// Every failure the Dataverse client can produce, classified where the raw
// HTTP exchange is visible. Tools check the class and its fields rather than
// matching message text, and translate what happened into what it means for
// their caller ("Entity not found: …").
//
// Logging (ADR-0001 §12): `status`, `code`, `method` and the class name are
// safe to log. `message` and `url` are not: messages carry raw Dataverse and
// Entra response text, and URLs carry `$filter` literals unmasked.

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
    this.code = errorCode(body);
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

function errorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error
      ?.code;
    return typeof code === "string" ? code : undefined;
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
