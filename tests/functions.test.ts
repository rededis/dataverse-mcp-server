import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../src/tools/all.js";
import { registerFunctionTools } from "../src/tools/functions.js";
import { NO_PERMISSIONS } from "../src/tools/permissions.js";
import { createMockServer, GUID, stdio } from "./helpers.js";

describe("invoke_function", () => {
  it("gets an unbound parameterless function from /<name>", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({ UserId: GUID }),
    } as any;
    registerAllTools(server as any, { client, ...stdio() });

    const result = await server.tools
      .get("invoke_function")!
      .handler({ name: "WhoAmI" });

    expect(client.get).toHaveBeenCalledWith("/WhoAmI");
    expect(result.content[0].text).toContain(GUID);
  });

  it("rejects a parameter name that could inject into the URL", async () => {
    const server = createMockServer();
    const client = { get: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio() });

    await server.tools.get("invoke_function")!.handler({
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

describe("invoke_function allowlist", () => {
  function functionTools(functions: readonly string[]) {
    const server = createMockServer();
    const client = { get: vi.fn().mockResolvedValue({}) } as any;
    registerFunctionTools(server as any, {
      client,
      permissions: { ...NO_PERMISSIONS, functions },
    });
    return { tools: server.tools, client };
  }

  it("is not registered when no function is allowed", () => {
    expect(functionTools([]).tools.has("invoke_function")).toBe(false);
  });

  it("calls a listed function and refuses another", async () => {
    const { tools, client } = functionTools(["RetrieveTotalRecordCount"]);
    const invoke = tools.get("invoke_function")!.handler;
    await invoke({
      name: "RetrieveTotalRecordCount",
      parameters: { EntityNames: ["account"] },
    });
    await expect(invoke({ name: "WhoAmI" })).rejects.toThrow(
      "Not permitted: call function 'WhoAmI'",
    );
    expect(client.get).toHaveBeenCalledTimes(1);
  });
});
