# Figma MCP com OAuth — plugin do DeepSeek Harness

Conecta o DeepSeek Harness ao **servidor MCP da Figma** (`https://mcp.figma.com/mcp`)
usando **OAuth 2.1 (authorization code + PKCE S256 + registro dinâmico de cliente)**
e publica as ferramentas do servidor para o agente como `mcp__figma__<ferramenta>`.

O plugin é um bundle **Host-only**: não tem metade Client nem interface própria. O
fluxo de autorização usa a porta de retorno local (loopback, RFC 8252), abre a
página da Figma no navegador do usuário e guarda o token no cofre de credenciais
do Harness — nunca em configuração.

---

## O que ele oferece

| Superfície | O que faz |
|---|---|
| `figma_login` (ferramenta) | Inicia/junta o fluxo OAuth. Devolve a URL de autorização para o usuário; por padrão não bloqueia. `wait: true` espera o callback. |
| `figma_status` (ferramenta) | Estado: conectado/desconectado, quantas ferramentas `mcp__figma__*` existem, URL pendente. |
| `figma_logout` (ferramenta) | Apaga o grant armazenado e desregistra as ferramentas do servidor. |
| `/figma-login` (comando do compositor) | Mesma operação do `figma_login`, bloqueando até o callback (útil quando o humano está na frente da tela). |
| fluxo `Figma MCP` em `ctx.authorization` | O mesmo sign-in registrado no seam de autorização do Harness, para qualquer superfície futura que renderize fluxos. |
| `mcp__figma__*` | Ferramentas do servidor MCP da Figma (design context, screenshot, write-to-canvas, etc.), registradas após a autorização. |

O plugin também publica as `instructions` do servidor MCP no system prompt na mesma
posição que o bridge oficial usa e registra as operações de recurso em
`ctx.mcpResources` (quando esses serviços existem).

## Como funciona o OAuth

1. `figma_login` abre um listener em `127.0.0.1:<redirectPort>/callback`.
2. O SDK MCP (`@modelcontextprotocol/client`) descobre os metadados:
   `https://mcp.figma.com/.well-known/oauth-protected-resource` →
   `https://api.figma.com/.well-known/oauth-authorization-server`.
3. Sem registro de cliente em cache, registra um cliente novo (RFC 7591) em
   `https://api.figma.com/v1/oauth/mcp/register` com o `clientName` configurado.
4. Monta a URL `https://www.figma.com/oauth/mcp` com PKCE S256, `state` de uso
   único e `resource=https://mcp.figma.com/mcp`; abre o navegador.
5. O navegador volta para `http://127.0.0.1:<redirectPort>/callback`; o plugin
   valida `state`, entrega o `code` ao SDK (que valida o `iss` RFC 9207) e troca
   o código por token **em menos de 30 s** (códigos da Figma expiram em 30 s).
6. Conecta em `https://mcp.figma.com/mcp` com `Authorization: Bearer …`,
   descobre a lista de ferramentas e registra a geração atual em `ctx.tools`.
7. Renovações: um 401 dispara refresh automático (client `client_secret_basic`)
   e nova tentativa; se o refresh falhar, o agente recebe uma mensagem pedindo
   `figma_login`.

## Instalação

Para instalar o bundle em um perfil do Harness:

```
plugin_manager action=install_bundle target=/caminho/absoluto/dsh-figma-mcp-oauth
```

O instalador faz `pnpm add <diretório>` e registra uma dependência `link:`; as
dependências declaradas são **peerDependencies** resolvidas pela instalação do DSH
(`@modelcontextprotocol/client`, `@deepseek-ai/dsh-mcp-client`,
`@deepseek-ai/schemastery`), então o bundle não baixa nada da npm.

## Configuração

Configurada na linha `figma-mcp` do patch do bundle (`cordis.patch.yml`):

| Campo | Padrão | Significado |
|---|---|---|
| `url` | `https://mcp.figma.com/mcp` | Endpoint Streamable HTTP do MCP da Figma (ou `http://127.0.0.1:3845/mcp` no modo desktop). |
| `serverName` | `figma` | Namespace das ferramentas públicas: `mcp__<serverName>__<rawName>`. |
| `authMode` | `oauth` | `none` para falar com o servidor desktop (sem OAuth). |
| `clientName` | `Claude Code (DSH)` | `client_name` enviado no registro dinâmico. **Leia a seção de política abaixo.** |
| `scope` | `mcp:connect` | Único escopo publicado pelo AS da Figma. |
| `redirectPort` | `3846` | Porta do callback loopback. Mantenha estável: a Figma compara o `redirect_uri` byte a byte. |
| `loginTimeoutMs` | `180000` | Tempo máximo de espera pelo callback em uma tentativa. |
| `toolCallTimeoutMs` | `60000` | Timeout por `tools/call`. |
| `autoConnect` | `true` | Conectar na carga quando já existe grant armazenado. |
| `openBrowser` | `true` | Tentar abrir a URL de autorização no navegador do host (senão, devolva a URL ao usuário). |

