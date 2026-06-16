# dataverse-mcp-server

[![npm version](https://img.shields.io/npm/v/@rededis/dataverse-mcp-server.svg)](https://www.npmjs.com/package/@rededis/dataverse-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@rededis/dataverse-mcp-server.svg)](https://www.npmjs.com/package/@rededis/dataverse-mcp-server)
[![CI](https://github.com/rededis/dataverse-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/rededis/dataverse-mcp-server/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@rededis/dataverse-mcp-server.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP (Model Context Protocol) server for Microsoft Dataverse API with [safe-by-default](#safety) configuration. Works with any Dataverse / Dynamics 365 environment.

## Tools

### Data operations
| Tool | Description |
|------|-------------|
| `list_entities` | List Dataverse tables with optional prefix and solution filters |
| `list_solutions` | List Dataverse solutions (use `uniquename` to filter `list_entities`) |
| `get_entity_schema` | Get attributes of a specific table |
| `query_records` | Query records with OData $filter, $select, $top, $orderby, $expand |
| `get_record` | Get a single record by ID |
| `create_record` | Create a record |
| `update_record` | Update a record |
| `delete_record` | Delete a record (disabled by default, see [Safety](#safety)) |

> Note: `solution` / `DATAVERSE_SOLUTION_NAME` only scopes `list_entities` (schema browsing). Data tools (`query_records`, `get_record`, `create_record`, …) keep full access to any table regardless of solution membership — shared tables like `account` or `contact` remain reachable.

### Schema operations
| Tool | Description |
|------|-------------|
| `create_entity` | Create a new table with attributes |
| `add_attribute` | Add a column to an existing table |
| `update_attribute` | Update column metadata (display name, required level, bounds, …) |
| `delete_attribute` | Delete a column (disabled by default, see [Safety](#safety)) |
| `get_attribute_dependencies` | List CRM components (forms, views, workflows, …) that reference a column — use after `delete_attribute` fails with 0x8004f01f |
| `create_relationship` | Create relationships between tables (1:N, N:N) |
| `list_entity_keys` | List alternate keys on a table (returns `key_attributes`, `entity_key_index_status`, …) |
| `add_entity_key` | Create an alternate key (single or composite) — enables race-safe keyed-PATCH upserts |
| `delete_entity_key` | Delete an alternate key and its supporting unique index (disabled by default, see [Safety](#safety)) |

> Dataverse does **not** allow changing a column's logical name or type. To "rename" or change type: create a new column, migrate data via `update_record`, then `delete_attribute` on the old one.

### Picklist option management
| Tool | Description |
|------|-------------|
| `get_picklist_options` | Read options of a Local or Global OptionSet as `[{ value, label }]` |
| `add_picklist_option` | Add an option to an existing OptionSet (`InsertOptionValue`) |
| `update_picklist_option` | Rename an option on an OptionSet (`UpdateOptionValue`) |
| `delete_picklist_option` | Remove an option from an OptionSet (`DeleteOptionValue`) |

Picklist tools accept either `entity_logical_name` + `attribute_logical_name` (Local OptionSet) or `option_set_name` (Global OptionSet) — the two modes are mutually exclusive. Write operations require Customizer or System Administrator role on the connected service principal. Deleting an option does **not** update existing records that hold its numeric value — they are left with an orphan integer.

### Actions & functions
| Tool | Description |
|------|-------------|
| `invoke_action` | Invoke a Web API **action** (POST), bound or unbound — for operations outside plain CRUD (e.g. `PublishDuplicateRule`, `QualifyLead`) |
| `invoke_function` | Invoke a Web API **function** (GET), bound or unbound — read-only operations exposed as functions (e.g. `WhoAmI`) |

Pass `entity_set` + `id` for a **bound** call (`POST /<entity_set>(<id>)/Microsoft.Dynamics.CRM.<name>`); omit both for an **unbound** call (`POST /<name>`). For `invoke_action`, `parameters` is the JSON request body; for `invoke_function`, `parameters` is inlined as OData function arguments. Bare operation names are namespaced automatically for bound calls — pass a fully-qualified name to override.

Examples:

```jsonc
// Publish a draft duplicate-detection rule.
// PublishDuplicateRule is a BOUND action on duplicaterule (returns an async job).
invoke_action({ name: "PublishDuplicateRule", entity_set: "duplicaterules", id: "<guid>" })

// Unpublish is an UNBOUND action taking DuplicateRuleId — note the asymmetry.
invoke_action({ name: "UnpublishDuplicateRule", parameters: { DuplicateRuleId: "<guid>" } })

// Qualify a lead into Account/Contact/Opportunity (bound action on lead).
invoke_action({ name: "QualifyLead", entity_set: "leads", id: "<guid>",
                parameters: { CreateAccount: true, CreateContact: true, CreateOpportunity: true, Status: 3 } })
```

> Whether an operation is bound or unbound is defined in the Web API `$metadata`, not by intuition — e.g. `PublishDuplicateRule` is bound but `UnpublishDuplicateRule` is unbound. Check `$metadata` (look for `IsBound="true"` and the binding `Parameter`) if a call returns `404 "Resource not found for the segment"`.

> ⚠️ `invoke_action` can perform arbitrary mutating operations. It is currently **ungated** by design; capability-based access control (a safe-by-default policy gating writes/actions) is tracked separately in [#45 / #46](https://github.com/rededis/dataverse-mcp-server/issues/45). `invoke_function` is read-only.

## Quick start (no clone)

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "dataverse": {
      "command": "npx",
      "args": ["-y", "@rededis/dataverse-mcp-server"]
    }
  }
}
```

Create a `.env` file next to it with the four required variables (see [Environment variables](#environment-variables) below) and restart your MCP client. The `-y` flag tells `npx` to auto-confirm the package install.

## Setup

### Environment variables

```
DATAVERSE_TENANT_ID=your-azure-tenant-id
DATAVERSE_CLIENT_ID=your-app-registration-client-id
DATAVERSE_CLIENT_SECRET=your-client-secret
DATAVERSE_RESOURCE_URL=https://your-org.crm.dynamics.com
DATAVERSE_ENTITY_PREFIX=contoso_          # optional, default prefix filter for list_entities
DATAVERSE_SOLUTION_NAME=MySolution        # optional, default solution unique name for list_entities
DATAVERSE_ALLOW_DELETE=true               # optional, enable delete operations (disabled by default)
```

### Azure App Registration

1. Register an app in Azure AD
2. Add API permission: **Dynamics CRM > user_impersonation** (or Application permissions)
3. Create a client secret
4. Grant the app a security role in Dataverse (e.g. System Administrator for full access)

### Build

```bash
npm install
npm run build
```

### Claude Code configuration (local build)

If you cloned the repo instead of using `npx`:

```json
{
  "mcpServers": {
    "dataverse": {
      "command": "node",
      "args": ["./dist/index.js"]
    }
  }
}
```

Create a `.env` file with your credentials (see `.env.example`).

## Safety

Destructive operations are **disabled by default** to prevent accidental data loss. All four delete tools are gated behind the same `DATAVERSE_ALLOW_DELETE=true` flag:
- `delete_record` — removes a row and all its data
- `delete_attribute` — removes a column along with ALL values across every record (no recovery short of a full environment restore)
- `delete_picklist_option` — removes an option from an OptionSet; records that hold the option's integer value are left with an orphan number (no label in UI, broken reports)
- `delete_entity_key` — drops an alternate key and its supporting unique index; any keyed-PATCH upsert flows relying on it stop working

When the flag is off, each tool registers as a stub that returns an instructional error instead of performing the delete. To enable, add `DATAVERSE_ALLOW_DELETE=true` to your `.env` file and restart the MCP server.

## License

MIT
