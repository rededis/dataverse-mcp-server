# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `@modelcontextprotocol/server` 2.3 instead of 2.2. The package now also depends on `@modelcontextprotocol/node` (which brings in `hono` and `@hono/node-server`) and contains the not yet released HTTP server under `dist/server/` (#76).
- The not yet released HTTP server gets roles, set in its config file: which tool groups a token may use, which entity sets it may create, update or delete in, and which actions and functions it may call. A token may also act on behalf of a Dataverse user (#77).

### Fixed

- `entity_set` and `id` are checked before they go into the request URL, in `query_records`, `get_record`, `create_record`, `update_record`, `delete_record` and the bound forms of `invoke_action` and `invoke_function`. An entity set must be a plain name and an id a GUID. Before, an `id` such as `<guid>)/../accounts(<guid>` reached a different table than the one named (#77).
- **BREAKING** — `invoke_action` and `invoke_function` accept an operation name with the `Microsoft.Dynamics.CRM.` namespace or without it, and refuse any other namespace. Before, a name with any dot was sent as given. An unbound call now goes to the bare name even when the namespace was given (#77).

## [0.9.0] - 2026-10-02

### Changed

- The server is built on MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.2) instead of `@modelcontextprotocol/sdk` 1.x (closes #75).
  - **BREAKING** — Node 20 or later is required; the SDK does not run on Node 18.
  - **The stdio server now speaks MCP 2026-07-28** as well as the 2025 revisions. A client that opens with `server/discover` is served on 2026-07-28; one that opens with `initialize` gets the revision it asks for, as before. Claude Code 2.1.287 was observed opening with `server/discover`, so it now runs on the new revision instead of falling back.
  - **Tool names, descriptions, order and input schemas are the same**, with three differences on every tool, none of which changes what a tool accepts: `$schema` is `https://json-schema.org/draft/2020-12/schema` instead of draft-07; `$schema` is the second key of the schema instead of the first; and the tool member `"execution":{"taskSupport":"forbidden"}` is no longer sent (`forbidden` is the default).
  - Input that fails a tool's schema is reported with different wording: one line, without the `MCP error -32602:` prefix.
  - A call to a tool name the server does not have is answered with a JSON-RPC error (`-32602`) instead of a tool result marked `isError`.
  - When stdin closes, the server stops at once: a request still in progress is not answered. Before, it was allowed to finish and its result was written. Clients that keep stdin open for the session, as MCP clients do, are unaffected. A one-shot pipe (`printf '…' | dataverse-mcp-server`) gets no answer to a call that had not finished, and a write sent that way may still reach Dataverse.
  - On a 2026-07-28 session every result also carries `resultType` and `_meta` with the server's name and version, and `tools/list` carries `ttlMs` and `cacheScope`.

  An error thrown inside a tool still reaches the client as the tool's error text with `isError: true`.

## [0.8.0] - 2026-10-02

### Added

- `DATAVERSE_REQUEST_TIMEOUT_MS` (default 30000, maximum 120000, matching Dataverse's own 2-minute limit on a message operation): every Dataverse request and the token request to Microsoft Entra ID now time out instead of hanging a tool call indefinitely. The error says which request timed out. A value that is not a whole number from 1 to 120000 is reported through `dataverse_setup` like a missing variable, rather than silently replaced by the default (#73).

- Handling of Dataverse service protection limits (closes #74). A `429 Too Many Requests` used to fail the tool call with the raw Dataverse error. Now:
  - A throttled request is resent after the wait its `Retry-After` header asks for, up to `DATAVERSE_MAX_ATTEMPTS` sends in total (default 3). Without a usable header the server backs off 2 s, then 4 s, and so on. While it waits, no other request is sent, because Dataverse extends the wait for a client that keeps sending.
  - If the waits of one request would add up to more than `DATAVERSE_MAX_RETRY_WAIT_MS` (default 15000), or the attempts run out, the tool call fails with "Dataverse is busy: a service protection limit was reached. Retry in N s." The raw Dataverse 429 text is no longer shown.
  - At most `DATAVERSE_MAX_CONCURRENCY` requests are in flight (default 8). Up to `DATAVERSE_MAX_QUEUE_LENGTH` more (default 100) wait their turn in arrival order for at most `DATAVERSE_MAX_QUEUE_WAIT_MS` (default 10000); beyond either bound the call fails with a "Dataverse is busy … Retry later" error instead of queuing indefinitely.
  - All five variables are optional. An out-of-range value is reported through `dataverse_setup` rather than replaced by the default.

  Behaviour to know about: writes are retried after a 429 like reads, as Microsoft's own clients do. A 429 holds other requests back for the wait Dataverse asked for, but no longer than `DATAVERSE_MAX_RETRY_WAIT_MS` (closes #88): in a live test Dataverse answered light requests straight after a 429 with `Retry-After: 300`, so a longer pause would only have been downtime of our own making. With the defaults the limits add at most 25 s of waiting to a request, chosen so that one request at the default timeout still fits the 60 s a client built on the MCP TypeScript SDK waits by default; the README gives the full arithmetic.

### Changed

- Tools are registered by purpose instead of by topic (closes #72): `metadata-read`, `data-read`, `data-write`, `actions`, `functions` and `development`, as named in [ADR-0001](docs/adr/0001-local-and-remote-variants.md) §4. Nothing a client sees changes except order: tool names, descriptions, input schemas and `DATAVERSE_ALLOW_DELETE` behaviour are identical, pinned by a `tools/list` snapshot taken before the change. `tools/list` now returns tools grouped this way rather than in the old per-file order.
- Tool input schemas are built once at module load instead of on every registration, ahead of SDK v2 building a server instance per HTTP request.
- When the cached token has expired, concurrent tool calls share one token request instead of each sending their own (#73).
- The client reports failures as typed errors (`DataverseApiError` with `status` and the Dataverse error `code`, `DataverseTimeoutError`, `DataverseNetworkError`, `DataverseAuthError`), and tools map "not found" by status rather than by matching message text. API error messages read as before. A network failure now says which request failed and why, instead of a bare `fetch failed` (#73).
- HTTP execution sits behind a `RequestExecutor` interface, the seam for throttling handling (#74), acting on behalf of a user (#77) and audit logging (#78) (#73).

### Fixed

- The server no longer writes a non-protocol line to stdout at startup. When a `.env` file was loaded, dotenv 17 printed a banner (`◇ injected env (7) from .env // tip: …`) with `console.log`, and on stdio stdout is the MCP protocol stream. Clients built on the MCP TypeScript SDK reported a parse error for that line and carried on; a stricter client could refuse the connection. Present in every release since 0.1.0.
- `get_picklist_options`, `add_attribute` and `create_entity` no longer report "Global OptionSet not found" for a server error whose body happens to contain "404". They matched `404` anywhere in the message; they now check the status (#73).

## [0.7.1] - 2026-08-17

### Fixed

- `list_entities` no longer fails with HTTP 501 when a prefix filter is used without a solution filter (closes #66) — the `DATAVERSE_ENTITY_PREFIX`-only setup that `.env.example` documents. Metadata entities reject `startswith` outright (`0x8006088a: The "startswith" function isn't supported for Metadata Entities`), not merely in combination with `or` as the code assumed, so the prefix is now applied client-side on every path rather than on one of the two.

  Cost of the fix, stated plainly: a prefixed call now fetches all table definitions and filters them here. Against a real org that is ~2.1 MB transferred to return 23 rows. Dataverse offers no server-side prefix match on metadata, and the solution-filtered path already worked this way; what is returned to the caller is unchanged.

  The test that should have caught this asserted the generated `$filter` string against a mocked client, so it agreed with the code while neither agreed with Dataverse. It now asserts that no `startswith` reaches the server and that the prefix is honoured on the returned rows.

- `get_entity_schema` reports a choice column whose `OptionSet` did not come back, instead of silently omitting its `option_set`. An omitted summary is indistinguishable from a non-choice column — an answer, and the wrong one. Such columns now appear in the same warning block as a failed cast lookup.

## [0.7.0] - 2026-08-17

### Added

- `add_attribute` and `create_entity` accept `global_option_set` on a `Picklist` attribute, binding the column to an existing Global OptionSet by name instead of creating a private copy of the values (closes #60). Mutually exclusive with `options`; an unknown name fails as `Global OptionSet not found: '<name>'`.

  Global OptionSets exist so one choice list can be shared across columns and tables. Previously the only ways to get a shared list were to accept a local copy that silently drifts the first time anyone edits one of them, or to create the column by hand in the maker portal — which breaks an otherwise scripted schema workflow.

  `create_entity` resolves names and builds every attribute body **before** creating the table, so nothing a client-side check can reject — an unknown set name, a Picklist with no values, an impossible DateTime pairing — can leave a half-built table behind; Dataverse offers no transaction to roll one back. A name repeated across attributes costs one lookup, not one per column.

### Changed

- Reworded the tool descriptions for `get_attribute_dependencies`, `delete_attribute`, `update_attribute` and `get_entity_schema`. These are the always-loaded prompt text a model reads to decide whether to call a tool, so they are pruned rather than expanded: return shapes and component-type enumerations that a caller gets for free by calling are gone, each meaning now lives in one tool rather than being restated across several, and the rename/type-change recipe sits in `update_attribute` alone. No behavior change.

### Notes

Three Web API details established live against a real org, all of which contradict the obvious reading:

- The binding goes through the `GlobalOptionSet` **navigation property**, not an inline `OptionSet`. Sending an inline one with `IsGlobal: true` is rejected: `0x80048403 — Only Local option set can be created through the attribute create. IsGlobal flag must be set to 'false'.`
- The binding target must be the **MetadataId**. Microsoft's documentation states the alternate key by name — `GlobalOptionSetDefinitions(Name='...')` — works there too, but a real org answers `HTTP 500: Guid should contain 32 digits with 4 dashes`. Hence the name is resolved to a GUID first.
- Sending an inline `OptionSet` **and** a binding together is not an error. Dataverse silently drops the binding and creates a local copy, which is why the pair is rejected client-side rather than left to the platform.

## [0.6.0] - 2026-08-17

### Changed

- **BREAKING** — `get_picklist_options` no longer returns a bare `[{ value, label }]` array. It now returns `{ option_set: { name, is_global, metadata_id }, options: [{ value, label }] }` (closes #61). The flat array made a Local OptionSet and a Global one indistinguishable: the response shape was identical either way, and matching values do not prove a binding. Callers that consumed the array directly need to read `.options`.
- `get_picklist_options` now resolves Choice, Status, State and MultiSelect columns, not just Choice. `statecode` / `statuscode` previously failed with "Picklist attribute not found"; the not-found message now names the whole choice family.

### Added

- `get_entity_schema` attaches an `option_set` summary — `{ name, is_global, metadata_id, option_count }` — to every choice-style column, so a schema dump answers "what can this column contain, and is the list shared?" without a call per column. The option values themselves are deliberately excluded; read them per column with `get_picklist_options`.

### Failure behavior

Reading OptionSet data turns `get_entity_schema` from one metadata request into five, so the two tools handle a failing request differently — in both cases so that an unknown answer is never presented as a definite one:

- `get_entity_schema` degrades. The base attribute list is the tool's contract and does not depend on OptionSets, so a failing lookup no longer costs the caller the column list. The partial coverage is reported in a second content block (the JSON stays in the first), because a silently missing `option_set` would read as "this column has no options". A failure of the base request itself still fails the call.
- `get_picklist_options` fails hard. There, an empty result means "not a choice column", so swallowing an error would turn a transient failure into a confident `Choice attribute not found` on a column that does exist. For the same reason a matched column whose `OptionSet` did not come back is an error rather than a default of `is_global: false`.

### Notes

Verified live against a real org: a column bound to a global set reports `is_global: true` with the global set's own `metadata_id`, while a locally-defined column reports `is_global: false` with an auto-generated name.

Two Web API details found during that verification, both encoded in `src/tools/optionset-utils.ts`:

- `OptionSet` is only reachable through a type cast, and the cast must name a **concrete** type. Casting to the abstract base — `/Attributes/Microsoft.Dynamics.CRM.EnumAttributeMetadata` — is rejected with HTTP 500 `0x8006088a: Unexpected attribute type`, despite the docs listing it as a GET-able entity type. Each concrete choice type is therefore requested separately.
- The sibling `GlobalOptionSet` navigation property is **not** a usable binding signal: for a locally-defined column it resolves to that column's own local set rather than returning null, so it cannot tell the two cases apart. `IsGlobal` on the expanded `OptionSet` is the reliable indicator.

## [0.5.0] - 2026-06-16

### Added

- Two new tools for invoking Dataverse Web API actions and functions, covering operations that fall outside CRUD (closes #57):
  - `invoke_action(name, entity_set?, id?, parameters?)` — POSTs a bound or unbound action. Unbound → `POST /<name>` (e.g. `UnpublishDuplicateRule` with `{ DuplicateRuleId }`); bound → `POST /<entity_set>(<id>)/Microsoft.Dynamics.CRM.<name>` (e.g. `PublishDuplicateRule` bound to `duplicaterule`, `QualifyLead` bound to `lead`). `parameters` is sent as the JSON request body. Bound-vs-unbound is per the Web API `$metadata`, not the SDK shape — verified live against a real org.
  - `invoke_function(name, entity_set?, id?, parameters?)` — GETs a bound or unbound function (e.g. `WhoAmI`). `parameters` are inlined as OData function arguments using parameter aliases; strings are quoted, GUIDs/numbers/booleans passed as-is.
  - Bare operation names are namespaced automatically for bound calls (`Microsoft.Dynamics.CRM.<name>`); a fully-qualified name is passed through. Operation names are validated against a dotted-identifier pattern and bound `id` must be a GUID, so a caller cannot inject extra path/query segments. Bound calls require both `entity_set` and `id`; unbound calls require neither (the half-specified case is rejected).

### Use case

Unblocks CRM operations that are only exposed as actions — notably publishing duplicate-detection rules (a rule created via `create_record` lands unpublished and has no effect until `PublishDuplicateRule`) and lead qualification (`QualifyLead`). Surfaced while building the fundaicapital Lead→Account qualification flow (DP-129 / DP-135).

### Note

`invoke_action` can perform arbitrary mutating operations and is intentionally ungated for now; capability-based access control (safe-by-default gating of writes/actions) is tracked separately in #45 / #46. `invoke_function` is read-only.

## [0.4.0] - 2026-05-12

### Added

- Three new tools for managing entity alternate keys (closes #35):
  - `list_entity_keys(entity_logical_name)` — reads `EntityDefinitions/Keys`, returns a flat array of `{ logical_name, schema_name, display_name, key_attributes, entity_key_index_status, metadata_id }`. Maps 404 to a friendly `Entity not found` error.
  - `add_entity_key(entity_logical_name, logical_name, display_name, key_attributes[], solution_unique_name?)` — POSTs `EntityKeyMetadata` to the entity's `/Keys` collection. Supports composite keys (multiple `key_attributes`). Optional `solution_unique_name` is sent via the `MSCRM.SolutionUniqueName` header. Index build is async — caller polls `list_entity_keys` for `entity_key_index_status: Active` before relying on the key for keyed-PATCH upserts.
  - `delete_entity_key(entity_logical_name, key_logical_name)` — `DELETE EntityDefinitions(...)/Keys(...)`. Gated behind `DATAVERSE_ALLOW_DELETE=true`, same pattern as `delete_attribute` and `delete_picklist_option` (disabled stub keeps the input schema identical so the tool surface stays stable across flag states).

### Use case

Enables race-safe upserts on custom Dataverse tables: define a natural/composite key (e.g. `contact + provider + period`), then use Dataverse's keyed-PATCH semantics for atomic insert-or-update without a preceding SELECT. Previously the only path was manual key creation in Power Apps Maker.

## [0.3.1] - 2026-04-25

### Fixed

- `get_attribute_dependencies`: a missing entity or attribute now surfaces as the friendly `Attribute not found: <entity>.<attribute>` error instead of the raw `Dataverse API error (404): ...` (#30).

### Changed

- CI: npm publish is now automated via a GitHub Actions release workflow that triggers on GitHub Release publication. Guards verify that the release tag matches `package.json` version and that `CHANGELOG.md` has a matching section before running lint/test/build and publishing with npm provenance (#31).

## [0.3.0] - 2026-04-25

### Added

- New tool `get_attribute_dependencies` (closes #27): list CRM components (forms, views, workflows, business rules, plugins, …) that reference a given attribute. Use after `delete_attribute` fails with error 0x8004f01f, or proactively before any destructive change. Returns a flat array of `{ component_type, component_type_name, object_id, name }`.

### Implementation

- Backed by the Dataverse `RetrieveDependenciesForDelete` function with `ComponentType=2` (Attribute).
- Hand-curated `componenttype` int → friendly name table covers the 30+ types most likely to surface for attributes; unknown ints fall back to `ComponentType_<N>` so callers still see the raw value.
- Best-effort name resolution: dependencies are grouped by component type and resolved in parallel batches against their respective entity sets (`systemforms`, `savedqueries`, `workflows`, `reports`, `webresourceset`, `fieldsecurityprofiles`, `appmodules`, `sdkmessageprocessingsteps`). One HTTP call per dependent type, not per dependency. Component types without a resolver (e.g. AppModule sub-types, niche types) keep `name: null`.

### Design note

An earlier iteration of this PR returned a Power Apps maker UI deep-link instead of a structured listing. That approach turned out unworkable: the URL pattern requires the Power Platform **EnvironmentId**, which is distinct from the Dataverse **OrganizationId** returned by `/WhoAmI`, and getting EnvironmentId requires a separate Power Platform Admin API with different OAuth scopes. Pivoted to the structured listing approach which is fully self-contained within the existing Dataverse Web API auth.

## [0.2.0] - 2026-04-24

### Added

- `add_attribute` and `update_attribute` accept two new optional fields for `DateTime` attributes (closes #24):
  - `date_format`: `"DateOnly" | "DateAndTime"` — controls UI presentation (calendar-only vs date+time picker). Maps to `Format` in the OData body.
  - `date_behavior`: `"UserLocal" | "DateOnly" | "TimeZoneIndependent"` — controls storage/projection semantics. Maps to `DateTimeBehavior: { Value: ... }` (wrapped form is a Dataverse gotcha).
- Client-side validation before any HTTP call:
  - `date_format: "DateOnly"` requires `date_behavior: "DateOnly"` — mismatched pairs rejected with a clear message.
  - `date_format` / `date_behavior` on a non-DateTime type rejected.
- Tool descriptions surface the one-way nature of Dataverse `DateTimeBehavior` mutations so the model warns users before calling `update_attribute` on a behavior-locked column.

### Why minor bump (0.2.0, not 0.1.3)

`AttributeSchema` gained two public fields — new schema surface exposed to MCP clients. Strict semver reads this as a minor addition, not a patch. Backward compatible: existing `add_attribute` / `update_attribute` calls without the new fields behave identically to 0.1.x.

## [0.1.2] - 2026-04-24

### Added

- Shields.io badges in README (npm version, monthly downloads, CI status, Node.js engines, TypeScript version, license). They update automatically as the package evolves — no manual version tweaks.

## [0.1.1] - 2026-04-24

### Added

- `CHANGELOG.md` — this file. Starts tracking release-by-release changes going forward; the 0.1.0 entry below is a retroactive summary of what shipped in the initial publish.

## [0.1.0] - 2026-04-24

Initial public release on npm as `@rededis/dataverse-mcp-server`.

### Added

#### Data operations

- `list_entities` — list Dataverse tables, with optional prefix and solution filters
- `list_solutions` — list available Dataverse solutions (use `uniquename` to filter `list_entities`)
- `get_entity_schema` — read attributes (columns) of a specific table
- `query_records` — OData queries with `$filter`, `$select`, `$top`, `$orderby`, `$expand`
- `get_record` — fetch a single record by GUID
- `create_record` — insert a new record
- `update_record` — update an existing record (PATCH)
- `delete_record` — delete a record (gated behind `DATAVERSE_ALLOW_DELETE`)

#### Schema operations

- `create_entity` — create a new Dataverse table with primary-name attribute and optional additional columns
- `add_attribute` — add a new column to an existing table (String, Integer, BigInt, Decimal, Double, Money, DateTime, Uniqueidentifier, Memo, Boolean, Picklist)
- `update_attribute` — update column metadata (display name, description, required level, bounds, precision); supports `MSCRM.MergeLabels` for localized-label merging
- `delete_attribute` — permanently delete a column (gated behind `DATAVERSE_ALLOW_DELETE`)
- `create_relationship` — create 1:N or N:N relationships between tables

#### Picklist option management

- `get_picklist_options` — read options as a flat `[{ value, label }]` list, for both Local and Global OptionSets
- `add_picklist_option` — append a new option (`InsertOptionValue` action)
- `update_picklist_option` — rename an existing option (`UpdateOptionValue` action)
- `delete_picklist_option` — remove an option (`DeleteOptionValue` action, gated behind `DATAVERSE_ALLOW_DELETE`)

All picklist tools accept either `entity_logical_name` + `attribute_logical_name` (Local OptionSet) or `option_set_name` (Global OptionSet) — the two modes are mutually exclusive.

#### Configuration

- `DATAVERSE_TENANT_ID`, `DATAVERSE_CLIENT_ID`, `DATAVERSE_CLIENT_SECRET`, `DATAVERSE_RESOURCE_URL` — required
- `DATAVERSE_ENTITY_PREFIX` — optional, default logical-name prefix filter for `list_entities`
- `DATAVERSE_SOLUTION_NAME` — optional, default solution filter for `list_entities`
- `DATAVERSE_ALLOW_DELETE` — optional, unlocks `delete_record`, `delete_attribute`, and `delete_picklist_option` (all destructive operations are disabled by default)

### Safety

- All three destructive tools (`delete_record`, `delete_attribute`, `delete_picklist_option`) are registered as instructional stubs when `DATAVERSE_ALLOW_DELETE` is not set, preventing accidental data loss without explicit opt-in.

### Notes

- Requires Node.js 18+
- Uses `@modelcontextprotocol/sdk` ^1.12.1
- Dataverse Web API v9.2 with OAuth 2.0 client-credentials authentication
- Supports `@odata.nextLink` pagination for large solutions

[Unreleased]: https://github.com/rededis/dataverse-mcp-server/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/rededis/dataverse-mcp-server/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/rededis/dataverse-mcp-server/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rededis/dataverse-mcp-server/releases/tag/v0.1.0
