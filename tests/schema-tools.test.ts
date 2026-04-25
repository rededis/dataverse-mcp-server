import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetOrganizationIdCache,
  buildAttributeBody,
  registerSchemaTools,
} from "../src/tools/schema-tools.js";

function createMockServer() {
  const tools = new Map<string, { description: string; handler: Function }>();
  return {
    tool: vi.fn(
      (
        name: string,
        description: string,
        _schema: unknown,
        handler: Function,
      ) => {
        tools.set(name, { description, handler });
      },
    ),
    tools,
  };
}

describe("buildAttributeBody", () => {
  it("builds String attribute body", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_name",
      type: "String",
      display_name: "Name",
      max_length: 100,
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    );
    expect(body.LogicalName).toBe("contoso_name");
    expect(body.MaxLength).toBe(100);
    expect(body.RequiredLevel).toEqual({ Value: "None" });
  });

  it("builds Integer attribute with min/max", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_count",
      type: "Integer",
      display_name: "Count",
      min_value: 0,
      max_value: 1000,
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
    );
    expect(body.MinValue).toBe(0);
    expect(body.MaxValue).toBe(1000);
  });

  it("builds Decimal attribute with precision", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_amount",
      type: "Decimal",
      display_name: "Amount",
      precision: 4,
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
    );
    expect(body.Precision).toBe(4);
  });

  it("sets required level", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_required",
      type: "String",
      display_name: "Required Field",
      required: "ApplicationRequired",
    });
    expect(body.RequiredLevel).toEqual({ Value: "ApplicationRequired" });
  });

  it("includes description when provided", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_desc",
      type: "String",
      display_name: "With Desc",
      description: "A description",
    });
    expect(body.Description).toBeDefined();
    const labels = (body.Description as Record<string, unknown>)
      .LocalizedLabels as Array<{ Label: string }>;
    expect(labels[0].Label).toBe("A description");
  });

  it("omits optional fields when not provided", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_simple",
      type: "String",
      display_name: "Simple",
    });
    expect(body.MaxLength).toBeUndefined();
    expect(body.MinValue).toBeUndefined();
    expect(body.MaxValue).toBeUndefined();
    expect(body.Precision).toBeUndefined();
    expect(body.Description).toBeUndefined();
  });

  it("generates SchemaName from logical_name", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_myfield",
      type: "String",
      display_name: "My Field",
    });
    expect(body.SchemaName).toBe("Contoso_myfield");
  });

  it("builds Boolean attribute with default Yes/No options", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_active",
      type: "Boolean",
      display_name: "Active",
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
    );
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.TrueOption.Value).toBe(1);
    expect(optionSet.FalseOption.Value).toBe(0);
    expect(optionSet.TrueOption.Label.LocalizedLabels[0].Label).toBe("Yes");
    expect(optionSet.FalseOption.Label.LocalizedLabels[0].Label).toBe("No");
  });

  it("builds Boolean attribute with custom options", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_verified",
      type: "Boolean",
      display_name: "Verified",
      options: [
        { label: "Unverified", value: 0 },
        { label: "Verified", value: 1 },
      ],
    });
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.TrueOption.Label.LocalizedLabels[0].Label).toBe("Verified");
    expect(optionSet.FalseOption.Label.LocalizedLabels[0].Label).toBe("Unverified");
  });

  it("builds Boolean attribute with reversed option order", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_reversed",
      type: "Boolean",
      display_name: "Reversed",
      options: [
        { label: "Yes", value: 1 },
        { label: "No", value: 0 },
      ],
    });
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.TrueOption.Value).toBe(1);
    expect(optionSet.TrueOption.Label.LocalizedLabels[0].Label).toBe("Yes");
    expect(optionSet.FalseOption.Value).toBe(0);
    expect(optionSet.FalseOption.Label.LocalizedLabels[0].Label).toBe("No");
  });

  it("builds Picklist attribute with options", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_status",
      type: "Picklist",
      display_name: "Status",
      options: [
        { label: "Active", value: 100000 },
        { label: "Inactive", value: 100001 },
        { label: "Pending", value: 100002 },
      ],
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
    );
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.Options).toHaveLength(3);
    expect(optionSet.Options[0].Value).toBe(100000);
    expect(optionSet.Options[0].Label.LocalizedLabels[0].Label).toBe("Active");
  });

  it("throws when Picklist has no options", () => {
    expect(() =>
      buildAttributeBody({
        logical_name: "contoso_status",
        type: "Picklist",
        display_name: "Status",
      }),
    ).toThrow("Picklist attributes require a non-empty 'options' array.");
  });

  describe("DateTime Format/Behavior", () => {
    it("builds DateOnly/DateOnly date-like column", () => {
      const body = buildAttributeBody({
        logical_name: "contoso_effectivedate",
        type: "DateTime",
        display_name: "Effective Date",
        date_format: "DateOnly",
        date_behavior: "DateOnly",
      });
      expect(body.Format).toBe("DateOnly");
      expect(body.DateTimeBehavior).toEqual({ Value: "DateOnly" });
    });

    it("builds TimeZoneIndependent datetime without setting Format", () => {
      const body = buildAttributeBody({
        logical_name: "contoso_event",
        type: "DateTime",
        display_name: "Event",
        date_behavior: "TimeZoneIndependent",
      });
      expect(body.Format).toBeUndefined();
      expect(body.DateTimeBehavior).toEqual({ Value: "TimeZoneIndependent" });
    });

    it("omits Format and DateTimeBehavior when not provided (Dataverse defaults apply)", () => {
      const body = buildAttributeBody({
        logical_name: "contoso_ts",
        type: "DateTime",
        display_name: "Timestamp",
      });
      expect(body.Format).toBeUndefined();
      expect(body.DateTimeBehavior).toBeUndefined();
    });

    it("rejects DateOnly format with a non-DateOnly behavior", () => {
      expect(() =>
        buildAttributeBody({
          logical_name: "contoso_bad",
          type: "DateTime",
          display_name: "Bad",
          date_format: "DateOnly",
          date_behavior: "UserLocal",
        }),
      ).toThrow(/DateOnly format requires DateOnly behavior, got: UserLocal/);
    });

    it("rejects date_format on a non-DateTime type", () => {
      expect(() =>
        buildAttributeBody({
          logical_name: "contoso_name",
          type: "String",
          display_name: "Name",
          date_format: "DateOnly",
        }),
      ).toThrow(/apply only to DateTime/);
    });

    it("rejects date_behavior on a non-DateTime type", () => {
      expect(() =>
        buildAttributeBody({
          logical_name: "contoso_count",
          type: "Integer",
          display_name: "Count",
          date_behavior: "UserLocal",
        }),
      ).toThrow(/apply only to DateTime/);
    });
  });
});

