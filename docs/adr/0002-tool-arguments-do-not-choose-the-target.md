# ADR-0002: Tool arguments do not choose what a request reaches

- **Status:** Proposed
- **Date:** 2026-10-09
- **Issue:** #77
- **Relates to:** [ADR-0001](0001-local-and-remote-variants.md) §8 (permissions), §9 (per-caller tool lists)

## Context

ADR-0001 §8 gives each token a role: the tool groups it may use, the entity
sets it may create, update or delete in, and the actions and functions it may
call. The tools enforce this by checking a **name taken from the arguments**
(`entity_set`, the operation name) against the role's lists.

Such a check protects nothing unless two things hold:

1. the request goes to the resource that name designates, and nothing else;
2. the request does only what the tool claims: an update updates, a create
   creates one row in the table named.

Neither held when #77 started, and the gaps were found one at a time while it
was implemented, each in a review round after the previous fix:

| Found by | Gap | What it allowed |
|---|---|---|
| Research for #77 | `entity_set`/`id` went into the path unchecked, and fetch resolves `..` | `delete_record {entity_set:"emails", id:"<g>)/../accounts(<g>"}` deletes an account |
| Research for #77 | A plain name in the first path segment can be an unbound operation | `query_records {entity_set:"WhoAmI"}` calls a function; `create_record` with `create: "*"` calls an unbound action |
| Research for #77 | Any operation name with a dot was sent as given | the allowlist entry `SendEmail` can be bypassed by another spelling |
| `/code-review` | `PATCH /<set>(<id>)` without `If-Match` is an upsert | an update grant creates records |
| Security review | A collection-valued `@odata.bind` on a one-to-many relationship writes the lookup of each existing record listed | `create: ["accounts"]` re-parents existing tasks or contacts |
| Security review | Metadata tools put logical names into a quoted key in the path; escaping the quote does not stop `..` and `#` | a role with only `metadata-read` reads any table through `get_entity_schema` |

The rule about collection-valued `@odata.bind` changed twice in the branch
(refused, then allowed as "only many-to-many", then refused again). Nothing
written down said which way it should go.

## Decision

**A tool argument may choose a value inside the request, never which resource
the request reaches or what kind of write it performs.** Every tool that builds
a request, now and in future, follows the rules below. They apply to the stdio
package as well as to the server, except where noted.

### 1. Names that go into a path are identifiers

Before any allowlist check, and before any request:

- `entity_set` matches `^[A-Za-z_][A-Za-z0-9_]*$`;
- a record `id` is a GUID;
- a logical name (table, column, key, global choice) matches the same
  identifier pattern. Quote-escaping is not a substitute: it protects an OData
  literal, not the path around it.

Each tool checks its own arguments, so the error says which argument is wrong.
Helpers live in `src/tools/shared/paths.ts`.

### 2. The client refuses a path that would resolve elsewhere

`DataverseClient.request` refuses a relative path whose part before `?` holds a
`.` or `..` segment, an encoded dot, a backslash, a `#` or a control character
(the URL parser deletes tabs and newlines, so `.\t.` becomes `..`). The query
string is not checked, since `$filter` may hold such text as data. Absolute
URLs pass: they are Dataverse's own (`@odata.nextLink`).

This is a backstop for a tool that forgets rule 1, not a replacement for it.

### 3. Operation names are normalized before they are checked

An action or function name is reduced to its bare form: exactly the
`Microsoft.Dynamics.CRM.` prefix is stripped, and any other dot is refused. The
allowlist is matched against the bare name, and the URL is built from the name
that was checked, never from the original argument.

### 4. On the server, an entity set must exist

The server checks each `entity_set` against the metadata
(`EntityDefinitions?$filter=EntitySetName eq '…'`, looked up as the
application user, found names cached for the life of the process), so that a
data tool cannot reach an unbound function or action by its name.

The stdio package does not do this: it grants every group and every operation
anyway, and the lookup would cost a request per new entity set.

### 5. A write does only what its tool says

- `update_record` sends `If-Match: *`, so a missing record is a 404 and not a
  create.
- When the create or update list is not `*`, the body may not carry related
  records (deep insert) nor a collection-valued `@odata.bind`. A single-valued
  `<lookup>@odata.bind`, which fills a column of the record being written,
  passes.
- **Exception: activity parties** (`<activity>_activity_parties`). They can
  only be written nested in their activity, and an email cannot be addressed
  without them. Each party must carry `participationtypemask` and otherwise
  only `addressused` and single-valued `@odata.bind` links; the name suffix
  alone is not enough, since a custom relationship can end the same way.

### 6. Allowlists match exactly

Dataverse matches entity set and operation names case-sensitively (`/ACCOUNTS`
and `/whoami` are 404), and so do the allowlists.

## Consequences

- A new tool that builds a path must use the identifier checks of rule 1; the
  client's guard (rule 2) catches it if it does not, with a less helpful
  message.
- Two changes are visible to stdio users and marked **BREAKING** in the
  changelog: `update_record` no longer creates a missing record, and operation
  names in any namespace other than `Microsoft.Dynamics.CRM.` are refused. A
  logical name with a quote, which used to be escaped and sent, is refused.
- A role with a restricted create or update list cannot associate records
  many-to-many in the same call. It has to be done through a role with `*`, or
  waits for an explicit rule (see Not decided).
- The server spends one metadata request per distinct entity set per process,
  plus one per call that names an unknown entity set.

## Not decided

- **Many-to-many associations for restricted roles.** Allowing a
  collection-valued `@odata.bind` only where the metadata says the navigation
  property is many-to-many would still write an intersect row, which needs a
  rule of its own in the role. Revisit when a role needs it.
- **Allowlisting a bound operation per table.** An allowed action may be
  called bound to any record of any table that Dataverse accepts for it.
  Revisit if an action turns out to be safe on one table and not another.
- **Caching unknown entity sets.** A miss is looked up again each time. Inbound
  rate limiting belongs in front of the server (ADR-0001 §11).

## Evidence

- Case sensitivity, checked on the dev org on 2026-10-09: `GET /ACCOUNTS` and
  `GET /whoami` return 404 `0x80060888`; `EntityDefinitions` with
  `$filter=EntitySetName eq 'accounts'` returns the entity, with
  `'ACCOUNTS'` an empty list; `query_records {entity_set:"WhoAmI"}` reached the
  function.
- URL resolution, checked in Node: `new URL(base + "/EntityDefinitions(LogicalName='/../accounts?$top=5#')/Attributes")`
  is `…/api/data/v9.2/accounts?$top=5#')/Attributes`, and fetch does not send
  the fragment.
- One-to-many binding on create: Microsoft Learn, [Create a table row using the
  Web API, "Associate table rows on create"](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api),
  where `"Account_Tasks@odata.bind": ["/tasks(…)", "/tasks(…)"]` on a new
  account attaches two existing tasks.
- Upsert on PATCH: Microsoft Learn, [Update and delete table rows using the
  Web API, "Basic update"](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/update-delete-entities-using-web-api):
  "The `If-Match: *` header ensures you don't create a new record by
  accidentally performing an upsert operation." Under "Upsert a table row":
  "if the record doesn't exist, it's created."
