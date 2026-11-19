import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GeminiDockerTransport } from "../src/agents/gemini";

// Exercise both process boundaries without starting Docker or contacting a model.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.assign(execFile, {
    [promisify.custom]: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFile(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
    }),
  });
  return { execFile, spawn: vi.fn() };
});

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  vi.mocked(spawn).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "/tmp/fixture-docker.sock"])("uses the same Docker endpoint for the complete lifecycle with socket %s", async socket => {
  vi.stubEnv("DOCKER_HOST", "tcp://docker.example.invalid:2375");
  vi.stubEnv("DOCKER_CONTEXT", "other-fixture-context");
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const stdout = argv[2] === "info" ? "arm64" : argv[2] === "ps" ? "abcdef123456" : "";
    (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(null, stdout, "");
    return undefined as never;
  });
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => { child.stdout.write("fixture output"); child.emit("close", 0); });
    return child as unknown as ReturnType<typeof spawn>;
  });
  const runtime = new GeminiDockerTransport(socket);
  const signal = new AbortController().signal;
  expect(await runtime.available()).toBe(true);
  await runtime.prepare(signal);
  await runtime.createRun(["create", "--name", "fixture-container"], signal);
  const output = vi.fn();
  await runtime.run("fixture-container", signal, output);
  await runtime.remove("fixture-container");
  await runtime.cleanup("fixture-owner");

  const endpoint = ["--host", `unix://${socket ?? "/var/run/docker.sock"}`];
  expect(vi.mocked(execFile).mock.calls.map(call => (call[1] as string[])[2])).toEqual(["info", "image", "create", "rm", "ps", "rm"]);
  for (const call of vi.mocked(execFile).mock.calls) {
    expect(call[0]).toBe("docker");
    expect((call[1] as string[]).slice(0, 2)).toEqual(endpoint);
  }
  expect(spawn).toHaveBeenCalledExactlyOnceWith("docker", [...endpoint, "start", "--attach", "fixture-container"], expect.objectContaining({ signal }));
  expect(output).toHaveBeenCalledWith("stdout", "fixture output");
});
