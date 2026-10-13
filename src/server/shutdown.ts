import type { AuditLog, JsonLinesAuditLogger } from "./audit.js";
import type { Listener } from "./listener.js";

/**
 * How long shutdown waits, within the 10 s Docker allows after SIGTERM before
 * it kills the container.
 */
export const SHUTDOWN_BOUNDS = { callsMs: 5_000, flushMs: 2_000 };

/**
 * Stops the server without losing audit lines (#78): stop accepting, wait for
 * the tool calls still running (closing the listener does not stop a call
 * already waiting on Dataverse), then wait until stdout has taken every line,
 * since process.exit() drops what a pipe has not taken yet.
 */
export async function shutDown(
  parts: { listener: Listener; audit: AuditLog; logger: JsonLinesAuditLogger },
  bounds: { callsMs: number; flushMs: number } = SHUTDOWN_BOUNDS,
): Promise<void> {
  await parts.listener.stop();
  await parts.audit.settled(bounds.callsMs);
  await parts.logger.flush(bounds.flushMs);
}
