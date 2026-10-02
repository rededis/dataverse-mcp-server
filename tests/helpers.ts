import { vi } from "vitest";
import { DataverseApiError } from "../src/errors.js";

// A stand-in for McpServer that records each tool registered through
// `server.registerTool(name, config, handler)`, so tests can look a tool up by
// name and call its handler directly.
export function createMockServer() {
  const tools = new Map<string, { description: string; handler: Function }>();
  return {
    registerTool: vi.fn(
      (name: string, config: { description: string }, handler: Function) => {
        tools.set(name, { description: config.description, handler });
      },
    ),
    tools,
  };
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
