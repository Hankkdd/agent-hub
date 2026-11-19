import { expect, it } from "vitest";
import type { Task, TaskEvent, TaskEventPayload } from "@agent-hub/shared";
import { redactSecrets } from "../src/core/redact";
import { readTaskLog, readTaskTestOutput, searchTaskLog, taskLogEvent } from "../src/core/task-log";

const event = (seq: number, payload: TaskEventPayload): TaskEvent => ({ id: `event-${seq}`, taskId: "worker", sessionId: null, seq, createdAt: "2026-01-01", ...payload });
const task = { title: "Worker evidence", status: "idle", workflow: "review" } as Task;

it("defaults to the last 100 events and bounds forward pages", () => {
  const events = Array.from({ length: 350 }, (_, i) => event(i + 1, { type: "agent_text", text: `line ${i + 1}` }));
  const tail = readTaskLog(task, events, {}, null);
  expect(tail).toContain("Events: 350; shown: 251-350");
  expect(tail).not.toContain("[seq 250]");
  const page = readTaskLog(task, events, { afterSeq: 50, tail: 3 }, null);
  expect(page).toContain("shown: 51-53");
  expect(page).toContain("Page forward: afterSeq=53");
  expect(page).not.toContain("[seq 54]");
  expect(readTaskLog(task, events, { afterSeq: 350 }, null)).toContain("shown: none");
});

it("renders messages, review findings, status, PR and failed turns", () => {
  const events = [
    event(1, { type: "user_message", text: "request" }),
    event(2, { type: "review_result", round: 2, verdict: "changes", findings: [{ severity: "high", location: "fixture.ts:1", message: "Missing evidence" }] }),
    event(3, { type: "status_change", from: "running", to: "idle", reason: "Complete" }),
    event(4, { type: "pr_opened", number: 7, url: "https://example.invalid/pull/7" }),
    event(5, { type: "turn_result", ok: false, error: "Fixture error" }),
  ];
  const log = readTaskLog(task, events, {}, null);
  for (const text of ["User: request", "Review round 2: changes", "Missing evidence", "Status: running -> idle (Complete)", "PR #7: https://example.invalid/pull/7", "Turn: failed; Fixture error"]) expect(log).toContain(text);
});

it("redacts additional credential fields and URLs without changing ordinary URLs or text", () => {
  const keys = ["access_token", "refresh_token", "id_token", "client_secret"];
  for (const key of keys) {
    expect(redactSecrets(`{"${key}":"private-value"} ${key}=private-value`, null)).toBe(`{"${key}":"[redacted]"} ${key}=[redacted]`);
  }
  for (const key of ["code", "access_token", "refresh_token", "id_token", "token", "state", "%63ode"]) {
    expect(redactSecrets(`https://login.example.invalid/path?${key}=private-value&other=private-value#fragment`, null)).toBe("https://login.example.invalid[redacted]");
  }
  expect(redactSecrets("Cookie: session=private-value\nSet-Cookie: login=private-value; HttpOnly", null)).toBe("Cookie: [redacted]\nSet-Cookie: [redacted]");
  expect(redactSecrets("https://example.invalid/path?q=public\nordinary output", null)).toBe("https://example.invalid/path?q=public\nordinary output");
});

it("redacts before input previews, output tails and the total cap split credentials", () => {
  const secret = `ghp_${"a".repeat(500)}`;
  const events = [event(1, { type: "tool_call", name: "tool", input: `input ${secret}`, output: `${secret}${"x".repeat(3_900)}`, sideEffect: "none" }),
    event(2, { type: "test_result", round: 1, command: "fixture", exitCode: 0, output: `${secret}${"x".repeat(15_900)}` })];
  for (const text of [taskLogEvent(events[0]!, true, null), readTaskLog(task, events, { includeOutputs: true }, null), readTaskTestOutput(events, undefined, null), searchTaskLog(events, "/.*/", null)]) {
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("a".repeat(10));
  }
  const log = readTaskLog(task, [event(1, { type: "agent_text", text: `${"x".repeat(31_500)}${secret}` })], {}, null);
  expect(log).not.toContain("a".repeat(10));
  expect(log.length).toBeLessThanOrEqual(32_000);
});
