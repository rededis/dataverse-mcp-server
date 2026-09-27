import { describe, expect, it } from "vitest";
import {
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

  it("leaves unbound names and already-qualified names untouched", () => {
    expect(qualifyOperationName("WhoAmI", false)).toBe("WhoAmI");
    expect(qualifyOperationName("Microsoft.Dynamics.CRM.X", true)).toBe(
      "Microsoft.Dynamics.CRM.X",
    );
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

  it("resolveBinding rejects a non-GUID id", () => {
    expect(() => resolveBinding("leads", "not-a-guid")).toThrow(
      /Invalid record id/,
    );
  });

  it("formats OData literals by type", () => {
    expect(formatODataLiteral("hello")).toBe("'hello'");
    expect(formatODataLiteral("O'Brien")).toBe("'O''Brien'");
    expect(formatODataLiteral(GUID)).toBe(GUID); // GUIDs are unquoted
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
