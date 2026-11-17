#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config } from "dotenv";
import { createDataverseClient, readDataverseSettings } from "./dataverse.js";
import { registerSetupTool } from "./setup.js";
import { registerAllTools } from "./tools/all.js";
import { stdioPermissions } from "./tools/permissions.js";

const projectRoot = resolve(__dirname, "..");
const cwdEnvPath = resolve(process.cwd(), ".env");
const projectEnvPath = resolve(projectRoot, ".env");

// quiet: dotenv 17 announces each file it loads with console.log, and on stdio
// stdout carries the protocol; only JSON-RPC messages may go there.
if (existsSync(cwdEnvPath)) {
  config({ path: cwdEnvPath, quiet: true });
} else if (existsSync(projectEnvPath)) {
  config({ path: projectEnvPath, quiet: true });
} else {
  console.error(
    "Warning: .env file not found. Using environment variables only.",
  );
}

const { settings, missing, invalid } = readDataverseSettings(process.env);

// Read version from package.json so it stays in sync with the npm release —
// avoids reporting a stale MCP server version on every bump.
const pkg = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf-8"),
) as { version: string };

// Decides once which tools a server gets. serveStdio builds an McpServer more
// than once per process (ADR-0001 §5), and the Dataverse client, with its
// token cache and its throttling state, must not be rebuilt each time.
function chooseTools(): (server: McpServer) => void {
  if (!settings) {
    const envExamplePath = resolve(projectRoot, ".env.example");
    const envFilePath = resolve(projectRoot, ".env");
    const hasEnvFile = existsSync(envFilePath);

    return (server) =>
      registerSetupTool(server, {
        missing,
        invalid,
        envFilePath,
        envExamplePath,
        hasEnvFile,
      });
  }

  const client = createDataverseClient(settings);
  const { entityPrefix, solutionName, allowDelete } = settings;

  return (server) =>
    registerAllTools(server, {
      client,
      entityPrefix,
      solutionName,
      permissions: stdioPermissions(allowDelete),
      deleteStubs: true,
    });
}

const addTools = chooseTools();

// Serves both protocol revisions, whichever the client opens with
// (ADR-0001 §5).
serveStdio(
  () => {
    const server = new McpServer({
      name: "dataverse-mcp-server",
      version: pkg.version,
    });
    addTools(server);
    return server;
  },
  { onerror: (error) => console.error("MCP stdio error:", error) },
);
