import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { runSignal } from "../src/agents/codex";

it("forwards the caller's abort while a run is active", () => {
  const parent = new AbortController();
  const run = runSignal(parent.signal);
  parent.abort();
  expect(run.signal.aborted).toBe(true);
});

it("starts aborted when the caller already aborted", () => {
  const parent = new AbortController();
  parent.abort();
  expect(runSignal(parent.signal).signal.aborted).toBe(true);
});

it("does not reach a finished SDK child after release (the abort that crashed the server)", async () => {
  const parent = new AbortController();
  const run = runSignal(parent.signal);
  const child = spawn("sleep", ["5"], { signal: run.signal });
  // What the Codex SDK does when a turn ends: this also drops Node's abort cleanup for the child.
  child.removeAllListeners();
  run.release();
  parent.abort();
  expect(run.signal.aborted).toBe(false);
  expect(child.killed).toBe(false);
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
});
