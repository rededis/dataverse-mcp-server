// Helpers shared by invoke_action and invoke_function, which sit in separate
// tool groups.

import { assertEntitySetName, assertRecordId, GUID } from "./paths.js";

// Operation names are restricted to identifiers so a caller can never smuggle
// a path segment, query string, or quote into the request URL.
export const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// Function parameter names are interpolated into the URL (`Fn(P=@P)?@P=...`),
// so they are held to the same identifier restriction to prevent URL injection.
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const CRM_NAMESPACE = "Microsoft.Dynamics.CRM.";

/**
 * The bare name of an operation: `Microsoft.Dynamics.CRM.SendEmail` and
 * `SendEmail` are the same action. Allowlists hold bare names, so a name is
 * normalized before it is checked, and the URL is built from what was
 * checked. Every Dataverse operation, custom APIs included, lives in that one
 * namespace, so a name with any other dot is refused rather than passed on.
 */
export function bareOperationName(name: string): string {
  const bare = name.startsWith(CRM_NAMESPACE)
    ? name.slice(CRM_NAMESPACE.length)
    : name;
  if (!OPERATION_NAME.test(bare)) {
    throw new Error(
      `Invalid operation name: '${name}'. Use the bare operation name (e.g. 'QualifyLead', 'PublishDuplicateRule').`,
    );
  }
  return bare;
}

/**
 * The name as it goes in the URL. Bound operations need the namespace; unbound
 * ones (system functions like WhoAmI, and custom process actions like
 * `new_MyAction`) are called by their plain name.
 */
export function qualifyOperationName(bare: string, bound: boolean): string {
  return bound ? `${CRM_NAMESPACE}${bare}` : bare;
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
  if (hasSet) {
    assertEntitySetName(entitySet as string);
    assertRecordId(id as string);
  }
  return hasSet;
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
  for (const k of keys) {
    if (!PARAM_NAME.test(k)) {
      throw new Error(
        `Invalid parameter name: '${k}'. Parameter names must be identifiers (letters, digits, underscore; starting with a letter).`,
      );
    }
  }
  const paramList = keys.map((k) => `${k}=@${k}`).join(",");
  const aliasList = keys
    .map(
      (k) =>
        `@${k}=${encodeURIComponent(formatODataLiteral((parameters as Record<string, unknown>)[k]))}`,
    )
    .join("&");
  return `${opName}(${paramList})?${aliasList}`;
}
