import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/agents/fake";
import { Hub, summaryPrompt } from "../src/core/hub";
import { openDb } from "../src/db/index";
import { clock, paragraphs, pickSubtitle, timeLink, vttToSegments, type VideoMeta } from "../src/media/video";

const meta = (o: Partial<VideoMeta>): VideoMeta => ({
  id: "abc123", title: "T", uploader: null, duration: 100, url: "https://www.youtube.com/watch?v=abc123", extractor: "Youtube",
  language: null, subtitles: [], autoCaptions: [], ...o,
});

describe("vttToSegments", () => {
  it("undoes YouTube's rolling two-line auto-captions", () => {
    const vtt = `WEBVTT
Kind: captions

00:00:00.000 --> 00:00:02.000 align:start position:0%
hello<00:00:00.500><c> world</c>

00:00:02.000 --> 00:00:02.010
hello world

00:00:02.010 --> 00:00:04.000
hello world
this is<00:00:03.000><c> a test</c>

00:00:04.000 --> 00:00:06.000
this is a test
of captions &amp; things
`;
    expect(vttToSegments(vtt)).toEqual([
      { start: 0, text: "hello world" },
      { start: 2.01, text: "this is a test" },
      { start: 4, text: "of captions & things" },
    ]);
  });
});

describe("pickSubtitle", () => {
  it("prefers a human-made track, in the video's language first", () => {
    expect(pickSubtitle(meta({ language: "ja", subtitles: ["en", "ja"], autoCaptions: ["ja-orig", "en"] }))).toEqual({ lang: "ja", auto: false });
    expect(pickSubtitle(meta({ subtitles: ["fr", "zh-TW"] }))).toEqual({ lang: "zh-TW", auto: false });
  });
  it("takes auto-captions only in the original language, never a machine translation", () => {
    expect(pickSubtitle(meta({ autoCaptions: ["af", "ar", "en-orig", "zh-Hant"] }))).toEqual({ lang: "en-orig", auto: true });
    expect(pickSubtitle(meta({ language: "ko", autoCaptions: ["en", "ko"] }))).toEqual({ lang: "ko", auto: true });
    expect(pickSubtitle(meta({ autoCaptions: ["en", "zh-Hant"] }))).toBeNull(); // unknown original: transcribe instead
  });
  it("picks the spoken language among an auto-dubbed video's many -orig tracks", () => {
    // Shape of yt-dlp's info for an auto-dubbed English talk: speech recognition per dubbed audio
    // track, Arabic listed first, and a regional video language.
    const origs = ["ar-orig", "bn-orig", "nl-orig", "en-orig", "fr-orig", "de-orig", "ja-orig"];
    const autoCaptions = ["ab", "aa", "af", ...origs.flatMap((o) => [o, o.replace("-orig", "")])];
    expect(pickSubtitle(meta({ language: "en-US", subtitles: [], autoCaptions }))).toEqual({ lang: "en-orig", auto: true });
    expect(pickSubtitle(meta({ language: "ja", autoCaptions }))).toEqual({ lang: "ja-orig", auto: true });
    // Several -orig tracks and no language to choose by: any could be a dub, so transcribe.
    expect(pickSubtitle(meta({ autoCaptions }))).toBeNull();
  });
  it("matches a regional video language to a plain track, and prefers original speech over a stray translation", () => {
    expect(pickSubtitle(meta({ language: "en-US", subtitles: ["ar", "en"] }))).toEqual({ lang: "en", auto: false });
    expect(pickSubtitle(meta({ language: "ko-KR", autoCaptions: ["en", "ko"] }))).toEqual({ lang: "ko", auto: true });
    expect(pickSubtitle(meta({ language: "en", subtitles: ["ar"], autoCaptions: ["ar", "en-orig"] }))).toEqual({ lang: "en-orig", auto: true });
    expect(pickSubtitle(meta({ subtitles: ["ar"], autoCaptions: ["en", "fr"] }))).toEqual({ lang: "ar", auto: false });
  });
});

describe("paragraphs and time", () => {
  it("groups by ~30s, and joins CJK without spaces", () => {
    const text = paragraphs([
      { start: 0, text: "大家好" },
      { start: 3, text: "今天談工作樹" },
      { start: 31, text: "Next part" },
      { start: 35, text: "continues" },
    ]);
    expect(text).toBe("[0:00] 大家好今天談工作樹\n\n[0:31] Next part continues");
    expect(clock(3725)).toBe("1:02:05");
    expect(timeLink(meta({}), 735.9)).toBe("https://youtu.be/abc123?t=735");
    expect(timeLink(meta({ extractor: "Vimeo" }), 10)).toBeNull();
  });

  it("asks for a summary in the user's words, with linked chapters, and not the transcript itself", () => {
    const p = summaryPrompt({ meta: meta({ title: "Talk" }), source: "auto-generated captions (en-orig)", segments: [], markdown: "# Talk\n\n[0:00] hi" }, "focus on costs");
    expect(p).toContain("Their instructions: focus on costs");
    expect(p).toContain("[12:15](https://youtu.be/abc123?t=735)");
    expect(p).toContain("do not reproduce the transcript");
    expect(p).toContain("machine-generated"); // auto captions: warn about misheard terms
    expect(p).toContain("the language of the user's instructions"); // English instructions -> English

    const linkOnly = summaryPrompt({ meta: meta({}), source: "subtitles (en)", segments: [], markdown: "" }, "");
    expect(linkOnly).toContain("Traditional Chinese (Taiwan usage, 繁體中文)");
    expect(linkOnly).toContain("## 摘要");
    expect(linkOnly).toContain("## 章節");
    expect(summaryPrompt({ meta: meta({}), source: "subtitles (en)", segments: [], markdown: "" }, "重點放在成本")).toContain("## 重點");
  });
});

describe("video task", () => {
  it("needs a URL, and defaults to Codex at medium effort", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-video-"));
    const hub = new Hub({ db: openDb(":memory:"), dataDir: dir, maxConcurrent: 1, agents: { claude: new FakeAdapter(), codex: new FakeAdapter() } });
    await expect(hub.createTask({ title: "", workflow: "video", message: "summarise the talk" })).rejects.toThrow(/URL/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
