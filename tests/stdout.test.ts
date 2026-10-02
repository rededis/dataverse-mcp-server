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

interface Message {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

// Starts the real entry point in a directory with a .env file, sends the
// given messages, and returns every line it wrote to stdout up to the response
// with the given id.
function stdoutUntilAnswered(
  messages: object[],
  lastId: number,
): Promise<string[]> {
  writeFileSync(
    join(cwd, ".env"),
    [
      "DATAVERSE_TENANT_ID=tenant",
      "DATAVERSE_CLIENT_ID=client",
      "DATAVERSE_CLIENT_SECRET=secret",
      "DATAVERSE_RESOURCE_URL=https://org.crm.dynamics.com",
    ].join("\n"),
  );
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/tsx/dist/cli.mjs"),
        join(root, "src/index.ts"),
      ],
      { cwd, stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      // A chunk can end mid-message: wait for the newline that closes the
      // response before reading the lines.
      if (out.includes(`"id":${lastId}`) && out.endsWith("\n")) {
        child.kill();
        resolvePromise(out.split("\n").filter((line) => line.trim() !== ""));
      }
    });
    child.on("error", reject);
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

function answerTo(lines: string[], id: number): Message {
  const found = lines
    .map((line) => JSON.parse(line) as Message)
    .find((message) => message.id === id);
  if (!found) throw new Error(`no response with id ${id}`);
  return found;
}

// What a client on the 2026-07-28 revision sends with every request, in place
// of the `initialize` handshake. Shape as sent by Claude Code 2.1.287.
const modernMeta = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
};

describe("stdio entry point", () => {
  // On stdio the server's stdout is the protocol stream: anything that is not
  // a JSON-RPC message there is a protocol violation.
  it("writes nothing but JSON-RPC messages to stdout when it loads a .env file", async () => {
    const lines = await stdoutUntilAnswered(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        },
      ],
      1,
    );

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), line).not.toThrow();
    }
    expect(answerTo(lines, 1).result?.protocolVersion).toBe("2025-11-25");
  }, 20_000);

  // Claude Code opens a stdio session with `server/discover`, not
  // `initialize`, and falls back to the 2025 handshake only when the server
  // does not know the method.
  it("serves a client that opens on the 2026-07-28 revision", async () => {
    const lines = await stdoutUntilAnswered(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: modernMeta,
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: modernMeta },
      ],
      2,
    );

    for (const line of lines) {
      expect(() => JSON.parse(line), line).not.toThrow();
    }
    const discover = answerTo(lines, 1);
    expect(discover.error).toBeUndefined();
    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    const list = answerTo(lines, 2);
    expect((list.result?.tools as unknown[]).length).toBe(23);
  }, 20_000);
});
