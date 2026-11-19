import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal("location", { href: "http://example.invalid/" });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tasks: [], summaries: [] })));
});
afterEach(() => vi.unstubAllGlobals());
it("uses the five room routes with encoded identifiers and preserves message context and images", async () => {
  const { client } = await import("./client");
  const fetcher = vi.mocked(fetch); fetcher.mockClear();
  fetcher.mockImplementation(async () => Response.json({ id: "room", sessions: [], options: {}, workflow: "room" }));
  const input = { documentId: "d/1", brief: "Ideas", claudeModel: "c", codexModel: "g" };
  await client.createRoom(input); await client.findRoom("d/1");
  const message = { text: "Revise", replyTo: { eventId: "E", part: "excerpt" }, selection: { baseRevisionId: "R", startUtf16: 0, endUtf16: 4, originalText: "text" }, images: [{ mime: "image/png" as const, data: "base64" }] };
  await client.sendRoomMessage("r/1", message); await client.roomExchange("r/1"); await client.setRoomBrief("r/1", "New brief");
  expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    ["/api/rooms", "POST"], ["/api/rooms?documentId=d%2F1", "GET"], ["/api/tasks/r%2F1/messages", "POST"], ["/api/tasks/r%2F1/room/exchange", "POST"], ["/api/tasks/r%2F1/room/brief", "PUT"],
  ]);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(input);
  expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string)).toEqual(message);
  expect(JSON.parse(fetcher.mock.calls[4]![1]!.body as string)).toEqual({ brief: "New brief" });
});
it("reuses authentication failure handling", async () => {
  const { client } = await import("./client");
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }));
  await expect(client.findRoom("D")).rejects.toThrow("Unauthorized"); expect(client.connection()).toBe("unauthorized");
});
