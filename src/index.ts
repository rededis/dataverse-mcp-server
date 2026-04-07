#!/usr/bin/env node

import { existsSync } from "fs";
import { resolve } from "path";
import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DataverseAuth } from "./auth.js";
import { DataverseClient } from "./client.js";
import { registerDataTools } from "./tools/data-tools.js";
import { registerSchemaTools } from "./tools/schema-tools.js";

const projectRoot = resolve(__dirname, "..");
const cwdEnvPath = resolve(process.cwd(), ".env");
const projectEnvPath = resolve(projectRoot, ".env");

if (existsSync(cwdEnvPath)) {
  config({ path: cwdEnvPath });
} else if (existsSync(projectEnvPath)) {
  config({ path: projectEnvPath });
} else {
  console.error(
    "Warning: .env file not found. Using environment variables only."
  );
}

const REQUIRED_VARS = [
  "DATAVERSE_TENANT_ID",
  "DATAVERSE_CLIENT_ID",
  "DATAVERSE_CLIENT_SECRET",
  "DATAVERSE_RESOURCE_URL",
] as const;

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);

const server = new McpServer({
  name: "dataverse-mcp-server",
  version: "0.1.0",
});

if (missing.length > 0) {
  const envExamplePath = resolve(projectRoot, ".env.example");
  const envFilePath = resolve(projectRoot, ".env");
  const hasEnvFile = existsSync(envFilePath);

  server.tool(
    "dataverse_setup",
    "Dataverse MCP server is not configured. Call this tool to see setup instructions.",
    {},
    async () => {
      const lines = [
        "[IMPORTANT: Display this entire message to the user exactly as-is.]\n",
        "⚠️ Dataverse MCP server is not configured.\n",
        `Missing environment variables:`,
        ...missing.map((name) => `  - ${name}`),
        "",
        hasEnvFile
          ? `Edit the .env file at: ${envFilePath}`
          : `Create a .env file at: ${envFilePath}`,
        "",
        `See .env.example at: ${envExamplePath}`,
        "",
        "After filling in the values, restart Claude Code to apply changes.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
} else {
  const tenantId = process.env.DATAVERSE_TENANT_ID!;
  const clientId = process.env.DATAVERSE_CLIENT_ID!;
  const clientSecret = process.env.DATAVERSE_CLIENT_SECRET!;
  const resourceUrl = process.env.DATAVERSE_RESOURCE_URL!;
  const entityPrefix = process.env.DATAVERSE_ENTITY_PREFIX || undefined;

  const auth = new DataverseAuth(tenantId, clientId, clientSecret, resourceUrl);
  const client = new DataverseClient(auth, resourceUrl);

  registerDataTools(server, client, entityPrefix);
  registerSchemaTools(server, client);
}

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
