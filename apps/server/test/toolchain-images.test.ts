import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureImage, imageTag } from "../src/docker/images";
import { ensureToolchainImage, toolchainSpec } from "../src/docker/toolchain";
import { imageTag as codexImageTag } from "../src/agents/codex-docker";

const docker = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => docker(...args) }));

beforeEach(() => { docker.mockReset(); });

describe("toolchain image tags", () => {
  it("sorts tools and changes the tag when a version or base image changes", () => {
    const first = toolchainSpec({ go: "1.26.5", python: "3.13" }, "codex:base");
    expect(first.buildArgs).toEqual({ CODEX_IMAGE: "codex:base", TOOLS: "go@1.26.5 python@3.13" });
    expect(imageTag(first)).toBe(imageTag(toolchainSpec({ python: "3.13", go: "1.26.5" }, "codex:base")));
    expect(imageTag(first)).not.toBe(imageTag(toolchainSpec({ go: "1.26.4", python: "3.13" }, "codex:base")));
    expect(imageTag(first)).not.toBe(imageTag(toolchainSpec({ go: "1.26.5", python: "3.13" }, "codex:new")));
  });

  it("ensures the current base before building the derived image and reuses it", async () => {
    const available = new Set<string>();
    docker.mockImplementation((_file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.at(-1) as (error: Error | null) => void;
      if (args[0] === "image") callback(available.has(args[2]!) ? null : new Error("missing"));
      else { available.add(args[2]!); callback(null); }
    });
    const activity = vi.fn();
    const first = await ensureToolchainImage({ go: "1.26.5" }, activity);
    expect(first.built).toBe(true);
    const builds = docker.mock.calls.filter((call) => call[1][0] === "build");
    expect(builds).toHaveLength(2);
    expect(builds[0]![1]).toContain(codexImageTag());
    expect(builds[1]![1]).toContain(`CODEX_IMAGE=${codexImageTag()}`);
    expect(builds[1]![1]).toContain("TOOLS=go@1.26.5");
    activity.mockClear();
    expect(await ensureToolchainImage({ go: "1.26.5" }, activity)).toEqual({ tag: first.tag, built: false });
    expect(activity).not.toHaveBeenCalled();
    expect(docker.mock.calls.filter((call) => call[1][0] === "build")).toHaveLength(2);
  });

  it("shares one build between concurrent callers and reports activity before it completes", async () => {
    const callbacks: ((error: Error | null) => void)[] = [];
    docker.mockImplementation((_file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.at(-1) as (error: Error | null) => void;
      if (args[0] === "image") callback(new Error("missing"));
      else callbacks.push(callback);
    });
    const activity = vi.fn();
    const spec = toolchainSpec({ go: "1.26.5" }, "codex:concurrent");
    const first = ensureImage(spec, activity);
    const second = ensureImage(spec, activity);
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(2));
    expect(callbacks).toHaveLength(1);
    callbacks[0]!(null);
    expect(await first).toEqual(await second);
  });

  it("propagates build failures and allows a subsequent retry", async () => {
    let fail = true;
    docker.mockImplementation((_file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.at(-1) as (error: Error | null) => void;
      callback(args[0] === "image" ? new Error("missing") : fail ? new Error("build failed") : null);
    });
    const spec = toolchainSpec({ go: "1.26.5" }, "codex:retry");
    await expect(ensureImage(spec)).rejects.toThrow("build failed");
    fail = false;
    expect((await ensureImage(spec)).built).toBe(true);
  });
});
