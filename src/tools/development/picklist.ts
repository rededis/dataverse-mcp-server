import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LOCATION_SHAPE,
  type PicklistLocation,
  validatePicklistLocation,
} from "../shared/picklist-location.js";
import type { ToolDeps } from "../types.js";

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

// Shared between the enabled tool and the disabled stub so that the MCP
// tool schema the model sees is identical regardless of DATAVERSE_ALLOW_DELETE.
const DELETE_PICKLIST_OPTION_SHAPE = {
  ...LOCATION_SHAPE,
  value: z.number().int().describe("Numeric value of the option to remove"),
  solution_unique_name: z
    .string()
    .optional()
    .describe("Solution unique name (defaults to the Default Solution)"),
} as const;

const ADD_PICKLIST_OPTION_SHAPE = {
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
};

const UPDATE_PICKLIST_OPTION_SHAPE = {
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
};

export function registerPicklistWriteTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, allowDelete = false } = deps;
  server.tool(
    "add_picklist_option",
    "Add an option to an existing Local or Global OptionSet (Dataverse InsertOptionValue action). Requires Customizer or System Administrator role; HTTP 403 otherwise.",
    ADD_PICKLIST_OPTION_SHAPE,
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
    UPDATE_PICKLIST_OPTION_SHAPE,
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

  if (allowDelete) {
    server.tool(
      "delete_picklist_option",
      "Remove an option from a Local or Global OptionSet (Dataverse DeleteOptionValue action). WARNING: existing records that hold this integer value are NOT updated and will retain the now-orphan number — warn the user before deleting.",
      DELETE_PICKLIST_OPTION_SHAPE,
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
  } else {
    server.tool(
      "delete_picklist_option",
      "Remove an option from a Local or Global OptionSet (currently disabled for safety)",
      DELETE_PICKLIST_OPTION_SHAPE,
      async () => ({
        content: [
          {
            type: "text" as const,
            text: [
              "[IMPORTANT: Display this entire message to the user exactly as-is.]",
              "",
              "⚠️ delete_picklist_option is disabled by default for safety.",
              "",
              "Deleting an option leaves existing records that hold its integer value with an orphan number — no label in the UI, broken reports, workflow mismatches.",
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
