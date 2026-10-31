import { afterEach, describe, expect, it } from "vitest";
import type { DataverseAuth } from "../../src/auth.js";
import { DataverseClient } from "../../src/client.js";
import type { HttpRequest, HttpResponse } from "../../src/executor.js";
import { createServerApp } from "../../src/server/app.js";
import {
  type AuditLine,
  AuditLog,
  fingerprint,
} from "../../src/server/audit.js";
import type { Role } from "../../src/server/config.js";
import { createServerFactory } from "../../src/server/mcp.js";
import { ConfigTokenVerifier } from "../../src/server/tokens.js";
import { withServiceProtection } from "../../src/service-protection.js";
import { NO_PERMISSIONS } from "../../src/tools/permissions.js";
import { READER, serverConfig, sha256 } from "./helpers.js";

// The audit log end to end (#78): requests go through the app, the factory
// and the real DataverseClient and service protection, over a fake Dataverse.
// Values sent or returned carry CANARY, which no line may contain.

const BASE = "http://127.0.0.1:8080";
const KEY = "audit-key-for-tests-0123456789abcdef";
const CANARY = "CANARY-5e1d";
const GUID = "11111111-1111-1111-1111-111111111111";
const DAVE = "22222222-2222-2222-2222-222222222222";

const WRITER: Role = {
  groups: ["metadata-read", "data-read", "data-write", "actions", "functions"],
  permissions: {
    create: ["emails"],
    update: ["emails"],
    delete: ["emails"],
    actions: ["SendEmail"],
    functions: ["WhoAmI"],
  },
};

const ENTITY_SETS = ["contacts", "emails"];

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  ({
    status,
    headers: new Headers(headers),
    body: JSON.stringify(body),
  }) as HttpResponse;

/** How the fake Dataverse answers; a test may replace it. */
let answer: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

function defaultAnswer({ method, url }: HttpRequest): HttpResponse {
  const path = decodeURIComponent(url.replace(/^.*\/api\/data\/v9\.2/, ""));
  if (path.startsWith("/EntityDefinitions?")) {
    const name = /EntitySetName eq '(\w+)'/.exec(path)?.[1];
    return json({
      value: ENTITY_SETS.filter((n) => n === name).map((n) => ({
        EntitySetName: n,
      })),
    });
  }
  if (path.startsWith("/contacts(")) {
    return json({ fullname: `${CANARY} One` });
  }
  if (/^\/contacts(\?|$)/.test(path)) {
    return json({
      value: [
        { fullname: `${CANARY} One`, emailaddress1: `one@${CANARY}.com` },
        { fullname: `${CANARY} Two`, emailaddress1: `two@${CANARY}.com` },
      ],
      "@odata.nextLink": `https://org/api/data/v9.2/contacts?$skiptoken=${CANARY}`,
    });
  }
  if (method === "POST" && path === "/emails") {
    return {
      status: 204,
      headers: new Headers({
        "OData-EntityId": `https://org/api/data/v9.2/emails(${GUID})`,
      }),
      body: "",
    };
  }
  if (path.startsWith("/emails(") && path.includes("SendEmail")) {
    return json({ Subject: CANARY });
  }
  if (path.startsWith("/emails(")) {
    return json(
      {
        error: {
          code: "0x80040217",
          message: `email ${CANARY} does not exist`,
        },
      },
      404,
    );
  }
  if (path.startsWith("/WhoAmI")) {
    return json({ UserId: GUID, value: [{}, {}, {}] });
  }
  return json({ error: { code: "0x0", message: CANARY } }, 500);
}

let lines: AuditLine[] = [];
let errors: Error[] = [];

function createApp() {
  lines = [];
  errors = [];
  const audit = new AuditLog({ write: (line) => lines.push(line) }, KEY);
  const auth = { getToken: async () => "token" } as unknown as DataverseAuth;
  const client = new DataverseClient(auth, "https://org.crm.dynamics.com", {
    executor: withServiceProtection(
      { execute: async (request) => answer(request) },
      { maxConcurrency: 4 },
    ),
  });
  return createServerApp({
    verifier: new ConfigTokenVerifier(
      serverConfig(
        [
          { name: "alice", sha256: sha256("alice-token") },
          { name: "wendy", sha256: sha256("wendy-token"), role: "writer" },
          {
            name: "dave",
            sha256: sha256("dave-token"),
            role: "writer",
            actAs: DAVE,
          },
          {
            name: "carol",
            sha256: sha256("carol-token"),
            expiresAt: "2020-01-01T00:00:00Z",
          },
        ],
        {
          reader: READER,
          writer: WRITER,
          nothing: { groups: [], permissions: NO_PERMISSIONS },
        },
      ),
    ),
    createServer: createServerFactory({
      client,
      version: "0.0.0-test",
      audit,
    }),
    audit,
    onerror: (error) => errors.push(error),
  });
}

