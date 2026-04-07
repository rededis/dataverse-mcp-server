import { describe, expect, it } from "vitest";
import { buildODataQuery, escapeODataString } from "../src/tools/data-tools.js";

describe("escapeODataString", () => {
  it("returns string unchanged when no quotes", () => {
    expect(escapeODataString("contoso_")).toBe("contoso_");
  });

  it("escapes single quotes by doubling them", () => {
    expect(escapeODataString("it's")).toBe("it''s");
  });

  it("escapes multiple single quotes", () => {
    expect(escapeODataString("a'b'c")).toBe("a''b''c");
  });

  it("handles empty string", () => {
    expect(escapeODataString("")).toBe("");
  });
});

describe("buildODataQuery", () => {
  it("returns empty string for empty params", () => {
    expect(buildODataQuery({})).toBe("");
  });

  it("skips undefined values", () => {
    expect(buildODataQuery({ $select: undefined, $top: undefined })).toBe("");
  });

  it("builds single param", () => {
    expect(buildODataQuery({ $select: "name,email" })).toBe(
      "?%24select=name%2Cemail",
    );
  });

  it("builds multiple params", () => {
    const result = buildODataQuery({
      $select: "name",
      $top: 5,
    });
    expect(result).toContain("%24select=name");
    expect(result).toContain("%24top=5");
    expect(result[0]).toBe("?");
  });

  it("handles $top=0", () => {
    const result = buildODataQuery({ $top: 0 });
    expect(result).toBe("?%24top=0");
  });

  it("encodes special characters", () => {
    const result = buildODataQuery({
      $filter: "name eq 'test&value'",
    });
    expect(result).toContain("%24filter=");
    // & should be encoded inside the value
    const params = new URLSearchParams(result.slice(1));
    expect(params.get("$filter")).toBe("name eq 'test&value'");
  });
});
