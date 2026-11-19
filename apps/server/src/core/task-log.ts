import type { Task, TaskEvent } from "@agent-hub/shared";
import { redactSecrets } from "./redact";

const marker = "\n[truncated]";
export function capLog(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - marker.length) + marker : text;
}
const last = (text: string, limit: number) => text.length > limit ? `[truncated]\n${text.slice(-(limit - marker.length))}` : text;

/** Share the event representation between reading and searching. Redact before taking previews. */
export function taskLogEvent(event: TaskEvent, includeOutputs: boolean, token: string | null): string {
  const clean = (text: string) => redactSecrets(text, token);
  const output = (text: string) => `\nOutput:\n${last(clean(text), 4_000)}`;
  let body: string;
  switch (event.type) {
    case "user_message": body = `User: ${clean(event.text)}`; break;
    case "agent_text": body = `Agent: ${clean(event.text)}`; break;
    case "tool_call":
      body = `Tool ${clean(event.name)}: ${capLog(clean(event.input).replace(/[\r\n]+/g, " "), 300)}`;
      if (includeOutputs && event.output !== undefined) body += output(event.output);
      break;
    case "review_result": body = `Review round ${event.round}: ${event.verdict}\n${clean(JSON.stringify(event.findings))}`; break;
    case "test_result":
      body = `Test round ${event.round}: ${clean(event.command)}; exit code: ${event.exitCode}`;
      if (includeOutputs) body += output(event.output);
      break;
    case "status_change": body = `Status: ${event.from} -> ${event.to}${event.reason ? ` (${clean(event.reason)})` : ""}`; break;
    case "pr_opened": body = `PR #${event.number}: ${clean(event.url)}`; break;
    case "turn_result": body = `Turn: ${event.ok ? "success" : "failed"}${event.error ? `; ${clean(event.error)}` : ""}`; break;
    default: body = event.type;
  }
  return `[seq ${event.seq}] ${body}`;
}

export function readTaskLog(task: Task, events: TaskEvent[], input: { tail?: number; afterSeq?: number; includeOutputs?: boolean }, token: string | null): string {
  const tail = input.tail ?? 100;
  const shown = input.afterSeq === undefined ? events.slice(-tail) : events.filter((e) => e.seq > input.afterSeq!).slice(0, tail);
  const first = shown[0]?.seq;
  const end = shown.at(-1)?.seq;
  const header = `${redactSecrets(task.title, token)} | status: ${task.status} | workflow: ${task.workflow}\nEvents: ${events.length}; shown: ${shown.length ? `${first}-${end}` : "none"}\n` +
    `Page forward: afterSeq=${end ?? input.afterSeq ?? 0}, tail=${tail}. Page back: afterSeq=${Math.max(0, (first ?? 1) - tail - 1)}, tail=${tail}; or omit afterSeq and increase tail (max 300).\n`;
  return capLog(redactSecrets(header + shown.map((e) => taskLogEvent(e, input.includeOutputs ?? false, token)).join("\n"), token), 32_000);
}

export function readTaskTestOutput(events: TaskEvent[], round: number | undefined, token: string | null): string {
  const test = events.filter((e) => e.type === "test_result" && (round === undefined || e.round === round)).at(-1);
  if (test?.type !== "test_result") return round === undefined ? "No test result recorded for this task." : `No test result recorded for round ${round}.`;
  return redactSecrets(`Test round ${test.round}\nCommand: ${redactSecrets(test.command, token)}\nExit code: ${test.exitCode}\nOutput:\n${last(redactSecrets(test.output, token), 16_000)}`, token);
}

export function searchTaskLog(events: TaskEvent[], pattern: string, token: string | null): string {
  let matches: (line: string) => boolean;
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    let regex: RegExp;
    try { regex = new RegExp(pattern.slice(1, -1), "i"); }
    catch { throw new Error("Invalid regular expression"); }
    matches = (line) => regex.test(line);
  } else {
    matches = (line) => line.toLowerCase().includes(pattern.toLowerCase());
  }
  const found: string[] = [];
  for (const event of events) {
    for (const line of taskLogEvent(event, true, token).split("\n")) {
      if (!matches(line)) continue;
      if (found.length === 100) return redactSecrets(found.join("\n"), token);
      found.push(`[seq ${event.seq}] ${line.replace(/^\[seq \d+\] /, "")}`);
    }
  }
  return redactSecrets(found.join("\n") || "No matching lines.", token);
}
