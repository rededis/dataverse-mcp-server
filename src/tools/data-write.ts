import { z } from "zod";
import { allowsNothing, assertAllowed, NO_PERMISSIONS } from "./permissions.js";
import {
  assertBodyWithin,
  assertEntitySetName,
  assertRecordId,
} from "./shared/paths.js";
import type { ToolDeps, ToolRegistrar } from "./types.js";

const CREATE_RECORD_INPUT = z.object({
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  data: z
    .record(z.string(), z.unknown())
    .describe("Record fields as key-value pairs"),
});

const UPDATE_RECORD_INPUT = z.object({
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  id: z.string().describe("Record GUID"),
  data: z
    .record(z.string(), z.unknown())
    .describe("Fields to update as key-value pairs"),
});

const DELETE_RECORD_INPUT = z.object({
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  id: z.string().describe("Record GUID"),
});

const DELETE_RECORD_DISABLED_INPUT = z.object({
  entity_set: z.string().describe("Entity set name"),
  id: z.string().describe("Record GUID"),
});

// Each handler checks its arguments in the same order: their shape, then the
// allowlist, then (on the server) that the entity set exists, which costs a
// request. The allowlist is checked here even though a tool whose list is
// empty is never registered (ADR-0001 §9).
export function registerDataWriteTools(
  server: ToolRegistrar,
  deps: ToolDeps,
): void {
  const { client, entitySets, deleteStubs = false } = deps;
  const permissions = deps.permissions ?? NO_PERMISSIONS;

  if (!allowsNothing(permissions.create)) {
    server.registerTool(
      "create_record",
      {
        description:
          "Create a record in a table (entity set) from column values keyed by logical name; get_entity_schema lists the columns and their types. Returns the new record's URL, which ends in its id, not the record itself. Every call creates a new record, so a retry after an error that may have reached Dataverse can create a duplicate.",
        inputSchema: CREATE_RECORD_INPUT,
      },
      async ({ entity_set, data }) => {
        assertEntitySetName(entity_set);
        assertAllowed(permissions.create, entity_set, "create in");
        assertBodyWithin(data, permissions);
        await entitySets?.assertExists(entity_set);
        const result = await client.post(`/${entity_set}`, data);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    );
  }

  if (!allowsNothing(permissions.update)) {
    server.registerTool(
      "update_record",
      {
        description:
          "Change the given columns of an existing record by its GUID; columns not in data keep their values. A record that does not exist is a 404 error: this tool never creates one (use create_record). Returns a confirmation text, not the record; read it back with get_record if needed.",
        inputSchema: UPDATE_RECORD_INPUT,
      },
      async ({ entity_set, id, data }) => {
        assertEntitySetName(entity_set);
        assertRecordId(id);
        assertAllowed(permissions.update, entity_set, "update in");
        assertBodyWithin(data, permissions);
        await entitySets?.assertExists(entity_set);
        // Without If-Match, a PATCH to a missing id creates the record
        // (upsert), which an update allowlist must not grant.
        await client.patch(`/${entity_set}(${id})`, data, { "If-Match": "*" });
        return {
          content: [
            {
              type: "text" as const,
              text: `Record ${id} updated successfully.`,
            },
          ],
        };
      },
    );
  }

  if (!allowsNothing(permissions.delete)) {
    server.registerTool(
      "delete_record",
      {
        description:
          "Permanently delete a record by its GUID; Dataverse may also delete or detach related records, as the relationships' cascade rules say. A record that does not exist is a 404 error. Returns a confirmation text.",
        inputSchema: DELETE_RECORD_INPUT,
      },
      async ({ entity_set, id }) => {
        assertEntitySetName(entity_set);
        assertRecordId(id);
        assertAllowed(permissions.delete, entity_set, "delete from");
        await entitySets?.assertExists(entity_set);
        await client.delete(`/${entity_set}(${id})`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Record ${id} deleted successfully.`,
            },
          ],
        };
      },
    );
  } else if (deleteStubs) {
    server.registerTool(
      "delete_record",
      {
        description:
          "Delete a record from a table. This tool is disabled on this server: a call only returns a message. Setting DATAVERSE_ALLOW_DELETE=true and restarting the server turns it on.",
        inputSchema: DELETE_RECORD_DISABLED_INPUT,
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: [
              "[IMPORTANT: Display this entire message to the user exactly as-is.]",
              "",
              "⚠️ Delete operations are disabled by default for safety.",
              "",
              "To enable, add DATAVERSE_ALLOW_DELETE=true to your .env file and restart the MCP server.",
            ].join("\n"),
          },
        ],
        isError: true,
      }),
    );
  }
}
