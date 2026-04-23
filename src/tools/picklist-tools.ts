import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";
import { buildODataQuery, escapeODataString } from "./data-tools.js";

interface PicklistLocation {
  entity_logical_name?: string;
  attribute_logical_name?: string;
  option_set_name?: string;
}

function validatePicklistLocation(loc: PicklistLocation): void {
  const hasEntity = !!loc.entity_logical_name;
  const hasAttr = !!loc.attribute_logical_name;
  const hasGlobal = !!loc.option_set_name;

  if (hasGlobal && (hasEntity || hasAttr)) {
    throw new Error(
      "option_set_name (Global OptionSet) is mutually exclusive with entity_logical_name/attribute_logical_name (Local OptionSet).",
    );
  }
  if (!hasGlobal && !(hasEntity && hasAttr)) {
    throw new Error(
      "Provide either option_set_name (Global OptionSet) OR both entity_logical_name and attribute_logical_name (Local OptionSet).",
    );
  }
}

function buildLabel(label: string, languageCode: number) {
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    LocalizedLabels: [
      {
        "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
        Label: label,
        LanguageCode: languageCode,
      },
    ],
  };
}

function addLocationToBody(
  body: Record<string, unknown>,
  loc: PicklistLocation,
): void {
  if (loc.option_set_name) {
    body.OptionSetName = loc.option_set_name;
  } else {
    body.EntityLogicalName = loc.entity_logical_name;
    body.AttributeLogicalName = loc.attribute_logical_name;
  }
}

const LOCATION_SHAPE = {
  entity_logical_name: z
    .string()
    .optional()
    .describe(
      "Entity logical name (Local OptionSet; pair with attribute_logical_name). Mutually exclusive with option_set_name.",
    ),
  attribute_logical_name: z
    .string()
    .optional()
    .describe(
      "Picklist attribute logical name (Local OptionSet; pair with entity_logical_name). Mutually exclusive with option_set_name.",
    ),
  option_set_name: z
    .string()
    .optional()
    .describe(
      "Global OptionSet name. Mutually exclusive with entity_logical_name/attribute_logical_name.",
    ),
} as const;

interface OptionLabel {
  LocalizedLabels?: Array<{ Label?: string; LanguageCode?: number }>;
  UserLocalizedLabel?: { Label?: string; LanguageCode?: number };
}

interface RawOption {
  Value: number;
  Label?: OptionLabel;
}

function flattenOption(opt: RawOption): {
  value: number;
  label: string | null;
} {
  const label =
    opt.Label?.UserLocalizedLabel?.Label ??
    opt.Label?.LocalizedLabels?.[0]?.Label ??
    null;
  return { value: opt.Value, label };
}

