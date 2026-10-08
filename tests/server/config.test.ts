import { describe, expect, it } from "vitest";
import {
  readListenSettings,
  readServerConfig,
} from "../../src/server/config.js";
import { sha256 } from "./helpers.js";

function config(tokens: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ tokens, ...extra });
}

describe("readListenSettings", () => {
  it("defaults to port 3000 on the loopback interface", () => {
    expect(readListenSettings({ DATAVERSE_SERVER_CONFIG: "/c.json" })).toEqual({
      ok: true,
      settings: { host: "127.0.0.1", port: 3000, configPath: "/c.json" },
    });
  });

  it("reads HOST and PORT", () => {
    expect(
      readListenSettings({
        DATAVERSE_SERVER_CONFIG: "/c.json",
        HOST: "0.0.0.0",
        PORT: "8080",
      }),
    ).toEqual({
      ok: true,
      settings: { host: "0.0.0.0", port: 8080, configPath: "/c.json" },
    });
  });

  it("names a missing config path and a bad port", () => {
    const result = readListenSettings({ PORT: "80a" });
    expect(result).toEqual({
      ok: false,
      problems: [
        "DATAVERSE_SERVER_CONFIG is not set (the path to the server's JSON config file)",
        "PORT=80a (expected a whole number from 1 to 65535)",
      ],
    });
  });

  it.each(["0", "65536", " 80", "8e3"])("rejects PORT=%s", (port) => {
    const result = readListenSettings({
      DATAVERSE_SERVER_CONFIG: "/c.json",
      PORT: port,
    });
    expect(result.ok).toBe(false);
  });
});

describe("readServerConfig", () => {
  it("reads tokens", () => {
    const result = readServerConfig(
      config([
        { name: "alice", sha256: sha256("a") },
        {
          name: "bob",
          sha256: sha256("b").toUpperCase(),
          expiresAt: "2030-01-01T00:00:00Z",
        },
      ]),
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
      },
    });
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["no tokens", config([]), /at least one token/],
    [
      "a short hash",
      config([{ name: "a", sha256: "abc" }]),
      /sha256: expected 64 hex/,
    ],
    [
      "an empty name",
      config([{ name: "", sha256: sha256("a") }]),
      /tokens\.0\.name/,
    ],
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
    // A config written for an earlier version, or a typo, is refused rather
    // than ignored.
    [
      "an unknown top-level key",
      config([{ name: "a", sha256: sha256("a") }], {
        allowedOrigins: ["https://app.example"],
      }),
      /Unrecognized key: "allowedOrigins"/,
    ],
  ])("rejects %s", (_, text, problem) => {
    const result = readServerConfig(text);
    expect(result.ok).toBe(false);
    expect(result.ok || result.problems.join("\n")).toMatch(problem);
  });
});
