import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolDeps } from "../types.js";
import { registerPicklistWriteTools } from "./picklist.js";
import { registerSchemaTools } from "./schema.js";
import { registerSolutionTools } from "./solutions.js";

/**
 * Schema changes, solutions and dependency checks. Imported only by the stdio
 * entry point (via ../all.ts); never by anything a server entry point reaches.
 */
export function registerDevelopmentTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerSolutionTools(server, deps);
  registerSchemaTools(server, deps);
  registerPicklistWriteTools(server, deps);
}
