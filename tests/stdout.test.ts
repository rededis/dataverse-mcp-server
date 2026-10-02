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

// Starts the real entry point in a directory with a .env file, sends
// `initialize`, and returns every line it wrote to stdout until it answered.
function stdoutUntilInitialized(): Promise<string[]> {
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
      [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/index.ts")],
      { cwd, stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      // A chunk can end mid-message: wait for the newline that closes the
      // response before reading the lines.
      if (out.includes('"serverInfo"') && out.endsWith("\n")) {
        child.kill();
        resolvePromise(out.split("\n").filter((line) => line.trim() !== ""));
      }
    });
    child.on("error", reject);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      })}\n`,
    );
  });
}

describe("stdio entry point", () => {
  // On stdio the server's stdout is the protocol stream: anything that is not
  // a JSON-RPC message there is a protocol violation.
  it("writes nothing but JSON-RPC messages to stdout when it loads a .env file", async () => {
    const lines = await stdoutUntilInitialized();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), line).not.toThrow();
    }
  }, 20_000);
});
