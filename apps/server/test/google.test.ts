import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAccount } from "../src/google/auth";
import { GoogleHttp } from "../src/google/http";
import { readConfig } from "../src/google/config";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { openDb } from "../src/db";
const dirs: string[] = [];
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "google-test-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
function configure(dir: string, redirectUri = "http://127.0.0.1:12345/callback") {
  fs.mkdirSync(path.join(dir, "google"), { recursive: true });
  fs.writeFileSync(path.join(dir, "google/client.json"), JSON.stringify({ clientId: "test-client", clientSecret: "secret-client", redirectUri }));
}
function token(sub = "account-1", email = "user@example.invalid", overrides: object = {}) {
  return { access_token: "secret-access", refresh_token: "secret-refresh", expires_in: 3600, scope: `openid email ${DRIVE_SCOPE}`, id_token: `header.${Buffer.from(JSON.stringify({ sub, email })).toString("base64url")}.signature`, ...overrides };
}
function state(google: GoogleAccount) { return new URL(google.startConnect("drive.read").authUrl).searchParams.get("state")!; }
function fixture(redirect?: string) {
  const dir = directory(); configure(dir, redirect);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(token()));
  let now = 1_000_000;
  const google = new GoogleAccount({ dataDir: dir, fetch: fetcher, now: () => now });
  return { dir, google, fetcher, advance: (ms: number) => { now += ms; } };
}
describe("Google configuration and network boundary", () => {
  it("reports missing configuration without credentials", () => {
    const google = new GoogleAccount({ dataDir: directory() });
    expect(google.status()).toMatchObject({ configured: false, mode: null, account: null });
    expect(() => google.startConnect("drive.read")).toThrow(/connect Google/);
  });
  it.each([
    ["https://hub.example.invalid/api/google/callback", "callback"],
    ["http://127.0.0.1:12345", "paste"], ["http://127.0.0.1:80/callback", "paste"], ["http://localhost:23456/callback", "paste"],
    ["http://hub.example.invalid/callback", null], ["http://127.0.0.1", null],
    ["https://192.0.2.1/callback", null], ["http://[::1]:12345", null],
    ["https://user:secret@hub.example.invalid/", null], ["", null],
  ])("validates %s", (uri, mode) => {
    const dir = directory(); configure(dir, uri!);
    expect(readConfig(dir).config?.mode ?? null).toBe(mode);
    expect(readConfig(dir).error ?? "").not.toContain("secret");
  });
  it("rejects other origins and redirects without following them or exposing errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const http = new GoogleHttp(fetcher);
    await expect(http.request("https://evil.example/")).rejects.toThrow(/refused/);
    await expect(http.request("http://www.googleapis.com/")).rejects.toThrow(/refused/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(http.request("https://www.googleapis.com/drive/v3/files/id")).rejects.toThrow(/redirect refused/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("manual");
    fetcher.mockRejectedValue(new Error("secret-refresh"));
    await expect(http.request("https://oauth2.googleapis.com/token")).rejects.toThrow("Google request failed");
  });
});
describe("Google authorization", () => {
  it("requests exactly the consented scopes, uses S256, persists a private keyed store and hides secrets", async () => {
    const { google, dir, fetcher } = fixture();
    const consent = new URL(google.startConnect("drive.read").authUrl);
    expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(consent.searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", DRIVE_SCOPE]);
    for (const [key, value] of Object.entries({ include_granted_scopes: "true", access_type: "offline", prompt: "consent", response_type: "code", code_challenge_method: "S256" })) expect(consent.searchParams.get(key)).toBe(value);
    await google.complete({ state: consent.searchParams.get("state")!, code: "secret-code" });
    const params = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(consent.searchParams.get("code_challenge"));
    expect(params.get("code")).toBe("secret-code");
    const store = path.join(dir, "google/accounts.json");
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toMatchObject({ version: 1, accounts: { "account-1": { email: "user@example.invalid", refreshToken: "secret-refresh" } } });
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "google/client.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "google")).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(google.status())).not.toMatch(/secret-|id_token|access_token|refreshToken/);
    expect(google.status().account).toEqual({ email: "user@example.invalid", capabilities: ["drive.read"], needsReauthorization: false });
    expect(() => google.startConnect("gmail.send")).toThrow(/Unknown/);
  });
  it("enforces state single use, expiry, denial and restart", async () => {
    const { google, dir, fetcher, advance } = fixture();
    const single = state(google);
    await google.complete({ state: single, code: "code" });
    await expect(google.complete({ state: single, code: "code" })).rejects.toMatchObject({ code: "expired_state" });
    const expired = state(google); advance(600_000);
    await expect(google.complete({ state: expired, code: "code" })).rejects.toMatchObject({ code: "expired_state" });
    const denied = state(google);
    await expect(google.complete({ state: denied, error: "access_denied" })).rejects.toMatchObject({ code: "denied" });
    await expect(google.complete({ state: denied, code: "code" })).rejects.toMatchObject({ code: "expired_state" });
    const lost = state(google);
    await expect(new GoogleAccount({ dataDir: dir, fetch: fetcher }).complete({ state: lost, code: "code" })).rejects.toMatchObject({ code: "expired_state" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("only parses a matching pasted origin/path and never fetches it", async () => {
    const { google, fetcher } = fixture();
    const key = state(google);
    for (const url of [`http://localhost:12345/callback?code=secret&state=${key}`, `http://127.0.0.1:12345/other?code=secret&state=${key}`, "not a url"]) {
      expect(() => google.completeFromPastedUrl(url)).toThrow(/matching/);
    }
    expect(fetcher).not.toHaveBeenCalled();
    await google.completeFromPastedUrl(`http://127.0.0.1:12345/callback?code=secret&state=${key}`);
    expect(fetcher.mock.calls.every(([url]) => url === "https://oauth2.googleapis.com/token")).toBe(true);
  });
  it("replaces a different account, merges same-account grants, and revokes on disconnect", async () => {
    const { google, fetcher, dir } = fixture();
    await google.complete({ state: state(google), code: "code" });
    fetcher.mockResolvedValueOnce(Response.json(token("account-1", "user@example.invalid", { refresh_token: undefined, scope: "openid email" })));
    await google.complete({ state: state(google), code: "code" });
    expect(google.status().account?.capabilities).toEqual(["drive.read"]);
    fetcher.mockResolvedValueOnce(Response.json(token("account-2", "other@example.invalid")));
    await google.complete({ state: state(google), code: "code" });
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "google/accounts.json"), "utf8")).accounts)).toEqual(["account-2"]);
    expect(fetcher.mock.calls.some(([url]) => url === "https://oauth2.googleapis.com/revoke")).toBe(true);
    fetcher.mockRejectedValueOnce(new Error("offline secret"));
    await google.disconnect();
    expect(google.status().account).toBeNull();
    expect(fs.existsSync(path.join(dir, "google/accounts.json"))).toBe(false);
  });
  it("refreshes after expiry or a 401 once, and invalid_grant preserves email with unusable capabilities", async () => {
    const { google, fetcher, advance, dir } = fixture();
    await google.complete({ state: state(google), code: "code" });
    advance(3600_000);
    await google.accessToken("drive.read");
    expect((fetcher.mock.calls[1]![1]?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(Response.json(token())).mockResolvedValueOnce(Response.json({ id: "file" }));
    await expect(google.request("drive.read", "https://www.googleapis.com/drive/v3/files/file")).resolves.toMatchObject({ status: 200 });
    fetcher.mockResolvedValueOnce(Response.json({ error: "invalid_grant", error_description: "secret" }, { status: 400 }));
    await expect(google.accessToken("drive.read", true)).rejects.toMatchObject({ code: "reauthorize" });
    expect(google.status().account).toEqual({ email: "user@example.invalid", capabilities: [], needsReauthorization: true });
    expect(new GoogleAccount({ dataDir: dir, fetch: fetcher }).status().account?.needsReauthorization).toBe(true);
    await expect(google.accessToken("drive.read")).rejects.toMatchObject({ code: "reauthorize" });
  });
  it("does not retry a second 401", async () => {
    const { google, fetcher } = fixture();
    await google.complete({ state: state(google), code: "code" });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(Response.json(token())).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(google.request("drive.read", "https://www.googleapis.com/drive/v3/files/file")).rejects.toThrow(/authorization expired/);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
describe("Google API", () => {
  function app(google: GoogleAccount, dir: string) {
    return createApp(new Hub({ db: openDb(":memory:"), dataDir: dir, agents: {}, maxConcurrent: 1 }), "hub-token", undefined, undefined, undefined, { google });
  }
  it("allows the callback without a cookie and uses only fixed redirect results", async () => {
    const { google, dir, fetcher } = fixture("https://hub.example.invalid/api/google/callback");
    const api = app(google, dir);
    const connected = await api.request(`/api/google/callback?code=secret&state=${state(google)}`);
    expect(connected.status).toBe(302); expect(connected.headers.get("location")).toBe("/?google=connected");
    expect(await connected.text()).not.toContain("secret");
    const denied = await api.request(`/api/google/callback?error=access_denied&state=${state(google)}`);
    expect(denied.headers.get("location")).toBe("/?google=denied");
    fetcher.mockResolvedValueOnce(Response.json({ error: "invalid_grant", error_description: "secret" }, { status: 400 }));
    const failed = await api.request(`/api/google/callback?code=secret&state=${state(google)}`);
    expect(failed.headers.get("location")).toBe("/?google=failed");
    expect(await failed.text()).not.toContain("secret");
    const bad = await api.request("/api/google/callback?state=secret&error=https://evil.example/");
    expect(bad.headers.get("location")).toBe("/?google=expired_state");
    expect((await api.request("/api/google")).status).toBe(401);
    const status = await api.request("/api/google", { headers: { authorization: "Bearer hub-token" } });
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.text()).not.toContain("secret");
    const complete = await api.request("/api/google/complete", { method: "POST", headers: { authorization: "Bearer hub-token", "content-type": "application/json" }, body: JSON.stringify({ url: "secret" }) });
    expect(complete.status).toBe(409);
  });
  it("reports absent configuration through the protected API", async () => {
    const dir = directory();
    const api = app(new GoogleAccount({ dataDir: dir }), dir);
    const response = await api.request("/api/google", { headers: { authorization: "Bearer hub-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, mode: null, account: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns 404 for paste callbacks, and protects connect, complete and delete", async () => {
    const { google, dir } = fixture(); const api = app(google, dir);
    expect((await api.request("/api/google/callback?state=secret")).status).toBe(404);
    for (const [url, method] of [["/api/google/connect", "POST"], ["/api/google/complete", "POST"], ["/api/google", "DELETE"]]) expect((await api.request(url!, { method })).status).toBe(401);
    expect((await api.request("/api/google/connect", { method: "POST", headers: { authorization: "Bearer hub-token", "content-type": "application/json" }, body: '{"capability":"gmail.send"}' })).status).toBe(400);
  });
});

describe("Google storage recovery and API error codes", () => {
  const headers = { authorization: "Bearer hub-token", "content-type": "application/json" };

  function api(google: GoogleAccount, dataDir: string) {
    const hub = new Hub({ db: openDb(":memory:"), dataDir, agents: {}, maxConcurrent: 1 });
    return createApp(hub, "hub-token", undefined, undefined, undefined, { google });
  }

  it.each([
    "{secret-file-contents",
    "null",
    JSON.stringify({ version: 2, accounts: {} }),
    JSON.stringify({ version: 1, accounts: [] }),
    JSON.stringify({ version: 1, accounts: "secret-file-contents" }),
    JSON.stringify({ version: 1, accounts: { sub: { email: "secret-file-contents" } } }),
    JSON.stringify({ version: 1, accounts: { one: {}, two: {} } }),
  ])("reports invalid storage safely and allows disconnect: %s", async (contents) => {
    const { google, dir, fetcher } = fixture();
    const pendingState = state(google);
    const file = path.join(dir, "google/accounts.json");
    fs.writeFileSync(file, contents);
    const app = api(google, dir);
    const response = await app.request("/api/google", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const status = await response.json();
    expect(status).toMatchObject({ configured: true, mode: "paste", storageError: true, account: null });
    expect(JSON.stringify(status)).not.toContain("secret-file-contents");

    expect(() => google.startConnect("drive.read")).toThrow(expect.objectContaining({ code: "storage_error" }));
    await expect(google.accessToken("drive.read")).rejects.toMatchObject({ code: "storage_error" });
    await expect(google.complete({ code: "secret-code", state: pendingState })).rejects.toMatchObject({ code: "storage_error" });
    expect(fetcher).not.toHaveBeenCalled();

    for (const [route, body] of [
      ["connect", { capability: "drive.read" }],
      ["complete", { url: "http://127.0.0.1:12345/callback?code=secret-code&state=lost" }],
    ] as const) {
      const failure = await app.request(`/api/google/${route}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect(failure.status).toBe(400);
      expect(await failure.json()).toEqual({
        error: "Could not read Google account storage", code: "storage_error",
      });
    }

    const disconnected = await app.request("/api/google", { method: "DELETE", headers });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({ storageError: false, account: null });
    expect(fs.existsSync(file)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => google.startConnect("drive.read")).not.toThrow();
    expect((await app.request("/api/google", { headers })).status).toBe(200);
  });

  it("refuses cached credentials after storage becomes corrupt and clears them on disconnect", async () => {
    const { google, dir } = fixture();
    await google.complete({ code: "code", state: state(google) });
    expect(await google.accessToken("drive.read")).toBe("secret-access");
    fs.writeFileSync(path.join(dir, "google/accounts.json"), "{corrupt-secret");
    await expect(google.accessToken("drive.read")).rejects.toMatchObject({ code: "storage_error" });
    await google.disconnect();
    await expect(google.accessToken("drive.read")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("returns fixed error codes for configuration, unknown capabilities and pasted URL failures", async () => {
    const { google, dir } = fixture();
    const app = api(google, dir);
    const post = (route: string, body: unknown) => app.request(`/api/google/${route}`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    const unknown = await post("connect", { capability: "unsupported-secret" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "Unknown Google capability", code: "unknown_capability" });

    const invalid = await post("complete", { url: "https://evil.example/secret" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Paste the full Google redirect URL matching the configured origin and path", code: "invalid_url",
    });
    const expired = await post("complete", { url: "http://127.0.0.1:12345/callback?state=lost-on-restart" });
    expect(await expired.json()).toEqual({ error: "Google connection expired; start again", code: "expired_state" });
    const denied = await post("complete", {
      url: `http://127.0.0.1:12345/callback?error=access_denied&state=${state(google)}`,
    });
    expect(await denied.json()).toEqual({ error: "Google consent was not completed", code: "denied" });

    fs.rmSync(path.join(dir, "google/client.json"));
    const unconfigured = await post("connect", { capability: "drive.read" });
    expect(await unconfigured.json()).toEqual({
      error: "connect Google Drive from the sidebar first", code: "not_configured",
    });
  });

  it("keeps wrong_mode as a coded 409 response", async () => {
    const { google, dir } = fixture("https://hub.example.invalid/api/google/callback");
    const response = await api(google, dir).request("/api/google/complete", {
      method: "POST", headers, body: JSON.stringify({ url: "secret" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Google connection uses callback mode", code: "wrong_mode" });
  });
});
