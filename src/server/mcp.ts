import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import {
  SERVER_TOOL_GROUPS,
  type ServerToolGroup,
} from "../tools/server-groups.js";
import type { ToolDeps } from "../tools/types.js";

const READ_GROUP_NAMES: readonly ServerToolGroup[] = [
  "metadata-read",
  "data-read",
];

/**
 * What every caller gets until roles exist (#77): reading metadata and data,
 * taken in `SERVER_TOOL_GROUPS` order, which fixes the order of `tools/list`
 * (ADR-0001 §9).
 */
export const READ_GROUPS = (
  Object.keys(SERVER_TOOL_GROUPS) as ServerToolGroup[]
).filter((group) => READ_GROUP_NAMES.includes(group));

/**
 * Builds the MCP server for one HTTP request. `createMcpHandler` calls it per
 * request, for `subscriptions/listen` and unknown methods too, so `deps`
 * (the Dataverse client above all) is built once by the caller.
 */
export function createReadServerFactory(
  deps: ToolDeps & { version: string },
): McpServerFactory {
  const { version, ...toolDeps } = deps;
  return () => {
    const server = new McpServer({ name: "dataverse-mcp-server", version });
    for (const group of READ_GROUPS) {
      SERVER_TOOL_GROUPS[group](server, toolDeps);
    }
    return server;
  };
}
