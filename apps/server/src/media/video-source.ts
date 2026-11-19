import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { timeLink, type Transcript, type VideoMeta, type Segment } from "./video";

const MAX_BYTES = 16_000_000;
const SOURCE_FILE = "transcript.source.v1.json";
export interface SourceUnit { id: string; start: number; text: string }
export interface AnalysisSource {
  version: 1;
  fingerprint: string;
  precision: "segment" | "paragraph";
  units: SourceUnit[];
  meta: VideoMeta | null;
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function readFixed(dir: string, name: string): string {
  const file = path.join(dir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("Unusable transcript source file");
  return fs.readFileSync(file, "utf8");
}
function segments(value: unknown): Segment[] {
  if (!Array.isArray(value) || value.length > 200_000) throw new Error("Invalid source segments");
  let previous = 0;
  return value.map(s => {
    if (!s || typeof s.start !== "number" || !Number.isFinite(s.start) || s.start < previous || s.start > 31_536_000 || typeof s.text !== "string" || !s.text.trim())
      throw new Error("Unusable or incomplete source timing/text");
    previous = s.start;
    return { start: s.start, text: s.text };
  });
}
function metadata(value: unknown): VideoMeta {
  if (!value || typeof value !== "object") throw new Error("Invalid source metadata");
  const m = value as VideoMeta;
  for (const k of ["id", "title", "url", "extractor"] as const) if (typeof m[k] !== "string" || m[k].length > 10000) throw new Error("Invalid source metadata");
  for (const k of ["uploader", "language"] as const) if (m[k] !== null && typeof m[k] !== "string") throw new Error("Invalid source metadata");
  if (m.duration !== null && (typeof m.duration !== "number" || !Number.isFinite(m.duration) || m.duration < 0)) throw new Error("Invalid source duration");
  for (const k of ["subtitles", "autoCaptions"] as const) if (!Array.isArray(m[k]) || m[k].some(x => typeof x !== "string")) throw new Error("Invalid source metadata");
  return m;
}
/** Fixed task-local path, validated before publication; never overwrite via a supplied path. */
export function retainVideoSource(dir: string, t: Transcript): void {
  const data = JSON.stringify({ version: 1, meta: metadata(t.meta), source: t.source, segments: segments(t.segments) });
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Transcript source exceeds retention limit");
  const temporary = path.join(dir, `.transcript-source-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { flag: "wx" });
    fs.renameSync(temporary, path.join(dir, SOURCE_FILE));
  } finally { fs.rmSync(temporary, { force: true }); }
}
/** Optional evidence retention must never make ordinary transcription fail. */
export function tryRetainVideoSource(dir: string, t: Transcript): boolean {
  try {
    retainVideoSource(dir, t);
    return true;
  } catch {
    // A previous artifact must not describe a newly acquired transcript after retention fails.
    try { fs.rmSync(path.join(dir, SOURCE_FILE), { force: true }); } catch { /* Acquisition remains usable even if cleanup fails. */ }
    return false;
  }
}
function source(parts: Segment[], precision: AnalysisSource["precision"], meta: VideoMeta | null): AnalysisSource {
  const fingerprint = digest(JSON.stringify({ version: 1, precision, meta, segments: parts }));
  return { version: 1, fingerprint, precision, meta, units: parts.map((s, i) => ({ ...s, id: `u-${digest(`${fingerprint}:${i}:${s.start}:${s.text}`).slice(0, 24)}` })) };
}
export function loadVideoSource(dir: string): AnalysisSource {
  if (fs.existsSync(path.join(dir, SOURCE_FILE))) {
    const data = JSON.parse(readFixed(dir, SOURCE_FILE));
    if (data.version !== 1 || typeof data.source !== "string") throw new Error("Invalid source version");
    return source(segments(data.segments), "segment", metadata(data.meta));
  }
  const markdown = readFixed(dir, "transcript.md").replace(/\r/g, "");
  const blocks = markdown.trim().split(/\n\s*\n/);
  const first = blocks.findIndex(b => /^\[/.test(b));
  const validHeader = (header: string[]) => header.length === 0 ||
    (header.length === 1 && /^#[^\n]*$/.test(header[0]!)) ||
    (header.length === 2 && /^#[^\n]*$/.test(header[0]!) && /^[^\n]*\nSource: [^\n]*$/.test(header[1]!));
  if (first < 0) {
    if (markdown.trim() && !validHeader(blocks)) throw new Error("No usable timestamped transcript paragraphs");
    return source([], "paragraph", null);
  }
  if (!validHeader(blocks.slice(0, first))) throw new Error("Incomplete legacy transcript time structure");
  const parts = blocks.slice(first).map(block => {
    const match = block.match(/^\[((?:\d+:)?\d{1,2}:\d{2})\]\s+([\s\S]+)$/);
    if (!match) throw new Error("Incomplete legacy transcript time structure");
    const times = match[1]!.split(":").map(Number);
    if (times.slice(1).some(n => n >= 60)) throw new Error("Invalid paragraph time");
    return { start: times.reduce((a, n) => a * 60 + n, 0), text: match[2]! };
  });
  // Only an actual header URL can establish a legacy source identity.
  const header = blocks.slice(0, first).join("\n");
  const url = header.match(/https?:\/\/[^\s·]+/g)?.find(raw => youtubeId(raw) !== null);
  const id = url ? youtubeId(url) : null;
  const meta: VideoMeta | null = id ? { id, url: url!, extractor: "Youtube", title: "", uploader: null, duration: null, language: null, subtitles: [], autoCaptions: [] } : null;
  return source(segments(parts), "paragraph", meta);
}
function youtubeId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const id = ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(u.hostname) && u.pathname === "/watch" ? u.searchParams.get("v") : u.hostname === "youtu.be" ? u.pathname.slice(1) : null;
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch { return null; }
}
export function evidenceLink(s: AnalysisSource, start: number): string | undefined {
  const m = s.meta;
  return m && /^youtube$/i.test(m.extractor) && youtubeId(m.url) === m.id ? timeLink(m, start) ?? undefined : undefined;
}
