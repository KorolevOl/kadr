import { copyFile, mkdir, stat } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This Tauri bundle targets Windows x64. Use x64 Node.js on the build machine.')
}

const root = fileURLToPath(new URL('../..', import.meta.url))
const binaries = join(root, 'src-tauri', 'binaries')
const generated = join(root, 'src-tauri', 'generated')
const licenses = join(generated, 'licenses')
const triple = 'x86_64-pc-windows-msvc'
const choco = process.env.ChocolateyInstall ?? join(process.env.ProgramData ?? 'C:/ProgramData', 'chocolatey')
const ffmpegDir = process.env.KADR_TAURI_FFMPEG_DIR
const candidates = ffmpegDir ? [resolve(ffmpegDir)] : [
  join(choco, 'lib', 'ffmpeg-full', 'tools', 'ffmpeg', 'bin'),
  join(choco, 'lib', 'ffmpeg', 'tools', 'ffmpeg', 'bin'),
  ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir &&
    resolve(dir).toLowerCase() !== join(choco, 'bin').toLowerCase())
]

let ffmpeg
for (const directory of candidates) {
  const executables = ['ffmpeg.exe', 'ffprobe.exe'].map((name) => join(directory, name))
  const files = await Promise.all(executables.map((path) => stat(path).catch(() => null)))
  if (files.every((file) => file?.isFile())) {
    ffmpeg = directory
    break
  }
}
if (!ffmpeg) throw new Error('Set KADR_TAURI_FFMPEG_DIR to the folder containing standalone ffmpeg.exe and ffprobe.exe.')

async function copyIfChanged(source, destination) {
  const sourceInfo = await stat(source)
  const copied = await stat(destination).catch(() => null)
  if (copied?.size !== sourceInfo.size || copied.mtimeMs < sourceInfo.mtimeMs) {
    await copyFile(source, destination)
  }
}

await Promise.all([mkdir(binaries, { recursive: true }), mkdir(licenses, { recursive: true })])
await Promise.all([
  ...['ffmpeg', 'ffprobe'].map((name) =>
    copyIfChanged(join(ffmpeg, name + '.exe'), join(binaries, name + '-' + triple + '.exe'))),
  copyIfChanged(process.execPath, join(binaries, 'kadr-node-' + triple + '.exe')),
  copyIfChanged(join(root, 'LICENSE'), join(licenses, 'Kadr.txt'))
])
for (const [file, label] of [
  [join(dirname(process.execPath), 'LICENSE'), 'Node.js.txt'],
  [join(dirname(ffmpeg), 'LICENSE'), 'FFmpeg.txt'],
  [join(dirname(ffmpeg), 'README.txt'), 'FFmpeg distribution.txt']
]) {
  if (await stat(file).catch(() => null)) await copyIfChanged(file, join(licenses, label))
}

await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': join(root, 'shared') } },
  build: {
    ssr: join(root, 'scripts', 'tauri', 'media-worker.ts'),
    outDir: generated,
    emptyOutDir: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'media-worker.cjs' } }
  }
})
