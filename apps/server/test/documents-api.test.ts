import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentDetail, DocumentWriteResult, DocumentList, DocumentRevisionList, DocumentErrorResponse } from "@agent-hub/shared";
import { createApp } from "../src/app";
import { Documents, DOCUMENT_BODY_BYTES, DOCUMENT_CONTENT_BYTES } from "../src/core/documents";
import { Hub } from "../src/core/hub";
import { FakeAdapter } from "../src/agents/fake";
import { openDb, schema, type Db } from "../src/db";

const draft = { title: " Fictional SOP ", contentFormat: "plain_text", content: "中文😀\r\nprivate fictional text" };
const headers = { authorization: "Bearer document-test", "content-type": "application/json" };
let root: string, db: Db, service: Documents, hub: Hub, fake: FakeAdapter, app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "document-api-"));
  db = openDb(":memory:"); service = new Documents(db); fake = new FakeAdapter();
  hub = new Hub({ db, dataDir: root, agents: { claude: fake, codex: fake }, maxConcurrent: 1 });
  app = createApp(hub, "document-test", undefined, undefined, undefined, { documents: service });
});
afterEach(async () => {
  await hub.shutdown(100); vi.restoreAllMocks();
  (db as Db & { $client: Database.Database }).$client.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const request = (url: string, method = "GET", body?: unknown, auth: Record<string, string> = headers) => app.request(url, {
  method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function create() {
  const response = await request("/api/documents", "POST", draft);
  expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
  const document = await response.json() as DocumentDetail;
  expect(response.headers.get("location")).toBe(`/api/documents/${document.id}`);
  return document;
}

it("implements the seven endpoints, returning metadata histories and immutable full revisions", async () => {
  const first = await create(), base = `/api/documents/${first.id}`;
  expect(await (await request(base)).json()).toEqual(first);
  const update = await request(base, "PUT", { ...draft, content: "edited", expectedRevisionId: first.currentRevision.id });
  expect(update.status).toBe(200);
  const updated = await update.json() as DocumentWriteResult;
  expect(updated.revisionCreated).toBe(true);
  const list = await (await request("/api/documents?limit=1&offset=0")).json() as DocumentList;
  expect(list).toMatchObject({ documents: [{ currentRevisionId: updated.document.currentRevision.id }], nextOffset: null });
  expect(list.documents[0]).not.toHaveProperty("content");
  const history = await (await request(`${base}/revisions?limit=1`)).json() as DocumentRevisionList;
  expect(history.revisions[0]!.revisionNumber).toBe(2); expect(history.revisions[0]).not.toHaveProperty("content");
  expect(history.nextBeforeRevisionNumber).toBe(2);
  const oldPage = await (await request(`${base}/revisions?beforeRevisionNumber=2`)).json() as DocumentRevisionList;
  expect(oldPage.revisions).toHaveLength(1);
  expect(await (await request(`${base}/revisions/${first.currentRevision.id}`)).json()).toEqual(first.currentRevision);
  const restored = await request(`${base}/revisions/${first.currentRevision.id}/restore`, "POST", { expectedRevisionId: updated.document.currentRevision.id });
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ revisionCreated: true, document: { currentRevision: { revisionNumber: 3, content: draft.content, restoredFromRevisionId: first.currentRevision.id } } });
  expect((await request(base, "DELETE")).status).toBe(404);
});

it("requires authentication on every endpoint and supports both existing Bearer and Cookie auth", async () => {
  const first = await create(), base = `/api/documents/${first.id}`;
  const routes = [["/api/documents", "POST"], ["/api/documents", "GET"], [base, "GET"], [base, "PUT"], [`${base}/revisions`, "GET"], [`${base}/revisions/${first.currentRevision.id}`, "GET"], [`${base}/revisions/${first.currentRevision.id}/restore`, "POST"]];
  for (const [url, method] of routes) {
    for (const auth of [{ "content-type": "application/json" }, { ...headers, authorization: "Bearer wrong" }]) {
      const response = await request(url!, method!, method === "GET" ? undefined : {}, auth as typeof headers);
      expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
    }
  }
  const login = await request("/api/auth", "POST", { token: "document-test" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const cookieHeaders = { "content-type": "application/json", cookie };
  expect((await app.request(base, { headers: cookieHeaders })).status).toBe(200);
  expect((await app.request("/api/documents", { method: "POST", headers: cookieHeaders, body: JSON.stringify(draft) })).status).toBe(201);
});

it("returns one success and one 409 for competing HTTP updates (sequential synchronous CAS, not a lock test)", async () => {
  const first = await create(), base = `/api/documents/${first.id}`, expectedRevisionId = first.currentRevision.id;
  const responses = await Promise.all([request(base, "PUT", { ...draft, content: "A", expectedRevisionId }), request(base, "PUT", { ...draft, content: "B", expectedRevisionId })]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const conflict = await responses.find((r) => r.status === 409)!.json() as DocumentErrorResponse;
  expect(conflict.code).toBe("revision_conflict"); expect(conflict).not.toHaveProperty("content");
  expect(service.listRevisions(first.id).revisions).toHaveLength(2);
  const current = service.get(first.id);
  expect(await (await request(base, "PUT", { title: current.currentRevision.title, contentFormat: "plain_text", content: current.currentRevision.content, expectedRevisionId: current.currentRevision.id })).json()).toEqual({ document: current, revisionCreated: false });
  expect((await request(`${base}/revisions/${first.currentRevision.id}/restore`, "POST", { expectedRevisionId })).status).toBe(409);
});

it("rejects bad IDs, absent documents/revisions, cross-document reads/restores and invalid pagination", async () => {
  const first = await create(), other = await create(), base = `/api/documents/${first.id}`;
  for (const url of ["/api/documents/nope", `${base}/revisions/nope`]) expect((await request(url)).status).toBe(400);
  for (const url of [`/api/documents/${randomUUID()}`, `${base}/revisions/${randomUUID()}`, `${base}/revisions/${other.currentRevision.id}`]) expect((await request(url)).status).toBe(404);
  expect((await request(`${base}/revisions/${other.currentRevision.id}/restore`, "POST", { expectedRevisionId: first.currentRevision.id })).status).toBe(404);
  for (const query of ["limit=0", "limit=101", "offset=-1", "limit=01", "limit=1.1"]) expect((await request(`/api/documents?${query}`)).status).toBe(400);
  expect((await request(`${base}/revisions?beforeRevisionNumber=0`)).status).toBe(400);
});

it("validates exact shapes, blank titles, Unicode, missing CAS and allowed empty bodies", async () => {
  for (const body of [null, [], {}, { ...draft, id: randomUUID() }, { ...draft, title: "  " }, { ...draft, title: "😀".repeat(101) }, { ...draft, title: "\ud800" }, { ...draft, content: "\udfff" }, { ...draft, content: "x\0" }, { ...draft, contentFormat: "json" }]) {
    expect((await request("/api/documents", "POST", body)).status).toBe(400);
  }
  for (const content of ["", " \r\n\t", "中文😀\r\n"]) {
    const response = await request("/api/documents", "POST", { ...draft, content });
    expect(response.status).toBe(201); expect((await response.json() as DocumentDetail).currentRevision.content).toBe(content);
  }
  const first = await create();
  expect((await request(`/api/documents/${first.id}`, "PUT", draft)).status).toBe(400);
  expect((await request(`/api/documents/${first.id}/revisions/${first.currentRevision.id}/restore`, "POST", {})).status).toBe(400);
  expect((await app.request("/api/documents", { method: "POST", headers, body: "{" })).status).toBe(400);
});

it("enforces decoded UTF-8 and actual raw byte boundaries, without trusting Content-Length", async () => {
  const content = "😀".repeat(DOCUMENT_CONTENT_BYTES / 4);
  expect((await request("/api/documents", "POST", { ...draft, content })).status).toBe(201);
  expect((await request("/api/documents", "POST", { ...draft, content: content + "x" })).status).toBe(413);
  const json = JSON.stringify({ ...draft, content: "" });
  const exact = json + " ".repeat(DOCUMENT_BODY_BYTES - Buffer.byteLength(json));
  expect((await app.request("/api/documents", { method: "POST", headers, body: exact })).status).toBe(201);
  const framings: Record<string, string>[] = [{}, { "content-length": "1" }, { "content-length": "invalid" }, { "transfer-encoding": "chunked" }];
  for (const framing of framings) {
    const response = await app.request("/api/documents", { method: "POST", headers: { ...headers, ...framing }, body: exact + " " });
    expect(response.status).toBe(413); expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

it("bounds a chunked stream, cancels oversized bodies and rejects invalid UTF-8", async () => {
  let cancelled = false, reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(512 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  const init = { method: "POST", headers, body: stream, duplex: "half" as const };
  const response = await app.request(new Request("http://localhost/api/documents", init));
  expect(response.status).toBe(413); expect(cancelled).toBe(true); expect(reads).toBeLessThanOrEqual(6);
  expect((await app.request("/api/documents", { method: "POST", headers, body: new Uint8Array([0xff]) })).status).toBe(400);
});

it("rejects unsupported media/encoding and accepts UTF-8 JSON charset", async () => {
  const media: Record<string, string>[] = [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=latin1" }, { "content-encoding": "gzip" }];
  for (const values of media) {
    expect((await app.request("/api/documents", { method: "POST", headers: { ...headers, ...values }, body: JSON.stringify(draft) })).status).toBe(415);
  }
  expect((await app.request("/api/documents", { method: "POST", headers: { ...headers, "content-type": "application/json; charset=\"UTF-8\"" }, body: JSON.stringify(draft) })).status).toBe(201);
});

it("never exposes/logs private SQL/query parameters in domain or unexpected document errors", async () => {
  const sentinel = "PRIVATE_FICTIONAL_SOP_SENTINEL";
  const spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
  expect((await request("/api/documents", "POST", { ...draft, title: sentinel + "\0" })).status).toBe(400);
  db.run(sql`CREATE TRIGGER fail_document AFTER INSERT ON document_revisions BEGIN SELECT RAISE(ABORT, 'internal failure'); END`);
  const failed = await request("/api/documents", "POST", { ...draft, content: sentinel });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: "Document storage failed.", code: "storage_error" });
  expect(db.select().from(schema.documents).all()).toEqual([]);
  vi.spyOn(service, "create").mockImplementation(() => { throw new Error(`SQL parameters: ${sentinel}`); });
  expect(await (await request("/api/documents", "POST", { ...draft, content: sentinel })).json()).toEqual({ error: "Document storage failed.", code: "storage_error" });
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it("does not create tasks/events, run agents, query quota or publish Hub notifications", async () => {
  const taskId = randomUUID(), sessionId = randomUUID(), eventId = randomUUID();
  db.insert(schema.tasks).values({ id: taskId, title: "existing", workflow: "chat", status: "idle", createdAt: "now", updatedAt: "now" }).run();
  db.insert(schema.sessions).values({ id: sessionId, taskId, agent: "claude", role: "main", status: "idle" }).run();
  db.insert(schema.events).values({ id: eventId, taskId, sessionId, seq: 1, type: "user_message", payload: { text: "existing" }, createdAt: "now" }).run();
  db.insert(schema.queuedMessages).values({ id: randomUUID(), taskId, eventId, text: "existing", createdAt: "now" }).run();
  const snapshot = () => [db.select().from(schema.tasks).all(), db.select().from(schema.sessions).all(), db.select().from(schema.events).all(), db.select().from(schema.queuedMessages).all()];
  const before = snapshot(), listener = vi.fn(), unsubscribe = hub.subscribe(listener);
  const first = await create();
  service.update(first.id, { ...draft, content: "edited", expectedRevisionId: first.currentRevision.id });
  service.restore(first.id, first.currentRevision.id, { expectedRevisionId: service.get(first.id).currentRevision.id });
  expect(snapshot()).toEqual(before); expect(fake.runs).toEqual([]); expect(fake.quotaCalls).toBe(0); expect(listener).not.toHaveBeenCalled(); unsubscribe();
  expect((await request(`/api/tasks/${taskId}`)).status).toBe(200);
});

it("returns safe unavailable errors without opening storage, while preserving auth and existing routes", async () => {
  app = createApp(hub, "document-test");
  expect((await request("/api/documents")).status).toBe(503);
  expect((await request("/api/documents", "GET", undefined, {} as typeof headers)).status).toBe(401);
  expect((await request("/api/tasks")).status).toBe(200);
});

it("maps a real SQLite writer lock to 503 with Retry-After, without exposing storage errors", async () => {
  const file = path.join(root, "locked.db"), connection = openDb(file);
  const native = (connection as Db & { $client: Database.Database }).$client;
  const locker = new Database(file), documents = new Documents(connection);
  try {
    const first = documents.create(draft);
    native.pragma("busy_timeout = 1");
    app = createApp(hub, "document-test", undefined, undefined, undefined, { documents });
    locker.exec("BEGIN IMMEDIATE");
    const response = await request(`/api/documents/${first.id}`, "PUT", { ...draft, content: "private edit", expectedRevisionId: first.currentRevision.id });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "storage_busy", error: "Document storage is busy. Retry later." });
    locker.exec("ROLLBACK");
    expect(documents.get(first.id)).toEqual(first);
  } finally { if (locker.inTransaction) locker.exec("ROLLBACK"); locker.close(); native.close(); }
});
