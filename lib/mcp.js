/**
 * Live MCP connection supervisor for the Figma remote server.
 *
 * Owns one `Client` + one `StreamableHTTPClientTransport` generation, the
 * public tool registrations mirrored onto `ctx.tools`, the server's
 * `instructions` snapshot, and the resource operations handed to
 * `ctx.mcpResources`. The OAuth provider/store live in `./oauth.js`.
 *
 * Public tool names follow the shipped bridge's pinned contract:
 * `mcp__<serverName>__<rawName>`, normalized to `[A-Za-z0-9_-]{1,64}` with a
 * 12-hex-char SHA-256 identity suffix when normalization is lossy.
 *
 * @module @dsh-burn-plugins/dsh-figma-mcp-oauth/lib/mcp
 */

import { createHash } from 'node:crypto'

import {
  Client,
  RegistrationRejectedError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'

import {
  CALLBACK_PATH,
  createGrantStore,
  createOAuthProvider,
  createState,
  openInBrowser,
  runAuthorization,
  startLoopback,
} from './oauth.js'

/** DeepSeek function-name contract. Wire constant, not configuration. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** Characters the function-name contract forbids. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex chars of the identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Scope requested from Figma (the only scope its MCP server advertises). */
const DEFAULT_SCOPE = 'mcp:connect'

/**
 * DeepSeek function-name safe public name, identical to the shipped MCP bridge:
 * clean `mcp__<server>__<raw>`; otherwise a hash-suffixed normalized form so
 * distinct MCP identities never collapse.
 *
 * @param {string} serverName configured namespace.
 * @param {string} rawName the server's own tool name.
 * @returns {string} model-facing tool name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Connection states surfaced to the user through `figma_status`.
 * @typedef {'unauthenticated' | 'authorizing' | 'connecting' | 'connected' | 'disconnected' | 'error'} ConnectionStatus
 */

/** Supervisor for one configured Figma MCP server. */
export class FigmaConnection {
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx
  /** @type {object} resolved options */
  #options
  /** @type {ReturnType<typeof createGrantStore>} */
  #store
  /** @type {(level: 'info'|'warn'|'error', message: string) => void} */
  #log
  /** @type {Client | undefined} */
  #client
  /** @type {StreamableHTTPClientTransport | undefined} */
  #transport
  /** @type {Map<string, () => void>} public name -> unregister */
  #toolDisposers = new Map()
  /** @type {string} */
  #instructions = ''
  /** @type {ConnectionStatus} */
  #status = 'unauthenticated'
  /** @type {string | undefined} */
  #lastError
  /** @type {string | undefined} browser authorization URL of the last attempt */
  #authorizationUrl
  /** @type {Promise<string> | undefined} in-flight login */
  #login
  /** @type {Promise<string> | undefined} in-flight connect */
  #connecting
  /** @type {Promise<void> | undefined} in-flight tool sync */
  #syncing
  /** @type {AbortController} cancels the pending flow on disposal */
  #flowAbort = new AbortController()
  /** @type {AbortController | undefined} cancels the current authorization attempt */
  #flowController
  /** @type {boolean} guards re-entrant authorization-loss handling */
  #authLossHandled = false

  /**
   * @param {object} input wiring.
   * @param {import('@deepseek-ai/cordis').Context} input.ctx plugin context.
   * @param {object} input.options resolved row options.
   * @param {(level: 'info'|'warn'|'error', message: string) => void} input.log logger.
   */
  constructor({ ctx, options, log }) {
    this.#ctx = ctx
    this.#options = options
    this.#store = createGrantStore(ctx)
    this.#log = log
  }

  /** @returns {boolean} whether a live server generation is registered. */
  get connected() {
    return this.#status === 'connected' && this.#client !== undefined
  }

  /** @returns {number} number of registered `mcp__*` tools. */
  get toolCount() {
    return this.#toolDisposers.size
  }

  /** @returns {string} browser authorization URL of the current/last attempt. */
  get authorizationUrl() {
    return this.#authorizationUrl
  }

  /**
   * The server's instructions as a logged prompt section; empty before the
   * first successful connection (absent instructions add no prompt text).
   *
   * @returns {string} literal prompt text.
   */
  instructions() {
    return this.#instructions
  }

  /**
   * One-line status for tools/commands.
   *
   * @returns {string} status text.
   */
  statusLine() {
    const parts = [`Figma MCP: ${this.#status}`]
    if (this.connected) {
      parts.push(`${this.toolCount} tool(s) available`, `endpoint ${this.#options.url}`)
    } else if (this.#options.authMode === 'none') {
      parts.push(`no OAuth (local server) — endpoint ${this.#options.url}`)
    } else if (this.#status === 'authorizing' && this.#authorizationUrl !== undefined) {
      parts.push(`open this URL to finish: ${this.#authorizationUrl}`)
    } else if (this.#lastError !== undefined) {
      parts.push(this.#lastError)
    } else if (this.#status === 'unauthenticated') {
      parts.push('not authorized yet — use figma_login to connect')
    }
    return parts.join(' — ')
  }

  /**
   * Build a fresh OAuth provider for one attempt (storage is shared).
   *
   * @param {object} [input] wiring.
   * @param {(notice: {message: string, url?: string}) => void} [input.notify] user-visible notices.
   * @param {boolean} [input.interactive] open the browser and notify the human
   *   (true for a human-initiated login, false for a redirect triggered by a
   *   rejected token during background work, which must not spawn tabs).
   * @returns {object} OAuthClientProvider.
   */
  #provider({ notify, interactive = false } = {}) {
    return createOAuthProvider({
      store: this.#store,
      redirectUri: this.#redirectUri(),
      clientName: this.#options.clientName,
      scope: this.#options.scope,
      clientId: this.#options.clientId,
      clientSecret: this.#options.clientSecret,
      onAuthorizationUrl: (url) => {
        this.#authorizationUrl = url
        // Log the endpoint only: the query carries the single-use state token.
        try {
          const parsed = new URL(url)
          this.#log('info', `authorization page requested: ${parsed.origin}${parsed.pathname}`)
        } catch {
          this.#log('info', 'authorization page requested')
        }
        if (!interactive) return
        notify?.({ message: 'Open the Figma page to authorize DeepSeek Harness, then come back to this window.', url })
        if (this.#options.openBrowser) openInBrowser(url)
      },
    })
  }

  /** @returns {string} exact redirect URI derived from the configured port. */
  #redirectUri() {
    return `http://127.0.0.1:${this.#options.redirectPort}${CALLBACK_PATH}`
  }

  /**
   * Run the whole interactive OAuth procedure: bind the loopback listener,
   * let the SDK perform discovery + DCR + PKCE (or refresh a stored grant),
   * open the authorization page, wait for the callback, redeem the code and
   * then connect for real and register the server's tools.
   *
   * Concurrent calls share one attempt.
   *
   * @param {object} [input] login wiring.
   * @param {AbortSignal} [input.signal] cancellation.
   * @param {(notice: {message: string, url?: string}) => void} [input.notify] user-visible notices.
   * @returns {Promise<string>} status text.
   */
  async login({ signal, notify } = {}) {
    if (this.connected) return this.statusLine()
    if (this.#login !== undefined) return this.#login
    this.#login = this.#loginOnce({ signal, notify }).finally(() => {
      this.#login = undefined
    })
    return this.#login
  }

  /**
   * Start (or join) an authorization attempt without waiting for the human.
   *
   * Resolves as soon as the authorization URL exists (or an error occurred), so
   * a model-facing tool can return the link immediately; the attempt keeps
   * running in the background until the callback arrives.
   *
   * @param {object} [input] wiring.
   * @param {(notice: {message: string, url?: string}) => void} [input.notify] user-visible notices.
   * @returns {Promise<string>} status text, including the URL when available.
   */
  async startLogin({ notify } = {}) {
    if (this.connected) return this.statusLine()
    const pending = this.login({ notify })
    let failure
    pending.catch((error) => {
      failure = error
      this.#log('warn', `background authorization failed: ${messageOf(error)}`)
    })
    const url = await this.#waitForAuthorizationUrl(15000, () => failure !== undefined)
    if (this.connected) return this.statusLine()
    if (url === undefined) {
      // Do not claim success when the attempt already failed (DCR 403, busy
      // callback port, discovery error): surface the actionable text instead.
      if (failure !== undefined) return `Figma: could not start authorization — ${describeAuthorizationError(failure)}`
      if (this.#lastError !== undefined) return this.statusLine()
      return 'Figma: authorization in progress; call figma_status to follow it.'
    }
    return `Figma: authorization started in the background. Open this URL to finish: ${url} After authorizing, call figma_status to confirm the connection.`
  }

  /**
   * Wait briefly for the redirect URL produced inside the attempt, stopping
   * early when the attempt settles or fails.
   *
   * @param {number} timeoutMs bound.
   * @param {() => boolean} [isDone] caller-supplied early-exit predicate.
   * @returns {Promise<string | undefined>} authorization URL, when it appeared.
   */
  async #waitForAuthorizationUrl(timeoutMs, isDone = () => false) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.#authorizationUrl !== undefined) return this.#authorizationUrl
      if (this.connected || isDone()) return undefined
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return this.#authorizationUrl
  }

  /**
   * Run one authorization attempt. The caller's abort signal, the plugin
   * lifetime and `logout()` all cancel it through one per-attempt controller;
   * listeners are always removed and the loopback listener is always closed.
   *
   * @param {object} input login wiring.
   * @param {AbortSignal} [input.signal] cancellation.
   * @param {(notice: object) => void} [input.notify] user-visible notices.
   * @returns {Promise<string>} status text.
   */
  async #loginOnce({ signal, notify }) {
    if (this.#options.authMode === 'none') {
      await this.connect()
      return this.statusLine()
    }
    this.#status = 'authorizing'
    this.#lastError = undefined
    this.#authorizationUrl = undefined
    this.#authLossHandled = false
    const controller = new AbortController()
    this.#flowController = controller
    const forwardAbort = () => controller.abort()
    // The caller's signal and the plugin lifetime both cancel the wait.
    signal?.addEventListener('abort', forwardAbort, { once: true })
    this.#flowAbort.signal.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted === true || this.#flowAbort.signal.aborted) controller.abort()
    const cleanupAbort = () => {
      signal?.removeEventListener('abort', forwardAbort)
      this.#flowAbort.signal.removeEventListener('abort', forwardAbort)
      this.#flowController = undefined
    }
    let loopback
    try {
      const state = createState()
      // Start every attempt from a clean authorization leg: fresh single-use
      // state and code verifier, reusing the cached client registration.
      await this.#store.patch((payload) => {
        const next = { ...payload, state }
        delete next.codeVerifier
        return next
      })
      try {
        loopback = await startLoopback({
          port: this.#options.redirectPort,
          callbackPath: CALLBACK_PATH,
          expectedState: state,
          timeoutMs: this.#options.loginTimeoutMs,
          signal: controller.signal,
        })
      } catch (error) {
        throw new Error(`could not listen on callback port ${this.#options.redirectPort}: ${messageOf(error)}`, { cause: error })
      }
      const provider = this.#provider({ notify, interactive: true })
      const serverUrl = this.#options.url
      const outcome = await runAuthorization({ provider, serverUrl, scope: this.#options.scope })
      if (outcome === 'AUTHORIZED') {
        // A stored grant was refreshed; no human interaction was needed.
        this.#status = 'connecting'
        await this.connect()
        return this.statusLine()
      }

      const callbackParams = await loopback.result
      // Figma authorization codes expire 30 s after issue: redeem immediately,
      // with nothing in between.
      const code = callbackParams.get('code')
      const iss = callbackParams.get('iss') ?? undefined
      this.#status = 'connecting'
      await runAuthorization({ provider, serverUrl, scope: this.#options.scope, authorizationCode: code, iss })
      await this.connect()
      this.#log('info', `authorization complete (${this.toolCount} tools)`)
      return this.statusLine()
    } catch (error) {
      if (isCancellation(error)) {
        // Cancelled by logout/dispose/turn abort: no error state, just stop.
        this.#status = this.connected ? 'connected' : 'unauthenticated'
        this.#lastError = undefined
        throw new Error('Figma authorization was cancelled', { cause: error })
      }
      this.#status = this.connected ? 'connected' : 'error'
      this.#lastError = describeAuthorizationError(error)
      this.#log('warn', `authorization attempt failed: ${this.#lastError}`)
      throw new Error(this.#lastError, { cause: error })
    } finally {
      cleanupAbort()
      loopback?.close()
    }
  }

  /**
   * Connect using the stored grant, then mirror the server's tools.
   * Concurrent calls share one attempt; an already connected instance is a no-op.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) return
    if (this.#connecting !== undefined) return this.#connecting
    this.#connecting = this.#connectOnce().finally(() => {
      this.#connecting = undefined
    })
    return this.#connecting
  }

  /** @returns {Promise<void>} */
  async #connectOnce() {
    const oauth = this.#options.authMode !== 'none'
    if (oauth) {
      const grant = await this.#store.read()
      if (grant?.tokens?.access_token === undefined) {
        this.#status = 'unauthenticated'
        throw new Error('Figma is not connected yet: call figma_login first.')
      }
    }
    await this.#closeGeneration()
    this.#status = 'connecting'
    // A redirect triggered by a rejected token while connecting is NOT a
    // human-initiated sign-in: capture the URL for status, but never open tabs.
    const provider = oauth ? this.#provider({ interactive: false }) : undefined
    const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), provider === undefined ? {} : { authProvider: provider })
    const client = new Client(
      { name: 'dsh-figma-mcp-oauth', version: this.#options.version },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        // Re-sync when the server says its tool list changed.
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              void this.syncTools().catch((error) => this.#log('warn', `tool re-sync failed: ${messageOf(error)}`))
            },
          },
        },
      },
    )
    try {
      await client.connect(transport)
    } catch (error) {
      await transport.close().catch(() => {})
      this.#status = error instanceof UnauthorizedError ? 'unauthenticated' : 'error'
      this.#lastError = describeAuthorizationError(error)
      throw new Error(this.#lastError, { cause: error })
    }
    this.#adopt(client, transport)
    await this.syncTools()
  }

  /**
   * Adopt a connected generation and arm its close handler.
   *
   * @param {Client} client connected client.
   * @param {StreamableHTTPClientTransport} transport its transport.
   * @returns {void}
   */
  #adopt(client, transport) {
    this.#client = client
    this.#transport = transport
    this.#status = 'connected'
    this.#lastError = undefined
    this.#authLossHandled = false
    client.onclose = () => {
      if (this.#client !== client) return
      this.#client = undefined
      this.#transport = undefined
      this.#status = 'disconnected'
      this.unregisterTools()
      this.#instructions = ''
      this.#log('warn', 'connection closed; call figma_login to reconnect')
    }
  }

  /**
   * Fetch the server's tool list and swap the registered generation. Fetch
   * failures keep the previous generation; registration conflicts roll the
   * attempted generation back (never a partial tool set).
   *
   * @returns {Promise<void>}
   */
  async syncTools() {
    if (this.#syncing !== undefined) return this.#syncing
    this.#syncing = this.#syncToolsOnce().finally(() => {
      this.#syncing = undefined
    })
    return this.#syncing
  }

  /** @returns {Promise<void>} */
  async #syncToolsOnce() {
    const client = this.#client
    if (client === undefined) return
    const capabilities = client.getServerCapabilities()
    const response = capabilities?.tools === undefined ? { tools: [] } : await client.listTools(undefined, { cacheMode: 'refresh' })
    const definitions = new Map()
    for (const tool of response.tools) {
      const publicName = publicToolName(this.#options.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(`figma-mcp: the server listed tool "${tool.name}" more than once — invalid list`)
      }
      definitions.set(
        publicName,
        createMcpToolDefinition(this.#ctx, {
          name: publicName,
          rawName: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          taskRequired: tool.execution?.taskSupport === 'required',
          call: async (args, execution) => {
            try {
              return await client.callTool(
                { name: tool.name, arguments: args },
                { signal: execution.signal, timeout: this.#options.toolCallTimeoutMs, toolDefinition: tool },
              )
            } catch (error) {
              throw await this.#decorateCallError(error)
            }
          },
        }),
      )
    }

    // Swap: the previous generation goes away only after the fetch succeeded.
    this.unregisterTools()
    try {
      for (const [publicName, definition] of definitions) {
        this.#toolDisposers.set(publicName, this.#ctx.tools.register(definition))
      }
    } catch (error) {
      this.unregisterTools()
      throw new Error(`figma-mcp: failed to register the tools, no Figma tool registered: ${messageOf(error)}`, { cause: error })
    }

    const serverText = client.getInstructions()?.trimEnd() ?? ''
    this.#instructions = serverText === '' ? '' : `### MCP server: ${this.#options.serverName}\n\n${serverText}`
    this.#log('info', `tool list synced (${this.#toolDisposers.size} tools)`)
  }

  /**
   * Turn an OAuth-related tool-call failure into actionable text.
   *
   * A rejected token is a connection-wide state change, not a per-call error:
   * the generation is torn down, the status leaves `connected` (so
   * `figma_login` can re-authorize) and the next calls fail fast instead of
   * each starting a new authorization redirect.
   *
   * @param {unknown} error thrown value.
   * @returns {Promise<unknown>} the value to throw.
   */
  async #decorateCallError(error) {
    if (!(error instanceof UnauthorizedError)) return error
    if (!this.#authLossHandled) {
      this.#authLossHandled = true
      this.#status = 'unauthenticated'
      this.#lastError = 'the Figma authorization expired or was revoked'
      this.#authorizationUrl = undefined
      try {
        await this.#closeGeneration()
      } catch {
        // Best effort: the failing call already reports the re-auth requirement.
      }
      this.#status = 'unauthenticated'
      this.#log('warn', 'authorization lost (401); call figma_login to re-authorize')
    }
    return new Error('The Figma authorization expired or is invalid. Call figma_login to authorize again and try again.')
  }

  /**
   * Drop every registered `mcp__*` tool.
   *
   * @returns {void}
   */
  unregisterTools() {
    for (const dispose of this.#toolDisposers.values()) {
      try {
        dispose()
      } catch (error) {
        this.#log('warn', `tool disposal failed: ${messageOf(error)}`)
      }
    }
    this.#toolDisposers = new Map()
  }

  /**
   * Resource operations for `ctx.mcpResources.register(server, provider)`.
   * Same shape the shipped bridge exposes.
   *
   * @param {{method: string, cursor?: string, uri?: string}} request typed operation.
   * @param {{signal?: AbortSignal}} [execution] tool execution.
   * @returns {Promise<object>} MCP result.
   */
  async requestResource(request, execution) {
    const client = this.#client
    if (client === undefined) throw new Error('figma-mcp: the server is disconnected')
    const options = { signal: execution?.signal, timeout: this.#options.toolCallTimeoutMs }
    const listable = client.getServerCapabilities()?.resources !== undefined
    switch (request.method) {
      case 'resources/list':
        return listable ? client.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options) : { resources: [] }
      case 'resources/templates/list':
        return listable ? client.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options) : { resourceTemplates: [] }
      case 'resources/read':
        return client.readResource({ uri: request.uri }, options)
      default:
        throw new Error(`figma-mcp: unsupported resource operation ${String(request.method)}`)
    }
  }

  /**
   * Attempt to connect when a grant appears from another surface.
   *
   * @returns {Promise<void>}
   */
  async onGrantUpdated() {
    if (this.connected || this.#options.authMode === 'none') return
    const grant = await this.#store.read()
    if (grant?.tokens?.access_token === undefined) return
    try {
      await this.connect()
      this.#log('info', `connected after grant update (${this.toolCount} tools)`)
    } catch (error) {
      this.#log('warn', `connect after grant update failed: ${messageOf(error)}`)
    }
  }

  /**
   * Forget the grant and unregister the server's tools.
   *
   * @returns {Promise<void>}
   */
  async logout() {
    // Cancel a pending attempt first: a late callback after the grant was
    // deleted would otherwise fail with a confusing issuer-binding error.
    this.#flowController?.abort()
    await this.#login?.catch(() => {})
    await this.#closeGeneration()
    await this.#store.clear()
    this.#status = 'unauthenticated'
    this.#lastError = undefined
    this.#authorizationUrl = undefined
    this.#authLossHandled = false
  }

  /**
   * Close the live generation, abort a pending flow and drop every registration
   * (effect teardown / plugin unload).
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    try {
      this.#flowAbort.abort()
    } catch {
      // Already aborted.
    }
    this.#flowController?.abort()
    await this.#login?.catch(() => {})
    await this.#closeGeneration()
  }

  /** @returns {Promise<void>} */
  async #closeGeneration() {
    const client = this.#client
    const transport = this.#transport
    this.#client = undefined
    this.#transport = undefined
    this.unregisterTools()
    this.#instructions = ''
    if (client !== undefined) {
      try {
        await client.close()
      } catch {
        // Best effort: the transport may already be closed.
      }
    } else if (transport !== undefined) {
      await transport.close().catch(() => {})
    }
    if (this.#status === 'connected') this.#status = 'disconnected'
  }
}

