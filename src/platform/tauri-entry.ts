import { getCurrentWebview } from '@tauri-apps/api/webview'
import { createTauriApi } from './tauri'

window.kadr = createTauriApi()

// The adapter is installed before any editor module reads native settings.
void import('../main').then(async () => {
  const [{ importFiles }, { useEditor }] = await Promise.all([
    import('@/engine/mediaImport'),
    import('@/state/store')
  ])
  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type !== 'drop' || !payload.paths.length) return
    const x = payload.position.x / window.devicePixelRatio
    const y = payload.position.y / window.devicePixelRatio
    const lane = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-lane]')
    const trackId = lane?.dataset.lane
    const at = lane ? Math.max(0, (x - lane.getBoundingClientRect().left) / useEditor.getState().zoom) : 0
    void importFiles(payload.paths, trackId ? { trackId, at } : null)
  })
}).catch((error) => console.error('Kadr startup failed', error))
