import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SuggestionImportResult, SuggestionAcceptResult, SuggestionList } from "@agent-hub/shared";
import { createApp } from "../src/app";
import { Documents, DOCUMENT_BODY_BYTES } from "../src/core/documents";
import { Hub } from "../src/core/hub";
import { FakeAdapter } from "../src/agents/fake";
import { openDb, schema, type Db } from "../src/db";

const native = (db: Db) => (db as Db & { $client: Database.Database }).$client;
const token = "fictional-suggestion-api";
const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let root: string, db: Db, service: Documents, fake: FakeAdapter, hub: Hub, app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-api-")); db = openDb(":memory:"); service = new Documents(db); fake = new FakeAdapter();
  hub = new Hub({ db, dataDir: root, agents: { claude: fake, codex: fake }, maxConcurrent: 1 });
  app = createApp(hub, token, undefined, undefined, undefined, { documents: service });
});
afterEach(async () => { await hub.shutdown(100); vi.restoreAllMocks(); native(db).close(); fs.rmSync(root, { recursive: true, force: true }); });
const request = (url: string, method = "GET", body?: unknown, auth = headers) => app.request(url, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function setup() {
  const d = service.create({ title: "Fictional SOP", contentFormat: "plain_text", content: "A😀B\nfictional" });
  const base = `/api/documents/${d.id}/suggestions`;
  const payload = { importRequestId: randomUUID(), source: "manual_import", baseRevisionId: d.currentRevision.id,
    selection: { startUtf16: 1, endUtf16: 3, originalText: "😀" }, replacementText: "new" };
  return { d, base, payload };
}

it("implements all five endpoints, keeps lists metadata-only, and replays accepted receipt independently of current tip", async () => {
  const { d, base, payload } = setup();
  const response = await request(base, "POST", payload); expect(response.status).toBe(201);
  const created = await response.json() as SuggestionImportResult, url = `${base}/${created.suggestion.id}`;
  expect(response.headers.get("location")).toBe(url); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await (await request(url)).json()).toEqual(created.suggestion);
  expect(await (await request(base, "POST", payload)).json()).toEqual({ ...created, replayed: true });
  const list = await (await request(`${base}?limit=1&status=pending&importRequestId=${payload.importRequestId}`)).json() as SuggestionList;
  expect(list.suggestions).toHaveLength(1); expect(list.suggestions[0]).not.toHaveProperty("originalText"); expect(list.suggestions[0]).not.toHaveProperty("replacementText");
  const acceptedResponse = await request(`${url}/accept`, "POST", { expectedRevisionId: d.currentRevision.id }); expect(acceptedResponse.status).toBe(200);
  const accepted = await acceptedResponse.json() as SuggestionAcceptResult;
  expect(accepted.document.currentRevision.content).toBe("AnewB\nfictional"); expect(accepted.replayed).toBe(false);
  // Simulate loss of this acknowledged response by discarding it and reconciling with a GET/repeated POST.
  expect(await (await request(url)).json()).toMatchObject({ status: "accepted", acceptedRevisionId: accepted.acceptedRevisionId });
  const latest = service.update(d.id, { title: "later", contentFormat: "plain_text", content: "later", expectedRevisionId: accepted.acceptedRevisionId }).document;
  expect(await (await request(`${url}/accept`, "POST", { expectedRevisionId: d.currentRevision.id })).json()).toMatchObject({ replayed: true, acceptedRevisionId: accepted.acceptedRevisionId, document: latest });
  expect((await request(base, "POST", payload)).status).toBe(200);
  const rejected = await request(`${url}/reject`, "POST", {}); expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ code: "suggestion_already_accepted" });
  const fresh = { ...payload, importRequestId: randomUUID(), baseRevisionId: latest.currentRevision.id, selection: { startUtf16: 0, endUtf16: 5, originalText: "later" } };
  const pending = await (await request(base, "POST", fresh)).json() as SuggestionImportResult;
  const rejectUrl = `${base}/${pending.suggestion.id}/reject`;
  expect(await (await request(rejectUrl, "POST", {})).json()).toMatchObject({ replayed: false, suggestion: { status: "rejected" } });
  expect(await (await request(rejectUrl, "POST", {})).json()).toMatchObject({ replayed: true, suggestion: { status: "rejected" } });
  expect((await request(`${base}/${pending.suggestion.id}/accept`, "POST", { expectedRevisionId: latest.currentRevision.id })).status).toBe(409);
  expect(service.get(d.id)).toEqual(latest); expect(service.listRevisions(d.id).revisions).toHaveLength(3);
});

