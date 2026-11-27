import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type PointerEvent, type RefObject } from 'react'
import type { Clip, Project, Track } from '@shared/types'
import {
  clipPlaneOffset, layerMoveForAlignment, layerProjection, layerTransformAt, manualClipSize,
  projectLayerPoint, unprojectLayerPoint, type LayerTransform
} from '@/engine/layerGeometry'
import { usePopout } from '@/engine/popout'
import { useT } from '@/i18n'
import { findClip, useEditor, useSettings } from '@/state/store'
import { applyValue } from './animUtils'

const EDGES = [
  { name: 'top', x: 0, y: -1, from: 0, to: 1 },
  { name: 'right', x: 1, y: 0, from: 1, to: 2 },
  { name: 'bottom', x: 0, y: 1, from: 2, to: 3 },
  { name: 'left', x: -1, y: 0, from: 3, to: 0 }
]
const SNAP_DISTANCE = 7 // CSS pixels in the preview

type Edge = (typeof EDGES)[number]
type Point = { x: number; y: number }
type Projection = ReturnType<typeof layerProjection>
type ProjectedPoint = ReturnType<typeof projectLayerPoint>
type ClipSize = NonNullable<Clip['frameSize']>

export interface ClipPreviewDraft {
  base: Project
  project: Project
  clip: Clip
  time: number
}

interface Drag {
  pointerId: number
  edge: Edge | null
  snapEdges: boolean
  project: Project
  track: Track
  clip: Clip
  size: ClipSize
  time: number
  pose: ReturnType<typeof layerTransformAt>
  projection: Projection
  rect: DOMRect
  start: Point
}

function pointerOnPlane(project: Project, rect: DOMRect, projection: Projection, e: PointerEvent) {
  const x = (e.clientX - rect.left - rect.width / 2) * project.width / rect.width
  const y = (e.clientY - rect.top - rect.height / 2) * project.height / rect.height
  return unprojectLayerPoint(projection, x, y)
}

function projectedCorners(project: Project, pose: LayerTransform, size: ClipSize) {
  const projection = layerProjection(project.width, project.height, pose)
  const halfW = size.width * Math.abs(pose.scale) / 2
  const halfH = size.height * Math.abs(pose.scale) / 2
  return [
    projectLayerPoint(projection, -halfW, -halfH),
    projectLayerPoint(projection, halfW, -halfH),
    projectLayerPoint(projection, halfW, halfH),
    projectLayerPoint(projection, -halfW, halfH)
  ]
}

function nearestFrameEdge(points: ProjectedPoint[], axis: 'x' | 'y', halfFrame: number, tolerance: number) {
  const first = points.reduce((a, b) => a[axis] <= b[axis] ? a : b)
  const last = points.reduce((a, b) => a[axis] >= b[axis] ? a : b)
  const firstDistance = Math.abs(first[axis] + halfFrame)
  const lastDistance = Math.abs(last[axis] - halfFrame)
  if (Math.min(firstDistance, lastDistance) >= tolerance) return
  return firstDistance <= lastDistance ? { point: first, target: -halfFrame } : { point: last, target: halfFrame }
}

function snapMove(drag: Drag, dx: number, dy: number) {
  const { project, pose, size, rect, start, projection } = drag
  const points = projectedCorners(project, { ...pose, x: pose.x + dx, y: pose.y + dy }, size)
  const x = nearestFrameEdge(points, 'x', project.width / 2, SNAP_DISTANCE * project.width / rect.width)
  const y = nearestFrameEdge(points, 'y', project.height / 2, SNAP_DISTANCE * project.height / rect.height)
  if (!x && !y) return [dx, dy, 0]
  // Keep the pointer's coordinate on the axis that has no nearby frame edge.
  const pointer = projectLayerPoint(projection, start.x + dx, start.y + dy)
  const shift = layerMoveForAlignment(projection,
    x ?? { point: pointer, target: pointer.x }, y ?? { point: pointer, target: pointer.y })
  return shift ? [dx + shift.x, dy + shift.y, 0] : [dx, dy, 0]
}

