import { describe, expect, it, vi } from "vitest";
import {
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
});

describe("update_attribute", () => {
  it("PATCHes only the provided fields with the correct @odata.type", async () => {
    const server = createMockServer();
    const client = { request: vi.fn().mockResolvedValue({}) } as any;
    registerSchemaTools(server as any, client);

    const result = await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_settledat",
      type: "String",
      display_name: "Settled At",
      required: "None",
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    const [path, opts] = client.request.mock.calls[0];
    expect(path).toBe(
      "/EntityDefinitions(LogicalName='fundai_x')/Attributes(LogicalName='fundai_settledat')",
    );
    expect(opts.method).toBe("PATCH");
    expect(opts.body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    );
    expect(opts.body.DisplayName.LocalizedLabels[0].Label).toBe("Settled At");
    expect(opts.body.RequiredLevel).toEqual({ Value: "None" });
    expect(opts.body.Description).toBeUndefined();
    expect(opts.body.MaxLength).toBeUndefined();
    expect(result.content[0].text).toContain("updated successfully");
  });

  it("sends MSCRM.MergeLabels header when merge_labels=true", async () => {
    const server = createMockServer();
    const client = { request: vi.fn().mockResolvedValue({}) } as any;
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_col",
      type: "String",
      display_name: "Localized",
      merge_labels: true,
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.headers["MSCRM.MergeLabels"]).toBe("true");
  });

  it("does not send MSCRM.MergeLabels header by default", async () => {
    const server = createMockServer();
    const client = { request: vi.fn().mockResolvedValue({}) } as any;
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_col",
      type: "String",
      display_name: "Replaced",
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.headers["MSCRM.MergeLabels"]).toBeUndefined();
  });

  it("forwards numeric bounds and precision", async () => {
    const server = createMockServer();
    const client = { request: vi.fn().mockResolvedValue({}) } as any;
    registerSchemaTools(server as any, client);

    await server.tools.get("update_attribute")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_amount",
      type: "Decimal",
      min_value: 0,
      max_value: 1000,
      precision: 4,
    });

    const [, opts] = client.request.mock.calls[0];
    expect(opts.body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
    );
    expect(opts.body.MinValue).toBe(0);
    expect(opts.body.MaxValue).toBe(1000);
    expect(opts.body.Precision).toBe(4);
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
