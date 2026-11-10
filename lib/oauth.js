/**
 * OAuth plumbing for the Figma remote MCP server.
 *
 * Figma's authorization server (probed 2026-11-09; see the plugin README):
 *  - protected resource `https://mcp.figma.com/mcp`, AS `https://api.figma.com`;
 *  - RFC 7591 Dynamic Client Registration at
 *    `https://api.figma.com/v1/oauth/mcp/register`; Figma only registers
 *    clients whose `client_name` is on its MCP-catalog allowlist (a bare
 *    `403 Forbidden` otherwise);
 *  - `require_state_parameter: true`, `authorization_response_iss_parameter_supported: true`
 *    (RFC 9207 `iss` must be `https://api.figma.com`), PKCE S256 only;
 *  - confidential client: token refresh requires `client_secret_basic`;
 *    authorization codes expire 30 seconds after issue;
 *  - one access token per app+user: a second sign-in invalidates the first.
 *
 * The MCP TypeScript SDK does the protocol work: `auth()` performs RFC 9728 +
 * RFC 8414 discovery, DCR, PKCE, token exchange, refresh and `iss` validation
 * when handed an `OAuthClientProvider`. This module implements that provider,
 * the RFC 8252 loopback listener and the best-effort browser launch.
 *
 * Secrets are stored ONLY in the harness credential store as the record
 * `<scope>/<id>` = `figma-mcp/oauth` (never in configuration).
 *
 * @module @local/dsh-figma-mcp/lib/oauth
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { auth as runAuthFlow } from '@modelcontextprotocol/client'

/** Credential record this plugin owns: `<scope>/<id>` (scope = plugin name). */
export const AUTH_KEY = 'figma-mcp/oauth'

/** Loopback callback path; part of the registered redirect URI. */
export const CALLBACK_PATH = '/callback'

/**
 * Credential-record-backed store for the OAuth client state.
 *
 * The payload holds, exactly as the SDK hands it over: `clientInformation`
 * (from DCR, with the SDK's `issuer` stamp), `tokens` (+ a computed
 * `expiresAt`), `codeVerifier`, `state`, `discoveryState`. Every write goes
 * through `ctx.credentials.modifyRecord`, the store's only write path, so a
 * token refresh is a read-decide-replace under the store's lock.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context carrying `credentials`.
 * @returns {{read: () => Promise<Record<string, unknown> | undefined>, patch: (mutate: (payload: Record<string, unknown>) => Record<string, unknown>) => Promise<void>, clear: () => Promise<void>}} store.
 */
export function createGrantStore(ctx) {
  const read = async () => {
    const record = await ctx.credentials.readRecord(AUTH_KEY)
    if (record === undefined || record === null || record.kind !== 'grant') return undefined
    const payload = record.payload
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    return payload
  }
  // The credential store accepts JSON values only, and the SDK legitimately
  // hands over objects with explicit `undefined` properties (for example
  // `discoveryState.resourceMetadataUrl` when the server has no
  // `resource_metadata` URL). Normalize through JSON so such properties are
  // dropped instead of making the whole record unwritable.
  const jsonSafe = (value) => JSON.parse(JSON.stringify(value ?? {}))
  const patch = (mutate) =>
    ctx.credentials.modifyRecord(AUTH_KEY, async (current) => {
      const base =
        current !== undefined && current !== null && current.kind === 'grant' && current.payload !== null && typeof current.payload === 'object' && !Array.isArray(current.payload)
          ? current.payload
          : {}
      return { kind: 'grant', payload: jsonSafe(mutate({ ...base })) }
    })
  const clear = () => ctx.credentials.deleteRecord(AUTH_KEY)
  return { read, patch, clear }
}

/**
 * Build a fresh single-use OAuth `state` value (32 random bytes, base64url).
 *
 * @returns {string} state.
 */
export function createState() {
  return randomBytes(32).toString('base64url')
}

/**
 * Adapt the credential record to the MCP SDK's `OAuthClientProvider`.
 *
 * Only the members the SDK actually calls are implemented; every method the
 * SDK treats as optional is implemented too, because the callback leg requires
 * `discoveryState`/`saveDiscoveryState` for the SEP-2352 issuer binding.
 *
 * @param {object} input provider wiring.
 * @param {ReturnType<typeof createGrantStore>} input.store credential store.
 * @param {string} input.redirectUri exact loopback redirect URI (must match DCR).
 * @param {string} input.clientName DCR `client_name` (Figma allowlist gate).
 * @param {string} input.scope requested scope (`mcp:connect`).
 * @param {string} [input.clientId] pre-registered client id (skips DCR when paired with the secret).
 * @param {string} [input.clientSecret] pre-registered client secret.
 * @param {(url: string) => void} [input.onAuthorizationUrl] receives the authorization URL.
 * @returns {object} OAuthClientProvider.
 */
