import { z } from "zod";
import { buildODataQuery } from "./shared/odata.js";
import { assertEntitySetName, assertRecordId } from "./shared/paths.js";
import type { ToolDeps, ToolRegistrar } from "./types.js";

const QUERY_RECORDS_INPUT = z.object({
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
});

const GET_RECORD_INPUT = z.object({
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
});

export function registerDataReadTools(
  server: ToolRegistrar,
  deps: ToolDeps,
): void {
  const { client, entitySets } = deps;
  server.registerTool(
    "query_records",
    {
      // Remove the one-page sentence when #193 lands.
      description:
        "Read records from a table (entity set) with optional OData select, filter, orderby, top and expand; returns a JSON array of records. Only one page comes back, up to 5000 rows by default, and a result that fills the page may be cut off, so before counting or summing narrow the query with filter until fewer rows come back; top only caps the rows returned. An unknown entity set or a bad OData expression is an error. To read one record by its id, use get_record.",
      inputSchema: QUERY_RECORDS_INPUT,
    },
    async ({ entity_set, select, filter, top, orderby, expand }) => {
      assertEntitySetName(entity_set);
      await entitySets?.assertExists(entity_set);
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
      description:
        "Read one record by its GUID from a table (entity set), optionally only the select columns and the expand relations; returns the record as JSON. An id that is not a GUID is refused before the request; a record that does not exist is a 404 error from Dataverse. To find records by their values rather than by id, use query_records.",
      inputSchema: GET_RECORD_INPUT,
    },
    async ({ entity_set, id, select, expand }) => {
      assertEntitySetName(entity_set);
      assertRecordId(id);
      await entitySets?.assertExists(entity_set);
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
