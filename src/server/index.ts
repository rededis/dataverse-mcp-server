import { readFileSync } from "node:fs";
import { createDataverseClient, readDataverseSettings } from "../dataverse.js";
import { createServerApp, MCP_PATH } from "./app.js";
import { AuditLog, JsonLinesAuditLogger } from "./audit.js";
import {
  expiredTokens,
  readListenSettings,
  readServerConfig,
} from "./config.js";
import { listen as startListening } from "./listener.js";
import { createServerFactory } from "./mcp.js";
import { shutDown } from "./shutdown.js";
import { ConfigTokenVerifier } from "./tokens.js";

// The HTTP server (ADR-0001 §1). Settings come from the environment only: no
// .env file is read, and bad settings stop the process instead of starting a
// server that cannot work. stdout carries the audit log and nothing else
// (#78); every other message goes to stderr. Nothing here may import
// src/setup.ts, src/tools/all.ts or src/tools/development/
// (tests/tool-groups.test.ts).

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
const serverConfig = readServerConfig(configText);
if (!serverConfig.ok) {
  fail(serverConfig.problems.map((p) => `${listen.settings.configPath}: ${p}`));
}

const expired = expiredTokens(serverConfig.config.tokens);
if (expired.length > 0) {
  console.error(
    `Warning: these tokens have expired and are refused: ${expired.join(", ")}`,
  );
}

// The image's bundle gets its version from scripts/build-server.mjs, which
// defines SERVER_VERSION (the image has its own release line, ADR-0001 §13)
// and drops the package.json branch. Run from src/ or dist/, it is undefined
// and the npm package's version is read: the same relative path from both.
declare const SERVER_VERSION: string | undefined;
const version: string =
  typeof SERVER_VERSION === "string"
    ? SERVER_VERSION
    : (require("../../package.json") as { version: string }).version;

const logError = (error: Error) =>
  console.error(`MCP server error: ${error.message}`);

const logger = new JsonLinesAuditLogger(process.stdout);
// stdout's reader can go away (EPIPE). Without a listener that error would
// end the process; the server keeps serving and says, once, that its audit
// lines are being lost.
let auditLost = false;
process.stdout.on("error", (error) => {
  if (auditLost) return;
  auditLost = true;
  console.error(`Audit log lost: writing to stdout failed: ${error.message}`);
});
const audit = new AuditLog(logger, listen.settings.auditKey);

const { entityPrefix, solutionName } = dataverse.settings;
const app = createServerApp({
  verifier: new ConfigTokenVerifier(serverConfig.config),
  createServer: createServerFactory({
    client: createDataverseClient(dataverse.settings),
    entityPrefix,
    solutionName,
    version,
    audit,
  }),
  audit,
  onerror: logError,
});

const { host, port } = listen.settings;
// An IPv6 address goes in brackets in a URL: http://[::1]:3000/mcp.
const urlHost = host.includes(":") ? `[${host}]` : host;
startListening(app, { host, port, onerror: logError }).then(
  (listener) => {
    console.error(
      `Dataverse MCP server ${version} listening on http://${urlHost}:${listener.port}${MCP_PATH}`,
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        console.error(`${signal} received, shutting down`);
        shutDown({ listener, audit, logger }).then(
          () => process.exit(0),
          (error: Error) => {
            console.error(`Shutdown failed: ${error.message}`);
            process.exit(1);
          },
        );
      });
    }
  },
  (error: Error) =>
    fail([`cannot listen on ${host}:${port}: ${error.message}`]),
);
