import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { DataverseClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/all.js";

// The wire contract of the stdio server, registered the way src/index.ts
// does: every tool's name, description and input JSON Schema exactly as a
// client receives them from tools/list.
// The contract snapshots are sorted by name, so they pin the set of tools; the
// order is pinned separately below.

// Registration never touches the client; listing tools makes no Dataverse call.
const client = {} as DataverseClient;

async function fetchTools(allowDelete: boolean) {
  const server = new McpServer({ name: "snapshot", version: "0.0.0" });
  registerAllTools(server, { client, allowDelete });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "snapshot-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const { tools } = await mcpClient.listTools();
  await mcpClient.close();

  return tools;
}

async function listTools(allowDelete: boolean) {
  return (await fetchTools(allowDelete))
    .map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("tools/list", () => {
  it("matches the snapshot with deletes disabled", async () => {
    expect(await listTools(false)).toMatchSnapshot();
  });

  it("matches the snapshot with deletes enabled", async () => {
    expect(await listTools(true)).toMatchSnapshot();
  });

  // Clients may treat a reordered list as a changed one, and the list is part
  // of the model's prompt, so a new order costs clients their prompt cache.
  // The order is deterministic (ADR-0001 §9); this makes any change to it a
  // visible diff instead of a silent side effect of moving registrations.
  it("returns tools in a fixed order", async () => {
    const names = (await fetchTools(false)).map((t) => t.name);
    expect(names).toMatchInlineSnapshot(`
      [
        "list_entities",
        "get_entity_schema",
        "get_picklist_options",
        "list_entity_keys",
        "query_records",
        "get_record",
        "create_record",
        "update_record",
        "delete_record",
        "invoke_action",
        "invoke_function",
        "list_solutions",
        "create_entity",
        "add_attribute",
        "create_relationship",
        "update_attribute",
        "delete_attribute",
        "get_attribute_dependencies",
        "add_entity_key",
        "delete_entity_key",
        "add_picklist_option",
        "update_picklist_option",
        "delete_picklist_option",
      ]
    `);
    expect((await fetchTools(true)).map((t) => t.name)).toEqual(names);
  });
});
