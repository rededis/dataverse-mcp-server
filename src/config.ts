export type ConfigValue<T> =
  | { ok: true; value: T | undefined }
  | { ok: false; problem: string };

/**
 * DATAVERSE_REQUEST_TIMEOUT_MS: optional, but a value that is set and wrong is
 * reported rather than replaced by the default, so a typo cannot quietly
 * change how long calls may hang.
 */
export function readRequestTimeoutMs(
  raw: string | undefined,
): ConfigValue<number> {
  if (!raw) return { ok: true, value: undefined };
  if (/^[1-9]\d*$/.test(raw)) return { ok: true, value: Number(raw) };
  return {
    ok: false,
    problem: `DATAVERSE_REQUEST_TIMEOUT_MS=${raw} (expected a positive whole number of milliseconds)`,
  };
}
