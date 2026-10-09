import { describe, expect, it, vi } from "vitest";
import { registerActionTools } from "../src/tools/actions.js";
import { registerAllTools } from "../src/tools/all.js";
import { NO_PERMISSIONS } from "../src/tools/permissions.js";
import { createMockServer, GUID, stdio } from "./helpers.js";

describe("invoke_action", () => {
  // UnpublishDuplicateRule is genuinely unbound (takes DuplicateRuleId);
  // PublishDuplicateRule, by contrast, is bound — see the bound test below.
  it("posts an unbound action to /<name> with parameters as body", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({ ok: true }) } as any;
    registerAllTools(server as any, { client, ...stdio() });

    const result = await server.tools.get("invoke_action")!.handler({
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
    registerAllTools(server as any, { client, ...stdio() });

    await server.tools.get("invoke_action")!.handler({
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
    registerAllTools(server as any, { client, ...stdio() });

    await server.tools.get("invoke_action")!.handler({
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
    registerAllTools(server as any, { client, ...stdio() });

    await server.tools.get("invoke_action")!.handler({ name: "WhoAmI" });
    expect(client.post).toHaveBeenCalledWith("/WhoAmI", {});
  });

  it("rejects an invalid operation name", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio() });

    await expect(
      server.tools.get("invoke_action")!.handler({ name: "../accounts" }),
    ).rejects.toThrow(/Invalid operation name/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("rejects a half-specified binding", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio() });

    await expect(
      server.tools
        .get("invoke_action")!
        .handler({ name: "QualifyLead", entity_set: "leads" }),
    ).rejects.toThrow(/Inconsistent binding/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("posts a bound action under its namespace whether or not the caller gave it", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerAllTools(server as any, { client, ...stdio() });

    await server.tools.get("invoke_action")!.handler({
      name: "Microsoft.Dynamics.CRM.SendEmail",
      entity_set: "emails",
      id: GUID,
      parameters: { IssueSend: false },
    });
    expect(client.post).toHaveBeenCalledWith(
      `/emails(${GUID})/Microsoft.Dynamics.CRM.SendEmail`,
      { IssueSend: false },
    );
  });

  it.each([
    "Other.Namespace.SendEmail",
    "microsoft.dynamics.crm.SendEmail",
    "Microsoft.Dynamics.CRM.",
  ])("refuses the name %j: only the one namespace is known", async (name) => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio() });

    await expect(
      server.tools.get("invoke_action")!.handler({ name }),
    ).rejects.toThrow(/Invalid operation name/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("refuses a bound call whose entity set would leave the path", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio() });

    await expect(
      server.tools.get("invoke_action")!.handler({
        name: "QualifyLead",
        entity_set: "leads/../accounts",
        id: GUID,
      }),
    ).rejects.toThrow(/Invalid entity set name/);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("invoke_action allowlist", () => {
  function actionTools(actions: readonly string[] | "*") {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({}) } as any;
    registerActionTools(server as any, {
      client,
      permissions: { ...NO_PERMISSIONS, actions },
    });
    return { tools: server.tools, client };
  }

  it("is not registered when no action is allowed", () => {
    expect(actionTools([]).tools.has("invoke_action")).toBe(false);
  });

  it("calls a listed action, with or without the namespace", async () => {
    const { tools, client } = actionTools(["SendEmail"]);
    const invoke = tools.get("invoke_action")!.handler;
    for (const name of ["SendEmail", "Microsoft.Dynamics.CRM.SendEmail"]) {
      await invoke({ name, entity_set: "emails", id: GUID });
    }
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  it("refuses an action that is not listed", async () => {
    const { tools, client } = actionTools(["SendEmail"]);
    await expect(
      tools.get("invoke_action")!.handler({ name: "CreateAndSendNewEmail" }),
    ).rejects.toThrow(
      "Not permitted: call action 'CreateAndSendNewEmail'. This token is allowed: SendEmail.",
    );
    expect(client.post).not.toHaveBeenCalled();
  });
});
