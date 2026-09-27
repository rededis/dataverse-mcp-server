import { DEFAULT_REQUEST_TIMEOUT_MS } from "./config.js";
import {
  DataverseNetworkError,
  DataverseTimeoutError,
  isTimeout,
} from "./errors.js";
import { fetchComplete, type HttpRequest, type HttpResponse } from "./http.js";

export type { HttpRequest, HttpResponse } from "./http.js";

/**
 * Performs one HTTP exchange with Dataverse. DataverseClient builds the
 * request (URL, auth, OData headers) and interprets the response; wrappers
 * around an executor add behaviour in between (retries and limits in #74,
 * acting on behalf of a user in #77, auditing in #78) without touching the
 * tools.
 *
 * Implementations resolve with any status, 4xx and 5xx included: a status
 * is a response, never an exception, so a wrapper can act on it (a 429 and
 * its Retry-After, for instance). They reject with a DataverseError when no
 * usable response can be returned: FetchExecutor with DataverseTimeoutError
 * or DataverseNetworkError; wrappers may add their own subclasses (#74).
 */
export interface RequestExecutor {
  execute(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchExecutor implements RequestExecutor {
  constructor(private timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {}

  async execute(request: HttpRequest): Promise<HttpResponse> {
    // One attempt, body included. Queueing and retries in #74 get their own
    // limits.
    try {
      return await fetchComplete(request, this.timeoutMs);
    } catch (err) {
      if (isTimeout(err)) {
        throw new DataverseTimeoutError(this.timeoutMs, request);
      }
      throw new DataverseNetworkError(request, err);
    }
  }
}
