import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../src/tools/all.js";
import { createMockServer, GUID } from "./helpers.js";

describe("invoke_action", () => {
  // UnpublishDuplicateRule is genuinely unbound (takes DuplicateRuleId);
  // PublishDuplicateRule, by contrast, is bound — see the bound test below.
  it("posts an unbound action to /<name> with parameters as body", async () => {
    const server = createMockServer();
    const client = { post: vi.fn().mockResolvedValue({ ok: true }) } as any;
    registerAllTools(server as any, { client });

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
    registerAllTools(server as any, { client });

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
    registerAllTools(server as any, { client });

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
    registerAllTools(server as any, { client });

    await server.tools.get("invoke_action")!.handler({ name: "WhoAmI" });
    expect(client.post).toHaveBeenCalledWith("/WhoAmI", {});
  });

  it("rejects an invalid operation name", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client });

    await expect(
      server.tools.get("invoke_action")!.handler({ name: "../accounts" }),
    ).rejects.toThrow(/Invalid operation name/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("rejects a half-specified binding", async () => {
    const server = createMockServer();
    const client = { post: vi.fn() } as any;
    registerAllTools(server as any, { client });

    await expect(
      server.tools
        .get("invoke_action")!
        .handler({ name: "QualifyLead", entity_set: "leads" }),
    ).rejects.toThrow(/Inconsistent binding/);
    expect(client.post).not.toHaveBeenCalled();
  });
});
