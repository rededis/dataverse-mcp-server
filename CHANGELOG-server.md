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
