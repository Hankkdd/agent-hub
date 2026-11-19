import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectDocuments } from "../src/core/project-documents";

let root: string;
let docs: ProjectDocuments;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-documents-"));
  docs = new ProjectDocuments(root);
  await fs.mkdir(path.join(root, "decisions"));
  await fs.writeFile(path.join(root, "README.md"), "Organization\ndecisions are established\nUse [literal.*] text\n");
  await fs.writeFile(path.join(root, "decisions", "one.MARKDOWN"), "Agreed [literal.*]\nSecond line\n");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it.each(["jira-ticket", ".git"])("allows document roots below a %s ancestor while excluding children within the root", async (ancestor) => {
  const documentsRoot = path.join(root, ancestor, "project-documents");
  await fs.mkdir(path.join(documentsRoot, "decisions"), { recursive: true });
  const fixtures = new Map([
    ["README.md", "Project organization\nRead decisions for [literal.*] constraints\n"],
    ["decisions/adr.md", "Established [literal.*] constraint\nAllowed second line\n"],
    [".git/README.md", "FORBIDDEN_CONTENT [literal.*]\n"],
    ["jira-ticket/README.md", "FORBIDDEN_CONTENT [literal.*]\n"],
  ]);
  for (const [relative, content] of fixtures) {
    await fs.mkdir(path.dirname(path.join(documentsRoot, relative)), { recursive: true });
    await fs.writeFile(path.join(documentsRoot, relative), content);
  }
  const alias = path.join(root, "documents-root-alias");
  await fs.symlink(documentsRoot, alias);
  for (const configured of [documentsRoot, alias]) {
    const documents = new ProjectDocuments(configured);
    const bootstrap = await documents.bootstrap();
    expect(bootstrap).toContain(fixtures.get("README.md"));
    expect(bootstrap).not.toContain("FORBIDDEN_CONTENT");
    const listing = await documents.list();
    expect(listing).toContain("file: README.md");
    expect(listing).toContain("directory: decisions");
    expect(listing).not.toMatch(/\.git|jira-ticket/);
    expect(await documents.list("decisions")).toContain("file: decisions/adr.md");
    const matches = await documents.search("[literal.*]");
    expect(matches).toContain("README.md:2: Read decisions for [literal.*] constraints");
    expect(matches).toContain("decisions/adr.md:1: Established [literal.*] constraint");
    expect(matches).not.toMatch(/FORBIDDEN_CONTENT|\.git|jira-ticket/);
    expect(await documents.search("FORBIDDEN_CONTENT")).not.toContain("README.md:");
    expect(await documents.read("decisions/adr.md", 2, 1)).toContain("2: Allowed second line");
    for (const child of [".git", "jira-ticket"]) {
      for (const result of [
        await documents.list(child),
        await documents.search("[literal.*]", child),
        await documents.read(`${child}/README.md`),
      ]) {
        expect(result).toContain("forbidden");
        expect(result).not.toContain("FORBIDDEN_CONTENT");
      }
      await fs.rm(path.join(documentsRoot, "README.md"));
      await fs.symlink(path.join(documentsRoot, child, "README.md"), path.join(documentsRoot, "README.md"));
      const excludedBootstrap = await documents.bootstrap();
      expect(excludedBootstrap).toContain("symlinks");
      expect(excludedBootstrap).not.toContain("FORBIDDEN_CONTENT");
      await fs.rm(path.join(documentsRoot, "README.md"));
      await fs.writeFile(path.join(documentsRoot, "README.md"), fixtures.get("README.md")!);
    }
  }
  for (const [relative, content] of fixtures) {
    expect(await fs.readFile(path.join(documentsRoot, relative), "utf8")).toBe(content);
  }
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
});

it("discovers nested supported text, matches literals, and continues line reads without changing Git", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const head = git("rev-parse", "HEAD"), status = git("status", "--porcelain");
  expect(await docs.list()).toContain("directory: decisions");
  expect(await docs.list("decisions")).toContain("file: decisions/one.MARKDOWN");
  expect(await docs.search("[literal.*]")).toContain("decisions/one.MARKDOWN:1: Agreed [literal.*]");
  expect(await docs.search("literalZZ")).toContain("End of search");
  expect(await docs.read("decisions/one.MARKDOWN", 1, 1)).toContain("next line 2");
  expect(await docs.read("decisions/one.MARKDOWN", 2, 1)).toContain("2: Second line");
  expect(git("rev-parse", "HEAD")).toBe(head); expect(git("status", "--porcelain")).toBe(status);
});

