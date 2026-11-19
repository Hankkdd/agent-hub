// `pnpm codex:image` builds the Codex container image; `pnpm codex:login` logs the container's own
// Codex in (device code: it prints a URL and a code to enter on any device). Run from the repo root.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureImage, imageTag } from "../src/agents/codex-docker";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexHome = path.resolve(ROOT, process.env.AGENT_HUB_DATA ?? "data", "codex-home");
const tag = imageTag();

console.log(`image: ${tag}`);
const { built } = await ensureImage(tag);
console.log(built ? "built" : "already present");

if (process.argv[2] === "login") {
  fs.mkdirSync(codexHome, { recursive: true });
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const r = spawnSync(
    "docker",
    ["run", "--rm", "-it", "--user", uid, "-e", "HOME=/tmp", "-e", "CODEX_HOME=/codex-home", "-v", `${codexHome}:/codex-home`, tag, "codex", "login", "--device-auth"],
    { stdio: "inherit" },
  );
  if (r.status === 0) console.log(`logged in; credentials in ${codexHome}/auth.json (gitignored)`);
  process.exit(r.status ?? 1);
}
