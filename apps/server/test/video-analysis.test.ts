import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latestVideoAnalysis, type AssignmentCategory, type TaskEvent, type VideoAnalysis } from "@agent-hub/shared";
import { loadVideoSource, retainVideoSource, evidenceLink } from "../src/media/video-source";
import { transcriptMarkdown, type Transcript, type Segment } from "../src/media/video";
import { ANALYSIS_LIMITS, consolidate, mergeExact, partitionSource, requestedAnalysis, runVideoAnalysis, validateExtraction } from "../src/core/video-analysis";
import { ASSIGNMENT_SYSTEM } from "../src/core/video-analysis-prompt";
import { Hub } from "../src/core/hub";
import { FakeAdapter } from "../src/agents/fake";
import { openDb, schema } from "../src/db/index";
import { createApp } from "../src/app";

const dirs: string[] = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-analysis-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function transcript(segments: Segment[]): Transcript {
  const meta = { id: "fixture123", title: "Fixture", url: "https://www.youtube.com/watch?v=fixture123", extractor: "Youtube", uploader: null, duration: null, language: null, subtitles: [], autoCaptions: [] };
  return { meta, source: "fixture", segments, markdown: transcriptMarkdown(meta, "fixture", segments) };
}
function retained(segments: Segment[]) { const dir = temporary(); retainVideoSource(dir, transcript(segments)); return { dir, source: loadVideoSource(dir) }; }
const empty = JSON.stringify({ version: 1, items: [] });
function item(unitId: string, excerpt: string, content = "必須完成指定工作", category: AssignmentCategory = "required", review = "pending", detail: string | null = null) {
  return { content, category, review, detail, evidence: [{ unitId, excerpt }] };
}
const json = (items: unknown[]) => JSON.stringify({ version: 1, items });
function unitsFromPrompt(prompt: string): { id: string; text: string }[] { return JSON.parse(prompt.split("UNTRUSTED_TRANSCRIPT_JSON\n")[1]!.split("\nEND_UNTRUSTED_TRANSCRIPT_JSON")[0]!); }
async function analyze(dir: string, generate: (prompt: string, system: string) => Promise<string>, signal = new AbortController().signal) {
  const events: VideoAnalysis[] = [];
  const result = await runVideoAnalysis(dir, requestedAnalysis(), { generate, signal, persist: a => events.push(a) });
  return { result, events };
}

