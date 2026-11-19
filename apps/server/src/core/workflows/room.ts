import { ROOM_EXCHANGE_TEXT, type RoomSelection, type Task, type TaskEvent } from "@agent-hub/shared";
import type { Documents } from "../documents";
import { ROOM_SYSTEM } from "../prompts";
import type { Outcome, WorkflowDeps } from "./types";

// Host reads use the existing durable tool-call envelope; no in-memory room cursor is needed.
function context(event: TaskEvent) {
  if (event.type !== "tool_call" || event.name !== "room_context" || !event.output) return undefined;
  return JSON.parse(event.input) as { through: number; userThrough: number; revisionId: string };
}

export async function roomWorkflow(deps: WorkflowDeps, documents: Documents, task: Task, message: Extract<TaskEvent, { type: "user_message" }>, ac: AbortController): Promise<Outcome> {
  const history = deps.events(task.id);
  const round = history.filter(e => e.type === "user_message" && e.seq < message.seq).length;
  const mentions = [...message.text.matchAll(/@(claude|gpt|codex)\b/gi)].map(m => m[1]!.toLowerCase() === "claude" ? "claude" : "codex");
  const order = round % 2 ? ["codex", "claude"] as const : ["claude", "codex"] as const;
  const results: Outcome[] = [];
  for (const member of order) {
    if (ac.signal.aborted) break;
    if (!message.exchange && mentions.length && !mentions.includes(member)) continue;
    const session = task.sessions.find(s => s.agent === member && s.role === "main")!;
    const events = deps.events(task.id);
    const previous = events.filter(e => e.sessionId === session.id && context(e)).at(-1);
    const seen = previous && context(previous);
    // Queued user inputs are excluded even when their sequence precedes a same-round reply.
    const visible = events.filter(e => e.type === "user_message" ? e.seq > (seen?.userThrough ?? 0) && !e.queued && e.seq <= message.seq : e.seq > (seen?.through ?? 0));
    if (message.exchange) {
      const latest = events.filter(e => e.type === "agent_text" && e.sessionId !== session.id).at(-1);
      if (latest && !visible.some(e => e.id === latest.id)) visible.unshift(latest);
    }
    const delta = visible.flatMap(e => {
      if (e.type === "user_message") {
        const quote = e.quote ? e.quote.author === "user"
          ? `[Quoting the user's message: "${e.quote.text}"]\n`
          : `[Quoting ${e.quote.author === "claude" ? "Claude" : "GPT"}'s reply: "${e.quote.text}"]\n` : "";
        return [`${quote}${e.text}`];
      }
      if (e.type !== "agent_text" || e.sessionId === session.id) return [];
      // Only the final text block of an invocation is conversation context.
      const nextResult = events.find(x => x.seq > e.seq && x.sessionId === e.sessionId && x.type === "turn_result");
      if (!nextResult || events.some(x => x.type === "agent_text" && x.sessionId === e.sessionId && x.seq > e.seq && x.seq < nextResult.seq)) return [];
      const author = task.sessions.find(s => s.id === e.sessionId)?.agent;
      return [`[${author === "claude" ? "Claude" : "GPT"}]: ${e.text}`];
    });
    const revision = documents.get(task.options.room!.documentId).currentRevision;
    const turnContext = [
      `Room brief: ${deps.getTask(task.id).options.room!.brief ?? ""}`,
      seen?.revisionId === revision.id ? `Document unchanged (revision ${revision.revisionNumber})`
        : `Document: ${revision.title}\nRevision ${revision.revisionNumber}\n${revision.content}`,
      message.selection ? selectionContext(message.selection) : "",
    ].filter(Boolean).join("\n\n");
    // User and conversation cursors advance independently when inputs arrive during a reply.
    const through = Math.max(message.seq, ...visible.filter(e => e.type === "agent_text").map(e => e.seq));
    const read = deps.append(task.id, session.id, { type: "tool_call", sideEffect: "none", name: "room_context", input: JSON.stringify({ through, userThrough: message.seq, revisionId: revision.id }) });
    try {
      const result = await deps.streamAgent(task, session, `[Room with the user, Claude and GPT]\n${message.exchange ? ROOM_EXCHANGE_TEXT + "\n" : ""}${delta.join("\n\n")}`, ac,
        { systemPrompt: ROOM_SYSTEM, turnContext, readOnly: true, roomSelection: message.selection });
      results.push(result);
      if (result.ok && !ac.signal.aborted) deps.patch(read.id, { output: `Read document revision ${revision.revisionNumber}` });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.append(task.id, session.id, { type: "turn_result", ok: false, error });
      results.push({ ok: false, error });
    }
  }
  return results.some(r => r.ok) ? { ok: true } : { ok: false, error: results.map(r => r.error).filter(Boolean).join("; "), limit: results.find(r => r.limit)?.limit };
}

function selectionContext(selection: RoomSelection): string {
  return `Frozen selection (base ${selection.baseRevisionId}, UTF-16 ${selection.startUtf16}:${selection.endUtf16}):\n${selection.originalText}\nCalling suggest_document_edit without originalText targets this frozen passage; stale selections are rejected.`;
}