it("requires Cookie/Bearer authentication on each route, including no-store on 401", async () => {
  const { d, base, payload } = setup(), s = service.importSuggestion(d.id, payload).suggestion;
  const routes = [[base, "POST", payload], [base, "GET"], [`${base}/${s.id}`, "GET"], [`${base}/${s.id}/accept`, "POST", { expectedRevisionId: d.currentRevision.id }], [`${base}/${s.id}/reject`, "POST", {}]] as const;
  for (const [url, method, body] of routes) {
    for (const auth of [{ "content-type": "application/json" }, { ...headers, authorization: "Bearer wrong" }] as Record<string, string>[]) {
      const r = await request(url, method, body, auth); expect(r.status).toBe(401); expect(r.headers.get("cache-control")).toBe("no-store");
    }
  }
  const login = await request("/api/auth", "POST", { token }), cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const auth = { "content-type": "application/json", cookie };
  for (const [url, method, body] of routes) {
    // Reject resolves it, so subsequent accept intentionally isn't included after resolution.
    const response = await request(url, method, body, auth); expect(response.status).not.toBe(401);
  }
  expect((await request(base)).status).toBe(200);
});

it("isolates document identities and returns safe 400/404/409 instead of leaking another document", async () => {
  const { d, base, payload } = setup(), s = service.importSuggestion(d.id, payload).suggestion, other = setup();
  for (const route of [`${other.base}/${s.id}`, `${other.base}/${s.id}/accept`, `${other.base}/${s.id}/reject`]) {
    const r = await request(route, route.endsWith(s.id) ? "GET" : "POST", route.endsWith("accept") ? { expectedRevisionId: payload.baseRevisionId } : route.endsWith("reject") ? {} : undefined);
    expect(r.status).toBe(404); expect(JSON.stringify(await r.json())).not.toContain(s.originalText);
  }
  expect((await request(`${base}/bad`)).status).toBe(400);
  expect((await request(`/api/documents/bad/suggestions`)).status).toBe(400);
  expect((await request(`${base}/${randomUUID()}`)).status).toBe(404);
  expect((await request(`/api/documents/${randomUUID()}/suggestions`)).status).toBe(404);
  expect((await request(base, "POST", { ...payload, replacementText: "other" })).status).toBe(409);
  expect((await request(base, "POST", { ...payload, extra: true })).status).toBe(400);
  expect((await request(base, "POST", { ...payload, importRequestId: randomUUID(), selection: { ...payload.selection, startUtf16: 2 } })).status).toBe(400);
  expect((await request(base, "POST", { ...payload, importRequestId: randomUUID(), selection: { ...payload.selection, originalText: "x" } })).status).toBe(409);
  for (const query of ["limit=0", "limit=101", "offset=-1", "limit=01", "limit=1.1", "status=stale", "importRequestId=bad"]) expect((await request(`${base}?${query}`)).status).toBe(400);
  expect((await request(`${base}/${s.id}/accept`, "POST", {})).status).toBe(400);
  expect((await request(`${base}/${s.id}/reject`, "POST", { extra: 1 })).status).toBe(400);
  service.restore(d.id, d.currentRevision.id, { expectedRevisionId: d.currentRevision.id });
  const stale = await request(`${base}/${s.id}/accept`, "POST", { expectedRevisionId: d.currentRevision.id });
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "revision_conflict" });
});

