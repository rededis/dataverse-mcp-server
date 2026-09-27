import { vi } from "vitest";
import { DataverseApiError } from "../src/errors.js";

// A stand-in for McpServer that records each tool registered through the v1
// `server.tool(name, description, shape, handler)` form, so tests can look a
// tool up by name and call its handler directly.
export function createMockServer() {
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

export const GUID = "11111111-1111-1111-1111-111111111111";

// What DataverseClient throws when Dataverse answers 404.
export function notFound(body = "not found") {
  return new DataverseApiError(
    404,
    { method: "GET", url: "https://org.crm.dynamics.com/api/data/v9.2/stub" },
    body,
  );
}
