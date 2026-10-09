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
| Blind security review | An unbound operation name is sent as `/<name>`, and nothing checked it named an operation; the server config accepted `"*"` for actions and functions | `actions: "*"` creates in any table (`invoke_action {name:"accounts"}` → `POST /accounts`, confirmed on the dev org) or a table (`EntityDefinitions`); `functions: "*"` reads any table |
| Copilot on PR #97 | The body check was skipped when the tool's **own** list was `*` | `create: "*"` with a restricted update re-parents existing records; `update: "*"` with a restricted create creates records by deep insert |

The rule about collection-valued `@odata.bind` changed twice in the branch
(refused, then allowed as "only many-to-many", then refused again). Nothing
written down said which way it should go.

The last row shows why the rule has to be stated in terms of operations, not
tools. The first version tied the body check to the list of the tool's own
operation; the issue, the code and a first draft of this record all said so,
and the three reviews run on the branch inherited that framing. A reviewer
that saw only the code found it.

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

Likewise for who makes the request: the client alone sets `Authorization`
and `CallerObjectId`, after any header a tool passes, and refuses a request
whose own headers name `Authorization`, `CallerObjectId` or `MSCRMCallerID`
in any letter case. No tool passes caller-controlled headers today; this keeps
`onBehalfOf()` true for the tool that one day does.

### 3. Operation names are normalized before they are checked

An action or function name is reduced to its bare form: exactly the
`Microsoft.Dynamics.CRM.` prefix is stripped, and any other dot is refused. The
allowlist is matched against the bare name, and the URL is built from the name
that was checked, never from the original argument.

An unbound call goes to `/<name>`, and from the name alone an operation cannot
be told from an entity set (`accounts`) or a metadata root
(`EntityDefinitions`). So **the server config takes action and function names
only, never `"*"`** (§7): each name is one the operator chose to expose. The
Dataverse metadata could tell them apart (`ActionImport`/`FunctionImport` in
`$metadata`), but that is a document of several megabytes for a convenience no
role needs; SDK message names (`sdkmessages`) do not match Web API operation
names (`SendEmail` is the `Send` message), so they cannot serve either. The
stdio package keeps `"*"`: it grants every table anyway.

### 4. On the server, an entity set must exist

The server checks the `entity_set` of each data tool (`query_records`,
`get_record`, `create_record`, `update_record`, `delete_record`) against the
metadata (`EntityDefinitions?$filter=EntitySetName eq '…'`, looked up as the
application user, found names cached for the life of the process), so that a
data tool cannot reach an unbound function or action by its name. There the
name can stand alone as the first path segment (`/WhoAmI`). A bound
`invoke_action` or `invoke_function` is not checked: its entity set is always
followed by `(<id>)` and the namespaced operation, so a name that is not a
table only gets an error from Dataverse.

The stdio package does not do this: it grants every group and every operation
anyway, and the lookup would cost a request per new entity set.

### 5. A write does only what its tool says

- `update_record` sends `If-Match: *`, so a missing record is a 404 and not a
  create.
- A body may do another operation than its tool's, and is checked against
  **that** operation's list, whichever tool carries it:
  - a related record nested in the body (deep insert) creates a row, so it
    needs create `*`; its own body is checked the same way;
  - a collection-valued `@odata.bind` on a one-to-many relationship writes the
    lookup of each existing record listed, so it needs update `*`.

  A single-valued `<lookup>@odata.bind`, which fills a column of the record
  being written, passes. Tests cover every combination of tool, create list
  and update list.

  The server config takes no `"*"` (§7), so on the server nested records and
  collection-valued links are always refused, activity parties aside. Only the
  stdio package, which grants `"*"` for both, lets them through.
- **Exception: activity parties** (`<activity>_activity_parties`). They can
  only be written nested in their activity, and an email cannot be addressed
  without them. Each party must carry `participationtypemask` and otherwise
  only `addressused` and single-valued `@odata.bind` links; the name suffix
  alone is not enough, since a custom relationship can end the same way.

### 6. Allowlists match exactly

Dataverse matches entity set and operation names case-sensitively (`/ACCOUNTS`
and `/whoami` are 404), and so do the allowlists.

### 7. The server config names what it allows

No list in the server config accepts `"*"`: entity sets for create, update
and delete, actions and functions are all listed by name. For operations,
`"*"` cannot be made safe (§3). For entity sets it would be safe as written,
but it hides what a role may write, and it is what rule 5 would turn into
"may also create or update through any body". Listing the names is the price,
and no role has needed more. `"*"` stays in the code for the stdio package.

## Consequences

- A new tool that builds a path must use the identifier checks of rule 1; the
  client's guard (rule 2) catches it if it does not, with a less helpful
  message.
- Two changes are visible to stdio users and marked **BREAKING** in the
  changelog: `update_record` no longer creates a missing record, and operation
  names in any namespace other than `Microsoft.Dynamics.CRM.` are refused. A
  logical name with a quote, which used to be escaped and sent, is refused.
- On the server, no role can link several records in one call, many-to-many
  included, nor create related records in one call: both are done by separate
  calls, or wait for an explicit rule (see Not decided).
- A role lists every table it may write and every operation it may call.
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
