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