/**
 * Turn an OAuth/registration failure into actionable user-facing text.
 *
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
export function describeAuthorizationError(error) {
  if (error instanceof RegistrationRejectedError) {
    return [
      `Figma refused the dynamic client registration (HTTP ${error.status}).`,
      "Figma's remote MCP server only registers clients from its MCP catalog list.",
      'Set config.clientName to a catalog-compatible value (for example "Claude Code (DSH)" or "Codex")',
      'as an explicit compatibility opt-in, or use the Figma desktop server at http://127.0.0.1:3845/mcp (no OAuth).',
      'Waitlist: https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021',
    ].join(' ')
  }
  if (error instanceof UnauthorizedError) {
    return 'The Figma authorization expired or is invalid. Call figma_login to authorize again.'
  }
  return messageOf(error)
}

/**
 * Whether a thrown value means the attempt was cancelled rather than failed.
 *
 * @param {unknown} error thrown value.
 * @returns {boolean} true for abort/cancel outcomes.
 */
export function isCancellation(error) {
  if (error === undefined || error === null) return false
  const name = typeof error === 'object' && error !== null ? error.name : undefined
  if (name === 'AbortError') return true
  const message = messageOf(error)
  return /cancelled|canceled|aborted/i.test(message)
}

/**
 * Normalize an unknown thrown value into one line.
 *
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
