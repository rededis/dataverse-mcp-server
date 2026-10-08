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
 * Serves the app over node:http through the SDK's Node adapter, which bounds
 * the request body while reading it, honours write backpressure and aborts the
 * request when the client goes away.
 */
export function listen(
  app: ServerApp,
  options: { host: string; port: number; onerror?: (error: Error) => void },
): Promise<Listener> {
  const handle = toNodeHandler(app, { onerror: options.onerror });
  let stopping = false;

  const server = createServer((req, res) => {
    // A keep-alive connection can still carry a request after the listener
    // has stopped accepting connections. The closed MCP handler would answer
    // it with a 500; this says what is happening instead.
    if (stopping) {
      res.writeHead(503, { Connection: "close" }).end();
      return;
    }
    void handle(req, res);
  });

  const stop = async () => {
    if (stopping) return;
    stopping = true;
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
      resolve({ port: (server.address() as AddressInfo).port, stop });
    });
  });
}
