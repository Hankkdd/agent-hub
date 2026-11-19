import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately scoped to the entry documents' inline links and ATX headings, not a repo index.
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const entrypoints = ["AGENTS.md", "README.md", "docs/knowledge-map.md"];
const errors = [];
let checked = 0;

function headings(text) {
  const ids = new Set();
  const counts = new Map();
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
  for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    ids.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return ids;
}

for (const source of entrypoints) {
  const text = await readFile(path.join(root, source), "utf8");
  const links = [...text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].map(match => match[1]);
  if (source !== "docs/knowledge-map.md") {
    assert.equal(links.filter(link => link === "docs/knowledge-map.md").length, 1,
      `${source}: expected one Knowledge Map entry`);
  }
  for (const link of links) {
    if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("//")) continue;
    try {
      const [relative, fragment] = link.split("#");
      assert(!relative.startsWith("/"), "use a relative repository link");
      const target = await realpath(path.resolve(root, path.dirname(source), decodeURIComponent(relative || path.basename(source))));
      const local = path.relative(root, target);
      assert(local !== ".." && !local.startsWith(`..${path.sep}`) && !path.isAbsolute(local), "target escapes repository");
      if (fragment) {
        assert((await stat(target)).isFile() && target.endsWith(".md"), "heading target must be Markdown");
        assert(headings(await readFile(target, "utf8")).has(decodeURIComponent(fragment)), "heading not found");
      }
      checked++;
    } catch (error) {
      errors.push(`${source}: ${link}: ${error.message}`);
    }
  }
}

assert.equal((await readFile(path.join(root, "CLAUDE.md"), "utf8")).trim(), "@AGENTS.md",
  "CLAUDE.md must retain the AGENTS.md import");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Document navigation: ${checked} local links valid; map entries and CLAUDE import valid.`);
}