describe("retained/legacy source", () => {
  it("retains real segment starts, fingerprints and derives only validated YouTube links", () => {
    const { source } = retained([{ start: 1.25, text: "first" }, { start: 3.5, text: "second" }]);
    expect(source.units.map(u => u.start)).toEqual([1.25, 3.5]);
    expect(evidenceLink(source, 3.5)).toBe("https://youtu.be/fixture123?t=3");
    expect(evidenceLink({ ...source, meta: { ...source.meta!, extractor: "GoogleDrive", url: "https://drive.google.com/file/d/fixture/view" } }, 3)).toBeUndefined();
    expect(evidenceLink({ ...source, meta: { ...source.meta!, id: "evil/redirect" } }, 3)).toBeUndefined();
    expect(evidenceLink({ ...source, meta: { ...source.meta!, url: "https://youtube.com.evil.test/watch?v=fixture123" } }, 3)).toBeUndefined();
  });
  it("uses all legacy paragraph starts with no inferred ends; rejects broken time structure", () => {
    const dir = temporary();
    fs.writeFileSync(path.join(dir, "transcript.md"), transcript([{ start: 0.5, text: "first" }, { start: 31.75, text: "last" }]).markdown);
    const source = loadVideoSource(dir);
    expect(source.precision).toBe("paragraph");
    expect(source.units.map(u => u.start)).toEqual([0, 31]);
    expect(source.units.every(u => !("end" in u))).toBe(true);
    expect(loadVideoSource(dir).fingerprint).toBe(source.fingerprint);
    for (const body of ["[0:00] good\n\n[bad] lost", "[0:99] invalid", "[0:31] later\n\n[0:00] earlier", "no timing"]) {
      fs.writeFileSync(path.join(dir, "transcript.md"), body);
      expect(() => loadVideoSource(dir)).toThrow();
    }
  });
  it("rejects invalid retained metadata/times and symbolic links without legacy downgrade", () => {
    const { dir } = retained([{ start: 0, text: "valid" }]);
    const file = path.join(dir, "transcript.source.v1.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.segments[0].start = -1; fs.writeFileSync(file, JSON.stringify(data));
    expect(() => loadVideoSource(dir)).toThrow(/timing/);
    data.segments[0].start = 0; data.meta.duration = "100"; fs.writeFileSync(file, JSON.stringify(data));
    expect(() => loadVideoSource(dir)).toThrow(/duration/);
    fs.rmSync(file); fs.symlinkSync(path.join(dir, "outside"), file); fs.writeFileSync(path.join(dir, "outside"), "{}");
    // Broken/malicious retained sources are not replaced by a guessed source.
    expect(() => loadVideoSource(dir)).toThrow();
  });
});

describe("structured extraction", () => {
  const rules: [string, string, AssignmentCategory, string][] = [
    ["Use eight leaf Bubble Sort jobs.", "必須使用八個葉節點 Bubble Sort 工作", "required", "pending"],
    ["Use seven merge jobs.", "必須使用七個 Merge 工作", "required", "pending"],
    ["Dynamically enqueue dependent Merge jobs when dependencies finish.", "相依工作完成時必須動態加入 Merge 工作", "required", "pending"],
    ["Rerun with 1–8 Workers.", "必須以 1–8 Workers 重新執行", "required", "pending"],
    ["Busy Waiting is prohibited.", "禁止 Busy Waiting", "prohibited", "pending"],
    ["FIFO Queue and three Semaphores are adjustable recommendations.", "建議使用 FIFO Queue 與三個 Semaphores，可調整", "suggested", "pending"],
    ["Maybe input.txt or inputs.txt; perhaps 1000 or 10000 inputs.", "檔名與輸入大小限制不確定，待確認", "uncertain", "uncertain"],
    ["Use exactly two Workers.", "必須使用恰好兩個 Workers", "required", "conflict"],
    ["Use exactly four Workers.", "必須使用恰好四個 Workers", "required", "conflict"],
  ];
  it("preserves fixture classifications, ambiguity, original evidence, duplicates and contradictions", async () => {
    const { dir } = retained([...rules.map(([text], i) => ({ start: i * 31, text })), { start: 300, text: rules[0]![0] }]);
    const { result, events } = await analyze(dir, async (prompt, system) => {
      if (system !== ASSIGNMENT_SYSTEM) {
        const entries = JSON.parse(prompt);
        const conflicts = entries.filter((e: { review: string }) => e.review === "conflict").map((e: { id: string }) => e.id);
        return JSON.stringify({ version: 1, merges: [], conflicts: [conflicts] });
      }
      const units = unitsFromPrompt(prompt);
      return json(units.map(u => { const r = rules.find(([text]) => text === u.text)!; return item(u.id, u.text, r[1], r[2], r[3]); }));
    });
    expect(result.status).toBe("complete");
    expect(result.items).toHaveLength(rules.length);
    expect(result.items[0]!.evidence.map(e => e.start)).toEqual([0, 300]);
    expect(result.items.filter(i => i.category === "prohibited").map(i => i.content)).toEqual(["禁止 Busy Waiting"]);
    expect(result.items.find(i => i.category === "suggested")!.content).toContain("可調整");
    expect(result.items.find(i => i.category === "uncertain")!.review).toBe("uncertain");
    expect(result.items.filter(i => i.review === "conflict").every(i => i.conflicts.length === 1)).toBe(true);
    expect(result.missing).toEqual({ deadline: "not_mentioned", submission: "not_mentioned", output_format: "not_mentioned" });
    expect(events.at(-1)).toEqual(result);
    expect(result.items.every(i => i.id.startsWith("as-") && i.evidence.length && i.review !== ("confirmed" as string))).toBe(true);
  });
  it("covers beyond the old 150000 character prefix, splitting oversized units losslessly", async () => {
    const text = "ordinary text ".repeat(13000) + "Late requirement: rerun with eight Workers.";
    const { dir, source } = retained([{ start: 91.25, text }]);
    const chunks = partitionSource(source);
    expect(chunks.flatMap(c => c.units).map(u => u.text).join("")).toBe(text);
    expect(chunks.every(c => c.units.reduce((n, u) => n + u.text.length, 0) <= ANALYSIS_LIMITS.chunkCharacters)).toBe(true);
    const { result } = await analyze(dir, async prompt => {
      const unit = unitsFromPrompt(prompt).find(u => u.text.includes("Late requirement"));
      return unit ? json([item(unit.id, "Late requirement: rerun with eight Workers.", "必須以八個 Workers 重新執行")]) : empty;
    });
    expect(result.status).toBe("complete");
    expect(result.coverage.processedCharacters).toBe(text.length);
    expect(result.coverage.processedUnits).toBe(1);
    expect(result.items[0]!.evidence[0]!.start).toBe(91.25);
    expect(result.items[0]!.evidence[0]).not.toHaveProperty("end");
  });
  it("rejects malformed schemas, model IDs/times, out-of-coverage sources and forged excerpts", () => {
    const { source } = retained([{ start: 5, text: "Use eight jobs" }]);
    const chunk = partitionSource(source)[0]!;
    const valid = item(chunk.units[0]!.id, "eight jobs");
    for (const invalid of ["not json", json([{ ...valid, category: "mandatory" }]), json([{ ...valid, review: "confirmed" }]), json([{ ...valid, start: 5 }]), json([{ ...valid, id: "invented" }]), json([{ ...valid, evidence: [{ unitId: valid.evidence[0]!.unitId, excerpt: "seven jobs" }] }]), json([{ ...valid, evidence: [{ unitId: "unknown@0", excerpt: "eight jobs" }] }]), json([{ ...valid, evidence: [{ ...valid.evidence[0], start: 999 }] }])]) {
      expect(() => validateExtraction(invalid, chunk, source)).toThrow();
    }
    const first = validateExtraction(json([valid]), chunk, source);
    expect(validateExtraction(json([valid]), chunk, source)[0]!.id).toBe(first[0]!.id);
    expect(mergeExact([...first, ...first], source.fingerprint)[0]!.id).toBe(first[0]!.id);
  });
  it("keeps all wording and evidence on validated similar-rule consolidation and rejects unsafe merges", () => {
    const { source } = retained([{ start: 0, text: "Use eight jobs. Eight jobs are required." }]);
    const chunk = partitionSource(source)[0]!, id = chunk.units[0]!.id;
    const items = validateExtraction(json([item(id, "Use eight jobs.", "必須使用八個工作"), item(id, "Eight jobs are required.", "需要八個工作")]), chunk, source);
    const raw = JSON.stringify({ version: 1, merges: [items.map(i => i.id)], conflicts: [] });
    const merged = consolidate(raw, items, source.fingerprint);
    expect(merged).toHaveLength(1); expect(merged[0]!.variants).toHaveLength(1); expect(merged[0]!.evidence).toHaveLength(2);
    expect(consolidate(raw, [...items].reverse(), source.fingerprint)).toEqual(merged);
    expect(() => consolidate(JSON.stringify({ version: 1, merges: [[items[0]!.id, "forged"]], conflicts: [] }), items, source.fingerprint)).toThrow();
    expect(() => consolidate(raw, [items[0]!, { ...items[1]!, category: "prohibited" }], source.fingerprint)).toThrow();
  });
  it("distinguishes no relevant specification from no evidence and incomplete/limited/stopped processing", async () => {
    const { dir } = retained([{ start: 0, text: "A podcast about music and product presentations." }]);
    const { result } = await analyze(dir, async () => empty);
    expect(result.status).toBe("complete"); expect(result.items).toEqual([]);
    const blank = retained([]);
    const noEvidence = await analyze(blank.dir, async () => { throw new Error("Must not call"); });
    expect(noEvidence.result.status).toBe("incomplete"); expect(noEvidence.result.reason).toMatch(/No transcript evidence/);
    expect(noEvidence.result.missing.deadline).toBe("unknown");
    const long = retained([{ start: 0, text: "x".repeat(20001) }]);
    let calls = 0;
    const partial = await analyze(long.dir, async prompt => {
      if (++calls === 2) throw new Error("usage limit reached");
      const u = unitsFromPrompt(prompt)[0]!; return json([item(u.id, "x", "保留部分規格")]);
    });
    expect(partial.result.status).toBe("incomplete"); expect(partial.result.items).toHaveLength(1);
    expect(partial.result.coverage.processedUnits).toBe(0); expect(partial.result.coverage.processedChunks).toBe(1);
    expect(partial.result.missing.deadline).toBe("unknown");
    const controller = new AbortController();
    const stopped = await analyze(dir, async () => { controller.abort(); return empty; }, controller.signal);
    expect(stopped.result.status).toBe("incomplete"); expect(stopped.result.coverage.processedChunks).toBe(0);
    const huge = retained([{ start: 0, text: "x".repeat(ANALYSIS_LIMITS.inputCharacters + 1) }]);
    expect((await analyze(huge.dir, async () => empty)).result.reason).toMatch(/input character limit/);
    const many = retained(Array.from({ length: 128 * 129 }, (_, i) => ({ start: i, text: "x" })));
    const limited = await analyze(many.dir, async () => empty);
    expect(limited.result.status).toBe("incomplete"); expect(limited.result.coverage.processedChunks).toBe(128); expect(limited.result.missing.deadline).toBe("unknown");
    const malformed = await analyze(dir, async () => "{}");
    expect(malformed.result.status).toBe("incomplete"); expect(malformed.result.coverage.processedChunks).toBe(0);
  });
});

async function setup(script?: ConstructorParameters<typeof FakeAdapter>[0], fileDb = false, agent: "codex" | "claude" = "codex") {
  const dir = temporary(), db = openDb(fileDb ? path.join(dir, "test.db") : ":memory:");
  const adapter = new FakeAdapter(script ?? ((input) => [{ type: "text_delta", text: input.toolsDisabled ? empty : "ordinary summary / answer" }, { type: "done", ok: true }]));
  let acquired = 0;
  const hub = new Hub({ db, dataDir: dir, maxConcurrent: 1, agents: { codex: adapter, claude: adapter }, video: { ytDlp: async (_url, cwd) => {
    acquired++; const t = transcript([{ start: 0, text: "Podcast product presentation." }]);
    fs.mkdirSync(cwd, { recursive: true }); fs.writeFileSync(path.join(cwd, "transcript.md"), t.markdown); retainVideoSource(cwd, t); return t;
  } } });
  const task = await hub.createTask({ title: "", workflow: "video", agent, message: "https://www.youtube.com/watch?v=fixture123" });
  await hub.settled(task.id);
  return { dir, db, hub, task, adapter, acquired: () => acquired };
}

describe("explicit API/workflow/replay isolation", () => {
  it.each(["codex", "claude"] as const)("leaves ordinary %s video prompts unchanged before/after analysis without reacquisition", async agent => {
    const { hub, task, adapter, acquired } = await setup(undefined, false, agent);
    expect(latestVideoAnalysis(hub.events(task.id))).toBeUndefined();
    expect(adapter.runs[0]!.prompt).not.toContain("assignment");
    hub.sendMessage(task.id, "Assignment Spec is a phrase in an ordinary question"); await hub.settled(task.id);
    expect(latestVideoAnalysis(hub.events(task.id))).toBeUndefined();
    hub.analyzeVideo(task.id, "assignment-spec"); await hub.settled(task.id);
    const a = latestVideoAnalysis(hub.events(task.id))!;
    expect(a.status).toBe("complete"); expect(a.items).toEqual([]);
    const analysisRun = adapter.runs.find(r => r.toolsDisabled)!;
    expect(analysisRun.readOnly).toBe(true); expect(analysisRun.threadId).toBeUndefined(); expect(analysisRun.mcp).toBeUndefined();
    hub.sendMessage(task.id, "Discuss the music freely"); await hub.settled(task.id);
    expect(adapter.runs.at(-1)!.prompt).toBe("Discuss the music freely"); expect(adapter.runs.at(-1)!.toolsDisabled).not.toBe(true);
    expect(acquired()).toBe(1);
    const history = hub.events(task.id); expect(history.filter(e => e.type === "video_analysis").map(e => e.seq)).toEqual([...history.filter(e => e.type === "video_analysis").map(e => e.seq)].sort((a, b) => a - b));
    expect(latestVideoAnalysis(JSON.parse(JSON.stringify(history)))).toEqual(a);
    expect(history.some(e => e.type === "invocation_started" && e.operationId === a.operationId)).toBe(true);
  });
  it("validates authenticated API requests and rejects wrong workflow/missing transcript/busy requests", async () => {
    const { hub, task, adapter } = await setup();
    const app = createApp(hub, "fixture-token"), url = `/api/tasks/${task.id}/video-analysis`;
    const headers = { authorization: "Bearer fixture-token", "content-type": "application/json" };
    const request = (body: string) => app.request(url, { method: "POST", headers, body });
    expect((await app.request(url, { method: "POST", body: '{"kind":"assignment-spec"}' })).status).toBe(401);
    expect((await request('{"kind":"unknown"}')).status).toBe(400);
    expect((await request('{"kind":"assignment-spec","extra":true}')).status).toBe(400);
    expect((await request('bad json')).status).toBe(400);
    adapter.hold(); expect((await request('{"kind":"assignment-spec"}')).status).toBe(202);
    expect((await request('{"kind":"assignment-spec"}')).status).toBe(409);
    hub.stop(task.id); adapter.release(); await hub.settled(task.id);
    expect(latestVideoAnalysis(hub.events(task.id))!.status).toBe("incomplete");
    fs.rmSync(path.join(task.cwd!, "transcript.md")); expect((await request('{"kind":"assignment-spec"}')).status).toBe(409);
    const chat = await hub.createTask({ title: "Chat", workflow: "chat", message: "hi" }); await hub.settled(chat.id);
    expect(() => hub.analyzeVideo(chat.id, "assignment-spec")).toThrow(/Video task/);
  });
  it("bounds runtime and retains honest incomplete status on quota/provider failures or tool attempts", async () => {
    for (const failure of ["quota", "missing-done", "tool", "oversized"]) {
      const f = await setup(input => input.toolsDisabled ? failure === "quota" ? [{ type: "done", ok: false, error: "usage limit reached" }] :
        failure === "tool" ? [{ type: "tool_start", callId: "forbidden", name: "read_file", input: "outside", sideEffect: "none" }] :
        [{ type: "text_delta", text: failure === "oversized" ? "x".repeat(48001) : empty }] : [{ type: "done", ok: true }]);
      f.hub.analyzeVideo(f.task.id, "assignment-spec"); await f.hub.settled(f.task.id);
      const a = latestVideoAnalysis(f.hub.events(f.task.id))!;
      expect(a.status).toBe("incomplete"); expect(a.missing.deadline).toBe("unknown"); expect(a.items).toEqual([]);
      expect(a.coverage.processedChunks).toBe(0);
      if (failure === "quota") expect(f.hub.events(f.task.id).some(e => e.type === "invocation_finished" && e.status === "usage_limit")).toBe(true);
    }
    const f = await setup(); f.adapter.hold();
    vi.useFakeTimers();
    try {
      f.hub.analyzeVideo(f.task.id, "assignment-spec");
      await vi.advanceTimersByTimeAsync(ANALYSIS_LIMITS.runtimeMs + 1);
      await f.hub.settled(f.task.id);
      expect(latestVideoAnalysis(f.hub.events(f.task.id))!.status).toBe("incomplete");
      expect(f.hub.isBusy(f.task.id)).toBe(false);
    } finally { vi.useRealTimers(); f.adapter.release(); }
  });
  it("restores durable progress after restart as incomplete and makes no automatic analysis calls", async () => {
    const { hub, task, dir, db } = await setup(undefined, true);
    hub.analyzeVideo(task.id, "assignment-spec"); await hub.settled(task.id);
    const a = latestVideoAnalysis(hub.events(task.id))!;
    // Simulate a crash after the last successful chunk but before terminal publication.
    const seq = hub.events(task.id).at(-1)!.seq + 1;
    db.insert(schema.events).values({ id: "crash-event", taskId: task.id, sessionId: null, seq, createdAt: new Date().toISOString(), type: "video_analysis",
      payload: { type: "video_analysis", analysis: { ...a, status: "running", missing: { deadline: "unknown", submission: "unknown", output_format: "unknown" } } } }).run();
    const adapter = new FakeAdapter();
    const restored = new Hub({ db, dataDir: dir, maxConcurrent: 1, agents: { codex: adapter } });
    restored.recoverInterrupted();
    const replay = latestVideoAnalysis(restored.events(task.id))!;
    expect(replay.status).toBe("incomplete"); expect(replay.source).toEqual(a.source); expect(replay.coverage).toEqual(a.coverage);
    expect(replay.reason).toMatch(/restart/); expect(adapter.runs).toHaveLength(0);
    restored.recoverInterrupted(); expect(adapter.runs).toHaveLength(0);
    // Projection is identical after wire serialization, independent of artifact reads.
    expect(latestVideoAnalysis(JSON.parse(JSON.stringify(restored.events(task.id))) as TaskEvent[])).toEqual(replay);
  });
});
