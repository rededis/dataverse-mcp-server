import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { ServerApp } from "./app.js";

export interface Listener {
  /** The address actually bound, e.g. with port 0 in tests. */
  port: number;
  /**
   * Stops the server: no new connections, open subscriptions/listen streams
   * end with a final result, and the call resolves once every socket is
   * closed.
   */
  stop(): Promise<void>;
}

/**
 * Whether parsing the request target as a URL changes its path. The app
 * routes on the parsed path, where `\` is a `/` and dot segments, encoded or
 * not, are resolved, so `/x/..\mcp` and `/%2e%2e/mcp` reach `/mcp`. A reverse
 * proxy that matches the raw path sees a different one and its path rules can
 * be bypassed (GHSA-jpvv-r467-5p4w; the SDK's Node adapter builds the URL
 * itself, without the fix in `@hono/node-server`).
 */
function changedByParsing(target: string): boolean {
  const end = target.search(/[?#]/);
  const path = end === -1 ? target : target.slice(0, end);
  try {
    return new URL(target, "http://localhost").pathname !== path;
  } catch {
    return true;
  }
}

/**
 * Serves the app over node:http through the SDK's Node adapter, which bounds
 * the request body while reading it, honours write backpressure and aborts the
 * request when the client goes away.
 */
export function listen(
  app: ServerApp,
  options: { host: string; port: number; onerror?: (error: Error) => void },
): Promise<Listener> {
  const handle = toNodeHandler(app, { onerror: options.onerror });
  // The shutdown in progress. A second stop() (SIGINT after SIGTERM) gets
  // the same promise, so its caller cannot exit before the first finishes.
  let stopped: Promise<void> | undefined;

  const server = createServer((req, res) => {
    // A keep-alive connection can still carry a request after the listener
    // has stopped accepting connections. The closed MCP handler would answer
    // it with a 500; this says what is happening instead.
    if (stopped) {
      res.writeHead(503, { Connection: "close" }).end();
      return;
    }
    if (changedByParsing(req.url ?? "/")) {
      res.writeHead(400).end();
      return;
    }
    void handle(req, res);
  });

  const stop = () => {
    stopped ??= shutDown();
    return stopped;
  };

  const shutDown = async () => {
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    server.closeIdleConnections();
    // Ends listen streams and aborts exchanges still running, so no socket
    // stays busy for long.
    await app.close();
    server.closeAllConnections();
    await closed;
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      // Without a listener a later error, such as accept failing when file
      // descriptors run out, would end the process.
      server.on("error", (error) => options.onerror?.(error));
      resolve({ port: (server.address() as AddressInfo).port, stop });
    });
  });
}
