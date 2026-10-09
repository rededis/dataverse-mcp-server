import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { Role, ServerConfig } from "./config.js";

/**
 * How the server decides who a bearer token belongs to. It is the SDK's
 * verifier interface, so `verifyBearerToken` can drive any implementation,
 * and a JWT verifier can later replace the config file (ADR-0001 Deferred).
 */
export type TokenVerifier = OAuthTokenVerifier;

/** Who is calling, as the token's config entry says: its name, role and user. */
export interface Caller {
  name: string;
  role: Role;
  /** The Microsoft Entra object id of the Dataverse user to act as. */
  actAs?: string;
}

const CALLER = "dataverse-mcp-server/caller";

/**
 * The caller a verified request carries. Only a ConfigTokenVerifier puts one
 * there; a request without one is a wiring fault, refused rather than served
 * with some default.
 */
export function callerOf(authInfo: AuthInfo | undefined): Caller {
  const caller = authInfo?.extra?.[CALLER] as Caller | undefined;
  if (!caller) throw new Error("The request carries no verified caller");
  return caller;
}

/**
 * Accepts the tokens listed in the config file, by their SHA-256.
 *
 * Expiry is reported, not checked: `verifyBearerToken` refuses an expired
 * token, and also one whose `expiresAt` is unset, so a token without expiry
 * is reported as expiring never (`Infinity`).
 */
export class ConfigTokenVerifier implements TokenVerifier {
  private entries: { hash: Buffer; expiresAt: number; caller: Caller }[];

  constructor(config: ServerConfig) {
    this.entries = config.tokens.map((t) => ({
      caller: { name: t.name, role: config.roles[t.role], actAs: t.actAs },
      hash: Buffer.from(t.sha256, "hex"),
      // AuthInfo.expiresAt is in seconds since the epoch.
      expiresAt:
        t.expiresAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(t.expiresAt) / 1000,
    }));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = createHash("sha256").update(token).digest();
    // Every entry is compared, so the time taken does not tell how many
    // entries come before the matching one.
    let match: (typeof this.entries)[number] | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(hash, entry.hash) && !match) match = entry;
    }
    if (!match)
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
    return {
      token,
      clientId: match.caller.name,
      scopes: [],
      expiresAt: match.expiresAt,
      extra: { [CALLER]: match.caller },
    };
  }
}
