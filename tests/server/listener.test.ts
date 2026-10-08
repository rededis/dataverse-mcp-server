import { afterEach, describe, expect, it } from "vitest";
import type { DataverseClient } from "../../src/client.js";
import { createServerApp } from "../../src/server/app.js";
import { type Listener, listen } from "../../src/server/listener.js";
import { createReadServerFactory } from "../../src/server/mcp.js";
import { ConfigTokenVerifier } from "../../src/server/tokens.js";
import { sha256 } from "./helpers.js";

let listener: Listener | undefined;
afterEach(async () => {
  await listener?.stop();
  listener = undefined;
});

async function start() {
  const app = createServerApp({
    verifier: new ConfigTokenVerifier([
      { name: "alice", sha256: sha256("alice-token") },
    ]),
    allowedOrigins: [],
    createServer: createReadServerFactory({
      client: {} as DataverseClient,
      version: "0.0.0-test",
    }),
  });
  listener = await listen(app, { host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${listener.port}`;
}

// What mcp-remote and Claude Code keep open for the whole session.
function openListenStream(base: string) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: "Bearer alice-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "subscriptions/listen",
      params: {
        notifications: { toolsListChanged: true },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
) {
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe("listen", () => {
  it("streams subscriptions/listen through the Node adapter", async () => {
    const base = await start();
    const res = await openListenStream(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // The acknowledgement arrives while the stream stays open.
    expect(await readUntil(reader, (t) => t.includes("acknowledged"))).toMatch(
      /notifications\/subscriptions\/acknowledged/,
    );

    // Stopping ends the stream with a final result, then closes every socket.
    const stopped = listener?.stop();
    const rest = await readUntil(reader, () => false);
    expect(rest).toMatch(/"id":7,"result"/);
    await stopped;
    listener = undefined;
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it("answers over a real socket, token check included", async () => {
    const base = await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
  });
});
