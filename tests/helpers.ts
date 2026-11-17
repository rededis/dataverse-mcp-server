import { vi } from "vitest";
import { DataverseApiError } from "../src/errors.js";
import { stdioPermissions } from "../src/tools/permissions.js";
import type { ToolDeps, ToolRegistrar } from "../src/tools/types.js";

type Handler = (...args: any[]) => any;

// What registerTool returns, a new one per call. Only this is cast: the tests
// never read it, and a full RegisteredTool needs methods they do not use.
type RegisterToolResult = ReturnType<ToolRegistrar["registerTool"]>;

interface RecordedTool {
  description: string | undefined;
  inputSchema: unknown;
  handler: Handler;
}

// A stand-in for the server's ToolRegistrar that records each tool registered
// through `server.registerTool(name, config, handler)`, so tests can look a
// tool up by name and call its handler directly.
export function createMockServer() {
  const tools = new Map<string, RecordedTool>();
  const registerTool = vi.fn(
    (
      name: string,
      config: { description?: string; inputSchema?: unknown },
      handler: Handler,
    ) => {
      tools.set(name, {
        description: config.description,
        inputSchema: config.inputSchema,
        handler,
      });
      return {} as RegisterToolResult;
    },
    // The mock is checked against ToolRegistrar, not cast to it (#135). As a
    // method, registerTool's parameters are compared both ways, so a mock that
    // accepts less than the registrar passes would still fit. This function
    // form compares them one way. Parameters takes only the last overload,
    // the raw-shape one: the other overload's config is not compared.
  ) satisfies (
    ...args: Parameters<ToolRegistrar["registerTool"]>
  ) => RegisterToolResult;
  return { registerTool, tools };
}

export const GUID = "11111111-1111-1111-1111-111111111111";

// What DataverseClient throws when Dataverse answers 404.
export function notFound(body = "not found") {
  return new DataverseApiError(
    404,
    { method: "GET", url: "https://org.crm.dynamics.com/api/data/v9.2/stub" },
    body,
  );
}

// What src/index.ts gives the tools: everything, deleting per
// DATAVERSE_ALLOW_DELETE, and stubs for the delete tools when it is off.
export function stdio(
  allowDelete = false,
): Pick<ToolDeps, "permissions" | "deleteStubs"> {
  return { permissions: stdioPermissions(allowDelete), deleteStubs: true };
}
