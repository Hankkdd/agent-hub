import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const DOCKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docker");

export interface ImageSpec {
  /** Repository name, e.g. "agent-hub-codex". */
  name: string;
  /** Dockerfile path relative to DOCKER_DIR, which is also the build context. */
  dockerfile: string;
  /** Other files the image copies in; they are part of the content hash. */
  files?: string[];
  buildArgs?: Record<string, string>;
  /** Human-readable prefix for the tag, e.g. the Codex CLI version. */
  version?: string;
}

/**
 * Content-addressed tag: a hash of everything the image is built from (Dockerfile, copied files,
 * build args). Editing any of them names a new image, so a stale one is never used and nothing has
 * to remember to rebuild.
 */
export function imageTag(spec: ImageSpec): string {
  const h = createHash("sha256");
  for (const f of [spec.dockerfile, ...(spec.files ?? [])]) h.update(fs.readFileSync(path.join(DOCKER_DIR, f)));
  h.update(JSON.stringify(spec.buildArgs ?? {}));
  const hash = h.digest("hex").slice(0, 10);
  return `${spec.name}:${spec.version ? `${spec.version}-` : ""}${hash}`;
}

const building = new Map<string, Promise<void>>();

/** Build the image if it is missing. Concurrent callers of the same tag share one build. */
export async function ensureImage(spec: ImageSpec, onBuild?: () => void): Promise<{ tag: string; built: boolean }> {
  const tag = imageTag(spec);
  try {
    await exec("docker", ["image", "inspect", tag]);
    return { tag, built: false };
  } catch {
    // missing: build below
  }
  // Notify each caller before waiting, including tasks sharing an in-flight build.
  onBuild?.();
  let b = building.get(tag);
  if (!b) {
    const args = ["build", "-t", tag, "-f", path.join(DOCKER_DIR, spec.dockerfile)];
    for (const [k, v] of Object.entries(spec.buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`);
    b = exec("docker", [...args, DOCKER_DIR], { maxBuffer: 64 * 1024 * 1024 })
      .then(() => undefined)
      .finally(() => building.delete(tag));
    building.set(tag, b);
  }
  await b;
  return { tag, built: true };
}
