import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../../src/tools/all.js";
import { createMockServer, stdio } from "../helpers.js";

describe("add_picklist_option", () => {
  it("posts InsertOptionValue with EntityLogicalName/AttributeLogicalName for Local", async () => {
    const server = createMockServer();
    const client = {
      post: vi.fn().mockResolvedValue({ NewOptionValue: 909890007 }),
    } as any;
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio() });

    const result = await server.tools.get("update_picklist_option")!.handler({
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
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio(true) });

    const result = await server.tools.get("delete_picklist_option")!.handler({
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
    registerAllTools(server as any, {
      client: { post: vi.fn() } as any,
      ...stdio(true),
    });
    const tool = server.tools.get("delete_picklist_option")!;
    expect(tool.description.toLowerCase()).toContain("orphan");
  });

  it("returns isError when allowDelete is false (default)", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio() });

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