export function createOAuthProvider({ store, redirectUri, clientName, scope, clientId, clientSecret, onAuthorizationUrl }) {
  const staticClient = typeof clientId === 'string' && clientId !== ''
  return {
    redirectUrl: redirectUri,
    clientMetadata: {
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Confidential client: Figma's refresh requires the secret (probed).
      token_endpoint_auth_method: 'client_secret_basic',
      scope,
    },
    async clientInformation() {
      if (staticClient) {
        return {
          client_id: clientId,
          client_secret: typeof clientSecret === 'string' && clientSecret !== '' ? clientSecret : undefined,
          token_endpoint_auth_method: 'client_secret_basic',
        }
      }
      const stored = (await store.read())?.clientInformation
      // A changed `clientName` invalidates the cached registration: Figma binds
      // the registration to the client name, so re-register instead of silently
      // keeping the old identity (the server may also have changed entirely).
      if (stored !== undefined && stored !== null && typeof stored.client_name === 'string' && stored.client_name !== clientName) {
        await store.patch((payload) => {
          const next = { ...payload }
          delete next.clientInformation
          return next
        })
        return undefined
      }
      return stored
    },
    async saveClientInformation(clientInformation) {
      if (staticClient) return
      await store.patch((payload) => ({ ...payload, clientInformation }))
    },
    async tokens() {
      return (await store.read())?.tokens
    },
    async saveTokens(tokens) {
      // Refresh responses may omit refresh_token: merge instead of replace, and
      // keep an absolute expiry so a near-expiry token can be refreshed early.
      await store.patch((payload) => {
        const merged = { ...(payload.tokens ?? {}), ...tokens }
        if (typeof tokens?.expires_in === 'number' && Number.isFinite(tokens.expires_in)) {
          merged.expiresAt = Date.now() + tokens.expires_in * 1000
        }
        // The flow that needed `state`/`codeVerifier` is done once tokens land.
        const next = { ...payload, tokens: merged }
        delete next.state
        delete next.codeVerifier
        return next
      })
    },
    async redirectToAuthorization(authorizationUrl) {
      onAuthorizationUrl?.(String(authorizationUrl))
    },
    async saveCodeVerifier(codeVerifier) {
      await store.patch((payload) => ({ ...payload, codeVerifier }))
    },
    async codeVerifier() {
      return (await store.read())?.codeVerifier
    },
    async state() {
      // Figma requires a state parameter (`require_state_parameter: true`), and
      // the SDK only sends one when `state()` returns it. Generate lazily so a
      // redirect triggered from a 401 also carries a fresh, single-use state.
      const existing = (await store.read())?.state
      if (typeof existing === 'string' && existing !== '') return existing
      const state = createState()
      await store.patch((payload) => ({ ...payload, state }))
      return state
    },
    async saveDiscoveryState(discoveryState) {
      await store.patch((payload) => ({ ...payload, discoveryState }))
    },
    async discoveryState() {
      return (await store.read())?.discoveryState
    },
    async invalidateCredentials(kind) {
      await store.patch((payload) => {
        const next = { ...payload }
        if (kind === 'client' || kind === 'all') {
          delete next.clientInformation
          delete next.tokens
        } else if (kind === 'tokens' || kind === 'all') {
          delete next.tokens
        } else if (kind === 'verifier') {
          delete next.codeVerifier
        } else if (kind === 'discovery') {
          delete next.discoveryState
        }
        return next
      })
    },
  }
}

/**
 * Start the RFC 8252 loopback listener that receives the authorization code.
 *
 * The response page is written only after `state` was validated (and, for a
 * provider error, after the failure was recorded), so a mix-up attempt or a
 * refused consent never looks like success. The RFC 9207 `iss` parameter is
 * forwarded to the SDK, which validates it against the discovered
 * authorization-server metadata before redeeming the code — so the page says
 * "authorization received", not "connected", until the exchange really
 * finishes.
 *
 * The exposed `result` promise has a no-op rejection handler attached: a
 * caller that aborts before awaiting it (or a bind failure) must never produce
 * an unhandled rejection, which the harness Host treats as fatal.
 *
 * @param {object} input listener wiring.
 * @param {number} input.port loopback port (also encoded in the registered redirect URI).
 * @param {string} [input.callbackPath] path of the redirect URI.
 * @param {string} input.expectedState single-use `state` this attempt expects.
 * @param {number} input.timeoutMs how long to wait for the browser.
 * @param {AbortSignal} [input.signal] cancellation from the caller.
 * @returns {Promise<{redirectUri: string, result: Promise<URLSearchParams>, close: () => void}>} listener.
 */
