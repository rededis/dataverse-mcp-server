# Changelog: HTTP server image

All notable changes to the HTTP server image `ghcr.io/rededis/dataverse-mcp-server-http`
are documented in this file. It has its own version line, released with
`server-v*` tags (ADR-0001 §13); the npm package's changes are in
[CHANGELOG.md](CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A `server-vX.Y.Z` tag needs a `## [X.Y.Z]` section here; a pre-release
`server-vX.Y.Z-rc.N` needs `## [X.Y.Z]` or `## [Unreleased]`.

## [Unreleased]

### Added

- The MCP server for Microsoft Dataverse over Streamable HTTP (MCP 2026-07-28), for remote agents: the metadata-read, data-read, data-write, actions and functions tool groups, without the development tools (#76).
- Access with bearer tokens listed by their SHA-256 in a JSON config file (#76).
- Roles in the config file: which tool groups a token may use, which entity sets it may create, update or delete in, which actions and functions it may call, and which Dataverse user it acts on behalf of (#77).
- The image: one esbuild bundle on distroless Node 24, non-root (uid 65532), for `linux/amd64` and `linux/arm64`, with the licence texts of the bundled packages (#79, #96).
- An audit log on stdout: one JSON line (`"type":"audit"`) per tool call, with the token, role, `actAs`, the JSON-RPC id, the proxy's `X-Request-Id`, the names the call used, how it ended, the record count and the Dataverse requests, throttling and retries it caused; and a line per refused token, refused `Origin` and call to a tool the role does not have. It records no content: no filters, bodies, parameter values, records or Dataverse error text (ADR-0001 §12, #78).
- `DATAVERSE_AUDIT_KEY` (optional, at least 32 characters): the key of the HMAC in the fingerprint the audit log writes for a value refused for its shape. Without it the fingerprint has only a length and flags (#78).
- The `documents-read` tool group, with `list_record_documents`: the files in a record's SharePoint folder, at most 100, most recently modified first. A role grants the group on its own, without a list of entity sets; the entity set must exist, as for the other data tools. The record is read before its documents, as the token's `actAs` user when it has one, so a caller sees no more documents than records it may read. The group comes last in the tool list, so the order of the other tools does not change. The audit line counts the files listed as its records. Reading SharePoint documents through the Dataverse API needs a one-time admin setup, described in the README (#200).

### Changed

- The descriptions of `query_records`, `get_record`, `create_record`, `update_record`, `delete_record`, `list_entities` and `get_picklist_options` say what the tool changes or that it only reads, what it returns, its typical errors and which tool to use instead where one fits; `query_records` says it returns one page, up to 5000 rows by default (500 for elastic tables), and that a full page or a result cut by `top` may be incomplete; the `prefix` field of `list_entities` says an empty string disables the default filter (#192).
- The `query_records` description says that a filter with too many conditions across relationships is an error, and to use `Microsoft.Dynamics.CRM.In(...)` for a long list of ids (#47).
- The startup and shutdown messages are written to stderr; stdout carries only audit lines (#78).
- `@modelcontextprotocol/server` 2.4 instead of 2.3 (#119).

### Security

- `zod` 4.6.7 and `@hono/node-server` 2.1.5, which fix [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f); `server-v0.1.0-rc.1` and `rc.2` carry the affected versions (#119).
- `@hono/node-server` 2.1.9 and `hono` 4.13.19, which fix [GHSA-jpvv-r467-5p4w](https://github.com/advisories/GHSA-jpvv-r467-5p4w) and [GHSA-qv5m-9pm6-hqp3](https://github.com/advisories/GHSA-qv5m-9pm6-hqp3) in `@hono/node-server` and [GHSA-h7mg-cq63-vhpq](https://github.com/advisories/GHSA-h7mg-cq63-vhpq), [GHSA-4m76-xfj5-7975](https://github.com/advisories/GHSA-4m76-xfj5-7975), [GHSA-4h7h-rv7c-7m2v](https://github.com/advisories/GHSA-4h7h-rv7c-7m2v), [GHSA-46wx-v44x-9hh2](https://github.com/advisories/GHSA-46wx-v44x-9hh2) and [GHSA-3gg2-335m-rxc6](https://github.com/advisories/GHSA-3gg2-335m-rxc6) in `hono`; `server-v0.1.0-rc.1` to `rc.3` carry affected versions (`rc.3` alone for GHSA-qv5m-9pm6-hqp3). None of them reaches the server through these packages: it takes requests through the MCP SDK's Node adapter, not through the code these advisories fix (#184).
- A request path that URL parsing would change, such as `/x/..\mcp` or `/%2e%2e/mcp`, is refused with 400. Before, it was routed to `/mcp` while a reverse proxy matching the raw path saw a different path, so a path rule at the proxy could be bypassed; `/mcp` still required a bearer token. This is the issue of GHSA-jpvv-r467-5p4w, in the SDK's adapter rather than in `@hono/node-server`; `server-v0.1.0-rc.1` to `rc.3` are affected (#184).
