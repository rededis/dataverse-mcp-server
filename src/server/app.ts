import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  isJSONRPCRequest,
  isJsonContentType,
  type McpServerFactory,
  OAuthError,
  OAuthErrorCode,
  readRequestBody,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { type AuditLog, type RequestFacts, withRequestFacts } from "./audit.js";
import type { TokenVerifier } from "./tokens.js";

export interface ServerAppOptions {
  verifier: TokenVerifier;
  createServer: McpServerFactory;
  /** Where refused tokens and origins are logged, as the factory logs calls. */
  audit: AuditLog;
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

/** Why a token was refused, as the audit line says. */
type AuthRefusal =
  | "missing"
  | "malformed"
  | "unknown"
  | "expired"
  | "insufficient-scope";

/**
 * Only `/mcp` is behind the token check. Everything else is answered without
 * one, because `mcp-remote` probes the OAuth discovery paths and `/register`
 * without `Authorization`: a 404 there tells it this server does not do OAuth,
 * where a 401 would start an OAuth flow (ADR-0001 §7). The MCP handler reads
 * no URL and checks no origin or token, so all of that happens here.
 */
export function createServerApp(options: ServerAppOptions): ServerApp {
  const { verifier, createServer, audit, onerror } = options;
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

      // Set by the proxy in front, so a line leads to the proxy's own log.
      const requestIdHeader = request.headers.get("x-request-id");
      const requestId =
        requestIdHeader === null ? undefined : audit.id(requestIdHeader);
      const withRequestId = requestId !== undefined && { requestId };

      // The specification requires validating Origin against DNS rebinding.
      // No origin is allowed: browser clients are not supported (ADR-0001
      // §7). Clients that are not browsers send none, and are served.
      if (request.headers.has("origin")) {
        audit.write({ event: "origin-refused", ...withRequestId });
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

      // What our verifier returned, if it was called: verifyBearerToken
      // checks expiry after it, so an expired token's name is known only
      // here.
      let verified: AuthInfo | undefined;
      let verifierCalled = false;
      let authInfo: AuthInfo;
      try {
        // Every request: the protocol is stateless and there is no session to
        // keep a verdict in.
        authInfo = await verifyBearerToken(
          request.headers.get("authorization"),
          {
            verifier: {
              async verifyAccessToken(token) {
                verifierCalled = true;
                verified = await verifier.verifyAccessToken(token);
                return verified;
              },
            },
          },
        );
      } catch (error) {
        // A refused token is the client's business; anything else is a fault
        // in the verifier, answered with 500, and the operator must see it.
        if (!(error instanceof OAuthError)) {
          onerror?.(error as Error);
        } else {
          const reason: AuthRefusal = !request.headers.has("authorization")
            ? "missing"
            : !verifierCalled
              ? "malformed"
              : !verified
                ? "unknown"
                : error.code === OAuthErrorCode.InsufficientScope
                  ? "insufficient-scope"
                  : "expired";
          audit.write({
            event: "auth-refused",
            reason,
            // The name only for a token that was known: never the token.
            ...(reason === "expired" &&
              verified && { token: verified.clientId }),
            ...withRequestId,
          });
        }
        return bearerAuthChallengeResponse(error);
      }

      const { forward, parsedBody, call } = await readCall(request, audit);
      const facts: RequestFacts = { ...withRequestId, ...(call && { call }) };
      return handler.fetch(forward, {
        authInfo: withRequestFacts(authInfo, facts),
        ...(parsedBody !== undefined && { parsedBody }),
      });
    },

    close: () => handler.close(),
  };
}

/**
 * Reads a POST's JSON body here rather than in the SDK, so the factory learns
 * a `tools/call` request's id and tool name from the body itself: `Mcp-Name`
 * is checked against the body only for requests, so a notification could
 * otherwise fake a call (#78). The SDK is handed the parsed body and reads
 * nothing again. A body this cannot use (too large, not JSON, unreadable)
 * is passed on unread, and the SDK answers it as it always did.
 */
async function readCall(
  request: Request,
  audit: AuditLog,
): Promise<{
  forward: Request;
  parsedBody?: unknown;
  call?: RequestFacts["call"];
}> {
  if (
    request.method !== "POST" ||
    !isJsonContentType(request.headers.get("content-type"))
  ) {
    return { forward: request };
  }
  const untouched = request.clone();
  let parsedBody: unknown;
  try {
    // The SDK's own bound, which it does not apply to a parsed body.
    const read = await readRequestBody(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (read.tooLarge || read.text === "") return { forward: untouched };
    parsedBody = JSON.parse(read.text);
  } catch {
    return { forward: untouched };
  }
  const call =
    isJSONRPCRequest(parsedBody) &&
    parsedBody.method === "tools/call" &&
    typeof parsedBody.params?.name === "string"
      ? { rpcId: audit.id(parsedBody.id), tool: parsedBody.params.name }
      : undefined;
  return { forward: request, parsedBody, ...(call && { call }) };
}
