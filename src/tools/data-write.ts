import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { allowsNothing, assertAllowed, NO_PERMISSIONS } from "./permissions.js";
import {
  assertEntitySetName,
  assertNoNestedRecords,
  assertRecordId,
} from "./shared/paths.js";
import type { ToolDeps } from "./types.js";

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
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, entitySets, deleteStubs = false } = deps;
  const permissions = deps.permissions ?? NO_PERMISSIONS;

  if (!allowsNothing(permissions.create)) {
    server.registerTool(
      "create_record",
      {
        description: "Create a new record in a Dataverse table",
        inputSchema: CREATE_RECORD_INPUT,
      },
      async ({ entity_set, data }) => {
        assertEntitySetName(entity_set);
        assertAllowed(permissions.create, entity_set, "create in");
        if (permissions.create !== "*") assertNoNestedRecords(data);
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
        description: "Update an existing record in a Dataverse table",
        inputSchema: UPDATE_RECORD_INPUT,
      },
      async ({ entity_set, id, data }) => {
        assertEntitySetName(entity_set);
        assertRecordId(id);
        assertAllowed(permissions.update, entity_set, "update in");
        if (permissions.update !== "*") assertNoNestedRecords(data);
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
        description: "Delete a record from a Dataverse table",
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
          "Delete a record from a Dataverse table (currently disabled for safety)",
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
