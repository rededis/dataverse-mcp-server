import {
  DataverseNetworkError,
  DataverseTimeoutError,
  isTimeout,
} from "./errors.js";

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A complete response: the body is already read, so it can be retried or logged. */
export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Performs one HTTP exchange with Dataverse. DataverseClient builds the
 * request (URL, auth, OData headers) and interprets the response; wrappers
 * around an executor add behaviour in between (retries and limits in #74,
 * acting on behalf of a user in #77, auditing in #78) without touching the
 * tools.
 *
 * Implementations resolve with any status, 4xx and 5xx included, and reject
 * only when no complete response arrived: DataverseTimeoutError or
 * DataverseNetworkError.
 */
export interface RequestExecutor {
  execute(request: HttpRequest): Promise<HttpResponse>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class FetchExecutor implements RequestExecutor {
  constructor(private timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {}

  async execute(request: HttpRequest): Promise<HttpResponse> {
    // The timeout covers one attempt, body included; the signal stays armed
    // until text() finishes. Queueing and retries in #74 get their own limits.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
      });
      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      };
    } catch (err) {
      if (isTimeout(err)) {
        throw new DataverseTimeoutError(
          this.timeoutMs,
          request.method,
          request.url,
        );
      }
      throw new DataverseNetworkError(request.method, request.url, err);
    }
  }
}