it("validates text sizes/Unicode, raw body actual bytes, JSON/UTF-8 and media on all write routes", async () => {
  const { d, base, payload } = setup(), s = service.importSuggestion(d.id, payload).suggestion;
  for (const replacementText of ["\0", "\ud800", "\udfff", "A\r\nB"]) expect((await request(base, "POST", { ...payload, replacementText })).status).toBe(400);
  expect((await request(base, "POST", { ...payload, replacementText: "x".repeat(65537) })).status).toBe(413);
  const large = service.create({ title: "Fictional large", contentFormat: "plain_text", content: "x".repeat(16385) });
  expect((await request(`/api/documents/${large.id}/suggestions`, "POST", { ...payload, baseRevisionId: large.currentRevision.id, selection: { startUtf16: 0, endUtf16: 16385, originalText: large.currentRevision.content } })).status).toBe(413);
  const encoded = JSON.stringify(payload), exact = encoded + " ".repeat(DOCUMENT_BODY_BYTES - Buffer.byteLength(encoded));
  expect((await app.request(base, { method: "POST", headers, body: exact })).status).toBe(200);
  for (const framing of [{}, { "content-length": "1" }, { "content-length": "invalid" }, { "transfer-encoding": "chunked" }] as Record<string, string>[]) {
    const response = await app.request(base, { method: "POST", headers: { ...headers, ...framing }, body: exact + " " });
    expect(response.status).toBe(413); expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const url of [base, `${base}/${s.id}/accept`, `${base}/${s.id}/reject`]) {
    expect((await app.request(url, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await app.request(url, { method: "POST", headers, body: new Uint8Array([0xff]) })).status).toBe(400);
    for (const changed of [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=latin1" }, { "content-encoding": "gzip" }] as Record<string, string>[]) {
      expect((await app.request(url, { method: "POST", headers: { ...headers, ...changed }, body: "{}" })).status).toBe(415);
    }
    expect((await app.request(url, { method: "POST", headers, body: " ".repeat(DOCUMENT_BODY_BYTES + 1) })).status).toBe(413);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(512 * 1024).fill(32)); }, cancel() { cancelled = true; } });
  expect((await app.request(new Request(`http://localhost${base}`, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit))).status).toBe(413);
  expect(cancelled).toBe(true);
});

it("sanitizes SQL failures and unknown error causes without logging original/replacement or leaving half a receipt", async () => {
  const { d, base, payload } = setup(), s = service.importSuggestion(d.id, payload).suggestion;
  const marker = "FICTIONAL_PRIVATE_REPLACEMENT_MARKER";
  const spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "debug").mockImplementation(() => {})];
  native(db).exec(`CREATE TRIGGER fail_suggestion AFTER UPDATE ON document_suggestions BEGIN SELECT RAISE(ABORT, '${marker}'); END`);
  const failed = await request(`${base}/${s.id}/accept`, "POST", { expectedRevisionId: d.currentRevision.id });
  expect(failed.status).toBe(500); expect(await failed.json()).toEqual({ code: "storage_error", error: "Document storage failed." });
  expect(service.get(d.id)).toEqual(d); expect(service.getSuggestion(d.id, s.id).status).toBe("pending");
  native(db).exec("DROP TRIGGER fail_suggestion");
  native(db).exec(`CREATE TRIGGER fail_import AFTER INSERT ON document_suggestions BEGIN SELECT RAISE(ABORT, '${marker}'); END`);
  const importFailure = await request(base, "POST", { ...payload, importRequestId: randomUUID(), replacementText: marker });
  expect(importFailure.status).toBe(500); expect(await importFailure.json()).toEqual({ code: "storage_error", error: "Document storage failed." });
  for (const method of ["importSuggestion", "listSuggestions", "getSuggestion", "acceptSuggestion", "rejectSuggestion"] as const) {
    const spy = vi.spyOn(service, method).mockImplementation(() => { throw new Error(`SQL ${marker}`, { cause: new Error(marker) }); });
    const route = method === "importSuggestion" || method === "listSuggestions" ? base : `${base}/${s.id}${method === "acceptSuggestion" ? "/accept" : method === "rejectSuggestion" ? "/reject" : ""}`;
    const result = await request(route, method === "getSuggestion" || method === "listSuggestions" ? "GET" : "POST", method === "importSuggestion" ? payload : method === "acceptSuggestion" ? { expectedRevisionId: d.currentRevision.id } : method === "rejectSuggestion" ? {} : undefined);
    expect(result.status).toBe(500); expect(await result.json()).toEqual({ code: "storage_error", error: "Document storage failed." }); spy.mockRestore();
  }
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it("maps a genuine SQLite lock to safe 503 Retry-After and preserves pending state", async () => {
  const file = path.join(root, "lock.db"), connection = openDb(file), c = native(connection), locker = new Database(file), documents = new Documents(connection);
  try {
    const d = documents.create({ title: "Fictional", contentFormat: "plain_text", content: "abc" });
    const payload = { importRequestId: randomUUID(), source: "manual_import", baseRevisionId: d.currentRevision.id, selection: { startUtf16: 0, endUtf16: 1, originalText: "a" }, replacementText: "b" };
    const s = documents.importSuggestion(d.id, payload).suggestion;
    c.pragma("busy_timeout = 1"); app = createApp(hub, token, undefined, undefined, undefined, { documents });
    const base = `/api/documents/${d.id}/suggestions`;
    locker.exec("BEGIN IMMEDIATE");
    for (const [url, body] of [[base, { ...payload, importRequestId: randomUUID() }], [`${base}/${s.id}/accept`, { expectedRevisionId: d.currentRevision.id }], [`${base}/${s.id}/reject`, {}]] as const) {
      const r = await request(url, "POST", body); expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("1"); expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({ code: "storage_busy", error: "Document storage is busy. Retry later." });
    }
    locker.exec("ROLLBACK"); expect(documents.get(d.id)).toEqual(d); expect(documents.getSuggestion(d.id, s.id).status).toBe("pending");
  } finally { if (locker.inTransaction) locker.exec("ROLLBACK"); locker.close(); c.close(); }
});

