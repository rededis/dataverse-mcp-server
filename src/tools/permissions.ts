// What the writing and invoking tools may do (ADR-0001 §8). Each entry point
// fills this in its own way: the stdio package from DATAVERSE_ALLOW_DELETE,
// the HTTP server from the caller's role. The tools check it on every call,
// not only when deciding what to register (ADR-0001 §9).

/**
 * The names an operation may touch: `"*"` for any, or the exact names.
 * Dataverse matches entity set and operation names case-sensitively
 * (`/ACCOUNTS` and `/whoami` are 404), and so does this list.
 */
export type Allowlist = "*" | readonly string[];

export interface Permissions {
  /** Entity sets `create_record` may create in. */
  create: Allowlist;
  /** Entity sets `update_record` may update. */
  update: Allowlist;
  /** Entity sets `delete_record` may delete from; `"*"` also enables the development delete tools. */
  delete: Allowlist;
  /** Action names `invoke_action` may call, without the `Microsoft.Dynamics.CRM.` namespace. */
  actions: Allowlist;
  /** Function names `invoke_function` may call, likewise. */
  functions: Allowlist;
}

/** Nothing is written, deleted or invoked: what a caller gets unless granted more. */
export const NO_PERMISSIONS: Permissions = {
  create: [],
  update: [],
  delete: [],
  actions: [],
  functions: [],
};

/** The stdio package: everything, and deleting only when DATAVERSE_ALLOW_DELETE is on. */
export function stdioPermissions(allowDelete: boolean): Permissions {
  return {
    create: "*",
    update: "*",
    delete: allowDelete ? "*" : [],
    actions: "*",
    functions: "*",
  };
}

export function allows(list: Allowlist, name: string): boolean {
  return list === "*" || list.includes(name);
}

/** True when no name at all is allowed: the tool is not registered. */
export function allowsNothing(list: Allowlist): boolean {
  return list !== "*" && list.length === 0;
}

/**
 * Refuses a name outside the list. The message lists what is allowed, so an
 * agent can correct itself instead of guessing.
 */
export function assertAllowed(
  list: Allowlist,
  name: string,
  operation: string,
): void {
  if (allows(list, name)) return;
  const allowed = list === "*" ? "any" : list.join(", ") || "none";
  throw new Error(
    `Not permitted: ${operation} '${name}'. This token is allowed: ${allowed}.`,
  );
}
