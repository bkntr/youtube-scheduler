import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { googleAuthLibrary } from 'googleapis-common'
import type { AppSettings, BatchRecord } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { settingsSchema } from '../shared/schemas'
import type { OAuthClientConfiguration } from './oauth-config'

interface PersistedState {
  version: 1
  settings: AppSettings
  batches: BatchRecord[]
  channelStreams: Record<string, string>
}

const EMPTY_STATE: PersistedState = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  batches: [],
  channelStreams: {}
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

export class AppStore {
  private state: PersistedState = structuredClone(EMPTY_STATE)
  private persistQueue: Promise<void> = Promise.resolve()
  private readonly statePath: string
  private readonly credentialPath: string
  private readonly oauthClientPath: string

  constructor(userDataPath = app.getPath('userData')) {
    this.statePath = join(userDataPath, 'state.json')
    this.credentialPath = join(userDataPath, 'oauth-credentials.bin')
    this.oauthClientPath = join(userDataPath, 'oauth-client.bin')
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedState>
      const settings = settingsSchema.safeParse(raw.settings)
      this.state = {
        version: 1,
        settings: settings.success ? settings.data : structuredClone(DEFAULT_SETTINGS),
        batches: Array.isArray(raw.batches) ? raw.batches.slice(0, 30) : [],
        channelStreams: raw.channelStreams && typeof raw.channelStreams === 'object' ? raw.channelStreams : {}
      }
    } catch {
      this.state = structuredClone(EMPTY_STATE)
      this.state.settings.locale = app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en'
    }
  }

  getSettings(): AppSettings {
    return structuredClone(this.state.settings)
  }

  async setSettings(settings: AppSettings): Promise<AppSettings> {
    this.state.settings = settingsSchema.parse(settings)
    await this.persist()
    return this.getSettings()
  }

  listBatches(): BatchRecord[] {
    return structuredClone(this.state.batches)
  }

  getBatch(id: string): BatchRecord | undefined {
    const batch = this.state.batches.find((candidate) => candidate.id === id)
    return batch ? structuredClone(batch) : undefined
  }

  async putBatch(batch: BatchRecord): Promise<void> {
    const existing = this.state.batches.findIndex((candidate) => candidate.id === batch.id)
    if (existing >= 0) this.state.batches.splice(existing, 1)
    this.state.batches.unshift(structuredClone(batch))
    this.state.batches = this.state.batches.slice(0, 30)
    await this.persist()
  }

  async clearHistory(): Promise<void> {
    this.state.batches = []
    await this.persist()
  }

  getChannelStream(channelId: string): string | undefined {
    return this.state.channelStreams[channelId]
  }

  async setChannelStream(channelId: string, streamId: string): Promise<void> {
    this.state.channelStreams[channelId] = streamId
    await this.persist()
  }

  async clearChannelStream(channelId: string): Promise<void> {
    delete this.state.channelStreams[channelId]
    await this.persist()
  }

  async loadCredentials(): Promise<googleAuthLibrary.Credentials | undefined> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return undefined
      const encrypted = await readFile(this.credentialPath)
      return JSON.parse(safeStorage.decryptString(encrypted)) as googleAuthLibrary.Credentials
    } catch {
      return undefined
    }
  }

  async saveCredentials(credentials: googleAuthLibrary.Credentials): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable for this Windows user.')
    }
    await mkdir(dirname(this.credentialPath), { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(credentials))
    const temporary = `${this.credentialPath}.tmp`
    await writeFile(temporary, encrypted, { mode: 0o600 })
    await rename(temporary, this.credentialPath)
  }

  async clearCredentials(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(this.credentialPath)
    } catch {
      // Already disconnected.
    }
  }

  async loadOAuthClient(): Promise<OAuthClientConfiguration | undefined> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return undefined
      const encrypted = await readFile(this.oauthClientPath)
      return JSON.parse(safeStorage.decryptString(encrypted)) as OAuthClientConfiguration
    } catch {
      return undefined
    }
  }

  async saveOAuthClient(configuration: OAuthClientConfiguration): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure OAuth configuration storage is unavailable for this Windows user.')
    }
    await mkdir(dirname(this.oauthClientPath), { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(configuration))
    const temporary = `${this.oauthClientPath}.tmp`
    await writeFile(temporary, encrypted, { mode: 0o600 })
    await rename(temporary, this.oauthClientPath)
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.state)
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => atomicJsonWrite(this.statePath, snapshot))
    await this.persistQueue
  }
}
