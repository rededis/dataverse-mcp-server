import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const cwd = mkdtempSync(join(tmpdir(), "dataverse-mcp-stdout-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

interface JsonRpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function request(id: number, method: string, params: object = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

// Starts the real entry point in a directory with a .env file, sends the
// given requests, and returns every line it wrote to stdout up to the response
// to the last of them.
function stdoutOf(requests: Array<{ id: number }>): Promise<string[]> {
  writeFileSync(
    join(cwd, ".env"),
    [
      "DATAVERSE_TENANT_ID=tenant",
      "DATAVERSE_CLIENT_ID=client",
      "DATAVERSE_CLIENT_SECRET=secret",
      "DATAVERSE_RESOURCE_URL=https://org.crm.dynamics.com",
    ].join("\n"),
  );
  const lastId = requests[requests.length - 1].id;
  // The id as a whole number, so that 2 does not match 20.
  const answered = new RegExp(`"id":${lastId}[,}]`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/index.ts")],
      { cwd, stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      // A chunk can end mid-message: wait for the newline that closes the
      // response before reading the lines.
      if (answered.test(out) && out.endsWith("\n")) {
        child.kill();
        resolvePromise(out.split("\n").filter((line) => line.trim() !== ""));
      }
    });
    child.on("error", reject);
    // Settling twice is harmless: after a normal answer this is a no-op.
    child.on("exit", () =>
      reject(new Error(`the server exited before answering ${lastId}`)),
    );
    for (const message of requests) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

// On stdio the server's stdout is the protocol stream: anything that is not
// a JSON-RPC message there is a protocol violation.
function parseAll(lines: string[]): JsonRpcResponse[] {
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((line) => {
    expect(() => JSON.parse(line), line).not.toThrow();
    return JSON.parse(line) as JsonRpcResponse;
  });
}

function answerTo(responses: JsonRpcResponse[], id: number): JsonRpcResponse {
  const found = responses.find((response) => response.id === id);
  if (!found) throw new Error(`no response with id ${id}`);
  return found;
}

// What a client on the 2026-07-28 revision sends with every request, in place
// of the `initialize` handshake. Shape as sent by Claude Code 2.1.287.
const modern = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
};

describe("stdio entry point", () => {
  it("answers the 2025 handshake, with nothing but JSON-RPC messages on stdout when it loads a .env file", async () => {
    const responses = parseAll(
      await stdoutOf([
        request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        }),
      ]),
    );

    expect(answerTo(responses, 1).result?.protocolVersion).toBe("2025-11-25");
  }, 20_000);

  // Claude Code opens a stdio session with `server/discover`, not
  // `initialize`, and falls back to the 2025 handshake only when the server
  // does not know the method (ADR-0001 §5).
  it("serves a client that opens on the 2026-07-28 revision", async () => {
    const responses = parseAll(
      await stdoutOf([
        request(1, "server/discover", modern),
        request(2, "tools/list", modern),
      ]),
    );

    const discover = answerTo(responses, 1);
    expect(discover.error).toBeUndefined();
    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    const tools = answerTo(responses, 2).result?.tools as Array<{
      name: string;
    }>;
    expect(tools.map((tool) => tool.name)).toContain("query_records");
  }, 20_000);
});
