import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createDataverseClient, readDataverseSettings } from "../dataverse.js";
import { createServerApp, MCP_PATH } from "./app.js";
import { readListenSettings, readServerConfig } from "./config.js";
import { createReadServerFactory } from "./mcp.js";
import { ConfigTokenVerifier } from "./tokens.js";

// The HTTP server (ADR-0001 §1). Settings come from the environment only: no
// .env file is read, and bad settings stop the process instead of starting a
// server that cannot work. Nothing here may import src/setup.ts, src/tools/all.ts
// or src/tools/development/ (tests/tool-groups.test.ts).

function fail(problems: string[]): never {
  console.error("Dataverse MCP server not started:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const dataverse = readDataverseSettings(process.env);
const listen = readListenSettings(process.env);
const problems = [
  ...dataverse.missing.map((name) => `${name} is not set`),
  ...dataverse.invalid,
  ...(listen.ok ? [] : listen.problems),
];
if (!dataverse.settings || !listen.ok) fail(problems);

let configText: string;
try {
  configText = readFileSync(listen.settings.configPath, "utf-8");
} catch (err) {
  fail([
    `cannot read DATAVERSE_SERVER_CONFIG=${listen.settings.configPath}: ${(err as Error).message}`,
  ]);
}
const config = readServerConfig(configText);
if (!config.ok) {
  fail(config.problems.map((p) => `${listen.settings.configPath}: ${p}`));
}

// The same relative path from src/server/ and dist/server/. A bundle (#79)
// inlines the file at build time.
const { version } = require("../../package.json") as { version: string };

const logError = (error: Error) =>
  console.error(`MCP server error: ${error.message}`);

const { entityPrefix, solutionName } = dataverse.settings;
const app = createServerApp({
  verifier: new ConfigTokenVerifier(config.config.tokens),
  allowedOrigins: config.config.allowedOrigins,
  createServer: createReadServerFactory({
    client: createDataverseClient(dataverse.settings),
    entityPrefix,
    solutionName,
    version,
  }),
  onerror: logError,
});

const { host, port } = listen.settings;
const server = createServer(toNodeHandler(app, { onerror: logError }));
server.listen(port, host, () => {
  console.log(
    `Dataverse MCP server ${version} listening on http://${host}:${port}${MCP_PATH}`,
  );
});

// Stop accepting connections first, then close the handler: that ends open
// subscriptions/listen streams with a final result. In the other order, a
// request arriving in between would get a 500.
let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  void app.close().then(() => server.closeIdleConnections());
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
