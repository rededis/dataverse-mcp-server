import { describe, expect, it, vi } from "vitest";
import { registerDataTools } from "../src/tools/data-tools.js";

function createMockServer() {
  const tools = new Map<string, { description: string; handler: Function }>();
  return {
    tool: vi.fn(
      (name: string, description: string, _schema: unknown, handler: Function) => {
        tools.set(name, { description, handler });
      },
    ),
    tools,
  };
}

const mockClient = {} as Parameters<typeof registerDataTools>[1];

describe("list_solutions", () => {
  it("queries /solutions excluding managed by default", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({ value: [{ uniquename: "Default" }] }),
    } as any;
    registerDataTools(server as any, client);

    const tool = server.tools.get("list_solutions");
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(client.get).toHaveBeenCalledTimes(1);
    const url = client.get.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/solutions\?/);
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("$filter")).toBe("isvisible eq true and ismanaged eq false");
    expect(qs.get("$select")).toContain("uniquename");
    expect(result.content[0].text).toContain("Default");
  });

  it("includes managed solutions when include_managed=true", async () => {
    const server = createMockServer();
    const client = { get: vi.fn().mockResolvedValue({ value: [] }) } as any;
    registerDataTools(server as any, client);

    await server.tools.get("list_solutions")!.handler({ include_managed: true });
    const url = client.get.mock.calls[0][0] as string;
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("$filter")).toBe("isvisible eq true");
  });

  it("follows @odata.nextLink when solutions response is paginated", async () => {
    const server = createMockServer();
    const nextLink =
      "https://org.crm.dynamics.com/api/data/v9.2/solutions?$skiptoken=page2";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          value: [{ uniquename: "A" }],
          "@odata.nextLink": nextLink,
        })
        .mockResolvedValueOnce({ value: [{ uniquename: "B" }] }),
    } as any;
    registerDataTools(server as any, client);

    const result = await server.tools.get("list_solutions")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get.mock.calls[1][0]).toBe(nextLink);
    expect(result.content[0].text).toContain('"A"');
    expect(result.content[0].text).toContain('"B"');
  });
});

