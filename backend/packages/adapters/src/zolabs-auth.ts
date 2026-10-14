// How the deployed server stays signed in to ZoLabs. ZoLabs signs people in with OAuth, so there is no password or API key
// to put in a setting. A person signs in once (scripts/zolabs-login.mjs) and gets a long-lived refresh token; from then on
// the server trades that token for short-lived access tokens by itself. If ZoLabs hands back a newer refresh token, the
// newest one is kept (encrypted) in the database, so every copy of the server uses the same one.
// ZoLabs lets each refresh token be used ONCE. So never run this against the configured token from anywhere that does not
// save the replacement (a local test, a second environment): it would lock the real server out until someone signs in again.
import { decryptPhone, encryptPhone, type Store } from "@dozai/core";

export const ZOLABS_API_URL = "https://qurateai-backend-development.onrender.com";
export const ZOLABS_TOKEN_URL = `${ZOLABS_API_URL}/oauth/token`;
const SECRET = "zolabs_refresh_token";

export interface TokenSource { token(): Promise<string> }

export interface RefreshingTokenConfig {
  clientId: string;
  /** The token from the one-time sign-in. Used until the database holds a newer one. */
  refreshToken: string;
  /** Encrypts the stored token. The same key that protects phone numbers. */
  piiKey: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class RefreshingToken implements TokenSource {
  private access?: { value: string; expires: number };
  private inflight?: Promise<string>;
  private store?: Store;
  constructor(private cfg: RefreshingTokenConfig) {}

  /** Where the newest refresh token is kept. Set on every request, because the database connection belongs to the request. */
  attach(store: Store): void { this.store = store; }

  private now = () => (this.cfg.now ?? Date.now)();

  private async current(): Promise<string> {
    const saved = await this.store?.getSecret(SECRET);
    if (saved) { try { return decryptPhone(this.cfg.piiKey, saved); } catch { /* an unreadable copy is ignored: the configured token is used */ } }
    return this.cfg.refreshToken;
  }

  async token(): Promise<string> {
    if (this.access && this.access.expires - this.now() > 30_000) return this.access.value;
    // Several calls at once share one renewal.
    return (this.inflight ??= this.renew().finally(() => { this.inflight = undefined; }));
  }

  private async renew(attempt = 0): Promise<string> {
    const used = await this.current();
    const res = await (this.cfg.fetch ?? fetch)(this.cfg.tokenUrl ?? ZOLABS_TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: used, client_id: this.cfg.clientId }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      // Another copy of the server may have just renewed and replaced the token we tried: look once more.
      if (attempt === 0 && body.error === "invalid_grant" && (await this.current()) !== used) return this.renew(1);
      throw new Error(`The ZoLabs sign-in could not be renewed (${body.error ?? res.status}). Sign in again with scripts/zolabs-login.mjs and update ZOLABS_REFRESH_TOKEN.`);
    }
    if (body.refresh_token && body.refresh_token !== used) await this.store?.putSecret(SECRET, encryptPhone(this.cfg.piiKey, body.refresh_token));
    this.access = { value: body.access_token, expires: this.now() + (Number(body.expires_in) || 3600) * 1000 };
    return this.access.value;
  }
}
