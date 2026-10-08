import { createHash } from "node:crypto";
import { OAuthError, verifyBearerToken } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../../src/server/config.js";
import { ConfigTokenVerifier } from "../../src/server/tokens.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function config(tokens: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ tokens, ...extra });
}

function verifierFor(tokens: unknown) {
  const result = readServerConfig(config(tokens));
  if (!result.ok) throw new Error(result.problems.join("; "));
  return new ConfigTokenVerifier(result.config.tokens);
}

describe("readServerConfig", () => {
  it("reads tokens and allowed origins", () => {
    const result = readServerConfig(
      config(
        [
          { name: "alice", sha256: sha256("a") },
          {
            name: "bob",
            sha256: sha256("b").toUpperCase(),
            expiresAt: "2030-01-01T00:00:00Z",
          },
        ],
        { allowedOrigins: ["https://app.example"] },
      ),
    );
    expect(result).toEqual({
      ok: true,
      config: {
        tokens: [
          { name: "alice", sha256: sha256("a") },
          {
            name: "bob",
            sha256: sha256("b"),
            expiresAt: "2030-01-01T00:00:00Z",
          },
        ],
        allowedOrigins: ["https://app.example"],
      },
    });
  });

  it("defaults allowedOrigins to none", () => {
    const result = readServerConfig(
      config([{ name: "alice", sha256: sha256("a") }]),
    );
    expect(result.ok && result.config.allowedOrigins).toEqual([]);
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["no tokens", config([]), /at least one token/],
    ["a short hash", config([{ name: "a", sha256: "abc" }]), /sha256: expected 64 hex/],
    ["an empty name", config([{ name: "", sha256: sha256("a") }]), /tokens\.0\.name/],
    [
      "a date that is not ISO 8601",
      config([{ name: "a", sha256: sha256("a"), expiresAt: "next year" }]),
      /expiresAt/,
    ],
    [
      "a date without a time zone",
      config([
        { name: "a", sha256: sha256("a"), expiresAt: "2030-01-01T00:00:00" },
      ]),
      /expiresAt/,
    ],
    [
      "an unknown key",
      config([{ name: "a", sha256: sha256("a"), token: "plain" }]),
      /Unrecognized key: "token"/,
    ],
    [
      "two tokens with one name",
      config([
        { name: "a", sha256: sha256("a") },
        { name: "a", sha256: sha256("b") },
      ]),
      /name "a"/,
    ],
    [
      "two tokens with one hash",
      config([
        { name: "a", sha256: sha256("a") },
        { name: "b", sha256: sha256("a").toUpperCase() },
      ]),
      /same sha256/,
    ],
    [
      "an origin with a path",
      config([{ name: "a", sha256: sha256("a") }], {
        allowedOrigins: ["https://app.example/x"],
      }),
      /allowedOrigins/,
    ],
  ])("rejects %s", (_, text, problem) => {
    const result = readServerConfig(text);
    expect(result.ok).toBe(false);
    expect(result.ok || result.problems.join("\n")).toMatch(problem);
  });
});

describe("ConfigTokenVerifier", () => {
  const verifier = verifierFor([
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
