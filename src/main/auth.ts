import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { URL } from 'node:url'
import { shell } from 'electron'
import log from 'electron-log/main'
import { youtube } from '@googleapis/youtube'
import { googleAuthLibrary, OAuth2Client } from 'googleapis-common'
import type { AuthState, ChannelSummary } from '../shared/types'
import { AppError, toAppError } from './errors'
import type { AppStore } from './storage'
import type { OAuthClientConfiguration } from './oauth-config'

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl']

function createOAuthClient(configuration: OAuthClientConfiguration, redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret || undefined,
    redirectUri,
    clientAuthentication: configuration.clientSecret
      ? googleAuthLibrary.ClientAuthentication.ClientSecretPost
      : googleAuthLibrary.ClientAuthentication.None
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Could not bind OAuth callback server.'))
      resolve(address.port)
    })
  })
}

export class AuthService {
  private client?: OAuth2Client

  constructor(private readonly store: AppStore) {}

  async configure(configuration: OAuthClientConfiguration): Promise<void> {
    await this.disconnect()
    await this.store.saveOAuthClient(configuration)
    this.client = undefined
  }

  async getClient(requireCredentials = true): Promise<OAuth2Client> {
    if (this.client) return this.client
    const configuration = await this.store.loadOAuthClient()
    if (!configuration?.clientId) {
      throw new AppError('OAUTH_UNCONFIGURED', 'Choose a Google Desktop OAuth JSON before connecting.')
    }
    const client = createOAuthClient(configuration)
    const credentials = await this.store.loadCredentials()
    if (credentials) client.setCredentials(credentials)
    if (requireCredentials && !credentials?.refresh_token && !credentials?.access_token) {
      throw new AppError('AUTH_REQUIRED', 'Connect a YouTube account first.')
    }
    client.on('tokens', (tokens) => {
      void this.persistMergedCredentials(client, tokens).catch((error) => {
        log.error('Could not persist refreshed OAuth credentials', { code: toAppError(error).code })
      })
    })
    this.client = client
    return client
  }

  async connect(): Promise<AuthState> {
    const configuration = await this.store.loadOAuthClient()
    if (!configuration?.clientId) {
      return { status: 'unconfigured', channels: [], message: 'Choose a Google Desktop OAuth JSON before connecting.' }
    }
    const state = randomBytes(24).toString('base64url')
    const server = createServer()
    const port = await listen(server)
    const redirectUri = `http://127.0.0.1:${port}`
    const client = createOAuthClient(configuration, redirectUri)
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
    const authorizationUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: googleAuthLibrary.CodeChallengeMethod.S256
    })

    const codePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new AppError('OAUTH_TIMEOUT', 'Authentication timed out.')), 5 * 60 * 1000)
      server.on('request', (request, response) => {
        const requestUrl = new URL(request.url ?? '/', redirectUri)
        if (requestUrl.pathname !== '/') {
          response.writeHead(404).end()
          return
        }
        const returnedState = requestUrl.searchParams.get('state')
        const code = requestUrl.searchParams.get('code')
        const oauthError = requestUrl.searchParams.get('error')
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>YouTube Scheduler</title><p>Authentication complete. You may close this tab and return to YouTube Scheduler.</p><p lang="fr">Authentification terminée. Vous pouvez fermer cet onglet et revenir dans YouTube Scheduler.</p></html>')
        clearTimeout(timeout)
        server.close()
        if (oauthError) return reject(new AppError('OAUTH_DENIED', `Google authentication failed: ${oauthError}`))
        if (returnedState !== state) return reject(new AppError('OAUTH_STATE', 'Authentication state did not match. Please try again.'))
        if (!code) return reject(new AppError('OAUTH_CODE', 'Google did not return an authorization code.'))
        resolve(code)
      })
    })

    try {
      await shell.openExternal(authorizationUrl)
      const code = await codePromise
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
      client.setCredentials(tokens)
      await this.store.saveCredentials(tokens)
      this.client = client
      client.on('tokens', (nextTokens) => {
        void this.persistMergedCredentials(client, nextTokens).catch((error) => {
          log.error('Could not persist refreshed OAuth credentials', { code: toAppError(error).code })
        })
      })
      return await this.getState()
    } finally {
      if (server.listening) server.close()
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.client?.credentials.access_token) await this.client.revokeCredentials()
    } catch {
      // Local disconnection must still succeed if Google is unavailable.
    }
    this.client = undefined
    await this.store.clearCredentials()
  }

  async listChannels(): Promise<ChannelSummary[]> {
    const auth = await this.getClient()
    const client = youtube({ version: 'v3', auth })
    const response = await client.channels.list({ part: ['snippet'], mine: true, maxResults: 50 })
    return (response.data.items ?? []).map((channel) => ({
      id: channel.id ?? '',
      title: channel.snippet?.title ?? 'YouTube channel',
      thumbnailUrl: channel.snippet?.thumbnails?.default?.url ?? undefined
    })).filter((channel) => channel.id)
  }

  async getState(): Promise<AuthState> {
    const configuration = await this.store.loadOAuthClient()
    if (!configuration?.clientId) {
      return { status: 'unconfigured', channels: [], message: 'Choose a Google Desktop OAuth JSON before connecting.' }
    }
    const credentials = await this.store.loadCredentials()
    if (!credentials) return { status: 'disconnected', channels: [] }
    try {
      if (!this.client) await this.getClient()
      const channels = await this.listChannels()
      const settings = this.store.getSettings()
      const selectedChannelId = channels.some((channel) => channel.id === settings.selectedChannelId)
        ? settings.selectedChannelId
        : channels.length === 1 ? channels[0].id : undefined
      return { status: 'connected', channels, selectedChannelId }
    } catch (error) {
      const appError = toAppError(error)
      if (appError.code === 'AUTH_REQUIRED') {
        return { status: 'reauth-required', channels: [], message: appError.message }
      }
      throw appError
    }
  }

  private async persistMergedCredentials(client: OAuth2Client, tokens: googleAuthLibrary.Credentials): Promise<void> {
    const saved = await this.store.loadCredentials()
    const merged = { ...saved, ...client.credentials, ...tokens }
    await this.store.saveCredentials(merged)
  }
}
