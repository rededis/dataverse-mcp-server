import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";
import { buildODataQuery, escapeODataString } from "./data-tools.js";

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
  date_format: z
    .enum(["DateOnly", "DateAndTime"])
    .optional()
    .describe(
      "DateTime only: UI presentation — 'DateOnly' hides the time picker (calendar columns), 'DateAndTime' shows both (default).",
    ),
  date_behavior: z
    .enum(["UserLocal", "DateOnly", "TimeZoneIndependent"])
    .optional()
    .describe(
      "DateTime only: storage/projection semantics. 'UserLocal' (default) shifts by viewer's TZ; 'DateOnly' stores a calendar date (requires date_format=DateOnly); 'TimeZoneIndependent' stores wall-clock time identical across TZs. Per Microsoft docs, changing DateTimeBehavior on an existing column is a one-way operation (UserLocal → other) and cannot be reverted.",
    ),
});

type AttributeInput = z.infer<typeof AttributeSchema>;

interface DateTimeFields {
  type?: string;
  date_format?: "DateOnly" | "DateAndTime";
  date_behavior?: "UserLocal" | "DateOnly" | "TimeZoneIndependent";
}

function validateDateTimeFields(attr: DateTimeFields): void {
  const usedDateFields =
    attr.date_format !== undefined || attr.date_behavior !== undefined;
  if (usedDateFields && attr.type !== "DateTime") {
    throw new Error(
      "date_format and date_behavior apply only to DateTime attributes",
    );
  }
  if (
    attr.date_format === "DateOnly" &&
    attr.date_behavior !== undefined &&
    attr.date_behavior !== "DateOnly"
  ) {
    throw new Error(
      `DateOnly format requires DateOnly behavior, got: ${attr.date_behavior}`,
    );
  }
}

