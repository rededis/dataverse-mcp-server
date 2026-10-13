import { describe, expect, it } from "vitest";
import { DataverseAuth } from "../../src/auth.js";
import { DataverseClient } from "../../src/client.js";
import { RefusedError, type RefusalCheck } from "../../src/errors.js";
import { assertAllowed } from "../../src/tools/permissions.js";
import {
  bareOperationName,
  buildFunctionCall,
  resolveBinding,
} from "../../src/tools/shared/operations.js";
import {
  assertBodyWithin,
  assertEntitySetName,
  assertLogicalName,
  assertRecordId,
  EntitySetCatalog,
} from "../../src/tools/shared/paths.js";
import { validatePicklistLocation } from "../../src/tools/shared/picklist-location.js";

// Each check the server makes on a call's arguments throws a RefusedError
// that names it, so the audit log can tell a refusal from a failure (#78).
// The message is what the agent reads and stays as it was.

function refusal(run: () => unknown): RefusedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RefusedError);
    return error as RefusedError;
  }
  throw new Error("nothing was refused");
}

async function refusalOf(run: () => Promise<unknown>): Promise<RefusedError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RefusedError);
  return error as RefusedError;
}

const NOTHING = { create: [], update: [] } as const;

describe("refusals name their check", () => {
  it.each<[RefusalCheck, () => unknown, string | undefined]>([
    ["entity-set-name", () => assertEntitySetName("a/../b"), "a/../b"],
    ["record-id", () => assertRecordId("john@example.com"), "john@example.com"],
    [
      "logical-name",
      () => assertLogicalName("bad name", "entity logical name"),
      "bad name",
    ],
    [
      "operation-name",
      () => bareOperationName("Other.Namespace.Op"),
      "Other.Namespace.Op",
    ],
    ["binding", () => resolveBinding("accounts", undefined), undefined],
    [
      "parameter-name",
      () => buildFunctionCall("Fn", { "bad key": 1 }),
      "bad key",
    ],
    [
      "allowlist",
      () => assertAllowed(["emails"], "contacts", "create in"),
      undefined,
    ],
    [
      "body",
      () => assertBodyWithin({ primarycontactid: { name: "x" } }, NOTHING),
      undefined,
    ],
    [
      "picklist-location",
      () => validatePicklistLocation({ entity_logical_name: "account" }),
      undefined,
    ],
  ])("%s", (check, run, value) => {
    const error = refusal(run);
    expect(error.check).toBe(check);
    expect(error.value).toBe(value);
  });

  it("keeps the message the agent reads", () => {
    expect(refusal(() => assertRecordId("x")).message).toBe(
      "Invalid record id (expected a GUID): x",
    );
  });

  it("unknown-entity-set, with the name", async () => {
    const catalog = new EntitySetCatalog({
      get: async () => ({ value: [] }),
    } as unknown as DataverseClient);
    const error = await refusalOf(() => catalog.assertExists("WhoAmI"));
    expect(error.check).toBe("unknown-entity-set");
  });

  describe("in the client", () => {
    const auth = {
      getToken: async () => "t",
    } as unknown as DataverseAuth;
    const client = new DataverseClient(auth, "https://org.crm.dynamics.com", {
      executor: {
        execute: () => Promise.reject(new Error("must not be sent")),
      },
    });

    it("path", async () => {
      const error = await refusalOf(() => client.get("/accounts/../contacts"));
      expect(error.check).toBe("path");
    });

    it("identity-headers", async () => {
      const error = await refusalOf(() =>
        client.request("/WhoAmI", { headers: { CallerObjectId: "x" } }),
      );
      expect(error.check).toBe("identity-headers");
    });
  });
});
