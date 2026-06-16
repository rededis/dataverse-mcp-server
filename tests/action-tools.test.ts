import { describe, expect, it, vi } from "vitest";
import {
  buildFunctionCall,
  formatODataLiteral,
  qualifyOperationName,
  registerActionTools,
  resolveBinding,
} from "../src/tools/action-tools.js";

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

const GUID = "11111111-1111-1111-1111-111111111111";

describe("helpers", () => {
  it("qualifies bound operation names with the CRM namespace", () => {
    expect(qualifyOperationName("QualifyLead", true)).toBe(
      "Microsoft.Dynamics.CRM.QualifyLead",
    );
  });

  it("leaves unbound names and already-qualified names untouched", () => {
    expect(qualifyOperationName("WhoAmI", false)).toBe("WhoAmI");
    expect(qualifyOperationName("Microsoft.Dynamics.CRM.X", true)).toBe(
      "Microsoft.Dynamics.CRM.X",
    );
  });

  it("resolveBinding returns true for bound, false for unbound", () => {
    expect(resolveBinding("leads", GUID)).toBe(true);
    expect(resolveBinding(undefined, undefined)).toBe(false);
    expect(resolveBinding("", "")).toBe(false);
  });

  it("resolveBinding rejects half-specified bindings", () => {
    expect(() => resolveBinding("leads", undefined)).toThrow(
      /Inconsistent binding/,
    );
    expect(() => resolveBinding(undefined, GUID)).toThrow(
      /Inconsistent binding/,
    );
  });

  it("resolveBinding rejects a non-GUID id", () => {
    expect(() => resolveBinding("leads", "not-a-guid")).toThrow(
      /Invalid record id/,
    );
  });

  it("formats OData literals by type", () => {
    expect(formatODataLiteral("hello")).toBe("'hello'");
    expect(formatODataLiteral("O'Brien")).toBe("'O''Brien'");
    expect(formatODataLiteral(GUID)).toBe(GUID); // GUIDs are unquoted
    expect(formatODataLiteral(42)).toBe("42");
    expect(formatODataLiteral(true)).toBe("true");
    expect(formatODataLiteral(null)).toBe("null");
  });

  it("builds parameterless and parameterized function calls", () => {
    expect(buildFunctionCall("WhoAmI")).toBe("WhoAmI");
    // encodeURIComponent leaves the apostrophe unescaped (it is URL-safe).
    expect(buildFunctionCall("GetX", { Name: "abc", Top: 5 })).toBe(
      "GetX(Name=@Name,Top=@Top)?@Name='abc'&@Top=5",
    );
  });
});

describe("invoke_action", () => {
  // UnpublishDuplicateRule is genuinely unbound (takes DuplicateRuleId);
  // PublishDuplicateRule, by contrast, is bound — see the bound test below.
  it("posts an unbound action to /<name> with parameters as body", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({ ok: true }) } as any;
    registerActionTools(server as any, client);

    const result = await server.tools
      .get("invoke_action")!
      .handler({
        name: "UnpublishDuplicateRule",
        parameters: { DuplicateRuleId: GUID },
      });

    expect(client.post).toHaveBeenCalledWith("/UnpublishDuplicateRule", {
      DuplicateRuleId: GUID,
    });
    expect(result.content[0].text).toContain("true");
  });

  it("posts a bound action to /<set>(<id>)/Microsoft.Dynamics.CRM.<name>", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerActionTools(server as any, client);

    await server.tools
      .get("invoke_action")!
      .handler({
        name: "QualifyLead",
        entity_set: "leads",
        id: GUID,
        parameters: { CreateAccount: true },
      });

    expect(client.post).toHaveBeenCalledWith(
      `/leads(${GUID})/Microsoft.Dynamics.CRM.QualifyLead`,
      { CreateAccount: true },
    );
  });

  // PublishDuplicateRule is bound to duplicaterule (verified live), so it must
  // be invoked on the entity, not at the service root.
  it("posts bound PublishDuplicateRule to the duplicaterule entity", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerActionTools(server as any, client);

    await server.tools
      .get("invoke_action")!
      .handler({
        name: "PublishDuplicateRule",
        entity_set: "duplicaterules",
        id: GUID,
      });

    expect(client.post).toHaveBeenCalledWith(
      `/duplicaterules(${GUID})/Microsoft.Dynamics.CRM.PublishDuplicateRule`,
      {},
    );
  });

  it("sends an empty body when no parameters are given", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerActionTools(server as any, client);

    await server.tools.get("invoke_action")!.handler({ name: "WhoAmI" });
    expect(client.post).toHaveBeenCalledWith("/WhoAmI", {});
  });

  it("rejects an invalid operation name", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerActionTools(server as any, client);

    await expect(
      server.tools.get("invoke_action")!.handler({ name: "../accounts" }),
    ).rejects.toThrow(/Invalid operation name/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("rejects a half-specified binding", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerActionTools(server as any, client);

    await expect(
      server.tools
        .get("invoke_action")!
        .handler({ name: "QualifyLead", entity_set: "leads" }),
    ).rejects.toThrow(/Inconsistent binding/);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("invoke_function", () => {
  it("gets an unbound parameterless function from /<name>", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({ UserId: GUID }),
    } as any;
    registerActionTools(server as any, client);

    const result = await server.tools
      .get("invoke_function")!
      .handler({ name: "WhoAmI" });

    expect(client.get).toHaveBeenCalledWith("/WhoAmI");
    expect(result.content[0].text).toContain(GUID);
  });

  it("rejects a parameter name that could inject into the URL", async () => {
    const server = createMockServer();
    const client = { get: vi.fn() } as any;
    registerActionTools(server as any, client);

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
    registerActionTools(server as any, client);

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
