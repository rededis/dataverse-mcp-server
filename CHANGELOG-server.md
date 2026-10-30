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

### Changed

- The startup and shutdown messages are written to stderr; stdout carries only audit lines (#78).
- `@modelcontextprotocol/server` 2.4 instead of 2.3 (#119).

### Security

- `zod` 4.6.7 and `@hono/node-server` 2.1.5, which fix [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f); `server-v0.1.0-rc.1` and `rc.2` carry the affected versions (#119).
