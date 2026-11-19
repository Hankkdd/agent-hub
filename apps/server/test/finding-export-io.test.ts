import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { findingGit } from "../src/core/finding-export-io";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.restoreAllMocks());
async function delayedGit() {
  const { spawn: exec } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const children: ChildProcess[] = [];
  vi.mocked(spawn).mockImplementation(((file: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    expect(file).toBe("git");
    const child = exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    children.push(child); return child;
  }) as typeof spawn);
  return children;
}
it("times out a delayed Git child and waits for its exit", async () => {
  const children = await delayedGit();
  await expect(findingGit(process.cwd(), ["status"], { gitTimeoutMs: 30 })).rejects.toThrow(/timed out/);
  expect(children).toHaveLength(1); expect(children[0]!.signalCode).toBe("SIGKILL");
});
it("cancels a delayed Git child without waiting for its normal completion", async () => {
  const children = await delayedGit(); const ac = new AbortController();
  const pending = findingGit(process.cwd(), ["status"], { signal: ac.signal });
  ac.abort(); await expect(pending).rejects.toThrow(/cancelled/);
  expect(children[0]!.signalCode).toBe("SIGKILL");
});
it("an already cancelled operation does not spawn Git", async () => {
  const children = await delayedGit();
  await expect(findingGit(process.cwd(), ["status"], { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(children).toHaveLength(0);
});