describe("list_entities solution filter", () => {
  it("uses prefix only when no solution is set", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({ value: [{ LogicalName: "contoso_x" }] }),
    } as any;
    registerDataTools(server as any, client, "contoso_");

    await server.tools.get("list_entities")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(1);
    const url = client.get.mock.calls[0][0] as string;
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("$filter")).toBe("startswith(LogicalName,'contoso_')");
  });

  it("resolves solution to entity MetadataIds and filters", async () => {
    const server = createMockServer();
    const solutionId = "11111111-1111-1111-1111-111111111111";
    const entityA = "22222222-2222-2222-2222-222222222222";
    const entityB = "33333333-3333-3333-3333-333333333333";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ value: [{ solutionid: solutionId }] })
        .mockResolvedValueOnce({
          value: [{ objectid: entityA }, { objectid: entityB }],
        })
        .mockResolvedValueOnce({
          value: [{ LogicalName: "contoso_a" }, { LogicalName: "contoso_b" }],
        }),
    } as any;
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("list_entities")!
      .handler({ solution: "MySolution" });

    expect(client.get).toHaveBeenCalledTimes(3);
    const solutionsUrl = client.get.mock.calls[0][0] as string;
    expect(solutionsUrl).toMatch(/^\/solutions\?/);
    expect(
      new URLSearchParams(solutionsUrl.slice(solutionsUrl.indexOf("?") + 1)).get(
        "$filter",
      ),
    ).toBe("uniquename eq 'MySolution'");

    const componentsUrl = client.get.mock.calls[1][0] as string;
    expect(componentsUrl).toMatch(/^\/solutioncomponents\?/);
    const componentsQs = new URLSearchParams(
      componentsUrl.slice(componentsUrl.indexOf("?") + 1),
    );
    expect(componentsQs.get("$filter")).toBe(
      `_solutionid_value eq ${solutionId} and componenttype eq 1`,
    );

    const entitiesUrl = client.get.mock.calls[2][0] as string;
    expect(entitiesUrl).toMatch(/^\/EntityDefinitions\?/);
    const entitiesQs = new URLSearchParams(
      entitiesUrl.slice(entitiesUrl.indexOf("?") + 1),
    );
    expect(entitiesQs.get("$filter")).toBe(
      `(MetadataId eq ${entityA} or MetadataId eq ${entityB})`,
    );
    expect(result.content[0].text).toContain("contoso_a");
    expect(result.content[0].text).toContain("contoso_b");
  });

  it("applies prefix client-side when combined with solution (Dataverse rejects startswith+or on metadata)", async () => {
    const server = createMockServer();
    const solutionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const entityA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const entityB = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ value: [{ solutionid: solutionId }] })
        .mockResolvedValueOnce({
          value: [{ objectid: entityA }, { objectid: entityB }],
        })
        .mockResolvedValueOnce({
          value: [
            { LogicalName: "contoso_a" },
            { LogicalName: "account" },
          ],
        }),
    } as any;
    registerDataTools(server as any, client, "contoso_");

    const result = await server.tools
      .get("list_entities")!
      .handler({ solution: "MySolution" });

    const entitiesUrl = client.get.mock.calls[2][0] as string;
    const entitiesQs = new URLSearchParams(
      entitiesUrl.slice(entitiesUrl.indexOf("?") + 1),
    );
    // prefix MUST NOT be in the OData filter — it is applied client-side
    expect(entitiesQs.get("$filter")).toBe(
      `(MetadataId eq ${entityA} or MetadataId eq ${entityB})`,
    );
    expect(result.content[0].text).toContain("contoso_a");
    expect(result.content[0].text).not.toContain("account");
  });

  it("uses default solution when parameter omitted", async () => {
    const server = createMockServer();
    const solutionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ value: [{ solutionid: solutionId }] })
        .mockResolvedValueOnce({ value: [] }),
    } as any;
    registerDataTools(server as any, client, undefined, false, "DefaultSol");

    const result = await server.tools.get("list_entities")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(2);
    const solutionsUrl = client.get.mock.calls[0][0] as string;
    const solutionsQs = new URLSearchParams(
      solutionsUrl.slice(solutionsUrl.indexOf("?") + 1),
    );
    expect(solutionsQs.get("$filter")).toBe("uniquename eq 'DefaultSol'");
    expect(result.content[0].text).toBe("[]");
  });

  it("empty-string solution parameter disables default solution filter", async () => {
    const server = createMockServer();
    const client = { get: vi.fn().mockResolvedValue({ value: [] }) } as any;
    registerDataTools(server as any, client, undefined, false, "DefaultSol");

    await server.tools.get("list_entities")!.handler({ solution: "" });
    expect(client.get).toHaveBeenCalledTimes(1);
    const url = client.get.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/EntityDefinitions/);
    expect(url).not.toContain("%24filter");
  });

  it("throws a helpful error when solution is not found", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValueOnce({ value: [] }),
    } as any;
    registerDataTools(server as any, client);

    await expect(
      server.tools.get("list_entities")!.handler({ solution: "Missing" }),
    ).rejects.toThrow(/Solution not found: 'Missing'/);
  });

  it("returns empty array when solution has no entity components", async () => {
    const server = createMockServer();
    const solutionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ value: [{ solutionid: solutionId }] })
        .mockResolvedValueOnce({ value: [] }),
    } as any;
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("list_entities")!
      .handler({ solution: "Empty" });
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toBe("[]");
  });

  it("follows @odata.nextLink when solutioncomponents is paginated", async () => {
    const server = createMockServer();
    const solutionId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const entityA = "11111111-2222-3333-4444-555555555555";
    const entityB = "22222222-3333-4444-5555-666666666666";
    const nextLink =
      "https://org.crm.dynamics.com/api/data/v9.2/solutioncomponents?$skiptoken=page2";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ value: [{ solutionid: solutionId }] })
        .mockResolvedValueOnce({
          value: [{ objectid: entityA }],
          "@odata.nextLink": nextLink,
        })
        .mockResolvedValueOnce({ value: [{ objectid: entityB }] })
        .mockResolvedValueOnce({ value: [] }),
    } as any;
    registerDataTools(server as any, client);

    await server.tools
      .get("list_entities")!
      .handler({ solution: "Paged" });

    // solutions + components page1 + components page2 + entities chunk
    expect(client.get).toHaveBeenCalledTimes(4);
    expect(client.get.mock.calls[2][0]).toBe(nextLink);

    const entitiesUrl = client.get.mock.calls[3][0] as string;
    const entitiesQs = new URLSearchParams(
      entitiesUrl.slice(entitiesUrl.indexOf("?") + 1),
    );
    expect(entitiesQs.get("$filter")).toBe(
      `(MetadataId eq ${entityA} or MetadataId eq ${entityB})`,
    );
  });

  it("chunks large MetadataId lists into multiple EntityDefinitions calls", async () => {
    const server = createMockServer();
    const solutionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const ids = Array.from({ length: 120 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    );
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ value: [{ solutionid: solutionId }] })
        .mockResolvedValueOnce({
          value: ids.map((objectid) => ({ objectid })),
        })
        .mockResolvedValue({ value: [] }),
    } as any;
    registerDataTools(server as any, client);

    await server.tools
      .get("list_entities")!
      .handler({ solution: "Huge" });

    // 1 solutions + 1 components + ceil(120 / 50) = 3 entity chunks = 5 total
    expect(client.get).toHaveBeenCalledTimes(5);
  });
});

describe("registerDataTools allowDelete", () => {
  it("delete_record returns error when allowDelete is false", async () => {
    const server = createMockServer();
    registerDataTools(server as any, mockClient, undefined, false);

    const deleteTool = server.tools.get("delete_record");
    expect(deleteTool).toBeDefined();
    expect(deleteTool!.description).toContain("disabled");

    const result = await deleteTool!.handler({ entity_set: "leads", id: "123" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DATAVERSE_ALLOW_DELETE");
  });

  it("delete_record calls client.delete when allowDelete is true", async () => {
    const server = createMockServer();
    const client = { delete: vi.fn() } as any;
    registerDataTools(server as any, client, undefined, true);

    const deleteTool = server.tools.get("delete_record");
    expect(deleteTool).toBeDefined();
    expect(deleteTool!.description).not.toContain("disabled");

    await deleteTool!.handler({ entity_set: "leads", id: "123" });
    expect(client.delete).toHaveBeenCalledWith("/leads(123)");
  });
});
