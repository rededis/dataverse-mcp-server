import { describe, expect, it } from "vitest";
import {
  expiredTokens,
  ROLE_GROUPS,
  readListenSettings,
  readServerConfig,
} from "../../src/server/config.js";
import { NO_PERMISSIONS } from "../../src/tools/permissions.js";
import { SERVER_TOOL_GROUPS } from "../../src/tools/server-groups.js";
import { READER, sha256 } from "./helpers.js";

const READER_ROLE = { groups: ["metadata-read", "data-read"] };

// Tokens get the reader role unless they name one.
function config(
  tokens: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    roles: { reader: READER_ROLE },
    tokens: tokens.map((t) => ({ role: "reader", ...t })),
    ...extra,
  });
}

function problemsOf(text: string): string {
  const result = readServerConfig(text);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.problems.join("\n");
}

describe("readListenSettings", () => {
  it("defaults to port 3000 on the loopback interface", () => {
    expect(readListenSettings({ DATAVERSE_SERVER_CONFIG: "/c.json" })).toEqual({
      ok: true,
      settings: { host: "127.0.0.1", port: 3000, configPath: "/c.json" },
    });
  });

  it("reads DATAVERSE_SERVER_HOST and PORT", () => {
    expect(
      readListenSettings({
        DATAVERSE_SERVER_CONFIG: "/c.json",
        DATAVERSE_SERVER_HOST: "0.0.0.0",
        PORT: "8080",
      }),
    ).toEqual({
      ok: true,
      settings: { host: "0.0.0.0", port: 8080, configPath: "/c.json" },
    });
  });

  // tcsh exports HOST as the machine's name.
  it("ignores HOST", () => {
    const result = readListenSettings({
      DATAVERSE_SERVER_CONFIG: "/c.json",
      HOST: "build-agent-7",
    });
    expect(result.ok && result.settings.host).toBe("127.0.0.1");
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
        roles: { reader: READER },
        tokens: [
          { name: "alice", sha256: sha256("a"), role: "reader" },
          {
            name: "bob",
            sha256: sha256("b"),
            expiresAt: "2030-01-01T00:00:00Z",
            role: "reader",
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
    expect(problemsOf(text)).toMatch(problem);
  });
});

describe("readServerConfig: roles", () => {
  it("knows exactly the server's tool groups", () => {
    expect([...ROLE_GROUPS]).toEqual(Object.keys(SERVER_TOOL_GROUPS));
  });

  const support = {
    groups: ["metadata-read", "data-read", "data-write", "actions"],
    dataWrite: { create: ["emails", "tasks"] },
    actions: ["SendEmail"],
  };

  it("reads roles into groups and permissions, and actAs into the token", () => {
    const actAs = "22222222-2222-2222-2222-222222222222";
    const result = readServerConfig(
      JSON.stringify({
        roles: {
          support,
          writer: {
            groups: ["data-read", "data-write", "functions"],
            dataWrite: { create: ["tasks"], update: ["tasks", "accounts"] },
            functions: ["RetrieveTotalRecordCount"],
          },
        },
        tokens: [
          { name: "agent", sha256: sha256("a"), role: "support", actAs },
          { name: "laptop", sha256: sha256("b"), role: "writer" },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      config: {
        roles: {
          support: {
            groups: ["metadata-read", "data-read", "data-write", "actions"],
            permissions: {
              ...NO_PERMISSIONS,
              create: ["emails", "tasks"],
              actions: ["SendEmail"],
            },
          },
          writer: {
            groups: ["data-read", "data-write", "functions"],
            permissions: {
              ...NO_PERMISSIONS,
              create: ["tasks"],
              update: ["tasks", "accounts"],
              functions: ["RetrieveTotalRecordCount"],
            },
          },
        },
        tokens: [
          { name: "agent", sha256: sha256("a"), role: "support", actAs },
          { name: "laptop", sha256: sha256("b"), role: "writer" },
        ],
      },
    });
  });

  const withRole = (role: unknown, token: Record<string, unknown> = {}) =>
    JSON.stringify({
      roles: { r: role },
      tokens: [{ name: "a", sha256: sha256("a"), role: "r", ...token }],
    });

  it.each([
    [
      "a token without a role",
      JSON.stringify({
        roles: {},
        tokens: [{ name: "a", sha256: sha256("a") }],
      }),
      /tokens\.0\.role/,
    ],
    [
      "a role that is not defined",
      config([{ name: "a", sha256: sha256("a"), role: "admin" }]),
      /"a" has the role "admin", which is not in roles/,
    ],
    ["a config without roles", JSON.stringify({ tokens: [] }), /roles/],
    [
      "a role named __proto__",
      '{"roles":{"__proto__":{"groups":["data-read"]}},"tokens":[{"name":"a","sha256":"' +
        sha256("a") +
        '","role":"__proto__"}]}',
      /"__proto__" is not a role name/,
    ],
    ["a role without groups", withRole({ groups: [] }), /at least one group/],
    [
      "the development group",
      withRole({ groups: ["development"] }),
      /roles\.r\.groups\.0/,
    ],
    [
      "a group listed twice",
      withRole({ groups: ["data-read", "data-read"] }),
      /"data-read" is listed more than once/,
    ],
    [
      "data-write without entity sets",
      withRole({ groups: ["data-write"] }),
      /the "data-write" group needs entries in dataWrite/,
    ],
    [
      "data-write with only empty lists",
      withRole({ groups: ["data-write"], dataWrite: { delete: [] } }),
      /the "data-write" group needs entries in dataWrite/,
    ],
    [
      "entity sets without data-write",
      withRole({ groups: ["data-read"], dataWrite: { create: ["emails"] } }),
      /roles\.r\.dataWrite: has no effect without the "data-write" group/,
    ],
    [
      "actions without the actions group",
      withRole({ groups: ["data-read"], actions: ["SendEmail"] }),
      /roles\.r\.actions: has no effect/,
    ],
    [
      "the functions group without functions",
      withRole({ groups: ["functions"] }),
      /the "functions" group needs entries in functions/,
    ],
    [
      '"*" for entity sets',
      withRole({ groups: ["data-write"], dataWrite: { create: ["*"] } }),
      /"\*" is not accepted: list the names/,
    ],
    [
      "an entity set that is not a plain name",
      withRole({
        groups: ["data-write"],
        dataWrite: { create: ["emails/.."] },
      }),
      /an entity set name/,
    ],
    [
      '"*" for actions',
      withRole({ groups: ["actions"], actions: ["*"] }),
      /"\*" is not accepted: list the names/,
    ],
    [
      '"*" for functions',
      withRole({ groups: ["functions"], functions: ["*"] }),
      /"\*" is not accepted: list the names/,
    ],
    [
      "a namespaced action name",
      withRole({
        groups: ["actions"],
        actions: ["Microsoft.Dynamics.CRM.SendEmail"],
      }),
      /without a namespace/,
    ],
    [
      "an unknown key in a role",
      withRole({ groups: ["data-read"], read: ["accounts"] }),
      /Unrecognized key: "read"/,
    ],
    [
      "an unknown write operation",
      withRole({ groups: ["data-write"], dataWrite: { upsert: ["emails"] } }),
      /Unrecognized key: "upsert"/,
    ],
    [
      "an actAs that is not a GUID",
      withRole({ groups: ["data-read"] }, { actAs: "support@contoso.com" }),
      /Entra object id/,
    ],
  ])("rejects %s", (_, text, problem) => {
    expect(problemsOf(text)).toMatch(problem);
  });
});

describe("expiredTokens", () => {
  it("names the tokens whose expiry has passed", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(
      expiredTokens(
        [
          { name: "forever", sha256: sha256("a"), role: "r" },
          {
            name: "old",
            role: "r",
            sha256: sha256("b"),
            expiresAt: "2026-10-08T11:59:59Z",
          },
          {
            name: "later",
            role: "r",
            sha256: sha256("c"),
            expiresAt: "2026-10-08T15:00:00+03:00",
          },
          {
            name: "soon",
            role: "r",
            sha256: sha256("d"),
            expiresAt: "2026-10-08T12:00:01Z",
          },
        ],
        now,
      ),
    ).toEqual(["old", "later"]);
  });
});
