# dataverse-mcp-server

MCP (Model Context Protocol) server for Microsoft Dataverse API. Works with any Dataverse / Dynamics 365 environment.

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
| `delete_record` | Delete a record |

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

Add to your Claude settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "dataverse": {
      "command": "node",
      "args": ["/path/to/dataverse-mcp-server/dist/index.js"],
      "env": {
        "DATAVERSE_TENANT_ID": "your-tenant-id",
        "DATAVERSE_CLIENT_ID": "your-client-id",
        "DATAVERSE_CLIENT_SECRET": "your-client-secret",
        "DATAVERSE_RESOURCE_URL": "https://your-org.crm.dynamics.com",
        "DATAVERSE_ENTITY_PREFIX": "contoso_"
      }
    }
  }
}
```

## License

MIT