let app = createApp();
answer = defaultAnswer;
afterEach(async () => {
  await app.close();
  app = createApp();
  answer = defaultAnswer;
});

const PROTOCOL = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2026-07-28",
};
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A tools/call as a client sends it; resolves once it is answered. */
async function call(
  token: string,
  tool: string,
  args: Record<string, unknown>,
  options: { id?: string | number; headers?: Record<string, string> } = {},
) {
  const res = await app.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        ...PROTOCOL,
        Authorization: `Bearer ${token}`,
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: options.id ?? 1,
        method: "tools/call",
        params: { name: tool, arguments: args, _meta: META },
      }),
    }),
  );
  return { status: res.status, text: await res.text() };
}

/** The only line written; fails if there is not exactly one. */
function theLine(): AuditLine {
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe("a tool call's line", () => {
  it("has who called, what was asked and what came back, but no values", async () => {
    const { text } = await call(
      "alice-token",
      "query_records",
      {
        entity_set: "contacts",
        select: "fullname,emailaddress1",
        filter: `emailaddress1 eq '${CANARY}'`,
        orderby: `fullname ${CANARY}`,
        top: 50,
      },
      { id: 7 },
    );
    expect(text).toContain(CANARY);

    const line = theLine();
    expect(line).toEqual({
      type: "audit",
      time: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      durationMs: expect.any(Number),
      rpcId: 7,
      token: "alice",
      role: "reader",
      tool: "query_records",
      entitySet: "contacts",
      columns: ["fullname", "emailaddress1"],
      top: 50,
      outcome: "ok",
      records: 2,
      more: true,
      // The entity-set lookup and the query.
      dataverseRequests: 2,
      throttled: false,
      heldBack: false,
      retries: 0,
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("does not count a cached entity set's lookup again, nor its rows as records", async () => {
    await call("alice-token", "query_records", { entity_set: "contacts" });
    await call("alice-token", "query_records", { entity_set: "contacts" });
    expect(lines.map((l) => [l.dataverseRequests, l.records])).toEqual([
      [2, 2],
      [1, 2],
    ]);
  });

  it("logs a create's field names and the created id, not the body", async () => {
    await call("wendy-token", "create_record", {
      entity_set: "emails",
      data: {
        subject: CANARY,
        description: CANARY,
        "regardingobjectid_contact@odata.bind": `/contacts(${GUID})`,
        [`${CANARY}@example.com`]: 1,
      },
    });
    const line = theLine();
    expect(line).toMatchObject({
      token: "wendy",
      role: "writer",
      tool: "create_record",
      entitySet: "emails",
      fields: [
        "subject",
        "description",
        "regardingobjectid_contact@odata.bind",
        fingerprint(`${CANARY}@example.com`, KEY),
      ],
      outcome: "ok",
      records: 0,
      createdId: GUID,
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("logs an action's name, record and parameter names, not their values", async () => {
    await call("dave-token", "invoke_action", {
      name: "SendEmail",
      entity_set: "emails",
      id: GUID,
      parameters: { IssueSend: true, TrackingToken: CANARY },
    });
    expect(theLine()).toMatchObject({
      token: "dave",
      actAs: DAVE,
      tool: "invoke_action",
      operation: "SendEmail",
      entitySet: "emails",
      id: GUID,
      params: ["IssueSend", "TrackingToken"],
      outcome: "ok",
    });
    expect(theLine().records).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("counts a function's collection", async () => {
    await call("wendy-token", "invoke_function", { name: "WhoAmI" });
    expect(theLine()).toMatchObject({
      operation: "WhoAmI",
      outcome: "ok",
      records: 3,
      dataverseRequests: 1,
    });
  });
});

describe("the JSON-RPC id and the proxy's request id", () => {
  it("keeps a plain string id, and fingerprints any other", async () => {
    await call(
      "alice-token",
      "get_record",
      { entity_set: "contacts", id: GUID },
      { id: "req-1.a:b" },
    );
    await call(
      "alice-token",
      "get_record",
      { entity_set: "contacts", id: GUID },
      { id: `${CANARY} x@y` },
    );
    await call(
      "alice-token",
      "get_record",
      { entity_set: "contacts", id: GUID },
      { id: "" },
    );
    expect(lines.map((l) => l.rpcId)).toEqual([
      "req-1.a:b",
      fingerprint(`${CANARY} x@y`, KEY),
      fingerprint("", KEY),
    ]);
  });

  it("logs X-Request-Id as is or as a fingerprint, and nothing without it", async () => {
    const args = { entity_set: "contacts", select: "fullname" };
    await call("alice-token", "query_records", args, {
      headers: { "X-Request-Id": "9f86d081884c7d65" },
    });
    await call("alice-token", "query_records", args, {
      headers: { "X-Request-Id": `${CANARY}/with spaces` },
    });
    await call("alice-token", "query_records", args);
    expect(lines.map((l) => l.requestId)).toEqual([
      "9f86d081884c7d65",
      fingerprint(`${CANARY}/with spaces`, KEY),
      undefined,
    ]);
    expect("requestId" in lines[2]).toBe(false);
  });
});

describe("refusals and errors", () => {
  it("fingerprints a value refused for its shape, an email sent as a record id", async () => {
    const email = `john.${CANARY}@example.com`;
    await call("alice-token", "get_record", {
      entity_set: "contacts",
      id: email,
    });
    const line = theLine();
    expect(line).toMatchObject({
      tool: "get_record",
      entitySet: "contacts",
      outcome: "refused",
      check: "record-id",
      got: {
        length: email.length,
        hasAt: true,
        hasSpace: false,
        nonAscii: false,
        hmac: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
      dataverseRequests: 0,
    });
    expect(line.id).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("logs an unknown entity set's name and the lookup it cost", async () => {
    await call("alice-token", "query_records", { entity_set: "WhoAmI" });
    expect(theLine()).toMatchObject({
      entitySet: "WhoAmI",
      outcome: "refused",
      check: "unknown-entity-set",
      dataverseRequests: 1,
    });
  });

  it("logs an allowlist refusal", async () => {
    await call("wendy-token", "create_record", {
      entity_set: "contacts",
      data: { fullname: CANARY },
    });
    expect(theLine()).toMatchObject({
      entitySet: "contacts",
      fields: ["fullname"],
      outcome: "refused",
      check: "allowlist",
      dataverseRequests: 0,
    });
  });

  it("logs a path check: an entity set that would reach another", async () => {
    const tricky = `emails(${GUID})/../${CANARY}`;
    await call("wendy-token", "delete_record", {
      entity_set: tricky,
      id: GUID,
    });
    expect(theLine()).toMatchObject({
      outcome: "refused",
      check: "entity-set-name",
      got: fingerprint(tricky, KEY),
      dataverseRequests: 0,
    });
    expect(theLine().entitySet).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("fingerprints a function parameter name refused for its shape", async () => {
    const name = `a/../${CANARY}`;
    await call("wendy-token", "invoke_function", {
      name: "WhoAmI",
      parameters: { [name]: 1 },
    });
    expect(theLine()).toMatchObject({
      outcome: "refused",
      check: "parameter-name",
      params: [fingerprint(name, KEY)],
      got: fingerprint(name, KEY),
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("logs a Dataverse error's status and code, never its text", async () => {
    await call("wendy-token", "delete_record", {
      entity_set: "emails",
      id: GUID,
    });
    expect(theLine()).toMatchObject({
      tool: "delete_record",
      id: GUID,
      outcome: "dataverse-error",
      error: { class: "DataverseApiError", status: 404, code: "0x80040217" },
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  // In SDK 2.4.0 McpServer turns every throw into an error result, so a
  // tool's error cannot reach the handler's onerror. Pinned, so an SDK that
  // starts forwarding them (with Dataverse's text) is noticed.
  it("does not pass a tool's Dataverse error to onerror", async () => {
    const { text } = await call("wendy-token", "delete_record", {
      entity_set: "emails",
      id: GUID,
    });
    expect(text).toContain("isError");
    expect(errors).toEqual([]);
  });
});

describe("a tool the role does not have", () => {
  it("gets a line with the body's tool name and id", async () => {
    const { text } = await call(
      "alice-token",
      "delete_record",
      { entity_set: "emails", id: GUID },
      { id: "r-9", headers: { "X-Request-Id": "abc" } },
    );
    expect(text).toContain("not found");
    expect(theLine()).toEqual({
      type: "audit",
      time: expect.any(String),
      durationMs: 0,
      rpcId: "r-9",
      token: "alice",
      role: "reader",
      requestId: "abc",
      tool: "delete_record",
      outcome: "refused",
      check: "tool-not-in-role",
    });
  });

  it("fingerprints a tool name no tool could have", async () => {
    const name = `${CANARY}@x`;
    await app.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          ...PROTOCOL,
          Authorization: "Bearer alice-token",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name, arguments: {}, _meta: META },
        }),
      }),
    );
    expect(theLine()).toMatchObject({
      check: "tool-not-in-role",
      got: fingerprint(name, KEY),
    });
    expect(theLine().tool).toBeUndefined();
  });

  it("gets no line from a notification with the same headers", async () => {
    const res = await app.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          ...PROTOCOL,
          Authorization: "Bearer alice-token",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "delete_record",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "delete_record", arguments: {}, _meta: META },
        }),
      }),
    );
    await res.text();
    expect(lines).toEqual([]);
  });

  it("leaves a body that is not JSON to the SDK, as before", async () => {
    const res = await app.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          ...PROTOCOL,
          Authorization: "Bearer alice-token",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "query_records",
        },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(lines).toEqual([]);
  });
});

describe("refused requests", () => {
  async function post(headers: Record<string, string>) {
    const res = await app.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { ...PROTOCOL, "Mcp-Method": "tools/list", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: META },
        }),
      }),
    );
    return res.status;
  }

  it.each([
    ["missing", {}],
    ["malformed", { Authorization: `Basic ${CANARY}` }],
    ["malformed", { Authorization: "Bearer  " }],
    ["unknown", { Authorization: `Bearer ${CANARY}` }],
  ])("a %s token gets a line without any token", async (reason, headers) => {
    expect(await post(headers)).toBe(401);
    expect(theLine()).toEqual({
      type: "audit",
      time: expect.any(String),
      event: "auth-refused",
      reason,
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it("an expired token's line has its name, never the token", async () => {
    expect(
      await post({ Authorization: "Bearer carol-token", "X-Request-Id": "r1" }),
    ).toBe(401);
    expect(theLine()).toMatchObject({
      event: "auth-refused",
      reason: "expired",
      token: "carol",
      requestId: "r1",
    });
    expect(JSON.stringify(lines)).not.toContain("carol-token");
  });

  it("a request with an Origin gets a line, with the proxy's id", async () => {
    expect(
      await post({
        Authorization: "Bearer alice-token",
        Origin: "https://evil.example",
        "X-Request-Id": "r2",
      }),
    ).toBe(403);
    expect(theLine()).toEqual({
      type: "audit",
      time: expect.any(String),
      event: "origin-refused",
      requestId: "r2",
    });
  });

  it("a request that is not a tool call gets no line", async () => {
    expect(await post({ Authorization: "Bearer alice-token" })).toBe(200);
    expect(lines).toEqual([]);
  });
});

describe("throttling, per call", () => {
  it("tells the throttled call from the one held back by it, running together", async () => {
    let throttledOnce = false;
    let release!: () => void;
    const queried = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = async (request) => {
      if (request.url.endsWith("/contacts") && !throttledOnce) {
        throttledOnce = true;
        release();
        return {
          status: 429,
          headers: new Headers({ "Retry-After": "1" }),
          body: `{"error":{"code":"0x80072322","message":"${CANARY}"}}`,
        };
      }
      return defaultAnswer(request);
    };

    const first = call(
      "alice-token",
      "query_records",
      { entity_set: "contacts" },
      { id: "first" },
    );
    await queried;
    const second = call(
      "wendy-token",
      "get_record",
      { entity_set: "contacts", id: GUID },
      { id: "second" },
    );
    await Promise.all([first, second]);

    const byId = Object.fromEntries(lines.map((l) => [l.rpcId, l]));
    expect(byId.first).toMatchObject({
      throttled: true,
      heldBack: false,
      retries: 1,
      // The lookup, and the query sent twice.
      dataverseRequests: 3,
      outcome: "ok",
    });
    expect(byId.second).toMatchObject({
      token: "wendy",
      throttled: false,
      heldBack: true,
      retries: 0,
      // The contacts lookup is cached by the first call.
      dataverseRequests: 1,
      outcome: "ok",
      records: 1,
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });
});

describe("metadata tools", () => {
  it("count the items of their own result", async () => {
    answer = (request) => {
      if (request.url.includes("/EntityDefinitions?")) {
        return json({
          value: [
            { LogicalName: "contoso_a" },
            { LogicalName: "contoso_b" },
            { LogicalName: "account" },
          ],
        });
      }
      return defaultAnswer(request);
    };
    await call("alice-token", "list_entities", { prefix: "contoso_" });
    expect(theLine()).toMatchObject({
      tool: "list_entities",
      outcome: "ok",
      records: 2,
    });
    expect(theLine().prefix).toBeUndefined();
  });
});
