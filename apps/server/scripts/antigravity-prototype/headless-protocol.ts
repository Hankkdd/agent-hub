import { verifySyntheticAnswer } from "./protocol";

export const LOGIN_PATTERN = /(?:log[ -]?in|sign[ -]?in|authenticat(?:ion|e))\s+(?:is\s+)?(?:required|needed)|please\s+(?:log[ -]?in|sign[ -]?in)|accounts\.google\.com\/(?:o\/oauth2|device)|(?:log[ -]?in|sign[ -]?in)\s+with|agy\s+(?:auth|login)|select.{0,30}(?:login|sign.in)/i;
export const STREAM_CHECKS = ["NO_INIT_EVENT", "NO_RESULT_EVENT", "RESULT_NOT_SUCCESS", "UNEXPECTED_EVENT",
  "MALFORMED_JSON", "INVALID_INIT_EVENT", "MALFORMED_RESULT", "CONVERSATION_MISMATCH", "AFTER_RESULT", "OUTPUT_LIMIT"] as const;
type Check = typeof STREAM_CHECKS[number];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Authentication/completion evidence is independent of answer shape and optional tool metadata.
// Provider text and identifiers remain local to this function and never enter its return value.
export function inspectHeadlessProtocol(stdout: string, stderr = "") {
  let failure: Check | undefined;
  let initialized = false, resultSeen = false, completed = false;
  let conversation: string | undefined;
  let advertisedTools: number | null = null;
  let observedToolEvents = 0, steps = 0;
  let answerShape: "MATCH" | "MISMATCH" = "MISMATCH";
  const fail = (check: Check) => { failure ??= check; };
  const outputLimited = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024;
  if (outputLimited) fail("OUTPUT_LIMIT");
  else for (const line of stdout.split("\n").filter(line => line.trim())) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { fail("MALFORMED_JSON"); continue; }
    if (!record(event) || typeof event.event !== "string") { fail("MALFORMED_JSON"); continue; }
    if (resultSeen) fail("AFTER_RESULT");
    if (/tool|subagent/i.test(event.event)) observedToolEvents++;
    if (event.event === "init") {
      if (initialized || !record(event.init)) { fail("INVALID_INIT_EVENT"); continue; }
      initialized = true;
      conversation = typeof event.conversation_id === "string" ? event.conversation_id : undefined;
      if (Array.isArray(event.init.tools)) advertisedTools = event.init.tools.length;
    } else if (event.event === "step_update") {
      if (!initialized) fail("NO_INIT_EVENT");
      steps++;
      if (!record(event.step_update)) { fail("UNEXPECTED_EVENT"); continue; }
      const step = event.step_update;
      if (/tool|subagent/i.test(String(step.step_type)) || Object.entries(step).some(([key, value]) => /tool|subagent/i.test(key) && value != null)) observedToolEvents++;
    } else if (event.event === "result") {
      if (!initialized) fail("NO_INIT_EVENT");
      resultSeen = true;
      if (!record(event.result)) { fail("MALFORMED_RESULT"); continue; }
      const result = event.result;
      if (conversation && typeof result.conversation_id === "string" && conversation !== result.conversation_id) {
        fail("CONVERSATION_MISMATCH");
        continue;
      }
      if (result.status !== "SUCCESS" || result.error != null) { fail("RESULT_NOT_SUCCESS"); continue; }
      completed = true;
      try { verifySyntheticAnswer(result.response); answerShape = "MATCH"; } catch { /* Shape mismatch is evidence, not an authentication failure. */ }
    } else fail("UNEXPECTED_EVENT");
  }
  if (!initialized) fail("NO_INIT_EVENT");
  if (!resultSeen) fail("NO_RESULT_EVENT");
  const loginRequested = LOGIN_PATTERN.test(`${stdout}\n${stderr}`);
  const auth = !loginRequested && (completed || /silent auth succeeded/i.test(`${stdout}\n${stderr}`)) ? "PASS" as const : "FAIL" as const;
  return { auth, completed, protocol: failure ? "FAIL" as const : "PASS" as const, answerShape,
    reasonCode: failure ?? "NONE", advertisedTools, observedToolEvents, steps,
    terminal: completed ? "SUCCESS" as const : null, structuredHunks: answerShape === "MATCH" ? 1 as const : null,
    strictIsolation: "UNVERIFIED" as const, loginRequested };
}
