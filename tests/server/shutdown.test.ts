import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DataverseAuth } from "../../src/auth.js";
import { DataverseClient } from "../../src/client.js";
import type { HttpResponse } from "../../src/executor.js";
import { createServerApp } from "../../src/server/app.js";
import { AuditLog, JsonLinesAuditLogger } from "../../src/server/audit.js";
import { listen } from "../../src/server/listener.js";
import { createServerFactory } from "../../src/server/mcp.js";
import { shutDown } from "../../src/server/shutdown.js";
import { ConfigTokenVerifier } from "../../src/server/tokens.js";
import { serverConfig, sha256 } from "./helpers.js";

const GUID = "11111111-1111-1111-1111-111111111111";

describe("shutDown", () => {
  // A call waiting on Dataverse when SIGTERM comes keeps running after the
  // listener closes; its line must still be written, and flushed, before the
  // process exits (#78).
  it("waits for a running call's line and flushes it", async () => {
    const events: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const dataverseReached = new Promise<void>((r) => {
      reached = r;
    });

    const logger = new JsonLinesAuditLogger({
      write(chunk: string, cb?: () => void) {
        events.push(chunk === "" ? "flushed" : JSON.parse(chunk).outcome);
        cb?.();
        return true;
      },
    });
    const audit = new AuditLog(logger);
    const auth = { getToken: async () => "t" } as unknown as DataverseAuth;
    const client = new DataverseClient(auth, "https://org.crm.dynamics.com", {
      executor: {
        async execute(request): Promise<HttpResponse> {
          if (request.url.includes("/EntityDefinitions?")) {
            return {
              status: 200,
              headers: new Headers(),
              body: '{"value":[{"EntitySetName":"contacts"}]}',
            };
          }
          reached();
          await released;
          return { status: 200, headers: new Headers(), body: "{}" };
        },
      },
    });
    const app = createServerApp({
      verifier: new ConfigTokenVerifier(
        serverConfig([{ name: "alice", sha256: sha256("alice-token") }]),
      ),
      createServer: createServerFactory({ client, version: "0", audit }),
      audit,
    });
    const listener = await listen(app, { host: "127.0.0.1", port: 0 });

    const request = fetch(`http://127.0.0.1:${listener.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer alice-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_record",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_record",
          arguments: { entity_set: "contacts", id: GUID },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }).catch(() => undefined);
    await dataverseReached;

    const stopped = shutDown(
      { listener, audit, logger },
      { callsMs: 5_000, flushMs: 1_000 },
    ).then(() => events.push("exit"));
    // The listener is closed by now; the call is still waiting.
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);

    release();
    await stopped;
    await request;
    expect(events).toEqual(["ok", "flushed", "exit"]);
  });

  it("does not wait past its bound for a call that never ends", async () => {
    const logger = new JsonLinesAuditLogger({
      write: (_: string, cb?: () => void) => {
        cb?.();
        return true;
      },
    });
    const audit = new AuditLog(logger);
    audit.begin();
    const listener = { port: 0, stop: async () => {} };
    const started = Date.now();
    await shutDown({ listener, audit, logger }, { callsMs: 50, flushMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// The real entry point: stdout carries audit lines and nothing else, so a log
// pipeline can take it as the audit log; startup and shutdown go to stderr.
describe("the server process", () => {
  const root = resolve(__dirname, "../..");
  const dir = mkdtempSync(join(tmpdir(), "dataverse-mcp-server-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function freePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolvePort(port));
      });
    });
  }

  it("writes only audit lines to stdout, and exits 0 on SIGTERM", async () => {
    const configPath = join(dir, "server.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        roles: { r: { groups: ["data-read"] } },
        tokens: [{ name: "t", sha256: "0".repeat(64), role: "r" }],
      }),
    );
    const port = await freePort();
    // tsx's loader, not its CLI: the CLI runs the server in a child process
    // of its own, and on the Linux CI runner the CLI exited 143 on SIGTERM
    // where the server itself exits 0. With the loader the signal reaches
    // the server.
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href,
        join(root, "src/server/index.ts"),
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          DATAVERSE_TENANT_ID: "t",
          DATAVERSE_CLIENT_ID: "c",
          DATAVERSE_CLIENT_SECRET: "s",
          DATAVERSE_RESOURCE_URL: "https://org.invalid",
          DATAVERSE_SERVER_CONFIG: configPath,
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c;
    });
    const listening = new Promise<void>((ready, failed) => {
      child.stderr.on("data", (c: Buffer) => {
        stderr += c;
        if (stderr.includes("listening on")) ready();
      });
      child.once("exit", () => failed(new Error(`exited early: ${stderr}`)));
    });
    const exited = new Promise<number | null>((done) =>
      child.once("exit", (code) => done(code)),
    );

    await listening;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "X-Request-Id": "probe-1" },
    });
    expect(res.status).toBe(401);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);

    const lines = stdout.split("\n").filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        type: "audit",
        time: expect.any(String),
        event: "auth-refused",
        reason: "missing",
        requestId: "probe-1",
      },
    ]);
    expect(stderr).toMatch(/Dataverse MCP server \S+ listening on/);
    expect(stderr).toContain("SIGTERM received, shutting down");
  }, 20_000);
});
