import fs from "node:fs";
import path from "node:path";
import type { AgentKind, Task } from "@agent-hub/shared";
import { fetchVideoTranscript, type StepReporter, type Transcript } from "../../media/video";
import { SYSTEM_APPEND, summaryPrompt } from "../prompts";
import type { Outcome, WorkflowDeps } from "./types";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
export const URL_RE = /https?:\/\/\S+/;
const TRANSCRIPT_POINTER = "The video's transcript is transcript.md in your working directory. Read it before answering.";

/**
 * First turn: fetch the transcript (each step shown as a tool line), then have the agent summarise it.
 * After that the task is an ordinary conversation about the video: the thread already holds it.
 */
export async function videoWorkflow(deps: WorkflowDeps, task: Task, prompt: string, ac: AbortController): Promise<Outcome> {
  const session = deps.session(task, "main");
  if (transcriptPath(task)) {
    // A transcript-only task has no summary turn, so the thread does not hold the video yet.
    const first = task.options.transcriptOnly && !session.sdkThreadId;
    const text = first ? `${TRANSCRIPT_POINTER}\n\n${prompt}` : prompt;
    return deps.streamAgent(task, session, text, ac, { systemPrompt: SYSTEM_APPEND });
  }

  const url = prompt.match(URL_RE)?.[0];
  if (!url) {
    const error = "no video URL in the message";
    deps.append(task.id, null, { type: "turn_result", ok: false, error });
    return { ok: false, error };
  }
  deps.setRunning(task.id, "Fetching the transcript");
  const open = new Set<string>();
  const reporter: StepReporter = {
    step: (name, input) => {
      const id = deps.append(task.id, session.id, { type: "tool_call", name, input, sideEffect: "none", pending: true }).id;
      open.add(id);
      return {
        progress: (text) => {
          deps.patch(id, { output: text });
          deps.setRunning(task.id, `Transcribing: ${text}`);
        },
        done: (output) => {
          open.delete(id);
          deps.patch(id, { output, pending: undefined });
        },
      };
    },
  };
  let t: Transcript;
  try {
    t = await fetchVideoTranscript(url, task.cwd!, path.join(deps.dataDir, "media-cache"), reporter, ac.signal, deps.video);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    for (const id of open) deps.patch(id, { output: ac.signal.aborted ? "stopped" : error, pending: undefined });
    if (ac.signal.aborted) return { ok: true };
    deps.append(task.id, null, { type: "turn_result", ok: false, error: `could not get a transcript: ${error}` });
    return { ok: false, error };
  }
  // A pasted link became the title; the video's own title says what the task is.
  if (/^https?:\/\//.test(task.title)) {
    deps.updateTitle(task.id, t.meta.title);
    deps.publishTask(task.id);
  }
  if (task.options.transcriptOnly) {
    deps.append(task.id, null, { type: "turn_result", ok: true });
    return { ok: true, activity: "Transcript ready" };
  }
  const extra = prompt.replace(url, "").trim();
  return deps.streamAgent(task, session, summaryPrompt(t, extra), ac, { systemPrompt: SYSTEM_APPEND, activity: `${AGENT_LABEL[session.agent]} summarizing` });
}

/** The video task's transcript file, once fetched. */
export function transcriptPath(task: Task): string | null {
  if (task.workflow !== "video" || !task.cwd) return null;
  const p = path.join(task.cwd, "transcript.md");
  return fs.existsSync(p) ? p : null;
}
