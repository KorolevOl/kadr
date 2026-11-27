import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Player } from '@/engine/player'
import { registerPreviewCanvas } from '@/engine/snapshot'
import { usePopout } from '@/engine/popout'
import { useT } from '@/i18n'
import { useEditor, projectDuration } from '@/state/store'
import { AudioMeter } from './AudioMeter'
import { FragmentOverlays } from './FragmentOverlays'
import { FragmentGizmo } from './FragmentGizmo'
import { OnionSkin } from './OnionSkin'

const FRAME_FORMATS = [
  { ratio: '16:9', width: 1920, height: 1080 },
  { ratio: '9:16', width: 1080, height: 1920 },
  { ratio: '1:1', width: 1080, height: 1080 },
  { ratio: '4:3', width: 1440, height: 1080 },
  { ratio: '4:5', width: 1080, height: 1350 },
  { ratio: '21:9', width: 2520, height: 1080 }
]

const RESIZE_HANDLES = [
  { edge: 'left', x: -1, y: 0 },
  { edge: 'right', x: 1, y: 0 },
  { edge: 'top', x: 0, y: -1 },
  { edge: 'bottom', x: 0, y: 1 },
  { edge: 'bottom-right', x: 1, y: 1 }
]

interface FrameDrag {
  pointerId: number
  projectId: string
  clientX: number
  clientY: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  handle: (typeof RESIZE_HANDLES)[number]
}

function frameAt(drag: FrameDrag, e: PointerEvent) {
  const { handle, scaleX, scaleY } = drag
  const resize = (size: number, delta: number) =>
    delta === 0 ? size : Math.max(16, 2 * Math.round((size + delta) / 2))
  const width = resize(drag.width, handle.x * (e.clientX - drag.clientX) / scaleX)
  const height = resize(drag.height, handle.y * (e.clientY - drag.clientY) / scaleY)
  return {
    width, height,
    style: {
      left: handle.x < 0 ? (drag.width - width) * scaleX : 0,
      top: handle.y < 0 ? (drag.height - height) * scaleY : 0,
      width: width * scaleX,
      height: height * scaleY
    }
  }
}

export function Preview() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<Player | null>(null)
  const popped = usePopout((s) => s.win)
  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const loading = useEditor((s) => s.previewLoading)
  const gpuLost = useEditor((s) => s.previewGpuLost)
  const frameDrag = useRef<FrameDrag | null>(null)
  const [draft, setDraft] = useState<ReturnType<typeof frameAt> | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new Player({
      getState: () => {
        const s = useEditor.getState()
        return { project: s.project, playhead: s.playhead, playing: s.playing }
      },
      setPlayhead: (t) => useEditor.getState().setPlayhead(t),
      setPlaying: (p) => useEditor.getState().setPlaying(p),
      setLoading: (l) => useEditor.getState().setPreviewLoading(l),
      setGpuLost: (lost) => useEditor.getState().setPreviewGpuLost(lost),
      duration: () => projectDuration(useEditor.getState().project)
    })
    player.attach(canvas)
    playerRef.current = player
    registerPreviewCanvas(canvas, player)
    return () => {
      registerPreviewCanvas(null, null)
      playerRef.current = null
      player.detach()
    }
  }, [])

  // detaching the preview moves this canvas into another window; the clock
  // has to be re-scheduled there at once instead of waiting for the old
  // window's next (possibly throttled) frame
  useEffect(() => {
    playerRef.current?.kick()
  }, [popped])

  const activeFormat = FRAME_FORMATS.find((f) => f.width === width && f.height === height)
  const frameStyle = { '--frame-width': `${width}px`, '--frame-ratio': width / height } as CSSProperties

  const startResize = (e: PointerEvent<HTMLDivElement>, handle: FrameDrag['handle']) => {
    if (e.button !== 0 || frameDrag.current) return
    const rect = canvasRef.current?.getBoundingClientRect()
    const { project } = useEditor.getState()
    if (!rect?.width || !rect.height || project.width < 1 || project.height < 1) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    frameDrag.current = {
      pointerId: e.pointerId, projectId: project.id, handle,
      clientX: e.clientX, clientY: e.clientY, width: project.width, height: project.height,
      scaleX: rect.width / project.width, scaleY: rect.height / project.height
    }
  }

  const moveResize = (e: PointerEvent) => {
    const drag = frameDrag.current
    if (drag?.pointerId === e.pointerId) setDraft(frameAt(drag, e))
  }

  const cancelResize = (e: PointerEvent) => {
    if (frameDrag.current?.pointerId !== e.pointerId) return
    frameDrag.current = null
    setDraft(null)
  }

  const finishResize = (e: PointerEvent) => {
    const drag = frameDrag.current
    if (drag?.pointerId !== e.pointerId) return
    cancelResize(e)
    const { project, setProjectSize } = useEditor.getState()
    if (project.id !== drag.projectId || project.width !== drag.width || project.height !== drag.height) return
    const size = frameAt(drag, e)
    setProjectSize(size.width, size.height)
  }

  return (
    <div className="preview">
      <div className="preview-picture">
        <label className="preview-format">
          <span>{t('frameFormat')}</span>
          <select
            data-act="frame-format"
            value={activeFormat?.ratio ?? ''}
            onChange={(e) => {
              const format = FRAME_FORMATS.find((f) => f.ratio === e.target.value)
              if (format) useEditor.getState().setProjectSize(format.width, format.height)
            }}
          >
            {!activeFormat && <option value="">{t('customFrameSize')} · {width} × {height}</option>}
            {FRAME_FORMATS.map((f) => (
              <option key={f.ratio} value={f.ratio}>{f.ratio} · {f.width} × {f.height}</option>
            ))}
          </select>
        </label>
        <div className="preview-canvas-wrap">
          <div className="preview-frame" style={frameStyle}>
            <canvas className="preview-canvas" ref={canvasRef} width={width} height={height} />
            <FragmentOverlays canvas={canvasRef} />
            <OnionSkin canvas={canvasRef} />
            <FragmentGizmo canvas={canvasRef} />
            {loading && !gpuLost && (
              <div className="preview-loading">
                <div className="spinner" />
              </div>
            )}
            {gpuLost && <div className="preview-gpu-lost">{t('gpuLost')}</div>}
            {/* Keep the video canvas at its current size until the drag is committed. */}
            {draft && (
              <div className="preview-resize-outline" style={draft.style} aria-hidden="true" />
            )}
            {RESIZE_HANDLES.map((handle) => (
              <div
                key={handle.edge}
                className="preview-resize-handle"
                data-edge={handle.edge}
                title={t('resizeFrame')}
                aria-hidden="true"
                onPointerDown={(e) => startResize(e, handle)}
                onPointerMove={moveResize}
                onPointerUp={finishResize}
                onPointerCancel={cancelResize}
                onLostPointerCapture={cancelResize}
              />
            ))}
          </div>
          {draft && <output className="preview-resize-size">{draft.width} × {draft.height}</output>}
        </div>
      </div>
      <AudioMeter />
    </div>
  )
}
