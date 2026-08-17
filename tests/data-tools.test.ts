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

describe("list_entities filters", () => {
  it("applies the prefix client-side when no solution is set", async () => {
    // Metadata entities answer HTTP 501 to `startswith`, so the filter must not
    // reach the server. Asserting on the generated filter string is what let this
    // ship broken: the assertion agreed with the code and neither agreed with
    // Dataverse.
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({
        value: [
          { LogicalName: "contoso_x" },
          { LogicalName: "account" },
          { LogicalName: "contoso_y" },
        ],
      }),
    } as any;
    registerDataTools(server as any, client, "contoso_");

    const result = await server.tools.get("list_entities")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(1);

    const url = client.get.mock.calls[0][0] as string;
    expect(url).not.toContain("startswith");
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("$filter")).toBeNull();

    // The prefix is honoured — just on the rows that came back
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.map((e: { LogicalName: string }) => e.LogicalName)).toEqual([
      "contoso_x",
      "contoso_y",
    ]);
  });

  it("returns every table when neither filter is set", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({
        value: [{ LogicalName: "account" }, { LogicalName: "contoso_x" }],
      }),
    } as any;
    registerDataTools(server as any, client);

    const result = await server.tools.get("list_entities")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toHaveLength(2);
  });

  it("follows @odata.nextLink when the unfiltered read is paginated", async () => {
    // The prefix is applied to whatever comes back, so a dropped page would
    // silently shrink the result rather than fail.
    const server = createMockServer();
    const nextLink =
      "https://org.crm.dynamics.com/api/data/v9.2/EntityDefinitions?$skiptoken=page2";
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          value: [{ LogicalName: "contoso_a" }],
          "@odata.nextLink": nextLink,
        })
        .mockResolvedValueOnce({
          value: [{ LogicalName: "contoso_b" }, { LogicalName: "account" }],
        }),
    } as any;
    registerDataTools(server as any, client, "contoso_");

    const result = await server.tools.get("list_entities")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get.mock.calls[1][0]).toBe(nextLink);

    // A table on page 2 must survive the prefix filter
    expect(
      JSON.parse(result.content[0].text).map(
        (e: { LogicalName: string }) => e.LogicalName,
      ),
    ).toEqual(["contoso_a", "contoso_b"]);
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

