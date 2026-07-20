import { z } from 'zod'
import { AppError } from './errors'

export interface OAuthClientConfiguration {
  clientId: string
  clientSecret: string
}

const desktopClientSchema = z.object({
  client_id: z.string().min(1).max(500).refine(
    (value) => value.endsWith('.apps.googleusercontent.com'),
    'The OAuth client ID is not a Google Desktop client ID.'
  ),
  client_secret: z.string().min(1).max(500).optional()
}).passthrough()

const downloadedClientSchema = z.object({
  installed: desktopClientSchema
}).passthrough()

export function parseOAuthClientJson(contents: string): OAuthClientConfiguration {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new AppError('OAUTH_CONFIG_INVALID', 'The selected file is not valid JSON.')
  }

  const result = downloadedClientSchema.safeParse(parsed)
  if (!result.success) {
    throw new AppError(
      'OAUTH_CONFIG_INVALID',
      'Choose the Desktop app OAuth JSON downloaded from Google Cloud. Web application credentials are not supported.'
    )
  }

  return {
    clientId: result.data.installed.client_id,
    clientSecret: result.data.installed.client_secret ?? ''
  }
}