describe("update_attribute", () => {
  const existingAttribute = {
    "@odata.context": "https://org/api/data/v9.2/$metadata#EntityDefinitions(...)/Attributes/$entity",
    "@odata.etag": 'W/"12345"',
    "@odata.type": "#Microsoft.Dynamics.CRM.StringAttributeMetadata",
    MetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    LogicalName: "fundai_settledat",
    SchemaName: "Fundai_settledat",
    EntityLogicalName: "fundai_x",
    MaxLength: 200,
    RequiredLevel: { Value: "ApplicationRequired" },
    IsCustomAttribute: true,
    DisplayName: {
      LocalizedLabels: [{ Label: "Old Name", LanguageCode: 1033 }],
    },
  };

  function mockClient(current = existingAttribute) {
    return {
      get: vi.fn().mockResolvedValue(current),
      request: vi.fn().mockResolvedValue({}),
    } as any;
  }

  it("GETs with the concrete type cast and PUTs the base path with If-Match: *", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    const result = await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_settledat",
      type: "String",
      display_name: "Settled At",
    });

    const basePath =
      "/EntityDefinitions(LogicalName='fundai_x')/Attributes(LogicalName='fundai_settledat')";
    // GET must target the concrete derived-type cast — without it, type-specific
    // fields (MaxLength, Format, …) are missing from the response and would be
    // dropped from the PUT body, breaking the merge.
    expect(client.get).toHaveBeenCalledWith(
      `${basePath}/Microsoft.Dynamics.CRM.StringAttributeMetadata`,
    );

    expect(client.request).toHaveBeenCalledTimes(1);
    const [putPath, opts] = client.request.mock.calls[0];
    expect(putPath).toBe(basePath);
    expect(opts.method).toBe("PUT");
    // Dataverse metadata API does not expose ETags, so optimistic concurrency
    // via If-Match: <etag> isn't possible. Use "*" (matches Microsoft's own
    // docs example).
    expect(opts.headers["If-Match"]).toBe("*");
    expect(result.content[0].text).toContain("updated successfully");
  });

  it("uses the correct cast for each attribute type", async () => {
    for (const [userType, odataType] of [
      ["Integer", "Microsoft.Dynamics.CRM.IntegerAttributeMetadata"],
      ["Decimal", "Microsoft.Dynamics.CRM.DecimalAttributeMetadata"],
      ["Money", "Microsoft.Dynamics.CRM.MoneyAttributeMetadata"],
      ["DateTime", "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata"],
      ["Boolean", "Microsoft.Dynamics.CRM.BooleanAttributeMetadata"],
      ["Picklist", "Microsoft.Dynamics.CRM.PicklistAttributeMetadata"],
    ] as const) {
      const server = createMockServer();
      const client = mockClient();
      registerSchemaTools(server as any, client);

      await server.tools.get("update_attribute")!.handler({
        entity_logical_name: "fundai_x",
        attribute_logical_name: "fundai_col",
        type: userType,
        display_name: "X",
      });

      const getPath = client.get.mock.calls[0][0] as string;
      // Literal suffix check — RegExp would treat the dots in the odataType
      // as wildcards and pass on false positives.
      expect(getPath.endsWith(`/${odataType}`)).toBe(true);
    }
  });

  it("strips @odata.etag/@odata.context but keeps everything else from GET (merge preserves untouched fields)", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_settledat",
      type: "String",
      display_name: "Settled At",
    });

    const [, opts] = client.request.mock.calls[0];
    // discriminator reset to the plain @odata.type form expected by PUT
    expect(opts.body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    );
    // control metadata stripped
    expect(opts.body["@odata.etag"]).toBeUndefined();
    expect(opts.body["@odata.context"]).toBeUndefined();
    // untouched fields preserved from GET
    expect(opts.body.MetadataId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(opts.body.MaxLength).toBe(200);
    expect(opts.body.RequiredLevel).toEqual({ Value: "ApplicationRequired" });
    expect(opts.body.IsCustomAttribute).toBe(true);
    expect(opts.body.SchemaName).toBe("Fundai_settledat");
    // user-supplied field overrides
    expect(opts.body.DisplayName.LocalizedLabels[0].Label).toBe("Settled At");
  });

  it("user-supplied fields override values from GET", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_settledat",
      type: "String",
      required: "None",
      max_length: 500,
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.body.RequiredLevel).toEqual({ Value: "None" }); // was ApplicationRequired
    expect(opts.body.MaxLength).toBe(500); // was 200
  });

  it("sends MSCRM.MergeLabels header when merge_labels=true", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_settledat",
      type: "String",
      display_name: "Localized",
      merge_labels: true,
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.headers["MSCRM.MergeLabels"]).toBe("true");
    expect(opts.headers["If-Match"]).toBe("*");
  });

  it("does not send MSCRM.MergeLabels header by default", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_settledat",
      type: "String",
      display_name: "Replaced",
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.headers["MSCRM.MergeLabels"]).toBeUndefined();
  });

  it("returns isError when no mutable fields are provided (no-op guard); no HTTP calls made", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    const result = await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_col",
      type: "String",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at least one of");
    expect(client.get).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("preserves type-specific fields from the cast GET (MaxLength/Format for String)", async () => {
    const server = createMockServer();
    // Simulates what a cast GET to .../StringAttributeMetadata returns:
    // base fields + String-specific MaxLength and Format.
    const stringAttr = {
      ...existingAttribute,
      LogicalName: "fundai_email",
      SchemaName: "Fundai_email",
      "@odata.type": "#Microsoft.Dynamics.CRM.StringAttributeMetadata",
      MaxLength: 500,
      Format: "Email",
      FormatName: { Value: "Email" },
    };
    const client = mockClient(stringAttr as any);
    registerSchemaTools(server as any, client);

    // User only changes display_name — MaxLength/Format MUST survive.
    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_email",
      type: "String",
      display_name: "Email",
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.body.MaxLength).toBe(500);
    expect(opts.body.Format).toBe("Email");
    expect(opts.body.FormatName).toEqual({ Value: "Email" });
    // user-supplied override still wins
    expect(opts.body.DisplayName.LocalizedLabels[0].Label).toBe("Email");
  });

  it("forwards numeric bounds and precision via merge", async () => {
    const server = createMockServer();
    const client = mockClient({
      ...existingAttribute,
      // Identity fields must match the URL the handler is called with,
      // otherwise the test would pass even if the implementation PUT a body
      // whose identity didn't match (which would be a real bug).
      LogicalName: "fundai_amount",
      SchemaName: "Fundai_amount",
      "@odata.type": "#Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
      Precision: 2,
      MinValue: -1000,
      MaxValue: 1000,
    } as any);
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_amount",
      type: "Decimal",
      min_value: 0,
      max_value: 9999,
      precision: 4,
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
    );
    expect(opts.body.LogicalName).toBe("fundai_amount");
    expect(opts.body.SchemaName).toBe("Fundai_amount");
    expect(opts.body.MinValue).toBe(0);
    expect(opts.body.MaxValue).toBe(9999);
    expect(opts.body.Precision).toBe(4);
  });

  it("merges date_format and date_behavior into PUT body (DateTime)", async () => {
    const server = createMockServer();
    const client = mockClient({
      ...existingAttribute,
      LogicalName: "fundai_effectivedate",
      SchemaName: "Fundai_effectivedate",
      "@odata.type": "#Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
      Format: "DateAndTime",
      DateTimeBehavior: { Value: "UserLocal" },
    } as any);
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_effectivedate",
      type: "DateTime",
      date_format: "DateOnly",
      date_behavior: "DateOnly",
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.body.Format).toBe("DateOnly");
    expect(opts.body.DateTimeBehavior).toEqual({ Value: "DateOnly" });
  });

  it("rejects date_format on non-DateTime type without calling HTTP", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    await expect(
      server.tools.get("update_attribute")!.handler({
        entity_logical_name: "fundai_x",
        attribute_logical_name: "fundai_col",
        type: "String",
        date_format: "DateOnly",
      }),
    ).rejects.toThrow(/apply only to DateTime/);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects DateOnly format with mismatched behavior on update_attribute", async () => {
    const server = createMockServer();
    const client = mockClient();
    registerSchemaTools(server as any, client);

    await expect(
      server.tools.get("update_attribute")!.handler({
        entity_logical_name: "fundai_x",
        attribute_logical_name: "fundai_col",
        type: "DateTime",
        date_format: "DateOnly",
        date_behavior: "UserLocal",
      }),
    ).rejects.toThrow(/DateOnly format requires DateOnly behavior/);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("delete_attribute", () => {
  it("returns an error when allowDelete is false", async () => {
    const server = createMockServer();
    const client = { delete: vi.fn() } as any;
    registerSchemaTools(server as any, client, false);

    const tool = server.tools.get("delete_attribute")!;
    expect(tool.description).toContain("disabled");

    const result = await tool.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_col",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DATAVERSE_ALLOW_DELETE");
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("calls client.delete when allowDelete is true", async () => {
    const server = createMockServer();
    const client = { delete: vi.fn().mockResolvedValue({}) } as any;
    registerSchemaTools(server as any, client, true);

    const tool = server.tools.get("delete_attribute")!;
    expect(tool.description).not.toContain("currently disabled");
    expect(tool.description).toContain("PERMANENTLY DESTROYS");

    const result = await tool.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_col",
    });
    expect(client.delete).toHaveBeenCalledWith(
      "/EntityDefinitions(LogicalName='fundai_x')/Attributes(LogicalName='fundai_col')",
    );
    expect(result.content[0].text).toContain("permanently lost");
  });

  it("escapes single quotes in entity/attribute names to prevent OData injection", async () => {
    const server = createMockServer();
    const client = { delete: vi.fn().mockResolvedValue({}) } as any;
    registerSchemaTools(server as any, client, true);

    await server.tools.get("delete_attribute")!.handler({
      entity_logical_name: "weird'name",
      attribute_logical_name: "odd'col",
    });
    expect(client.delete).toHaveBeenCalledWith(
      "/EntityDefinitions(LogicalName='weird''name')/Attributes(LogicalName='odd''col')",
    );
  });
});

