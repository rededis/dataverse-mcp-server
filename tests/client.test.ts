import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataverseAuth } from "../src/auth.js";
import { DataverseClient } from "../src/client.js";
import { DataverseApiError } from "../src/errors.js";
import type { HttpRequest, RequestExecutor } from "../src/executor.js";

describe("DataverseClient", () => {
  let client: DataverseClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    const auth = new DataverseAuth(
      "tenant",
      "client",
      "secret",
      "https://org.crm.dynamics.com",
    );
    vi.spyOn(auth, "getToken").mockResolvedValue("test-token");
    client = new DataverseClient(auth, "https://org.crm.dynamics.com");
  });

  it("sends GET request with correct URL and headers", async () => {
    const mockData = { value: [{ id: "1" }] };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockData), { status: 200 }),
      );

    const result = await client.get("/accounts?$top=1");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://org.crm.dynamics.com/api/data/v9.2/accounts?$top=1",
    );
    expect(options?.method).toBe("GET");
    expect((options?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(result).toEqual(mockData);
  });

  it("sends POST request with body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: {
          "OData-EntityId": "https://org/api/data/v9.2/accounts(123)",
        },
      }),
    );

    const result = await client.post("/accounts", { name: "Test" });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe(JSON.stringify({ name: "Test" }));
    expect(result).toEqual({
      "@odata.entityId": "https://org/api/data/v9.2/accounts(123)",
    });
  });

  it("throws on error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":"not found"}', { status: 404 }),
    );

    await expect(client.get("/bad")).rejects.toThrow(
      "Dataverse API error (404)",
    );
  });

  it("throws DataverseApiError with the status and the code from the error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        '{"error":{"code":"0x80060888","message":"Resource not found"}}',
        { status: 404 },
      ),
    );

    const error = await client.get("/bad").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseApiError);
    expect((error as DataverseApiError).status).toBe(404);
    expect((error as DataverseApiError).code).toBe("0x80060888");
    expect((error as DataverseApiError).method).toBe("GET");
    // Message text is unchanged from before typed errors.
    expect((error as Error).message).toBe(
      'Dataverse API error (404): {"error":{"code":"0x80060888","message":"Resource not found"}}',
    );
  });

  it("leaves code undefined when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>gateway</html>", { status: 502 }),
    );

    const error = await client.get("/bad").catch((e: unknown) => e);

    expect((error as DataverseApiError).status).toBe(502);
    expect((error as DataverseApiError).code).toBeUndefined();
  });

  it("handles 204 with no OData-EntityId", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await client.delete("/accounts(123)");
    expect(result).toEqual({});
  });
});

describe("DataverseClient with an injected executor", () => {
  function recordingExecutor(status = 200, body = "{}") {
    const requests: HttpRequest[] = [];
    const executor: RequestExecutor = {
      execute: async (request) => {
        requests.push(request);
        return { status, headers: new Headers(), body };
      },
    };
    return { executor, requests };
  }

  function makeClient(executor: RequestExecutor) {
    const auth = new DataverseAuth(
      "tenant",
      "client",
      "secret",
      "https://org.crm.dynamics.com",
    );
    vi.spyOn(auth, "getToken").mockResolvedValue("test-token");
    return new DataverseClient(auth, "https://org.crm.dynamics.com/", {
      executor,
    });
  }

  it("hands the executor a complete request and parses its response", async () => {
    const { executor, requests } = recordingExecutor(200, '{"id":"1"}');
    const client = makeClient(executor);

    const result = await client.request("/accounts", {
      method: "PATCH",
      body: { name: "A" },
      headers: { "If-Match": "*" },
    });

    expect(result).toEqual({ id: "1" });
    expect(requests).toEqual([
      {
        method: "PATCH",
        url: "https://org.crm.dynamics.com/api/data/v9.2/accounts",
        headers: {
          Authorization: "Bearer test-token",
          "OData-Version": "4.0",
          "OData-MaxVersion": "4.0",
          Accept: "application/json",
          "If-Match": "*",
          "Content-Type": "application/json",
        },
        body: '{"name":"A"}',
      },
    ]);
  });

  it("passes absolute URLs (e.g. @odata.nextLink) through unchanged", async () => {
    const { executor, requests } = recordingExecutor();
    const client = makeClient(executor);
    const next = "https://org.crm.dynamics.com/api/data/v9.2/accounts?$skiptoken=x";

    await client.get(next);

    expect(requests[0].url).toBe(next);
    expect(requests[0].body).toBeUndefined();
  });

  it("does not catch what the executor rejects with", async () => {
    const failure = new Error("from the executor");
    const client = makeClient({ execute: () => Promise.reject(failure) });

    await expect(client.get("/accounts")).rejects.toBe(failure);
  });
});