export function registerPicklistTools(
  server: McpServer,
  client: DataverseClient,
): void {
  server.tool(
    "add_picklist_option",
    "Add an option to an existing Local or Global OptionSet (Dataverse InsertOptionValue action). Requires Customizer or System Administrator role; HTTP 403 otherwise.",
    {
      ...LOCATION_SHAPE,
      value: z
        .number()
        .int()
        .optional()
        .describe(
          "Explicit option value. Must fall within the publisher's customization prefix range (e.g. 909890XXX). If omitted, Dataverse assigns the next free value.",
        ),
      label: z.string().describe("UI label for the new option (e.g. 'Queued')"),
      language_code: z
        .number()
        .int()
        .optional()
        .describe("Language code for the label (default: 1033 = English)"),
      description: z.string().optional().describe("Optional description"),
      solution_unique_name: z
        .string()
        .optional()
        .describe("Solution unique name (defaults to the Default Solution)"),
    },
    async (params) => {
      validatePicklistLocation(params);
      const lang = params.language_code ?? 1033;
      const body: Record<string, unknown> = {
        Label: buildLabel(params.label, lang),
      };
      addLocationToBody(body, params);
      if (params.value !== undefined) body.Value = params.value;
      if (params.description) {
        body.Description = buildLabel(params.description, lang);
      }
      if (params.solution_unique_name) {
        body.SolutionUniqueName = params.solution_unique_name;
      }
      const result = await client.post("/InsertOptionValue", body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "update_picklist_option",
    "Update an existing option's label/description on a Local or Global OptionSet (Dataverse UpdateOptionValue action). Requires Customizer or System Administrator role.",
    {
      ...LOCATION_SHAPE,
      value: z.number().int().describe("Numeric value of the option to update"),
      label: z.string().describe("New UI label"),
      language_code: z
        .number()
        .int()
        .optional()
        .describe("Language code for the label (default: 1033)"),
      description: z.string().optional().describe("New description"),
      merge_labels: z
        .boolean()
        .optional()
        .describe(
          "If true, merge the new label with existing localized labels (other languages kept); if false (default), replace all localized labels with just the new one.",
        ),
      solution_unique_name: z
        .string()
        .optional()
        .describe("Solution unique name (defaults to the Default Solution)"),
    },
    async (params) => {
      validatePicklistLocation(params);
      const lang = params.language_code ?? 1033;
      const body: Record<string, unknown> = {
        Value: params.value,
        Label: buildLabel(params.label, lang),
        MergeLabels: params.merge_labels ?? false,
      };
      addLocationToBody(body, params);
      if (params.description) {
        body.Description = buildLabel(params.description, lang);
      }
      if (params.solution_unique_name) {
        body.SolutionUniqueName = params.solution_unique_name;
      }
      await client.post("/UpdateOptionValue", body);
      return {
        content: [
          {
            type: "text" as const,
            text: `Option ${params.value} updated successfully.`,
          },
        ],
      };
    },
  );

  server.tool(
    "delete_picklist_option",
    "Remove an option from a Local or Global OptionSet (Dataverse DeleteOptionValue action). WARNING: existing records that hold this integer value are NOT updated and will retain the now-orphan number — warn the user before deleting.",
    {
      ...LOCATION_SHAPE,
      value: z.number().int().describe("Numeric value of the option to remove"),
      solution_unique_name: z
        .string()
        .optional()
        .describe("Solution unique name (defaults to the Default Solution)"),
    },
    async (params) => {
      validatePicklistLocation(params);
      const body: Record<string, unknown> = { Value: params.value };
      addLocationToBody(body, params);
      if (params.solution_unique_name) {
        body.SolutionUniqueName = params.solution_unique_name;
      }
      await client.post("/DeleteOptionValue", body);
      return {
        content: [
          {
            type: "text" as const,
            text: `Option ${params.value} deleted successfully.`,
          },
        ],
      };
    },
  );

  server.tool(
    "get_picklist_options",
    "Read options of a Local or Global OptionSet as a flat [{ value, label }] list.",
    LOCATION_SHAPE,
    async (params) => {
      validatePicklistLocation(params);
      let options: RawOption[] = [];
      if (params.option_set_name) {
        const escaped = escapeODataString(params.option_set_name);
        const query = buildODataQuery({ $select: "Options" });
        // Dataverse rejects $filter on /GlobalOptionSetDefinitions (405), so address by alternate key (Name).
        // Cast to OptionSetMetadata — Options lives on the derived type, not the base GlobalOptionSetDefinition.
        let result: { Options?: RawOption[] };
        try {
          result = (await client.get(
            `/GlobalOptionSetDefinitions(Name='${escaped}')/Microsoft.Dynamics.CRM.OptionSetMetadata${query}`,
          )) as { Options?: RawOption[] };
        } catch (err) {
          if (err instanceof Error && /\b404\b/.test(err.message)) {
            throw new Error(
              `Global OptionSet not found: '${params.option_set_name}'`,
            );
          }
          throw err;
        }
        options = result.Options ?? [];
      } else {
        // validatePicklistLocation guarantees both are present when option_set_name is absent
        const entity = params.entity_logical_name ?? "";
        const attr = params.attribute_logical_name ?? "";
        const entityEscaped = escapeODataString(entity);
        const attrEscaped = escapeODataString(attr);
        const query = buildODataQuery({
          $filter: `LogicalName eq '${attrEscaped}'`,
          $select: "LogicalName",
          $expand: "OptionSet($select=Options)",
        });
        const result = (await client.get(
          `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata${query}`,
        )) as {
          value: Array<{ OptionSet: { Options: RawOption[] } }>;
        };
        if (result.value.length === 0) {
          throw new Error(`Picklist attribute not found: ${entity}.${attr}`);
        }
        options = result.value[0].OptionSet.Options;
      }
      const flat = options.map(flattenOption);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(flat, null, 2) },
        ],
      };
    },
  );
}
