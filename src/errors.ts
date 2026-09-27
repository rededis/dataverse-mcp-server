// Every failure the Dataverse client can produce, classified where the raw
// HTTP exchange is visible. Tools check the class and its fields rather than
// matching message text, and translate what happened into what it means for
// their caller ("Entity not found: …").

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

  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    body: string,
  ) {
    // Same text as before typed errors existed; callers may still show it.
    super(`Dataverse API error (${status}): ${body}`);
    this.code = errorCode(body);
  }
}

/** No complete response arrived within the per-request timeout. */
export class DataverseTimeoutError extends DataverseError {
  constructor(
    readonly timeoutMs: number,
    readonly method: string,
    readonly url: string,
  ) {
    super(
      `Dataverse request timed out after ${timeoutMs} ms: ${method} ${url}`,
    );
  }
}

/** The request failed before any response: DNS, connection reset, TLS. */
export class DataverseNetworkError extends DataverseError {
  constructor(
    readonly method: string,
    readonly url: string,
    cause: unknown,
  ) {
    super(
      `Dataverse request failed before a response arrived: ${method} ${url} (${describe(cause)})`,
      { cause },
    );
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

function describe(cause: unknown): string {
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
