import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";
import { escapeODataString } from "./data-tools.js";

const ATTRIBUTE_ODATA_TYPE_MAP: Record<string, string> = {
  String: "Microsoft.Dynamics.CRM.StringAttributeMetadata",
  Integer: "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
  BigInt: "Microsoft.Dynamics.CRM.BigIntAttributeMetadata",
  Decimal: "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
  Double: "Microsoft.Dynamics.CRM.DoubleAttributeMetadata",
  Money: "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
  DateTime: "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
  Uniqueidentifier: "Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata",
  Memo: "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
  Boolean: "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
  Picklist: "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
};

function buildLabel(label: string, languageCode = 1033) {
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

const AttributeSchema = z.object({
  logical_name: z.string().describe("Logical name (e.g. 'contoso_amount')"),
  type: z
    .enum([
      "String",
      "Integer",
      "BigInt",
      "Decimal",
      "Double",
      "Money",
      "DateTime",
      "Uniqueidentifier",
      "Memo",
      "Boolean",
      "Picklist",
    ])
    .describe("Attribute type"),
  display_name: z.string().describe("Display name"),
  description: z.string().optional().describe("Description"),
  required: z
    .enum(["None", "ApplicationRequired", "SystemRequired"])
    .optional()
    .describe("Required level (default: None)"),
  max_length: z.number().optional().describe("Max length for String/Memo"),
  min_value: z.number().optional().describe("Min value for numeric types"),
  max_value: z.number().optional().describe("Max value for numeric types"),
  precision: z
    .number()
    .optional()
    .describe("Decimal precision for Decimal/Money"),
  options: z
    .array(z.object({ label: z.string(), value: z.number() }))
    .optional()
    .describe(
      "Options for Boolean (2 items: false=0, true=1) or Picklist types",
    ),
});

type AttributeInput = z.infer<typeof AttributeSchema>;

export function buildAttributeBody(
  attr: AttributeInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    "@odata.type": ATTRIBUTE_ODATA_TYPE_MAP[attr.type],
    LogicalName: attr.logical_name,
    SchemaName:
      attr.logical_name.charAt(0).toUpperCase() + attr.logical_name.slice(1),
    DisplayName: buildLabel(attr.display_name),
    RequiredLevel: { Value: attr.required || "None" },
  };

  if (attr.description) body.Description = buildLabel(attr.description);
  if (attr.max_length !== undefined) body.MaxLength = attr.max_length;
  if (attr.min_value !== undefined) body.MinValue = attr.min_value;
  if (attr.max_value !== undefined) body.MaxValue = attr.max_value;
  if (attr.precision !== undefined) body.Precision = attr.precision;

  if (attr.type === "Boolean") {
    const falseOption = attr.options?.find((o) => o.value === 0) ?? {
      label: "No",
      value: 0,
    };
    const trueOption = attr.options?.find((o) => o.value === 1) ?? {
      label: "Yes",
      value: 1,
    };
    body.OptionSet = {
      "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
      TrueOption: {
        Value: trueOption.value,
        Label: buildLabel(trueOption.label),
      },
      FalseOption: {
        Value: falseOption.value,
        Label: buildLabel(falseOption.label),
      },
    };
  }

  if (attr.type === "Picklist") {
    if (!attr.options?.length) {
      throw new Error(
        "Picklist attributes require a non-empty 'options' array.",
      );
    }
    body.OptionSet = {
      "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
      IsGlobal: false,
      Options: attr.options.map((opt) => ({
        Value: opt.value,
        Label: buildLabel(opt.label),
      })),
    };
  }

  return body;
}

