import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_TIMEOUT_MS,
  readRequestTimeoutMs,
  readServiceProtectionSettings,
} from "../src/config.js";

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

describe("readServiceProtectionSettings", () => {
  it("leaves every setting to its default when nothing is set", () => {
    expect(readServiceProtectionSettings({})).toEqual({
      settings: {},
      problems: [],
    });
    expect(
      readServiceProtectionSettings({ DATAVERSE_MAX_CONCURRENCY: "" }),
    ).toEqual({ settings: {}, problems: [] });
  });

  it("reads each variable into the option it sets", () => {
    expect(
      readServiceProtectionSettings({
        DATAVERSE_MAX_CONCURRENCY: "4",
        DATAVERSE_MAX_QUEUE_LENGTH: "0",
        DATAVERSE_MAX_QUEUE_WAIT_MS: "5000",
        DATAVERSE_MAX_ATTEMPTS: "1",
        DATAVERSE_MAX_RETRY_WAIT_MS: "0",
      }),
    ).toEqual({
      settings: {
        maxConcurrency: 4,
        maxQueueLength: 0,
        maxQueueWaitMs: 5000,
        maxAttempts: 1,
        maxRetryWaitMs: 0,
      },
      problems: [],
    });
  });

  it("reports every unusable value instead of falling back to the default", () => {
    expect(
      readServiceProtectionSettings({
        DATAVERSE_MAX_CONCURRENCY: "0",
        DATAVERSE_MAX_QUEUE_LENGTH: "many",
        DATAVERSE_MAX_QUEUE_WAIT_MS: "120001",
        DATAVERSE_MAX_ATTEMPTS: "2.5",
        DATAVERSE_MAX_RETRY_WAIT_MS: "30s",
      }),
    ).toEqual({
      settings: {},
      problems: [
        "DATAVERSE_MAX_CONCURRENCY=0 (expected a whole number from 1 to 100)",
        "DATAVERSE_MAX_QUEUE_LENGTH=many (expected a whole number from 0 to 10000)",
        "DATAVERSE_MAX_QUEUE_WAIT_MS=120001 (expected a whole number of milliseconds from 1 to 120000)",
        "DATAVERSE_MAX_ATTEMPTS=2.5 (expected a whole number from 1 to 10)",
        "DATAVERSE_MAX_RETRY_WAIT_MS=30s (expected a whole number of milliseconds from 0 to 120000)",
      ],
    });
  });

  it("keeps the usable values when another one is wrong", () => {
    const result = readServiceProtectionSettings({
      DATAVERSE_MAX_CONCURRENCY: "16",
      DATAVERSE_MAX_ATTEMPTS: "11",
    });
    expect(result.settings).toEqual({ maxConcurrency: 16 });
    expect(result.problems).toHaveLength(1);
  });
});
