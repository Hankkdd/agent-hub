import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { attachmentPath, saveImages } from "../src/core/attachments";
import { openDb } from "../src/db/index";

// A real 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-att-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("saveImages", () => {
  it("stores real pictures and refuses everything else", () => {
    const [a] = saveImages(dir, "t1", [{ mime: "image/png", data: PNG }]);
    expect(a).toMatchObject({ mime: "image/png", size: 70, file: expect.stringMatching(/\.png$/) });
    expect(fs.existsSync(attachmentPath(dir, "t1", a!.file)!)).toBe(true);

    expect(() => saveImages(dir, "t1", [{ mime: "image/svg+xml", data: PNG }])).toThrow(/unsupported/);
    expect(() => saveImages(dir, "t1", [{ mime: "image/jpeg", data: PNG }])).toThrow(/not a image\/jpeg/); // PNG bytes claiming JPEG
    expect(() => saveImages(dir, "t1", [{ mime: "image/png", data: Buffer.from("not a png").toString("base64") }])).toThrow(/not a image\/png/);
    expect(() => saveImages(dir, "t1", Array(7).fill({ mime: "image/png", data: PNG }))).toThrow(/at most 6/);
  });

  it("serves only its own file names", () => {
    expect(attachmentPath(dir, "t1", "../../token")).toBeNull();
    expect(attachmentPath(dir, "t1", "x.png")).toBeNull();
  });
});

describe("pictures in a conversation", () => {
  it("go to the agent with the message, queue with it, and work without text", async () => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = new Hub({ db: openDb(":memory:"), dataDir: dir, maxConcurrent: 2, flushMs: 1, agents: { codex: agent } });
    const task = await hub.createTask({ title: "", workflow: "chat", message: "what is this?", images: [{ mime: "image/png", data: PNG }] });
    await new Promise((r) => setTimeout(r, 5));
    hub.sendMessage(task.id, "", [{ mime: "image/png", data: PNG }, { mime: "image/png", data: PNG }]); // queued, picture only
    agent.release();
    await hub.settled(task.id);

    expect(agent.runs[0]!.images).toHaveLength(1);
    expect(agent.runs[0]!.prompt).toBe("what is this?");
    expect(agent.runs[1]!.images).toHaveLength(2);
    expect(agent.runs[1]!.prompt).toBe("(see the attached picture)");
    const first = hub.events(task.id).find((e) => e.type === "user_message")!;
    expect(first.type === "user_message" && first.images?.[0]?.mime).toBe("image/png");
    expect(fs.existsSync(agent.runs[0]!.images![0]!.path)).toBe(true);
    // stored outside the working directory, so a worktree diff never picks them up
    expect(agent.runs[0]!.images![0]!.path.startsWith(hub.getTask(task.id).cwd!)).toBe(false);

    await hub.deleteTask(task.id);
    expect(fs.existsSync(path.join(dir, "attachments", task.id))).toBe(false);
  });

  it("rejects a bad picture without recording the message", async () => {
    const hub = new Hub({ db: openDb(":memory:"), dataDir: dir, maxConcurrent: 2, agents: { codex: new FakeAdapter() } });
    await expect(hub.createTask({ title: "", workflow: "chat", message: "x", images: [{ mime: "image/png", data: "AAAA" }] })).rejects.toThrow(/not a image\/png/);
    expect(hub.listTasks()).toEqual([]); // nothing half-created
  });
});
