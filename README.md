# Figma MCP with OAuth — DeepSeek Harness plugin

Connects DeepSeek Harness to the **Figma MCP server** (`https://mcp.figma.com/mcp`)
using **OAuth 2.1 (authorization code + PKCE S256 + dynamic client registration)**
and publishes the server's tools to the agent as `mcp__figma__<tool>`.

The plugin is a **Host-only** bundle: it has no Client half and no UI of its own. The
authorization flow uses the local loopback redirect port (RFC 8252), opens the
Figma page in the user's browser, and stores the token in the Harness credential
store — never in configuration.

---

## What it offers

| Surface | What it does |
|---|---|
| `figma_login` (tool) | Starts/joins the OAuth flow. Returns the authorization URL to the user; does not block by default. `wait: true` waits for the callback. |
| `figma_status` (tool) | State: connected/disconnected, how many `mcp__figma__*` tools exist, pending URL. |
| `figma_logout` (tool) | Deletes the stored grant and unregisters the server's tools. |
| `/figma-login` (composer command) | Same operation as `figma_login`, blocking until the callback (useful when the human is in front of the screen). |
| `Figma MCP` flow in `ctx.authorization` | The same sign-in registered on the Harness authorization seam, for any future surface that renders flows. |
| `mcp__figma__*` | Figma MCP server tools (design context, screenshot, write-to-canvas, etc.), registered after authorization. |

The plugin also publishes the MCP server's `instructions` into the system prompt at the
same position the official bridge uses and registers the resource operations in
`ctx.mcpResources` (when those services exist).

## How OAuth works

1. `figma_login` opens a listener on `127.0.0.1:<redirectPort>/callback`.
2. The MCP SDK (`@modelcontextprotocol/client`) discovers the metadata:
   `https://mcp.figma.com/.well-known/oauth-protected-resource` →
   `https://api.figma.com/.well-known/oauth-authorization-server`.
3. With no cached client registration, it registers a new client (RFC 7591) at
   `https://api.figma.com/v1/oauth/mcp/register` with the configured `clientName`.
4. It builds the `https://www.figma.com/oauth/mcp` URL with PKCE S256, a single-use
   `state`, and `resource=https://mcp.figma.com/mcp`; opens the browser.
5. The browser returns to `http://127.0.0.1:<redirectPort>/callback`; the plugin
   validates `state`, hands the `code` to the SDK (which validates the RFC 9207 `iss`)
   and exchanges the code for a token **in under 30 s** (Figma codes expire in 30 s).
6. It connects to `https://mcp.figma.com/mcp` with `Authorization: Bearer …`,
   discovers the tool list, and registers the current generation in `ctx.tools`.
7. Refreshes: a 401 triggers an automatic refresh (client `client_secret_basic`)
   and a retry; if the refresh fails, the agent receives a message asking for
   `figma_login`.

## Installation

To install the bundle into a Harness profile:

```
plugin_manager action=install_bundle target=/absolute/path/dsh-figma-mcp-oauth
```

The installer runs `pnpm add <directory>` and registers a `link:` dependency; the
declared dependencies are **peerDependencies** resolved by the DSH installation
(`@modelcontextprotocol/client`, `@deepseek-ai/dsh-mcp-client`,
`@deepseek-ai/schemastery`), so the bundle downloads nothing from npm.

## Configuration

Configured on the `figma-mcp` row of the bundle patch (`cordis.patch.yml`):

| Field | Default | Meaning |
|---|---|---|
| `url` | `https://mcp.figma.com/mcp` | Figma MCP Streamable HTTP endpoint (or `http://127.0.0.1:3845/mcp` in desktop mode). |
| `serverName` | `figma` | Namespace of the public tools: `mcp__<serverName>__<rawName>`. |
| `authMode` | `oauth` | `none` to talk to the desktop server (no OAuth). |
| `clientName` | `Claude Code (DSH)` | `client_name` sent in dynamic registration. **Read the policy section below.** |
| `scope` | `mcp:connect` | The only scope published by Figma's AS. |
| `redirectPort` | `3846` | Loopback callback port. Keep it stable: Figma compares the `redirect_uri` byte by byte. |
| `loginTimeoutMs` | `180000` | Maximum time to wait for the callback in one attempt. |
| `toolCallTimeoutMs` | `60000` | Timeout per `tools/call`. |
| `autoConnect` | `true` | Connect at load when a stored grant already exists. |
| `openBrowser` | `true` | Try to open the authorization URL in the host's browser (otherwise, return the URL to the user). |

