import type { ServiceProtectionSettings } from "./service-protection.js";

/** DATAVERSE_REQUEST_TIMEOUT_MS when unset. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound for DATAVERSE_REQUEST_TIMEOUT_MS. Dataverse cancels any message
 * operation after 2 minutes, so waiting longer than that buys nothing; it is
 * also far below the 2^31 ms where Node timers overflow to 1 ms.
 */
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

/** DATAVERSE_MAX_CONCURRENCY when unset. */
export const DEFAULT_MAX_CONCURRENCY = 8;

/** DATAVERSE_MAX_QUEUE_LENGTH when unset. */
export const DEFAULT_MAX_QUEUE_LENGTH = 100;

/** DATAVERSE_MAX_QUEUE_WAIT_MS when unset. */
export const DEFAULT_MAX_QUEUE_WAIT_MS = 30_000;

/** DATAVERSE_MAX_ATTEMPTS when unset: the first try plus two retries. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** DATAVERSE_MAX_RETRY_WAIT_MS when unset. */
export const DEFAULT_MAX_RETRY_WAIT_MS = 30_000;

/**
 * Upper bound for each of the two waits a request can spend before it is sent
 * for the last time: in the queue and on throttling. A request carries the
 * token it was built with, and DataverseAuth hands out tokens with at least 5
 * minutes left. With the defaults that holds even if every 429 took the whole
 * request timeout to arrive (30 s + 30 s + 2 × 30 s). At the top of every
 * range it relies on a 429 arriving quickly, which a throttled request does.
 */
export const MAX_WAIT_MS = 120_000;

type NumberSetting =
  | { ok: true; value: number | undefined }
  | { ok: false; problem: string };

export type RequestTimeoutSetting = NumberSetting;

/**
 * An optional whole number from an environment variable. A value that is set
 * and wrong is reported rather than replaced by the default, so a typo cannot
 * quietly change how the server behaves.
 */
function readWholeNumber(
  name: string,
  raw: string | undefined,
  range: { min: number; max: number; unit?: string },
): NumberSetting {
  if (!raw) return { ok: true, value: undefined };
  // Plain digits only: Number() alone would accept " 100", "1e3" and "0x10".
  if (/^(0|[1-9]\d*)$/.test(raw)) {
    const value = Number(raw);
    if (value >= range.min && value <= range.max) return { ok: true, value };
  }
  const unit = range.unit ? ` of ${range.unit}` : "";
  return {
    ok: false,
    problem: `${name}=${raw} (expected a whole number${unit} from ${range.min} to ${range.max})`,
  };
}

/** DATAVERSE_REQUEST_TIMEOUT_MS, read as readWholeNumber describes. */
export function readRequestTimeoutMs(
  raw: string | undefined,
): RequestTimeoutSetting {
  return readWholeNumber("DATAVERSE_REQUEST_TIMEOUT_MS", raw, {
    min: 1,
    max: MAX_REQUEST_TIMEOUT_MS,
    unit: "milliseconds",
  });
}

// The upper bounds are sanity limits, not Dataverse's: they stop a typo from
// meaning "unlimited".
const SERVICE_PROTECTION_VARIABLES = [
  // Twice the highest degree of parallelism Dataverse has been seen to
  // recommend (x-ms-dop-hint: 48).
  ["maxConcurrency", "DATAVERSE_MAX_CONCURRENCY", { min: 1, max: 100 }],
  // 0 turns queueing off: a request that finds no free slot is turned away.
  ["maxQueueLength", "DATAVERSE_MAX_QUEUE_LENGTH", { min: 0, max: 10_000 }],
  [
    "maxQueueWaitMs",
    "DATAVERSE_MAX_QUEUE_WAIT_MS",
    { min: 1, max: MAX_WAIT_MS, unit: "milliseconds" },
  ],
  // 1 turns retries off. 10 is what Microsoft's ServiceClient defaults to,
  // the highest first-party value.
  ["maxAttempts", "DATAVERSE_MAX_ATTEMPTS", { min: 1, max: 10 }],
  // 0 means never wait: the first 429 fails the call.
  [
    "maxRetryWaitMs",
    "DATAVERSE_MAX_RETRY_WAIT_MS",
    { min: 0, max: MAX_WAIT_MS, unit: "milliseconds" },
  ],
] as const;

/**
 * The limits of #74 from the environment: the usable values, and a line for
 * each value that is set and wrong.
 */
export function readServiceProtectionSettings(
  env: Record<string, string | undefined>,
): { settings: ServiceProtectionSettings; problems: string[] } {
  const settings: ServiceProtectionSettings = {};
  const problems: string[] = [];
  for (const [key, name, range] of SERVICE_PROTECTION_VARIABLES) {
    const result = readWholeNumber(name, env[name], range);
    if (!result.ok) problems.push(result.problem);
    else if (result.value !== undefined) settings[key] = result.value;
  }
  return { settings, problems };
}
