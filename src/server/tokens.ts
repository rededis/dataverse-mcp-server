import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { TokenEntry } from "./config.js";

/**
 * How the server decides who a bearer token belongs to. It is the SDK's
 * verifier interface, so `verifyBearerToken` can drive any implementation,
 * and a JWT verifier can later replace the config file (ADR-0001 Deferred).
 */
export type TokenVerifier = OAuthTokenVerifier;

/**
 * Accepts the tokens listed in the config file, by their SHA-256.
 *
 * Expiry is reported, not checked: `verifyBearerToken` refuses an expired
 * token, and also one whose `expiresAt` is unset, so a token without expiry
 * is reported as expiring never (`Infinity`).
 */
export class ConfigTokenVerifier implements TokenVerifier {
  private entries: { name: string; hash: Buffer; expiresAt: number }[];

  constructor(tokens: readonly TokenEntry[]) {
    this.entries = tokens.map((t) => ({
      name: t.name,
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
      clientId: match.name,
      scopes: [],
      expiresAt: match.expiresAt,
    };
  }
}
