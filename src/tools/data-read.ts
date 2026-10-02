import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildODataQuery } from "./shared/odata.js";
import type { ToolDeps } from "./types.js";

const QUERY_RECORDS_SHAPE = {
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  select: z
    .string()
    .optional()
    .describe("Comma-separated list of columns to return ($select)"),
  filter: z.string().optional().describe("OData filter expression ($filter)"),
  top: z
    .number()
    .optional()
    .describe("Maximum number of records to return ($top)"),
  orderby: z.string().optional().describe("Order by expression ($orderby)"),
  expand: z
    .string()
    .optional()
    .describe("Related entities to expand ($expand)"),
};

const GET_RECORD_SHAPE = {
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
};

export function registerDataReadTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  server.registerTool(
    "query_records",
    {
      description: "Query records from a Dataverse table with OData filters",
      inputSchema: QUERY_RECORDS_SHAPE,
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

  server.registerTool(
    "get_record",
    {
      description: "Get a single record by ID from a Dataverse table",
      inputSchema: GET_RECORD_SHAPE,
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
}