> Alterar `clientName` invalida o registro de cliente em cache e força um novo
> registro no próximo `figma_login`. Alterar `url`/`redirectPort` também exige
> refazer o login (`figma_logout` → `figma_login`).
>
> Não há cliente OAuth pré-registrado configurável hoje: o plugin usa somente o
> registro dinâmico (DCR). Qualquer suporte futuro a cliente pré-registrado lerá
> o segredo do cofre de credenciais, nunca de `cordis.patch.yml`.

## ⚠️ Política da Figma: por que `clientName: 'Claude Code (DSH)'`

O registro dinâmico de clientes do servidor MCP remoto da Figma **não aceita
clientes arbitrários**: o `client_name` é comparado com uma lista de clientes do
catálogo MCP da Figma (prefixos `Claude Code` / `Claude Desktop`, ou exatamente
`Codex`). Qualquer outro nome recebe `403 Forbidden` seco. Clientes fora do
catálogo são direcionados a uma lista de espera
([formulário](https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021));
apps OAuth normais da Figma não podem pedir o escopo `mcp:connect`.

Este perfil usa o nome `Claude Code (DSH)` como **opt-in de compatibilidade
explícito**: é o único caminho hoje para um cliente de terceiros falar com o
servidor remoto. Consequências que você deve conhecer:

- a tela de consentimento da Figma mostra a marca do cliente do catálogo
  (`Figma MCP in Claude Code`), não o DeepSeek Harness;
- isso contorna uma restrição de acesso da Figma durante o beta dela — a decisão
  de usar é sua, e pode deixar de funcionar se a Figma apertar a verificação;
- **`figma_logout` limpa o registro local**, mas a sessão autorizada na Figma
  continua existindo na conta até expirar/revogar (a Figma mantém um token por
  app/usuário).

Alternativas legítimas:

1. **Lista de espera do catálogo MCP da Figma** (acima). Cliente
   pré-registrado **ainda não está implementado** neste plugin: quando a Figma
   aprovar o projeto (ou liberar clientes de terceiros), a evolução é ler um
   `clientId` de configuração e o `client_secret` do cofre de credenciais
   (registro próprio) e pular o registro dinâmico — hoje só o caminho DCR existe.
2. **Modo desktop, sem OAuth**: `authMode: none` + `url: http://127.0.0.1:3845/mcp`
   com o app Figma desktop, Dev Mode e assento Dev/Full em plano pago. Sem
   write-to-canvas e sem as ferramentas de geração de design do servidor remoto.
3. Atualizar o Harness quando a Figma permitir CIMD (Client ID Metadata Documents)
   ou liberar clientes de terceiros; a camada de OAuth do plugin é a do SDK, então
   a migração é local.

## Modo desktop (sem OAuth)

```yaml
- id: figma-mcp
  name: '@local/dsh-figma-mcp-oauth'
  config:
    url: http://127.0.0.1:3845/mcp
    authMode: none
    autoConnect: true
```

Requisitos: app Figma desktop atualizado, arquivo de Design aberto, `Shift+D`
(Dev Mode, nada selecionado) → barra direita → “Enable desktop MCP server”.

## Segurança

- O grant (client information, tokens, code verifier, `state`, discovery state)
  fica no **cofre de credenciais do Harness**, registro `figma-mcp/oauth`
  (`ctx.credentials`), nunca em `cordis.patch.yml`.
- O listener de callback escuta **somente** `127.0.0.1`, valida `state` e mostra a
  página de sucesso só depois de o `error`/`state` serem conferidos; o `iss` é
  validado pelo SDK antes de trocar o código.
- `figma_logout` apaga o registro (`deleteRecord`) e desconecta.
- Nenhum segredo aparece em prompt, saída de ferramenta ou log.

## Solução de problemas

| Sintoma | Causa / ação |
|---|---|
| `403 Forbidden` no login, mensagem sobre lista do catálogo | `clientName` fora da allowlist ou a Figma mudou o gate. Ajuste `clientName` ou use o modo desktop. |
| “não foi possível ouvir na porta de callback 3846” | Outra instância do plugin/Harness está usando a porta. A mensagem é devolvida na hora (não trava o Host); feche a outra instância ou mude `redirectPort` e refaça o login. |
| “authorization timed out” | Ninguém concluiu o login em `loginTimeoutMs`. Rode `figma_login` de novo. |
| “state mismatch (possible mix-up attack)” | Um callback de outra tentativa/instância (ou forjado) é **ignorado**: a página mostra o erro, mas o login pendente continua esperando o callback legítimo até `loginTimeoutMs`. Refaça o login somente se ele expirar. |
| Ferramentas `mcp__figma__*` não aparecem | Verifique `figma_status`; se estiver `unauthenticated`, chame `figma_login`. Depois da autorização, as ferramentas entram na geração seguinte do prompt. |
| “a autorização da Figma expirou” ao chamar ferramenta | Token inválido/revogado (por exemplo, login em outra máquina: a Figma mantém um token por app/usuário). A conexão é derrubada e o status passa a `unauthenticated`; `figma_login` refaz o login (sem abrir uma aba por chamada). |
| Trocou o nome/URL do servidor e a conexão continua igual | `figma_logout` e `figma_login` para registrar de novo. |
| `figma_logout` durante um login em andamento | O `figma_logout` cancela a tentativa pendente e apaga o grant; o callback atrasado não gera erro confuso. |

