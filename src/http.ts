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
