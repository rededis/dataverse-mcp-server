import { describe, expect, it, vi } from "vitest";
import type { DataverseClient } from "../src/client.js";
import { registerDataReadTools } from "../src/tools/data-read.js";
import { EntitySetCatalog } from "../src/tools/shared/paths.js";
import { createMockServer, GUID } from "./helpers.js";

function readTools(client: unknown, entitySets?: EntitySetCatalog) {
  const server = createMockServer();
  registerDataReadTools(server as any, {
    client: client as DataverseClient,
    entitySets,
  });
  return server.tools;
}

describe("path arguments of the read tools", () => {
  it.each([
    "accounts/../WhoAmI",
    "accounts(1)",
    "accounts?$top=1",
  ])("query_records refuses the entity set %j", async (entity_set) => {
    const client = { get: vi.fn() };
    await expect(
      readTools(client).get("query_records")!.handler({ entity_set }),
    ).rejects.toThrow(/Invalid entity set name/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("get_record refuses an id that is not a GUID", async () => {
    const client = { get: vi.fn() };
    await expect(
      readTools(client)
        .get("get_record")!
        .handler({ entity_set: "accounts", id: `${GUID})/../contacts(${GUID}` }),
    ).rejects.toThrow(/Invalid record id/);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("EntitySetCatalog", () => {
  function metadataClient(known: string[]) {
    return {
      get: vi.fn(async (path: string) => {
        const filter = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get(
          "$filter",
        );
        const name = /EntitySetName eq '(.*)'$/.exec(filter ?? "")?.[1];
        return {
          value: known
            .filter((n) => n === name)
            .map((n) => ({ EntitySetName: n })),
        };
      }),
    };
  }

  // A plain name in the first segment can be an unbound function: without
  // the catalog, query_records would call WhoAmI.
  it("keeps query_records from calling a function by its name", async () => {
    const client = metadataClient(["accounts"]);
    const tools = readTools(
      client,
      new EntitySetCatalog(client as unknown as DataverseClient),
    );
    await expect(
      tools.get("query_records")!.handler({ entity_set: "WhoAmI" }),
    ).rejects.toThrow("Unknown entity set: 'WhoAmI'");
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get.mock.calls[0][0]).toMatch(/^\/EntityDefinitions\?/);
  });

  it("looks a found entity set up once, and a missing one each time", async () => {
    const client = metadataClient(["accounts"]);
    const catalog = new EntitySetCatalog(client as unknown as DataverseClient);

    await catalog.assertExists("accounts");
    await catalog.assertExists("accounts");
    expect(client.get).toHaveBeenCalledTimes(1);

    await expect(catalog.assertExists("Accounts")).rejects.toThrow(/Unknown/);
    await expect(catalog.assertExists("Accounts")).rejects.toThrow(/Unknown/);
    expect(client.get).toHaveBeenCalledTimes(3);
  });
});
