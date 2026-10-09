import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import type { DataverseClient } from "../client.js";
import {
  SERVER_TOOL_GROUPS,
  type ServerToolGroup,
} from "../tools/server-groups.js";
import { EntitySetCatalog } from "../tools/shared/paths.js";
import type { ToolDeps } from "../tools/types.js";
import { callerOf } from "./tokens.js";

export interface ServerFactoryDeps
  extends Pick<ToolDeps, "entityPrefix" | "solutionName"> {
  /** The application user's client, shared by every request. */
  client: DataverseClient;
  version: string;
}

/**
 * Builds the MCP server for one HTTP request, with the tools the caller's role
 * allows (ADR-0001 §8, §9). `createMcpHandler` calls it per request, for
 * `subscriptions/listen` and unknown methods too, so the Dataverse client is
 * built once by the caller, and a token that acts as a user gets a view of
 * it, sharing its token cache and throttling state.
 *
 * Groups are taken in `SERVER_TOOL_GROUPS` order, not the role's, which fixes
 * the order of `tools/list`. The list varies by caller, which the SDK's
 * default cache hint (`cacheScope: "private"`) allows for.
 */
export function createServerFactory(deps: ServerFactoryDeps): McpServerFactory {
  const { client, version, entityPrefix, solutionName } = deps;
  // Looked up as the application user: whether a table exists is not a
  // question of the caller's privileges, and the answers are shared.
  const entitySets = new EntitySetCatalog(client);
  const groups = Object.keys(SERVER_TOOL_GROUPS) as ServerToolGroup[];

  return (ctx) => {
    const caller = callerOf(ctx.authInfo);
    const toolDeps: ToolDeps = {
      client: caller.actAs
        ? client.onBehalfOf({ name: caller.name, objectId: caller.actAs })
        : client,
      entityPrefix,
      solutionName,
      permissions: caller.role.permissions,
      entitySets,
    };
    const server = new McpServer({ name: "dataverse-mcp-server", version });
    for (const group of groups) {
      if (caller.role.groups.includes(group)) {
        SERVER_TOOL_GROUPS[group](server, toolDeps);
      }
    }
    return server;
  };
}
