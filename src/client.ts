import type { DataverseAuth } from "./auth.js";
import { DataverseApiError } from "./errors.js";
import { FetchExecutor, type RequestExecutor } from "./executor.js";

export interface DataverseRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface DataverseClientOptions {
  apiVersion?: string;
  /** Performs the HTTP exchange. Defaults to a FetchExecutor with `timeoutMs`. */
  executor?: RequestExecutor;
  /** Per-request timeout for the default executor. Ignored when `executor` is given. */
  timeoutMs?: number;
}

export class DataverseClient {
  private baseUrl: string;
  private executor: RequestExecutor;

  constructor(
    private auth: DataverseAuth,
    resourceUrl: string,
    options: DataverseClientOptions = {},
  ) {
    const normalizedUrl = resourceUrl.replace(/\/+$/, "");
    this.baseUrl = `${normalizedUrl}/api/data/${options.apiVersion ?? "v9.2"}`;
    this.executor = options.executor ?? new FetchExecutor(options.timeoutMs);
  }

  async request(
    path: string,
    options: DataverseRequestOptions = {},
  ): Promise<unknown> {
    const token = await this.auth.getToken();
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const method = options.method || "GET";

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "OData-Version": "4.0",
      "OData-MaxVersion": "4.0",
      Accept: "application/json",
      ...options.headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.executor.execute({
      method,
      url,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 204) {
      const entityId = response.headers.get("OData-EntityId");
      return entityId ? { "@odata.entityId": entityId } : {};
    }

    if (response.status < 200 || response.status >= 300) {
      throw new DataverseApiError(response.status, method, url, response.body);
    }

    return JSON.parse(response.body);
  }

  async get(path: string): Promise<unknown> {
    return this.request(path);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body });
  }

  async patch(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "PATCH", body });
  }

  async delete(path: string): Promise<unknown> {
    return this.request(path, { method: "DELETE" });
  }
}
