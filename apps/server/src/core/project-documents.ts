import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-settings";

const FILE_CAP = 1_048_576;
const OUTPUT_CAP = 32_000;
const ENTRY_CAP = 200;
const SCAN_CAP = 2_000;
const BYTE_CAP = 16 * FILE_CAP;
const supported = (name: string) => /\.(md|markdown|txt)$/i.test(name);
const excluded = (name: string) => [".git", "jira-ticket"].includes(name.toLowerCase());
const unavailable = "Project documents unavailable. Configure documentsDir in data-directory repos.json with a readable absolute directory or ~/ path; new plans capture changes. Do not invent directory rules.";

/** Live host reads only: no index, native agent grant, or document write authority. */
export class ProjectDocuments {
  constructor(private readonly configured: string | undefined, private readonly signal?: AbortSignal) {}

  private check(): void { this.signal?.throwIfAborted(); }

  private async root(): Promise<string> {
    this.check();
    if (!this.configured || /[\r\n\0]/.test(this.configured) || (!path.isAbsolute(this.configured) && !this.configured.startsWith("~/"))) throw new Error(unavailable);
    try {
      // The operator may select a symlink root; all objects below its canonical target must be real.
      const root = await fs.realpath(repoPath(this.configured));
      if (!(await fs.stat(root)).isDirectory()) throw new Error();
      await fs.access(root, constants.R_OK | constants.X_OK);
      return root;
    } catch { throw new Error(unavailable); }
  }

  private parts(relative: string): string[] {
    if (relative.length > 4096 || /[\0\r\n]/.test(relative) || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.startsWith("\\")) throw new Error("Document path must be relative to the configured directory");
    const parts = relative.split(/[\\/]/).filter((part) => part && part !== ".");
    if (parts.includes("..") || parts.some(excluded)) throw new Error("Document path is forbidden (traversal, .git or jira-ticket)");
    return parts;
  }

