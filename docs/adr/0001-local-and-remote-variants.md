# ADR-0001: Local and remote variants

- **Status:** Accepted
- **Date:** 2026-09-27
- **Epic:** #70

## Context

Until now this repository shipped one artifact: an npm package that runs as a
local stdio MCP server and exposes the whole Dataverse surface, schema changes
included. It is a development tool for one person working against a dev org.

Remote agents (Claude Code on another machine, Claude Desktop, other MCP
clients) need access to Dataverse **data**, not to its schema. They need it
through a server that someone else operates, with credentials the agents never
see and permissions narrower than the application user's.

The decisions below fix the repository layout and decide where future code
goes. The evidence behind them is in
[`docs/research/remote-server-open-questions.md`](../research/remote-server-open-questions.md)
(research date 2026-09-22). Section numbers (Q1–Q4) refer to that document.

## Decisions

### 1. One repository, one source tree, two artifacts

The HTTP server is a second entry point in the same package. It shares the
Dataverse client and the tools with the stdio entry point.

- **npm package** (`@rededis/dataverse-mcp-server`): the stdio server. It keeps
  every tool, development tools included.
- **Docker image** (`ghcr.io/rededis/dataverse-mcp-server-http`): the HTTP
  server. It is built from a single bundle of the server entry point, so only
  what that entry point imports ends up in the image.

