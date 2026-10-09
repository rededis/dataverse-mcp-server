import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { DataverseClient } from "../client.js";
import { isNotFound } from "../errors.js";
import {
  buildODataQuery,
  escapeODataString,
  fetchAllPages,
} from "./shared/odata.js";
import {
  CHOICE_ATTRIBUTE_CASTS,
  fetchChoiceAttributes,
  fetchChoiceAttributesSettled,
  flattenOption,
  flattenOptionSet,
  globalOptionSetNotFound,
  OPTION_SET_EXPAND,
  OPTION_SET_IDENTITY_SELECT,
  type OptionSetSummary,
  type RawOptionSet,
  summarizeOptionSet,
} from "./shared/optionset.js";
import { assertLogicalName } from "./shared/paths.js";
import {
  LOCATION_INPUT,
  validatePicklistLocation,
} from "./shared/picklist-location.js";
import type { ToolDeps } from "./types.js";

const METADATA_ID_CHUNK_SIZE = 50;

const ENTITY_DEFINITION_SELECT =
  "LogicalName,DisplayName,EntitySetName,Description,IsCustomEntity";

interface EntityDefinitionRow {
  LogicalName?: string;
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

const LIST_ENTITIES_INPUT = z.object({
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
});

const GET_ENTITY_SCHEMA_INPUT = z.object({
  entity_logical_name: z
    .string()
    .describe(
      "Logical name of the entity (e.g. 'account', 'contact', 'contoso_bankaccount')",
    ),
});

const LIST_ENTITY_KEYS_INPUT = z.object({
  entity_logical_name: z.string().describe("Logical name of the entity"),
});

export function registerMetadataReadTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const {
    client,
    entityPrefix: defaultPrefix,
    solutionName: defaultSolution,
  } = deps;
  server.registerTool(
    "list_entities",
    {
      description:
        "List Dataverse tables (entities) with optional prefix and solution filters",
      inputSchema: LIST_ENTITIES_INPUT,
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

      // Paged, like the /solutioncomponents read above and list_solutions. A live
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

  server.registerTool(
    "get_entity_schema",
    {
      description:
        "Get attributes (columns) of a specific Dataverse table. Choice-style columns (Choice, Status, State, MultiSelect) carry an option_set summary with is_global and option_count, so one dump shows which choice lists are shared org-wide. Read the option values per column with get_picklist_options.",
      inputSchema: GET_ENTITY_SCHEMA_INPUT,
    },
    async ({ entity_logical_name }) => {
      assertLogicalName(entity_logical_name, "entity logical name");
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

  server.registerTool(
    "get_picklist_options",
    {
      description:
        "Read a Local or Global OptionSet as { option_set: { name, is_global, metadata_id }, options: [{ value, label }] }. Use is_global to tell whether a column holds a local copy of the values or is bound to a shared Global OptionSet — matching values alone do not prove a binding. Works for Choice, Status, State and MultiSelect columns.",
      inputSchema: LOCATION_INPUT,
    },
    async (params) => {
      validatePicklistLocation(params);
      let optionSet: RawOptionSet;
      if (params.option_set_name) {
        assertLogicalName(params.option_set_name, "option set name");
        const escaped = escapeODataString(params.option_set_name);
        const query = buildODataQuery({
          $select: `${OPTION_SET_IDENTITY_SELECT},Options`,
        });
        // Dataverse rejects $filter on /GlobalOptionSetDefinitions (405), so address by alternate key (Name).
        // Cast to OptionSetMetadata — Options lives on the derived type, not the base GlobalOptionSetDefinition.
        try {
          optionSet = (await client.get(
            `/GlobalOptionSetDefinitions(Name='${escaped}')/Microsoft.Dynamics.CRM.OptionSetMetadata${query}`,
          )) as RawOptionSet;
        } catch (err) {
          if (isNotFound(err)) {
            throw globalOptionSetNotFound(params.option_set_name);
          }
          throw err;
        }
      } else {
        // validatePicklistLocation guarantees both are present when option_set_name is absent
        const entity = params.entity_logical_name ?? "";
        const attr = params.attribute_logical_name ?? "";
        assertLogicalName(entity, "entity logical name");
        assertLogicalName(attr, "attribute logical name");
        const entityEscaped = escapeODataString(entity);
        const attrEscaped = escapeODataString(attr);
        const query = buildODataQuery({
          $filter: `LogicalName eq '${attrEscaped}'`,
          $select: "LogicalName",
          $expand: OPTION_SET_EXPAND,
        });
        const rows = await fetchChoiceAttributes(
          client,
          `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes`,
          query,
        );
        if (rows.length === 0) {
          throw new Error(
            `Choice attribute not found: ${entity}.${attr} — no Choice, Status, State or MultiSelect column with that logical name`,
          );
        }
        // Not defaulted to {}: an absent OptionSet would flatten to
        // is_global: false, reporting a local set with full confidence on data that
        // never arrived. is_global is the entire point of this tool, so an unknown
        // answer has to fail rather than guess.
        if (!rows[0].OptionSet) {
          throw new Error(
            `OptionSet metadata missing for ${entity}.${attr} — cannot tell whether it is Local or Global`,
          );
        }
        optionSet = rows[0].OptionSet;
      }
      const payload = {
        option_set: flattenOptionSet(optionSet),
        options: (optionSet.Options ?? []).map(flattenOption),
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "list_entity_keys",
    {
      description:
        "List alternate keys defined on a Dataverse table. Returns a flat array of { logical_name, schema_name, display_name, key_attributes, entity_key_index_status, metadata_id }. entity_key_index_status reflects the background index build (Pending → Active, or Failed) — alt keys are not usable for keyed-PATCH upserts until Active.",
      inputSchema: LIST_ENTITY_KEYS_INPUT,
    },
    async ({ entity_logical_name }) => {
      assertLogicalName(entity_logical_name, "entity logical name");
      const entityEscaped = escapeODataString(entity_logical_name);
      let result: {
        value: Array<{
          LogicalName?: string;
          SchemaName?: string;
          DisplayName?: {
            UserLocalizedLabel?: { Label?: string };
            LocalizedLabels?: Array<{ Label?: string }>;
          };
          KeyAttributes?: string[];
          EntityKeyIndexStatus?: string;
          MetadataId?: string;
        }>;
      };
      try {
        result = (await client.get(
          `/EntityDefinitions(LogicalName='${entityEscaped}')/Keys`,
        )) as typeof result;
      } catch (err) {
        if (isNotFound(err)) {
          throw new Error(`Entity not found: ${entity_logical_name}`);
        }
        throw err;
      }

      const flat = (result.value ?? []).map((k) => ({
        logical_name: k.LogicalName ?? null,
        schema_name: k.SchemaName ?? null,
        display_name:
          k.DisplayName?.UserLocalizedLabel?.Label ??
          k.DisplayName?.LocalizedLabels?.[0]?.Label ??
          null,
        key_attributes: k.KeyAttributes ?? [],
        entity_key_index_status: k.EntityKeyIndexStatus ?? null,
        metadata_id: k.MetadataId ?? null,
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(flat, null, 2) },
        ],
      };
    },
  );
}
