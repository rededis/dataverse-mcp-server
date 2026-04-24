import { describe, expect, it, vi } from "vitest";
import { registerPicklistTools } from "../src/tools/picklist-tools.js";

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

describe("picklist location XOR validation", () => {
  const toolNames = [
    "add_picklist_option",
    "update_picklist_option",
    "delete_picklist_option",
    "get_picklist_options",
  ];

  for (const name of toolNames) {
    it(`${name}: throws when both Local and Global fields are provided`, async () => {
      const server = createMockServer();
      const client = { post: vi.fn(), get: vi.fn() } as any;
      // allowDelete=true so the delete_picklist_option real handler (not the stub) is registered
      registerPicklistTools(server as any, client, true);

      await expect(
        server.tools.get(name)!.handler({
          entity_logical_name: "fundai_x",
          attribute_logical_name: "fundai_status",
          option_set_name: "MyGlobalSet",
          label: "L",
          value: 1,
        }),
      ).rejects.toThrow(/mutually exclusive/);
    });

    it(`${name}: throws when neither Local pair nor Global is provided`, async () => {
      const server = createMockServer();
      const client = { post: vi.fn(), get: vi.fn() } as any;
      registerPicklistTools(server as any, client, true);

      await expect(
        server.tools.get(name)!.handler({ label: "L", value: 1 }),
      ).rejects.toThrow(/Provide either/);
    });

    it(`${name}: throws when Local pair is incomplete (entity only)`, async () => {
      const server = createMockServer();
      const client = { post: vi.fn(), get: vi.fn() } as any;
      registerPicklistTools(server as any, client, true);

      await expect(
        server.tools.get(name)!.handler({
          entity_logical_name: "fundai_x",
          label: "L",
          value: 1,
        }),
      ).rejects.toThrow(/Provide either/);
    });
  }
});

describe("add_picklist_option", () => {
  it("posts InsertOptionValue with EntityLogicalName/AttributeLogicalName for Local", async () => {
    const server = createMockServer();
    const client = {
      post: vi.fn().mockResolvedValue({ NewOptionValue: 909890007 }),
    } as any;
    registerPicklistTools(server as any, client);

    const result = await server.tools.get("add_picklist_option")!.handler({
      entity_logical_name: "fundai_achtransaction",
      attribute_logical_name: "fundai_transactionstatus",
      value: 909890007,
      label: "Queued",
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe("/InsertOptionValue");
    expect(body.EntityLogicalName).toBe("fundai_achtransaction");
    expect(body.AttributeLogicalName).toBe("fundai_transactionstatus");
    expect(body.OptionSetName).toBeUndefined();
    expect(body.Value).toBe(909890007);
    expect(body.Label.LocalizedLabels[0].Label).toBe("Queued");
    expect(body.Label.LocalizedLabels[0].LanguageCode).toBe(1033);
    expect(result.content[0].text).toContain("909890007");
  });

  it("posts InsertOptionValue with OptionSetName for Global", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerPicklistTools(server as any, client);

    await server.tools.get("add_picklist_option")!.handler({
      option_set_name: "MyGlobalSet",
      label: "Active",
    });

    const [, body] = client.post.mock.calls[0];
    expect(body.OptionSetName).toBe("MyGlobalSet");
    expect(body.EntityLogicalName).toBeUndefined();
    expect(body.AttributeLogicalName).toBeUndefined();
  });

  it("omits Value when not provided (Dataverse assigns next free)", async () => {
    const server = createMockServer();
    const client = {
      post: vi.fn().mockResolvedValue({ NewOptionValue: 100000042 }),
    } as any;
    registerPicklistTools(server as any, client);

    await server.tools.get("add_picklist_option")!.handler({
      option_set_name: "MyGlobalSet",
      label: "Auto",
    });

    const [, body] = client.post.mock.calls[0];
    expect(body.Value).toBeUndefined();
  });

  it("includes Description and SolutionUniqueName when provided", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerPicklistTools(server as any, client);

    await server.tools.get("add_picklist_option")!.handler({
      option_set_name: "MyGlobalSet",
      label: "Important",
      description: "High priority items",
      solution_unique_name: "FundaiCleanSolution",
      language_code: 1049,
    });

    const [, body] = client.post.mock.calls[0];
    expect(body.Label.LocalizedLabels[0].LanguageCode).toBe(1049);
    expect(body.Description.LocalizedLabels[0].Label).toBe(
      "High priority items",
    );
    expect(body.Description.LocalizedLabels[0].LanguageCode).toBe(1049);
    expect(body.SolutionUniqueName).toBe("FundaiCleanSolution");
  });
});

describe("update_picklist_option", () => {
  it("posts UpdateOptionValue with Value, Label and MergeLabels=false by default", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerPicklistTools(server as any, client);

    const result = await server.tools
      .get("update_picklist_option")!
      .handler({
        entity_logical_name: "fundai_x",
        attribute_logical_name: "fundai_status",
        value: 100000000,
        label: "Renamed",
      });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe("/UpdateOptionValue");
    expect(body.Value).toBe(100000000);
    expect(body.Label.LocalizedLabels[0].Label).toBe("Renamed");
    expect(body.EntityLogicalName).toBe("fundai_x");
    // MergeLabels is required by Dataverse — default false = replace localized labels
    expect(body.MergeLabels).toBe(false);
    expect(result.content[0].text).toContain("100000000");
    expect(result.content[0].text).toContain("updated successfully");
  });

  it("forwards merge_labels=true to MergeLabels", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerPicklistTools(server as any, client);

    await server.tools.get("update_picklist_option")!.handler({
      option_set_name: "MyGlobalSet",
      value: 1,
      label: "Updated",
      merge_labels: true,
    });

    const [, body] = client.post.mock.calls[0];
    expect(body.MergeLabels).toBe(true);
  });
});

