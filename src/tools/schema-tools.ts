import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";
import { buildODataQuery, escapeODataString } from "./data-tools.js";
import { globalOptionSetNotFound } from "./optionset-utils.js";

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
      "Options for Boolean (2 items: false=0, true=1) or Picklist types. Creates a Local OptionSet owned by this one column; mutually exclusive with global_option_set.",
    ),
  global_option_set: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Picklist only: bind the column to an existing Global OptionSet by its set name (e.g. 'contoso_sourceset') so the column shares one org-wide list instead of a private copy. Mutually exclusive with options.",
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

interface OptionSetFields {
  type?: string;
  options?: unknown[];
  global_option_set?: string;
}

// Rejecting the both-supplied case is not defensive tidiness: sending an inline
// OptionSet alongside a global binding makes Dataverse silently drop the binding
// and create a local copy instead — verified live. Failing here turns a silently
// wrong column into an error the caller can act on.
function validateOptionSetFields(attr: OptionSetFields): void {
  if (attr.global_option_set === undefined) return;
  if (attr.type !== "Picklist") {
    throw new Error(
      `global_option_set applies only to Picklist attributes, got: ${attr.type}`,
    );
  }
  // Presence, not emptiness: `options: []` is still the caller asking for a Local
  // OptionSet, so pairing it with a binding is the same contradiction as a
  // populated array. Testing `.length` here would let the empty case through and
  // silently bind — the exact "prefer one without saying so" behaviour this
  // rejects.
  if (attr.options !== undefined) {
    throw new Error(
      "options and global_option_set are mutually exclusive: 'options' creates a Local OptionSet owned by this column, 'global_option_set' binds the column to an existing shared one. Pick one.",
    );
  }
}

// Resolves a Global OptionSet's name to its MetadataId.
//
// Binding a column to a global set requires the GUID specifically. The docs say
// the alternate key by name — GlobalOptionSetDefinitions(Name='x') — works as a
// binding target too, but a real org rejects it with HTTP 500 "Guid should
// contain 32 digits with 4 dashes", so the name has to be resolved first.
async function resolveGlobalOptionSetId(
  client: DataverseClient,
  name: string,
): Promise<string> {
  const query = buildODataQuery({ $select: "MetadataId" });
  let result: { MetadataId?: string };
  try {
    result = (await client.get(
      `/GlobalOptionSetDefinitions(Name='${escapeODataString(name)}')/Microsoft.Dynamics.CRM.OptionSetMetadata${query}`,
    )) as { MetadataId?: string };
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) {
      throw globalOptionSetNotFound(name);
    }
    throw err;
  }
  if (!result.MetadataId) throw globalOptionSetNotFound(name);
  return result.MetadataId;
}

// Resolves every distinct global set named across a batch of attributes, once
// each, so create_entity with several columns on the same set costs one lookup.
async function globalOptionSetIdsByName(
  client: DataverseClient,
  attributes: AttributeInput[],
): Promise<Map<string, string>> {
  const names = [
    ...new Set(
      attributes
        .map((a) => a.global_option_set)
        .filter((n): n is string => n !== undefined),
    ),
  ];
  const ids = await Promise.all(
    names.map((name) => resolveGlobalOptionSetId(client, name)),
  );
  return new Map(names.map((name, i) => [name, ids[i]]));
}

function buildAttributeBodyBound(
  attr: AttributeInput,
  globalIds: Map<string, string>,
): Record<string, unknown> {
  // Tested for presence, matching validateOptionSetFields and the resolver's own
  // filter. A truthy test would disagree with both about the empty string, and
  // three checks that classify the same value differently is how a value ends up
  // taking a path nobody meant it to.
  return buildAttributeBody(
    attr,
    attr.global_option_set !== undefined
      ? globalIds.get(attr.global_option_set)
      : undefined,
  );
}