it("has no Agent, Task, Session, Event, queue, quota or Hub notification side effects", async () => {
  const taskId = randomUUID(), sessionId = randomUUID(), eventId = randomUUID();
  db.insert(schema.tasks).values({ id: taskId, title: "existing", workflow: "chat", status: "idle", createdAt: "now", updatedAt: "now" }).run();
  db.insert(schema.sessions).values({ id: sessionId, taskId, agent: "claude", role: "main", status: "idle" }).run();
  db.insert(schema.events).values({ id: eventId, taskId, sessionId, seq: 1, type: "user_message", payload: { text: "existing" }, createdAt: "now" }).run();
  db.insert(schema.queuedMessages).values({ id: randomUUID(), taskId, eventId, text: "existing", createdAt: "now" }).run();
  const snapshot = () => [db.select().from(schema.tasks).all(), db.select().from(schema.sessions).all(), db.select().from(schema.events).all(), db.select().from(schema.queuedMessages).all()];
  const before = snapshot(), listener = vi.fn(), unsubscribe = hub.subscribe(listener);
  const { d, base, payload } = setup();
  const s = (await (await request(base, "POST", payload)).json() as SuggestionImportResult).suggestion;
  const second = (await (await request(base, "POST", { ...payload, importRequestId: randomUUID() })).json() as SuggestionImportResult).suggestion;
  await request(base); await request(`${base}/${s.id}`);
  await request(`${base}/${s.id}/accept`, "POST", { expectedRevisionId: d.currentRevision.id });
  await request(`${base}/${second.id}/reject`, "POST", {});
  expect(snapshot()).toEqual(before); expect(fake.runs).toEqual([]); expect(fake.quotaCalls).toBe(0); expect(listener).not.toHaveBeenCalled(); unsubscribe();
  expect((await request(`/api/tasks/${taskId}`)).status).toBe(200);
});

it("returns authenticated no-store unavailable errors without touching storage", async () => {
  const { d, base, payload } = setup();
  app = createApp(hub, token);
  for (const [url, method, body] of [[base, "POST", payload], [base, "GET"], [`${base}/${randomUUID()}`, "GET"], [`${base}/${randomUUID()}/accept`, "POST", { expectedRevisionId: d.currentRevision.id }], [`${base}/${randomUUID()}/reject`, "POST", {}]] as const) {
    const r = await request(url, method, body); expect(r.status).toBe(503); expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ code: "documents_unavailable" });
  }
});