describe("delete_picklist_option", () => {
  it("posts DeleteOptionValue with Value and location when allowDelete is true", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerPicklistTools(server as any, client, true);

    const result = await server.tools
      .get("delete_picklist_option")!
      .handler({
        option_set_name: "MyGlobalSet",
        value: 909890009,
      });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe("/DeleteOptionValue");
    expect(body.Value).toBe(909890009);
    expect(body.OptionSetName).toBe("MyGlobalSet");
    expect(result.content[0].text).toContain("909890009");
    expect(result.content[0].text).toContain("deleted successfully");
  });

  it("description warns about orphan values when allowDelete is true", async () => {
    const server = createMockServer();
    registerPicklistTools(server as any, { post: vi.fn() } as any, true);
    const tool = server.tools.get("delete_picklist_option")!;
    expect(tool.description.toLowerCase()).toContain("orphan");
  });

  it("returns isError when allowDelete is false (default)", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerPicklistTools(server as any, client);

    const tool = server.tools.get("delete_picklist_option")!;
    expect(tool.description).toContain("disabled");

    const result = await tool.handler({
      option_set_name: "MyGlobalSet",
      value: 909890009,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DATAVERSE_ALLOW_DELETE");
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("get_picklist_options", () => {
  it("reads and flattens options for a Local picklist", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({
        value: [
          {
            OptionSet: {
              Options: [
                {
                  Value: 100000000,
                  Label: {
                    UserLocalizedLabel: { Label: "Active", LanguageCode: 1033 },
                    LocalizedLabels: [
                      { Label: "Active", LanguageCode: 1033 },
                    ],
                  },
                },
                {
                  Value: 100000001,
                  Label: {
                    LocalizedLabels: [
                      { Label: "Inactive", LanguageCode: 1033 },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
    } as any;
    registerPicklistTools(server as any, client);

    const result = await server.tools.get("get_picklist_options")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_status",
    });

    const url = client.get.mock.calls[0][0] as string;
    expect(url).toContain(
      "/EntityDefinitions(LogicalName='fundai_x')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
    );
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("$filter")).toBe("LogicalName eq 'fundai_status'");
    expect(qs.get("$select")).toBe("LogicalName");
    expect(qs.get("$expand")).toBe("OptionSet($select=Options)");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      { value: 100000000, label: "Active" },
      { value: 100000001, label: "Inactive" },
    ]);
  });

  it("reads and flattens options for a Global OptionSet via keyed access (single-object response)", async () => {
    const server = createMockServer();
    // Dataverse returns a single OptionSetMetadata object here, NOT wrapped in { value: [...] }
    const client = {
      get: vi.fn().mockResolvedValue({
        Options: [
          {
            Value: 1,
            Label: {
              UserLocalizedLabel: { Label: "One", LanguageCode: 1033 },
            },
          },
        ],
      }),
    } as any;
    registerPicklistTools(server as any, client);

    const result = await server.tools.get("get_picklist_options")!.handler({
      option_set_name: "MyGlobalSet",
    });

    const url = client.get.mock.calls[0][0] as string;
    expect(url).toContain(
      "/GlobalOptionSetDefinitions(Name='MyGlobalSet')/Microsoft.Dynamics.CRM.OptionSetMetadata",
    );
    // $filter is NOT supported on this path — must use keyed access
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("$filter")).toBeNull();
    expect(qs.get("$select")).toBe("Options");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([{ value: 1, label: "One" }]);
  });

  it("throws when Local picklist attribute is not found", async () => {
    const server = createMockServer();
    const client = { get: vi.fn().mockResolvedValue({ value: [] }) } as any;
    registerPicklistTools(server as any, client);

    await expect(
      server.tools.get("get_picklist_options")!.handler({
        entity_logical_name: "fundai_x",
        attribute_logical_name: "missing_attr",
      }),
    ).rejects.toThrow(/Picklist attribute not found/);
  });

  it("throws a helpful error when Global OptionSet returns 404", async () => {
    const server = createMockServer();
    const client = {
      get: vi
        .fn()
        .mockRejectedValue(new Error("Dataverse API error (404): not found")),
    } as any;
    registerPicklistTools(server as any, client);

    await expect(
      server.tools.get("get_picklist_options")!.handler({
        option_set_name: "Missing",
      }),
    ).rejects.toThrow(/Global OptionSet not found: 'Missing'/);
  });

  it("returns empty array when Global OptionSet has no Options", async () => {
    const server = createMockServer();
    const client = { get: vi.fn().mockResolvedValue({ Options: [] }) } as any;
    registerPicklistTools(server as any, client);

    const result = await server.tools.get("get_picklist_options")!.handler({
      option_set_name: "Empty",
    });
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it("returns null label gracefully when no localized label exists", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({
        value: [
          {
            OptionSet: {
              Options: [{ Value: 42, Label: { LocalizedLabels: [] } }],
            },
          },
        ],
      }),
    } as any;
    registerPicklistTools(server as any, client);

    const result = await server.tools.get("get_picklist_options")!.handler({
      entity_logical_name: "fundai_x",
      attribute_logical_name: "fundai_status",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([{ value: 42, label: null }]);
  });
});
