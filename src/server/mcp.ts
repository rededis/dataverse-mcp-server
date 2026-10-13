import {
  type CallToolResult,
  McpServer,
  type McpServerFactory,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { DataverseClient } from "../client.js";
import {
  SERVER_TOOL_GROUPS,
  type ServerToolGroup,
  type ToolRegistrar,
} from "../tools/server-groups.js";
import { EntitySetCatalog } from "../tools/shared/paths.js";
import type { ToolDeps } from "../tools/types.js";
import {
  type AuditLog,
  CallMetrics,
  callFields,
  fingerprint,
  outcomeOf,
  requestFactsOf,
  resultFields,
} from "./audit.js";
import { callerOf } from "./tokens.js";

export interface ServerFactoryDeps
  extends Pick<ToolDeps, "entityPrefix" | "solutionName"> {
  /** The application user's client, shared by every request. */
  client: DataverseClient;
  version: string;
  /** Where each tool call's line goes (#78). */
  audit: AuditLog;
}

// A tool name as MCP allows it; anything else in the body is fingerprinted.
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ServerContext,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Builds the MCP server for one HTTP request, with the tools the caller's role
 * allows (ADR-0001 §8, §9). `createMcpHandler` calls it per request, for
 * `subscriptions/listen` and unknown methods too, so the Dataverse client is
 * built once by the caller, and a token that acts as a user gets a view of
 * it, sharing its token cache and throttling state.
 *
 * A request carries one JSON-RPC message (batches are refused), so what is
 * built here serves at most one tool call: its metrics need no other key.
 * Each tool is registered through a wrapper that writes the call's audit
 * line; the tools themselves know nothing of it.
 *
 * Groups are taken in `SERVER_TOOL_GROUPS` order, not the role's, which fixes
 * the order of `tools/list`. The list varies by caller, which the SDK's
 * default cache hint (`cacheScope: "private"`) allows for.
 */
export function createServerFactory(deps: ServerFactoryDeps): McpServerFactory {
  const { client, version, entityPrefix, solutionName, audit } = deps;
  // The entity sets found so far, shared by every request's catalog.
  const knownEntitySets = new Set<string>();
  const groups = Object.keys(SERVER_TOOL_GROUPS) as ServerToolGroup[];

  return (ctx) => {
    const caller = callerOf(ctx.authInfo);
    const facts = requestFactsOf(ctx.authInfo);
    const metrics = new CallMetrics();
    const observed = client.observed(metrics.data);
    const toolDeps: ToolDeps = {
      client: caller.actAs
        ? observed.onBehalfOf({ name: caller.name, objectId: caller.actAs })
        : observed,
      entityPrefix,
      solutionName,
      permissions: caller.role.permissions,
      // Looked up as the application user: whether a table exists is not a
      // question of the caller's privileges. The lookup is the call's own
      // request, and its rows are not the call's records.
      entitySets: new EntitySetCatalog(
        client.observed(metrics.lookups),
        knownEntitySets,
      ),
    };
    const who = {
      token: caller.name,
      role: caller.roleName,
      ...(caller.actAs && { actAs: caller.actAs }),
      ...(facts.requestId !== undefined && { requestId: facts.requestId }),
    };

    const audited =
      (tool: string, handler: ToolHandler): ToolHandler =>
      async (args, callCtx) => {
        const start = new Date();
        const end = audit.begin();
        const line = (ending: Record<string, unknown>) =>
          audit.write(
            {
              durationMs: Date.now() - start.getTime(),
              rpcId: audit.id(callCtx.mcpReq.id),
              ...who,
              tool,
              ...callFields(tool, args, audit.key),
              ...ending,
              ...metrics.summary(),
            },
            start,
          );
        try {
          const result = await handler(args, callCtx);
          line(
            result.isError
              ? { outcome: "error" }
              : { outcome: "ok", ...resultFields(tool, result, metrics) },
          );
          return result;
        } catch (error) {
          line(outcomeOf(error, audit.key));
          throw error;
        } finally {
          end();
        }
      };

    const server = new McpServer({ name: "dataverse-mcp-server", version });
    const registrar: ToolRegistrar = {
      // The overloads of registerTool are not worth restating: the wrapper
      // passes the tool's name and config through untouched.
      registerTool: ((name: string, config: never, handler: ToolHandler) =>
        server.registerTool(
          name,
          config,
          audited(name, handler) as never,
        )) as McpServer["registerTool"],
    };
    for (const group of groups) {
      if (caller.role.groups.includes(group)) {
        SERVER_TOOL_GROUPS[group](registrar, toolDeps);
      }
    }

    // A call to a tool the role does not have: the SDK answers "not found"
    // before any handler runs, so the line is written here.
    const call = facts.call;
    if (call && server.toolInputSchemaJson(call.tool) === undefined) {
      const named = TOOL_NAME.test(call.tool);
      audit.write({
        durationMs: 0,
        rpcId: call.rpcId,
        ...who,
        ...(named && { tool: call.tool }),
        outcome: "refused",
        check: "tool-not-in-role",
        ...(!named && { got: fingerprint(call.tool, audit.key) }),
      });
    }
    return server;
  };
}
