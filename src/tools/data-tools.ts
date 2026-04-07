import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";

export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildODataQuery(
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function registerDataTools(
  server: McpServer,
  client: DataverseClient,
  defaultPrefix?: string,
): void {
  server.tool(
    "list_entities",
    "List Dataverse tables (entities) with optional prefix filter",
    {
      prefix: z
        .string()
        .optional()
        .describe(
          "Filter entities by logical name prefix (e.g. 'contoso_'). Uses DATAVERSE_ENTITY_PREFIX env if not specified.",
        ),
    },
    async ({ prefix }) => {
      const effectivePrefix = prefix ?? defaultPrefix;
      const params: Record<string, string | undefined> = {
        $select:
          "LogicalName,DisplayName,EntitySetName,Description,IsCustomEntity",
      };
      if (effectivePrefix) {
        params.$filter = `startswith(LogicalName,'${escapeODataString(effectivePrefix)}')`;
      }
      const query = buildODataQuery(params);
      const result = (await client.get(`/EntityDefinitions${query}`)) as {
        value: unknown[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.value, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "get_entity_schema",
    "Get attributes (columns) of a specific Dataverse table",
    {
      entity_logical_name: z
        .string()
        .describe(
          "Logical name of the entity (e.g. 'account', 'contact', 'contoso_bankaccount')",
        ),
    },
    async ({ entity_logical_name }) => {
      const escaped = escapeODataString(entity_logical_name);
      const query = buildODataQuery({
        $select:
          "LogicalName,AttributeType,DisplayName,RequiredLevel,IsCustomAttribute,Description",
      });
      const result = (await client.get(
        `/EntityDefinitions(LogicalName='${escaped}')/Attributes${query}`,
      )) as { value: unknown[] };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.value, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "query_records",
    "Query records from a Dataverse table with OData filters",
    {
      entity_set: z
        .string()
        .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
      select: z
        .string()
        .optional()
        .describe("Comma-separated list of columns to return ($select)"),
      filter: z
        .string()
        .optional()
        .describe("OData filter expression ($filter)"),
      top: z
        .number()
        .optional()
        .describe("Maximum number of records to return ($top)"),
      orderby: z.string().optional().describe("Order by expression ($orderby)"),
      expand: z
        .string()
        .optional()
        .describe("Related entities to expand ($expand)"),
    },
    async ({ entity_set, select, filter, top, orderby, expand }) => {
      const query = buildODataQuery({
        $select: select,
        $filter: filter,
        $top: top !== undefined ? top : undefined,
        $orderby: orderby,
        $expand: expand,
      });
      const result = (await client.get(`/${entity_set}${query}`)) as {
        value: unknown[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.value, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "get_record",
    "Get a single record by ID from a Dataverse table",
    {
      entity_set: z
        .string()
        .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
      id: z.string().describe("Record GUID"),
      select: z
        .string()
        .optional()
        .describe("Comma-separated list of columns to return ($select)"),
      expand: z
        .string()
        .optional()
        .describe("Related entities to expand ($expand)"),
    },
    async ({ entity_set, id, select, expand }) => {
      const query = buildODataQuery({ $select: select, $expand: expand });
      const result = await client.get(`/${entity_set}(${id})${query}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "create_record",
    "Create a new record in a Dataverse table",
    {
      entity_set: z
        .string()
        .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
      data: z
        .record(z.string(), z.unknown())
        .describe("Record fields as key-value pairs"),
    },
    async ({ entity_set, data }) => {
      const result = await client.post(`/${entity_set}`, data);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "update_record",
    "Update an existing record in a Dataverse table",
    {
      entity_set: z
        .string()
        .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
      id: z.string().describe("Record GUID"),
      data: z
        .record(z.string(), z.unknown())
        .describe("Fields to update as key-value pairs"),
    },
    async ({ entity_set, id, data }) => {
      await client.patch(`/${entity_set}(${id})`, data);
      return {
        content: [
          { type: "text" as const, text: `Record ${id} updated successfully.` },
        ],
      };
    },
  );

  server.tool(
    "delete_record",
    "Delete a record from a Dataverse table",
    {
      entity_set: z
        .string()
        .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
      id: z.string().describe("Record GUID"),
    },
    async ({ entity_set, id }) => {
      await client.delete(`/${entity_set}(${id})`);
      return {
        content: [
          { type: "text" as const, text: `Record ${id} deleted successfully.` },
        ],
      };
    },
  );
}
