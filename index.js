/**
 * Figma remote MCP bridge — Host half.
 *
 * Connects DeepSeek Harness to Figma's MCP server
 * (`https://mcp.figma.com/mcp`, or the local desktop server) using OAuth, and
 * mirrors the server's tools onto `ctx.tools` as `mcp__<serverName>__<rawName>`.
 *
 * Responsibilities:
 *  - own the OAuth provider/store for the Figma MCP server and run the RFC 8252
 *    loopback authorization flow on demand;
 *  - keep ONE live MCP `Client` connection and swap the registered tool
 *    generation when the server's tool list changes;
 *  - expose the flow through `figma_login` / `figma_status` / `figma_logout`
 *    tools, the `/figma-login` composer command and an `ctx.authorization` flow;
 *  - add the server's `instructions` to the system prompt and register its
 *    resource operations with `ctx.mcpResources` (both optional services).
 *
 * Boot safety: `apply` never awaits the network. With no stored grant the
 * plugin loads, publishes `figma_login`, and stays "not connected"; a failed
 * background connect only logs and never rejects activation.
 *
 * Secrets live in the harness credential store as the record `figma-mcp/oauth`,
 * never in configuration.
 *
 * @module @dsh-burn-plugins/dsh-figma-mcp-oauth
 */

import z from '@deepseek-ai/schemastery'

import { AUTH_KEY } from './lib/oauth.js'
import { FigmaConnection, describeAuthorizationError, messageOf } from './lib/mcp.js'

/** Plugin name used by Loader diagnostics. */
export const name = 'figma-mcp-oauth'

/**
 * Services this plugin needs before it activates. `tools` registers the
 * management and MCP tools; `credentials` holds the OAuth grant.
 */
export const inject = ['tools', 'credentials']

/** Valid `serverName`, kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Plugin version reported to the MCP server as `clientInfo`. */
const PLUGIN_VERSION = '0.1.0'

/**
 * Live `serverName` reservations inside this bundle, so two rows of this plugin
 * in one scope fail fast instead of silently colliding on public tool names.
 * This is a local guard only: a separate configuration-only `mcp-client` row
 * using the same namespace is detected by the tool registry at registration
 * time (which rolls the whole generation back), not here.
 */
const activeServerNames = new WeakMap()

/** Row configuration; validated by Cordis before `apply` runs. */
export const Config = z.object({
  /** Streamable-HTTP endpoint. `https://mcp.figma.com/mcp`, or the desktop server. */
  url: z.string().default('https://mcp.figma.com/mcp'),
  /** Namespace for public tool names: `mcp__<serverName>__<rawName>`. */
  serverName: z.string().default('figma'),
  /** `oauth` for the remote server; `none` for the no-auth Figma desktop Dev Mode server. */
  authMode: z.union([z.const('oauth'), z.const('none')]).default('oauth'),
  /**
   * `client_name` sent during Dynamic Client Registration. Figma's authorization
   * server only registers clients on its MCP-catalog allowlist; see README.
   */
  clientName: z.string().default('Claude Code (DSH)'),
  /** OAuth scope request. Figma advertises exactly `mcp:connect`. */
  scope: z.string().default('mcp:connect'),
  /** Loopback callback port; keep stable while a client registration is cached. */
  redirectPort: z.number().step(1).min(1024).max(65535).default(3846),
  /** How long one authorization attempt waits for the browser callback. */
  loginTimeoutMs: z.number().step(1).min(5000).max(600000).default(180000),
  /** Per-`tools/call` deadline passed to the MCP SDK. */
  toolCallTimeoutMs: z.number().step(1).min(1000).max(600000).default(60000),
  /** Connect at load when a stored grant exists. */
  autoConnect: z.boolean().default(true),
  /** Try to open the authorization URL in the host's browser. */
  openBrowser: z.boolean().default(true),
})

