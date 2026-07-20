import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import log from 'electron-log/main'
import type { AppSettings, ChannelSummary } from '../shared/types'
import { batchStartSchema, settingsSchema } from '../shared/schemas'
import type { AuthService } from './auth'
import { AppError, toAppError } from './errors'
import type { SchedulerService } from './scheduler'
import type { AppStore } from './storage'
import type { YouTubeService } from './youtube'
import { parseOAuthClientJson } from './oauth-config'

interface Dependencies {
  store: AppStore
  auth: AuthService
  youtube: YouTubeService
  scheduler: SchedulerService
  window: () => BrowserWindow | undefined
  requestClose: (mode: 'keep' | 'stop' | 'now') => void
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

function register<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<TResult>> => {
    try {
      return { ok: true, data: await handler(...(args as TArgs)) }
    } catch (error) {
      const appError = toAppError(error)
      log.error('IPC operation failed', { channel, code: appError.code })
      return { ok: false, error: { code: appError.code, message: appError.message } }
    }
  })
}

function selectedChannel(state: Awaited<ReturnType<AuthService['getState']>>): ChannelSummary {
  if (state.status !== 'connected') throw new AppError('AUTH_REQUIRED', 'Connect a YouTube account first.')
  const channel = state.channels.find((candidate) => candidate.id === state.selectedChannelId)
  if (!channel) throw new AppError('CHANNEL_REQUIRED', 'Select the YouTube channel to schedule on.')
  return channel
}

function newerVersion(latest: string, current: string): boolean {
  const parts = (value: string): number[] => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parts(latest)
  const right = parts(current)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false
  }
  return false
}

export function registerIpc(dependencies: Dependencies): void {
  const { store, auth, youtube, scheduler } = dependencies

  register('app:bootstrap', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    settings: store.getSettings(),
    auth: await auth.getState(),
    batches: store.listBatches()
  }))

  register('settings:save', async (raw: AppSettings) => store.setSettings(settingsSchema.parse(raw)))

  register('auth:connect', async () => {
    const state = await auth.connect()
    if (state.status === 'connected' && state.channels.length === 1) {
      const settings = store.getSettings()
      settings.selectedChannelId = state.channels[0].id
      await store.setSettings(settings)
      state.selectedChannelId = state.channels[0].id
    }
    return state
  })
  register('auth:chooseConfiguration', async () => {
    const result = await dialog.showOpenDialog(dependencies.window()!, {
      title: 'Choose a Google Desktop OAuth JSON',
      properties: ['openFile'],
      filters: [{ name: 'Google OAuth JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return undefined
    const contents = await readFile(result.filePaths[0], 'utf8')
    if (Buffer.byteLength(contents, 'utf8') > 1024 * 1024) {
      throw new AppError('OAUTH_CONFIG_INVALID', 'The selected OAuth JSON is unexpectedly large.')
    }
    const configuration = parseOAuthClientJson(contents)
    await auth.configure(configuration)
    const settings = store.getSettings()
    delete settings.selectedChannelId
    await store.setSettings(settings)
    return auth.getState()
  })
  register('auth:state', () => auth.getState())
  register('auth:selectChannel', async (channelId: string) => {
    const state = await auth.getState()
    if (!state.channels.some((channel) => channel.id === channelId)) throw new AppError('CHANNEL_INVALID', 'That channel is not available.')
    const settings = store.getSettings()
    settings.selectedChannelId = channelId
    await store.setSettings(settings)
    state.selectedChannelId = channelId
    return state
  })
  register('auth:disconnect', async () => {
    await auth.disconnect()
    const settings = store.getSettings()
    delete settings.selectedChannelId
    await store.setSettings(settings)
  })

  register('youtube:playlists', () => youtube.playlists())
  register('thumbnail:choose', async () => {
    const result = await dialog.showOpenDialog(dependencies.window()!, {
      title: 'Choose a broadcast thumbnail',
      properties: ['openFile'],
      filters: [{ name: 'PNG or JPEG image', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    if (result.canceled || !result.filePaths[0]) return undefined
    return youtube.validateThumbnail(result.filePaths[0])
  })
  register('thumbnail:validate', (path: string) => youtube.validateThumbnail(path))

  register('batch:start', async (raw: unknown) => {
    const request = batchStartSchema.parse(raw)
    const channel = selectedChannel(await auth.getState())
    const settings = store.getSettings()
    const { startDate: _startDate, thumbnailPath: _thumbnailPath, rotateStreamKey: _rotateStreamKey, ...remembered } = request.input
    settings.lastSchedule = remembered
    await store.setSettings(settings)
    return scheduler.start(request.input, request.excludedIds, channel)
  })
  register('batch:resume', (batchId: string) => scheduler.resume(batchId))
  register('batch:stop', () => scheduler.requestStop())
  register('batch:list', () => store.listBatches())
  register('batch:clearHistory', () => {
    if (scheduler.isRunning()) throw new AppError('BATCH_RUNNING', 'Stop the active batch before clearing history.')
    return store.clearHistory()
  })
  register('batch:streamKey', (batchId: string, streamId?: string) => scheduler.streamKey(batchId, streamId))

  register('clipboard:write', (text: string) => clipboard.writeText(text))
  register('external:open', async (url: string) => {
    const parsed = new URL(url)
    const googleConsolePath = parsed.hostname === 'console.cloud.google.com' && [
      '/apis/library/youtube.googleapis.com',
      '/auth/clients'
    ].includes(parsed.pathname.replace(/\/$/, ''))
    const allowed = parsed.protocol === 'https:' && (
      ['github.com', 'studio.youtube.com', 'www.youtube.com'].includes(parsed.hostname) || googleConsolePath
    )
    if (!allowed) throw new AppError('URL_BLOCKED', 'This external URL is not allowed.')
    await shell.openExternal(parsed.toString())
  })

  register('updates:check', async () => {
    const currentVersion = app.getVersion()
    const response = await net.fetch('https://api.github.com/repos/bkntr/youtube-scheduler/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `YouTube-Scheduler/${currentVersion}` }
    })
    if (response.status === 404) return { available: false, currentVersion }
    if (!response.ok) throw new AppError('UPDATE_CHECK_FAILED', `Update check failed (${response.status}).`)
    const release = await response.json() as { tag_name?: string; name?: string; body?: string; html_url?: string }
    const latestVersion = release.tag_name?.replace(/^v/, '')
    return {
      available: Boolean(latestVersion && newerVersion(latestVersion, currentVersion)),
      currentVersion,
      latestVersion,
      releaseName: release.name,
      releaseNotes: release.body,
      url: release.html_url
    }
  })

  register('diagnostics:copy', async () => {
    const logPath = log.transports.file.getFile().path
    const contents = await readFile(logPath, 'utf8').catch(() => '')
    const report = [
      `YouTube Scheduler ${app.getVersion()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Electron: ${process.versions.electron}`,
      `Chrome: ${process.versions.chrome}`,
      `Node: ${process.versions.node}`,
      '',
      'Recent redacted log:',
      contents.slice(-20_000)
    ].join('\n')
    clipboard.writeText(report)
    return true
  })

  register('app:closeDecision', (mode: 'keep' | 'stop' | 'now') => dependencies.requestClose(mode))
}
