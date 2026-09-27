import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../src/tools/all.js";
import { createMockServer, GUID } from "./helpers.js";

describe("invoke_function", () => {
  it("gets an unbound parameterless function from /<name>", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({ UserId: GUID }),
    } as any;
    registerAllTools(server as any, { client });

    const result = await server.tools
      .get("invoke_function")!
      .handler({ name: "WhoAmI" });

    expect(client.get).toHaveBeenCalledWith("/WhoAmI");
    expect(result.content[0].text).toContain(GUID);
  });

  it("rejects a parameter name that could inject into the URL", async () => {
    const server = createMockServer();
    const client = { get: vi.fn() } as any;
    registerAllTools(server as any, { client });

    await expect(
      server.tools
        .get("invoke_function")!
        .handler({ name: "GetX", parameters: { "Bad)&$top": 1 } }),
    ).rejects.toThrow(/Invalid parameter name/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("inlines parameters into a bound function URL", async () => {
    const server = createMockServer();
    const client = { get: vi.fn().mockResolvedValue({ value: [] }) } as any;
    registerAllTools(server as any, { client });

    await server.tools
      .get("invoke_function")!
      .handler({
        name: "RetrieveX",
        entity_set: "accounts",
        id: GUID,
        parameters: { Top: 3 },
      });

    expect(client.get).toHaveBeenCalledWith(
      `/accounts(${GUID})/Microsoft.Dynamics.CRM.RetrieveX(Top=@Top)?@Top=3`,
    );
  });
});