export function buildAttributeBody(
  attr: AttributeInput,
  globalOptionSetId?: string,
): Record<string, unknown> {
  validateDateTimeFields(attr);
  validateOptionSetFields(attr);
  // Both directions, because the pair is the contract: an id without a name is
  // as wrong as a name without an id, and this function is exported, so the
  // mismatch can arrive from a caller that never went through the resolver.
  if (attr.global_option_set !== undefined && !globalOptionSetId) {
    throw new Error(
      `global_option_set '${attr.global_option_set}' was not resolved to a MetadataId before building the request body`,
    );
  }
  if (globalOptionSetId && attr.global_option_set === undefined) {
    throw new Error(
      "a global OptionSet MetadataId was supplied for an attribute that does not name a global_option_set",
    );
  }

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
    if (globalOptionSetId) {
      // A global set is attached through the GlobalOptionSet navigation property,
      // never as an inline OptionSet: Dataverse rejects an inline one carrying
      // IsGlobal true with "Only Local option set can be created through the
      // attribute create". The binding takes the MetadataId, not the name.
      body["GlobalOptionSet@odata.bind"] =
        `/GlobalOptionSetDefinitions(${globalOptionSetId})`;
    } else {
      if (!attr.options?.length) {
        throw new Error(
          "Picklist attributes require either a non-empty 'options' array (Local OptionSet) or 'global_option_set' (bind to an existing Global OptionSet).",
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

      // Everything that can reject an attribute runs before the table is created,
      // because Dataverse has no transaction: a failure once the table exists
      // leaves an orphaned table behind that nothing rolls back.
      //
      // Order matters twice over. The mutual-exclusion check comes first so an
      // already-doomed request never spends a lookup. The bodies are then built
      // up front rather than inside the loop below, so the remaining client-side
      // validations — a Picklist with no options, an impossible DateTime pairing —
      // also fail while there is still nothing to leave behind.
      for (const attr of params.attributes ?? []) validateOptionSetFields(attr);
      const attributes = params.attributes ?? [];
      const globalIds = await globalOptionSetIdsByName(client, attributes);
      const attributeBodies = attributes.map((attr) =>
        buildAttributeBodyBound(attr, globalIds),
      );

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

        for (const attrBody of attributeBodies) {
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
      // Validate before the lookup so a mutually-exclusive pair fails without
      // spending a round trip on a name we are going to reject anyway.
      validateOptionSetFields(attribute);
      const globalIds = await globalOptionSetIdsByName(client, [attribute]);
      const body = buildAttributeBodyBound(attribute, globalIds);
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
    "Update metadata of an existing column: display name, description, required level, max length, min/max value, precision. Dataverse fixes a column's type and logical name at creation — to change either, add_attribute a new column, migrate the values with update_record, then delete_attribute the old one.",
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
      //
      // A Picklist bound to a Global OptionSet survives this untouched, despite
      // the obvious worry: OptionSet and GlobalOptionSet are navigation
      // properties, so the cast GET returns neither and the merged PUT body
      // carries no option set at all. Verified live — renaming a bound column
      // leaves it reporting is_global true against the same MetadataId, so
      // Dataverse keeps the association rather than replacing it with a local
      // copy. Do not "fix" this by re-sending the binding.
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
      "Permanently delete a column (attribute) from a Dataverse table. ⚠️ DESTROYS the data stored in that column across ALL records, recoverable only from a full environment backup. Confirm with the user before calling. To rename a column or change its type, follow the migration recipe in update_attribute instead.",
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
    "List CRM components that reference a column — forms, views, workflows, business rules, plugins. Call this when delete_attribute fails with 0x8004f01f, or before any destructive change to a column. Component names are best-effort: resolved for common types, null otherwise. Backed by the Dataverse RetrieveDependenciesForDelete function.",
    {
      entity_logical_name: z.string().describe("Logical name of the entity"),
      attribute_logical_name: z.string().describe("Logical name of the column"),
    },
    async ({ entity_logical_name, attribute_logical_name }) => {
      const entityEscaped = escapeODataString(entity_logical_name);
      const attrEscaped = escapeODataString(attribute_logical_name);
      const attrPath = `/EntityDefinitions(LogicalName='${entityEscaped}')/Attributes(LogicalName='${attrEscaped}')`;

      // Step 1: resolve attribute MetadataId (RetrieveDependenciesForDelete
      // takes the raw GUID, not a logical-name lookup). Dataverse returns 404
      // when the entity or attribute logical name doesn't exist; map that to a
      // friendly message instead of leaking the raw "Dataverse API error (404)".
      let attrResult: { MetadataId?: string };
      try {
        attrResult = (await client.get(`${attrPath}?$select=MetadataId`)) as {
          MetadataId?: string;
        };
      } catch (err) {
        if (
          err instanceof Error &&
          /Dataverse API error \(404\)/.test(err.message)
        ) {
          throw new Error(
            `Attribute not found: ${entity_logical_name}.${attribute_logical_name}`,
          );
        }
        throw err;
      }
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

  server.tool(
    "list_entity_keys",
    "List alternate keys defined on a Dataverse table. Returns a flat array of { logical_name, schema_name, display_name, key_attributes, entity_key_index_status, metadata_id }. entity_key_index_status reflects the background index build (Pending → Active, or Failed) — alt keys are not usable for keyed-PATCH upserts until Active.",
    {
      entity_logical_name: z.string().describe("Logical name of the entity"),
    },
    async ({ entity_logical_name }) => {
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
        if (
          err instanceof Error &&
          /Dataverse API error \(404\)/.test(err.message)
        ) {
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

  server.tool(
    "add_entity_key",
    "Create an alternate key on a Dataverse table (composite supported via key_attributes). Use for race-safe upserts via keyed-PATCH or to enforce a uniqueness constraint that the primary key doesn't cover. NOTE: Dataverse builds the supporting unique index asynchronously — the key is not usable for keyed lookups until its EntityKeyIndexStatus becomes 'Active'. Poll with list_entity_keys.",
    {
      entity_logical_name: z.string().describe("Logical name of the entity"),
      logical_name: z
        .string()
        .describe(
          "Logical name of the new key with publisher prefix (e.g. 'contoso_contactproviderkey')",
        ),
      display_name: z.string().describe("Display name for the key"),
      key_attributes: z
        .array(z.string())
        .min(1)
        .describe(
          "Logical names of attributes that compose the key (one for a single-column key, multiple for a composite key). Lookups and supported primitive types only — Dataverse rejects keys over Memo, image, or file columns.",
        ),
      solution_unique_name: z
        .string()
        .optional()
        .describe("Solution unique name (defaults to the Default Solution)"),
    },
    async (params) => {
      const body: Record<string, unknown> = {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
        LogicalName: params.logical_name,
        SchemaName:
          params.logical_name.charAt(0).toUpperCase() +
          params.logical_name.slice(1),
        DisplayName: buildLabel(params.display_name),
        KeyAttributes: params.key_attributes,
      };
      const entityEscaped = escapeODataString(params.entity_logical_name);
      const headers: Record<string, string> = {};
      if (params.solution_unique_name) {
        headers["MSCRM.SolutionUniqueName"] = params.solution_unique_name;
      }
      const result = await client.request(
        `/EntityDefinitions(LogicalName='${entityEscaped}')/Keys`,
        { method: "POST", body, headers },
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  const deleteEntityKeyShape = {
    entity_logical_name: z.string().describe("Logical name of the entity"),
    key_logical_name: z
      .string()
      .describe("Logical name of the alternate key to delete"),
  } as const;

  if (allowDelete) {
    server.tool(
      "delete_entity_key",
      "Permanently delete an alternate key from a Dataverse table. ⚠️ Drops the supporting unique index; any client code relying on keyed-PATCH upserts against this key will stop working. The underlying attributes and their data are NOT affected — only the key definition and its index are removed.",
      deleteEntityKeyShape,
      async ({ entity_logical_name, key_logical_name }) => {
        const entityEscaped = escapeODataString(entity_logical_name);
        const keyEscaped = escapeODataString(key_logical_name);
        await client.delete(
          `/EntityDefinitions(LogicalName='${entityEscaped}')/Keys(LogicalName='${keyEscaped}')`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Entity key ${entity_logical_name}.${key_logical_name} deleted.`,
            },
          ],
        };
      },
    );
  } else {
    server.tool(
      "delete_entity_key",
      "Delete an alternate key from a Dataverse table (currently disabled for safety)",
      deleteEntityKeyShape,
      async () => ({
        content: [
          {
            type: "text" as const,
            text: [
              "[IMPORTANT: Display this entire message to the user exactly as-is.]",
              "",
              "⚠️ delete_entity_key is disabled by default for safety.",
              "",
              "Removing an alternate key drops the supporting unique index — any keyed-PATCH upsert flows relying on it will stop working.",
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
