import { describe, expect, it } from "vitest";
import {
  bareOperationName,
  buildFunctionCall,
  formatODataLiteral,
  qualifyOperationName,
  resolveBinding,
} from "../../src/tools/shared/operations.js";
import { GUID } from "../helpers.js";

describe("helpers", () => {
  it("qualifies bound operation names with the CRM namespace", () => {
    expect(qualifyOperationName("QualifyLead", true)).toBe(
      "Microsoft.Dynamics.CRM.QualifyLead",
    );
  });

  it("leaves unbound names plain", () => {
    expect(qualifyOperationName("WhoAmI", false)).toBe("WhoAmI");
  });

  it("strips exactly the CRM namespace to get the bare name", () => {
    expect(bareOperationName("SendEmail")).toBe("SendEmail");
    expect(bareOperationName("Microsoft.Dynamics.CRM.SendEmail")).toBe(
      "SendEmail",
    );
    for (const name of [
      "Other.SendEmail",
      "Microsoft.Dynamics.CRM.Microsoft.Dynamics.CRM.SendEmail",
      "microsoft.dynamics.crm.SendEmail",
      "../accounts",
      "",
    ]) {
      expect(() => bareOperationName(name), name).toThrow(
        /Invalid operation name/,
      );
    }
  });

  it("resolveBinding returns true for bound, false for unbound", () => {
    expect(resolveBinding("leads", GUID)).toBe(true);
    expect(resolveBinding(undefined, undefined)).toBe(false);
    expect(resolveBinding("", "")).toBe(false);
  });

  it("resolveBinding rejects half-specified bindings", () => {
    expect(() => resolveBinding("leads", undefined)).toThrow(
      /Inconsistent binding/,
    );
    expect(() => resolveBinding(undefined, GUID)).toThrow(
      /Inconsistent binding/,
    );
  });

  it("resolveBinding rejects an entity set that is not a plain name", () => {
    expect(() => resolveBinding("leads/../accounts", GUID)).toThrow(
      /Invalid entity set name/,
    );
  });

  it("resolveBinding accepts a GUID without braces only", () => {
    expect(() => resolveBinding("leads", `{${GUID}}`)).toThrow(
      /Invalid record id/,
    );
    expect(() => resolveBinding("leads", `{${GUID}`)).toThrow(
      /Invalid record id/,
    );
    expect(() => resolveBinding("leads", `${GUID}}`)).toThrow(
      /Invalid record id/,
    );
  });

  it("resolveBinding rejects a non-GUID id", () => {
    expect(() => resolveBinding("leads", "not-a-guid")).toThrow(
      /Invalid record id/,
    );
  });

  it("formats OData literals by type", () => {
    expect(formatODataLiteral("hello")).toBe("'hello'");
    expect(formatODataLiteral("O'Brien")).toBe("'O''Brien'");
    expect(formatODataLiteral(GUID)).toBe(GUID); // GUIDs are unquoted
    // A GUID in braces is no Edm.Guid literal: it goes as a string.
    expect(formatODataLiteral(`{${GUID}}`)).toBe(`'{${GUID}}'`);
    expect(formatODataLiteral(42)).toBe("42");
    expect(formatODataLiteral(true)).toBe("true");
    expect(formatODataLiteral(null)).toBe("null");
  });

  it("builds parameterless and parameterized function calls", () => {
    expect(buildFunctionCall("WhoAmI")).toBe("WhoAmI");
    // encodeURIComponent leaves the apostrophe unescaped (it is URL-safe).
    expect(buildFunctionCall("GetX", { Name: "abc", Top: 5 })).toBe(
      "GetX(Name=@Name,Top=@Top)?@Name='abc'&@Top=5",
    );
  });
});
