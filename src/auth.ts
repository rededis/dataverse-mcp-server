interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export class DataverseAuth {
  private tokenCache: TokenCache | null = null;

  constructor(
    private tenantId: string,
    private clientId: string,
    private clientSecret: string,
    private resourceUrl: string
  ) {}

  async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 300_000) {
      return this.tokenCache.accessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: `${this.resourceUrl}/.default`,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth token request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.tokenCache.accessToken;
  }
}
