# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-04-25

### Added

- New tool `get_attribute_dependencies_list_url` (closes #27): returns a Power Apps maker UI URL for an attribute. Use after `delete_attribute` fails with error 0x8004f01f, or proactively before any destructive change. The URL points to the field details page in Power Apps maker; from there a single "Show dependencies" click yields the rich dependency graph (forms, views, workflows, business rules, calculated columns, …) with in-place edit links per dependency.

### Notes on the URL-only approach

A full programmatic dependency-listing tool (parsing `RetrieveDependenciesForDelete`, mapping component-type integers, resolving names per type) would be ~150 lines and require a hand-maintained component-type enum. The link-only design solves the practical problem with ~30 lines: every workflow path that needed deps ended in "go to maker UI to edit them" anyway, so the JSON intermediate offered little real value. If a programmatic listing turns out useful for automation later, it can be a follow-up additive tool.

### Implementation

- The OrganizationId required for the maker URL is fetched from `/WhoAmI` once per process and cached at module scope.
- Entity and attribute MetadataIds are fetched in parallel with the cached OrganizationId via `Promise.all`.

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

[Unreleased]: https://github.com/rededis/dataverse-mcp-server/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rededis/dataverse-mcp-server/releases/tag/v0.1.0
