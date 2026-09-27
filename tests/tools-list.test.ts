import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { DataverseClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/all.js";

// The wire contract of the stdio server, registered the way src/index.ts
// does: every tool's name, description and input JSON Schema exactly as a
// client receives them from tools/list.
// Sorted by name, so the snapshot pins the set of tools rather than the
// registration order.

// Registration never touches the client; listing tools makes no Dataverse call.
const client = {} as DataverseClient;

async function listTools(allowDelete: boolean) {
  const server = new McpServer({ name: "snapshot", version: "0.0.0" });
  registerAllTools(server, { client, allowDelete });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "snapshot-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const { tools } = await mcpClient.listTools();
  await mcpClient.close();

  return tools
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
});
