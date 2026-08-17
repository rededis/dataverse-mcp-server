import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";
import {
  CHOICE_ATTRIBUTE_CASTS,
  fetchChoiceAttributesSettled,
  OPTION_SET_EXPAND,
  type OptionSetSummary,
  summarizeOptionSet,
} from "./optionset-utils.js";

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

const ENTITY_DEFINITION_SELECT =
  "LogicalName,DisplayName,EntitySetName,Description,IsCustomEntity";

interface EntityDefinitionRow {
  LogicalName?: string;
}

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

      // Prefix filtering happens client-side on every path. Metadata entities do
      // not support `startswith` at all — sending it returns HTTP 501
      // `0x8006088a: The "startswith" function isn't supported for Metadata
      // Entities`, not only when combined with `or` as previously believed. One
      // rule for both branches, so they cannot disagree about where it applies.
      const filterByPrefix = (entities: EntityDefinitionRow[]) =>
        effectivePrefix
          ? entities.filter((e) => e.LogicalName?.startsWith(effectivePrefix))
          : entities;

      const asJson = (entities: EntityDefinitionRow[]) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(filterByPrefix(entities), null, 2),
          },
        ],
      });

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
        const entities: EntityDefinitionRow[] = [];
        for (let i = 0; i < entityIds.length; i += METADATA_ID_CHUNK_SIZE) {
          const chunk = entityIds.slice(i, i + METADATA_ID_CHUNK_SIZE);
          const query = buildODataQuery({
            $select: ENTITY_DEFINITION_SELECT,
            $filter: `(${chunk.map((id) => `MetadataId eq ${id}`).join(" or ")})`,
          });
          entities.push(
            ...(await fetchAllPages<EntityDefinitionRow>(
              client,
              `/EntityDefinitions${query}`,
            )),
          );
        }
        return asJson(entities);
      }

      // Paged, like the /solutions and /solutioncomponents reads above. A live
      // org returns all 2078 definitions in one response with no @odata.nextLink,
      // but the prefix is now applied to whatever comes back, so completeness is
      // load-bearing — worth not resting on an unwritten platform guarantee.
      // (The attribute reads further down are still unpaged; they are scoped to
      // one table and predate this.)
      const query = buildODataQuery({ $select: ENTITY_DEFINITION_SELECT });
      return asJson(
        await fetchAllPages<EntityDefinitionRow>(
          client,
          `/EntityDefinitions${query}`,
        ),
      );
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
    "Get attributes (columns) of a specific Dataverse table. Choice-style columns (Choice, Status, State, MultiSelect) carry an option_set summary with is_global and option_count, so one dump shows which choice lists are shared org-wide. Read the option values per column with get_picklist_options.",
    {
      entity_logical_name: z
        .string()
        .describe(
          "Logical name of the entity (e.g. 'account', 'contact', 'contoso_bankaccount')",
        ),
    },
    async ({ entity_logical_name }) => {
      const escaped = escapeODataString(entity_logical_name);
      const attributesPath = `/EntityDefinitions(LogicalName='${escaped}')/Attributes`;
      const query = buildODataQuery({
        $select:
          "LogicalName,AttributeType,DisplayName,RequiredLevel,IsCustomAttribute,Description",
      });
      // OptionSet cannot be expanded on the plain /Attributes collection — it is
      // declared on a derived type — so the choice columns are fetched separately
      // through type casts and merged onto the base rows by LogicalName.
      const optionSetQuery = buildODataQuery({
        $select: "LogicalName",
        $expand: OPTION_SET_EXPAND,
      });
      // The base attribute list is this tool's actual contract; the OptionSet
      // lookups only enrich it. A failure in one of the four cast requests must not
      // cost the caller the column list, so the fan-out degrades instead of
      // rejecting — but any degradation is reported, because a silently missing
      // option_set would read as "this column has no options".
      const [base, choice] = await Promise.all([
        client.get(`${attributesPath}${query}`) as Promise<{
          value: Array<Record<string, unknown>>;
        }>,
        fetchChoiceAttributesSettled(client, attributesPath, optionSetQuery),
      ]);

      const summaries = new Map<string, OptionSetSummary>();
      // A row that matched a choice cast but came back without its OptionSet is
      // reported, not skipped. Skipping would leave the column with no
      // option_set at all — indistinguishable from a non-choice column, which is
      // an answer, and the wrong one.
      const unresolved: string[] = [];
      for (const attr of choice.rows) {
        if (attr.OptionSet) {
          summaries.set(attr.LogicalName, summarizeOptionSet(attr.OptionSet));
        } else {
          unresolved.push(attr.LogicalName);
        }
      }
      // Options are fetched but deliberately not returned: a table like account has
      // dozens of choice columns, and inlining every option list would blow past the
      // tool-result size limit. Only the count travels back.
      const attributes = base.value.map((attr) => {
        const summary = summaries.get(attr.LogicalName as string);
        return summary ? { ...attr, option_set: summary } : attr;
      });

      // The JSON stays in content[0] so callers can keep parsing the first block.
      const content = [
        { type: "text" as const, text: JSON.stringify(attributes, null, 2) },
      ];
      if (choice.failed.length > 0 || unresolved.length > 0) {
        const reasons: string[] = [];
        if (choice.failed.length > 0) {
          reasons.push(
            `${choice.failed.length} of ${CHOICE_ATTRIBUTE_CASTS.length} choice-column lookups failed:`,
            ...choice.failed.map((f) => `  - ${f.cast}: ${f.message}`),
          );
        }
        if (unresolved.length > 0) {
          // Blank line between the two blocks when both are present, so the
          // lists do not read as one.
          if (reasons.length > 0) reasons.push("");
          reasons.push(
            `${unresolved.length} choice column(s) returned no OptionSet:`,
            ...unresolved.map((name) => `  - ${name}`),
          );
        }
        content.push({
          type: "text" as const,
          text: [
            "[IMPORTANT: Display this entire message to the user exactly as-is.]",
            "",
            `⚠️ OptionSet data for ${entity_logical_name} is INCOMPLETE.`,
            "",
            ...reasons,
            "",
            "The affected columns carry no option_set summary. Do NOT read a missing option_set as 'this column has no options' — for those columns the answer is unknown, not negative.",
            "",
            "Re-run get_entity_schema to retry, or read a specific column with get_picklist_options.",
          ].join("\n"),
        });
      }

      return { content };
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
      "Delete a record from a Dataverse table (currently disabled for safety)",
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
