import { tryRetainVideoSource } from "./video-source";
import { GoogleAccount } from "../google/auth";
import { downloadDrive, parseDriveUrl, type DriveOptions } from "../google/drive";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureImage, type ImageSpec } from "../docker/images";

/**
 * Video -> transcript, every step in a short-lived container (docker/media.Dockerfile) that sees only
 * the task's directory, so neither yt-dlp nor ffmpeg nor Whisper is installed on the host.
 *
 * Subtitles first (fast, exact): a human-made track if there is one, else the auto-captions in the
 * video's own language. Only a video with neither is downloaded as audio and transcribed.
 */

export const MEDIA_IMAGE: ImageSpec = { name: "agent-hub-media", dockerfile: "media.Dockerfile", files: ["media/transcribe.py"] };

export interface VideoMeta {
  id: string;
  title: string;
  uploader: string | null;
  duration: number | null;
  url: string;
  extractor: string;
  language: string | null;
  subtitles: string[];
  autoCaptions: string[];
}

export interface Segment {
  start: number;
  text: string;
}

export interface Transcript {
  meta: VideoMeta;
  source: string;
  segments: Segment[];
  markdown: string;
}

export interface StepReporter {
  /** A step starts; returns a function to report progress text and one to finish it. */
  step(name: string, input: string): { progress(text: string): void; done(output: string, isError?: boolean): void };
}

