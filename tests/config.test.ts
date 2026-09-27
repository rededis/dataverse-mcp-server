import { describe, expect, it } from "vitest";
import { readRequestTimeoutMs } from "../src/config.js";

describe("readRequestTimeoutMs", () => {
  it("is unset when the variable is missing or empty", () => {
    expect(readRequestTimeoutMs(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readRequestTimeoutMs("")).toEqual({ ok: true, value: undefined });
  });

  it("accepts a positive whole number of milliseconds", () => {
    expect(readRequestTimeoutMs("45000")).toEqual({ ok: true, value: 45000 });
  });

  for (const raw of ["0", "-5", "abc", "1.5", "30s", " 100"]) {
    it(`reports ${JSON.stringify(raw)} instead of falling back to the default`, () => {
      const result = readRequestTimeoutMs(raw);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.problem).toContain(
        `DATAVERSE_REQUEST_TIMEOUT_MS=${raw}`,
      );
    });
  }
});
