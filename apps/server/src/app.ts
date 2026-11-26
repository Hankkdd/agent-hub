import type { ClaudeLogin } from "./claude-login/login";
import type { RoomCreateInput, RoomMessageInput } from "@agent-hub/shared";
import { AntigravityLogin, AntigravityError } from "./antigravity/login";
import { GoogleAccount, GoogleError } from "./google/auth";
import type { Deployer } from "./deploy/deployer";
import { IssueCommentError } from "./core/issue-comments";
import fs from "node:fs";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { ImageUpload, NewTaskInput, RecoverAction, StreamMessage } from "@agent-hub/shared";
import { COOKIE, requireToken, tokenMatches } from "./auth";
import { isRemoteRequest, RemoteRejection, remoteScope, remoteTaskInput } from "./remote";
import { HubError, type Hub } from "./core/hub";
import { HostError, type Hosts } from "./tools/hosts";
import { TaskListProjection } from "./core/task-list";
import { DocumentError, DOCUMENT_BODY_BYTES, safeDocumentError, type Documents } from "./core/documents";

const RECOVER_ACTIONS: RecoverAction[] = ["continue", "restart", "end"];

const isDocumentPath = (path: string) => path === "/api/documents" || path.startsWith("/api/documents/");

/** Count actual bytes even when Content-Length is missing or incorrect. Never log parse errors. */
async function documentBody(request: Request): Promise<unknown> {
  const [media, ...parameters] = (request.headers.get("content-type") ?? "").split(";");
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (media?.trim().toLowerCase() !== "application/json" ||
    parameters.some((part) => !/^\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(part)) ||
    (encoding !== undefined && encoding !== "identity")) throw new DocumentError("unsupported_media_type");
  const reader = request.body?.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > DOCUMENT_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new DocumentError("payload_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("malformed_json");
  } finally { reader?.releaseLock(); }
}

