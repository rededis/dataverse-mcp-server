import { afterEach, describe, expect, it, vi } from "vitest";
import { DataverseNetworkError, DataverseTimeoutError } from "../src/errors.js";
import { FetchExecutor } from "../src/executor.js";

const request = {
  method: "GET",
  url: "https://org.crm.dynamics.com/api/data/v9.2/accounts",
  headers: { Accept: "application/json" },
};

// A fetch that never answers on its own and rejects the way the real one does
// when its signal aborts.
function hangingFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          ),
        ),
    );
}

describe("FetchExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with status, headers and the body read to the end", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"value":[]}', {
        status: 200,
        headers: { "OData-Version": "4.0" },
      }),
    );

    const response = await new FetchExecutor(1_000).execute(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("OData-Version")).toBe("4.0");
    expect(response.body).toBe('{"value":[]}');
  });

  it("resolves, not rejects, on a non-2xx status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("busy", { status: 429, headers: { "Retry-After": "5" } }),
    );

    const response = await new FetchExecutor(1_000).execute(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("passes an abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await new FetchExecutor(1_000).execute(request);

    expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with DataverseTimeoutError when no response arrives in time", async () => {
    hangingFetch();

    const error = await new FetchExecutor(20)
      .execute(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseTimeoutError);
    expect((error as DataverseTimeoutError).timeoutMs).toBe(20);
    expect((error as Error).message).toBe(
      "Dataverse request timed out after 20 ms: GET https://org.crm.dynamics.com/api/data/v9.2/accounts",
    );
  });

  it("rejects with DataverseNetworkError when fetch fails before a response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED"),
      }),
    );

    const error = await new FetchExecutor(1_000)
      .execute(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseNetworkError);
    expect((error as Error).message).toBe(
      "Dataverse request failed before a response arrived: GET https://org.crm.dynamics.com/api/data/v9.2/accounts (fetch failed: connect ECONNREFUSED)",
    );
  });
});
