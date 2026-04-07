import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../client.js";

const AttributeSchema = z.object({
  logical_name: z.string().describe("Logical name (e.g. 'contoso_amount')"),
  type: z.enum([
    "String", "Integer", "BigInt", "Decimal", "Double", "Money",
    "Boolean", "DateTime", "Uniqueidentifier", "Memo", "Picklist", "Lookup",
  ]).describe("Attribute type"),
  display_name: z.string().describe("Display name"),
  description: z.string().optional().describe("Description"),
  required: z.enum(["None", "ApplicationRequired", "SystemRequired"]).optional()
    .describe("Required level (default: None)"),
  max_length: z.number().optional().describe("Max length for String/Memo"),
  min_value: z.number().optional().describe("Min value for numeric types"),
  max_value: z.number().optional().describe("Max value for numeric types"),
  precision: z.number().optional().describe("Decimal precision for Decimal/Money"),
});

type AttributeInput = z.infer<typeof AttributeSchema>;

function buildAttributeBody(attr: AttributeInput): Record<string, unknown> {
  const typeMap: Record<string, string> = {
    String: "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    Integer: "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
    BigInt: "Microsoft.Dynamics.CRM.BigIntAttributeMetadata",
    Decimal: "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
    Double: "Microsoft.Dynamics.CRM.DoubleAttributeMetadata",
    Money: "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
    Boolean: "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
    DateTime: "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
    Uniqueidentifier: "Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata",
    Memo: "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
    Picklist: "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
    Lookup: "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
  };

  const body: Record<string, unknown> = {
    "@odata.type": typeMap[attr.type],
    LogicalName: attr.logical_name,
    SchemaName: attr.logical_name.charAt(0).toUpperCase() + attr.logical_name.slice(1),
    DisplayName: {
      "@odata.type": "Microsoft.Dynamics.CRM.Label",
      LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: attr.display_name, LanguageCode: 1033 }],
    },
    RequiredLevel: { Value: attr.required || "None" },
  };

  if (attr.description) {
    body.Description = {
      "@odata.type": "Microsoft.Dynamics.CRM.Label",
      LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: attr.description, LanguageCode: 1033 }],
    };
  }

  if (attr.max_length !== undefined) body.MaxLength = attr.max_length;
  if (attr.min_value !== undefined) body.MinValue = attr.min_value;
  if (attr.max_value !== undefined) body.MaxValue = attr.max_value;
  if (attr.precision !== undefined) body.Precision = attr.precision;

  return body;
}

export function registerSchemaTools(server: McpServer, client: DataverseClient): void {
  server.tool(
    "create_entity",
    "Create a new Dataverse table (entity) with specified attributes",
    {
      logical_name: z.string().describe("Logical name with publisher prefix (e.g. 'contoso_newtable')"),
      display_name: z.string().describe("Display name"),
      display_collection_name: z.string().describe("Plural display name"),
      description: z.string().optional().describe("Table description"),
      primary_attribute_name: z.string().optional()
        .describe("Logical name for primary name attribute (default: '{prefix}_name')"),
      primary_attribute_display_name: z.string().optional()
        .describe("Display name for primary name attribute (default: 'Name')"),
      ownership_type: z.enum(["UserOwned", "OrganizationOwned"]).optional()
        .describe("Ownership type (default: UserOwned)"),
      attributes: z.array(AttributeSchema).optional()
        .describe("Additional attributes to create with the entity"),
    },
    async (params) => {
      const prefix = params.logical_name.split("_")[0];
      const primaryAttrName = params.primary_attribute_name || `${prefix}_name`;

      const body: Record<string, unknown> = {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        LogicalName: params.logical_name,
        SchemaName: params.logical_name.charAt(0).toUpperCase() + params.logical_name.slice(1),
        DisplayName: {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: params.display_name, LanguageCode: 1033 }],
        },
        DisplayCollectionName: {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: params.display_collection_name, LanguageCode: 1033 }],
        },
        OwnershipType: params.ownership_type || "UserOwned",
        HasActivities: false,
        PrimaryNameAttribute: primaryAttrName,
        Attributes: [
          {
            "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
            LogicalName: primaryAttrName,
            SchemaName: primaryAttrName.charAt(0).toUpperCase() + primaryAttrName.slice(1),
            MaxLength: 200,
            DisplayName: {
              "@odata.type": "Microsoft.Dynamics.CRM.Label",
              LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: params.primary_attribute_display_name || "Name", LanguageCode: 1033 }],
            },
            RequiredLevel: { Value: "ApplicationRequired" },
            IsPrimaryName: true,
          },
        ],
      };

      if (params.description) {
        body.Description = {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: params.description, LanguageCode: 1033 }],
        };
      }

      const result = await client.post("/EntityDefinitions", body);

      // Create additional attributes if specified
      if (params.attributes?.length) {
        const entityMeta = result as { MetadataId?: string };
        const entityId = entityMeta.MetadataId || (result as Record<string, string>)["@odata.entityId"]?.match(/\(([^)]+)\)/)?.[1];

        if (entityId) {
          for (const attr of params.attributes) {
            const attrBody = buildAttributeBody(attr);
            await client.post(`/EntityDefinitions(${entityId})/Attributes`, attrBody);
          }
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
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
      const escaped = entity_logical_name.replace(/'/g, "''");
      const result = await client.post(
        `/EntityDefinitions(LogicalName='${escaped}')/Attributes`,
        body
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_relationship",
    "Create a relationship between two Dataverse tables",
    {
      type: z.enum(["OneToMany", "ManyToMany"]).describe("Relationship type"),
      primary_entity: z.string().describe("Primary (referenced) entity logical name"),
      related_entity: z.string().describe("Related (referencing) entity logical name"),
      schema_name: z.string().describe("Unique schema name for the relationship"),
      lookup_name: z.string().optional()
        .describe("Logical name for lookup attribute (OneToMany only)"),
      lookup_display_name: z.string().optional()
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
            LogicalName: params.lookup_name || `${params.related_entity}_${params.primary_entity}id`,
            SchemaName: (params.lookup_name || `${params.related_entity}_${params.primary_entity}id`)
              .charAt(0).toUpperCase() + (params.lookup_name || `${params.related_entity}_${params.primary_entity}id`).slice(1),
            DisplayName: {
              "@odata.type": "Microsoft.Dynamics.CRM.Label",
              LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: params.lookup_display_name || params.primary_entity, LanguageCode: 1033 }],
            },
            RequiredLevel: { Value: "None" },
          },
        };
        const result = await client.post("/RelationshipDefinitions", body);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } else {
        const body = {
          "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
          SchemaName: params.schema_name,
          Entity1LogicalName: params.primary_entity,
          Entity2LogicalName: params.related_entity,
          IntersectEntityName: `${params.primary_entity}_${params.related_entity}`,
        };
        const result = await client.post("/RelationshipDefinitions", body);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    }
  );
}
