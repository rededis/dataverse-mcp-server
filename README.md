# dataverse-mcp-server

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
| `create_relationship` | Create relationships between tables (1:N, N:N) |

> Dataverse does **not** allow changing a column's logical name or type. To "rename" or change type: create a new column, migrate data via `update_record`, then `delete_attribute` on the old one.

### Picklist option management
| Tool | Description |
|------|-------------|
| `get_picklist_options` | Read options of a Local or Global OptionSet as `[{ value, label }]` |
| `add_picklist_option` | Add an option to an existing OptionSet (`InsertOptionValue`) |
| `update_picklist_option` | Rename an option on an OptionSet (`UpdateOptionValue`) |
| `delete_picklist_option` | Remove an option from an OptionSet (`DeleteOptionValue`) |

Picklist tools accept either `entity_logical_name` + `attribute_logical_name` (Local OptionSet) or `option_set_name` (Global OptionSet) — the two modes are mutually exclusive. Write operations require Customizer or System Administrator role on the connected service principal. Deleting an option does **not** update existing records that hold its numeric value — they are left with an orphan integer.

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

### Claude Code configuration

Add `.mcp.json` to your project root:

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

Destructive operations are **disabled by default** to prevent accidental data loss. Both `delete_record` (removes rows) and `delete_attribute` (removes columns and ALL data stored in them — no recovery) are gated behind the same flag: they register as stubs that return an error message explaining how to enable them.

To enable, add `DATAVERSE_ALLOW_DELETE=true` to your `.env` file and restart the MCP server.

## License

MIT