export async function fetchTranscript(url: string, dir: string, cacheDir: string, report: StepReporter, signal: AbortSignal, runtime: MediaRuntime = DEFAULT_RUNTIME): Promise<Transcript> {
  fs.mkdirSync(dir, { recursive: true });
  const img = report.step("docker image", "agent-hub-media");
  const { tag, built } = await runtime.ensureImage(MEDIA_IMAGE);
  img.done(built ? `built ${tag} (first use only)` : tag);

  const probe = report.step("yt-dlp", `info ${url}`);
  let meta: VideoMeta;
  try {
    const json = await runtime.run(tag, dir, ["yt-dlp", "--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url], { signal });
    meta = toMeta(JSON.parse(json), url);
  } catch (err) {
    probe.done(String(err instanceof Error ? err.message : err), true);
    throw err;
  }
  probe.done(`${meta.title} · ${meta.duration ? clock(meta.duration) : "?"} · subtitles: ${meta.subtitles.join(", ") || "none"} · auto: ${meta.autoCaptions.length ? `${meta.autoCaptions.length} languages` : "none"}`);

  let segments: Segment[];
  let source: string;
  const pick = pickSubtitle(meta);
  if (pick) {
    const s = report.step("yt-dlp", `subtitles ${pick.lang}${pick.auto ? " (auto)" : ""}`);
    await runtime.run(tag, dir, ["yt-dlp", "--skip-download", "--no-playlist", "--no-warnings", pick.auto ? "--write-auto-subs" : "--write-subs", "--sub-langs", pick.lang, "--sub-format", "vtt", "-o", "sub.%(ext)s", url], { signal });
    const file = fs.readdirSync(dir).find((f) => f.startsWith("sub.") && f.endsWith(".vtt"));
    if (!file) throw new Error("yt-dlp reported subtitles but wrote no .vtt file");
    segments = vttToSegments(fs.readFileSync(path.join(dir, file), "utf8"));
    source = `${pick.auto ? "auto-generated captions" : "subtitles"} (${pick.lang})`;
    s.done(`${segments.length} lines from ${file}`);
  } else {
    const a = report.step("yt-dlp", "audio (no subtitles)");
    await runtime.run(tag, dir, ["yt-dlp", "--no-playlist", "--no-warnings", "-f", "bestaudio/best", "-x", "--audio-format", "m4a", "-o", "audio.%(ext)s", url], { signal });
    a.done("downloaded audio");
    ({ segments, source } = await transcribeAudio(tag, dir, cacheDir, report, signal, meta.duration, runtime));
  }
  fs.rmSync(path.join(dir, "audio.m4a"), { force: true }); // the audio was only a means

  const markdown = transcriptMarkdown(meta, source, segments);
  fs.writeFileSync(path.join(dir, "transcript.md"), markdown);
  retainAnalysisEvidence(dir, { meta, source, segments, markdown }, report);
  return { meta, source, segments, markdown };
}

function retainAnalysisEvidence(dir: string, t: Transcript, report: StepReporter): void {
  if (!tryRetainVideoSource(dir, t)) {
    report.step("transcript evidence", "optional segment retention").done("Segment evidence could not be retained. Analysis will validate the Markdown transcript at paragraph precision when no retained source is available.");
  }
}

export interface MediaRuntime {
  ensureImage: typeof ensureImage;
  run: typeof run;
}
export const DEFAULT_RUNTIME: MediaRuntime = { ensureImage, run };

export async function transcribeAudio(tag: string, dir: string, cacheDir: string, report: StepReporter, signal: AbortSignal, durationHint: number | null, runtime: MediaRuntime = DEFAULT_RUNTIME): Promise<{ segments: Segment[]; source: string }> {
  const w = report.step("whisper", "small, CPU");
  const total = durationHint;
  const segments: Segment[] = [];
  let language = "?";
  await runtime.run(tag, dir, ["python", "/usr/local/bin/transcribe.py", "audio.m4a", "small"], {
    signal,
    cacheDir,
    onLine: (line) => {
      const o = JSON.parse(line) as { start?: number; text?: string; language?: string };
      if (o.language) language = o.language;
      else if (o.text !== undefined && o.start !== undefined) {
        segments.push({ start: o.start, text: o.text });
        w.progress(`transcribed up to ${clock(o.start)}${total ? ` of ${clock(total)}` : ""}`);
      }
    },
  });
  const source = `Whisper small (language: ${language})`;
  w.done(`${segments.length} segments, language ${language}`);
  return { segments, source };
}

export interface VideoSourceOptions {
  google?: GoogleAccount;
  media?: MediaRuntime;
  drive?: DriveOptions;
  ytDlp?: typeof fetchTranscript;
}
/** One source dispatch point; unrecognized URLs retain the yt-dlp subtitles-first path. */
export async function fetchVideoTranscript(url: string, dir: string, cacheDir: string, report: StepReporter, signal: AbortSignal, options: VideoSourceOptions = {}): Promise<Transcript> {
  const drive = parseDriveUrl(url);
  if (!drive) return (options.ytDlp ?? fetchTranscript)(url, dir, cacheDir, report, signal, options.media);
  if (!options.google) throw new Error("connect Google Drive from the sidebar first");
  fs.mkdirSync(dir, { recursive: true });
  const runtime = options.media ?? DEFAULT_RUNTIME;
  let file: string | undefined;
  try {
    const downloaded = await downloadDrive(drive, options.google, dir, report, signal, options.drive);
    file = downloaded.file;
    const img = report.step("docker image", "agent-hub-media");
    const { tag, built } = await runtime.ensureImage(MEDIA_IMAGE);
    img.done(built ? `built ${tag} (first use only)` : tag);
    signal.throwIfAborted();
    const ffmpeg = report.step("ffmpeg", `extract audio from ${file}`);
    await runtime.run(tag, dir, ["ffmpeg", "-nostdin", "-y", "-i", file, "-vn", "-c:a", "aac", "audio.m4a"], { signal });
    ffmpeg.done("extracted audio");
    const { source, segments } = await transcribeAudio(tag, dir, cacheDir, report, signal, downloaded.meta.duration, runtime);
    signal.throwIfAborted();
    const markdown = transcriptMarkdown(downloaded.meta, source, segments);
    fs.writeFileSync(path.join(dir, "transcript.md"), markdown);
    retainAnalysisEvidence(dir, { meta: downloaded.meta, source, segments, markdown }, report);
    return { meta: downloaded.meta, source, segments, markdown };
  } finally {
    for (const name of [file, file ? `${file}.part` : undefined, "audio.m4a"]) {
      if (name) fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

/** Run one command in the media image with the task directory mounted at /work. */
function run(tag: string, dir: string, cmd: string[], o: { signal: AbortSignal; cacheDir?: string; onLine?: (line: string) => void }): Promise<string> {
  const args = ["run", "--rm", "-i", "--init", "--label", "agent-hub=media", "--user", `${process.getuid!()}:${process.getgid!()}`, "-e", "HOME=/tmp", "-v", `${dir}:/work`, "-w", "/work"];
  if (o.cacheDir) {
    fs.mkdirSync(o.cacheDir, { recursive: true });
    args.push("-v", `${o.cacheDir}:/cache`, "-e", "HF_HOME=/cache");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args, tag, ...cmd], { signal: o.signal, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let partial = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      out += s;
      if (o.onLine) {
        partial += s;
        const lines = partial.split("\n");
        partial = lines.pop()!;
        for (const l of lines) if (l.trim()) o.onLine(l);
      }
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(lastLines(err) || `exited with ${code}`));
    });
  });
}

function toMeta(j: Record<string, unknown>, url: string): VideoMeta {
  const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).filter((k) => k !== "live_chat") : []);
  return {
    id: String(j.id ?? ""),
    title: String(j.title ?? "(untitled)"),
    uploader: (j.uploader as string) ?? (j.channel as string) ?? null,
    duration: typeof j.duration === "number" ? j.duration : null,
    url: String(j.webpage_url ?? url),
    extractor: String(j.extractor_key ?? j.extractor ?? ""),
    language: (j.language as string) ?? null,
    subtitles: keys(j.subtitles),
    autoCaptions: keys(j.automatic_captions),
  };
}

