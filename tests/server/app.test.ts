import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DataverseClient } from "../../src/client.js";
import { DataverseCallerDeniedError } from "../../src/errors.js";
import { createServerApp } from "../../src/server/app.js";
import type { Role } from "../../src/server/config.js";
import { createServerFactory } from "../../src/server/mcp.js";
import { ConfigTokenVerifier } from "../../src/server/tokens.js";
import { NO_PERMISSIONS } from "../../src/tools/permissions.js";
import { READER, serverConfig, sha256 } from "./helpers.js";

const BASE = "http://127.0.0.1:8080";
const AUTH = { Authorization: "Bearer alice-token" };
const GUID = "11111111-1111-1111-1111-111111111111";
const DAVE = "22222222-2222-2222-2222-222222222222";

// The support role from #77: reads everything, may create emails and tasks,
// and send an email.
const SUPPORT: Role = {
  groups: ["metadata-read", "data-read", "data-write", "actions"],
  permissions: {
    ...NO_PERMISSIONS,
    create: ["emails", "tasks"],
    actions: ["SendEmail"],
  },
};

// Every group, listed in reverse to show the role's order does not matter.
const EVERYTHING: Role = {
  groups: ["functions", "actions", "data-write", "data-read", "metadata-read"],
  permissions: {
    create: "*",
    update: "*",
    delete: ["tasks"],
    actions: ["SendEmail"],
    functions: ["WhoAmI"],
  },
};

/** What reached Dataverse, and on whose behalf (`as`: an Entra object id). */
const requests: { method: string; path: string; as?: string }[] = [];
const ENTITY_SETS = ["accounts", "contacts", "emails", "tasks"];

// A Dataverse that knows four entity sets. Metadata lookups by the entity set
// catalog are answered but not recorded, so `requests` shows the tool calls.
function fakeDataverse(as?: string): DataverseClient {
  const record = (method: string, path: string) => {
    requests.push({ method, path, ...(as && { as }) });
  };
  return {
    get: async (path: string) => {
      if (path.startsWith("/EntityDefinitions?")) {
        const name = /EntitySetName eq '(\w+)'/.exec(decodeURIComponent(path));
        return {
          value: ENTITY_SETS.filter((n) => n === name?.[1]).map((n) => ({
            EntitySetName: n,
          })),
        };
      }
      record("GET", path);
      return { accountid: "1", name: "Contoso" };
    },
    post: async (path: string) => {
      record("POST", path);
      if (as === DAVE && path === "/tasks") {
        throw new DataverseCallerDeniedError(
          { method: "POST", url: path },
          JSON.stringify({
            error: {
              code: "0x80040220",
              message: "Principal user is missing prvCreateTask privilege",
            },
          }),
          { name: "dave", objectId: DAVE },
        );
      }
      return {};
    },
    delete: async (path: string) => {
      record("DELETE", path);
      return {};
    },
    onBehalfOf: ({ objectId }: { objectId: string }) => fakeDataverse(objectId),
  } as unknown as DataverseClient;
}

function createApp() {
  return createServerApp({
    verifier: new ConfigTokenVerifier(
      serverConfig(
        [
          { name: "alice", sha256: sha256("alice-token") },
          {
            name: "carol",
            sha256: sha256("carol-token"),
            expiresAt: "2020-01-01T00:00:00Z",
          },
          { name: "sam", sha256: sha256("sam-token"), role: "support" },
          { name: "erin", sha256: sha256("erin-token"), role: "everything" },
          { name: "mona", sha256: sha256("mona-token"), role: "schema" },
          {
            name: "dave",
            sha256: sha256("dave-token"),
            role: "support",
            actAs: DAVE,
          },
        ],
        {
          reader: READER,
          support: SUPPORT,
          everything: EVERYTHING,
          schema: { groups: ["metadata-read"], permissions: NO_PERMISSIONS },
        },
      ),
    ),
    createServer: createServerFactory({
      client: fakeDataverse(),
      version: "0.0.0-test",
    }),
  });
}

let app = createApp();
afterEach(async () => {
  await app.close();
  app = createApp();
  requests.length = 0;
});

function send(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`${BASE}${path}`, init));
}

