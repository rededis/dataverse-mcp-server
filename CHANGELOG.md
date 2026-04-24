# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/rededis/dataverse-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rededis/dataverse-mcp-server/releases/tag/v0.1.0
