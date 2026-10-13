import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DataverseApiError,
  DataverseAuthError,
  DataverseBusyError,
  DataverseCallerDeniedError,
  DataverseError,
  DataverseTimeoutError,
  RefusedError,
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
  it.each([7, 0, -3, "abc-1.2:3_X", "a".repeat(64)])("keeps %j", (v) => {
    expect(plainOrFingerprint(v)).toBe(v);
  });

  it.each(["", "a b", "a".repeat(65), "x@y", "ид"])("fingerprints %j", (v) => {
    expect(plainOrFingerprint(v, KEY)).toEqual(fingerprint(v, KEY));
  });
});

describe("callFields", () => {
  const CANARY = "CANARY-7f3a";

  it("logs the names a query uses and none of its values", () => {
    const fields = callFields(
      "query_records",
      {
        entity_set: "contacts",
        select: "fullname, emailaddress1",
        filter: `emailaddress1 eq '${CANARY}'`,
        orderby: `${CANARY} desc`,
        expand: `${CANARY}($filter=x eq '${CANARY}')`,
        top: 50,
      },
      KEY,
    );
    expect(fields).toEqual({
      entitySet: "contacts",
      columns: ["fullname", "emailaddress1"],
      top: 50,
    });
    expect(JSON.stringify(fields)).not.toContain(CANARY);
  });

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

  it("logs a record id only when it is a GUID", () => {
    expect(
      callFields("delete_record", {
        entity_set: "tasks",
        id: "john@example.com",
      }),
    ).toEqual({ entitySet: "tasks" });
  });

  it("logs the field names of a body and none of its values", () => {
    const fields = callFields(
      "create_record",
      {
        entity_set: "emails",
        data: {
          subject: CANARY,
          "regardingobjectid_contact@odata.bind": `/contacts(${GUID})`,
          [`${CANARY}@example.com`]: 1,
        },
      },
      KEY,
    );
    expect(fields).toEqual({
      entitySet: "emails",
      fields: [
        "subject",
        "regardingobjectid_contact@odata.bind",
        fingerprint(`${CANARY}@example.com`, KEY),
      ],
    });
    expect(JSON.stringify(fields)).not.toContain(CANARY);
  });

  it("logs an operation's bare name and its parameter names", () => {
    const fields = callFields("invoke_action", {
      name: "Microsoft.Dynamics.CRM.SendEmail",
      entity_set: "emails",
      id: GUID,
      parameters: { IssueSend: CANARY },
    });
    expect(fields).toEqual({
      operation: "SendEmail",
      entitySet: "emails",
      id: GUID,
      params: ["IssueSend"],
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

  it("names the check of a refusal and fingerprints the refused value", () => {
    expect(
      outcomeOf(
        new RefusedError("record-id", "Invalid: john@x.com", "john@x.com"),
        KEY,
      ),
    ).toEqual({
      outcome: "refused",
      check: "record-id",
      got: fingerprint("john@x.com", KEY),
    });
    expect(outcomeOf(new RefusedError("allowlist", "Not permitted"))).toEqual({
      outcome: "refused",
      check: "allowlist",
    });
  });

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
  const metrics = (records?: number, more = false) => {
    const m = new CallMetrics();
    m.data.answered?.({ records, more });
    return m;
  };

  it("query_records: rows of the response, and whether there are more", () => {
    expect(
      resultFields("query_records", text([1, 2]), metrics(2, true)),
    ).toEqual({
      records: 2,
      more: true,
    });
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

  it("actions and functions: a collection's length, otherwise nothing", () => {
    expect(resultFields("invoke_function", text({}), metrics(3))).toEqual({
      records: 3,
    });
    expect(resultFields("invoke_action", text({}), metrics())).toEqual({});
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

describe("CallMetrics", () => {
  it("counts the tool's requests and the lookups, records from the tool's only", () => {
    const m = new CallMetrics();
    m.lookups.sent?.();
    m.lookups.answered?.({ records: 1, more: false });
    m.data.sent?.();
    m.data.retried?.();
    m.data.throttled?.();
    m.data.answered?.({ records: 25, more: false });
    expect(m.summary()).toEqual({
      dataverseRequests: 2,
      throttled: true,
      heldBack: false,
      retries: 1,
    });
    expect(m.records).toBe(25);
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
