import { access, mkdir, mkdtemp, open, rename, rmdir, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { HDR_VERSION, hdrCube, hdrFilter } from '@shared/hdr'
import type { ExportJob, ExportProgress, KadrApi } from '@shared/types'
import {
  ExportMuxer, RawVideoEncoder, makeDecoded, makeProxy, makeReversed,
  meanVolume, measureLoudness, packedAlphaPlan, probeBasic, probeMedia
} from '../../electron/ffmpeg'
import { decodedSuffix, mediaCacheKey, proxySuffix, reverseSuffix } from '../../electron/cacheKeys'

const cacheDirectory = process.env.KADR_TAURI_CACHE ?? ''
if (!cacheDirectory) throw new Error('Missing Kadr media cache directory')

interface ExportSession {
  job: ExportJob
  dir: string
  video: string
  result: string
  file?: FileHandle
  opening?: Promise<FileHandle>
  encoder?: RawVideoEncoder
  frameBytes?: number
  rawComplete?: boolean
  muxer?: ExportMuxer
  cancelled: boolean
}

let activeExport: ExportSession | null = null
let exportGeneration = 0
const builds = new Map<string, Promise<string>>()
const luts = new Map<string, Promise<string>>()

function send(message: object) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function event(name: string, payload: unknown) {
  send({ kind: 'event', name, payload })
}

function exportProgress(progress: ExportProgress) {
  event('kadr-export-progress', progress)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function currentExport() {
  if (!activeExport || activeExport.cancelled) throw new Error('cancelled')
  return activeExport
}

async function exportBegin(job: ExportJob) {
  if (activeExport) throw new Error('An export is already in progress')
  if (!isAbsolute(job.outputPath) || !Number.isFinite(job.duration) || job.duration <= 0) {
    throw new Error('Invalid export path or duration')
  }
  const generation = exportGeneration
  const dir = await mkdtemp(join(dirname(job.outputPath), 'kadr-export-'))
  if (activeExport || generation !== exportGeneration) {
    await rmdir(dir)
    throw new Error('cancelled')
  }
  activeExport = {
    job, dir, video: join(dir, 'video.mp4'),
    result: join(dir, 'result' + (extname(job.outputPath) || '.' + job.preset.container)),
    cancelled: false
  }
}

async function releaseExport(session: ExportSession, keepVideo = false) {
  if (session.opening) await session.opening.catch(() => undefined)
  await session.file?.close().catch(() => {})
  await unlink(session.result).catch(() => {})
  if (!keepVideo) {
    await unlink(session.video).catch(() => {})
    await rmdir(session.dir).catch(() => {})
  }
  if (activeExport === session) activeExport = null
}

async function exportCancel() {
  exportGeneration++
  const session = activeExport
  if (!session || session.cancelled) return
  session.cancelled = true
  if (session.muxer) {
    session.muxer.cancel()
    return
  }
  session.encoder?.kill()
  await session.encoder?.finish().catch(() => {})
  await releaseExport(session)
  exportProgress({ phase: 'cancelled', progress: 0 })
}

function startRaw(options: Parameters<KadrApi['rawEncodeStart']>[0]) {
  const session = currentExport()
  if (session.encoder || session.file || session.muxer) throw new Error('The export already has a video stream')
  const { width, height, fps } = options
  if (![width, height, options.outWidth ?? width, options.outHeight ?? height].every(
    (size) => Number.isSafeInteger(size) && size > 0
  ) || !Number.isFinite(fps) || fps <= 0 || !['libx264', 'libvpx-vp9'].includes(options.codec)) {
    throw new Error('Unsupported raw export format')
  }
  session.frameBytes = width * height * 4
  session.encoder = new RawVideoEncoder()
  session.encoder.start({ ...options, out: session.video })
  return session.video
}

async function rawFrame(data: Buffer) {
  const session = currentExport()
  if (!session.encoder || data.length !== session.frameBytes) throw new Error('Invalid export frame')
  await session.encoder.write(data)
}

async function finishRaw() {
  const session = currentExport()
  if (!session.encoder) throw new Error('The export encoder is not running')
  await session.encoder.finish()
  if (session.cancelled) throw new Error('cancelled')
  session.encoder = undefined
  session.rawComplete = true
}

async function videoChunk(position: number, data: Buffer) {
  const session = currentExport()
  if (!Number.isSafeInteger(position) || position < 0 || session.encoder || session.muxer) {
    throw new Error('Invalid encoded video chunk')
  }
  session.opening ??= open(session.video, 'w').then((file) => { session.file = file; return file })
  const file = await session.opening
  if (session.cancelled) throw new Error('cancelled')
  const { bytesWritten } = await file.write(data, 0, data.length, position)
  if (bytesWritten !== data.length) throw new Error('Incomplete encoded video write')
}

async function finishExport() {
  const session = currentExport()
  if (session.encoder || session.muxer) throw new Error('The export is not ready to mux')
  const { job } = session
  session.muxer = new ExportMuxer()
  let keepVideo = false
  try {
    await session.opening
    await session.file?.close()
    session.file = undefined
    const preset = session.rawComplete ? { ...job.preset, ffmpegVideo: 'copy' } : job.preset
    await session.muxer.run({ ...job, preset, outputPath: session.result }, session.video, exportProgress)
    if (session.cancelled) throw new Error('cancelled')
    await rename(session.result, job.outputPath)
    exportProgress({ phase: 'done', progress: 1 })
    return { ok: true }
  } catch (error) {
    const cancelled = session.cancelled || message(error) === 'cancelled'
    keepVideo = !cancelled && !job.preset.audioOnly && ((await stat(session.video).catch(() => null))?.size ?? 0) > 0
    const errorText = message(error) + (keepVideo ? ' (video kept at ' + session.video + ')' : '')
    exportProgress({ phase: cancelled ? 'cancelled' : 'error', progress: 0, message: errorText })
    return { ok: false, cancelled, error: errorText }
  } finally {
    await releaseExport(session, keepVideo)
  }
}

async function cachedMedia(
  folder: string, path: string, suffix: string, extension: string,
  build: (destination: string) => Promise<void>
) {
  const source = await stat(path)
  const dir = join(cacheDirectory, folder)
  const key = mediaCacheKey(path, source.size, source.mtimeMs, suffix)
  const out = join(dir, key + extension)
  const running = builds.get(out)
  if (running) return running
  const task = (async () => {
    if (((await stat(out).catch(() => null))?.size ?? 0) > 0) return out
    await mkdir(dir, { recursive: true })
    const partial = join(dir, key + '.part' + extension)
    try {
      await build(partial)
      await rename(partial, out)
      return out
    } finally {
      await unlink(partial).catch(() => {})
    }
  })()
  builds.set(out, task)
  try { return await task } finally { builds.delete(out) }
}

type ProxyOptions = NonNullable<Parameters<KadrApi['requestProxy']>[2]>
type DecodeOptions = NonNullable<Parameters<KadrApi['requestDecoded']>[2]>

async function toneMap(path: string) {
  const hdr = (await probeBasic(path).catch(() => null))?.hdr
  if (!hdr) return undefined
  let pending = luts.get(hdr)
  if (!pending) {
    const dir = join(cacheDirectory, 'luts')
    const lut = join(dir, hdr + '-to-sdr709-v' + HDR_VERSION + '.cube')
    pending = (async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(lut, hdrCube(hdr))
      return hdrFilter(lut)
    })()
    luts.set(hdr, pending)
  }
  try { return await pending } catch (error) {
    luts.delete(hdr)
    throw error
  }
}

async function requestProxy(path: string, duration: number, options?: ProxyOptions) {
  const vfPre = options?.alpha ? undefined : await toneMap(path)
  return cachedMedia('proxies', path, proxySuffix(options?.alpha, !!vfPre), options?.alpha ? '.webm' : '.mp4',
    (out) => makeProxy(path, out, duration,
      (progress) => event('kadr-proxy-progress', { path, progress }), { ...options, vfPre }))
}

async function requestDecoded(path: string, duration: number, options?: DecodeOptions) {
  const packed = options?.packed ? await packedAlphaPlan(path) : null
  if (packed && !packed.canPack) throw new Error('Alpha packing is unavailable for this source')
  const vfPre = options?.alpha || packed ? undefined : await toneMap(path)
  const opts = { ...options, matrix: packed?.matrix, vfPre, sdr: !!vfPre }
  return cachedMedia('decoded', path, decodedSuffix(opts), opts?.alpha && !opts.packed ? '.webm' : '.mp4',
    (out) => makeDecoded(path, out, duration,
      (progress) => event('kadr-proxy-progress', { path, progress }), opts))
}

async function reverseMedia(...[path, start, duration, info]: Parameters<KadrApi['reverseMedia']>) {
  const suffix = reverseSuffix(start, duration)
  const extension = info.kind === 'video' ? '.mp4' : '.wav'
  return cachedMedia('reversed', path, suffix, extension,
    (out) => makeReversed(path, start, duration, out, info, out + '.tmp',
      (progress) => event('kadr-reverse-progress', { path, start, duration, progress })))
}

async function saveBlobMedia(name: string, mime: string, data: Buffer) {
  const mimeTypes: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
    'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg'
  }
  const extension = extname(name).toLowerCase()
  const suffix = mimeTypes[mime] ?? (/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '')
  if (!suffix || !data.length) throw new Error('Unsupported media blob')
  const out = join(cacheDirectory, 'imported', createHash('sha256').update(data).digest('hex') + suffix)
  await mkdir(dirname(out), { recursive: true })
  try {
    await access(out)
  } catch {
    await writeFile(out, data)
  }
  return out
}

