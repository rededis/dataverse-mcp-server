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

const METADATA_ID_CHUNK_SIZE = 50;

async function fetchAllPages<T>(
  client: DataverseClient,
  path: string,
): Promise<T[]> {
  const results: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page = (await client.get(next)) as {
      value: T[];
      "@odata.nextLink"?: string;
    };
    results.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return results;
}

async function getEntityIdsInSolution(
  client: DataverseClient,
  solutionUniqueName: string,
): Promise<string[]> {
  const solutionsQuery = buildODataQuery({
    $select: "solutionid",
    $filter: `uniquename eq '${escapeODataString(solutionUniqueName)}'`,
  });
  const solutionsResult = (await client.get(`/solutions${solutionsQuery}`)) as {
    value: Array<{ solutionid: string }>;
  };
  if (solutionsResult.value.length === 0) {
    throw new Error(
      `Solution not found: '${solutionUniqueName}'. Use list_solutions to see available solutions.`,
    );
  }
  const solutionId = solutionsResult.value[0].solutionid;

  // componenttype = 1 is Entity (table)
  const componentsQuery = buildODataQuery({
    $select: "objectid",
    $filter: `_solutionid_value eq ${solutionId} and componenttype eq 1`,
  });
  const components = await fetchAllPages<{ objectid: string }>(
    client,
    `/solutioncomponents${componentsQuery}`,
  );
  return components.map((c) => c.objectid);
}

export function registerDataTools(
  server: McpServer,
  client: DataverseClient,
  defaultPrefix?: string,
  allowDelete = false,
  defaultSolution?: string,
): void {
  server.tool(
    "list_entities",
    "List Dataverse tables (entities) with optional prefix and solution filters",
    {
      prefix: z
        .string()
        .optional()
        .describe(
          "Filter entities by logical name prefix (e.g. 'contoso_'). Uses DATAVERSE_ENTITY_PREFIX env if not specified.",
        ),
      solution: z
        .string()
        .optional()
        .describe(
          "Filter entities by solution unique name (e.g. 'MySolution'). Uses DATAVERSE_SOLUTION_NAME env if not specified. Pass an empty string to disable the default filter.",
        ),
    },
    async ({ prefix, solution }) => {
      const effectivePrefix = prefix ?? defaultPrefix;
      const effectiveSolution =
        solution === undefined ? defaultSolution : solution || undefined;

      const filterParts: string[] = [];

      if (effectiveSolution) {
        const entityIds = await getEntityIdsInSolution(
          client,
          effectiveSolution,
        );
        if (entityIds.length === 0) {
          return {
            content: [{ type: "text" as const, text: "[]" }],
          };
        }
        // Dataverse Metadata entities reject `startswith` combined with `or`,
        // so prefix is applied client-side when a solution filter is active.
        const entities: Array<{ LogicalName?: string }> = [];
        for (let i = 0; i < entityIds.length; i += METADATA_ID_CHUNK_SIZE) {
          const chunk = entityIds.slice(i, i + METADATA_ID_CHUNK_SIZE);
          const query = buildODataQuery({
            $select:
              "LogicalName,DisplayName,EntitySetName,Description,IsCustomEntity",
            $filter: `(${chunk.map((id) => `MetadataId eq ${id}`).join(" or ")})`,
          });
          const result = (await client.get(`/EntityDefinitions${query}`)) as {
            value: Array<{ LogicalName?: string }>;
          };
          entities.push(...result.value);
        }
        const filtered = effectivePrefix
          ? entities.filter((e) => e.LogicalName?.startsWith(effectivePrefix))
          : entities;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(filtered, null, 2) },
          ],
        };
      }

      if (effectivePrefix) {
        filterParts.push(
          `startswith(LogicalName,'${escapeODataString(effectivePrefix)}')`,
        );
      }
      const params: Record<string, string | undefined> = {
        $select:
          "LogicalName,DisplayName,EntitySetName,Description,IsCustomEntity",
      };
      if (filterParts.length > 0) {
        params.$filter = filterParts.join(" and ");
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
    "list_solutions",
    "List Dataverse solutions (uniquename is used to filter list_entities)",
    {
      include_managed: z
        .boolean()
        .optional()
        .describe(
          "Include managed solutions (default: false — only unmanaged are returned)",
        ),
    },
    async ({ include_managed }) => {
      const filters = ["isvisible eq true"];
      if (!include_managed) filters.push("ismanaged eq false");
      const query = buildODataQuery({
        $select: "solutionid,uniquename,friendlyname,version,ismanaged",
        $filter: filters.join(" and "),
        $orderby: "friendlyname",
      });
      const solutions = await fetchAllPages<unknown>(
        client,
        `/solutions${query}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(solutions, null, 2),
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

  if (allowDelete) {
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
            {
              type: "text" as const,
              text: `Record ${id} deleted successfully.`,
            },
          ],
        };
      },
    );
  } else {
    server.tool(
      "delete_record",
      "Delete a record from a Dataverse table (currently disabled)",
      {
        entity_set: z.string().describe("Entity set name"),
        id: z.string().describe("Record GUID"),
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: [
              "[IMPORTANT: Display this entire message to the user exactly as-is.]",
              "",
              "⚠️ Delete operations are disabled by default for safety.",
              "",
              "To enable, add DATAVERSE_ALLOW_DELETE=true to your .env file and restart the MCP server.",
            ].join("\n"),
          },
        ],
        isError: true,
      }),
    );
  }
}
