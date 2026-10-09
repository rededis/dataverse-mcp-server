import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../../src/tools/all.js";
import { createMockServer, stdio } from "../helpers.js";

describe("list_solutions", () => {
  it("queries /solutions excluding managed by default", async () => {
    const server = createMockServer();
    const client = {
      get: vi.fn().mockResolvedValue({ value: [{ uniquename: "Default" }] }),
    } as any;
    registerAllTools(server as any, { client, ...stdio() });

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
    registerAllTools(server as any, { client, ...stdio() });

    await server.tools
      .get("list_solutions")!
      .handler({ include_managed: true });
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
    registerAllTools(server as any, { client, ...stdio() });

    const result = await server.tools.get("list_solutions")!.handler({});
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get.mock.calls[1][0]).toBe(nextLink);
    expect(result.content[0].text).toContain('"A"');
    expect(result.content[0].text).toContain('"B"');
  });
});
