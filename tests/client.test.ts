import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataverseAuth } from "../src/auth.js";
import { DataverseClient } from "../src/client.js";

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

  it("handles 204 with no OData-EntityId", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await client.delete("/accounts(123)");
    expect(result).toEqual({});
  });
});
