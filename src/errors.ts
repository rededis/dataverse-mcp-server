// Every failure the Dataverse client can produce, classified where the raw
// HTTP exchange is visible. Tools check the class and its fields rather than
// matching message text, and translate what happened into what it means for
// their caller ("Entity not found: …").
//
// Logging (ADR-0001 §12): `status`, `code`, `method`, `reason`,
// `retryAfterMs` and the class name are safe to log. `message` and `url` are
// not: messages carry raw Dataverse and Entra response text, and URLs carry
// `$filter` literals unmasked. DataverseBusyError is the exception: its
// message is written here and carries neither.

import type { HttpRequest } from "./http.js";

/** Which request failed: enough to name it, without headers or body. */
type RequestLine = Pick<HttpRequest, "method" | "url">;

export class DataverseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Dataverse answered with a non-2xx status. */
export class DataverseApiError extends DataverseError {
  /** `error.code` from the JSON error body, e.g. `0x80060888`, when present. */
  readonly code?: string;

  readonly method: string;
  readonly url: string;

  constructor(
    readonly status: number,
    request: RequestLine,
    body: string,
  ) {
    // Same text as before typed errors existed; callers may still show it.
    super(`Dataverse API error (${status}): ${body}`);
    this.method = request.method;
    this.url = request.url;
    this.code = errorField(body, "code");
  }
}

/** Who a request was made on behalf of: the token's name and its `actAs`. */
export interface OnBehalfOf {
  /** The token's name in the server config. */
  name: string;
  /** The Dataverse user's Microsoft Entra object id. */
  objectId: string;
}

// prvActOnBehalfOfAnotherUser is missing from the application user's roles.
const CANNOT_ACT_ON_BEHALF = "0x8004a110";
// PrivilegeDenied: the user, or the application user, lacks a privilege.
const PRIVILEGE_DENIED = "0x80040220";

/**
 * Dataverse refused (403) a request made on behalf of a user. Its own message
 * names a systemuserid, which neither the agent nor the operator can map to
 * a token, so this one names the token and the user it acts as, and keeps
 * Dataverse's text. Only the two codes whose cause is known get an
 * explanation; any other 403 (a disabled or unlicensed user, for instance)
 * is passed on as Dataverse put it.
 */
export class DataverseCallerDeniedError extends DataverseApiError {
  constructor(request: RequestLine, body: string, caller: OnBehalfOf) {
    super(403, request, body);
    const who = `user ${caller.objectId}, on whose behalf token "${caller.name}" acts`;
    const said = `Dataverse said: ${errorField(body, "message") ?? body}`;
    switch (this.code?.toLowerCase()) {
      case CANNOT_ACT_ON_BEHALF:
        this.message = `Dataverse refused to act for ${who}: the server's application user lacks the "Act on Behalf of Another User" privilege (prvActOnBehalfOfAnotherUser), which must be in a security role assigned to it directly, not through a team. ${said}`;
        break;
      case PRIVILEGE_DENIED:
        this.message = `Dataverse denied this call for lack of a privilege, to ${who}. The user, and the server's application user, both need it. ${said}`;
        break;
      default:
        this.message = `Dataverse refused this call made for ${who}. ${said}`;
    }
  }
}

/** No complete response arrived within the per-request timeout. */
export class DataverseTimeoutError extends DataverseError {
  readonly method: string;
  readonly url: string;

  constructor(
    readonly timeoutMs: number,
    request: RequestLine,
  ) {
    super(
      `Dataverse request timed out after ${timeoutMs} ms: ${request.method} ${request.url}`,
    );
    this.method = request.method;
    this.url = request.url;
  }
}

/** The request failed before any response: DNS, connection reset, TLS. */
export class DataverseNetworkError extends DataverseError {
  readonly method: string;
  readonly url: string;

  constructor(request: RequestLine, cause: unknown) {
    super(
      `Dataverse request failed before a response arrived: ${request.method} ${request.url} (${describeCause(cause)})`,
      { cause },
    );
    this.method = request.method;
    this.url = request.url;
  }
}

/** The access token could not be obtained from Microsoft Entra ID. */
export class DataverseAuthError extends DataverseError {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Why a request was turned away without an answer from Dataverse. */
export type BusyReason = "throttled" | "queue-full" | "queue-timeout";

/**
 * Dataverse cannot take the request now: it is throttling this application
 * user (service protection limits), or too many requests are already waiting
 * here. The message never repeats Dataverse's own 429 text, which is not
 * meant for users and embeds the environment's limit values.
 */
export class DataverseBusyError extends DataverseError {
  constructor(
    readonly reason: BusyReason,
    message: string,
    /**
     * How long to wait before trying again, for "throttled": what Dataverse
     * asked for, or this server's own backoff when Dataverse named no wait.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A string field of the JSON error body (`{"error":{"code":…,"message":…}}`). */
function errorField(
  body: string,
  field: "code" | "message",
): string | undefined {
  try {
    const value = (JSON.parse(body) as { error?: Record<string, unknown> })
      .error?.[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A readable reason for a failed fetch, including undici's inner cause. */
export function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  // undici reports "fetch failed" and keeps the useful part in its own cause.
  const inner = cause.cause instanceof Error ? `: ${cause.cause.message}` : "";
  return `${cause.message}${inner}`;
}

/** True for the rejection AbortSignal.timeout() produces. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/** Dataverse said the addressed resource does not exist. */
export function isNotFound(err: unknown): boolean {
  return err instanceof DataverseApiError && err.status === 404;
}