> Changing `clientName` invalidates the cached client registration and forces a new
> registration on the next `figma_login`. Changing `url`/`redirectPort` also requires
> logging in again (`figma_logout` → `figma_login`).
>
> There is no configurable pre-registered OAuth client today: the plugin uses only
> dynamic registration (DCR). Any future support for a pre-registered client will read
> the secret from the credential store, never from `cordis.patch.yml`.

## ⚠️ Figma policy: why `clientName: 'Claude Code (DSH)'`

Figma's remote MCP server **does not accept arbitrary clients** in dynamic client
registration: the `client_name` is compared against a list of clients from the
Figma MCP catalog (`Claude Code` / `Claude Desktop` prefixes, or exactly
`Codex`). Any other name gets a bare `403 Forbidden`. Clients outside the
catalog are directed to a waitlist
([form](https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021));
normal Figma OAuth apps cannot request the `mcp:connect` scope.

This profile uses the name `Claude Code (DSH)` as an **explicit compatibility
opt-in**: it is the only path today for a third-party client to talk to the
remote server. Consequences you should know:

- Figma's consent screen shows the catalog client's brand
  (`Figma MCP in Claude Code`), not DeepSeek Harness;
- this works around a Figma access restriction during its beta — the decision
  to use it is yours, and it may stop working if Figma tightens verification;
- **`figma_logout` clears the local registration**, but the authorized session in Figma
  still exists on the account until it expires/is revoked (Figma keeps one token per
  app/user).

Legitimate alternatives:

1. **Figma MCP catalog waitlist** (above). A pre-registered client is
   **not implemented yet** in this plugin: when Figma approves the project (or
   opens up third-party clients), the evolution is to read a `clientId` from
   configuration and the `client_secret` from the credential store
   (own registration) and skip dynamic registration — today only the DCR path exists.
2. **Desktop mode, without OAuth**: `authMode: none` + `url: http://127.0.0.1:3845/mcp`
   with the Figma desktop app, Dev Mode, and a Dev/Full seat on a paid plan. No
   write-to-canvas and no design-generation tools from the remote server.
3. Update the Harness when Figma allows CIMD (Client ID Metadata Documents)
   or opens up third-party clients; the plugin's OAuth layer is the SDK's, so
   the migration is local.

## Desktop mode (no OAuth)

```yaml
- id: figma-mcp
  name: '@dsh-burn-plugins/dsh-figma-mcp-oauth'
  config:
    url: http://127.0.0.1:3845/mcp
    authMode: none
    autoConnect: true
```

Requirements: updated Figma desktop app, a Design file open, `Shift+D`
(Dev Mode, nothing selected) → right sidebar → “Enable desktop MCP server”.

## Security

- The grant (client information, tokens, code verifier, `state`, discovery state)
  lives in the **Harness credential store**, record `figma-mcp/oauth`
  (`ctx.credentials`), never in `cordis.patch.yml`.
- The callback listener listens on `127.0.0.1` **only**, validates `state`, and shows the
  success page only after the `error`/`state` have been checked; the `iss` is
  validated by the SDK before redeeming the code.
- `figma_logout` deletes the record (`deleteRecord`) and disconnects.
- No secret appears in a prompt, tool output, or log.

## Troubleshooting

| Symptom | Cause / action |
|---|---|
| `403 Forbidden` at login, message about the catalog list | `clientName` outside the allowlist or Figma changed the gate. Adjust `clientName` or use desktop mode. |
| “could not listen on callback port 3846” | Another instance of the plugin/Harness is using the port. The message is returned right away (it does not hang the Host); close the other instance or change `redirectPort` and log in again. |
| “authorization timed out” | Nobody completed the login within `loginTimeoutMs`. Run `figma_login` again. |
| “state mismatch (possible mix-up attack)” | A callback from another attempt/instance (or forged) is **ignored**: the page shows the error, but the pending login keeps waiting for the legitimate callback until `loginTimeoutMs`. Log in again only if it expires. |
| `mcp__figma__*` tools do not appear | Check `figma_status`; if it is `unauthenticated`, call `figma_login`. After authorization, the tools enter the next prompt generation. |
| “Figma authorization expired or is invalid” when calling a tool | Invalid/revoked token (for example, signing in on another machine: Figma keeps one token per app/user). The connection is dropped and the status becomes `unauthenticated`; `figma_login` logs in again (no tab opened per call). |
| Changed the server name/URL and the connection stays the same | `figma_logout` and `figma_login` to register again. |
| `figma_logout` during a login in progress | `figma_logout` cancels the pending attempt and deletes the grant; the late callback does not produce a confusing error. |