export function registerSchemaTools(
  server: McpServer,
  client: DataverseClient,
  allowDelete = false,
): void {
  server.tool(
    "create_entity",
    "Create a new Dataverse table (entity) with specified attributes",
    {
      logical_name: z
        .string()
        .describe(
          "Logical name with publisher prefix (e.g. 'contoso_newtable')",
        ),
      display_name: z.string().describe("Display name"),
      display_collection_name: z.string().describe("Plural display name"),
      description: z.string().optional().describe("Table description"),
      primary_attribute_name: z
        .string()
        .optional()
        .describe(
          "Logical name for primary name attribute (default: '{prefix}_name')",
        ),
      primary_attribute_display_name: z
        .string()
        .optional()
        .describe("Display name for primary name attribute (default: 'Name')"),
      ownership_type: z
        .enum(["UserOwned", "OrganizationOwned"])
        .optional()
        .describe("Ownership type (default: UserOwned)"),
      attributes: z
        .array(AttributeSchema)
        .optional()
        .describe("Additional attributes to create with the entity"),
    },
    async (params) => {
      const separatorIndex = params.logical_name.indexOf("_");
      if (
        separatorIndex <= 0 ||
        separatorIndex === params.logical_name.length - 1
      ) {
        throw new Error(
          "Invalid logical_name. Expected format '<publisherprefix>_<name>' (e.g. 'contoso_newtable').",
        );
      }
      const prefix = params.logical_name.slice(0, separatorIndex);
      const primaryAttrName = params.primary_attribute_name || `${prefix}_name`;

      const body: Record<string, unknown> = {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        LogicalName: params.logical_name,
        SchemaName:
          params.logical_name.charAt(0).toUpperCase() +
          params.logical_name.slice(1),
        DisplayName: {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          LocalizedLabels: [
            {
              "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
              Label: params.display_name,
              LanguageCode: 1033,
            },
          ],
        },
        DisplayCollectionName: {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          LocalizedLabels: [
            {
              "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
              Label: params.display_collection_name,
              LanguageCode: 1033,
            },
          ],
        },
        OwnershipType: params.ownership_type || "UserOwned",
        HasActivities: false,
        PrimaryNameAttribute: primaryAttrName,
        Attributes: [
          {
            "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
            LogicalName: primaryAttrName,
            SchemaName:
              primaryAttrName.charAt(0).toUpperCase() +
              primaryAttrName.slice(1),
            MaxLength: 200,
            DisplayName: {
              "@odata.type": "Microsoft.Dynamics.CRM.Label",
              LocalizedLabels: [
                {
                  "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                  Label: params.primary_attribute_display_name || "Name",
                  LanguageCode: 1033,
                },
              ],
            },
            RequiredLevel: { Value: "ApplicationRequired" },
            IsPrimaryName: true,
          },
        ],
      };

      if (params.description) {
        body.Description = {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          LocalizedLabels: [
            {
              "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
              Label: params.description,
              LanguageCode: 1033,
            },
          ],
        };
      }

      const result = await client.post("/EntityDefinitions", body);

      // Create additional attributes if specified
      if (params.attributes?.length) {
        const entityMeta = result as { MetadataId?: string };
        const entityId =
          entityMeta.MetadataId ||
          (result as Record<string, string>)["@odata.entityId"]?.match(
            /\(([^)]+)\)/,
          )?.[1];

        if (!entityId) {
          throw new Error(
            "Entity was created but additional attributes could not be created because the entity ID was not returned by the create-entity response.",
          );
        }

        for (const attr of params.attributes) {
          const attrBody = buildAttributeBody(attr);
          await client.post(
            `/EntityDefinitions(${entityId})/Attributes`,
            attrBody,
          );
        }
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "add_attribute",
    "Add a column (attribute) to an existing Dataverse table",
    {
      entity_logical_name: z.string().describe("Logical name of the entity"),
      attribute: AttributeSchema,
    },
    async ({ entity_logical_name, attribute }) => {
      const body = buildAttributeBody(attribute);
      const escaped = escapeODataString(entity_logical_name);
      const result = await client.post(
        `/EntityDefinitions(LogicalName='${escaped}')/Attributes`,
        body,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "create_relationship",
    "Create a relationship between two Dataverse tables",
    {
      type: z.enum(["OneToMany", "ManyToMany"]).describe("Relationship type"),
      primary_entity: z
        .string()
        .describe("Primary (referenced) entity logical name"),
      related_entity: z
        .string()
        .describe("Related (referencing) entity logical name"),
      schema_name: z
        .string()
        .describe("Unique schema name for the relationship"),
      lookup_name: z
        .string()
        .optional()
        .describe("Logical name for lookup attribute (OneToMany only)"),
      lookup_display_name: z
        .string()
        .optional()
        .describe("Display name for lookup attribute (OneToMany only)"),
    },
    async (params) => {
      if (params.type === "OneToMany") {
        const body = {
          "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
          SchemaName: params.schema_name,
          ReferencedEntity: params.primary_entity,
          ReferencingEntity: params.related_entity,
          Lookup: {
            "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
            LogicalName:
              params.lookup_name ||
              `${params.related_entity}_${params.primary_entity}id`,
            SchemaName:
              (
                params.lookup_name ||
                `${params.related_entity}_${params.primary_entity}id`
              )
                .charAt(0)
                .toUpperCase() +
              (
                params.lookup_name ||
                `${params.related_entity}_${params.primary_entity}id`
              ).slice(1),
            DisplayName: {
              "@odata.type": "Microsoft.Dynamics.CRM.Label",
              LocalizedLabels: [
                {
                  "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                  Label: params.lookup_display_name || params.primary_entity,
                  LanguageCode: 1033,
                },
              ],
            },
            RequiredLevel: { Value: "None" },
          },
        };
        const result = await client.post("/RelationshipDefinitions", body);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } else {
        const body = {
          "@odata.type":
            "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
          SchemaName: params.schema_name,
          Entity1LogicalName: params.primary_entity,
          Entity2LogicalName: params.related_entity,
          IntersectEntityName: `${params.primary_entity}_${params.related_entity}`,
        };
        const result = await client.post("/RelationshipDefinitions", body);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    },
  );

  server.tool(
    "update_attribute",
    "Update metadata of an existing column (display name, description, required level, max length, min/max value, precision). The column's type and logical name CANNOT be changed by Dataverse — for those, create a new column, migrate data, then delete the old one.",
    {
      entity_logical_name: z.string().describe("Logical name of the entity"),
      attribute_logical_name: z
        .string()
        .describe("Logical name of the column to update"),
      type: z
        .enum([
          "String",
          "Integer",
          "BigInt",
          "Decimal",
          "Double",
          "Money",
          "DateTime",
          "Uniqueidentifier",
          "Memo",
          "Boolean",
          "Picklist",
        ])
        .describe(
          "Current type of the attribute (required to build the correct metadata discriminator; must match the existing type — type changes are not allowed)",
        ),
      display_name: z.string().optional().describe("New display name"),
      description: z.string().optional().describe("New description"),
      required: z
        .enum(["None", "ApplicationRequired", "SystemRequired"])
        .optional()
        .describe("New required level"),
      max_length: z
        .number()
        .optional()
        .describe("New max length (String/Memo only)"),
      min_value: z
        .number()
        .optional()
        .describe("New min value (numeric types only)"),
      max_value: z
        .number()
        .optional()
        .describe("New max value (numeric types only)"),
      precision: z
        .number()
        .optional()
        .describe("New precision (Decimal/Money only)"),
      language_code: z
        .number()
        .optional()
        .describe("Language code for labels (default: 1033)"),
      merge_labels: z
        .boolean()
        .optional()
        .describe(
          "If true, preserve existing localized labels in other languages; if false (default), replace all localized labels with just the new one.",
        ),
    },
    async (params) => {
      const hasMutableField =
        params.display_name !== undefined ||
        params.description !== undefined ||
        params.required !== undefined ||
        params.max_length !== undefined ||
        params.min_value !== undefined ||
        params.max_value !== undefined ||
        params.precision !== undefined;
      if (!hasMutableField) {
        return {
          content: [
            {
              type: "text" as const,
              text: "update_attribute requires at least one of: display_name, description, required, max_length, min_value, max_value, precision. Nothing to update.",
            },
          ],
          isError: true,
        };
      }

      const entityEscaped = escapeODataString(params.entity_logical_name);
      const attrEscaped = escapeODataString(params.attribute_logical_name);
      const path = `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes(LogicalName='${attrEscaped}')`;

      // Dataverse metadata endpoint rejects PATCH with HTTP 405; updates go
      // through PUT, which REPLACES the full resource. To avoid resetting
      // untouched fields (RequiredLevel, MaxLength, etc.) to defaults, fetch
      // current metadata first and merge the user-supplied changes on top.
      const current = (await client.get(path)) as Record<string, unknown>;
      const merged: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) {
        // Strip control metadata (@odata.etag, @odata.context, ...) — the
        // discriminator @odata.type is re-set below.
        if (key.startsWith("@odata.")) continue;
        merged[key] = value;
      }
      merged["@odata.type"] = ATTRIBUTE_ODATA_TYPE_MAP[params.type];

      const lang = params.language_code ?? 1033;
      if (params.display_name !== undefined) {
        merged.DisplayName = buildLabel(params.display_name, lang);
      }
      if (params.description !== undefined) {
        merged.Description = buildLabel(params.description, lang);
      }
      if (params.required !== undefined) {
        merged.RequiredLevel = { Value: params.required };
      }
      if (params.max_length !== undefined) merged.MaxLength = params.max_length;
      if (params.min_value !== undefined) merged.MinValue = params.min_value;
      if (params.max_value !== undefined) merged.MaxValue = params.max_value;
      if (params.precision !== undefined) merged.Precision = params.precision;

      const headers: Record<string, string> = { "If-Match": "*" };
      if (params.merge_labels) headers["MSCRM.MergeLabels"] = "true";

      await client.request(path, { method: "PUT", body: merged, headers });
      return {
        content: [
          {
            type: "text" as const,
            text: `Attribute ${params.entity_logical_name}.${params.attribute_logical_name} updated successfully.`,
          },
        ],
      };
    },
  );

  if (allowDelete) {
    server.tool(
      "delete_attribute",
      "Permanently delete a column (attribute) from a Dataverse table. ⚠️ WARNING: this PERMANENTLY DESTROYS all data stored in this column across ALL records — there is no soft-delete, no undo, no recovery except from a full environment backup. Before calling this, make the user confirm explicitly and consider: (1) is this a rename? then create the new column, migrate data, and only then delete the old one; (2) type change? same pattern.",
      {
        entity_logical_name: z.string().describe("Logical name of the entity"),
        attribute_logical_name: z
          .string()
          .describe("Logical name of the column to delete"),
      },
      async ({ entity_logical_name, attribute_logical_name }) => {
        const entityEscaped = escapeODataString(entity_logical_name);
        const attrEscaped = escapeODataString(attribute_logical_name);
        await client.delete(
          `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes(LogicalName='${attrEscaped}')`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Attribute ${entity_logical_name}.${attribute_logical_name} deleted. All data stored in this column across all records is permanently lost.`,
            },
          ],
        };
      },
    );
  } else {
    server.tool(
      "delete_attribute",
      "Delete a column from a Dataverse table (currently disabled for safety)",
      {
        entity_logical_name: z.string().describe("Logical name of the entity"),
        attribute_logical_name: z
          .string()
          .describe("Logical name of the column"),
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: [
              "[IMPORTANT: Display this entire message to the user exactly as-is.]",
              "",
              "⚠️ delete_attribute is disabled by default for safety.",
              "",
              "Deleting a column PERMANENTLY destroys all data in it across every record — no recovery.",
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