## Arquitetura

```
figma-mcp-oauth/
├── index.js           # plugin Cordis: Config, inject, apply, ferramentas/comando/fluxo
├── lib/oauth.js       # OAuthClientProvider + cofre via ctx.credentials + loopback + navegador
├── lib/mcp.js         # supervisor da conexão MCP, nomes públicos, registro das ferramentas
├── cordis.patch.yml   # linha figma-mcp do bundle
├── locale/{en,pt}.json
└── icon.svg
```

- **Protocolo**: todo o OAuth é do SDK oficial `@modelcontextprotocol/client@2.2.x`
  (`auth()`, `OAuthClientProvider`, `StreamableHTTPClientTransport`). O plugin
  implementa apenas o provider, o listener loopback e a persistência.
- **Bridge de ferramentas**: reutiliza `createMcpToolDefinition` do
  `@deepseek-ai/dsh-mcp-client` (mesmo contrato de resultado canônico, imagens
  duráveis e `projectContent` do bridge oficial); a nomenclatura pública é
  reimplementada verbatim (`mcp__<server>__<raw>`, 64 chars `[A-Za-z0-9_-]`,
  sufixo hash SHA-256 de 12 hex quando a normalização perde informação).
- **Sem dependências npm no bundle**: os três pacotes são `peerDependencies`
  resolvidas pela instalação do DSH (regra de resolução de bundle `link:`).
- **Boot seguro**: `apply` nunca espera a rede. Sem grant, o plugin carrega,
  publica `figma_login` e fica `unauthenticated`; falha de conexão em background
  só loga.

## Verificação

Estado em 2026-11-09, em desenvolvimento local:

- **Fluxo OAuth completo offline** contra um AS + servidor MCP falsos: descoberta
  (RFC 9728/8414), DCR, PKCE S256 + `state`, callback loopback, troca de código,
  conexão, `tools/list`, `tools/call`, refresh automático no 401 e reconexão
  após “restart” usando o grant armazenado, mais `figma_logout` — 19/19
  checagens (harness local, mantido fora do repositório).
- **Contra a Figma real**: registro dinâmico `201` com `clientName`
  `Claude Code (DSH)`, URL de autorização aceita (`302` para o login da Figma)
  com PKCE S256 + `state` + `scope` + `resource`; nome não-catalogado mapeado
  para a mensagem acionável de `403`.
- **Login real concluído pelo usuário** em uso real: `figma_status` →
  `connected — 42 ferramentas disponíveis — endpoint https://mcp.figma.com/mcp`;
  `mcp__figma__whoami` respondeu com a conta autenticada; `list_mcp_resources`
  listou os recursos e skills do servidor (`skill://figma/...`), provando também
  a integração com `ctx.mcpResources`.
- **Revisão independente** (relatório mantido fora do repositório, teammate separado do
  autor): happy path e as 19/19 checagens reproduzidas; encontrou 1 bloqueador
  (uma rejeição de promise não tratada no listener loopback podia chegar ao
  handler fatal do Host quando a porta de callback estava ocupada — corrigido:
  a promise exposta tem handler no-op, listeners são removidos em `finally`,
  `logout`/`dispose` cancelam a tentativa e todo `void` assíncrono tem `.catch`;
  reprodução com o handler real do DSH passa a **sobreviver**) e 2 achados
  maiores corrigidos: recuperação após token revogado (a conexão é derrubada,
  o status sai de `connected`, `figma_login` volta a funcionar e não abre mais
  uma aba por chamada falha) e `figma_login` não-bloqueante agora devolve o erro
  acionável (DCR 403, porta ocupada, descoberta) em vez de “iniciado”.
- **Re-verificação independente: PASS** (relatório mantido fora do repositório).
  Contra o código atual: harness adversarial do revisor **180/180** checagens e
  0 rejeições não tratadas; estático/manifesto/registro vivo **82/82**; harness
  do autor **37/37**; reparo do bloqueador confirmado com o handler fatal real do
  DSH (`SURVIVED`, exit 0). Nenhum achado bloqueador/maior residual. Achado
  menor R1 (README anunciava cliente pré-registrado inexistente) corrigido na
  documentação.
- **Pendências conhecidas**: reconexão automática após reiniciar o Host foi
  coberta apenas no teste offline (`autoConnect` + grant no cofre), não num
  restart real deste perfil; metadados/ícone renderizados na UI não foram
  verificados visualmente (sem controle de navegador; recursos estáticos
  válidos); `tools/call` real do Figma foi exercido via `mcp__figma__whoami`
  após o login, mas não os fluxos de design.
