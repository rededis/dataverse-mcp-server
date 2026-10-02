import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolDeps } from "./types.js";

const CREATE_RECORD_SHAPE = {
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  data: z
    .record(z.string(), z.unknown())
    .describe("Record fields as key-value pairs"),
};

const UPDATE_RECORD_SHAPE = {
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  id: z.string().describe("Record GUID"),
  data: z
    .record(z.string(), z.unknown())
    .describe("Fields to update as key-value pairs"),
};

const DELETE_RECORD_SHAPE = {
  entity_set: z
    .string()
    .describe("Entity set name (plural, e.g. 'accounts', 'contacts')"),
  id: z.string().describe("Record GUID"),
};

const DELETE_RECORD_DISABLED_SHAPE = {
  entity_set: z.string().describe("Entity set name"),
  id: z.string().describe("Record GUID"),
};

export function registerDataWriteTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, allowDelete = false } = deps;
  server.registerTool(
    "create_record",
    {
      description: "Create a new record in a Dataverse table",
      inputSchema: CREATE_RECORD_SHAPE,
    },
    async ({ entity_set, data }) => {
      const result = await client.post(`/${entity_set}`, data);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "update_record",
    {
      description: "Update an existing record in a Dataverse table",
      inputSchema: UPDATE_RECORD_SHAPE,
    },
    async ({ entity_set, id, data }) => {
      await client.patch(`/${entity_set}(${id})`, data);
      return {
        content: [
          { type: "text" as const, text: `Record ${id} updated successfully.` },
        ],
      };
    },
  );

  if (allowDelete) {
    server.registerTool(
      "delete_record",
      {
        description: "Delete a record from a Dataverse table",
        inputSchema: DELETE_RECORD_SHAPE,
      },
      async ({ entity_set, id }) => {
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
  } else {
    server.registerTool(
      "delete_record",
      {
        description:
          "Delete a record from a Dataverse table (currently disabled for safety)",
        inputSchema: DELETE_RECORD_DISABLED_SHAPE,
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
