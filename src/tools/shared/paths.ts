// Checks on the arguments that become part of a request path. They run before
// any allowlist check: an entity set like `emails(<id>)/../accounts` would
// pass a list that names `emails`, and fetch resolves the `..` to
// `/accounts(<id>)`.

import type { DataverseClient } from "../../client.js";
import { escapeODataString } from "./odata.js";

/** A plain entity set name; the server config holds its allowlists to it too. */
export const ENTITY_SET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A record id, braces allowed. */
export const GUID =
  /^\{?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}?$/;

/** A logical name: of a table, a column, a key or a global choice. */
const LOGICAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The metadata tools put logical names in the path, inside a quoted key
 * (`EntityDefinitions(LogicalName='…')`). Escaping the quote does not keep a
 * name like `/../contacts?…#` in there: fetch resolves the `..` first.
 */
export function assertLogicalName(name: string, what: string): void {
  if (!LOGICAL_NAME.test(name)) {
    throw new Error(
      `Invalid ${what}: '${name}'. Use the logical name, e.g. 'account'.`,
    );
  }
}

export function assertEntitySetName(name: string): void {
  if (!ENTITY_SET_NAME.test(name)) {
    throw new Error(
      `Invalid entity set name: '${name}'. Use the plural entity set name, e.g. 'accounts'.`,
    );
  }
}

export function assertRecordId(id: string): void {
  if (!GUID.test(id)) {
    throw new Error(`Invalid record id (expected a GUID): ${id}`);
  }
}

// Activity parties (To, Cc, From of an email, …) can only be written nested in
// the activity, so they are the one kind of related record a restricted
// create or update may carry. The navigation property name alone would admit
// a custom relationship that merely ends the same way, so each party must
// also look like one: a participation type, which no other table has, and
// otherwise only an address and links to existing records.
const ACTIVITY_PARTIES = /_activity_parties$/;
const BIND = /@odata\.bind$/;

function isActivityParty(party: unknown): boolean {
  if (!isRecordLike(party) || Array.isArray(party)) return false;
  const fields = Object.entries(party);
  return (
    typeof (party as Record<string, unknown>).participationtypemask ===
      "number" &&
    fields.every(
      ([key, value]) =>
        key === "participationtypemask" ||
        (key === "addressused" && typeof value === "string") ||
        (BIND.test(key) && typeof value === "string"),
    )
  );
}

/**
 * Refuses related records nested in a create or update body (deep insert),
 * which would create rows in tables the allowlist does not name. A link set
 * with `<lookup>@odata.bind` and one URL passes: it fills a column of the
 * record being written. An array of URLs does not: on a one-to-many
 * relationship (`Account_Tasks@odata.bind`) Dataverse writes the lookup of
 * each existing record listed, which is an update to a table the allowlist
 * may not name. Activity parties pass.
 */
export function assertNoNestedRecords(data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (!isRecordLike(value)) continue;
    if (
      ACTIVITY_PARTIES.test(key) &&
      Array.isArray(value) &&
      value.every(isActivityParty)
    ) {
      continue;
    }
    throw new Error(
      `Nested or linked records are not permitted for this token: '${key}'. Create related records separately, and link them from the record that holds the lookup, with '<lookup>@odata.bind'.`,
    );
  }
}

function isRecordLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * The entity sets that exist, looked up in the metadata. A plain name in the
 * first path segment can also be an unbound function or action
 * (`/WhoAmI`), which `query_records` or `create_record` would otherwise call
 * outside the actions and functions groups. Found names are remembered for
 * the life of the process; names not found are looked up again, since a table
 * may be created meanwhile.
 */
export class EntitySetCatalog {
  private known = new Set<string>();

  constructor(private client: DataverseClient) {}

  async assertExists(name: string): Promise<void> {
    if (this.known.has(name)) return;
    const filter = `EntitySetName eq '${escapeODataString(name)}'`;
    const result = (await this.client.get(
      `/EntityDefinitions?$select=EntitySetName&$filter=${encodeURIComponent(filter)}`,
    )) as { value?: { EntitySetName?: string }[] };
    // The metadata filter is case-sensitive, as is the Web API; compare
    // exactly all the same.
    if (result.value?.some((e) => e.EntitySetName === name)) {
      this.known.add(name);
      return;
    }
    throw new Error(
      `Unknown entity set: '${name}'. Use the plural entity set name, e.g. 'accounts' (list_entities shows them).`,
    );
  }
}
