import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureImage as ensure, imageTag as tagOf, type ImageSpec } from "../docker/images";

const exec = promisify(execFile);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The wrapper the Codex SDK runs instead of `codex`. */
export const WRAPPER = path.join(SERVER_DIR, "bin/codex-docker");

/** The Codex CLI version the installed SDK speaks to: the image must carry exactly this one. */
export function codexVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "node_modules/@openai/codex-sdk/package.json"), "utf8"));
  return pkg.dependencies["@openai/codex"];
}

function spec(): ImageSpec {
  const version = codexVersion();
  return { name: "agent-hub-codex", dockerfile: "codex.Dockerfile", version, buildArgs: { CODEX_VERSION: version } };
}

export function imageTag(): string {
  return tagOf(spec());
}

/** Build the Codex image if it is missing. */
export async function ensureImage(_tag?: string, onBuild?: () => void): Promise<{ built: boolean }> {
  return { built: (await ensure(spec(), onBuild)).built };
}

/** The container's own Codex login lives here, apart from the host's ~/.codex. */
export function isLoggedIn(codexHome: string): boolean {
  return fs.existsSync(path.join(codexHome, "auth.json"));
}

/** Remove Codex containers a hard kill of the server left running. Safe at boot: none are ours yet. */
export async function removeOrphans(): Promise<number> {
  try {
    const { stdout } = await exec("docker", ["ps", "-aq", "--filter", "label=agent-hub=codex"]);
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length) await exec("docker", ["rm", "-f", ...ids]);
    return ids.length;
  } catch {
    return 0;
  }
}

/** The one command a human runs once, printed wherever the login is missing. */
export function loginCommand(): string {
  return "mise exec -- pnpm codex:login";
}