  private async resolve(root: string, relative: string, directory: boolean): Promise<string> {
    let target = root;
    const parts = this.parts(relative);
    for (const [index, part] of parts.entries()) {
      this.check();
      target = path.join(target, part);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error("Document symlinks below the configured root are forbidden");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Document parent must be a directory");
    }
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Document object must be a regular file or directory; special files are forbidden");
    const canonical = await fs.realpath(target);
    const rel = path.relative(root, canonical);
    if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel) || canonical !== target) throw new Error("Document path escaped its canonical directory");
    return target;
  }

  private async text(root: string, relative: string): Promise<string> {
    this.parts(relative);
    if (!supported(relative)) throw new Error("Unsupported document: use UTF-8 .md, .markdown or .txt files");
    const file = await this.resolve(root, relative, false);
    // NONBLOCK prevents a replaced file from hanging if it becomes a pipe; NOFOLLOW rejects leaf aliases.
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      const current = await fs.lstat(await this.resolve(root, relative, false));
      if (!stat.isFile() || stat.dev !== current.dev || stat.ino !== current.ino) throw new Error("Document changed during validation; retry");
      if (stat.size > FILE_CAP) throw new Error("Oversized document skipped: per-file processing cap is 1 MiB");
      const buffer = Buffer.alloc(FILE_CAP + 1);
      let size = 0;
      while (size < buffer.length) {
        this.check();
        const read = await handle.read(buffer, size, Math.min(65_536, buffer.length - size), size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > FILE_CAP) throw new Error("Oversized document skipped: per-file processing cap is 1 MiB");
      await this.resolve(root, relative, false);
      const bytes = buffer.subarray(0, size);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("Non-text document skipped: invalid UTF-8"); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Non-text document skipped");
      this.check();
      return text;
    } finally { await handle.close(); }
  }

  private async safe(action: (root: string) => Promise<string>): Promise<string> {
    try { return await action(await this.root()); }
    catch (err) {
      this.check();
      const code = (err as NodeJS.ErrnoException).code;
      if (code) return `[Project documents unavailable] Path unavailable (${code}). Check that it exists and is readable; do not invent directory rules.`;
      return `[Project documents unavailable] ${err instanceof Error ? err.message : "Unable to read project documents"}`;
    }
  }

  async bootstrap(): Promise<string> {
    return this.safe(async (root) => {
      const body = await this.text(root, "README.md");
      const prefix = "Host bootstrap read: README.md (project reference material)\n";
      if (body.length <= 16_000) return prefix + body;
      const included = body.slice(0, 16_000);
      const next = included.split("\n").length;
      const column = included.length - included.lastIndexOf("\n");
      return `${prefix}${included}\n[Truncated at 16,000 body characters. Use read_project_doc with path README.md, startLine ${next} and startColumn ${column} to continue.]`;
    });
  }

  async read(relative: string, startLine = 1, maxLines = 200, startColumn = 1): Promise<string> {
    return this.safe(async (root) => {
      if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 200) throw new Error("startLine must be positive; maxLines must be 1-200");
      if (!Number.isSafeInteger(startColumn) || startColumn < 1) throw new Error("startColumn must be positive");
      const lines = (await this.text(root, relative)).split("\n");
      const output = [`Document: ${this.parts(relative).join("/")}`];
      let size = output[0]!.length;
      let index = startLine - 1;
      for (; index < Math.min(lines.length, startLine - 1 + maxLines); index++) {
        this.check();
        const column = index === startLine - 1 ? startColumn : 1;
        const prefix = `${index + 1}: `;
        const body = lines[index]!.slice(column - 1);
        const line = prefix + body;
        if (size + line.length + 1 > OUTPUT_CAP - 300) {
          if (output.length === 1) {
            const fragment = body.slice(0, OUTPUT_CAP - 400 - size - prefix.length);
            const nextColumn = column + fragment.length;
            output.push(prefix + fragment);
            output.push(`[Truncated within line: next line ${index + 1}, next column ${nextColumn}; use startLine ${index + 1} and startColumn ${nextColumn}.]`);
            return output.join("\n");
          }
          break;
        }
        output.push(line); size += line.length + 1;
      }
      output.push(index < lines.length ? `[Truncated: next line ${index + 1}; use startLine ${index + 1}.]` : "[End of document]");
      return output.join("\n");
    });
  }

  private async entries(root: string, relative: string, budget: { scanned: number; truncated: boolean }): Promise<{ path: string; kind: "file" | "directory" }[]> {
    const dir = await this.resolve(root, relative, true);
    const entries: { path: string; kind: "file" | "directory" }[] = [];
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      this.check();
      if (++budget.scanned > SCAN_CAP) { budget.truncated = true; break; }
      if (excluded(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || !supported(entry.name)))) continue;
      entries.push({ path: [...this.parts(relative), entry.name].join("/"), kind: entry.isDirectory() ? "directory" : "file" });
    }
    return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  async list(relative = ""): Promise<string> {
    return this.safe(async (root) => {
      const budget = { scanned: 0, truncated: false };
      const entries = await this.entries(root, relative, budget);
      const output: string[] = [];
      let size = 0, skipped = 0, bytes = 0;
      for (const entry of entries) {
        if (entry.kind === "file") {
          if (bytes + FILE_CAP > BYTE_CAP) { budget.truncated = true; break; }
          try { bytes += Buffer.byteLength(await this.text(root, entry.path)); } catch { this.check(); bytes += FILE_CAP; skipped++; continue; }
        }
        const line = `${entry.kind}: ${entry.path}`;
        if (output.length >= ENTRY_CAP || size + line.length > OUTPUT_CAP - 400) { budget.truncated = true; break; }
        output.push(line); size += line.length + 1;
      }
      return [...output, `Skipped ${skipped} unavailable, oversized or non-text files.`, budget.truncated ? "[Truncated listing: entry/file/output/scan budget reached; discover a narrower directory.]" : "[End of listing]"].join("\n");
    });
  }

  async search(query: string, relative = ""): Promise<string> {
    return this.safe(async (root) => {
      if (!query.trim() || query.length > 1_000 || /[\0\r\n]/.test(query)) throw new Error("query must be nonempty single-line literal text, at most 1,000 characters");
      const budget = { scanned: 0, truncated: false };
      const queue = [relative];
      const matches: string[] = [];
      let bytes = 0, size = 0, skipped = 0;
      outer: while (queue.length && !budget.truncated) {
        this.check();
        const subtree = queue.shift()!;
        let entries;
        try { entries = await this.entries(root, subtree, budget); }
        catch (err) { if (subtree === relative) throw err; this.check(); skipped++; continue; }
        for (const entry of entries) {
          if (entry.kind === "directory") { queue.push(entry.path); continue; }
          if (bytes + FILE_CAP > BYTE_CAP) { budget.truncated = true; break outer; }
          let text: string;
          try { text = await this.text(root, entry.path); bytes += Buffer.byteLength(text); } catch { this.check(); bytes += FILE_CAP; skipped++; continue; }
          for (const [index, line] of text.split("\n").entries()) {
            this.check();
            if (index % 512 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
            const position = line.indexOf(query);
            if (position < 0) continue;
            const snippet = line.slice(Math.max(0, position - 80), position + query.length + 160);
            const match = `${entry.path}:${index + 1}: ${snippet}${line.length > position + query.length + 160 ? " [snippet truncated]" : ""}`;
            if (matches.length >= ENTRY_CAP || size + match.length > OUTPUT_CAP - 400) { budget.truncated = true; break outer; }
            matches.push(match); size += match.length + 1;
          }
        }
      }
      return [...matches, `Skipped ${skipped} unavailable, oversized or non-text files/directories.`, budget.truncated ? "[Truncated search: scan/file/output/result budget reached; absence of a match is not exhaustive. Search a narrower subtree.]" : "[End of search]"].join("\n");
    });
  }
}