Development tools live in modules that nothing outside the stdio entry point
imports. A CI check fails the build if the server bundle contains any of them
(#79). The guarantee is physical absence, not a runtime flag that a
misconfiguration could flip.

*Why not npm workspaces now:* the core has one consumer shape today (two entry
points in one package). Workspaces add release and build machinery without
buying anything the bundle does not already give. See Deferred.

### 2. Mechanism in code, policy in configuration

Whatever differs between installations is configuration: Dataverse endpoint
and credentials, limits, tokens, roles, allowlists, logging options. Code
provides the mechanisms (token verification, role checks, limiter, audit
logger), each behind an interface so an installation's needs do not require a
fork.

### 3. One server instance serves one Dataverse environment

Another environment means another instance. This keeps the configuration flat,
keeps the Dataverse limits of one environment isolated from another's, and
means a token can never reach an environment it was not issued for.

### 4. Tool groups

Tools are grouped by purpose, and the group names are the vocabulary of role
configuration (#72, #77):

| Group | Tools |
|---|---|
| `metadata-read` | `list_entities`, `get_entity_schema`, `get_picklist_options`, `list_entity_keys` |
| `data-read` | `query_records`, `get_record` |
| `data-write` | `create_record`, `update_record`, `delete_record` |
| `actions` | `invoke_action` |
| `functions` | `invoke_function` |
| `development` | `list_solutions`, `get_attribute_dependencies`, `create_entity`, `add_attribute`, `update_attribute`, `delete_attribute`, `create_relationship`, `add_entity_key`, `delete_entity_key`, `add_picklist_option`, `update_picklist_option`, `delete_picklist_option` |

The npm package registers all six. The server image contains the first five;
each role picks from those.

Solutions and dependency checks sit in `development` because they serve
packaging customizations and preparing destructive schema changes. An agent
working with data does not need them.

### 5. Protocol split

- **HTTP server: MCP 2026-07-28 only.** It is built on SDK v2
  `createMcpHandler` with `legacy: 'reject'`. A 2025-era request gets the
  SDK's unsupported-protocol-version error (`-32022`, HTTP 400) naming the
  supported revision (Q1d).
- **stdio package: stays compatible with 2025-era clients.** Today's clients
  speak 2025-11-25 over stdio; Claude Code 2.1.278 was observed doing so. SDK v2
  `serveStdio` pins such a connection to the legacy era by default (Q1a–Q1c).

*Why reject legacy on HTTP:* 2026-07-28 is stateless by design (no `initialize`,
no `Mcp-Session-Id`), which is what a horizontally scaled, per-request
authenticated server wants. Serving 2025-era HTTP as well would double the
surface to test, audit and secure, for no client we need: Claude Code already
speaks 2026-07-28 over HTTP (Q1f), and the `mcp-remote` bridge does when given
`--protocol auto` (verified with 0.14.3; without it the bridge speaks
2025-11-25 and is rejected).

*Why keep legacy on stdio:* rejecting it would break every existing user of the
npm package with no benefit; the SDK serves both eras from one factory.

Migrating to SDK v2 (#75) raises `engines.node` from `>=18` to `>=20`, because
`@modelcontextprotocol/server` and `@modelcontextprotocol/core` 2.0.0 require
it (Q1). That is a breaking change for the npm package and is released as
0.9.0.

### 6. Proxy headers

A 2026-07-28 request carries its method and protocol version in HTTP headers
(`Mcp-Method`, `MCP-Protocol-Version`) as well as in the body. The SDK checks
that they agree and answers **400** (`-32020`, "the request headers and body
disagree") when a header is missing (Q1e). Any reverse proxy, gateway or WAF in
front of the server must pass these headers through unchanged. The server
documentation says so (#80).

### 7. Access: bearer tokens from a config file

- Tokens are stored as SHA-256 hashes in a JSON config file, compared in
  constant time, and may carry an expiry date.
- Every request is verified; there is no session to cache a verdict on. A
  failure answers 401 with `WWW-Authenticate`.
- Verification sits behind a `TokenVerifier` interface; the SDK's handler does
  no verification of its own and only passes `authInfo` through (Q1).
- OAuth discovery probes (`/.well-known/oauth-*`,
  `/.well-known/openid-configuration`) answer 404, so clients do not assume
  OAuth.
- Config changes apply on restart.

*Why not OAuth now:* the clients in scope (Claude Code, `mcp-remote`, other
programmatic clients) all send a static header. OAuth pays off only when people
must be told apart or the server is added through the Claude UI. See Deferred.

### 8. Permissions: roles as rules in configuration

A role lists the tool groups it may use; for `data-write`, the entity sets it
may create, update or delete, per operation; and the action and function names
it may call. Everything that writes, deletes or invokes an action or function
is **off unless listed**. An empty allowlist means the corresponding tool is not
registered.

A token may optionally map to a Dataverse user. Calls are then made on that
user's behalf, and **both** the role and the user's Dataverse privileges apply.

Fixed roles would not survive the first real installation. The typical case
that shaped this: a support role that reads everything but may only prepare
and send messages to customers. Depending on the org, sending is either
"create an `email` in Draft, then call `SendEmail`" or "create a record in a
queued state that a flow or plugin picks up". Only per-entity-set and per-action
allowlists can express both (#77).

### 9. Per-caller tool lists

`tools/list` returns only what the caller's role allows. The 2026-07-28 tools
page permits this explicitly (Q2):

> [The set] **MUST NOT** vary per-connection or as a side effect of other
> requests on the connection. The set **MAY** vary by the authorization
> presented on the request — for example, returning only the tools the
> caller's granted scopes permit — since credentials are per-request input,
> not connection state.

Consequences:

- The role comes from the bearer token on each request, never from earlier
  calls. The SDK v2 factory builds the tool set from `ctx.authInfo` per
  request, which matches.
- Lists are returned with `cacheScope: "private"` (the SDK default). The caching
  page says caches with that scope "MUST NOT be shared across authorization
  contexts". Never configure `public` for role-filtered lists.
- The caching page also says servers "MUST NOT rely on `cacheScope` alone to
  prevent unauthorized access". Permissions are therefore re-checked on every
  `tools/call`, and entity-set and action allowlists are checked on the
  arguments, which a filtered list cannot do.
- Tool order is deterministic (a SHOULD in the same section).

### 10. Dataverse limits

Service protection limits apply **per user per web server**, over a 5-minute
sliding window: 6,000 requests, 20 minutes of combined execution time, 52
concurrent requests. Application users get the same limits as everyone else
(Q3). A server that sends every caller's traffic through one application user
concentrates all of it on one user's limits.

The server protects Dataverse, not itself: a concurrency limit, a bounded queue
with a maximum wait, retry on 429 honouring `Retry-After` (failing fast when the
wait is long), and per-request timeouts (#73, #74). These also benefit the
stdio package, where parallel tool calls hit the same limits.

Adding application users would only spread the 5-minute limits. All
application users in a tenant **share one tenant-level daily allowance**
(Q3, Power Platform request limits page), so extra users add no daily capacity.
See Deferred for the pool.

### 11. Inbound rate limiting is out of scope

Per-client rate limiting and TLS belong to whatever reverse proxy or gateway an
installation puts in front of the server. Every installation already has one,
and duplicating it in the server would add configuration without adding
protection.

### 12. Audit log records the shape of a call, not its content

Per call: time, token name, role, the Dataverse user acted on behalf of,
tool, entity set, selected columns, `$filter` with literals masked, status,
record count, duration, Dataverse request count, and whether throttling
occurred. Never logged: bearer tokens, secrets, request or response bodies,
field values, raw Dataverse error text. Field values only when a config
allowlist names the entity set and field (#78).

### 13. Two independent release lines

- Tags `v*` publish the npm package (`release.yml`).
- Tags `server-v*` publish the image (`server-release.yml`), with its own
  version and CHANGELOG. `release.yml` ignores `server-v*`.

Deploying a particular installation is outside this repository.

### 14. The server ships as 0.x, as-is

Documentation covers running and configuring the server and connecting
clients (#80). No compatibility promise until real installations shape the
configuration format.

## Licensing

Using the server does not change how many Microsoft licences are needed.
Microsoft's multiplexing guidance for Dynamics 365, Power Platform and
Dataverse:

> There is no such thing as "unlicensed user access" and a Multiplexing setup
> does not reduce the number of licenses required to access a Dynamics 365
> service, regardless of the pooling connection created. Any user or device
> that accesses the Dynamics 365 service—whether directly or indirectly—must be
> properly licensed.

People who reach Dataverse through the server still need their own licences,
even though the server uses an application user. The server documentation says
so and links the guidance (#80).

## Deferred

Not planned now. Each item names what would make it worth revisiting.

| Item | Revisit when |
|---|---|
| npm workspaces (core / development / stdio / server packages) | The core gets a second consumer, or the single-bundle approach becomes painful. |
| Config reload without restart | Restarts become a real operational cost for an installation. |
| Setup guides for Microsoft Foundry and Amazon Bedrock AgentCore | Someone actually connects them. |
| JWT verification (Microsoft Entra or another identity provider) | Foundry agent identity or Bedrock OAuth modes are needed. The `TokenVerifier` interface is the seam. |
| OAuth for Claude connectors | The server should be added through the Claude UI, shared within an organization, or individual people must be distinguished. Note: claude.ai custom connectors also offer static request headers as a beta for a limited set of organizations; that connection comes from Anthropic's cloud, one header per connector, and which protocol era it speaks was not verified (Q1, Q4). |
| Separate Dataverse credentials per role | Acting on behalf of a Dataverse user turns out to be unsuitable. |
| Extensions (custom module, derived image, upstream proxy, server as a library) | The first concrete request for custom behaviour. |
| Shared limiter across instances (e.g. Redis) | More than one instance runs against the same Dataverse budget. |
| Pool of Dataverse application users | One application user's limits are the bottleneck. Extra users only spread the 5-minute limits and share the tenant's daily allowance. Microsoft's Product Terms forbid working "around any technical limitations"; whether a pool counts is unresolved (Q3), so check it first. |
| `structuredContent` / `outputSchema` | Programmatic consumers need a typed response contract. |
| Excluding field-secured columns (`IsSecured`) from logs | Field value logging is enabled for an installation. |

## Sources

MCP specification 2026-07-28:

- Tools, "Capabilities": https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Caching: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
- Changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- SEP-2567 "Sessionless MCP": https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567

MCP TypeScript SDK v2:

- `@modelcontextprotocol/server` 2.0.0 npm tarball: `package.json` (`engines`), `dist/stdio.d.cts` (`ServeStdioOptions.legacy`), `dist/createMcpHandler-*.d.cts` (`CreateMcpHandlerOptions.legacy`, `authInfo` pass-through, cache hint defaults). Line references in Q1.

Microsoft:

- Dataverse service protection API limits: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits
- Power Platform request limits and allocations: https://learn.microsoft.com/en-us/power-platform/admin/api-request-limits-allocations
- Multiplexing licensing guidance: https://www.microsoft.com/licensing/guidance/Multiplexing
- Power Platform Licensing Guide, September 2026, "Multiplexing" (link in Q3)
- Product Terms, Universal License Terms for Online Services, "Technical Limitations": https://www.microsoft.com/licensing/terms/product/ForOnlineServices/all

Clients:

- Claude Code remote MCP servers: https://code.claude.com/docs/en/mcp
- Claude connectors authentication: https://claude.com/docs/connectors/building/authentication
- `mcp-remote` 0.14.3 README (`npm view mcp-remote@0.14.3 readme`)
