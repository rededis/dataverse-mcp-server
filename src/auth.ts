import { DEFAULT_REQUEST_TIMEOUT_MS } from "./config.js";
import { DataverseAuthError, isTimeout } from "./errors.js";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface DataverseAuthOptions {
  /** Timeout for the token request to Microsoft Entra ID. */
  timeoutMs?: number;
}

export class DataverseAuth {
  private tokenCache: TokenCache | null = null;
  // Callers that arrive while a token request is running share it, instead
  // of each sending their own when the cached token has expired.
  private pending: Promise<string> | null = null;
  private timeoutMs: number;

  constructor(
    private tenantId: string,
    private clientId: string,
    private clientSecret: string,
    private resourceUrl: string,
    options: DataverseAuthOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 300_000) {
      return this.tokenCache.accessToken;
    }
    if (!this.pending) {
      // A failed request is not cached: the next caller tries again.
      this.pending = this.requestToken().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async requestToken(): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: `${this.resourceUrl}/.default`,
    });

    let response: Response;
    let text: string;
    try {
      // Bounded like Dataverse requests: with a shared in-flight request, a
      // hung token call would otherwise stall every caller at once.
      response = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      if (isTimeout(err)) {
        throw new DataverseAuthError(
          `OAuth token request timed out after ${this.timeoutMs} ms`,
        );
      }
      throw new DataverseAuthError(
        `OAuth token request failed before a response arrived (${err instanceof Error ? err.message : String(err)})`,
        undefined,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new DataverseAuthError(
        `OAuth token request failed (${response.status}): ${text}`,
        response.status,
      );
    }

    // A 200 is not proof of a usable token: validate before caching, or a
    // missing access_token would be sent as "Bearer undefined" until expiry.
    let data: { access_token?: unknown; expires_in?: unknown };
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new DataverseAuthError(
        `OAuth token response is not JSON (${response.status})`,
        response.status,
        { cause: err },
      );
    }
    const expiresIn = Number(data?.expires_in);
    if (
      typeof data?.access_token !== "string" ||
      data.access_token === "" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new DataverseAuthError(
        "OAuth token response is missing access_token or a valid expires_in",
        response.status,
      );
    }
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return this.tokenCache.accessToken;
  }
}
