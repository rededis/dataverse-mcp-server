import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { allowsNothing, assertAllowed, NO_PERMISSIONS } from "./permissions.js";
import {
  bareOperationName,
  qualifyOperationName,
  resolveBinding,
} from "./shared/operations.js";
import type { ToolDeps } from "./types.js";

const INVOKE_ACTION_INPUT = z.object({
  name: z
    .string()
    .describe(
      "Action name, e.g. 'PublishDuplicateRule', 'QualifyLead'. The Microsoft.Dynamics.CRM. namespace is added for bound calls and may be omitted.",
    ),
  entity_set: z
    .string()
    .optional()
    .describe(
      "Entity set (plural, e.g. 'leads') for a bound action. Omit for unbound actions.",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Record GUID the bound action targets. Required iff entity_set is set.",
    ),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Action parameters sent as the JSON request body (e.g. { DuplicateRuleId } for PublishDuplicateRule, { CreateAccount, CreateContact, Status } for QualifyLead).",
    ),
});

export function registerActionTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const allowed = (deps.permissions ?? NO_PERMISSIONS).actions;
  if (allowsNothing(allowed)) return;
  server.registerTool(
    "invoke_action",
    {
      description:
        "Invoke a Dataverse Web API action (POST) — bound or unbound. Use for operations that are not plain CRUD, e.g. PublishDuplicateRule (bound to a duplicaterule) or QualifyLead (bound to a lead), or UnpublishDuplicateRule (unbound, takes DuplicateRuleId). Whether an action is bound is defined in the Web API $metadata. Pass entity_set+id for bound actions, neither for unbound. parameters becomes the JSON request body.",
      inputSchema: INVOKE_ACTION_INPUT,
    },
    async ({ name, entity_set, id, parameters }) => {
      const bare = bareOperationName(name);
      const bound = resolveBinding(entity_set, id);
      assertAllowed(allowed, bare, "call action");
      const opName = qualifyOperationName(bare, bound);
      const path = bound ? `/${entity_set}(${id})/${opName}` : `/${opName}`;
      const result = await client.post(path, parameters ?? {});
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
