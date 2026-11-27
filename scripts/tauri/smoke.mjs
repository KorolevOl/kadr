import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import WebSocket from 'ws'

const exe = resolve(process.argv[2] ?? 'src-tauri/target/x86_64-pc-windows-msvc/release/kadr.exe')
const ffmpeg = join(dirname(exe), 'ffmpeg.exe')
const ffprobe = join(dirname(exe), 'ffprobe.exe')

async function localPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function eventually(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await wait(100)
  }
  throw new Error('Timed out waiting for ' + label)
}

function evaluator(ws) {
  let id = 0
  return (fn, ...args) => new Promise((resolve, reject) => {
    const request = ++id
    const receive = (data) => {
      const message = JSON.parse(data)
      if (message.id !== request) return
      ws.off('message', receive)
      clearTimeout(timer)
      if (message.error || message.result.exceptionDetails) {
        reject(new Error(message.error?.message ?? message.result.exceptionDetails.exception?.description))
      } else {
        resolve(message.result.result.value)
      }
    }
    const timer = setTimeout(() => {
      ws.off('message', receive)
      reject(new Error('WebView2 evaluation timed out'))
    }, 45_000)
    ws.on('message', receive)
    ws.send(JSON.stringify({
      id: request, method: 'Runtime.evaluate',
      params: { expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')',
        awaitPromise: true, returnByValue: true }
    }))
  })
}

await mkdir('out', { recursive: true })
const testRoot = await realpath('out')
const test = await mkdtemp(join(testRoot, 'tauri-smoke-'))
const source = join(test, 'Кадры.mp4')
const saved = join(test, 'Монтаж.kadr')
const exported = join(test, 'Экспорт.mp4')
const run = (binary, args, options = {}) =>
  execFileSync(binary, args, { windowsHide: true, timeout: 20_000, ...options })

let child
let ws
let failure
try {
  run(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
  ])
  const port = await localPort()
  const system = process.env.SystemRoot ?? 'C:/Windows'
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  const flags = [
    '--remote-debugging-port=' + port, '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE *.localhost"'
  ]
  child = spawn(exe, [], {
    cwd: test,
    env: {
      ...env,
      PATH: [join(system, 'System32'), system].join(delimiter),
      KADR_TAURI_DATA: join(test, 'app-data'),
      KADR_TAURI_HEADLESS: '1',
      WEBVIEW2_USER_DATA_FOLDER: join(test, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: flags.join(' ')
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true
  })
  child.on('error', (error) => { failure = error })
  const target = await eventually(async () => {
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error('The editor exited with ' + child.exitCode)
    const pages = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(1000)
    }).then((response) => response.json()).catch(() => [])
    return pages.find((page) => page.type === 'page' && page.url.includes('tauri.localhost'))
  }, 'the editor WebView')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const evaluate = evaluator(ws)
  await eventually(() => evaluate(() => !!window.kadrEditor && !!document.querySelector('.preview-canvas')), 'the editor')
  const loaded = await evaluate(async (path, projectPath) => {
    const editor = window.kadrEditor
    const s = editor.useEditor.getState()
    s.setProjectSize(320, 180)
    const ids = await editor.importFiles([path], { trackId: s.project.tracks[0].id, at: 0 })
    const project = editor.useEditor.getState().project
    await window.kadr.writeProject(projectPath, project)
    await window.kadr.writeProject(projectPath, project)
    await editor.openProject(projectPath)
    return { ids: ids.length, audio: project.assets[0]?.hasAudio, platform: window.kadr.platform }
  }, source, saved)
  assert.deepEqual(loaded, { ids: 1, audio: true, platform: 'tauri' })

  const pixel = () => evaluate(() => {
    const canvas = document.querySelector('.preview-canvas')
    const gl = canvas.getContext('webgl2')
    const data = new Uint8Array(4)
    gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return [...data]
  })
  await eventually(async () => (await pixel())[0] > 190, 'the red preview frame')
  await evaluate(() => window.kadrEditor.useEditor.getState().setPlayhead(1.5))
  await eventually(async () => (await pixel())[2] > 190, 'the blue frame after seeking')
  console.log('PASS import, project overwrite/reopen, preview and seek')

  await evaluate(async (file) => {
    const ed = window.kadrEditor
    const state = ed.useEditor.getState()
    state.setProjectSize(1920, 1080)
    const preset = ed.PRESETS.find((item) => item.id === 'source')
    await ed.startExport(ed.useEditor.getState().project, preset, file, () => {},
      { start: 0, end: 0.4 }, { motionBlur: false, frameBlending: false }).done
  }, exported)
  const output = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', exported], { encoding: 'utf8' }))
  const video = output.streams.find((stream) => stream.codec_type === 'video')
  assert.equal(video?.width, 1920)
  assert.equal(video?.height, 1080)
  assert.ok(output.streams.some((stream) => stream.codec_type === 'audio'))
  const rgb = run(ffmpeg, [
    '-v', 'error', '-i', exported, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ])
  assert.ok(rgb[0] > 190 && rgb[1] < 40 && rgb[2] < 40)
  console.log('PASS binary 1080p frame transfer and MP4 export with audio')
} catch (error) {
  console.error('Smoke test files: ' + test)
  failure = error
  throw error
} finally {
  ws?.close()
  if (child && child.exitCode === null && child.pid) {
    const exit = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exit
  }
  if (!failure) {
    const resolved = await realpath(test)
    if (dirname(resolved) === testRoot && basename(resolved).startsWith('tauri-smoke-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        .catch((error) => console.warn('Could not remove smoke test files:', error.message))
    }
  }
}
