import { describe, expect, it } from "vitest";
import { MAX_REQUEST_TIMEOUT_MS, readRequestTimeoutMs } from "../src/config.js";

describe("readRequestTimeoutMs", () => {
  it("is unset when the variable is missing or empty", () => {
    expect(readRequestTimeoutMs(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readRequestTimeoutMs("")).toEqual({ ok: true, value: undefined });
  });

  it("accepts a whole number of milliseconds up to the cap", () => {
    expect(readRequestTimeoutMs("45000")).toEqual({ ok: true, value: 45000 });
    expect(readRequestTimeoutMs(String(MAX_REQUEST_TIMEOUT_MS))).toEqual({
      ok: true,
      value: MAX_REQUEST_TIMEOUT_MS,
    });
  });

  // 120001 is just over the cap; 3000000000 would overflow Node's timers and
  // silently become a 1 ms timeout; 99999999999 makes AbortSignal.timeout throw.
  for (const raw of [
    "0",
    "-5",
    "abc",
    "1.5",
    "30s",
    " 100",
    "120001",
    "3000000000",
    "99999999999",
  ]) {
    it(`reports ${JSON.stringify(raw)} instead of falling back to the default`, () => {
      const result = readRequestTimeoutMs(raw);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.problem).toContain(
        `DATAVERSE_REQUEST_TIMEOUT_MS=${raw}`,
      );
    });
  }
});
