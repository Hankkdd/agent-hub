/**
 * Proves the real Codex and media images work with production's uid/gid and HOME=/tmp, including
 * Codex tool resolution with and without a mise project. Needs installed dependencies, Docker CLI
 * and a running daemon on a Unix host, plus network access for the first build. Cached checks usually
 * take under a minute; a first build takes several minutes. Run `pnpm verify:images` from repo root.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as codex from "../src/agents/codex-docker";
import { ensureImage } from "../src/docker/images";
import { ensureToolchainImage } from "../src/docker/toolchain";
import { MEDIA_IMAGE } from "../src/media/video";

interface Check {
  command: string[];
  accepts?: (stdout: string) => boolean;
  expected?: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let failures = 0;

// Keep output on one line per check, even when Docker or mise returns a multiline diagnostic.
function fail(label: string, output: string): void {
  failures++;
  console.log(`FAIL ${label}: ${JSON.stringify(output.trim())}`);
}

async function verify(): Promise<void> {
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-verify-images-"));
  try {
    const empty = path.join(temp, "empty");
    const project = path.join(temp, "mise-project");
    const codexHome = path.join(temp, "codex-home");
    const mediaWork = path.join(temp, "media");
    for (const dir of [empty, project, codexHome, mediaWork]) fs.mkdirSync(dir);
    fs.copyFileSync(path.join(ROOT, "mise.toml"), path.join(project, "mise.toml"));

    function check(label: string, args: string[], { command, accepts, expected }: Check): void {
      const result = spawnSync("docker", [...args, ...command], { encoding: "utf8" });
      const stdout = result.stdout ?? "";
      if (result.status === 0 && (!accepts || accepts(stdout.trim()))) {
        console.log(`PASS ${label}: ${command.join(" ")}`);
      } else {
        fail(`${label}: ${command.join(" ")}`, [
          stdout,
          result.stderr,
          result.error?.message,
          `exit status: ${result.status}`,
          expected ? `expected: ${expected}` : undefined,
        ].filter(Boolean).join("\n"));
      }
    }

    // Match bin/codex-docker, including mounting the work directory at the same path inside and out.
    try {
      const version = codex.codexVersion();
      const tag = codex.imageTag();
      await codex.ensureImage(tag);
      const checks: Check[] = [
        { command: ["codex", "--version"], accepts: (out) => out === `codex-cli ${version}`, expected: `codex-cli ${version}` },
        { command: ["which", "codex"], accepts: (out) => out.startsWith("/") && !out.startsWith("/opt/mise/shims/"), expected: "a Codex executable outside /opt/mise/shims" },
        { command: ["node", "--version"], accepts: (out) => out.startsWith("v22."), expected: "Node v22" },
        { command: ["pnpm", "--version"], accepts: (out) => out.startsWith("10."), expected: "pnpm 10" },
        { command: ["mise", "exec", "--", "pnpm", "--version"], accepts: (out) => out.startsWith("10."), expected: "pnpm 10 through mise exec" },
      ];
      for (const [label, dir] of [["empty directory", empty], ["mise project", project]] as const) {
        const args = [
          "run", "--rm", "-i", "--init", "--label", "agent-hub=codex", "--user", uid,
          "-e", "HOME=/tmp", "-e", "CODEX_HOME=/codex-home", "-v", `${codexHome}:/codex-home`,
          "-v", `${dir}:${dir}:rw`, "-w", dir, tag,
        ];
        for (const c of checks) check(`codex (${label})`, args, c);
      }
    } catch (error) {
      fail("codex image build", error instanceof Error ? error.message : String(error));
    }

    try {
      const version = codex.codexVersion();
      const { tag } = await ensureToolchainImage({ go: "1.26.5" });
      const checks: Check[] = [
        { command: ["go", "version"], accepts: (out) => /^go version go1\.26\.5\s/.test(out), expected: "go version go1.26.5" },
        { command: ["which", "go"], accepts: (out) => out.startsWith("/"), expected: "an absolute Go executable path" },
        { command: ["make", "--version"], accepts: (out) => out.startsWith("GNU Make"), expected: "GNU Make" },
        { command: ["codex", "--version"], accepts: (out) => out === `codex-cli ${version}`, expected: `codex-cli ${version}` },
        { command: ["which", "codex"], accepts: (out) => out.startsWith("/") && !out.startsWith("/opt/mise/shims/"), expected: "a Codex executable outside /opt/mise/shims" },
      ];
      for (const [label, dir] of [["empty directory", empty], ["mise project", project]] as const) {
        const args = [
          "run", "--rm", "-i", "--init", "--label", "agent-hub=codex", "--user", uid,
          "-e", "HOME=/tmp", "-e", "CODEX_HOME=/codex-home", "-v", `${codexHome}:/codex-home`,
          "-v", `${dir}:${dir}:rw`, "-w", dir, tag,
        ];
        for (const c of checks) check(`toolchain (${label})`, args, c);
      }
    } catch (error) {
      fail("toolchain image build", error instanceof Error ? error.message : String(error));
    }

    // Match media/video.ts: the media task directory is mounted at /work.
    try {
      const { tag } = await ensureImage(MEDIA_IMAGE);
      const args = [
        "run", "--rm", "-i", "--init", "--label", "agent-hub=media", "--user", uid,
        "-e", "HOME=/tmp", "-v", `${mediaWork}:/work`, "-w", "/work", tag,
      ];
      check("media", args, { command: ["yt-dlp", "--version"] });
      check("media", args, { command: ["python3", "-c", "import faster_whisper, av"] });
    } catch (error) {
      fail("media image build", error instanceof Error ? error.message : String(error));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  await verify();
} catch (error) {
  fail("image verification setup", error instanceof Error ? error.message : String(error));
}
process.exitCode = failures ? 1 : 0;
