/** DATAVERSE_REQUEST_TIMEOUT_MS when unset. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound for DATAVERSE_REQUEST_TIMEOUT_MS. Dataverse cancels any message
 * operation after 2 minutes, so waiting longer than that buys nothing; it is
 * also far below the 2^31 ms where Node timers overflow to 1 ms.
 */
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

export type RequestTimeoutSetting =
  | { ok: true; value: number | undefined }
  | { ok: false; problem: string };

/**
 * DATAVERSE_REQUEST_TIMEOUT_MS: optional, but a value that is set and wrong is
 * reported rather than replaced by the default, so a typo cannot quietly
 * change how long calls may hang.
 */
export function readRequestTimeoutMs(
  raw: string | undefined,
): RequestTimeoutSetting {
  if (!raw) return { ok: true, value: undefined };
  if (/^[1-9]\d*$/.test(raw) && Number(raw) <= MAX_REQUEST_TIMEOUT_MS) {
    return { ok: true, value: Number(raw) };
  }
  return {
    ok: false,
    problem: `DATAVERSE_REQUEST_TIMEOUT_MS=${raw} (expected a whole number of milliseconds from 1 to ${MAX_REQUEST_TIMEOUT_MS})`,
  };
}
