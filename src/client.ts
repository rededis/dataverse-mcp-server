import { DataverseAuth } from "./auth.js";

export interface DataverseRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class DataverseClient {
  private baseUrl: string;

  constructor(
    private auth: DataverseAuth,
    resourceUrl: string,
    private apiVersion: string = "v9.2"
  ) {
    this.baseUrl = `${resourceUrl}/api/data/${apiVersion}`;
  }

  async request(path: string, options: DataverseRequestOptions = {}): Promise<unknown> {
    const token = await this.auth.getToken();
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "OData-Version": "4.0",
      "OData-MaxVersion": "4.0",
      Accept: "application/json",
      ...options.headers,
    };

    if (options.body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 204) {
      const entityId = response.headers.get("OData-EntityId");
      return entityId ? { "@odata.entityId": entityId } : {};
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Dataverse API error (${response.status}): ${text}`);
    }

    return response.json();
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
