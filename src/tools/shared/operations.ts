// Helpers shared by invoke_action and invoke_function, which sit in separate
// tool groups.

// Operation names are restricted to dotted identifiers so a caller can never
// smuggle a path segment, query string, or quote into the request URL.
const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
// Function parameter names are interpolated into the URL (`Fn(P=@P)?@P=...`),
// so they are held to the same identifier restriction to prevent URL injection.
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
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

export function assertValidName(name: string): void {
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
