import { OAuthError, verifyBearerToken } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { ConfigTokenVerifier } from "../../src/server/tokens.js";
import { sha256 } from "./helpers.js";

describe("ConfigTokenVerifier", () => {
  const verifier = new ConfigTokenVerifier([
    { name: "alice", sha256: sha256("alice-token") },
    {
      name: "bob",
      sha256: sha256("bob-token"),
      expiresAt: "2099-01-01T00:00:00Z",
    },
    {
      name: "carol",
      sha256: sha256("carol-token"),
      expiresAt: "2020-01-01T00:00:00Z",
    },
  ]);

  const verify = (header: string | undefined) =>
    verifyBearerToken(header, { verifier });

  it("accepts a token without expiry", async () => {
    const info = await verify("Bearer alice-token");
    expect(info).toMatchObject({
      token: "alice-token",
      clientId: "alice",
      scopes: [],
      expiresAt: Number.POSITIVE_INFINITY,
    });
  });

  // AuthInfo.expiresAt is in seconds, as the SDK compares it to Date.now() / 1000.
  it("accepts a token before its expiry and reports it in seconds", async () => {
    const info = await verify("Bearer bob-token");
    expect(info.clientId).toBe("bob");
    expect(info.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z") / 1000);
  });

  it.each([
    ["a missing header", undefined, "Missing Authorization header"],
    ["another scheme", "Basic alice-token", "Invalid Authorization header"],
    ["an unknown token", "Bearer nobody", "Invalid token"],
    ["an expired token", "Bearer carol-token", "Token has expired"],
  ])("rejects %s", async (_, header, message) => {
    const error = await verify(header).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).message).toContain(message);
  });

  it("does not accept the hash itself as a token", async () => {
    await expect(verify(`Bearer ${sha256("alice-token")}`)).rejects.toThrow(
      "Invalid token",
    );
  });
});
