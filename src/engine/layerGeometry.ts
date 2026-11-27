import type { Clip, ClipTransform, Track } from '@shared/types'
import { evalAnim } from './anim'

interface Size {
  width: number
  height: number
}

export function fittedLayerSize(
  width: number, height: number, sourceWidth: number, sourceHeight: number, scale = 1
): Size {
  const fit = Math.min(width / sourceWidth, height / sourceHeight) * scale
  return { width: sourceWidth * fit, height: sourceHeight * fit }
}

export function manualClipSize(clip: Clip) {
  const size = clip.frameSize
  if (clip.kind === 'media' && size?.autoFit === false &&
      Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0) return size
}

type Vector = [number, number, number]

interface Pose {
  x: number
  y: number
  scale: number
  rotation: number
  rotX: number
  rotY: number
  z: number
}

export interface LayerTransform extends Omit<Pose, 'rotX' | 'rotY' | 'z'> {
  rotX?: number
  rotY?: number
  z?: number
  outer?: Pose
}

function poseAt(transform: ClipTransform | NonNullable<Track['motion']>, time: number): Pose {
  return {
    x: evalAnim(transform.x, time),
    y: evalAnim(transform.y, time),
    scale: evalAnim(transform.scale, time),
    rotation: evalAnim(transform.rotation, time),
    rotX: evalAnim(transform.rotX, time),
    rotY: evalAnim(transform.rotY, time),
    z: evalAnim(transform.z, time)
  }
}

export function layerTransformAt(clip: Clip, track: Track, time: number): LayerTransform {
  return {
    ...poseAt(clip.transform, time - clip.start),
    // Whole-track motion is keyed in project time.
    outer: track.motion ? poseAt(track.motion, time) : undefined
  }
}

/** Row-major 3×3 rotation: Ry, then Rx, then Rz. */
function rotationMatrix(zDegrees: number, xDegrees = 0, yDegrees = 0): number[] {
  const z = zDegrees * Math.PI / 180
  const x = xDegrees * Math.PI / 180
  const y = yDegrees * Math.PI / 180
  const cz = Math.cos(z), sz = Math.sin(z)
  const cx = Math.cos(x), sx = Math.sin(x)
  const cy = Math.cos(y), sy = Math.sin(y)
  return [
    cz * cy + sz * sx * sy, -sz * cx, -cz * sy + sz * sx * cy,
    sz * cy - cz * sx * sy, cz * cx, -sz * sy - cz * sx * cy,
    cx * sy, sx, cx * cy
  ]
}

function rotate(matrix: number[], [x, y, z]: Vector): Vector {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z
  ]
}

/** Clip plane in camera space, after clip rotation and whole-track motion. */
export function layerProjection(width: number, height: number, pose: LayerTransform) {
  const rotation = rotationMatrix(pose.rotation, pose.rotX, pose.rotY)
  const localX: Vector = [rotation[0], rotation[3], rotation[6]]
  const localY: Vector = [rotation[1], rotation[4], rotation[7]]
  let origin: Vector = [pose.x, pose.y, pose.z ?? 0]
  let axisX = localX
  let axisY = localY
  if (pose.outer) {
    const { x, y, z, scale, rotation, rotX, rotY } = pose.outer
    const matrix = rotationMatrix(rotation, rotX, rotY)
    const apply = ([x, y, z]: Vector) => rotate(matrix, [x * scale, y * scale, z * scale])
    origin = apply(origin)
    origin[0] += x
    origin[1] += y
    origin[2] += z
    axisX = apply(axisX)
    axisY = apply(axisY)
  }
  return { origin, axisX, axisY, localX, localY, focal: Math.max(width, height) * 1.2 }
}

type Projection = ReturnType<typeof layerProjection>
const MIN_DEPTH = 0.05

/** Project to pixels relative to the center of the project frame. */
export function projectLayerPoint({ origin, axisX, axisY, focal }: Projection, x: number, y: number) {
  const z = origin[2] + axisX[2] * x + axisY[2] * y
  const clipW = Math.max(MIN_DEPTH, (focal + z) / focal)
  return {
    x: (origin[0] + axisX[0] * x + axisY[0] * y) / clipW,
    y: (origin[1] + axisX[1] * x + axisY[1] * y) / clipW,
    clipW
  }
}

function solvePlanePoint(xx: number, xy: number, yx: number, yy: number, tx: number, ty: number) {
  const det = xx * yy - xy * yx
  if (Math.abs(det) < 1e-8) return null // edge-on plane
  const u = (tx * yy - xy * ty) / det
  const v = (xx * ty - tx * yx) / det
  return Number.isFinite(u) && Number.isFinite(v) ? { x: u, y: v } : null
}

type ScreenAlignment = { point: ReturnType<typeof projectLayerPoint>; target: number }

/** Solve a single move that aligns both axes, which can use different corners. */
export function layerMoveForAlignment(
  { axisX, axisY, focal }: Projection, horizontal: ScreenAlignment, vertical: ScreenAlignment
) {
  const { point: fromX, target: x } = horizontal
  const { point: fromY, target: y } = vertical
  const depthX = fromX.clipW > MIN_DEPTH ? x / focal : 0
  const depthY = fromY.clipW > MIN_DEPTH ? y / focal : 0
  return solvePlanePoint(
    axisX[0] - depthX * axisX[2], axisY[0] - depthX * axisY[2],
    axisX[1] - depthY * axisX[2], axisY[1] - depthY * axisY[2],
    (x - fromX.x) * fromX.clipW, (y - fromY.y) * fromY.clipW
  )
}

/** Intersect a preview pointer with the layer plane at its current depth. */
export function unprojectLayerPoint({ origin, axisX, axisY, focal }: Projection, x: number, y: number) {
  const depth = (focal + origin[2]) / focal
  const point = solvePlanePoint(
    axisX[0] - x * axisX[2] / focal, axisY[0] - x * axisY[2] / focal,
    axisX[1] - y * axisX[2] / focal, axisY[1] - y * axisY[2] / focal,
    x * depth - origin[0], y * depth - origin[1]
  )
  const depthAt = (p: { x: number; y: number }) => depth + (axisX[2] * p.x + axisY[2] * p.y) / focal
  if (point && depthAt(point) >= MIN_DEPTH) return point
  const clamped = solvePlanePoint(
    axisX[0], axisY[0], axisX[1], axisY[1], x * MIN_DEPTH - origin[0], y * MIN_DEPTH - origin[1]
  )
  return clamped && depthAt(clamped) <= MIN_DEPTH ? clamped : null
}

/** Shift the clip center along its rotated local axes, before track motion. */
export function clipPlaneOffset({ localX, localY }: Projection, x: number, y: number): Vector {
  return [
    localX[0] * x + localY[0] * y,
    localX[1] * x + localY[1] * y,
    localX[2] * x + localY[2] * y
  ]
}
