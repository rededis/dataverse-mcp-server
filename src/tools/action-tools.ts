import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataverseClient } from "../client.js";

// Operation names are restricted to dotted identifiers so a caller can never
// smuggle a path segment, query string, or quote into the request URL.
const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
const GUID = /^\{?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}?$/;
const CRM_NAMESPACE = "Microsoft.Dynamics.CRM.";

/**
 * Bound operations need the `Microsoft.Dynamics.CRM.` namespace prefix; unbound
 * ones (system functions like WhoAmI, and custom process actions like
 * `new_MyAction`) are called by their plain name. A name that already carries a
 * namespace (contains a dot) is passed through untouched.
 */
export function qualifyOperationName(name: string, bound: boolean): string {
  if (!bound || name.includes(".")) return name;
  return `${CRM_NAMESPACE}${name}`;
}

/**
 * Decide bound-vs-unbound and reject the half-specified case. Bound calls need
 * BOTH entity_set and id; unbound calls need NEITHER.
 */
export function resolveBinding(entitySet?: string, id?: string): boolean {
  const hasSet = entitySet !== undefined && entitySet !== "";
  const hasId = id !== undefined && id !== "";
  if (hasSet !== hasId) {
    throw new Error(
      "Inconsistent binding: a bound call requires both entity_set and id; an unbound call requires neither.",
    );
  }
  if (hasSet && id !== undefined && !GUID.test(id)) {
    throw new Error(`Invalid record id (expected a GUID): ${id}`);
  }
  return hasSet;
}

function assertValidName(name: string): void {
  if (!OPERATION_NAME.test(name)) {
    throw new Error(
      `Invalid operation name: '${name}'. Use the bare operation name (e.g. 'QualifyLead', 'PublishDuplicateRule') or a fully-qualified name.`,
    );
  }
}

/** Format a single value as an OData literal for inline function parameters. */
export function formatODataLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return GUID.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Edm complex/collection values are passed as JSON.
  return JSON.stringify(value);
}

/**
 * Build the function-call URL segment using parameter aliases, e.g.
 * `FnName(P1=@p1,P2=@p2)?@p1='x'&@p2=42`. With no parameters the bare operation
 * name is used (`WhoAmI`), which Dataverse accepts for parameterless functions.
 */
export function buildFunctionCall(
  opName: string,
  parameters?: Record<string, unknown>,
): string {
  const keys = parameters ? Object.keys(parameters) : [];
  if (keys.length === 0) return opName;
  const paramList = keys.map((k) => `${k}=@${k}`).join(",");
  const aliasList = keys
    .map(
      (k) =>
        `@${k}=${encodeURIComponent(formatODataLiteral((parameters as Record<string, unknown>)[k]))}`,
    )
    .join("&");
  return `${opName}(${paramList})?${aliasList}`;
}

export function registerActionTools(
  server: McpServer,
  client: DataverseClient,
): void {
  server.tool(
    "invoke_action",
    "Invoke a Dataverse Web API action (POST) — bound or unbound. Use for operations that are not plain CRUD, e.g. PublishDuplicateRule/UnpublishDuplicateRule (unbound) or QualifyLead (bound to a lead). Pass entity_set+id for bound actions, neither for unbound. parameters becomes the JSON request body.",
    {
      name: z
        .string()
        .describe(
          "Action name, e.g. 'PublishDuplicateRule', 'QualifyLead'. Bare names are namespaced automatically for bound calls; pass a fully-qualified name to override.",
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
    },
    async ({ name, entity_set, id, parameters }) => {
      assertValidName(name);
      const bound = resolveBinding(entity_set, id);
      const opName = qualifyOperationName(name, bound);
      const path = bound ? `/${entity_set}(${id})/${opName}` : `/${opName}`;
      const result = await client.post(path, parameters ?? {});
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "invoke_function",
    "Invoke a Dataverse Web API function (GET) — bound or unbound. Use for read-only operations exposed as functions, e.g. WhoAmI (unbound) or RetrieveDuplicates. Pass entity_set+id for bound functions, neither for unbound. parameters are inlined into the URL as OData function arguments.",
    {
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
    },
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
