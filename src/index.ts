#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config } from "dotenv";
import { DataverseAuth } from "./auth.js";
import { DataverseClient } from "./client.js";
import {
  readRequestTimeoutMs,
  readServiceProtectionSettings,
} from "./config.js";
import { FetchExecutor } from "./executor.js";
import { withServiceProtection } from "./service-protection.js";
import { registerSetupTool } from "./setup.js";
import { registerAllTools } from "./tools/all.js";

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

const REQUIRED_VARS = [
  "DATAVERSE_TENANT_ID",
  "DATAVERSE_CLIENT_ID",
  "DATAVERSE_CLIENT_SECRET",
  "DATAVERSE_RESOURCE_URL",
] as const;

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);

const invalid: string[] = [];
const requestTimeout = readRequestTimeoutMs(
  process.env.DATAVERSE_REQUEST_TIMEOUT_MS,
);
if (!requestTimeout.ok) invalid.push(requestTimeout.problem);
const requestTimeoutMs = requestTimeout.ok ? requestTimeout.value : undefined;
const serviceProtection = readServiceProtectionSettings(process.env);
invalid.push(...serviceProtection.problems);

// Read version from package.json so it stays in sync with the npm release —
// avoids reporting a stale MCP server version on every bump.
const pkg = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf-8"),
) as { version: string };

// Decides once which tools a server gets. serveStdio builds an McpServer more
// than once per process (ADR-0001 §5), and the Dataverse client, with its
// token cache and its throttling state, must not be rebuilt each time.
function chooseTools(): (server: McpServer) => void {
  if (missing.length > 0 || invalid.length > 0) {
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

  const tenantId = process.env.DATAVERSE_TENANT_ID as string;
  const clientId = process.env.DATAVERSE_CLIENT_ID as string;
  const clientSecret = process.env.DATAVERSE_CLIENT_SECRET as string;
  const resourceUrl = process.env.DATAVERSE_RESOURCE_URL as string;
  const entityPrefix = process.env.DATAVERSE_ENTITY_PREFIX || undefined;
  const solutionName = process.env.DATAVERSE_SOLUTION_NAME || undefined;
  const allowDelete = process.env.DATAVERSE_ALLOW_DELETE === "true";

  const auth = new DataverseAuth(
    tenantId,
    clientId,
    clientSecret,
    resourceUrl,
    {
      timeoutMs: requestTimeoutMs,
    },
  );
  const client = new DataverseClient(auth, resourceUrl, {
    executor: withServiceProtection(
      new FetchExecutor(requestTimeoutMs),
      serviceProtection.settings,
    ),
  });

  return (server) =>
    registerAllTools(server, {
      client,
      entityPrefix,
      solutionName,
      allowDelete,
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