describe("get_entity_schema", () => {
  // Choice rows are keyed by the cast that should return them, mirroring how
  // Dataverse answers: a cast that does not match yields an empty collection.
  function schemaClient(
    base: Array<Record<string, unknown>>,
    byCast: Record<string, Array<Record<string, unknown>>> = {},
  ) {
    return {
      get: vi.fn(async (url: string) => {
        const cast = url.match(/Microsoft\.Dynamics\.CRM\.(\w+)/)?.[1];
        if (!cast) return { value: base };
        return { value: byCast[cast] ?? [] };
      }),
    } as any;
  }

  const STRING_ATTR = {
    LogicalName: "name",
    AttributeType: "String",
    IsCustomAttribute: false,
  };
  const PICKLIST_ATTR = {
    LogicalName: "fundai_source",
    AttributeType: "Picklist",
    IsCustomAttribute: true,
  };

  it("issues the base request plus one cast request per concrete choice type", async () => {
    const server = createMockServer();
    const client = schemaClient([STRING_ATTR]);
    registerDataTools(server as any, client);

    await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    const urls = client.get.mock.calls.map((c: unknown[]) => c[0] as string);
    const baseUrl = urls.find(
      (u) => !u.includes("Microsoft.Dynamics.CRM."),
    ) as string;
    const castUrls = urls.filter((u) => u.includes("Microsoft.Dynamics.CRM."));

    expect(baseUrl).toContain(
      "/EntityDefinitions(LogicalName='opportunity')/Attributes?",
    );
    // The abstract EnumAttributeMetadata cast is rejected by Dataverse with a 500,
    // so each concrete choice type must be requested on its own.
    expect(castUrls.map((u) => u.match(/CRM\.(\w+)/)![1]).sort()).toEqual([
      "MultiSelectPicklistAttributeMetadata",
      "PicklistAttributeMetadata",
      "StateAttributeMetadata",
      "StatusAttributeMetadata",
    ]);
    expect(urls.some((u) => u.includes("EnumAttributeMetadata"))).toBe(false);

    const qs = new URLSearchParams(
      castUrls[0].slice(castUrls[0].indexOf("?") + 1),
    );
    expect(qs.get("$select")).toBe("LogicalName");
    expect(qs.get("$expand")).toBe(
      "OptionSet($select=Name,IsGlobal,MetadataId,Options)",
    );
  });

  it("attaches an option_set summary to a globally-bound choice column", async () => {
    const server = createMockServer();
    const client = schemaClient([PICKLIST_ATTR], {
      PicklistAttributeMetadata: [
        {
          LogicalName: "fundai_source",
          OptionSet: {
            Name: "fundai_source",
            IsGlobal: true,
            MetadataId: "8f2c0000-0000-0000-0000-00000000abcd",
            Options: [{ Value: 1 }, { Value: 2 }, { Value: 3 }],
          },
        },
      ],
    });
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].option_set).toEqual({
      name: "fundai_source",
      is_global: true,
      metadata_id: "8f2c0000-0000-0000-0000-00000000abcd",
      option_count: 3,
    });
    // The base fields are preserved alongside the new summary
    expect(parsed[0].AttributeType).toBe("Picklist");
  });

  it("reports is_global=false for a column holding a local copy", async () => {
    const server = createMockServer();
    const client = schemaClient([PICKLIST_ATTR], {
      PicklistAttributeMetadata: [
        {
          LogicalName: "fundai_source",
          OptionSet: {
            Name: "opportunity_fundai_source",
            IsGlobal: false,
            MetadataId: "44444444-4444-4444-4444-444444444444",
            Options: [{ Value: 1 }],
          },
        },
      ],
    });
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    expect(JSON.parse(result.content[0].text)[0].option_set.is_global).toBe(
      false,
    );
  });

  it("does not return the option values themselves, only their count", async () => {
    const server = createMockServer();
    const client = schemaClient([PICKLIST_ATTR], {
      PicklistAttributeMetadata: [
        {
          LogicalName: "fundai_source",
          OptionSet: {
            Name: "fundai_source",
            IsGlobal: true,
            Options: [
              { Value: 1, Label: { UserLocalizedLabel: { Label: "Website" } } },
            ],
          },
        },
      ],
    });
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    const text = result.content[0].text;
    expect(text).not.toContain("Website");
    expect(JSON.parse(text)[0].option_set.option_count).toBe(1);
  });

  it("leaves non-choice attributes without an option_set field", async () => {
    const server = createMockServer();
    const client = schemaClient([STRING_ATTR, PICKLIST_ATTR], {
      PicklistAttributeMetadata: [
        {
          LogicalName: "fundai_source",
          OptionSet: { Name: "fundai_source", IsGlobal: true, Options: [] },
        },
      ],
    });
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0]).not.toHaveProperty("option_set");
    expect(parsed[1]).toHaveProperty("option_set");
  });

  it("covers Status and State columns via the same Enum cast", async () => {
    const server = createMockServer();
    const client = schemaClient(
      [
        { LogicalName: "statecode", AttributeType: "State" },
        { LogicalName: "statuscode", AttributeType: "Status" },
      ],
      {
        StateAttributeMetadata: [
          {
            LogicalName: "statecode",
            OptionSet: {
              Name: "opportunity_statecode",
              IsGlobal: false,
              Options: [{ Value: 0 }, { Value: 1 }],
            },
          },
        ],
        StatusAttributeMetadata: [
          {
            LogicalName: "statuscode",
            OptionSet: {
              Name: "opportunity_statuscode",
              IsGlobal: false,
              Options: [{ Value: 1 }],
            },
          },
        ],
      },
    );
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].option_set.option_count).toBe(2);
    expect(parsed[1].option_set.option_count).toBe(1);
  });

  it("still returns the attribute list when a cast request fails, and says so", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn(async (url: string) => {
        if (url.includes("StateAttributeMetadata")) {
          throw new Error("Dataverse API error (503): service unavailable");
        }
        if (url.includes("PicklistAttributeMetadata")) {
          return {
            value: [
              {
                LogicalName: "fundai_source",
                OptionSet: {
                  Name: "fundai_source",
                  IsGlobal: true,
                  Options: [{ Value: 1 }],
                },
              },
            ],
          };
        }
        if (url.includes("Microsoft.Dynamics.CRM.")) return { value: [] };
        return { value: [STRING_ATTR, PICKLIST_ATTR] };
      }),
    } as any;
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    // The base list survives an enrichment failure, and stays in content[0]
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].option_set.is_global).toBe(true);

    // ...but the partial coverage is stated, not left to be inferred
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain("INCOMPLETE");
    expect(result.content[1].text).toContain("StateAttributeMetadata");
    expect(result.content[1].text).toContain("503");
  });

  it("reports a choice column that came back without an OptionSet", async () => {
    // Dropping it would leave the column with no option_set at all, which reads
    // as "not a choice column" — an answer, and the wrong one.
    const server = createMockServer();
    const client = schemaClient([PICKLIST_ATTR], {
      PicklistAttributeMetadata: [{ LogicalName: "fundai_source" }],
    });
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0]).not.toHaveProperty("option_set");

    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain("INCOMPLETE");
    expect(result.content[1].text).toContain("returned no OptionSet");
    expect(result.content[1].text).toContain("fundai_source");
  });

  it("emits no warning block when every cast succeeds", async () => {
    const server = createMockServer();
    const client = schemaClient([STRING_ATTR]);
    registerDataTools(server as any, client);

    const result = await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "opportunity" });

    expect(result.content).toHaveLength(1);
  });

  it("fails when the base attribute request itself fails", async () => {
    // Degrading is only right for the enrichment — without the base list there is
    // nothing worth returning.
    const server = createMockServer();
    const client = {
      get: vi.fn(async (url: string) => {
        if (url.includes("Microsoft.Dynamics.CRM.")) return { value: [] };
        throw new Error("Dataverse API error (404): table not found");
      }),
    } as any;
    registerDataTools(server as any, client);

    await expect(
      server.tools
        .get("get_entity_schema")!
        .handler({ entity_logical_name: "nope" }),
    ).rejects.toThrow(/404/);
  });

  it("escapes single quotes in the entity logical name on both requests", async () => {
    const server = createMockServer();
    const client = schemaClient([]);
    registerDataTools(server as any, client);

    await server.tools
      .get("get_entity_schema")!
      .handler({ entity_logical_name: "o'brien" });

    for (const call of client.get.mock.calls) {
      expect(call[0] as string).toContain("LogicalName='o''brien'");
    }
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
