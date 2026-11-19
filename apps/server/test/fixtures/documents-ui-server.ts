/** Isolated, loopback-only browser fixture. Never import the production entrypoint. */
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb, type Db } from "../../src/db";
import { Documents } from "../../src/core/documents";
import { Hub } from "../../src/core/hub";
import { FakeAdapter } from "../../src/agents/fake";
import { createApp } from "../../src/app";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "document-ui-"));
const db = openDb(path.join(root, "fixture.db"));
const documents = new Documents(db), fake = new FakeAdapter();
const hub = new Hub({ db, dataDir: root, agents: { claude: fake, codex: fake }, maxConcurrent: 1 });
// This public fixture constant is not an account credential. The server binds only to loopback.
const token = "fictional-document-ui-fixture";
const app = new Hono();
let release: (() => void) | undefined, waiting = false;
let loseCreateResponse = false, createPosts = 0;
let suggestionMode = "", releaseDetail: (() => void) | undefined, failHeldDetail = false;
let delayedAccept: Request | undefined;
const suggestionPosts = { import: 0, accept: 0, reject: 0 };
app.post("/__test/suggestion-mode", async c => { suggestionMode = (await c.req.json<{ mode: string }>()).mode; return c.json({ ok: true }); });
app.post("/__test/release-suggestion", async c => {
  if (delayedAccept) { const request = delayedAccept; delayedAccept = undefined; await backend.fetch(request); }
  releaseDetail?.(); releaseDetail = undefined;
  return c.json({ ok: true });
});
app.post("/__test/lose-create-response", c => { loseCreateResponse = true; return c.json({ ok: true }); });
app.post("/__test/hold", c => { waiting = true; return c.json({ ok: true }); });
app.post("/__test/release", c => { waiting = false; release?.(); release = undefined; return c.json({ ok: true }); });
app.get("/__test/state", c => c.json({ runs: fake.runs.length, quotaCalls: fake.quotaCalls, createPosts, suggestionPosts, heldSuggestionDetail: !!releaseDetail, suggestionMode, documents: documents.list({ limit: "100" }).documents }));
app.use("/api/documents", async (c, next) => {
  const lose = c.req.method === "POST" && loseCreateResponse;
  if (c.req.method === "POST") { createPosts++; loseCreateResponse = false; }
  await next();
  // The real temp-DB Create commits, but the browser cannot parse its acknowledgment.
  if (lose && c.res.ok) c.res = new Response("unreadable fixture response", { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
app.use("/api/documents/*", async (c, next) => {
  if (waiting && c.req.method === "PUT") await new Promise<void>(resolve => { release = resolve; });
  await next();
});
app.use("/api/documents/*", async (c, next) => {
  const path = c.req.path;
  if (!path.includes("/suggestions")) return next();
  const kind = path.endsWith("/accept") ? "accept" : path.endsWith("/reject") ? "reject" : "import";
  if (c.req.method === "POST") {
    suggestionPosts[kind]++;
    if (suggestionMode === "defer-accept" && kind === "accept") {
      suggestionMode = ""; delayedAccept = c.req.raw.clone();
      // A proxy-like unreadable acknowledgment while the original authenticated request is still pending.
      return new Response("unreadable fixture response", { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const lose = suggestionMode === `lose-${kind}`; if (lose) suggestionMode = "";
    await next();
    if (lose && c.res.ok) c.res = new Response("unreadable fixture response", { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } else {
    if (suggestionMode === "hold-detail-fail" && /\/suggestions\/[^/]+$/.test(path)) {
      suggestionMode = ""; failHeldDetail = true;
      await new Promise<void>(resolve => { releaseDetail = resolve; });
      if (failHeldDetail) { failHeldDetail = false; return c.json({ error: "Fixture read failed.", code: "storage_error" }, 500); }
    }
    await next();
  }
});
const backend = createApp(hub, token, undefined, undefined, undefined, { documents });
app.route("/", backend);
const assets = path.resolve(import.meta.dirname, "../../../web/dist");
app.use("/*", serveStatic({ root: assets }));
app.get("/*", c => c.html(fs.readFileSync(path.join(assets, "index.html"), "utf8")));
const first = documents.create({ title: "Fictional LF SOP", contentFormat: "plain_text", content: "Hello 中文😀\nFictional only." });
const legacy = documents.create({ title: "Fictional CRLF SOP", contentFormat: "plain_text", content: "A\r\n\rB" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, info => {
  fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({ port: info.port, first: first.id, legacy: legacy.id }));
  console.log(JSON.stringify({ root, port: info.port, first: first.id, legacy: legacy.id }));
});
async function shutdown() {
  release?.(); releaseDetail?.(); (server as Server).closeAllConnections(); server.close(); await hub.shutdown(100);
  (db as Db & { $client: Database.Database }).$client.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
