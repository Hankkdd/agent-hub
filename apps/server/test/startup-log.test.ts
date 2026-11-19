import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadToken, startupMessages, tokenFile } from "../src/auth";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("startup log", () => {
  it.each([true, false])("never contains the Hub token, serveWeb=%s", (serveWeb) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-log-")); dirs.push(dataDir);
    const token = loadToken(dataDir);
    const lines = startupMessages({ address: "127.0.0.1", port: 8787, serveWeb, claudePermission: "auto", codexRuntime: "docker",
      toolsUrl: "http://172.17.0.1:8788/mcp", tokenFile: tokenFile(dataDir) });
    const log = lines.join("\n");
    expect(log).not.toContain(token);
    expect(log).not.toMatch(/[?&]token=(?!<token>)/); // Only the placeholder, never a value.
    // Non-sensitive facts stay, and the reader is told where to find the token.
    expect(log).toContain("agent-hub server on http://127.0.0.1:8787");
    expect(log).toContain("codex runtime: docker");
    expect(log).toContain(path.join(dataDir, "token"));
    if (serveWeb) expect(log).toContain("open: http://127.0.0.1:8787/");
  });

  it("main.ts logs startup only through startupMessages, never the token variable", () => {
    const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main.ts"), "utf8");
    const logged = main.split("\n").filter((line) => /console\.(log|info|warn|error)\(/.test(line));
    for (const line of logged) expect(line).not.toMatch(/\$\{token\}|[(,]\s*token\s*[),]/);
    expect(main).toContain("startupMessages(");
  });
});
