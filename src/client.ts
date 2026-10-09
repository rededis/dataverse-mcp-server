import type { DataverseAuth } from "./auth.js";
import {
  DataverseApiError,
  DataverseCallerDeniedError,
  DataverseError,
  type OnBehalfOf,
} from "./errors.js";
import { FetchExecutor, type RequestExecutor } from "./executor.js";

export interface DataverseRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface DataverseClientOptions {
  apiVersion?: string;
  /** Performs the HTTP exchange. Defaults to a FetchExecutor with the default timeout. */
  executor?: RequestExecutor;
  /** Every request is made on behalf of this user (`CallerObjectId`). */
  caller?: OnBehalfOf;
}

// What fetch would resolve or cut off in the path, so that it addressed
// another resource than the one built: a `.` or `..` segment, encoded dots,
// a backslash (a `/` to the URL parser), a fragment, and control characters,
// tabs and newlines included, which the parser deletes (`.\t.` becomes `..`).
// Only the part before `?` is checked: a query may hold such text as data.
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what this refuses.
const UNSAFE_PATH = /(^|\/)\.{1,2}(\/|$)|%2e|\\|#|[\x00-\x1f\x7f]/i;

/**
 * The last line of defence against a tool argument that changes which
 * resource a request reaches (`/EntityDefinitions(LogicalName='/../contacts`).
 * Tools check their arguments first, with messages that say what is wrong;
 * this catches the tool that forgot. Absolute URLs are Dataverse's own
 * (`@odata.nextLink`) and pass.
 */
function assertPathStaysPut(path: string): void {
  const beforeQuery = path.split("?", 1)[0];
  if (UNSAFE_PATH.test(beforeQuery)) {
    throw new DataverseError(
      `Refused a request path that would reach another resource: ${beforeQuery}`,
    );
  }
}

export class DataverseClient {
  private baseUrl: string;
  private executor: RequestExecutor;
  private caller?: OnBehalfOf;

  constructor(
    private auth: DataverseAuth,
    private resourceUrl: string,
    private options: DataverseClientOptions = {},
  ) {
    const normalizedUrl = resourceUrl.replace(/\/+$/, "");
    this.baseUrl = `${normalizedUrl}/api/data/${options.apiVersion ?? "v9.2"}`;
    this.executor = options.executor ?? new FetchExecutor();
    this.caller = options.caller;
  }

  /**
   * The same client, with every request made on behalf of a Dataverse user
   * (ADR-0001 §8): Dataverse then applies that user's privileges and records
   * the user as the author, with the application user as the delegate
   * (`createdonbehalfby`). It shares the token cache and the executor, so the
   * service protection state stays one per process.
   */
  onBehalfOf(caller: OnBehalfOf): DataverseClient {
    return new DataverseClient(this.auth, this.resourceUrl, {
      ...this.options,
      executor: this.executor,
      caller,
    });
  }

  async request(
    path: string,
    options: DataverseRequestOptions = {},
  ): Promise<unknown> {
    if (!path.startsWith("http")) assertPathStaysPut(path);
    const token = await this.auth.getToken();
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const method = options.method || "GET";

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "OData-Version": "4.0",
      "OData-MaxVersion": "4.0",
      Accept: "application/json",
      // Microsoft's preferred header; MSCRMCallerID with a systemuserid is
      // the legacy one.
      ...(this.caller && { CallerObjectId: this.caller.objectId }),
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

    if (this.caller && response.status === 403) {
      throw new DataverseCallerDeniedError(
        { method, url },
        response.body,
        this.caller,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new DataverseApiError(
        response.status,
        { method, url },
        response.body,
      );
    }

    try {
      return JSON.parse(response.body);
    } catch (err) {
      throw new DataverseError(
        `Dataverse returned ${response.status} with a body that is not JSON: ${method} ${url}`,
        { cause: err },
      );
    }
  }

  async get(path: string): Promise<unknown> {
    return this.request(path);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body });
  }

  async patch(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    return this.request(path, { method: "PATCH", body, headers });
  }

  async delete(path: string): Promise<unknown> {
    return this.request(path, { method: "DELETE" });
  }
}
