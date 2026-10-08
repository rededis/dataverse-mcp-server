import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  type McpServerFactory,
  OAuthError,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import type { TokenVerifier } from "./tokens.js";

export interface ServerAppOptions {
  verifier: TokenVerifier;
  createServer: McpServerFactory;
  /** Requests the MCP handler refused or failed, for the operator's log. */
  onerror?: (error: Error) => void;
}

/** The server as a fetch function: routing, the auth gate, and MCP behind it. */
export interface ServerApp {
  fetch(request: Request): Promise<Response>;
  /** Ends open `subscriptions/listen` streams; later requests get a 500. */
  close(): Promise<void>;
}

export const MCP_PATH = "/mcp";

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/**
 * Only `/mcp` is behind the token check. Everything else is answered without
 * one, because `mcp-remote` probes the OAuth discovery paths and `/register`
 * without `Authorization`: a 404 there tells it this server does not do OAuth,
 * where a 401 would start an OAuth flow (ADR-0001 §7). The MCP handler reads
 * no URL and checks no origin or token, so all of that happens here.
 */
export function createServerApp(options: ServerAppOptions): ServerApp {
  const { verifier, createServer, onerror } = options;
  // 2026-07-28 only: a 2025-era request is refused with -32022 (ADR-0001 §5).
  const handler = createMcpHandler(createServer, { legacy: "reject", onerror });

  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/health") {
        // Liveness only: it does not call Dataverse, which would spend the
        // application user's limits and fail whenever Entra or Dataverse is
        // down.
        return Response.json({ status: "ok" });
      }
      if (pathname !== MCP_PATH) return notFound();

      // The specification requires validating Origin against DNS rebinding.
      // No origin is allowed: browser clients are not supported (ADR-0001
      // §7). Clients that are not browsers send none, and are served.
      if (request.headers.has("origin")) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            // -32000, as the SDK's Node adapter answers an origin it refuses.
            error: {
              code: -32000,
              message: "Forbidden: browser requests are not served",
            },
          },
          { status: 403 },
        );
      }

      let authInfo: AuthInfo;
      try {
        // Every request: the protocol is stateless and there is no session to
        // keep a verdict in.
        authInfo = await verifyBearerToken(
          request.headers.get("authorization"),
          { verifier },
        );
      } catch (error) {
        // A refused token is the client's business; anything else is a fault
        // in the verifier, answered with 500, and the operator must see it.
        if (!(error instanceof OAuthError)) onerror?.(error as Error);
        return bearerAuthChallengeResponse(error);
      }

      return handler.fetch(request, { authInfo });
    },

    close: () => handler.close(),
  };
}