function clipAtPointer(drag: Drag, e: PointerEvent): Clip | null {
  const { clip, size, projection, pose, edge } = drag
  const point = pointerOnPlane(drag.project, drag.rect, projection, e)
  if (!point) return null
  const dx = point.x - drag.start.x
  const dy = point.y - drag.start.y
  if (dx === 0 && dy === 0) return null
  const scale = Math.abs(pose.scale)
  const width = edge?.x && dx ? Math.max(1, size.width + edge.x * dx / scale) : size.width
  const height = edge?.y && dy ? Math.max(1, size.height + edge.y * dy / scale) : size.height
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  // Move the center by half the size change along the dragged edge's axis.
  // The opposite edge then stays in place, including on a tilted clip.
  const [x, y, z] = edge
    ? clipPlaneOffset(projection, edge.x * (width - size.width) * scale / 2, edge.y * (height - size.height) * scale / 2)
    : drag.snapEdges ? snapMove(drag, dx, dy) : [dx, dy, 0]
  if (width === size.width && height === size.height && x === 0 && y === 0 && z === 0) return null
  const tr = clip.transform
  const rel = drag.time - clip.start
  return {
    ...clip,
    frameSize: { ...size, width, height },
    transform: {
      ...tr,
      x: x ? applyValue(tr.x, rel, pose.x + x, false) : tr.x,
      y: y ? applyValue(tr.y, rel, pose.y + y, false) : tr.y,
      z: z ? applyValue(tr.z ?? { value: 0 }, rel, (pose.z ?? 0) + z, false) : tr.z
    }
  }
}

interface GizmoProps {
  canvas: RefObject<HTMLCanvasElement>
  draftRef: MutableRefObject<ClipPreviewDraft | null>
}

export function ClipGizmo({ canvas, draftRef }: GizmoProps) {
  const project = useEditor((s) => s.project)
  const selected = useEditor((s) => s.selection[0])
  const time = useEditor((s) => s.playhead)
  const found = selected ? findClip(project, selected) : null
  if (!found || found.track.kind !== 'video' || found.track.muted || found.track.locked) return null
  const { clip, track } = found
  if (!manualClipSize(clip) || time < clip.start || time >= clip.start + clip.duration ||
      !project.assets.some((asset) => asset.id === clip.assetId && asset.kind !== 'audio')) return null
  return (
    <ClipHandles key={`${project.id}:${clip.id}`} canvas={canvas} draftRef={draftRef}
      project={project} clip={clip} track={track} time={time} />
  )
}

