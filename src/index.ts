#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DataverseAuth } from "./auth.js";
import { DataverseClient } from "./client.js";
import { registerDataTools } from "./tools/data-tools.js";
import { registerSchemaTools } from "./tools/schema-tools.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const tenantId = getRequiredEnv("DATAVERSE_TENANT_ID");
const clientId = getRequiredEnv("DATAVERSE_CLIENT_ID");
const clientSecret = getRequiredEnv("DATAVERSE_CLIENT_SECRET");
const resourceUrl = getRequiredEnv("DATAVERSE_RESOURCE_URL");

const auth = new DataverseAuth(tenantId, clientId, clientSecret, resourceUrl);
const client = new DataverseClient(auth, resourceUrl);

const server = new McpServer({
  name: "dataverse-mcp-server",
  version: "0.1.0",
});

registerDataTools(server, client);
registerSchemaTools(server, client);

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
