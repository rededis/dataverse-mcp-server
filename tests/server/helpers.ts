import { createHash } from "node:crypto";

/** What a config file lists for a token: its SHA-256 in hex. */
export const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex");
