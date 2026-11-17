import { createHash } from "node:crypto";
import type {
  Role,
  ServerConfig,
  TokenEntry,
} from "../../src/server/config.js";
import { NO_PERMISSIONS } from "../../src/tools/permissions.js";

/** What a config file lists for a token: its SHA-256 in hex. */
export const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex");

/** Reads metadata and data, and nothing else. */
export const READER: Role = {
  groups: ["metadata-read", "data-read"],
  permissions: NO_PERMISSIONS,
};

/** A config as readServerConfig returns it; tokens default to the reader role. */
export function serverConfig(
  tokens: (Omit<TokenEntry, "role"> & { role?: string })[],
  roles: Record<string, Role> = { reader: READER },
): ServerConfig {
  return {
    roles,
    tokens: tokens.map((t) => ({ role: "reader", ...t })),
  };
}
