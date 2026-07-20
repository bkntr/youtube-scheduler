import { describe, expect, it } from 'vitest'
import { parseOAuthClientJson } from '../src/main/oauth-config'

describe('Google Desktop OAuth JSON', () => {
  it('extracts an installed-app client without retaining unrelated fields', () => {
    const configuration = parseOAuthClientJson(JSON.stringify({
      installed: {
        client_id: '123-example.apps.googleusercontent.com',
        client_secret: 'GOCSPX-example',
        project_id: 'example-project',
        redirect_uris: ['http://localhost']
      }
    }))

    expect(configuration).toEqual({
      clientId: '123-example.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-example'
    })
  })

  it('rejects web application credentials', () => {
    expect(() => parseOAuthClientJson(JSON.stringify({
      web: {
        client_id: '123-example.apps.googleusercontent.com',
        client_secret: 'GOCSPX-example'
      }
    }))).toThrow(/Desktop app OAuth JSON/)
  })

  it('accepts current public desktop clients without a client secret', () => {
    expect(parseOAuthClientJson(JSON.stringify({
      installed: {
        client_id: '123-public.apps.googleusercontent.com',
        redirect_uris: ['http://localhost']
      }
    }))).toEqual({
      clientId: '123-public.apps.googleusercontent.com',
      clientSecret: ''
    })
  })

  it('rejects invalid JSON', () => {
    expect(() => parseOAuthClientJson('{')).toThrow(/not valid JSON/)
  })
})
