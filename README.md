# dataverse-mcp-server

MCP (Model Context Protocol) server for Microsoft Dataverse API with [safe-by-default](#safety) configuration. Works with any Dataverse / Dynamics 365 environment.

## Tools

### Data operations
| Tool | Description |
|------|-------------|
| `list_entities` | List Dataverse tables with optional prefix filter |
| `get_entity_schema` | Get attributes of a specific table |
| `query_records` | Query records with OData $filter, $select, $top, $orderby, $expand |
| `get_record` | Get a single record by ID |
| `create_record` | Create a record |
| `update_record` | Update a record |
| `delete_record` | Delete a record (disabled by default, see [Safety](#safety)) |

### Schema operations
| Tool | Description |
|------|-------------|
| `create_entity` | Create a new table with attributes |
| `add_attribute` | Add a column to an existing table |
| `create_relationship` | Create relationships between tables (1:N, N:N) |

## Setup

### Environment variables

```
DATAVERSE_TENANT_ID=your-azure-tenant-id
DATAVERSE_CLIENT_ID=your-app-registration-client-id
DATAVERSE_CLIENT_SECRET=your-client-secret
DATAVERSE_RESOURCE_URL=https://your-org.crm.dynamics.com
DATAVERSE_ENTITY_PREFIX=contoso_          # optional, default prefix filter for list_entities
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

Delete operations are **disabled by default** to prevent accidental data loss. The `delete_record` tool is registered but returns an error message explaining how to enable it.

To enable, add `DATAVERSE_ALLOW_DELETE=true` to your `.env` file and restart the MCP server.

## License

MIT