async function saveSnapshot(dir: string | null, baseName: string, png: Buffer) {
  const folder = dir ?? process.env.KADR_TAURI_DOWNLOADS
  if (!folder || !isAbsolute(folder) || !png.length) throw new Error('Invalid snapshot destination')
  const stem = baseName.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Kadr'
  for (let index = 1; ; index++) {
    const path = join(folder, stem + (index > 1 ? '-' + index : '') + '.png')
    try {
      await writeFile(path, png, { flag: 'wx' })
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

const commands = {
  probeMedia, probeBasic, requestProxy, requestDecoded, reverseMedia, measureLoudness, meanVolume, saveBlobMedia, saveSnapshot,
  exportBegin, exportCancel, exportVideoChunk: videoChunk, exportVideoDone: finishExport,
  rawEncodeStart: startRaw, rawEncodeFrame: rawFrame, rawEncodeEnd: finishRaw,
  exportUseVideo: (path: string) => {
    const session = currentExport()
    if (!session.rawComplete || path !== session.video) throw new Error('Invalid export video path')
  },
  exportRawBegin: (width: number, height: number, fps: number, outWidth?: number, outHeight?: number) => {
    const { preset } = currentExport().job
    startRaw({
      width, height, fps, outWidth, outHeight,
      codec: preset.ffmpegVideo === 'copy' ? 'libx264' : preset.ffmpegVideo, bitrate: preset.videoBitrate
    })
    return 0
  }
}

interface Header {
  id: number
  method: keyof typeof commands
  args: unknown[]
  bytes: number
}

async function dispatch(header: Header, data?: Buffer) {
  try {
    if (!Object.hasOwn(commands, header.method)) throw new Error('Unknown media operation')
    const execute = commands[header.method] as (...args: unknown[]) => unknown
    const result = await (data ? execute(...header.args, data) : execute(...header.args))
    send({ kind: 'reply', id: header.id, result: result ?? null })
  } catch (error) {
    send({ kind: 'reply', id: header.id, error: message(error) })
  }
}

// Each newline-delimited header announces the exact number of binary bytes
// that follow it. Frames can span pipe reads and are never encoded as JSON.
async function readCommands() {
  let headerParts: Buffer[] = []
  let packet: { header: Header; data: Buffer; received: number } | null = null
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    let offset = 0
    while (offset < chunk.length) {
      if (!packet) {
        const lineEnd = chunk.indexOf(10, offset)
        if (lineEnd < 0) {
          headerParts.push(chunk.subarray(offset))
          break
        }
        headerParts.push(chunk.subarray(offset, lineEnd))
        const header = JSON.parse(Buffer.concat(headerParts).toString('utf8')) as Header
        headerParts = []
        offset = lineEnd + 1
        if (header.bytes === 0) {
          void dispatch(header)
          continue
        }
        packet = { header, data: Buffer.allocUnsafe(header.bytes), received: 0 }
      }
      const size = Math.min(chunk.length - offset, packet.data.length - packet.received)
      chunk.copy(packet.data, packet.received, offset, offset + size)
      packet.received += size
      offset += size
      if (packet.received === packet.data.length) {
        void dispatch(packet.header, packet.data)
        packet = null
      }
    }
  }
  await exportCancel()
}

void readCommands().catch((error) => {
  console.error(message(error))
  process.exitCode = 1
  process.stdin.destroy()
})