/**
 * Validate/normalize the row config once, so `apply` and the connection only
 * see plain values. Schemastery defaults still apply when a programmatic caller
 * bypasses the Loader.
 *
 * @param {object} config raw row config.
 * @returns {object} frozen resolved options.
 */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const url = text(raw.url, 'https://mcp.figma.com/mcp')
  if (!URL.canParse(url)) throw new Error(`figma-mcp: url ${JSON.stringify(url)} is not a valid URL`)
  const authMode = raw.authMode === 'none' ? 'none' : 'oauth'
  const serverName = text(raw.serverName, 'figma')
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`figma-mcp: serverName ${JSON.stringify(serverName)} must match ${SERVER_NAME_PATTERN}`)
  }
  const bounded = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback)
  return Object.freeze({
    url,
    serverName,
    authMode,
    clientName: text(raw.clientName, 'Claude Code (DSH)'),
    // Reserved for a future pre-registered client (Figma MCP-catalog
    // registration): the client id may come from configuration, but the secret
    // belongs in the credential store, so it is never a config field here.
    clientId: text(raw.clientId, ''),
    clientSecret: '',
    scope: text(raw.scope, 'mcp:connect'),
    redirectPort: bounded(raw.redirectPort, 3846, 1024, 65535),
    loginTimeoutMs: bounded(raw.loginTimeoutMs, 180000, 5000, 600000),
    toolCallTimeoutMs: bounded(raw.toolCallTimeoutMs, 60000, 1000, 600000),
    autoConnect: raw.autoConnect !== false,
    openBrowser: raw.openBrowser !== false,
    version: PLUGIN_VERSION,
  })
}

/**
 * Load the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} [config] row configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const log = (level, message) => {
    try {
      const line = `figma-mcp: ${message}`
      const logger = ctx.logger
      if (level === 'error') logger?.error?.(line)
      else if (level === 'warn') logger?.warn?.(line)
      else logger?.info?.(line)
    } catch {
      // Logging must never break the plugin.
    }
  }

  // 1. Reserve the namespace inside this registration scope (a duplicate row
  //    fails fast instead of racing on public tool names).
  ctx.effect(() => {
    const owner = ctx.root
    let names = activeServerNames.get(owner)
    if (names === undefined) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(options.serverName)) {
      throw new Error(`figma-mcp: serverName "${options.serverName}" is already in use by another figma-mcp instance`)
    }
    names.add(options.serverName)
    return () => void names.delete(options.serverName)
  }, 'figma-mcp.serverName')

  // 2. The connection supervisor owns the live MCP client, the registered MCP
  //    tool disposers and the OAuth grant store.
  const connection = new FigmaConnection({
    ctx,
    options,
    log: (level, message) => log(level, message),
  })

  // 3. Always-available management tools, registered before any network work so
  //    the agent can always ask about / start the connection.
  ctx.effect(() => {
    const disposers = [registerLoginTool(ctx, connection), registerStatusTool(ctx, connection), registerLogoutTool(ctx, connection)]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          log('warn', `tool disposal failed: ${messageOf(error)}`)
        }
      }
    }
  }, 'figma-mcp.tools')

  // 4. Same operation from a human command in the composer.
  ctx.inject(['commands'], (inner) => {
    inner.commands.register({
      name: 'figma-login',
      description: 'Conecta o servidor MCP da Figma (abre a página de autorização da Figma).',
      handler: async (invocation) => {
        try {
          const text = await connection.login({ signal: invocation.signal })
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    })
  })

  // 5. The credential-obtaining seam: one flow per credential record. Any
  //    surface that renders authorization flows can run the same sign-in.
  ctx.inject(['authorization'], (inner) => {
    inner.authorization.registerFlow({
      key: AUTH_KEY,
      label: 'Figma MCP',
      methods: [{ id: 'oauth', label: 'Entrar com a Figma' }],
      async run(session) {
        await connection.login({
          signal: session.signal,
          notify: (notice) => {
            try {
              session.notify(notice)
            } catch {
              // A surface that cannot show notices still gets the URL in the log.
            }
          },
        })
      },
    })
  })

  // 6. Optional: server instructions in the logged system prompt, at the MCP
  //    section order the shipped bridge uses, as literal (non-interpolated) text.
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${options.serverName}`,
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: () => connection.instructions(),
    })
  })

  // 7. Optional: register resource operations so the profile's shared
  //    `list_mcp_resources` / `read_mcp_resource` tools see this server.
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(options.serverName, {
      request: (request, exec) => connection.requestResource(request, exec),
    })
  })

  // 8. A grant can be committed by another surface (the authorization seam);
  //    connect when that happens.
  ctx.on('credentials/record-updated', (key) => {
    if (key !== AUTH_KEY) return
    void connection.onGrantUpdated().catch((error) => log('warn', `grant-update reconnect failed: ${messageOf(error)}`))
  })

  // 9. One effect owns the connection's lifetime: unload/HMR disposes the
  //    client, unregisters every MCP tool and aborts a pending flow.
  ctx.effect(() => () => connection.dispose(), 'figma-mcp.connection')

  // 10. Boot never waits on the network: connect in the background and log.
  if (options.autoConnect) {
    void (async () => {
      try {
        if (options.authMode === 'none') {
          await connection.connect()
          log('info', `connected at load (${connection.toolCount} tools, no OAuth)`)
          return
        }
        const grant = await ctx.credentials.readRecord(AUTH_KEY).catch(() => undefined)
        const hasToken = grant !== undefined && grant !== null && grant.kind === 'grant' && grant.payload !== null && typeof grant.payload === 'object'
        if (!hasToken) return // not connected yet: figma_login is the entry point
        await connection.connect()
        log('info', `connected at load (${connection.toolCount} tools)`)
      } catch (error) {
        log('warn', `background connect failed: ${messageOf(error)}`)
      }
    })()
  }
}

/**
 * `figma_login`: start (or join) the OAuth flow.
 *
 * Non-blocking by default so the model can hand the authorization URL to the
 * user immediately; `wait: true` blocks up to `loginTimeoutMs` and returns the
 * final status (useful in a command-line or single-shot flow).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {FigmaConnection} connection live connection.
 * @returns {() => void} tool disposer.
 */
