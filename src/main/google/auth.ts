import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { EncryptedJson } from '../secrets'

// Google sign-in for a desktop app (OAuth 2.0 with a loopback redirect and PKCE), as Google
// documents for installed apps. The user makes their own OAuth client in Google Cloud and
// pastes its ID and secret (a desktop client's secret isn't confidential, but it's still
// kept with the refresh token, encrypted). Only `calendar.app.created` is asked for: Engram
// can make its own calendar and change events on it, and can't see any other calendar.

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
  refreshToken?: string
}

const base64url = (b: Buffer) => b.toString('base64url')

/**
 * The client ID and secret from what the user pasted: the two values, or the JSON file
 * Google Cloud downloads ({"installed": {"client_id", "client_secret", …}}).
 */
export function parseClient(
  clientIdOrJson: string,
  secret = ''
): Pick<GoogleCredentials, 'clientId' | 'clientSecret'> {
  const raw = clientIdOrJson.trim()
  if (raw.startsWith('{')) {
    let parsed: { installed?: { client_id?: string; client_secret?: string } }
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('That isn’t the JSON file Google Cloud downloads.')
    }
    const c = parsed.installed
    if (!c?.client_id || !c.client_secret) {
      throw new Error('Use the client file of a “Desktop app” OAuth client.')
    }
    return { clientId: c.client_id, clientSecret: c.client_secret }
  }
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(raw)) {
    throw new Error('The client ID ends in “.apps.googleusercontent.com”.')
  }
  if (!secret.trim()) throw new Error('Paste the client secret too.')
  return { clientId: raw, clientSecret: secret.trim() }
}

export interface GoogleAuthDeps {
  store: EncryptedJson<GoogleCredentials>
  openExternal(url: string): Promise<void>
  fetch?: typeof fetch
}

/** Signs in, keeps the refresh token, and hands out access tokens. */
export class GoogleAuth {
  private access: { token: string; expires: number } | null = null
  private pending: Server | null = null

  constructor(private readonly deps: GoogleAuthDeps) {}

  private get http(): typeof fetch {
    return this.deps.fetch ?? fetch
  }

  async state(): Promise<{ hasClient: boolean; signedIn: boolean; clientId: string | null }> {
    const c = await this.deps.store.get()
    return { hasClient: !!c, signedIn: !!c?.refreshToken, clientId: c?.clientId ?? null }
  }

  async setClient(clientIdOrJson: string, secret?: string): Promise<void> {
    const client = parseClient(clientIdOrJson, secret)
    this.access = null
    await this.deps.store.set(client)
  }

  /** Forget the sign-in (the client stays, so signing in again is one click). */
  async signOut(): Promise<void> {
    const c = await this.deps.store.get()
    this.access = null
    if (!c) return
    if (c.refreshToken) {
      // Tell Google too; carry on if it can't be reached.
      await this.http('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: c.refreshToken }),
        signal: AbortSignal.timeout(10_000)
      }).catch(() => {})
    }
    await this.deps.store.set({ clientId: c.clientId, clientSecret: c.clientSecret })
  }

  /** Remove the client and the sign-in. */
  async forget(): Promise<void> {
    await this.signOut()
    this.deps.store.clear()
  }

  /**
   * Sign in through the browser: a one-off listener on 127.0.0.1 catches Google's redirect.
   * Resolves once the refresh token is stored.
   */
  async signIn(): Promise<void> {
    const client = await this.deps.store.get()
    if (!client) throw new Error('Add your Google OAuth client first.')
    this.pending?.close()

    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
      (resolve, reject) => {
        let redirectUri = ''
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (url.pathname !== '/') {
            res.writeHead(404).end()
            return
          }
          const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><meta charset="utf-8"><title>Engram</title><body style="font:15px -apple-system;padding:40px;background:#0a0a0b;color:#e8e8eb">${
              ok
                ? 'Signed in to Google. You can close this tab and go back to Engram.'
                : 'Google sign-in didn’t finish. Go back to Engram and try again.'
            }</body>`
          )
          clearTimeout(timer)
          server.close()
          this.pending = null
          if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri })
          else
            reject(
              new Error(
                url.searchParams.get('error') === 'access_denied'
                  ? 'Google sign-in was cancelled.'
                  : 'Google sign-in didn’t finish.'
              )
            )
        })
        const timer = setTimeout(() => {
          server.close()
          this.pending = null
          reject(new Error('Google sign-in timed out. Try again.'))
        }, SIGN_IN_TIMEOUT_MS)
        server.listen(0, '127.0.0.1', () => {
          redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
          const url = new URL(AUTH_URL)
          url.search = new URLSearchParams({
            client_id: client.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: GOOGLE_SCOPE,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            access_type: 'offline',
            prompt: 'consent'
          }).toString()
          this.deps.openExternal(url.toString()).catch(reject)
        })
        server.on('error', reject)
        this.pending = server
      }
    )

    const tokens = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret
    })
    if (!tokens.refresh_token)
      throw new Error('Google didn’t return a sign-in that lasts. Try again.')
    await this.deps.store.set({ ...client, refreshToken: tokens.refresh_token })
    this.access = {
      token: tokens.access_token,
      expires: Date.now() + (tokens.expires_in - 60) * 1000
    }
  }

  /** A valid access token (refreshed when it's about to expire). */
  async accessToken(): Promise<string> {
    if (this.access && this.access.expires > Date.now()) return this.access.token
    const c = await this.deps.store.get()
    if (!c?.refreshToken) throw new Error('Sign in to Google in Settings.')
    try {
      const t = await this.token({
        grant_type: 'refresh_token',
        refresh_token: c.refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret
      })
      this.access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 }
      return t.access_token
    } catch (e) {
      if ((e as Error).message === 'invalid_grant') {
        // Revoked or expired (an OAuth app left in "Testing" only gets 7-day sign-ins).
        await this.deps.store.set({ clientId: c.clientId, clientSecret: c.clientSecret })
        throw new Error('Google signed Engram out. Sign in again in Settings.', { cause: e })
      }
      throw e
    }
  }

  private async token(
    body: Record<string, string>
  ): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000)
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String(json.error ?? `Google answered ${res.status}.`))
    return json as { access_token: string; expires_in: number; refresh_token?: string }
  }
}