## Architecture

```
figma-mcp-oauth/
├── index.js           # Cordis plugin: Config, inject, apply, tools/command/flow
├── lib/oauth.js       # OAuthClientProvider + store via ctx.credentials + loopback + browser
├── lib/mcp.js         # MCP connection supervisor, public names, tool registration
├── cordis.patch.yml   # bundle's figma-mcp row
├── locale/en.json
└── icon.svg
```

- **Protocol**: all OAuth comes from the official SDK `@modelcontextprotocol/client@2.2.x`
  (`auth()`, `OAuthClientProvider`, `StreamableHTTPClientTransport`). The plugin
  implements only the provider, the loopback listener, and the persistence.
- **Tool bridge**: reuses `createMcpToolDefinition` from
  `@deepseek-ai/dsh-mcp-client` (same canonical result contract, durable images,
  and `projectContent` as the official bridge); the public naming is
  reimplemented verbatim (`mcp__<server>__<raw>`, 64 chars `[A-Za-z0-9_-]`,
  a 12-hex SHA-256 hash suffix when normalization loses information).
- **No npm dependencies in the bundle**: the three packages are `peerDependencies`
  resolved by the DSH installation (`link:` bundle resolution rule).
- **Safe boot**: `apply` never waits on the network. Without a grant, the plugin loads,
  publishes `figma_login`, and stays `unauthenticated`; a background connection failure
  only logs.

## Verification

State as of 2026-11-09, in local development:

- **Full OAuth flow offline** against a fake AS + MCP server: discovery
  (RFC 9728/8414), DCR, PKCE S256 + `state`, loopback callback, code exchange,
  connection, `tools/list`, `tools/call`, automatic refresh on 401, and reconnection
  after a "restart" using the stored grant, plus `figma_logout` — 19/19
  checks (local harness, kept outside the repository).
- **Against real Figma**: dynamic registration `201` with `clientName`
  `Claude Code (DSH)`, authorization URL accepted (`302` to Figma's login)
  with PKCE S256 + `state` + `scope` + `resource`; a non-catalog name mapped
  to the actionable `403` message.
- **Real login completed by the user** in real use: `figma_status` →
  `connected — 42 tools available — endpoint https://mcp.figma.com/mcp`;
  `mcp__figma__whoami` answered with the authenticated account; `list_mcp_resources`
  listed the server's resources and skills (`skill://figma/...`), also proving
  the integration with `ctx.mcpResources`.
- **Independent review** (report kept outside the repository, a teammate separate from
  the author): happy path and the 19/19 checks reproduced; found 1 blocker
  (an unhandled promise rejection in the loopback listener could reach the Host's
  fatal handler when the callback port was busy — fixed: the exposed promise has a
  no-op handler, listeners are removed in `finally`, `logout`/`dispose` cancel the
  attempt, and every async `void` has `.catch`; reproduction with DSH's real
  handler now **survives**) and 2 major findings fixed: recovery after a revoked
  token (the connection is dropped, the status leaves `connected`, `figma_login`
  works again, and it no longer opens a tab on every failed call) and non-blocking
  `figma_login` now returns the actionable error (DCR 403, busy port, discovery)
  instead of "started".
- **Independent re-verification: PASS** (report kept outside the repository).
  Against the current code: the reviewer's adversarial harness **180/180** checks and
  0 unhandled rejections; static/manifest/live registration **82/82**; the author's
  harness **37/37**; blocker fix confirmed with DSH's real fatal handler
  (`SURVIVED`, exit 0). No residual blocker/major findings. Minor finding R1
  (the README announced a non-existent pre-registered client) fixed in the
  documentation.
- **Known gaps**: automatic reconnection after restarting the Host was covered
  only in the offline test (`autoConnect` + grant in the credential store), not in a real
  restart of this profile; metadata/icon rendered in the UI were not verified
  visually (no browser control; valid static resources); real Figma `tools/call`
  was exercised via `mcp__figma__whoami` after login, but not the design flows.
