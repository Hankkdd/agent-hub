import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Capture docker's arguments without launching a container or contacting a model.
const wrapper = path.resolve(import.meta.dirname, "../bin/codex-docker");
let root: string;
let cwd: string;
let reference: string;
let capture: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-wrapper-"));
  cwd = path.join(root, "repo");
  reference = path.join(root, "reference repository");
  capture = path.join(root, "args.json");
  fs.mkdirSync(cwd);
  fs.mkdirSync(reference);
  fs.writeFileSync(path.join(root, "docker"), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.WRAPPER_CAPTURE, JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(sandbox: string, references?: string, cache?: string, extra: string[] = []) {
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, AGENT_HUB_CODEX_IMAGE: "test-image", AGENT_HUB_CODEX_HOME: path.join(root, "codex-home"), WRAPPER_CAPTURE: capture };
  delete (env as NodeJS.ProcessEnv).AGENT_HUB_CODEX_REFERENCE_DIRS;
  delete (env as NodeJS.ProcessEnv).AGENT_HUB_CODEX_CACHE;
  if (cache) (env as NodeJS.ProcessEnv).AGENT_HUB_CODEX_CACHE = cache;
  if (references !== undefined) (env as NodeJS.ProcessEnv).AGENT_HUB_CODEX_REFERENCE_DIRS = references;
  execFileSync("bash", [wrapper, "exec", "--cd", cwd, "--sandbox", sandbox, ...extra], { env });
  return JSON.parse(fs.readFileSync(capture, "utf8")) as string[];
}

describe("Codex reference mounts", () => {
  it("mounts planning references read-only at the same paths and keeps the checkout read-only", () => {
    const args = run("read-only", `${reference}:${reference}:${cwd}`);
    expect(args).toContain(`${cwd}:${cwd}:ro`);
    expect(args.filter((arg) => arg === `${reference}:${reference}:ro`)).toHaveLength(1);
    expect(args.filter((arg) => arg === `${cwd}:${cwd}:ro`)).toHaveLength(1);
    expect(args).toContain("danger-full-access");
  });

  it("does not mount references in ordinary author or reviewer turns", () => {
    expect(run("workspace-write")).toContain(`${cwd}:${cwd}:rw`);
    expect(run("read-only")).not.toContain(`${reference}:${reference}:ro`);
  });

  it("refuses reference mounts on a writable turn", () => {
    expect(() => run("workspace-write", reference)).toThrow();
    expect(fs.existsSync(capture)).toBe(false);
  });
});


it("persists pnpm and Go caches under the shared cache mount", () => {
  const cache = path.join(root, "cache");
  const args = run("workspace-write", undefined, cache);
  expect(args).toContain(`${cache}:/cache`);
  expect(args).toContain("npm_config_store_dir=/cache/pnpm-store");
  expect(args).toContain("GOMODCACHE=/cache/go-mod");
  expect(args).toContain("GOCACHE=/cache/go-build");
  for (const dir of ["pnpm-store", "go-mod", "go-build"]) expect(fs.statSync(path.join(cache, dir)).isDirectory()).toBe(true);
  expect(run("read-only", undefined, cache)).toContain("GOCACHE=/cache/go-build");
});

it("mounts the SDK output schema directory read-only, preserving the CLI argument", () => {
  const schema = path.join(reference, "schema.json");
  fs.writeFileSync(schema, "{}");
  const args = run("workspace-write", undefined, undefined, ["--output-schema", schema]);
  expect(args).toContain(`${reference}:${reference}:ro`);
  expect(args.slice(-2)).toEqual(["--output-schema", schema]);
});
