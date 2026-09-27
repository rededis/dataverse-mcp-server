import { describe, expect, it, vi } from "vitest";
import type { DataverseClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/all.js";
import { createMockServer } from "./helpers.js";

const mockClient = {} as DataverseClient;

describe("delete_record allowDelete", () => {
  it("delete_record returns error when allowDelete is false", async () => {
    const server = createMockServer();
    registerAllTools(server as any, { client: mockClient, allowDelete: false });

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
    registerAllTools(server as any, { client, allowDelete: true });

    const deleteTool = server.tools.get("delete_record");
    expect(deleteTool).toBeDefined();
    expect(deleteTool!.description).not.toContain("disabled");

    await deleteTool!.handler({ entity_set: "leads", id: "123" });
    expect(client.delete).toHaveBeenCalledWith("/leads(123)");
  });
});