// A 2026-07-28 request as a client sends it: the method and protocol version
// travel in headers as well as in the body (ADR-0001 §6).
function mcp(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return send("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function connect(token: string) {
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("routes outside the auth gate", () => {
  it("answers /health without a token and without calling Dataverse", async () => {
    const res = await send("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(requests).toEqual([]);
  });

  // The paths mcp-remote probes before connecting, all without a token. A 404
  // tells it the server does not do OAuth; a 401 would start an OAuth flow.
  it.each([
    ["GET", "/.well-known/oauth-protected-resource"],
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-authorization-server/mcp"],
    ["GET", "/.well-known/openid-configuration"],
    ["GET", "/.well-known/openid-configuration/mcp"],
    ["GET", "/mcp/.well-known/openid-configuration"],
    ["POST", "/register"],
  ])("%s %s answers 404 without a token", async (method, path) => {
    const res = await send(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("answers 404 for any other path, with or without a token", async () => {
    expect((await send("/")).status).toBe(404);
    expect((await send("/mcpx")).status).toBe(404);
    const res = await send("/admin", {
      headers: { Authorization: "Bearer alice-token" },
    });
    expect(res.status).toBe(404);
  });
});

describe("the auth gate on /mcp", () => {
  it.each([
    ["no Authorization header", {}, "Missing Authorization header"],
    ["an unknown token", { Authorization: "Bearer nobody" }, "Invalid token"],
    [
      "an expired token",
      { Authorization: "Bearer carol-token" },
      "Token has expired",
    ],
    [
      "another scheme",
      { Authorization: "Basic alice-token" },
      "Invalid Authorization header format",
    ],
  ])("refuses %s with 401 and a challenge", async (_, headers, message) => {
    const res = await mcp("tools/list", {}, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(
      /^Bearer error="invalid_token", error_description=".+"$/,
    );
    // OAuth-style, not JSON-RPC: the request never reached MCP.
    const body = await res.json();
    expect(body).toEqual({
      error: "invalid_token",
      error_description: expect.stringContaining(message),
    });
    expect(requests).toEqual([]);
  });

  // A verifier that fails, as a JWT verifier could on a network error, is a
  // server fault: 500 for the client, the error for the operator.
  it("reports a verifier fault through onerror and answers 500", async () => {
    const errors: Error[] = [];
    const faulty = createServerApp({
      verifier: {
        verifyAccessToken: async () => {
          throw new TypeError("keys unavailable");
        },
      },
      createServer: createServerFactory({
        client: fakeDataverse(),
        version: "0.0.0-test",
      }),
      onerror: (error) => errors.push(error),
    });
    const res = await faulty.fetch(
      new Request(`${BASE}/mcp`, { method: "POST", headers: AUTH }),
    );
    await faulty.close();
    expect(res.status).toBe(500);
    expect(errors.map((e) => e.message)).toEqual(["keys unavailable"]);
  });

  it("does not report a refused token as a fault", async () => {
    const errors: Error[] = [];
    const quiet = createServerApp({
      verifier: new ConfigTokenVerifier(serverConfig([])),
      createServer: createServerFactory({
        client: fakeDataverse(),
        version: "0.0.0-test",
      }),
      onerror: (error) => errors.push(error),
    });
    const res = await quiet.fetch(
      new Request(`${BASE}/mcp`, { method: "POST", headers: AUTH }),
    );
    await quiet.close();
    expect(res.status).toBe(401);
    expect(errors).toEqual([]);
  });

  it("checks the token on every request, not once per client", async () => {
    expect((await mcp("tools/list", {}, AUTH)).status).toBe(200);
    expect((await mcp("tools/list", {})).status).toBe(401);
  });

  // Any Origin means a browser, and no browser origin is allowed: a page
  // holding a valid token is refused all the same.
  it.each([
    "https://evil.example",
    "http://127.0.0.1:8080",
    "null",
  ])("refuses a request with Origin: %s, token or not", async (origin) => {
    for (const headers of [{ ...AUTH, Origin: origin }, { Origin: origin }]) {
      const res = await mcp("tools/list", {}, headers);
      expect(res.status).toBe(403);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  // ADR-0001 §6: a proxy that drops Mcp-Name breaks every tool call.
  it("refuses tools/call without Mcp-Name", async () => {
    const res = await mcp(
      "tools/call",
      { name: "get_record", arguments: {} },
      AUTH,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
    expect(requests).toEqual([]);
  });

  it("refuses a 2025-era request (2026-07-28 only)", async () => {
    const res = await send("/mcp", {
      method: "POST",
      headers: {
        ...AUTH,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32022);
  });
});

describe("an authenticated client", () => {
  it("lists only the metadata-read and data-read tools, in order", async () => {
    const client = await connect("alice-token");
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual([
      "list_entities",
      "get_entity_schema",
      "get_picklist_options",
      "list_entity_keys",
      "query_records",
      "get_record",
    ]);
  });

  it("calls a tool against Dataverse", async () => {
    const client = await connect("alice-token");
    const result = await client.callTool({
      name: "get_record",
      arguments: {
        entity_set: "accounts",
        id: "11111111-1111-1111-1111-111111111111",
      },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/accounts(11111111-1111-1111-1111-111111111111)",
      },
    ]);
  });

  it("does not reach a tool outside the read groups", async () => {
    const client = await connect("alice-token");
    const error = await client
      .callTool({
        name: "create_record",
        arguments: { entity_set: "accounts", data: {} },
      })
      .then(
        (r) => r,
        (e: unknown) => e,
      );
    await client.close();
    expect(String((error as Error).message ?? error)).toMatch(/not found/);
    expect(requests).toEqual([]);
  });

  it("cannot connect with a rejected token", async () => {
    await expect(connect("nobody")).rejects.toThrow();
  });
});

describe("roles", () => {
  async function toolNames(token: string) {
    const client = await connect(token);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name);
  }

  async function call(token: string, name: string, args: object) {
    const client = await connect(token);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    return {
      isError: Boolean(result.isError),
      text: (result.content as { text: string }[])[0]?.text ?? "",
    };
  }

  it("lists the support role's tools: create, and the action, but no update or delete", async () => {
    expect(await toolNames("sam-token")).toEqual([
      "list_entities",
      "get_entity_schema",
      "get_picklist_options",
      "list_entity_keys",
      "query_records",
      "get_record",
      "create_record",
      "invoke_action",
    ]);
  });

  it("orders the tools by group, whatever order the role lists them in", async () => {
    expect(await toolNames("erin-token")).toEqual([
      "list_entities",
      "get_entity_schema",
      "get_picklist_options",
      "list_entity_keys",
      "query_records",
      "get_record",
      "create_record",
      "update_record",
      "delete_record",
      "invoke_action",
      "invoke_function",
    ]);
  });

  it("returns the tool list as private to the caller", async () => {
    const res = await mcp("tools/list", {}, AUTH);
    const text = await res.text();
    expect(text).toContain('"cacheScope":"private"');
    expect(text).not.toContain('"cacheScope":"public"');
  });

  it("lets the support role create an email but not a contact", async () => {
    const email = await call("sam-token", "create_record", {
      entity_set: "emails",
      data: { subject: "Your ticket" },
    });
    expect(email.isError).toBe(false);

    const contact = await call("sam-token", "create_record", {
      entity_set: "contacts",
      data: { lastname: "A" },
    });
    expect(contact).toEqual({
      isError: true,
      text: expect.stringContaining(
        "Not permitted: create in 'contacts'. This token is allowed: emails, tasks.",
      ),
    });
    expect(requests).toEqual([{ method: "POST", path: "/emails" }]);
  });

  it("lets the support role send an email, and no other action", async () => {
    const send = await call("sam-token", "invoke_action", {
      name: "SendEmail",
      entity_set: "emails",
      id: GUID,
      parameters: { IssueSend: true },
    });
    expect(send.isError).toBe(false);

    const other = await call("sam-token", "invoke_action", {
      name: "CreateAndSendNewEmail",
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("Not permitted: call action");
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/emails(${GUID})/Microsoft.Dynamics.CRM.SendEmail`,
      },
    ]);
  });

  it("rejects a delete unless the entity set is listed, path tricks included", async () => {
    const results = [
      await call("erin-token", "delete_record", {
        entity_set: "accounts",
        id: GUID,
      }),
      await call("erin-token", "delete_record", {
        entity_set: "tasks",
        id: `${GUID})/../accounts(${GUID}`,
      }),
      await call("erin-token", "delete_record", {
        entity_set: "tasks",
        id: GUID,
      }),
    ];
    expect(results.map((r) => r.isError)).toEqual([true, true, false]);
    expect(requests).toEqual([{ method: "DELETE", path: `/tasks(${GUID})` }]);
  });

  // fetch resolves `..` and drops what follows `#`, so this name used to
  // turn get_entity_schema into GET /contacts for a role that may not read
  // data.
  it("keeps a metadata-only role from reading rows through a metadata tool", async () => {
    expect(await toolNames("mona-token")).not.toContain("query_records");
    const result = await call("mona-token", "get_entity_schema", {
      entity_logical_name: "/../contacts?$select=fullname&$top=5#",
    });
    expect(result).toEqual({
      isError: true,
      text: expect.stringContaining("Invalid entity logical name"),
    });
    expect(requests).toEqual([]);
  });

  it("keeps query_records from calling a function, even with every group", async () => {
    const result = await call("erin-token", "query_records", {
      entity_set: "WhoAmI",
    });
    expect(result).toEqual({
      isError: true,
      text: expect.stringContaining("Unknown entity set: 'WhoAmI'"),
    });
    expect(requests).toEqual([]);
  });

  it("makes a mapped token's calls on its user's behalf", async () => {
    await call("dave-token", "create_record", {
      entity_set: "emails",
      data: { subject: "Hi" },
    });
    await call("sam-token", "create_record", {
      entity_set: "emails",
      data: { subject: "Hi" },
    });
    expect(requests).toEqual([
      { method: "POST", path: "/emails", as: DAVE },
      { method: "POST", path: "/emails" },
    ]);
  });

  it("reports a Dataverse privilege error with the token and its user", async () => {
    const result = await call("dave-token", "create_record", {
      entity_set: "tasks",
      data: { subject: "Call back" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`user ${DAVE}`);
    expect(result.text).toContain('token "dave"');
    expect(result.text).toContain("missing prvCreateTask privilege");
  });
});