it("rejects excluded components, traversal, absolute/drive paths, aliases and special files", async () => {
  for (const directory of [".git", "jira-ticket", "nested/jira-ticket"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(path.join(root, directory, "secret.md"), "FORBIDDEN_CONTENT");
  }
  await fs.symlink(path.join(root, "jira-ticket"), path.join(root, "alias"));
  await fs.symlink(root, path.join(root, "loop"));
  await fs.symlink(os.tmpdir(), path.join(root, "escape"));
  await fs.symlink(path.join(root, "README.md"), path.join(root, "leaf.md"));
  execFileSync("mkfifo", [path.join(root, "pipe.txt")]);
  for (const file of [".git/secret.md", "jira-ticket/secret.md", "nested/jira-ticket/secret.md", "../README.md", "/README.md", "C:README.md", "C:\\README.md", "bad\0.md", "alias/secret.md", "loop/README.md", "escape/README.md", "leaf.md", "pipe.txt"]) {
    const result = await docs.read(file);
    expect(result).not.toContain("FORBIDDEN_CONTENT");
    expect(result).toMatch(/forbidden|relative|unavailable/i);
  }
  expect(await docs.search("FORBIDDEN_CONTENT")).not.toContain("secret.md");
  expect(await docs.list()).not.toMatch(/\.git|alias|loop|escape|pipe.txt|leaf.md/);
  await fs.rm(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git"), "FORBIDDEN_CONTENT");
  expect(await docs.read(".git")).toContain("forbidden");
  expect(await docs.list()).not.toContain(".git");
});

it("handles missing, unreadable, excluded, binary and oversized README without blocking other documents", async () => {
  await fs.rm(path.join(root, "README.md"));
  expect(await docs.bootstrap()).toContain("unavailable");
  expect(await docs.list()).toContain("decisions");
  await fs.writeFile(path.join(root, "README.md"), Buffer.from([255, 0]));
  expect(await docs.bootstrap()).toContain("Non-text");
  await fs.writeFile(path.join(root, "README.md"), "x".repeat(1_048_577));
  expect(await docs.bootstrap()).toContain("Oversized");
  await fs.rm(path.join(root, "README.md"));
  await fs.symlink(path.join(root, "decisions", "one.MARKDOWN"), path.join(root, "README.md"));
  expect(await docs.bootstrap()).toContain("symlinks");
  await fs.rm(path.join(root, "README.md"));
  await fs.writeFile(path.join(root, "README.md"), "readable");
  vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("private host message"), { code: "EACCES" }));
  expect(await docs.bootstrap()).toContain("EACCES");
  expect(await docs.read("image.pdf")).toContain("Unsupported");
  expect(await new ProjectDocuments(undefined).read("README.md")).toContain("Configure documentsDir");
  expect(await new ProjectDocuments(path.join(root, "missing")).list()).toContain("Configure documentsDir");
  expect(await new ProjectDocuments(path.join(root, "README.md")).search("text")).toContain("unavailable");
});

it("bounds bootstrap, line and character output, results and scans with explicit markers", async () => {
  const content = Array.from({ length: 600 }, (_, index) => `Rule ${index}: ${"x".repeat(100)}`).join("\n");
  await fs.writeFile(path.join(root, "README.md"), content);
  const bootstrap = await docs.bootstrap();
  expect(bootstrap).toContain("Truncated at 16,000");
  const next = Number(/startLine (\d+)/.exec(bootstrap)![1]);
  expect(await docs.read("README.md", next)).toContain(`${next}: Rule ${next - 1}`);
  expect(await docs.read("README.md")).toContain("next line 201");
  expect(await docs.search("Rule")).toContain("Truncated search");
  await fs.writeFile(path.join(root, "huge-line.txt"), "x".repeat(40_000));
  const read = await docs.read("huge-line.txt");
  expect(read.length).toBeLessThanOrEqual(32_000); expect(read).toContain("Truncated within line");
  const column = Number(/next column (\d+)/.exec(read)![1]);
  const continued = await docs.read("huge-line.txt", 1, 200, column);
  expect(continued).toContain("End of document");
  expect(read.split("\n")[1]!.slice(3).length + continued.split("\n")[1]!.slice(3).length).toBe(40_000);
  await Promise.all(Array.from({ length: 205 }, (_, i) => fs.writeFile(path.join(root, `${String(i).padStart(3, "0")}.txt`), "match")));
  const listing = await docs.list();
  expect(listing).toContain("Truncated listing");
  expect(listing.split("\n").filter((line) => /^(file|directory):/.test(line))).toHaveLength(200);
  await fs.mkdir(path.join(root, "scan"));
  await Promise.all(Array.from({ length: 2005 }, (_, i) => fs.writeFile(path.join(root, "scan", `${i}.bin`), "skip")));
  expect(await docs.search("absent", "scan")).toContain("not exhaustive");
  expect(await docs.list("scan")).toContain("scan budget");
});

it("resolves an operator root alias but responds to cancellation and rejects invalid ranges", async () => {
  const alias = path.join(root, "root-link");
  await fs.symlink(path.join(root, "decisions"), alias);
  expect(await new ProjectDocuments(alias).read("one.MARKDOWN")).toContain("Agreed");
  const ac = new AbortController(); ac.abort();
  await expect(new ProjectDocuments(root, ac.signal).search("text")).rejects.toThrow();
  expect(await docs.read("README.md", 0)).toContain("positive");
  expect(await docs.read("README.md", 1, 201)).toContain("1-200");
  expect(await docs.search(" ")).toContain("nonempty");
});
