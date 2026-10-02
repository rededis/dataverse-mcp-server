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
goes. The evidence behind them was gathered on 2026-09-22 from primary sources
and local experiments; what this record relies on is reproduced in
[Evidence](#evidence) at the end (E1–E4).

## Decisions

### 1. One repository, one source tree, two artifacts

The HTTP server is a second entry point in the same package. It shares the
Dataverse client and the tools with the stdio entry point.

- **npm package** (`@rededis/dataverse-mcp-server`): the stdio server. It keeps
  every tool, development tools included.
- **Docker image** (`ghcr.io/rededis/dataverse-mcp-server-http`): the HTTP
  server. It is built from a single bundle of the server entry point, so only
  what that entry point imports ends up in the image. That includes the
  read-only metadata tools; what it excludes is the `development` group
  (schema changes, solutions, dependency checks, see §4).

Development tools live under `src/tools/development/`, which nothing a server
entry point can reach imports. A CI check fails the build if the server bundle
contains any of them (#79). The guarantee is physical absence, not a runtime
flag that a misconfiguration could flip.

*Mechanism* (#72):

- The server entry point takes its tools from `src/tools/server-groups.ts`
  (`SERVER_TOOL_GROUPS`, the five server-safe groups). Nothing reachable from
  it imports `development/`.
- `development/` has exactly one importer, `src/tools/all.ts`
  (`registerAllTools`: every group, development included), and `all.ts` has
  exactly one, `src/index.ts`, the stdio entry point. `all.ts` is a separate
  module rather than code inside `src/index.ts` because `src/index.ts` loads
  `.env` and connects stdio on import, so no test can import it; with `all.ts`
  the `tools/list` snapshot registers tools exactly as stdio does.
- Code needed by more than one group lives in `src/tools/shared/`. Group
  modules never import each other, so a helper cannot pull another group,
  or development, in after it.
- `tests/tool-groups.test.ts` enforces both rules: reachability from
  `server-groups.ts`, and the importer allowlist. The bundle check in #79
  covers the same boundary from the build side.

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
each role picks from those. The server gets them from `SERVER_TOOL_GROUPS`,
keyed by these names.

Solutions and dependency checks sit in `development` because they serve
packaging customizations and preparing destructive schema changes. An agent
working with data does not need them.

### 5. Protocol split

- **HTTP server: MCP 2026-07-28 only.** It is built on SDK v2
  `createMcpHandler` with `legacy: 'reject'`. A 2025-era request gets the
  SDK's unsupported-protocol-version error (`-32022`, HTTP 400) naming the
  supported revision ([E1](#e1-mcp-typescript-sdk-v2)).
- **stdio package: stays compatible with 2025-era clients.** Today's clients
  speak 2025-11-25 over stdio; Claude Code 2.1.278 was observed doing so. SDK v2
  `serveStdio` pins such a connection to the legacy era by default ([E1](#e1-mcp-typescript-sdk-v2)).

  _Added 2026-10-02 with #75._ The stdio package serves both revisions, and
  the 2025 one is no longer the path the main client takes
  ([E1](#e1-mcp-typescript-sdk-v2)). Claude Code
  2.1.287, with default settings, was observed opening a stdio session with
  `server/discover` and staying on 2026-07-28; against a server on SDK v1 it
  got "Method not found" and fell back to a 2025-11-25 `initialize` in the same
  process. With `MCP_PROTOCOL_NEGOTIATION=legacy` it sent `initialize` straight
  away. Its documentation says stdio servers are not probed unless that
  variable is `auto`, so the default may depend on the account. Which revision
  Claude Desktop speaks to a local stdio server was not established. A test
  opens a session each way.

  _Added 2026-10-02 after the 0.9.0 release._ The published package was
  checked by hand from another project with Claude Code 2.1.287, in default
  mode and with `MCP_PROTOCOL_NEGOTIATION=legacy`: it connected, listed 23
  tools, and read data, metadata and a function result in both
  ([E1](#e1-mcp-typescript-sdk-v2)). No wire log was taken, so which revision
  those runs used is not known, and Claude Desktop was not checked.

  `serveStdio` builds an `McpServer` object per connection, plus one for a
  `server/discover` probe that it discards if the client falls back, and
  `createMcpHandler` builds one per HTTP request. Whatever must exist once per
  process is therefore created outside the factory: the Dataverse client, its
  token cache, and the throttling state of §10.

*Why reject legacy on HTTP:* 2026-07-28 is stateless by design (no `initialize`,
no `Mcp-Session-Id`), which is what a horizontally scaled, per-request
authenticated server wants. Serving 2025-era HTTP as well would double the
surface to test, audit and secure, for no client we need: Claude Code already
speaks 2026-07-28 over HTTP ([E1](#e1-mcp-typescript-sdk-v2)), and the `mcp-remote` bridge does when given
`--protocol auto` (verified with 0.14.3; without it the bridge speaks
2025-11-25 and is rejected).

*Why keep legacy on stdio:* rejecting it would break every existing user of the
npm package with no benefit; the SDK serves both eras from one factory.

Migrating to SDK v2 (#75) raises `engines.node` from `>=18` to `>=20`, because
`@modelcontextprotocol/server` and `@modelcontextprotocol/core` 2.0.0 require
it ([E1](#e1-mcp-typescript-sdk-v2)). That is a breaking change for the npm package and is released as
0.9.0.

### 6. Proxy headers

A 2026-07-28 request carries its method and protocol version in HTTP headers
(`Mcp-Method`, `MCP-Protocol-Version`) as well as in the body. The SDK checks
that they agree and answers **400** (`-32020`, "the request headers and body
disagree") when a header is missing ([E1](#e1-mcp-typescript-sdk-v2)). If an
installation puts a reverse proxy, gateway or WAF in front of the server, it
must pass these headers through unchanged. The server documentation says so
(#80).

### 7. Access: bearer tokens from a config file

- Tokens are stored as SHA-256 hashes in a JSON config file, compared in
  constant time, and may carry an expiry date.
- Every request is verified; there is no session to cache a verdict on. A
  failure answers 401 with `WWW-Authenticate`.
- Verification sits behind a `TokenVerifier` interface; the SDK's handler does
  no verification of its own and only passes `authInfo` through ([E1](#e1-mcp-typescript-sdk-v2)).
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
page permits this explicitly ([E2](#e2-mcp-specification-2026-07-28)):

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
- Tool order is deterministic (a SHOULD in the same section): the key order of
  `SERVER_TOOL_GROUPS`, then development. A test pins it. The list is part of
  the model's prompt, so a new order costs clients their prompt cache; change
  it deliberately.

### 10. Dataverse limits

Service protection limits apply **per user per web server**. The documented
defaults are 6,000 requests and 20 minutes of combined execution time within a
5-minute sliding window, plus 52 or more concurrent requests; Microsoft notes
they "can change and might vary between different environments" (Dataverse
service protection API limits page). Application users get the same limits as
everyone else ([E3](#e3-microsoft-dataverse-limits-and-licensing)). A server that sends every caller's traffic through one application user
concentrates all of it on one user's limits.

The server protects Dataverse, not itself: a concurrency limit, a bounded queue
with a maximum wait, retry on 429 honouring `Retry-After` (failing fast when the
wait is long), and per-request timeouts (#73, #74). These also benefit the
stdio package, where parallel tool calls hit the same limits.

_Added 2026-10-02 with the implementation of #74._ How those mechanisms behave,
where the choice was not obvious:

- **One instance keeps one throttling state.** An instance authenticates as one
  application user, and that user is what Dataverse throttles. A 429 on any
  request therefore holds back every request the instance would send until the
  wait Dataverse asked for is over, because Dataverse extends the wait for a
  client that keeps sending
  ([E3](#e3-microsoft-dataverse-limits-and-licensing)). The pause deliberately
  ignores that the limits are counted per web server: the server keeps no
  affinity cookie, so a retry may reach a web server that was never busy, which
  costs a wait and nothing else.

  _Revised 2026-10-02 (#88)._ Other requests are held back for the wait
  Dataverse asked for, but no longer than one request is allowed to wait
  (`DATAVERSE_MAX_RETRY_WAIT_MS`, 15 s by default). The first version held them
  for up to 5 minutes. A live 429 then carried `Retry-After: 300` while light
  requests sent straight after it were answered
  ([E3](#e3-microsoft-dataverse-limits-and-licensing)): Dataverse turns a
  request away when the allowance is used up at that moment, not for the whole
  `Retry-After`. A long pause would have been downtime of our own making. The
  evidence is four probes and one of the three limits, so this is the cheaper
  mistake to make, not a settled fact.
- **A throttled write is retried like a throttled read.** Microsoft's
  ServiceClient does the same and does not look at the method. No Microsoft
  source states that a request answered with 429 was not executed
  ([E3](#e3-microsoft-dataverse-limits-and-licensing)), so this rests on
  reading throttling as an admission check. If that reading is wrong, the cost
  is a duplicate record, which no later code change removes. The live 429s of
  2026-10-02 took 28 to 75 s to arrive, which does not look like a check made
  on arrival; they were reads, so nothing shows whether a write answered that
  way had run. Watch for duplicates once the server is deployed.
- **Failing fast counts the waits of one request together**, not each
  `Retry-After` on its own, so the number of attempts does not multiply the
  time a tool call is held.
- **A retry carries the token the request was built with.** The token is added
  by `DataverseClient`, before the executor chain (#73). The waits are capped
  in configuration so that the token is still valid when the request is sent
  for the last time. ServiceClient instead acquires the token again on every
  attempt.

**Open for #77.** Acting on behalf of a Dataverse user may change whose limits
a request counts against. If Dataverse counts it against the user acted for,
one throttling state per instance is wrong, and the state has to be kept per
user. How Dataverse counts impersonated requests was not verified.

Adding application users would only spread the 5-minute limits. All
application users in a tenant **share one tenant-level daily allowance**
([E3](#e3-microsoft-dataverse-limits-and-licensing)), so extra users add no daily capacity.
See Deferred for the pool.

### 11. No inbound rate limiting or TLS in the server

The server does not terminate TLS and does not limit how often a client may
call it. What sits in front of it is the installation's choice: a reverse
proxy, an API gateway, a platform ingress, or nothing, with clients calling it
directly. This repository does not decide that for the operator.

The server's own protection points at Dataverse (§10), not at its callers. An
installation that exposes the server directly gets bearer-token authentication
and nothing else between the network and the server; the server documentation
says so plainly, so that is a decision the operator makes knowingly (#80).

### 12. Audit log records the shape of a call, not its content

Per call: time, token name, role, the Dataverse user acted on behalf of,
tool, entity set, selected columns, `$filter` with literals masked, status,
record count, duration, Dataverse request count, and whether throttling
occurred.

Never logged: bearer tokens, secrets, request or response bodies, and raw
Dataverse error text. Field values are not logged **by default**. The only
exception is opt-in: an installation may name specific entity-set/field pairs
in a config allowlist, and only those values are logged (#78).

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
| OAuth for Claude connectors | The server should be added through the Claude UI, shared within an organization, or individual people must be distinguished. Note: claude.ai custom connectors also offer static request headers as a beta for a limited set of organizations; that connection comes from Anthropic's cloud, one header per connector, and which protocol era it speaks was not verified ([E4](#e4-claude-clients)). |
| Separate Dataverse credentials per role | Acting on behalf of a Dataverse user turns out to be unsuitable. |
| Extensions (custom module, derived image, upstream proxy, server as a library) | The first concrete request for custom behaviour. |
| Shared limiter across instances (e.g. Redis) | More than one instance runs against the same Dataverse budget. |
| Pool of Dataverse application users | One application user's limits are the bottleneck. Extra users only spread the 5-minute limits and share the tenant's daily allowance. Microsoft's Product Terms forbid working "around any technical limitations"; whether a pool counts is unresolved ([E3](#e3-microsoft-dataverse-limits-and-licensing)), so check it first. |
| `structuredContent` / `outputSchema` | Programmatic consumers need a typed response contract. |
| Excluding field-secured columns (`IsSecured`) from logs | Field value logging is enabled for an installation. |

## Evidence

Gathered on 2026-09-22 from primary sources (spec Markdown sources, SDK type
declarations in the published npm tarballs, Microsoft Learn and licensing
terms, Anthropic docs) and from local experiments. Versions:
`@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0,
Claude Code 2.1.278, Node 24.9.0. The experiment scripts were throwaway and are
not committed; their results are recorded here.

### E1. MCP TypeScript SDK v2

Package shape, from the `@modelcontextprotocol/server` 2.0.0 tarball:

- `package.json` declares `"engines": { "node": ">=20" }`; so does
  `@modelcontextprotocol/core` 2.0.0.
- It ships a CJS build (`require` conditions point to `dist/*.cjs` with
  `dist/*.d.cts` types). A file importing `McpServer`, `createMcpHandler` and
  `serveStdio` compiled with this repo's `tsconfig.json` (`module: Node16`) and
  `tsc` 5.9.3, and ran.
- Its dependency `zod ^4.2.0` is compatible with this repo's `zod ^4.3.6`.

stdio, `dist/stdio.d.cts`, `ServeStdioOptions.legacy?: 'serve' | 'reject'`:

> `'serve'` (default) — the connection is pinned to a 2025-era instance from
> the same factory and served exactly as a hand-wired stdio server serves it
> today.

HTTP, `dist/createMcpHandler-*.d.cts`,
`CreateMcpHandlerOptions.legacy?: 'stateless' | 'reject'`:

> `'reject'` — modern-only strict: legacy-classified requests are rejected with
> the unsupported-protocol-version error naming the endpoint's supported
> revisions (legacy-classified notifications are acknowledged with `202` and
> dropped). **There is no 2025 serving in this mode.**

Authentication, same file:

> The entry performs no token verification: `authInfo` given to `fetch` is
> passed through to handlers and the factory as-is and is never derived from
> request headers.

Cache defaults, same file: 2026-07-28 cacheable results default to
`{ ttlMs: 0, cacheScope: 'private' }`, overridable per method with the
`cacheHints` option.

Experiments:

- **2025-era clients over stdio.** A v2 `serveStdio` server answered a raw
  2025-11-25 JSON-RPC client, the v1 SDK 1.30.0 client, and Claude Code 2.1.278
  (`initialize`, `tools/list`, `tools/call`). The factory saw `era=legacy`.
  Claude Code sends a 2025-11-25 `initialize` over stdio.

  Re-checked 2026-10-02 for #75, on `@modelcontextprotocol/server` 2.2.0 and
  Claude Code 2.1.287. The package findings above hold on 2.2.0, and
  `tools/list` is byte-identical across 2.0.0, 2.1.0 and 2.2.0. The last
  sentence no longer does: with default settings Claude Code 2.1.287 opened
  the stdio session with `server/discover`
  (`"io.modelcontextprotocol/protocolVersion":"2026-07-28"` in `_meta`), the
  `serveStdio` factory saw `era=modern`, and the whole session (`tools/list`,
  `tools/call`) ran on 2026-07-28. Against a server on SDK 1.29.0 the same
  probe was answered `-32601 Method not found`, and Claude Code then sent a
  2025-11-25 `initialize` in the same process. With
  `MCP_PROTOCOL_NEGOTIATION=legacy` it sent `initialize` first. One run per
  configuration, on one account, plus one repeat with a clean environment.
  Claude Code's documentation (https://code.claude.com/docs/en/mcp, "MCP client
  runtimes") says stdio servers are probed only when that variable is `auto`.
  A raw client that opens with `server/discover` gets
  `{"supportedVersions":["2026-07-28"],…}` from `serveStdio` and
  `Method not found` from a hand-wired `StdioServerTransport` on the same SDK.

  Manual check of the published 0.9.0 (2026-10-02, Claude Code 2.1.287, Node
  24.9.0, from another project; recorded in full on #75). Default mode:
  connected, 23 tools; `query_records`, `get_record`, `list_entities`,
  `get_entity_schema`, `invoke_function` (`WhoAmI`), `get_picklist_options`
  and `list_solutions` returned data; a request to a missing table returned the
  Dataverse 404 text and the session carried on; seven calls in one message
  all answered. With `MCP_PROTOCOL_NEGOTIATION=legacy`, run headless:
  connected, 23 tools, `WhoAmI` and `query_records` returned data. Compared
  with 0.8.0 on a raw 2025-11-25 client, two things differ, both as recorded
  in the CHANGELOG: an unknown tool is a JSON-RPC `-32602` error instead of an
  `isError` result, and the input-validation text lost its
  `MCP error -32602:` prefix. Not covered: the protocol revision the runs
  used, whether the `legacy` setting took effect, Claude Desktop, and writes
  (`create_record`, `update_record`) against a live org.
- **2025-era request against `legacy: 'reject'`:**
  `400 {"error":{"code":-32022,"message":"Unsupported protocol version: 2025-11-25","data":{"supported":["2026-07-28"],"requested":"2025-11-25"}}}`
- **2026-07-28 request without the `Mcp-Method` header:**
  `400 {"error":{"code":-32020,"message":"Bad Request: the request headers and body disagree: the body names method tools/list but the required Mcp-Method header is absent"}}`
- **Per-caller lists.** `tools/list` without `authInfo` returned one tool; with
  `authInfo` carrying an admin role it returned two. Both results carried
  `ttlMs: 0, cacheScope: "private"`.
- **Claude Code 2.1.278 over HTTP**, with a static `Authorization` header: it
  opens with a 2026-07-28 `server/discover`, then sends `subscriptions/listen`,
  `tools/list` and `tools/call`, each with the `MCP-Protocol-Version: 2026-07-28`
  and `Mcp-Method` headers. It never sends `initialize` or `Mcp-Session-Id`. The
  `Authorization` header arrived on every request.

### E2. MCP specification 2026-07-28

Tools page, "Capabilities" section
(https://modelcontextprotocol.io/specification/2026-07-28/server/tools):

> Servers that declare the `tools` capability **MUST** respond to `tools/list`
> requests with the set of tools currently available to the requesting client.
> This set **MAY** be empty and **MAY** change over time (see List Changed
> Notification), but **MUST NOT** vary per-connection or as a side effect of
> other requests on the connection. The set **MAY** vary by the authorization
> presented on the request — for example, returning only the tools the caller's
> granted scopes permit — since credentials are per-request input, not
> connection state.
>
> Servers **SHOULD** return tools in a deterministic order.

SEP-2567 "Sessionless MCP", section "Session-independent list endpoints"
(https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567):

> This does not preclude varying the list by the authorization presented on the
> request: credentials are carried on each request, so a server returning
> different tool sets to different principals or scopes is relying on
> per-request input, not connection state.

Caching page
(https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching):

> `"private"` — The response contains private data that is not meant to be
> shared between callers. Cached responses **MAY** be reused for the same
> authorization context. Caches **MUST NOT** be shared across authorization
> contexts (e.g. a different access token requires a different cache).
>
> Servers MUST be aware that responses with a `"public"` `cacheScope` may be
> shared between callers even if the Result is coming from an authenticated
> endpoint. … Server implementors … MUST apply appropriate per-primitive access
> controls, and MUST NOT rely on `cacheScope` alone to prevent unauthorized
> access to primitives.

Changelog (sessions and `initialize` removed, `server/discover` added):
https://modelcontextprotocol.io/specification/2026-07-28/changelog

### E3. Microsoft: Dataverse limits and licensing

Service protection API limits
(https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits,
re-checked 2026-09-27):

> The system evaluates service protection API limits for each user. Each
> authenticated user has an independent limit.
>
> Each web server that your environment makes available enforces these limits
> independently.
>
> Are limits applied differently for application users? No. The system applies
> the same limits to all users.

Default limits per web server: 6,000 requests and 20 minutes (1,200 s) of
combined execution time within a five-minute sliding window, and "52 or
higher" concurrent requests. "These limits can change and might vary between
different environments." A 429 carries a `Retry-After` header in seconds.

Re-checked 2026-10-01 for #74. The same page, on what happens to a client that
does not stop:

> If the application continues to send such demanding requests, the duration is
> extended to minimize the impact on shared resources. This extension causes
> the individual retry-after duration period to be longer, which means your
> application sees longer periods of inactivity while it's waiting.

Server affinity, "Send parallel requests"
(https://learn.microsoft.com/en-us/power-apps/developer/data-platform/send-parallel-requests):

> When you send requests in parallel from your client application, you can gain
> performance benefits by disabling this cookie. Each request you send routes
> to any of the eligible servers. This change not only increases total
> throughput, but it also helps reduce the impact of service protection limits
> because each limit applies per server.

Node's `fetch` stores no cookies (undici 7.16.0, `lib/web/fetch/index.js`: both
cookie steps of the Fetch algorithm are stubs), so the server sends none.

Whether a request answered with 429 was executed: no Microsoft page says. The
service protection page calls `Retry-After` "the duration before any new
requests from the user can be processed", which suggests an admission check
without promising one. ServiceClient retries a throttled request without
looking at its method, and acquires the token again inside the retry loop
(https://github.com/microsoft/PowerPlatform-DataverseServiceClient/blob/03fa4d1132c90af9f6c08e581119e7407ca61fa7/src/GeneralTools/DataverseClient/Client/ConnectionService.cs,
L2343-L2345 and L2436-L2500).

A live 429, provoked on the dev org on 2026-10-02 with read-only requests
(#88). A filter of 40 `contains()` conditions forces a table scan and costs
about 16 s of execution time per request; sent 16 at a time, it exhausted the
execution-time limit in about five minutes, twice. Eight requests were
answered:

```
status: 429
retry-after: 300
body: {"error":{"code":"0x80072321","message":"Combined execution time of
incoming requests exceeded limit of 1200000 milliseconds over time window of
300 seconds. Decrease number of concurrent requests or reduce the duration of
requests and try again later."}}
```

- `error.code` is a hex string and `Retry-After` is whole seconds. Values
  recorded: 300, 0, 23, 7, 27, 27. There are no `x-ms-ratelimit-*` headers on
  a 429.
- The throttled requests took 28 to 75 s to come back.
- Light `WhoAmI` requests sent straight after were answered 200: four after
  the `Retry-After: 300` response, and in the second run two probes 9 and 14 s
  after a `Retry-After: 27` response, on the web server that reported 24 s and
  84 s of execution time remaining. Pinning to one web server with the
  `ARRAffinity` cookie did not hold reliably, so only those probes are known to
  have reached the throttled server.
- The other two limits were not reached: 150 requests at once and 9,514
  `WhoAmI` requests in nine minutes produced slow responses and network-level
  failures on the client side, and no 429.
- The server's own retry chain has not run against a live 429.

Request limits and allocations
(https://learn.microsoft.com/en-us/power-platform/admin/api-request-limits-allocations):

> Does each application user, non-interactive user, administrative user, or
> system user get their own tenant-level limit? No, they don't. All application
> users, non-interactive users, administrative users, and system users within
> the tenant share tenant-level limits.

The Dataverse page neither recommends nor forbids spreading load across several
application users. The Finance & Operations docs, a different Dynamics 365
product, do recommend it
(https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/service-protection-maximizing-api-throughput,
"Distribute workloads across multiple service principals"). Applying that to
Dataverse is an inference, not documented.

Product Terms, Universal License Terms for Online Services, "Technical
Limitations" (https://www.microsoft.com/licensing/terms/product/ForOnlineServices/all):

> Customer must comply with, and may not work around, any technical limitations
> in an Online Service that only allow Customer to use it in certain ways.

No Microsoft source says whether several application users count as working
around service protection limits.

Multiplexing guidance, "Details – Dynamics 365, Power Platform, & Dataverse"
(https://www.microsoft.com/licensing/guidance/Multiplexing), quoted in
[Licensing](#licensing) above. The Power Platform Licensing Guide, September
2026, p. 24, "Multiplexing"
(https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/bizapps/PowerPlatformLicensingGuideSeptember-2026.pdf)
says the same:

> Any user or device that inputs data into, queries, views data from or
> otherwise accesses Power Apps, Power Automate and Power Pages apps, directly
> or indirectly must be properly licensed. The number of tiers of hardware or
> software between Power Platform apps and the users or devices that ultimately
> use Power Platform indirectly does not affect the number of USLs required.

### E4. Claude clients

Claude Code (https://code.claude.com/docs/en/mcp) adds a remote HTTP server
with a static header:

```bash
claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"
```

Verified locally on 2.1.278 (see E1).

claude.ai, Claude Desktop and mobile custom connectors
(https://claude.com/docs/connectors/building/authentication):

> `static_headers` — Fixed credential (API key or bearer token) entered by an
> organization administrator as a request header when adding the connector —
> **Beta**
>
> The credential is shared by the organization rather than pasted per user.

https://claude.com/docs/connectors/custom/remote-mcp:

> Request header authentication is in beta and available to a limited set of
> organizations.

Custom connectors connect from Anthropic's cloud, not from the user's device
(https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
so a server used that way must be reachable from the internet. Which protocol
era these connectors speak could not be observed.

Claude Desktop's `claude_desktop_config.json` is documented for local (stdio)
servers only. A static token from it needs a stdio bridge such as `mcp-remote`
(README of `mcp-remote` 0.14.3, `npm view mcp-remote@0.14.3 readme`), which
supports `--header` and `--header-file`. That the bridge needs
`--protocol auto` to reach a 2026-07-28-only server was found in a spike with
0.14.3 (see §5).