export function buildAttributeBody(
  attr: AttributeInput,
): Record<string, unknown> {
  validateDateTimeFields(attr);

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

  if (attr.type === "DateTime") {
    if (attr.date_format) body.Format = attr.date_format;
    // DateTimeBehavior is wrapped in { Value: ... } per Dataverse OData spec
    // (common gotcha — Format is a bare string but Behavior is a typed object)
    if (attr.date_behavior)
      body.DateTimeBehavior = { Value: attr.date_behavior };
  }

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

// Common componenttype int → friendly name. Hand-curated from Microsoft docs:
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/dependency
// Covers the types most likely to appear as attribute dependencies; unknown
// values fall back to "ComponentType_<N>" so the caller still sees the raw int.
const COMPONENT_TYPE_NAMES: Record<number, string> = {
  1: "Entity",
  2: "Attribute",
  3: "Relationship",
  9: "OptionSet",
  10: "EntityRelationship",
  14: "EntityKey",
  20: "Role",
  22: "DisplayString",
  24: "Form",
  25: "Organization",
  26: "SavedQuery",
  27: "Workflow",
  29: "Report",
  31: "ReportCategory",
  32: "ReportEntity",
  46: "DuplicateRule",
  59: "SavedQueryVisualization",
  60: "SystemForm",
  61: "WebResource",
  62: "SiteMap",
  65: "HierarchyRule",
  66: "CustomControl",
  70: "FieldSecurityProfile",
  71: "FieldPermission",
  80: "AppModule",
  90: "PluginAssembly",
  91: "PluginType",
  92: "SDKMessageProcessingStep",
  93: "SDKMessageProcessingStepImage",
  102: "Workflow",
  103: "ConvertRule",
  150: "Theme",
  152: "ConnectionRole",
  166: "SLA",
};

// Per-componenttype info to do best-effort name resolution from the dep's
// objectid back to a human-readable name. Component types not listed here
// keep `name: null` in the output (caller still gets the raw object_id).
interface DependencyResolver {
  entitySet: string;
  idField: string;
  nameField: string;
}

const DEPENDENCY_RESOLVERS: Record<number, DependencyResolver> = {
  26: { entitySet: "savedqueries", idField: "savedqueryid", nameField: "name" },
  27: { entitySet: "workflows", idField: "workflowid", nameField: "name" },
  29: { entitySet: "reports", idField: "reportid", nameField: "name" },
  60: { entitySet: "systemforms", idField: "formid", nameField: "name" },
  61: {
    entitySet: "webresourceset",
    idField: "webresourceid",
    nameField: "name",
  },
  70: {
    entitySet: "fieldsecurityprofiles",
    idField: "fieldsecurityprofileid",
    nameField: "name",
  },
  80: { entitySet: "appmodules", idField: "appmoduleid", nameField: "name" },
  92: {
    entitySet: "sdkmessageprocessingsteps",
    idField: "sdkmessageprocessingstepid",
    nameField: "name",
  },
  102: { entitySet: "workflows", idField: "workflowid", nameField: "name" },
};

interface RawDependency {
  dependentcomponenttype: number;
  dependentcomponentobjectid: string;
}

interface FlatDependency {
  component_type: number;
  component_type_name: string;
  object_id: string;
  name: string | null;
}

async function resolveDependencyNames(
  client: DataverseClient,
  componentType: number,
  ids: string[],
): Promise<Map<string, string>> {
  const resolver = DEPENDENCY_RESOLVERS[componentType];
  if (!resolver) return new Map();

  const filter = ids.map((id) => `${resolver.idField} eq ${id}`).join(" or ");
  const query = buildODataQuery({
    $filter: filter,
    $select: `${resolver.idField},${resolver.nameField}`,
  });
  const result = (await client.get(`/${resolver.entitySet}${query}`)) as {
    value: Array<Record<string, string>>;
  };
  const map = new Map<string, string>();
  for (const row of result.value) {
    const id = row[resolver.idField];
    const name = row[resolver.nameField];
    if (id && name) map.set(id, name);
  }
  return map;
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
      date_format: z
        .enum(["DateOnly", "DateAndTime"])
        .optional()
        .describe(
          "DateTime only: change UI presentation. See add_attribute for semantics.",
        ),
      date_behavior: z
        .enum(["UserLocal", "DateOnly", "TimeZoneIndependent"])
        .optional()
        .describe(
          "DateTime only: change storage semantics. ONE-WAY per Microsoft — you can switch from UserLocal to DateOnly or TimeZoneIndependent once, but cannot switch back or between the non-UserLocal values. Dataverse will return 400 if the behavior is already locked.",
        ),
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
      validateDateTimeFields(params);

      const hasMutableField =
        params.display_name !== undefined ||
        params.description !== undefined ||
        params.required !== undefined ||
        params.max_length !== undefined ||
        params.min_value !== undefined ||
        params.max_value !== undefined ||
        params.precision !== undefined ||
        params.date_format !== undefined ||
        params.date_behavior !== undefined;
      if (!hasMutableField) {
        return {
          content: [
            {
              type: "text" as const,
              text: "update_attribute requires at least one of: display_name, description, required, max_length, min_value, max_value, precision, date_format, date_behavior. Nothing to update.",
            },
          ],
          isError: true,
        };
      }

      const entityEscaped = escapeODataString(params.entity_logical_name);
      const attrEscaped = escapeODataString(params.attribute_logical_name);
      const odataType = ATTRIBUTE_ODATA_TYPE_MAP[params.type];
      const basePath = `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes(LogicalName='${attrEscaped}')`;
      // GET must be cast to the concrete derived type — otherwise the response
      // only contains base AttributeMetadata fields and type-specific ones
      // (MaxLength, Precision, Format, OptionSet, …) are missing. A subsequent
      // PUT with those fields absent would either 400 or reset them, because
      // PUT replaces the full resource.
      const getPath = `${basePath}/${odataType}`;

      // Dataverse metadata endpoint rejects PATCH with HTTP 405; updates go
      // through PUT, which REPLACES the full resource. To avoid resetting
      // untouched fields to defaults, fetch current metadata (with the type
      // cast) and merge the user-supplied changes on top.
      const current = (await client.get(getPath)) as Record<string, unknown>;
      const merged: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) {
        // Strip control metadata (@odata.etag, @odata.context, ...) — the
        // discriminator @odata.type is re-set below.
        if (key.startsWith("@odata.")) continue;
        merged[key] = value;
      }
      merged["@odata.type"] = odataType;

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
      if (params.date_format !== undefined) merged.Format = params.date_format;
      if (params.date_behavior !== undefined) {
        // DateTimeBehavior wrapped in { Value: ... } on write, matches the
        // shape GET returns for this property.
        merged.DateTimeBehavior = { Value: params.date_behavior };
      }

      // Dataverse metadata API does NOT expose ETags (verified empirically
      // with odata.metadata=full — neither ETag response header nor
      // @odata.etag body property is present), so optimistic concurrency via
      // If-Match: <etag> is not available here. If-Match: * is what Microsoft's
      // own update-column example uses — it signals "update existing" (vs
      // upsert) without tying to a version.
      const headers: Record<string, string> = { "If-Match": "*" };
      if (params.merge_labels) headers["MSCRM.MergeLabels"] = "true";

      await client.request(basePath, { method: "PUT", body: merged, headers });
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

  server.tool(
    "get_attribute_dependencies",
    "List CRM components (forms, views, workflows, business rules, calculated columns, plugins, …) that reference a given attribute. Use this when delete_attribute fails with error 0x8004f01f, or proactively before any destructive change. Returns a flat array of { component_type, component_type_name, object_id, name }; name is best-effort (resolved for common types — SystemForm, SavedQuery, Workflow, Report, WebResource, FieldSecurityProfile, AppModule, SDKMessageProcessingStep — null otherwise). Backed by the Dataverse RetrieveDependenciesForDelete function.",
    {
      entity_logical_name: z.string().describe("Logical name of the entity"),
      attribute_logical_name: z.string().describe("Logical name of the column"),
    },
    async ({ entity_logical_name, attribute_logical_name }) => {
      const entityEscaped = escapeODataString(entity_logical_name);
      const attrEscaped = escapeODataString(attribute_logical_name);
      const attrPath = `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes(LogicalName='${attrEscaped}')`;

      // Step 1: resolve attribute MetadataId (RetrieveDependenciesForDelete
      // takes the raw GUID, not a logical-name lookup).
      const attrResult = (await client.get(
        `${attrPath}?$select=MetadataId`,
      )) as { MetadataId?: string };
      if (!attrResult.MetadataId) {
        throw new Error(
          `Attribute not found: ${entity_logical_name}.${attribute_logical_name}`,
        );
      }

      // Step 2: ask Dataverse for the dependency list. ComponentType=2 means
      // the target is an Attribute. Returns a {value:[Dependency]} collection;
      // each Dependency has dependentcomponenttype + dependentcomponentobjectid.
      const depsResult = (await client.get(
        `/RetrieveDependenciesForDelete(ComponentType=2,ObjectId=${attrResult.MetadataId})`,
      )) as { value: RawDependency[] };

      // Step 3: group dep ids by componenttype, then resolve names per group
      // in parallel. Each group is one HTTP call instead of N.
      const idsByType = new Map<number, string[]>();
      for (const dep of depsResult.value) {
        const list = idsByType.get(dep.dependentcomponenttype) ?? [];
        list.push(dep.dependentcomponentobjectid);
        idsByType.set(dep.dependentcomponenttype, list);
      }
      const namesByType = new Map<number, Map<string, string>>();
      await Promise.all(
        Array.from(idsByType.entries()).map(async ([type, ids]) => {
          namesByType.set(
            type,
            await resolveDependencyNames(client, type, ids),
          );
        }),
      );

      const flat: FlatDependency[] = depsResult.value.map((dep) => ({
        component_type: dep.dependentcomponenttype,
        component_type_name:
          COMPONENT_TYPE_NAMES[dep.dependentcomponenttype] ??
          `ComponentType_${dep.dependentcomponenttype}`,
        object_id: dep.dependentcomponentobjectid,
        name:
          namesByType
            .get(dep.dependentcomponenttype)
            ?.get(dep.dependentcomponentobjectid) ?? null,
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(flat, null, 2) },
        ],
      };
    },
  );
}
