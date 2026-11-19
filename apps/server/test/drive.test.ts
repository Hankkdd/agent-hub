import { loadVideoSource, retainVideoSource } from "../src/media/video-source";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAccount } from "../src/google/auth";
import { parseDriveUrl, type DriveOptions } from "../src/google/drive";
import { fetchVideoTranscript, fetchTranscript, timeLink, type MediaRuntime, type StepReporter } from "../src/media/video";
import { TaskListProjection } from "../src/core/task-list";
import { Hub } from "../src/core/hub";
import { FakeAdapter } from "../src/agents/fake";
import { openDb } from "../src/db";
const ID = "abcDEF_0123456789";
const URL = `https://drive.google.com/file/d/${ID}/view`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-test-")); dirs.push(dir); return dir; }
const metadata = { id: ID, name: "Course video", mimeType: "video/mp4", size: "4", videoMediaMetadata: { durationMillis: "5000" }, owners: [{ displayName: "Course owner" }], capabilities: { canDownload: true } };
const events: string[] = [];
const report: StepReporter = { step: (name, input) => { events.push(`${name}: ${input}`); return { progress: (text) => events.push(text), done: (text) => events.push(text) }; } };
function fixture() {
  const dataDir = temp(); const dir = path.join(dataDir, "task"); fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dataDir, "google"));
  fs.writeFileSync(path.join(dataDir, "google/client.json"), JSON.stringify({ clientId: "id", clientSecret: "secret-client", redirectUri: "http://localhost:12345" }));
  fs.writeFileSync(path.join(dataDir, "google/accounts.json"), JSON.stringify({ version: 1, accounts: { account: { email: "viewer@example.invalid", refreshToken: "secret-refresh", scopes: ["https://www.googleapis.com/auth/drive.readonly"], updatedAt: "2026-01-01" } } }));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "secret-access", expires_in: 3600 });
    if (String(url).includes("alt=media")) return new Response(new Uint8Array([1, 2, 3, 4]));
    return Response.json(metadata);
  });
  const google = new GoogleAccount({ dataDir, fetch: fetcher });
  const run = vi.fn<MediaRuntime["run"]>().mockImplementation(async (_tag, work, cmd, options) => {
    if (cmd[0] === "ffmpeg") fs.writeFileSync(path.join(work, "audio.m4a"), "audio");
    if (cmd[0] === "python") {
      options.onLine?.('{"start":0,"end":1,"text":"A course segment"}');
      options.onLine?.('{"language":"en","duration":5}');
    }
    return "";
  });
  const media: MediaRuntime = { run, ensureImage: vi.fn().mockResolvedValue({ tag: "media-test", built: false }) };
  const drive: DriveOptions = { statfs: vi.fn().mockResolvedValue({ bavail: 10 * 1024 ** 3, bsize: 1 }) as unknown as typeof fs.promises.statfs };
  return { dataDir, dir, google, fetcher, run, media, drive,
    transcribe: (signal = new AbortController().signal) => fetchVideoTranscript(URL, dir, path.join(dataDir, "cache"), report, signal, { google, media, drive }),
  };
}
function clean(dir: string) { expect(fs.readdirSync(dir).filter((f) => f.startsWith("source.") || f === "audio.m4a")).toEqual([]); }
describe("Drive URL parser", () => {
  it.each([`/file/d/${ID}`, `/file/d/${ID}/view?usp=sharing`, `/file/d/${ID}/preview`, `/file/d/${ID}/edit`, `/open?id=${ID}`, `/uc?id=${ID}`, `/uc?export=download&id=${ID}`])("accepts %s", (suffix) => {
    expect(parseDriveUrl(`https://drive.google.com${suffix}`)).toEqual({ fileId: ID });
  });
  it("preserves the resource key", () => { expect(parseDriveUrl(`${URL}?resourcekey=resourceKey_12345`)).toEqual({ fileId: ID, resourceKey: "resourceKey_12345" }); });
  it.each([
    `http://drive.google.com/file/d/${ID}`, `https://drive.google.com.evil.example/file/d/${ID}`,
    `https://evil.example/drive.google.com/file/d/${ID}`, `https://user:pass@drive.google.com/file/d/${ID}`,
    `https://@drive.google.com/file/d/${ID}`,
    `https://docs.google.com/file/d/${ID}`, `https://drive.google.com/file/d/short`,
    `https://drive.google.com/file/d/${"a".repeat(201)}`, `https://drive.google.com/file/d/${ID}/../${ID}`,
    `https://drive.google.com/file/d/%2e%2e/${ID}`, `https://drive.google.com/file/d/${ID}%2fview`,
    `https://drive.google.com/open?id=${ID}%2Fother`, `${URL}?resourcekey=bad!`, `${URL}/other`,
    `https://drive.google.com/uc?id=`, `https://drive.google.com:444/file/d/${ID}`, "invalid",
  ])("rejects %s", (value) => expect(parseDriveUrl(value)).toBeNull());
});
describe("Drive transcript pipeline", () => {
  it("streams Drive, extracts audio and shares Whisper without exposing credentials", async () => {
    events.length = 0;
    const f = fixture();
    const transcript = await fetchVideoTranscript(`${URL}?resourcekey=resourceKey_12345`, f.dir, path.join(f.dataDir, "cache"), report, new AbortController().signal, { google: f.google, media: f.media, drive: f.drive });
    expect(transcript.meta).toMatchObject({ id: ID, title: "Course video", extractor: "GoogleDrive", duration: 5, uploader: "Course owner", url: URL });
    expect(transcript.source).toBe("Whisper small (language: en)");
    expect(transcript.markdown).toContain("[0:00] A course segment");
    expect(fs.readFileSync(path.join(f.dir, "transcript.md"), "utf8")).toBe(transcript.markdown);
    expect(loadVideoSource(f.dir)).toMatchObject({ precision: "segment", units: transcript.segments.map(s => ({ start: s.start, text: s.text })) });
    expect(timeLink(transcript.meta, 10)).toBeNull(); clean(f.dir);
    expect(f.run.mock.calls[0]![2]).toEqual(["ffmpeg", "-nostdin", "-y", "-i", "source.mp4", "-vn", "-c:a", "aac", "audio.m4a"]);
    const calls = f.fetcher.mock.calls.filter(([url]) => String(url).startsWith("https://www.googleapis.com/"));
    expect(calls).toHaveLength(2);
    expect(calls.every(([url, init]) => String(url).includes(`/files/${ID}?`) && new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys") === `${ID}/resourceKey_12345`)).toBe(true);
    expect(JSON.stringify(f.run.mock.calls) + JSON.stringify(events)).not.toMatch(/secret-(access|refresh|client)/);
    expect(events.some((e) => e.includes("4 / 4 bytes"))).toBe(true);
  });
  it("retries a 401 with one refresh and succeeds", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "old", expires_in: 3600 })).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await f.transcribe(); clean(f.dir);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(2);
  });
  it.each([
    [403, /no permission to read this file as viewer@example.invalid/],
    [404, /file not found, or not shared with viewer@example.invalid/],
  ])("maps status %i", async (status, message) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "secret-access" })).mockResolvedValueOnce(new Response(null, { status }));
    await expect(f.transcribe()).rejects.toThrow(message); clean(f.dir); expect(f.run).not.toHaveBeenCalled();
  });
  it.each([
    [{ mimeType: "application/pdf" }, /type: application\/pdf/],
    [{ capabilities: { canDownload: false } }, /owner disabled downloading/],
    [{ size: String(2 * 1024 ** 3 + 1) }, /download limit/],
  ])("validates metadata %j before media download", async (override, message) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "secret-access" })).mockResolvedValueOnce(Response.json({ ...metadata, ...override }));
    await expect(f.transcribe()).rejects.toThrow(message); clean(f.dir);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("alt=media"))).toBe(false);
  });
  it("requires free space greater than file size plus 512 MiB", async () => {
    const f = fixture(); f.drive.statfs = vi.fn().mockResolvedValue({ bavail: 512 * 1024 ** 2 + 4, bsize: 1 });
    await expect(f.transcribe()).rejects.toThrow(/Not enough disk space/); clean(f.dir);
  });
  it.each([undefined, "1"])("limits streamed bytes with absent or inaccurate size %s", async (size) => {
    const f = fixture(); f.drive.sizeLimit = 3;
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "secret-access" })).mockResolvedValueOnce(Response.json({ ...metadata, size }));
    await expect(f.transcribe()).rejects.toThrow(/stream exceeds/); clean(f.dir);
  });
  it("removes partial files on an interrupted stream and keeps an existing transcript", async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.dir, "transcript.md"), "existing transcript");
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "secret-access" })).mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.error(new Error("transport secret-access")); } })));
    await expect(f.transcribe()).rejects.toThrow("Google Drive download interrupted"); clean(f.dir);
    expect(fs.readFileSync(path.join(f.dir, "transcript.md"), "utf8")).toBe("existing transcript");
  });
  it("detects a short download", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "secret-access" })).mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response("x"));
    await expect(f.transcribe()).rejects.toThrow(/file size mismatch/); clean(f.dir);
  });
  it.each(["stop", "timeout"])("cleans a pending streamed download after %s", async (kind) => {
    const f = fixture(); const ac = new AbortController();
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    f.fetcher.mockResolvedValueOnce(Response.json({ access_token: "secret-access" })).mockResolvedValueOnce(Response.json(metadata)).mockImplementationOnce(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); started(); } })));
    if (kind === "timeout") f.drive.timeoutMs = 30;
    const result = f.transcribe(ac.signal);
    const assertion = expect(result).rejects.toThrow(kind === "stop" ? /stopped/ : /timed out/);
    await ready; if (kind === "stop") ac.abort();
    await assertion; clean(f.dir); expect(fs.existsSync(path.join(f.dir, "transcript.md"))).toBe(false);
  });
  it.each(["ffmpeg", "python"])("cleans media if %s fails or is stopped", async (command) => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { if (args[2][0] === command) { fs.writeFileSync(path.join(f.dir, "audio.m4a"), "partial"); throw new Error("media failed"); } return original(...args); });
    await expect(f.transcribe()).rejects.toThrow(/media failed/); clean(f.dir);
  });
  it("cleans media on Stop during Whisper and leaves transcript untouched", async () => {
    const f = fixture(); const ac = new AbortController(); fs.writeFileSync(path.join(f.dir, "transcript.md"), "keep");
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { if (args[2][0] === "python") { ac.abort(); args[3].signal.throwIfAborted(); } return original(...args); });
    await expect(f.transcribe(ac.signal)).rejects.toThrow(); clean(f.dir);
    expect(fs.readFileSync(path.join(f.dir, "transcript.md"), "utf8")).toBe("keep");
  });
  it("Stop does not wait for a shared token refresh or start a Drive request", async () => {
    const f = fixture(); const ac = new AbortController();
    let release!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.transcribe(ac.signal);
    const assertion = expect(pending).rejects.toThrow(/stopped/);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    ac.abort(); await assertion; clean(f.dir);
    release(Response.json({ access_token: "secret-access", expires_in: 3600 }));
    await vi.waitFor(() => expect(f.google.accessToken("drive.read")).resolves.toBe("secret-access"));
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("does not expose unclassified errors even when they resemble Drive messages", async () => {
    const f = fixture();
    f.drive.statfs = vi.fn().mockRejectedValue(new Error("Google provider secret-access"));
    await expect(f.transcribe()).rejects.toThrow("Google Drive download interrupted");
    clean(f.dir);
  });

  it("requires a connected account and the drive.read capability", async () => {
    const f = fixture();
    await expect(fetchVideoTranscript(URL, f.dir, "cache", report, new AbortController().signal)).rejects.toThrow(/connect Google/);
    await f.google.disconnect();
    await expect(f.transcribe()).rejects.toThrow(/connect Google/); clean(f.dir);
    fs.writeFileSync(path.join(f.dataDir, "google/accounts.json"), JSON.stringify({ version: 1, accounts: { account: { email: "viewer@example.invalid", refreshToken: "secret-refresh", scopes: [], updatedAt: "" } } }));
    await expect(f.transcribe()).rejects.toThrow(/connect Google/);
  });
});
describe("video source dispatch", () => {
  it.each(["https://www.youtube.com/watch?v=test", `https://drive.google.com.evil.example/file/d/${ID}`, `http://drive.google.com/file/d/${ID}`])("preserves yt-dlp dispatch for %s", async (url) => {
    const ytDlp = vi.fn<typeof fetchTranscript>().mockResolvedValue({} as Awaited<ReturnType<typeof fetchTranscript>>);
    await fetchVideoTranscript(url, "work", "cache", report, new AbortController().signal, { ytDlp });
    expect(ytDlp).toHaveBeenCalledOnce(); expect(ytDlp.mock.calls[0]![0]).toBe(url);
  });
  it("keeps subtitles first and original step outputs using an injected media runner", async () => {
    const dir = temp();
    const run = vi.fn<MediaRuntime["run"]>().mockImplementation(async (_tag, work, cmd) => {
      if (cmd.includes("--dump-single-json")) return JSON.stringify({ id: "youtube-id", title: "Talk", language: "en", subtitles: { en: [] } });
      fs.writeFileSync(path.join(work, "sub.en.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"); return "";
    });
    const transcript = await fetchVideoTranscript("https://www.youtube.com/watch?v=test", dir, "cache", report, new AbortController().signal, { media: { run, ensureImage: vi.fn().mockResolvedValue({ tag: "fake", built: false }) } });
    expect(loadVideoSource(dir)).toMatchObject({ precision: "segment", units: transcript.segments.map(s => ({ start: s.start, text: s.text })) });
    expect(transcript.source).toBe("subtitles (en)"); expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls[1]![2]).toContain("--write-subs");
  });
  it.each(["non-monotonic starts", "odd metadata"])("keeps ordinary VTT acquisition usable despite retention rejecting %s", async problem => {
    const dir = temp();
    const run = vi.fn<MediaRuntime["run"]>().mockImplementation(async (_tag, work, cmd) => {
      if (cmd.includes("--dump-single-json")) return JSON.stringify({ id: "test", title: "Talk", uploader: problem === "odd metadata" ? 42 : null, language: "en", subtitles: { en: [] } });
      fs.writeFileSync(path.join(work, "sub.en.vtt"), problem === "non-monotonic starts"
        ? "WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nFirst\n\n00:00:01.000 --> 00:00:02.000\nSecond\n"
        : "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
      return "";
    });
    const t = await fetchVideoTranscript("https://www.youtube.com/watch?v=test", dir, "cache", report, new AbortController().signal,
      { media: { run, ensureImage: vi.fn().mockResolvedValue({ tag: "fake", built: false }) } });
    expect(fs.readFileSync(path.join(dir, "transcript.md"), "utf8")).toBe(t.markdown);
    expect(fs.existsSync(path.join(dir, "transcript.source.v1.json"))).toBe(false);
    expect(loadVideoSource(dir).precision).toBe("paragraph");
    expect(loadVideoSource(dir).units.map(u => u.text).join(" ")).toContain(problem === "odd metadata" ? "Hello" : "First Second");
  });
  it("continues ordinary Drive summary and questions when Whisper emits empty segment text", async () => {
    const f = fixture(), agent = new FakeAdapter();
    f.run.mockImplementation(async (_tag, work, cmd, options) => {
      if (cmd[0] === "ffmpeg") fs.writeFileSync(path.join(work, "audio.m4a"), "audio");
      if (cmd[0] === "python") {
        // Simulate an old retained source so a rejected replacement cannot leave stale evidence.
        retainVideoSource(work, { meta: { id: "stale", title: "Old", url: URL, extractor: "GoogleDrive", uploader: null, duration: null, language: null, subtitles: [], autoCaptions: [] },
          source: "fixture", segments: [{ start: 0, text: "Stale evidence" }], markdown: "" });
        options.onLine?.('{"start":0,"text":"A course segment"}');
        options.onLine?.('{"start":1,"text":"   "}');
      }
      return "";
    });
    const hub = new Hub({ db: openDb(":memory:"), dataDir: f.dataDir, agents: { codex: agent }, maxConcurrent: 1, video: { google: f.google, media: f.media, drive: f.drive } });
    try {
      const task = await hub.createTask({ title: URL, workflow: "video", message: URL });
      await hub.settled(task.id);
      expect(hub.getTask(task.id).status).toBe("idle");
      expect(agent.runs[0]?.prompt).toContain("A course segment");
      expect(fs.existsSync(path.join(task.cwd!, "transcript.source.v1.json"))).toBe(false);
      expect(loadVideoSource(task.cwd!).precision).toBe("paragraph");
      expect(loadVideoSource(task.cwd!).units[0]!.text).toContain("A course segment");
      expect(hub.events(task.id).some(e => e.type === "tool_call" && e.name === "transcript evidence" && !e.pending)).toBe(true);
      hub.sendMessage(task.id, "More detail"); await hub.settled(task.id);
      expect(agent.runs).toHaveLength(2);
      expect(f.run.mock.calls.filter(call => call[2][0] === "python")).toHaveLength(1);
    } finally { await hub.shutdown(); }
  });
  it("stops after the transcript for a transcript-only task, and points the first follow-up at the file", async () => {
    const f = fixture(); const agent = new FakeAdapter();
    const hub = new Hub({ db: openDb(":memory:"), dataDir: f.dataDir, agents: { codex: agent }, maxConcurrent: 1, video: { google: f.google, media: f.media, drive: f.drive } });
    try {
      const task = await hub.createTask({ title: URL, workflow: "video", message: URL, transcriptOnly: true });
      await hub.settled(task.id);
      expect(hub.getTask(task.id)).toMatchObject({ status: "idle", title: "Course video", options: { transcriptOnly: true } });
      expect(agent.runs).toHaveLength(0);
      expect(fs.readFileSync(hub.transcriptPath(hub.getTask(task.id))!, "utf8")).toContain("A course segment");
      expect(hub.events(task.id).some(e => e.type === "turn_result" && e.ok)).toBe(true);
      const projection = new TaskListProjection(hub);
      expect((await projection.list()).summaries.find(s => s.taskId === task.id)?.transcriptOnlyUntouched).toBe(true);
      hub.sendMessage(task.id, "What is it about?"); await hub.settled(task.id);
      expect((await projection.list()).summaries.find(s => s.taskId === task.id)?.transcriptOnlyUntouched).toBeUndefined();
      expect(agent.runs).toHaveLength(1);
      expect(agent.runs[0]?.prompt).toMatch(/transcript\.md[\s\S]*What is it about\?/);
    } finally { await hub.shutdown(); }
  });
  it("rejects transcriptOnly outside video tasks", async () => {
    const f = fixture();
    const hub = new Hub({ db: openDb(":memory:"), dataDir: f.dataDir, agents: { codex: new FakeAdapter() }, maxConcurrent: 1 });
    try {
      await expect(hub.createTask({ title: "c", workflow: "chat", message: "hi", transcriptOnly: true })).rejects.toThrow(/only for video/);
    } finally { await hub.shutdown(); }
  });
  it("runs the existing summary, renames a URL task and uses the transcript for follow-up", async () => {
    const f = fixture(); const agent = new FakeAdapter();
    const hub = new Hub({ db: openDb(":memory:"), dataDir: f.dataDir, agents: { codex: agent }, maxConcurrent: 1, video: { google: f.google, media: f.media, drive: f.drive } });
    const task = await hub.createTask({ title: URL, workflow: "video", message: URL });
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(hub.getTask(task.id).title).toBe("Course video");
    expect(agent.runs[0]?.prompt).toContain("A course segment");
    expect(JSON.stringify(hub.events(task.id))).not.toMatch(/secret-(access|refresh|client)/);
    const count = f.fetcher.mock.calls.length;
    hub.sendMessage(task.id, "More detail");
    await vi.waitFor(() => expect(agent.runs).toHaveLength(2));
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    await hub.shutdown();
  });
});
