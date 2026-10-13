export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Told what happens to this request on its way; never sent. */
  observer?: RequestObserver;
}

/**
 * What a call's requests went through, for the audit log (#78). The client
 * and the service protection executors report to it; the executors stay one
 * per process, and the observer travels with each request instead.
 */
export interface RequestObserver {
  /**
   * The request goes out to Dataverse, a resend included. One the
   * concurrency limit or a throttling pause turns away is never sent.
   */
  sent?(): void;
  /** A JSON response: the length of its `value` array, and whether it has a next page. */
  answered?(response: { records?: number; more: boolean }): void;
  /** Dataverse answered this request with 429. */
  throttled?(): void;
  /** The request waited before its first send, because another was throttled. */
  heldBack?(): void;
  /** The request is sent again after a 429. */
  retried?(): void;
}

/** A complete response: the body is already read, so it can be retried or logged. */
export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * One fetch whose timeout covers the whole exchange, body included: the
 * signal stays armed until text() finishes. Rejects with whatever fetch
 * rejects with; callers classify (isTimeout, describeCause).
 */
export async function fetchComplete(
  request: HttpRequest,
  timeoutMs: number,
): Promise<HttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}