describe("get_attribute_dependencies_list_url", () => {
  const ORG_ID = "5c8ce4d5-a81e-e726-82d5-26ece5066319";
  const ENTITY_META = "08bb20a4-9d75-f011-b4cb-7ced8d703de4";
  const ATTR_META = "be1ee949-dc3f-f111-88b4-6045bd070a95";

  beforeEach(() => {
    _resetOrganizationIdCache();
  });

  function makeClient({
    whoami = { OrganizationId: ORG_ID },
    entity = { MetadataId: ENTITY_META },
    attr = { MetadataId: ATTR_META },
  }: {
    whoami?: unknown;
    entity?: unknown;
    attr?: unknown;
  } = {}) {
    return {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/WhoAmI") return Promise.resolve(whoami);
        if (path.includes("/Attributes(")) return Promise.resolve(attr);
        if (path.includes("/EntityDefinitions(")) return Promise.resolve(entity);
        throw new Error(`unexpected GET ${path}`);
      }),
    } as any;
  }

  it("returns the maker URL with the right GUIDs and metadata in the payload", async () => {
    const server = createMockServer();
    const client = makeClient();
    registerSchemaTools(server as any, client);

    const result = await server.tools
      .get("get_attribute_dependencies_list_url")!
      .handler({
        entity_logical_name: "fundai_achtransaction",
        attribute_logical_name: "fundai_settledat",
      });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toBe(
      `https://make.powerapps.com/environments/${ORG_ID}/entities/${ENTITY_META}/fields/${ATTR_META}`,
    );
    expect(payload.organization_id).toBe(ORG_ID);
    expect(payload.entity_metadata_id).toBe(ENTITY_META);
    expect(payload.attribute_metadata_id).toBe(ATTR_META);
    expect(payload.hint).toMatch(/Show dependencies/);
  });

  it("caches OrganizationId across multiple invocations (only one /WhoAmI call total)", async () => {
    const server = createMockServer();
    const client = makeClient();
    registerSchemaTools(server as any, client);

    const tool = server.tools.get("get_attribute_dependencies_list_url")!;
    await tool.handler({
      entity_logical_name: "e",
      attribute_logical_name: "a",
    });
    await tool.handler({
      entity_logical_name: "e2",
      attribute_logical_name: "a2",
    });
    await tool.handler({
      entity_logical_name: "e3",
      attribute_logical_name: "a3",
    });

    const whoamiCalls = client.get.mock.calls.filter(
      ([p]: [string]) => p === "/WhoAmI",
    );
    expect(whoamiCalls).toHaveLength(1);
  });

  it("escapes single quotes in logical names (OData injection)", async () => {
    const server = createMockServer();
    const client = makeClient();
    registerSchemaTools(server as any, client);

    await server.tools
      .get("get_attribute_dependencies_list_url")!
      .handler({
        entity_logical_name: "weird'entity",
        attribute_logical_name: "odd'col",
      });

    const paths = client.get.mock.calls.map(([p]: [string]) => p);
    expect(paths).toContain(
      "/EntityDefinitions(LogicalName='weird''entity')?$select=MetadataId",
    );
    expect(paths).toContain(
      "/EntityDefinitions(LogicalName='weird''entity')/Attributes(LogicalName='odd''col')?$select=MetadataId",
    );
  });

  it("throws if the attribute lookup returns no MetadataId", async () => {
    const server = createMockServer();
    const client = makeClient({ attr: {} });
    registerSchemaTools(server as any, client);

    await expect(
      server.tools.get("get_attribute_dependencies_list_url")!.handler({
        entity_logical_name: "fundai_x",
        attribute_logical_name: "missing_attr",
      }),
    ).rejects.toThrow(/Attribute not found: fundai_x\.missing_attr/);
  });

  it("throws if WhoAmI omits OrganizationId", async () => {
    const server = createMockServer();
    const client = makeClient({ whoami: {} });
    registerSchemaTools(server as any, client);

    await expect(
      server.tools.get("get_attribute_dependencies_list_url")!.handler({
        entity_logical_name: "e",
        attribute_logical_name: "a",
      }),
    ).rejects.toThrow(/OrganizationId/);
  });
});
