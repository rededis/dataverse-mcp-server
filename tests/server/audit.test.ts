import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DataverseApiError,
  DataverseAuthError,
  DataverseBusyError,
  DataverseCallerDeniedError,
  DataverseError,
  DataverseTimeoutError,
} from "../../src/errors.js";
import {
  CallMetrics,
  callFields,
  fingerprint,
  JsonLinesAuditLogger,
  outcomeOf,
  plainOrFingerprint,
  resultFields,
} from "../../src/server/audit.js";

const KEY = "k".repeat(32);
const GUID = "11111111-1111-1111-1111-111111111111";

describe("fingerprint", () => {
  it("tells what kind of value it was, without the value", () => {
    expect(fingerprint("john smith@exämple.com")).toEqual({
      length: 22,
      hasAt: true,
      hasSpace: true,
      nonAscii: true,
    });
  });

  it("adds an HMAC under the key, the first 16 hex", () => {
    const hmac = createHmac("sha256", KEY)
      .update("john@example.com")
      .digest("hex")
      .slice(0, 16);
    expect(fingerprint("john@example.com", KEY)).toEqual({
      length: 16,
      hasAt: true,
      hasSpace: false,
      nonAscii: false,
      hmac,
    });
  });

  it("counts characters, not bytes", () => {
    expect(fingerprint("ё").length).toBe(1);
  });
});

describe("plainOrFingerprint", () => {
  it.each([-3, "a".repeat(64)])("keeps %j", (v) => {
    expect(plainOrFingerprint(v)).toBe(v);
  });

  it.each(["a".repeat(65), "ид"])("fingerprints %j", (v) => {
    expect(plainOrFingerprint(v, KEY)).toEqual(fingerprint(v, KEY));
  });
});

describe("callFields", () => {
  const CANARY = "CANARY-7f3a";

  it("fingerprints a column that is not a logical name", () => {
    expect(
      callFields(
        "get_record",
        { entity_set: "contacts", id: GUID, select: "a,b c" },
        KEY,
      ),
    ).toEqual({
      entitySet: "contacts",
      id: GUID,
      columns: ["a", fingerprint("b c", KEY)],
    });
  });

  it("logs the logical names of a metadata call, not list_entities' filters", () => {
    expect(
      callFields("get_picklist_options", {
        entity_logical_name: "account",
        attribute_logical_name: "industrycode",
      }),
    ).toEqual({ entity: "account", attribute: "industrycode" });
    expect(
      callFields("get_picklist_options", { option_set_name: "x y" }),
    ).toEqual({});
    expect(
      callFields("list_entities", { prefix: CANARY, solution: CANARY }),
    ).toEqual({});
  });
});

describe("outcomeOf", () => {
  const request = {
    method: "GET",
    url: `https://org/api/data/v9.2/x?$filter=CANARY`,
  };

  it("keeps a Dataverse error's status and code, never its text", () => {
    const body = JSON.stringify({
      error: { code: "0x80040217", message: "CANARY does not exist" },
    });
    const line = outcomeOf(new DataverseApiError(404, request, body));
    expect(line).toEqual({
      outcome: "dataverse-error",
      error: { class: "DataverseApiError", status: 404, code: "0x80040217" },
    });
    expect(JSON.stringify(line)).not.toContain("CANARY");
    expect(
      outcomeOf(
        new DataverseCallerDeniedError(request, body, {
          name: "n",
          objectId: GUID,
        }),
      ),
    ).toEqual({
      outcome: "dataverse-error",
      error: {
        class: "DataverseCallerDeniedError",
        status: 403,
        code: "0x80040217",
      },
    });
  });

  it("classifies the other Dataverse errors by their safe fields", () => {
    expect(outcomeOf(new DataverseBusyError("queue-full", "busy"))).toEqual({
      outcome: "dataverse-error",
      error: { class: "DataverseBusyError", reason: "queue-full" },
    });
    expect(outcomeOf(new DataverseTimeoutError(30000, request))).toEqual({
      outcome: "dataverse-error",
      error: { class: "DataverseTimeoutError" },
    });
    expect(outcomeOf(new DataverseAuthError("CANARY", 401))).toEqual({
      outcome: "dataverse-error",
      error: { class: "DataverseAuthError", status: 401 },
    });
    expect(outcomeOf(new DataverseError("CANARY"))).toEqual({
      outcome: "dataverse-error",
      error: { class: "DataverseError" },
    });
  });

  it("gives any other error its class only", () => {
    expect(outcomeOf(new TypeError("CANARY"))).toEqual({
      outcome: "error",
      error: { class: "TypeError" },
    });
    expect(outcomeOf("CANARY")).toEqual({
      outcome: "error",
      error: { class: "string" },
    });
  });
});

describe("resultFields", () => {
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  it("the record tools", () => {
    const none = new CallMetrics();
    expect(resultFields("get_record", text({}), none)).toEqual({ records: 1 });
    expect(resultFields("update_record", text("ok"), none)).toEqual({
      records: 0,
    });
    expect(resultFields("delete_record", text("ok"), none)).toEqual({
      records: 0,
    });
    expect(
      resultFields(
        "create_record",
        text({
          "@odata.entityId": `https://org/api/data/v9.2/emails(${GUID})`,
        }),
        none,
      ),
    ).toEqual({ records: 0, createdId: GUID });
  });

  it("a created id that is not a bare GUID is not logged", () => {
    expect(
      resultFields(
        "create_record",
        text({
          "@odata.entityId": `https://org/api/data/v9.2/x(xid=${GUID},partitionid='CANARY')`,
        }),
        new CallMetrics(),
      ),
    ).toEqual({ records: 0 });
  });

  it("metadata tools: items in the tool's own result", () => {
    const none = new CallMetrics();
    expect(resultFields("list_entities", text([{}, {}, {}]), none)).toEqual({
      records: 3,
    });
    expect(resultFields("get_entity_schema", text([{}]), none)).toEqual({
      records: 1,
    });
    expect(resultFields("list_entity_keys", text([]), none)).toEqual({
      records: 0,
    });
    expect(
      resultFields(
        "get_picklist_options",
        text({ option_set: {}, options: [{}, {}] }),
        none,
      ),
    ).toEqual({ records: 2 });
  });
});

describe("JsonLinesAuditLogger", () => {
  it("writes one JSON line per entry, and flushes", async () => {
    const chunks: string[] = [];
    const stream = {
      write(chunk: string, cb?: () => void) {
        chunks.push(chunk);
        cb?.();
        return true;
      },
    };
    const logger = new JsonLinesAuditLogger(stream);
    logger.write({ type: "audit", time: "t", tool: "x" });
    await logger.flush(100);
    expect(chunks).toEqual(['{"type":"audit","time":"t","tool":"x"}\n', ""]);
  });

  it("does not wait past the bound when the stream never drains", async () => {
    const logger = new JsonLinesAuditLogger({ write: () => false });
    await logger.flush(10);
  });
});
