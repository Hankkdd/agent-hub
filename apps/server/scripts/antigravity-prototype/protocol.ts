// Only a small, explicit subset of the documented stream is accepted. Provider strings never escape.
export class PrototypeError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrototypeError("MALFORMED_PROTOCOL");
  return value as Record<string, unknown>;
}
export function verifySyntheticAnswer(value: unknown) {
  if (typeof value !== "string") throw new PrototypeError("MALFORMED_RESPONSE");
  let response: Record<string, unknown>;
  try { response = object(JSON.parse(value)); } catch { throw new PrototypeError("MALFORMED_RESPONSE"); }
  const hunks = response.hunks;
  if (Object.keys(response).length !== 1 || !Array.isArray(hunks) || hunks.length !== 1) throw new PrototypeError("MALFORMED_RESPONSE");
  const hunk = object(hunks[0]);
  if (Object.keys(hunk).sort().join(",") !== "explanation,id" || hunk.id !== "synthetic-1" ||
      typeof hunk.explanation !== "string" || hunk.explanation.length > 1000 || !/[\u3400-\u9fff]/u.test(hunk.explanation)) throw new PrototypeError("MALFORMED_RESPONSE");
  return { structuredHunks: 1 as const };
}
export function verifyProtocol(stdout: string, stderr = "") {
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024) throw new PrototypeError("OUTPUT_LIMIT");
  // Diagnostics can include soft-denied actions even on successful runs. Never print them.
  if (stderr.trim()) throw new PrototypeError("PROVIDER_DIAGNOSTIC");
  let initialized = false;
  let conversationId: string | undefined;
  let completed = false;
  let steps = 0;
  for (const line of stdout.split("\n").filter(line => line.trim())) {
    let event: Record<string, unknown>;
    try { event = parseStreamEvent(line); } catch { throw new PrototypeError("MALFORMED_PROTOCOL"); }
    if (Object.keys(event).some(key => !["event", "conversation_id", "init", "step_update", "result"].includes(key))) throw new PrototypeError("UNSUPPORTED_PROTOCOL");
    if (completed) throw new PrototypeError("AFTER_RESULT");
    if (event.event === "init") {
      const init = object(event.init);
      if (initialized || typeof event.conversation_id !== "string" || !event.conversation_id ||
          init.agent !== "hub-prototype" || init.cwd !== "/work" || !Array.isArray(init.tools)) {
        throw new PrototypeError("UNVERIFIED_CAPABILITIES");
      }
      if (init.tools.length) throw new PrototypeError("INHERITED_TOOLS");
      if (Object.keys(init).some(key => /mcp|hook|plugin|skill|warning|error/i.test(key))) throw new PrototypeError("UNVERIFIED_CAPABILITIES");
      conversationId = event.conversation_id as string;
      initialized = true;
    } else if (event.event === "step_update" && initialized) {
      const step = object(event.step_update);
      if (!["user_input", "agent_response", "checkpoint"].includes(String(step.step_type)) ||
          Object.keys(step).some(key => /tool|subagent|warning|error|permission/i.test(key))) throw new PrototypeError("TOOL_OR_UNKNOWN_ACTIVITY");
      if (!["ACTIVE", "DONE"].includes(String(step.state))) throw new PrototypeError("MALFORMED_PROTOCOL");
      // Deltas can repeat or disagree with final text. They are evidence of transport only.
      steps++;
    } else if (event.event === "result" && initialized) {
      const result = object(event.result);
      if (result.conversation_id !== conversationId) throw new PrototypeError("CONVERSATION_MISMATCH");
      if (Object.keys(result).some(key => /tool|subagent|warning|permission/i.test(key))) throw new PrototypeError("TOOL_OR_UNKNOWN_ACTIVITY");
      if (result.status !== "SUCCESS" || result.error !== undefined) throw new PrototypeError("PROVIDER_FAILURE");
      verifySyntheticAnswer(result.response);
      completed = true;
    } else throw new PrototypeError("UNSUPPORTED_PROTOCOL");
  }
  if (!completed) throw new PrototypeError("INCOMPLETE_RESULT");
  return { advertisedTools: 0, observedToolEvents: 0, steps, terminal: "SUCCESS", structuredHunks: 1,
    strictIsolation: "UNVERIFIED" as const };
}
export const SYNTHETIC_PROMPT = 'Explain only this synthetic committed hunk in Traditional Chinese (Taiwan). Return exactly JSON {"hunks":[{"id":"synthetic-1","explanation":"..."}]}. No tools or external context. Hunk synthetic-1: @@ -1 +1 @@\n-const retries = 1;\n+const retries = 2;';

/** Shared NDJSON decoder; the prototype keeps its stricter synthetic-answer policy above. */
export function parseStreamEvent(line: string): Record<string, unknown> {
  try { return object(JSON.parse(line)); } catch { throw new Error("Malformed Gemini stream-json event"); }
}
