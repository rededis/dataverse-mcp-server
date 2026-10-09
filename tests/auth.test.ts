import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataverseAuth } from "../src/auth.js";
import { DataverseAuthError } from "../src/errors.js";

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

  function makeAuth(timeoutMs?: number) {
    return new DataverseAuth(
      "tenant-id",
      "client-id",
      "client-secret",
      "https://org.crm.dynamics.com",
      { timeoutMs },
    );
  }

  function tokenResponse(token: string, expiresIn = 3600) {
    return new Response(
      JSON.stringify({ access_token: token, expires_in: expiresIn }),
      { status: 200 },
    );
  }

  it("throws DataverseAuthError with the status on a failed token request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const error = await makeAuth()
      .getToken()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseAuthError);
    expect((error as DataverseAuthError).status).toBe(401);
    expect((error as Error).message).toBe(
      "OAuth token request failed (401): Unauthorized",
    );
  });

  it("concurrent callers share one in-flight token request", async () => {
    let release: (r: Response) => void = () => {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const auth = makeAuth();

    const calls = [auth.getToken(), auth.getToken(), auth.getToken()];
    release(tokenResponse("shared"));

    expect(await Promise.all(calls)).toEqual(["shared", "shared", "shared"]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not cache a failure: the next call requests again", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(tokenResponse("second"));
    const auth = makeAuth();

    await expect(auth.getToken()).rejects.toBeInstanceOf(DataverseAuthError);
    expect(await auth.getToken()).toBe("second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refreshes once when the cached token is about to expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(tokenResponse("first", 3600))
        .mockResolvedValueOnce(tokenResponse("second", 3600));
      const auth = makeAuth();

      expect(await auth.getToken()).toBe("first");
      // Inside the 5-minute early-refresh margin.
      vi.setSystemTime(Date.now() + 3600_000 - 299_000);
      const [a, b] = await Promise.all([auth.getToken(), auth.getToken()]);

      expect([a, b]).toEqual(["second", "second"]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [label, body] of [
    ["is not JSON", "<html>login</html>"],
    ["has no access_token", '{"expires_in":3600}'],
    ["has an empty access_token", '{"access_token":"","expires_in":3600}'],
    ["has no expires_in", '{"access_token":"t"}'],
    [
      "has a non-numeric expires_in",
      '{"access_token":"t","expires_in":"soon"}',
    ],
  ]) {
    it(`rejects a 200 token response that ${label}, and caches nothing`, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(body, { status: 200 }))
        .mockResolvedValueOnce(tokenResponse("good"));
      const auth = makeAuth();

      await expect(auth.getToken()).rejects.toBeInstanceOf(DataverseAuthError);
      expect(await auth.getToken()).toBe("good");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  }

  it("says why the token request failed when no response arrived", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"),
      }),
    );

    const error = await makeAuth()
      .getToken()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseAuthError);
    expect((error as Error).message).toBe(
      "OAuth token request failed before a response arrived (fetch failed: getaddrinfo ENOTFOUND login.microsoftonline.com)",
    );
  });

  it("times out the token request with DataverseAuthError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          ),
        ),
    );

    const error = await makeAuth(20)
      .getToken()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseAuthError);
    expect((error as Error).message).toBe(
      "OAuth token request timed out after 20 ms",
    );
  });
});
