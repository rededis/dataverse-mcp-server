# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rededis/dataverse-mcp-server/compare/v0.7.1...HEAD
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