function registerLoginTool(ctx, connection) {
  return ctx.tools.register({
    name: 'figma_login',
    description: [
      'Connect DeepSeek Harness to Figma through the Figma MCP server, using OAuth.',
      'Starts the sign-in: the host opens the Figma authorization page in the browser and listens on 127.0.0.1 for the callback.',
      'Call it when the user asks to use Figma or when a figma_* / mcp__figma__* tool reports that the connection is missing.',
      'The tool result contains the authorization URL when the browser did not open by itself; give that URL to the user.',
      'If starting the sign-in fails (for example the Figma client registration is refused, or the callback port is busy), the tool result carries that error instead of a URL.',
      'After the user authorizes, call figma_status to confirm and then use the mcp__figma__* tools.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        wait: {
          type: 'boolean',
          description: 'Wait for the user to finish in the browser (up to the configured loginTimeoutMs) instead of returning the URL immediately. Default false.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args, exec) {
      if (connection.connected) return connection.statusLine()
      try {
        if (args?.wait === true) return await connection.login({ signal: exec.signal })
        return await connection.startLogin()
      } catch (error) {
        throw new Error(describeAuthorizationError(error))
      }
    },
  })
}

/**
 * `figma_status`: read-only connection/token status.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {FigmaConnection} connection live connection.
 * @returns {() => void} tool disposer.
 */
function registerStatusTool(ctx, connection) {
  return ctx.tools.register({
    name: 'figma_status',
    description:
      'Report whether the Figma MCP connection is authenticated and connected, how many mcp__figma__* tools are registered, and which authorization URL is pending when a sign-in is in progress.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute() {
      return connection.statusLine()
    },
  })
}

/**
 * `figma_logout`: remove the stored grant and unregister the server's tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {FigmaConnection} connection live connection.
 * @returns {() => void} tool disposer.
 */
function registerLogoutTool(ctx, connection) {
  return ctx.tools.register({
    name: 'figma_logout',
    description:
      'Forget the stored Figma OAuth grant and disconnect the Figma MCP server for this profile. The next figma_login asks the user to sign in again.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute() {
      await connection.logout()
      return 'Figma: sessão encerrada e desconectada.'
    },
  })
}