export async function startLoopback({ port, callbackPath = CALLBACK_PATH, expectedState, timeoutMs, signal }) {
  const pending = Promise.withResolvers()
  // Guard the exposed promise: rejections must never be unhandled.
  pending.promise.catch(() => {})
  const settled = { done: false }
  const finish = (fn, value) => {
    if (settled.done) return
    settled.done = true
    fn(value)
  }
  let timer
  let server
  let listening = false
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`
  const respond = (response, status, title, body) => {
    try {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(page(title, body))
    } catch {
      // The browser may have gone away.
    }
  }
  server = http.createServer((request, response) => {
    // Only GET is a valid redirect target; a POST from another local process
    // must not be able to settle the attempt.
    if (request.method !== 'GET') {
      respond(response, 405, 'Figma authorization', 'Method not allowed.')
      return
    }
    let url
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    } catch {
      respond(response, 400, 'Figma authorization', 'Bad request.')
      return
    }
    if (url.pathname !== callbackPath) {
      respond(response, 404, 'Figma authorization', 'Not found.')
      return
    }
    const params = url.searchParams
    // State is checked before any other parameter, and a mismatch IGNORES the
    // request instead of settling the attempt: a local page or process that does
    // not know the single-use state must neither authenticate nor cancel the
    // sign-in. Only the timeout ends an attempt whose callback never arrives.
    if (params.get('state') !== expectedState) {
      respond(response, 400, 'Authorization rejected', 'The state parameter does not match this attempt (possible mix-up attack). Start the sign-in again from DeepSeek Harness.')
      return
    }
    const error = params.get('error')
    if (error !== null && error !== '') {
      const description = params.get('error_description')
      respond(response, 400, 'Authorization refused', `Figma reported: ${escapeHtml(error)}${description ? ` (${escapeHtml(description)})` : ''}.`)
      finish(pending.reject, new Error(`Figma authorization failed: ${error}${description ? ` (${description})` : ''}`))
      return
    }
    const code = params.get('code')
    if (code === null || code === '') {
      respond(response, 400, 'Authorization failed', 'The callback carried no authorization code.')
      finish(pending.reject, new Error('Figma authorization callback carried no code'))
      return
    }
    respond(response, 200, 'Authorization received', 'Autorização recebida. O DeepSeek Harness está concluindo a conexão com o Figma — você pode fechar esta aba e voltar ao app.')
    finish(pending.resolve, params)
  })
  server.once('error', (error) => finish(pending.reject, error))
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        listening = true
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  } catch (error) {
    finish(pending.reject, error)
    throw error
  }
  timer = setTimeout(() => {
    finish(pending.reject, new Error(`Figma authorization timed out after ${Math.round(timeoutMs / 1000)} s`))
  }, timeoutMs)
  timer.unref?.()
  const onAbort = () => finish(pending.reject, new DOMException('Figma authorization cancelled', 'AbortError'))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted === true) onAbort()
  const cleanup = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (listening) {
      try {
        server.close()
      } catch {
        // Already closed.
      }
    }
  }
  return {
    redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
    result: pending.promise,
    close: () => {
      finish(pending.reject, new DOMException('Figma authorization cancelled', 'AbortError'))
      cleanup()
    },
  }
}

/**
 * Escape user-influenced text for the loopback result page.
 *
 * @param {string} value untrusted text.
 * @returns {string} escaped text.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

/**
 * Open a URL in the host's default browser, best effort.
 *
 * Host plugin code runs in-process; the product exposes no "open an arbitrary
 * external URL" seam (the shipped `dsh-host-open-in-app` opens workspace
 * directories in editors). A detached OS launcher is therefore the mechanism,
 * and failure is harmless because the tool result and the status text both
 * carry the URL.
 *
 * @param {string} url HTTPS authorization URL.
 * @param {string} [platform] `process.platform`, injectable for tests.
 * @returns {boolean} whether a launcher was spawned.
 */
export function openInBrowser(url, platform = process.platform) {
  try {
    const [command, args] =
      platform === 'darwin'
        ? ['open', [url]]
        : platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', url]]
          : ['xdg-open', [url]]
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Run the SDK's OAuth orchestrator for one leg.
 *
 * `authorizationCode` present runs the callback leg (validates `iss`, redeems
 * the code — Figma codes expire in 30 s, so call it with nothing in between).
 * Without it, the call refreshes a stored grant when possible, or performs
 * discovery + DCR + PKCE and hands the authorization URL to the provider.
 *
 * @param {object} input call wiring.
 * @param {object} input.provider OAuthClientProvider.
 * @param {string} input.serverUrl protected resource URL.
 * @param {string} input.scope requested scope.
 * @param {string} [input.authorizationCode] code from the callback.
 * @param {string} [input.iss] RFC 9207 `iss` from the callback.
 * @returns {Promise<'AUTHORIZED' | 'REDIRECT'>} the SDK's outcome.
 */
export function runAuthorization({ provider, serverUrl, scope, authorizationCode, iss }) {
  return runAuthFlow(provider, {
    serverUrl,
    scope,
    ...(authorizationCode === undefined ? {} : { authorizationCode }),
    ...(iss === undefined ? {} : { iss }),
  })
}
