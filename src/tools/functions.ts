import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertValidName,
  buildFunctionCall,
  qualifyOperationName,
  resolveBinding,
} from "./shared/operations.js";
import type { ToolDeps } from "./types.js";

const INVOKE_FUNCTION_SHAPE = {
  name: z
    .string()
    .describe(
      "Function name, e.g. 'WhoAmI'. Bare names are namespaced automatically for bound calls; pass a fully-qualified name to override.",
    ),
  entity_set: z
    .string()
    .optional()
    .describe(
      "Entity set (plural) for a bound function. Omit for unbound functions.",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Record GUID the bound function targets. Required iff entity_set is set.",
    ),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Function parameters, inlined as OData arguments. Strings are quoted, GUIDs/numbers/booleans passed as-is.",
    ),
};

export function registerFunctionTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  server.tool(
    "invoke_function",
    "Invoke a Dataverse Web API function (GET) — bound or unbound. Use for read-only operations exposed as functions, e.g. WhoAmI (unbound) or RetrieveDuplicates. Pass entity_set+id for bound functions, neither for unbound. parameters are inlined into the URL as OData function arguments.",
    INVOKE_FUNCTION_SHAPE,
    async ({ name, entity_set, id, parameters }) => {
      assertValidName(name);
      const bound = resolveBinding(entity_set, id);
      const opName = qualifyOperationName(name, bound);
      const fnCall = buildFunctionCall(opName, parameters);
      const path = bound ? `/${entity_set}(${id})/${fnCall}` : `/${fnCall}`;
      const result = await client.get(path);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
