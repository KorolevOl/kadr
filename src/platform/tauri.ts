import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { KadrApi } from '@shared/types'

const request = <T>(method: string, ...args: unknown[]) =>
  invoke<T>('media_request', { method, args })

const binary = <T>(method: string, bytes: ArrayBuffer | Uint8Array, args: unknown[] = []) =>
  invoke<T>('media_bytes', bytes, {
    headers: {
      'x-kadr-method': method,
      'x-kadr-args': encodeURIComponent(JSON.stringify(args))
    }
  })

function subscribe<T>(name: string, callback: (event: T) => void): () => void {
  let unlisten: UnlistenFn | undefined
  let disposed = false
  void listen<T>(name, ({ payload }) => {
    if (!disposed) callback(payload)
  }).then((unsubscribe) => {
    if (disposed) unsubscribe()
    else unlisten = unsubscribe
  }).catch((error) => console.error('Could not listen for ' + name, error))
  return () => {
    disposed = true
    unlisten?.()
  }
}

function pickPaths(kind: string, name?: string, extension?: string) {
  return invoke<string[]>('pick_paths', { kind, name, extension })
}

async function pickPath(kind: string, name?: string, extension?: string) {
  return (await pickPaths(kind, name, extension))[0] ?? null
}

export function createTauriApi(): KadrApi {
  let writes = Promise.resolve()
  const encodeFrame: KadrApi['rawEncodeFrame'] = (data) => {
    // WebView2 can complete invokes out of order. Submit the frame buffers in
    // renderer order and wait for the encoder's write before reusing a slot.
    writes = writes.then(() => binary<void>('rawEncodeFrame', data))
    return writes
  }
  const cancel = () => request<void>('exportCancel')
  const cancelInBackground = () => { void cancel().catch(() => {}) }

  const api: Partial<KadrApi> = {
    platform: 'tauri',
    openMediaDialog: () => pickPaths('import'),
    probeMedia: (path) => request('probeMedia', path),
    probeBasic: (path) => request('probeBasic', path),
    fileUrl: (path) => convertFileSrc(path),
    pathForFile: () => '',
    saveBlobMedia: (name, mime, data) => binary('saveBlobMedia', data, [name, mime]),
    clipboardMedia: async () => [],
    portalFiles: async () => [],
    dropLog: () => {},

    saveProjectDialog: (name) => pickPath('saveProject', name),
    openProjectDialog: () => pickPath('openProject'),
    readProject: (path) => invoke('read_project', { path }),
    writeProject: (path, project) => invoke('write_project', { path, project }),
    autosaveProject: (project, mainPath) => invoke('autosave_project', { project, mainPath }),
    readUserStore: (name) => invoke('read_user_store', { name }),
    writeUserStore: (name, data) => invoke('write_user_store', { name, data }),
    readTextFile: (path) => invoke('read_text_file', { path }),
    writeTextFile: (path, content) => invoke('write_text_file', { path, content }),
    statFile: (path) => invoke('stat_file', { path }),
    pickDirectory: (title) => pickPath('directory', title),
    saveSnapshot: (dir, baseName, png) => binary('saveSnapshot', png, [dir, baseName]),

    requestProxy: (path, duration, options) => request('requestProxy', path, duration, options),
    onProxyProgress: (cb) => subscribe('kadr-proxy-progress', cb),
    requestDecoded: (path, duration, options) => request('requestDecoded', path, duration, options),
    reverseMedia: (path, start, duration, info) => request('reverseMedia', path, start, duration, info),
    onReverseProgress: (cb) => subscribe('kadr-reverse-progress', cb),
    measureLoudness: (path, start, duration) => request('measureLoudness', path, start, duration),
    meanVolume: (path, start, duration) => request('meanVolume', path, start, duration),

    exportDialog: (name, ext) => pickPath('export', name, ext),
    exportBegin: async (job) => {
      await writes.catch(() => {})
      await request<void>('exportBegin', job)
      writes = Promise.resolve()
    },
    exportVideoChunk: (data, position) => binary('exportVideoChunk', data, [position]),
    rawEncodeStart: (opts) => request('rawEncodeStart', opts),
    rawEncodeFrame: encodeFrame,
    rawEncodeEnd: () => request('rawEncodeEnd'),
    rawEncodeKill: cancelInBackground,
    rawEncodeDiscard: cancelInBackground,
    exportUseVideo: (path) => request('exportUseVideo', path),
    exportRawBegin: (...args) => request('exportRawBegin', ...args),
    exportRawFrame: (data) => encodeFrame(new Uint8Array(data)),
    exportRawEnd: () => request('rawEncodeEnd'),
    exportVideoDone: () => request('exportVideoDone'),
    exportCancel: cancel,
    onExportProgress: (cb) => subscribe('kadr-export-progress', cb),
    // The common export cancellation path may call this without a fragment.
    fragmentCancelRender: async () => {},
    ttsHasKey: async () => false
  }

  // Existing projects can refer to features still on Electron. Operations
  // outside the migrated API fail explicitly so callers can report them.
  return new Proxy(api as KadrApi, {
    get(target, key) {
      if (key in target || typeof key !== 'string') return Reflect.get(target, key)
      if (key.startsWith('on')) return () => () => {}
      return () => Promise.reject(new Error(
        (localStorage.getItem('kadr.lang') === 'en'
          ? 'This operation is not available in the Tauri build: '
          : 'Эта операция пока недоступна в сборке Tauri: ') + key
      ))
    }
  })
}
