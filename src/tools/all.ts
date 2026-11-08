import { registerDevelopmentTools } from "./development/index.js";
import { SERVER_TOOL_GROUPS } from "./server-groups.js";
import type { ToolDeps, ToolRegistrar } from "./types.js";

/** Every tool group, development included: what the stdio package exposes. */
export function registerAllTools(server: ToolRegistrar, deps: ToolDeps): void {
  for (const register of Object.values(SERVER_TOOL_GROUPS)) {
    register(server, deps);
  }
  registerDevelopmentTools(server, deps);
}