function ClipHandles({
  canvas, draftRef, project, clip, track, time
}: GizmoProps & { project: Project; clip: Clip; track: Track; time: number }) {
  const t = useT()
  const popped = usePopout((s) => s.win)
  const [display, setDisplay] = useState<{ width: number; height: number } | null>(null)
  const [draft, setDraft] = useState<ClipPreviewDraft | null>(null)
  const dragging = useRef<Drag | null>(null)

  const clear = useCallback(() => {
    dragging.current = null
    draftRef.current = null
    setDraft(null)
  }, [draftRef])

  useLayoutEffect(() => {
    const el = canvas.current
    if (!el) return
    clear()
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      setDisplay({ width, height })
    }
    measure()
    const win = el.ownerDocument.defaultView ?? window
    const observer = new win.ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      draftRef.current = null
    }
  }, [canvas, clear, draftRef, popped])

  useEffect(() => {
    const drag = dragging.current
    if (drag && (drag.project !== project || drag.time !== time)) clear()
  }, [clear, project, time])

  const shown = draft?.base === project && draft.time === time ? draft.clip : clip
  const size = manualClipSize(shown)
  const pose = layerTransformAt(shown, track, time)
  if (!size || !pose.scale || !display?.width || !display.height) return null
  const points = projectedCorners(project, pose, size).map((p) => ({
    x: display.width * (0.5 + p.x / project.width),
    y: display.height * (0.5 + p.y / project.height)
  }))
  if (!points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null

  const begin = (e: PointerEvent<HTMLDivElement>, edge: Edge | null) => {
    if (e.button !== 0 || dragging.current) return
    const rect = canvas.current?.getBoundingClientRect()
    const size = manualClipSize(clip)
    const s = useEditor.getState()
    if (!size || !rect?.width || !rect.height || s.project !== project || s.selection[0] !== clip.id ||
        s.playhead < clip.start || s.playhead >= clip.start + clip.duration) return
    const pose = layerTransformAt(clip, track, s.playhead)
    if (!pose.scale) return
    // A move keeps the clip's depth. A resize follows the clip's own plane.
    const axes = edge ? pose : { ...pose, rotation: 0, rotX: 0, rotY: 0 }
    const plane = layerProjection(project.width, project.height, axes)
    const start = pointerOnPlane(project, rect, plane, e)
    if (!start) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (s.playing) s.setPlaying(false)
    dragging.current = {
      pointerId: e.pointerId, edge, project, track, clip, size, rect, start,
      time: s.playhead, pose, projection: plane, snapEdges: useSettings.getState().snapClipEdges
    }
  }

  const currentDrag = (e: PointerEvent) => {
    const drag = dragging.current
    if (drag?.pointerId !== e.pointerId) return null
    const s = useEditor.getState()
    if (s.project === drag.project && s.playhead === drag.time && s.selection[0] === drag.clip.id && !s.playing) return drag
    clear()
    return null
  }

  const move = (e: PointerEvent) => {
    const drag = currentDrag(e)
    if (!drag) return
    const next = clipAtPointer(drag, e)
    // The player sees this shallow draft while the stored project stays
    // available for autosave, undo and export until the pointer is released.
    const preview = next ? {
      base: project,
      project: {
        ...project,
        tracks: project.tracks.map((tr) => tr === drag.track
          ? { ...tr, clips: tr.clips.map((c) => c === drag.clip ? next : c) }
          : tr)
      },
      clip: next,
      time: drag.time
    } : null
    draftRef.current = preview
    setDraft(preview)
  }

  const finish = (e: PointerEvent) => {
    const drag = currentDrag(e)
    if (!drag) return
    const next = clipAtPointer(drag, e)
    clear()
    if (!next) return
    const s = useEditor.getState()
    s.pushHistory('hEdit')
    s.updateClip(clip.id, { frameSize: next.frameSize, transform: next.transform })
  }

  const cancel = (e: PointerEvent) => {
    if (dragging.current?.pointerId === e.pointerId) clear()
  }

  return (
    <div className="clip-gizmo" aria-hidden="true" onPointerMove={move} onPointerUp={finish}
      onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <div className="clip-gizmo-move" title={t('moveClipInPreview')}
        style={{ clipPath: `polygon(${points.map(({ x, y }) => `${x}px ${y}px`).join(', ')})` }}
        onPointerDown={(e) => begin(e, null)} />
      {EDGES.map((edge) => {
        const a = points[edge.from], b = points[edge.to]
        const angle = Math.atan2(b.y - a.y, b.x - a.x)
        const direction = (Math.round(angle * 4 / Math.PI) + 6) % 4
        const cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][direction]
        return (
          <div key={edge.name} data-edge={edge.name} className="clip-gizmo-edge" title={t('resizeClipInPreview')}
            style={{
              left: (a.x + b.x) / 2,
              top: (a.y + b.y) / 2,
              width: Math.hypot(b.x - a.x, b.y - a.y),
              transform: `translate(-50%, -50%) rotate(${angle}rad)`,
              cursor
            }}
            onPointerDown={(e) => begin(e, edge)} />
        )
      })}
    </div>
  )
}
