import { createHash, randomBytes } from "node:crypto";
import type { GoogleStatus } from "@agent-hub/shared";
import { BASE_SCOPES, CAPABILITIES, capabilities, isCapability, type GoogleCapability } from "./capabilities";
import { readConfig } from "./config";
import { GoogleStore, type StoredAccount } from "./store";
import { GoogleError, GoogleHttp } from "./http";

export { GoogleError } from "./http";

const CONNECT_FIRST = "connect Google Drive from the sidebar first";
const REAUTHORIZE = "Google authorization expired; reconnect Google from the sidebar";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
}

interface PendingConsent {
  verifier: string;
  expires: number;
  redirectUri: string;
  clientId: string;
}

export class GoogleAccount {
  private readonly store: GoogleStore;
  readonly http: GoogleHttp;
  private readonly now: () => number;
  // Losing pending consent on restart is fine: the user retries. Never persist PKCE verifiers.
  private readonly pending = new Map<string, PendingConsent>();
  private cached: { key: string; token: string; expires: number } | null = null;
  private refresh: Promise<string> | null = null;
  // Serialize account mutations, including refresh, so disconnect cannot resurrect a saved account.
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { dataDir: string; fetch?: typeof fetch; now?: () => number }) {
    this.store = new GoogleStore(options.dataDir);
    this.http = new GoogleHttp(options.fetch);
    this.now = options.now ?? Date.now;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(fn, fn);
    this.mutations = next.catch(() => {});
    return next;
  }

  private config() {
    return readConfig(this.options.dataDir);
  }

  status(): GoogleStatus {
    const { config, error } = this.config();
    let account: StoredAccount | undefined;
    let storageError = false;
    try {
      account = Object.values(this.store.read().accounts)[0];
    } catch (err) {
      if (!(err instanceof GoogleError) || err.code !== "storage_error") throw err;
      storageError = true;
    }
    return {
      configured: !!config,
      mode: config?.mode ?? null,
      configError: error,
      storageError,
      account: account ? {
        email: account.email,
        capabilities: account.refreshToken ? capabilities(account.scopes) : [],
        needsReauthorization: !account.refreshToken,
      } : null,
    };
  }

  startConnect(capability: unknown): { authUrl: string } {
    this.store.read();
    if (!isCapability(capability)) throw new GoogleError("unknown_capability", "Unknown Google capability");
    const { config } = this.config();
    if (!config) throw new GoogleError("not_configured", CONNECT_FIRST);
    for (const [state, value] of this.pending) {
      if (value.expires <= this.now()) this.pending.delete(state);
    }
    if (this.pending.size >= 100) {
      throw new GoogleError("failed", "Too many pending Google connections; retry later");
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, {
      verifier,
      expires: this.now() + 10 * 60_000,
      redirectUri: config.redirectUri,
      clientId: config.clientId,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: [...BASE_SCOPES, ...CAPABILITIES[capability].scopes].join(" "),
      include_granted_scopes: "true",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { authUrl: url.href };
  }

  async complete(input: { code?: string; state?: string; error?: string }): Promise<GoogleStatus> {
    const pending = input.state ? this.pending.get(input.state) : undefined;
    if (input.state) this.pending.delete(input.state);
    this.store.read();
    if (!pending || pending.expires <= this.now()) {
      throw new GoogleError("expired_state", "Google connection expired; start again");
    }
    if (input.error) {
      throw new GoogleError(
        input.error === "access_denied" ? "denied" : "failed",
        "Google consent was not completed",
      );
    }
    if (!input.code) throw new GoogleError("failed", "Google authorization code missing");
    return this.serial(async () => {
      this.store.read();
      const { config } = this.config();
      if (!config || config.clientId !== pending.clientId || config.redirectUri !== pending.redirectUri) {
        throw new GoogleError("not_configured", CONNECT_FIRST);
      }
      const token = await this.token({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: input.code!,
        code_verifier: pending.verifier,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      });
      let identity: { sub: string; email: string };
      try {
        // This ID token comes directly from Google's TLS token endpoint, never from the browser.
        identity = JSON.parse(Buffer.from(token.id_token!.split(".")[1]!, "base64url").toString("utf8"));
        if (
          typeof identity.sub !== "string" || !identity.sub ||
          typeof identity.email !== "string" || !identity.email
        ) {
          throw new Error();
        }
      } catch {
        throw new GoogleError("failed", "Google account identity missing");
      }
      const accounts = this.store.read().accounts;
      const old = Object.entries(accounts)[0];
      const same = old?.[0] === identity.sub ? old[1] : undefined;
      const refreshToken = token.refresh_token || same?.refreshToken;
      if (!refreshToken) {
        throw new GoogleError("failed", "Google offline authorization missing; reconnect Google");
      }
      if (old && !same) await this.revoke(old[1].refreshToken);
      this.store.write({
        version: 1,
        accounts: {
          [identity.sub]: {
            email: identity.email,
            refreshToken,
            scopes: [...new Set([
              ...(same?.scopes ?? []),
              ...(token.scope?.split(/\s+/).filter(Boolean) ?? []),
            ])],
            updatedAt: new Date(this.now()).toISOString(),
          },
        },
      });
      this.cached = {
        key: identity.sub,
        token: token.access_token!,
        expires: this.now() + (token.expires_in ?? 3600) * 1000 - 60_000,
      };
      return this.status();
    });
  }

  completeFromPastedUrl(value: unknown): Promise<GoogleStatus> {
    this.store.read();
    const { config } = this.config();
    if (!config) throw new GoogleError("not_configured", CONNECT_FIRST);
    if (config.mode !== "paste") throw new GoogleError("wrong_mode", "Google connection uses callback mode");
    let url: URL;
    try {
      if (typeof value !== "string") throw new Error();
      url = new URL(value);
      const expected = new URL(config.redirectUri);
      if (
        url.origin !== expected.origin || url.pathname !== expected.pathname ||
        url.username || url.password || url.hash
      ) {
        throw new Error();
      }
    } catch {
      throw new GoogleError(
        "invalid_url",
        "Paste the full Google redirect URL matching the configured origin and path",
      );
    }
    // Only parse the pasted URL. It must never become a network destination.
    return this.complete({
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
    });
  }

  private async token(params: Record<string, string>): Promise<TokenResponse> {
    const response = await this.http.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams(params),
    });
    const value = await response.json().catch(() => ({})) as TokenResponse;
    if (!response.ok || typeof value.access_token !== "string" || !value.access_token) {
      if (value.error === "invalid_grant" && params.grant_type === "refresh_token") {
        throw new GoogleError("reauthorize", REAUTHORIZE);
      }
      throw new GoogleError("failed", "Google token exchange failed");
    }
    return value;
  }

  private async revoke(token: string): Promise<void> {
    if (!token) return;
    await this.http.request("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      body: new URLSearchParams({ token }),
    }).then(async (r) => {
      await r.body?.cancel();
    }).catch(() => {});
  }

  disconnect(): Promise<GoogleStatus> {
    this.pending.clear();
    return this.serial(async () => {
      try {
        const account = Object.values(this.store.read().accounts)[0];
        if (account) await this.revoke(account.refreshToken);
      } catch (err) {
        // An unreadable store has no usable token to revoke; deletion is the recovery path.
        if (!(err instanceof GoogleError) || err.code !== "storage_error") throw err;
      } finally {
        this.cached = null;
        this.store.clear();
      }
      return this.status();
    });
  }

  async accessToken(capability: GoogleCapability, force = false): Promise<string> {
    const entry = Object.entries(this.store.read().accounts)[0];
    if (!this.config().config) throw new GoogleError("not_configured", CONNECT_FIRST);
    if (!entry) throw new GoogleError("not_connected", CONNECT_FIRST);
    const [key, account] = entry;
    if (!account.refreshToken) throw new GoogleError("reauthorize", REAUTHORIZE);
    if (!capabilities(account.scopes).includes(capability)) {
      throw new GoogleError("missing_capability", CONNECT_FIRST);
    }
    if (!force && this.cached?.key === key && this.cached.expires > this.now()) return this.cached.token;
    if (this.refresh) return this.refresh;
    this.refresh = this.serial(async () => {
      const current = Object.entries(this.store.read().accounts)[0];
      const { config } = this.config();
      if (!current || current[0] !== key || !config) throw new GoogleError("not_connected", CONNECT_FIRST);
      try {
        const token = await this.token({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: current[1].refreshToken,
          grant_type: "refresh_token",
        });
        this.cached = {
          key,
          token: token.access_token!,
          expires: this.now() + (token.expires_in ?? 3600) * 1000 - 60_000,
        };
        return this.cached.token;
      } catch (err) {
        if (err instanceof GoogleError && err.code === "reauthorize") {
          this.cached = null;
          this.store.write({
            version: 1,
            accounts: {
              [key]: {
                ...current[1],
                refreshToken: "",
                scopes: [],
                updatedAt: new Date(this.now()).toISOString(),
              },
            },
          });
        }
        throw err;
      }
    }).finally(() => {
      this.refresh = null;
    });
    return this.refresh;
  }

  async request(capability: GoogleCapability, url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(init.headers);
      init.signal?.throwIfAborted();
      const pendingToken = this.accessToken(capability, attempt === 1);
      const token = init.signal ? await withSignal(pendingToken, init.signal) : await pendingToken;
      init.signal?.throwIfAborted();
      headers.set("Authorization", `Bearer ${token}`);
      const response = await this.http.request(url, { ...init, headers });
      if (response.status !== 401) return response;
      await response.body?.cancel().catch(() => {});
    }
    throw new GoogleError("reauthorize", REAUTHORIZE);
  }
}

/** A stopped download need not wait for a shared account refresh to finish. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