/** The HTTP API (commands) + the SSE stream (changes). Static files are mounted by main.ts. */
export function createApp(hub: Hub, token: string, hosts?: Hosts, agentKey?: { keyPath: string; publicKey: string }, deployer?: Deployer, options: { google?: GoogleAccount; antigravity?: AntigravityLogin; claudeLogin?: ClaudeLogin; documents?: Documents; remoteToken?: string | null } = {}): Hono {
  const remoteToken = options.remoteToken ?? null;
  const app = new Hono();

  const google = options.google;

  app.onError((err, c) => {
    // SQL/Drizzle errors may include private text in query parameters. Do not pass them to logs.
    if (isDocumentPath(c.req.path) || err instanceof DocumentError) {
      const failure = safeDocumentError(err);
      c.header("Cache-Control", "no-store");
      if (failure.code === "storage_busy") c.header("Retry-After", "1");
      return c.json({ error: failure.message, code: failure.code,
        ...(failure.currentRevisionId ? { currentRevisionId: failure.currentRevisionId } : {}) }, failure.status);
    }
    if (err instanceof HubError || err instanceof IssueCommentError) return c.json({ error: err.message }, err.status);
    if (err instanceof HostError) return c.json({ error: err.message }, 400);
    if (err instanceof GoogleError) return c.json({ error: err.message, code: err.code }, err.code === "wrong_mode" ? 409 : 400);
    if (err instanceof AntigravityError) return c.json({ error: err.code, code: err.code }, err.status);
    if (c.req.path === "/api/antigravity" || c.req.path.startsWith("/api/antigravity/")) {
      return c.json({ error: "antigravity-unavailable", code: "antigravity-unavailable" }, 503);
    }
    if (c.req.path.startsWith("/api/terminal-login/claude")) return c.json({ error: "claude-login-unavailable", code: "claude-login-unavailable" }, 503);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.post("/api/auth", async (c) => {
    const body = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
    if (!tokenMatches(token, body.token)) return c.json({ error: "wrong token" }, 401);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 60 * 60 * 24 * 365 });
    return c.json({ ok: true });
  });

  // SameSite=Strict cookies are absent on Google's redirect. Single-use state is the authority.
  app.get("/api/google/callback", async (c) => {
    if (!google || google.status().mode !== "callback") return c.notFound();
    let result = "failed";
    try {
      await google.complete({ code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error") });
      result = "connected";
    } catch (err) {
      if (err instanceof GoogleError && ["denied", "expired_state"].includes(err.code)) result = err.code;
    }
    return c.redirect(`/?google=${result}`, 302);
  });

  for (const route of ["/api/documents", "/api/documents/*"])
    app.use(route, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/*", requireToken(token, remoteToken));
  app.use("/api/*", remoteScope(remoteToken));
  const documents = () => {
    if (!options.documents) throw new DocumentError("documents_unavailable");
    return options.documents;
  };
  app.post("/api/documents", async (c) => {
    const service = documents();
    const document = service.create(await documentBody(c.req.raw));
    c.header("Location", `/api/documents/${document.id}`);
    return c.json(document, 201);
  });
  app.get("/api/documents", (c) => c.json(documents().list({ limit: c.req.query("limit"), offset: c.req.query("offset") })));
  app.get("/api/documents/:id", (c) => c.json(documents().get(c.req.param("id"))));
  app.put("/api/documents/:id", async (c) => {
    const service = documents();
    return c.json(service.update(c.req.param("id"), await documentBody(c.req.raw)));
  });
  app.get("/api/documents/:id/revisions", (c) => c.json(documents().listRevisions(c.req.param("id"), {
    limit: c.req.query("limit"), beforeRevisionNumber: c.req.query("beforeRevisionNumber"),
  })));
  app.get("/api/documents/:id/revisions/:revisionId", (c) => c.json(documents().getRevision(c.req.param("id"), c.req.param("revisionId"))));
  app.post("/api/documents/:id/revisions/:revisionId/restore", async (c) => {
    const service = documents();
    return c.json(service.restore(c.req.param("id"), c.req.param("revisionId"), await documentBody(c.req.raw)));
  });
  app.post("/api/documents/:id/suggestions", async (c) => {
    const service = documents();
    const result = service.importSuggestion(c.req.param("id"), await documentBody(c.req.raw));
    c.header("Location", `/api/documents/${result.suggestion.documentId}/suggestions/${result.suggestion.id}`);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.get("/api/documents/:id/suggestions", (c) => c.json(documents().listSuggestions(c.req.param("id"), {
    limit: c.req.query("limit"), offset: c.req.query("offset"), status: c.req.query("status"), importRequestId: c.req.query("importRequestId"),
  })));
  app.get("/api/documents/:id/suggestions/:suggestionId", (c) => c.json(documents().getSuggestion(c.req.param("id"), c.req.param("suggestionId"))));
  app.post("/api/documents/:id/suggestions/:suggestionId/accept", async (c) => {
    const service = documents();
    return c.json(service.acceptSuggestion(c.req.param("id"), c.req.param("suggestionId"), await documentBody(c.req.raw)));
  });
  app.post("/api/documents/:id/suggestions/:suggestionId/reject", async (c) => {
    const service = documents();
    return c.json(service.rejectSuggestion(c.req.param("id"), c.req.param("suggestionId"), await documentBody(c.req.raw)));
  });
  app.use("/api/antigravity/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/antigravity", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  const antigravity = () => {
    if (!options.antigravity) throw new AntigravityError("docker-unavailable", 503);
    return options.antigravity;
  };
  app.get("/api/antigravity", async c => c.json(await antigravity().status()));
  app.get("/api/antigravity/login", async c => c.json(await antigravity().session()));
  app.post("/api/antigravity/login/start", async c => c.json(await antigravity().start()));
  app.post("/api/antigravity/login/cancel", async c => c.json(await antigravity().cancel()));
  app.post("/api/antigravity/logout", async c => c.json(await antigravity().logout()));
  app.post("/api/antigravity/login/input", async c => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 4096) throw new AntigravityError("invalid-input", 400);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new AntigravityError("invalid-input", 400); }
    antigravity().input(input);
    return c.json({ ok: true });
  });
  app.use("/api/terminal-login/claude/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/terminal-login/claude", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  const claudeLogin = () => {
    if (!options.claudeLogin) throw new AntigravityError("docker-unavailable", 503);
    return options.claudeLogin;
  };
  app.get("/api/terminal-login/claude", async c => c.json(await claudeLogin().status(c.req.query("refresh") === "1")));
  app.get("/api/terminal-login/claude/login", async c => c.json(await claudeLogin().session()));
  app.post("/api/terminal-login/claude/login/start", async c => c.json(await claudeLogin().start()));
  app.post("/api/terminal-login/claude/login/cancel", async c => c.json(await claudeLogin().cancel()));
  app.post("/api/terminal-login/claude/logout", async c => c.json(await claudeLogin().logout()));
  app.post("/api/terminal-login/claude/login/input", async c => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 4096) throw new AntigravityError("invalid-input", 400);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new AntigravityError("invalid-input", 400); }
    claudeLogin().input(input);
    return c.json({ ok: true });
  });
  const unavailableGoogle = { storageError: false, configured: false, mode: null, configError: "Create google/client.json to configure Google.", account: null };
  app.use("/api/google", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/api/google", (c) => c.json(google?.status() ?? unavailableGoogle));
  app.post("/api/google/connect", async (c) => {
    if (!google) throw new GoogleError("not_configured", "connect Google Drive from the sidebar first");
    const body = await c.req.json<{ capability?: unknown }>().catch(() => ({} as { capability?: unknown }));
    return c.json(google.startConnect(body.capability));
  });
  app.post("/api/google/complete", async (c) => {
    if (!google) throw new GoogleError("not_configured", "connect Google Drive from the sidebar first");
    const body = await c.req.json<{ url?: unknown }>().catch(() => ({} as { url?: unknown }));
    return c.json(await google.completeFromPastedUrl(body.url));
  });
  app.delete("/api/google", async (c) => c.json(google ? await google.disconnect() : unavailableGoogle));


  app.use("/api/*", async (c, next) => {
    const gated = c.req.method === "POST" && (c.req.path === "/api/rooms" || /^\/api\/tasks(?:\/[^/]+\/(?:messages|room\/exchange|video-analysis|answer|recover|continue-now|stop-waiting|switch-agent|briefing|explanations|pr(?:\/draft)?))?$/.test(c.req.path));
    if (gated && deployer) {
      // Re-read the persisted request after a restart while the deploy unit may still be activating.
      if (await deployer.refreshDeploying()) throw new HubError(409, "Deploying; the Hub will restart shortly");
    }
    await next();
  });
  app.get("/api/deploy", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(deployer ? await deployer.status() : { enabled: false, disabledReason: "not_enabled", current: null, target: null, pending: [], dirty: false, last: null, history: null, deploying: false });
  });
  app.post("/api/deploy", async (c) => {
    if (!deployer) throw new HubError(409, "Deploy disabled: not_enabled");
    const body = await c.req.json<{ sha?: unknown }>().catch(() => null);
    return c.json(await deployer.start(body?.sha, hub.listTasks()));
  });

  app.post("/api/rooms", async (c) => c.json(await hub.createRoom(await c.req.json<RoomCreateInput>()), 201));
  app.get("/api/rooms", (c) => c.json({ room: hub.newestRoom(c.req.query("documentId") ?? "") }));
  app.post("/api/tasks/:id/room/exchange", (c) => {
    hub.exchangeRoom(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.put("/api/tasks/:id/room/brief", async (c) => {
    const { brief } = await c.req.json<{ brief: string }>();
    return c.json(hub.updateRoomBrief(c.req.param("id"), brief));
  });
  app.get("/api/task-list", async (c) => c.json(await new TaskListProjection(hub).list()));
  app.get("/api/tasks", (c) => c.json(hub.listTasks()));
  app.get("/api/quota", async (c) => { c.header("Cache-Control", "no-store"); return c.json(await hub.quota()); });
  app.post("/api/quota/refresh", async (c) => { c.header("Cache-Control", "no-store"); return c.json(await hub.quota(true)); });
  app.get("/api/models", async (c) => c.json(await hub.models()));
  app.get("/api/repo-settings", async (c) => c.json(await hub.repoSettings(c.req.query("path") ?? "")));
  app.get("/api/tasks/:id", (c) => c.json(hub.getTask(c.req.param("id"))));
  app.get("/api/tasks/:id/events", (c) => c.json(hub.events(c.req.param("id"))));
  app.get("/api/tasks/:id/usage", (c) => c.json(hub.usageSummary(c.req.param("id"))));
  app.get("/api/tasks/:id/usage/calls", (c) => {
    const parse = (value: string | undefined, fallback: number, max: number, min: number) => {
      if (value === undefined) return fallback;
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HubError(400, "Invalid usage pagination");
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < min || n > max) throw new HubError(400, "Invalid usage pagination");
      return n;
    };
    return c.json(hub.usageCalls(c.req.param("id"), parse(c.req.query("after"), 0, Number.MAX_SAFE_INTEGER, 0), parse(c.req.query("limit"), 20, 100, 1)));
  });

  app.post("/api/tasks", async (c) => {
    let input = await c.req.json<NewTaskInput>();
    if (isRemoteRequest(remoteToken, c.req.header("authorization"))) {
      try { input = await remoteTaskInput(input, async (repo) => !!(await hub.repoSettings(repo))); }
      catch (err) { if (err instanceof RemoteRejection) return c.json({ error: err.message }, 403); throw err; }
    }
    return c.json(await hub.createTask(input), 201);
  });

  app.post("/api/tasks/:id/switch-agent", async (c) => {
    const input = await c.req.json().catch(() => null);
    return c.json(await hub.switchAgent(c.req.param("id"), input));
  });

  app.post("/api/tasks/:id/pin", async (c) => {
    const input: unknown = await c.req.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !("pinned" in input) || typeof input.pinned !== "boolean") {
      throw new HubError(400, "Expected { pinned: boolean }");
    }
    return c.json(hub.setPinned(c.req.param("id"), input.pinned));
  });

  app.post("/api/tasks/:id/findings/retry", async (c) => { await hub.retryFindingExport(c.req.param("id")); return c.json({ ok: true }); });
  app.get("/api/tasks/:id/diff", async (c) => c.json(await hub.diff(c.req.param("id"))));
  app.get("/api/tasks/:id/diff/file", async (c) => {
    const file = c.req.query("path");
    if (!file) throw new HubError(400, "path is required");
    return c.json(await hub.diffFile(c.req.param("id"), file));
  });

  app.get("/api/tasks/:id/briefing", async (c) => c.json(await hub.briefing(c.req.param("id"))));
  app.post("/api/tasks/:id/briefing", async (c) => {
    const input = await c.req.json<{ rewrite?: boolean }>();
    await hub.generateBriefing(c.req.param("id"), input.rewrite === true);
    return c.json(await hub.briefing(c.req.param("id")));
  });
  for (const action of ["edit", "confirm", "reconcile"] as const) {
    app.post(`/api/tasks/:id/issue-comment/${action}`, async (c) => {
      const input: unknown = await c.req.json().catch(() => { throw new IssueCommentError(400, "Invalid JSON"); });
      const id = c.req.param("id");
      return c.json(action === "edit" ? hub.issueComments.edit(id, input) : await hub.issueComments.confirm(id, input, action === "reconcile"));
    });
  }
  app.post("/api/tasks/:id/pr-draft/edit", async (c) => c.json(await hub.editPrDraft(c.req.param("id"), await c.req.json())));
  app.get("/api/tasks/:id/explanations", async (c) => c.json(await hub.explanations(c.req.param("id"))));
  app.post("/api/tasks/:id/explanations", (c) => {
    hub.regenerateExplanations(c.req.param("id"));
    return c.json({ ok: true }, 202);
  });

  app.post("/api/tasks/:id/video-analysis", async (c) => {
    const input = await c.req.json().catch(() => { throw new HubError(400, "Invalid analysis request JSON"); });
    if (!input || Object.keys(input).length !== 1 || typeof input.kind !== "string") throw new HubError(400, "Expected an analysis kind");
    hub.analyzeVideo(c.req.param("id"), input.kind);
    return c.json({ ok: true }, 202);
  });

  // The video task's transcript, as plain text the browser can show or save.
  app.get("/api/tasks/:id/transcript", (c) => {
    const p = hub.transcriptPath(hub.getTask(c.req.param("id")));
    if (!p) throw new HubError(404, "no transcript for this task (yet)");
    return c.body(fs.readFileSync(p, "utf8"), 200, { "content-type": "text/markdown; charset=utf-8" });
  });

  app.delete("/api/tasks/:id", async (c) => {
    await hub.deleteTask(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/pr/draft", async (c) => c.json(await hub.preparePrDraft(c.req.param("id"))));
  app.post("/api/tasks/:id/pr/update", async (c) => {
    const input = await c.req.json().catch(() => { throw new HubError(400, "Expected an explicit PR update confirmation"); });
    if (input?.confirmed !== true) throw new HubError(400, "Explicit confirmation is required");
    return c.json(hub.updatePr(c.req.param("id"), input.revision), 202);
  });
  app.post("/api/tasks/:id/pr/abandon-update", async (c) => {
    const input = await c.req.json().catch(() => { throw new HubError(400, "Expected an explicit abandonment confirmation"); });
    if (input?.confirmed !== true) throw new HubError(400, "Explicit confirmation is required");
    return c.json(hub.abandonPrUpdate(c.req.param("id")), 202);
  });
  app.post("/api/tasks/:id/pr", async (c) => c.json(await hub.openPr(c.req.param("id"), await c.req.json().catch(() => undefined))));

  app.post("/api/tasks/:id/merge", async (c) => {
    await hub.merge(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/discard", async (c) => {
    await hub.discard(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/messages", async (c) => {
    const { text, images, replyTo, selection } = await c.req.json<RoomMessageInput & { images?: ImageUpload[] }>();
    if (replyTo !== undefined || selection !== undefined) hub.sendMessage(c.req.param("id"), String(text ?? ""), images, { replyTo, selection });
    else hub.sendMessage(c.req.param("id"), String(text ?? ""), images);
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:id/attachments/:file", (c) => {
    const p = hub.attachment(c.req.param("id"), c.req.param("file"));
    if (!p) throw new HubError(404, "no such attachment");
    const ext = p.split(".").pop()!;
    const type = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] ?? "application/octet-stream";
    return c.body(fs.readFileSync(p), 200, { "content-type": type, "cache-control": "private, max-age=31536000, immutable" });
  });

  app.post("/api/tasks/:id/stop", (c) => {
    hub.stop(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/answer", async (c) => {
    const { eventId, answer } = await c.req.json<{ eventId: string; answer: string }>();
    if (answer !== "Allow" && answer !== "Deny") throw new HubError(400, "answer must be Allow or Deny");
    hub.answer(c.req.param("id"), String(eventId), answer);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/recover", async (c) => {
    const { action } = await c.req.json<{ action: RecoverAction }>();
    if (!RECOVER_ACTIONS.includes(action)) throw new HubError(400, `action must be one of ${RECOVER_ACTIONS.join(", ")}`);
    hub.recover(c.req.param("id"), action);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/continue-now", (c) => { hub.continueNow(c.req.param("id")); return c.json({ ok: true }); });
  app.post("/api/tasks/:id/stop-waiting", (c) => { hub.stopWaiting(c.req.param("id")); return c.json({ ok: true }); });

  // --- devices (design.md §7.3) ---
  if (hosts) {
    app.get("/api/hosts", (c) => c.json(hosts.list()));
    // The public half of Agent Hub's key, for the setup steps on the Devices page. Public by nature.
    app.get("/api/ssh/public-key", (c) => c.json(agentKey ?? null));
    app.put("/api/hosts/:name", async (c) => c.json(hosts.upsert(c.req.param("name"), await c.req.json())));
    app.delete("/api/hosts/:name", (c) => {
      hosts.remove(c.req.param("name"));
      return c.json({ ok: true });
    });
    app.get("/api/hosts/:name/log", (c) => c.json(hosts.log(c.req.param("name"))));
    // Through the same exec path as an agent's ssh_exec, so it is logged like one.
    app.post("/api/hosts/:name/test", async (c) => {
      // Runs the same in sh and in PowerShell, so a Windows device does not "fail" its own test.
      const { result, text } = await hosts.exec(c.req.param("name"), "whoami; hostname", { timeoutS: 20 });
      return c.json({ ok: result.exitCode === 0, output: text });
    });
  }

  // One stream for everything. A client applies each message as an upsert, and on (re)connect it
  // re-reads what it shows, so nothing missed while disconnected can leave it stale.
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: StreamMessage[] = [{ type: "hello" }];
      let wake: (() => void) | null = null;
      const projection = new TaskListProjection(hub);
      const deleted = new Set<string>();
      // Establish fingerprints once, so the first activity-only update is also ignored.
      let updates = projection.list().then(() => undefined).catch((err) => console.error("task-list projection failed", err));
      const unsubscribe = hub.subscribe((m) => {
        if (m.type === "task_deleted") deleted.add(m.taskId);
        queue.push(m);
        wake?.();
        if (m.type !== "task" && m.type !== "task_deleted" && !(m.type === "event" && m.event.type === "ask")) return;
        updates = updates.then(async () => {
          const taskId = m.type === "task" ? m.task.id : m.type === "event" ? m.event.taskId : null;
          if (taskId && deleted.has(taskId)) return;
          const summary = await projection.update(m);
          if (summary && !deleted.has(summary.taskId) && !stream.aborted) {
            queue.push({ type: "task_summary", summary });
            wake?.();
          }
        }).catch((err) => console.error("task-list projection failed", err));
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      const heartbeat = setInterval(() => {
        queue.push({ type: "hello" });
        wake?.();
      }, 25_000);
      try {
        while (!stream.aborted) {
          const m = queue.shift();
          if (m) await stream.writeSSE({ data: JSON.stringify(m) });
          else await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }),
  );

  return app;
}
