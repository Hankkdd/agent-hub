// `pnpm claude:login` logs the container's own Claude Code in, apart from the host's ~/.claude.
// Needed once before AGENT_HUB_CLAUDE_RUNTIME=docker. Run from the repo root, in a real terminal.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeBinary, dockerArgs, isLoggedIn } from "../src/agents/claude-docker";
import { ensureImage, imageTag } from "../src/agents/codex-docker";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const claudeHome = path.resolve(ROOT, process.env.AGENT_HUB_DATA ?? "data", "claude-home");
const tag = imageTag();

console.log(`image: ${tag}`);
const { built } = await ensureImage(tag);
console.log(built ? "built" : "already present");

fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
// Same container shape as a turn, made interactive for the login prompt.
const args = dockerArgs({ image: tag, claudeHome, command: claudeBinary(), args: ["auth", "login"], env: {} });
args.splice(args.indexOf("-i"), 1, "-it");
const r = spawnSync("docker", args, { stdio: "inherit" });
if (r.status === 0 && isLoggedIn(claudeHome)) console.log(`logged in; credentials in ${claudeHome} (outside the repository)`);
process.exit(r.status ?? 1);