const PREFERRED = ["zh-Hant", "zh-TW", "zh-HK", "zh", "zh-Hans", "zh-CN", "en", "en-US", "en-GB", "ja", "ko"];

/**
 * Which track to fetch. A human-made track beats auto-captions; among auto-captions only the ORIGINAL
 * language is real speech recognition (YouTube offers machine translations into every language, which
 * would summarise a translation of a guess).
 *
 * "-orig" alone does not identify the original: an auto-dubbed video has speech recognition for every
 * dubbed audio track, all keyed "<lang>-orig" ("ar-orig", "bn-orig", ..., "en-orig"), and the first key
 * is not the spoken language. The video's language (yt-dlp takes it from the original audio track) picks
 * among them; it is often regional ("en-US") while caption keys are not ("en-orig"), so match on the
 * base language too.
 */
export function pickSubtitle(m: VideoMeta): { lang: string; auto: boolean } | null {
  const langs = m.language ? languageVariants(m.language) : [];
  const own = matchLanguage(m.subtitles, langs);
  if (own) return { lang: own, auto: false };
  const preferred = PREFERRED.find((l) => m.subtitles.includes(l));
  if (preferred) return { lang: preferred, auto: false };

  const origs = m.autoCaptions.filter((k) => k.endsWith("-orig"));
  const orig =
    matchLanguage(origs, langs.map((l) => `${l}-orig`)) ??
    // A single "-orig" track is unambiguous; several with no known language could be any dub.
    (origs.length === 1 ? origs[0] : undefined) ??
    (origs.length === 0 ? matchLanguage(m.autoCaptions, langs) : undefined);
  if (orig) return { lang: orig, auto: true };

  // A human-made track in some other language still beats transcribing.
  const anyManual = m.subtitles[0];
  if (anyManual) return { lang: anyManual, auto: false };
  return null;
}

/** "en-US" -> ["en-US", "en"]; "zh-Hant-TW" -> ["zh-Hant-TW", "zh-Hant", "zh"]. */
function languageVariants(lang: string): string[] {
  const parts = lang.split(/[-_]/);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join("-"));
  return out;
}

/** The first key equal (ignoring case) to a wanted language, trying wanted languages in order. */
function matchLanguage(keys: string[], wanted: string[]): string | undefined {
  for (const w of wanted) {
    const hit = keys.find((k) => k.toLowerCase() === w.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * WebVTT -> lines with start times. YouTube's auto-captions repeat the previous line at the top of each
 * cue (a rolling two-line display) and add near-empty 10ms cues; keeping only lines not just seen turns
 * that back into the spoken sequence.
 */
export function vttToSegments(vtt: string): Segment[] {
  const out: Segment[] = [];
  const seen: string[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const start = parseTime(lines[i]!.split("-->")[0]!.trim());
    for (const raw of lines.slice(i + 1)) {
      const text = decode(raw.replace(/<[^>]+>/g, "")).trim();
      if (!text || seen.includes(text)) continue;
      out.push({ start, text });
      seen.push(text);
      if (seen.length > 3) seen.shift();
    }
  }
  return out;
}

/** Paragraphs of about `every` seconds, each headed by its start time. */
export function paragraphs(segments: Segment[], every = 30): string {
  const paras: string[] = [];
  let cur: { start: number; text: string } | null = null;
  for (const s of segments) {
    if (!cur || s.start - cur.start >= every) {
      if (cur) paras.push(`[${clock(cur.start)}] ${cur.text}`);
      cur = { start: s.start, text: s.text };
    } else {
      cur.text += joiner(cur.text, s.text) + s.text;
    }
  }
  if (cur) paras.push(`[${clock(cur.start)}] ${cur.text}`);
  return paras.join("\n\n");
}

export function transcriptMarkdown(m: VideoMeta, source: string, segments: Segment[]): string {
  return [
    `# ${m.title}`,
    "",
    [m.uploader, m.duration ? clock(m.duration) : null, m.url].filter(Boolean).join(" · "),
    `Source: ${source}`,
    "",
    paragraphs(segments),
    "",
  ].join("\n");
}

/** A link to a moment in the video, when the site supports one. */
export function timeLink(m: VideoMeta, seconds: number): string | null {
  if (/youtube/i.test(m.extractor) && m.id) return `https://youtu.be/${m.id}?t=${Math.floor(seconds)}`;
  return null;
}

export function clock(s: number): string {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function parseTime(t: string): number {
  const parts = t.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯]/;
/** No space between two CJK runs; a space otherwise. */
function joiner(a: string, b: string): string {
  return CJK.test(a.slice(-1)) && CJK.test(b.charAt(0)) ? "" : " ";
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function lastLines(s: string, n = 4): string {
  return s.trim().split("\n").slice(-n).join("\n");
}
