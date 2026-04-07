import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataverseAuth } from "../src/auth.js";

describe("DataverseAuth", () => {
  const mockToken = {
    access_token: "mock-token-123",
    expires_in: 3600,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a token from Azure AD", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockToken), { status: 200 }),
      );

    const auth = new DataverseAuth(
      "tenant-id",
      "client-id",
      "client-secret",
      "https://org.crm.dynamics.com",
    );

    const token = await auth.getToken();
    expect(token).toBe("mock-token-123");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
    );
    expect(options?.method).toBe("POST");
    expect(options?.body).toContain("grant_type=client_credentials");
    expect(options?.body).toContain("client_id=client-id");
  });

  it("caches the token on subsequent calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockToken), { status: 200 }),
      );

    const auth = new DataverseAuth(
      "tenant-id",
      "client-id",
      "client-secret",
      "https://org.crm.dynamics.com",
    );

    await auth.getToken();
    await auth.getToken();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("throws on failed token request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const auth = new DataverseAuth(
      "tenant-id",
      "client-id",
      "client-secret",
      "https://org.crm.dynamics.com",
    );

    await expect(auth.getToken()).rejects.toThrow("OAuth token request failed");
  });
});
