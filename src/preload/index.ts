import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  AuthState,
  BatchRecord,
  PlaylistSummary,
  ProgressEvent,
  ScheduleInput,
  ThumbnailInfo,
  UpdateInfo
} from '../shared/types'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IpcResult<T>
  if (result.ok) return result.data
  const error = new Error(result.error.message) as Error & { code?: string }
  error.code = result.error.code
  throw error
}

const thumbnailDropCallbacks = new Set<(result: { thumbnail?: ThumbnailInfo; error?: string }) => void>()
window.addEventListener('dragover', (event) => {
  if ((event.target as Element | null)?.closest('[data-thumbnail-drop]')) event.preventDefault()
})
window.addEventListener('drop', (event) => {
  if (!(event.target as Element | null)?.closest('[data-thumbnail-drop]')) return
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (!file) return
  const path = webUtils.getPathForFile(file)
  void invoke<ThumbnailInfo>('thumbnail:validate', path)
    .then((thumbnail) => thumbnailDropCallbacks.forEach((callback) => callback({ thumbnail })))
    .catch((error: Error) => thumbnailDropCallbacks.forEach((callback) => callback({ error: error.message })))
})

const api = {
  bootstrap: () => invoke<{
    version: string
    platform: string
    arch: string
    settings: AppSettings
    auth: AuthState
    batches: BatchRecord[]
  }>('app:bootstrap'),
  settings: {
    save: (settings: AppSettings) => invoke<AppSettings>('settings:save', settings)
  },
  auth: {
    chooseConfiguration: () => invoke<AuthState | undefined>('auth:chooseConfiguration'),
    connect: () => invoke<AuthState>('auth:connect'),
    state: () => invoke<AuthState>('auth:state'),
    selectChannel: (channelId: string) => invoke<AuthState>('auth:selectChannel', channelId),
    disconnect: () => invoke<void>('auth:disconnect')
  },
  youtube: {
    playlists: () => invoke<PlaylistSummary[]>('youtube:playlists')
  },
  thumbnail: {
    choose: () => invoke<ThumbnailInfo | undefined>('thumbnail:choose'),
    onDrop: (callback: (result: { thumbnail?: ThumbnailInfo; error?: string }) => void) => {
      thumbnailDropCallbacks.add(callback)
      return () => thumbnailDropCallbacks.delete(callback)
    }
  },
  batches: {
    start: (input: ScheduleInput, excludedIds: string[]) => invoke<BatchRecord>('batch:start', { input, excludedIds }),
    resume: (batchId: string) => invoke<BatchRecord>('batch:resume', batchId),
    stop: () => invoke<void>('batch:stop'),
    list: () => invoke<BatchRecord[]>('batch:list'),
    clearHistory: () => invoke<void>('batch:clearHistory'),
    streamKey: (batchId: string, streamId?: string) => invoke<string>('batch:streamKey', batchId, streamId)
  },
  clipboard: {
    write: (text: string) => invoke<void>('clipboard:write', text)
  },
  external: {
    open: (url: string) => invoke<void>('external:open', url)
  },
  updates: {
    check: () => invoke<UpdateInfo>('updates:check')
  },
  diagnostics: {
    copy: () => invoke<boolean>('diagnostics:copy')
  },
  app: {
    closeDecision: (mode: 'keep' | 'stop' | 'now') => invoke<void>('app:closeDecision', mode)
  },
  onProgress: (callback: (event: ProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProgressEvent): void => callback(progress)
    ipcRenderer.on('batch:progress', listener)
    return () => ipcRenderer.removeListener('batch:progress', listener)
  },
  onCloseRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:closeRequested', listener)
    return () => ipcRenderer.removeListener('app:closeRequested', listener)
  }
}

contextBridge.exposeInMainWorld('desktop', api)

export type DesktopApi = typeof api
