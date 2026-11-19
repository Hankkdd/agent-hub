import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("location", { href: "http://example.invalid/" });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tasks: [], summaries: [] })));
});
afterEach(() => vi.unstubAllGlobals());

it("uses all seven typed document routes, encoded IDs, cookie auth and no-store", async () => {
  const { client } = await import("./client");
  const fetcher = vi.mocked(fetch); fetcher.mockClear(); fetcher.mockImplementation(async () => Response.json({}));
  const body = { title: "Fictional SOP", contentFormat: "plain_text" as const, content: "中文😀\r\n" };
  await client.createDocument(body); await client.listDocuments({ limit: 2, offset: 4 });
  await client.getDocument("a/b"); await client.updateDocument("a/b", { ...body, expectedRevisionId: "r5" });
  await client.listDocumentRevisions("a/b", { limit: 3, beforeRevisionNumber: 8 });
  await client.getDocumentRevision("a/b", "r/1"); await client.restoreDocumentRevision("a/b", "r/1", { expectedRevisionId: "r5" });
  expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    ["/api/documents", "POST"], ["/api/documents?limit=2&offset=4", "GET"], ["/api/documents/a%2Fb", "GET"],
    ["/api/documents/a%2Fb", "PUT"], ["/api/documents/a%2Fb/revisions?limit=3&beforeRevisionNumber=8", "GET"],
    ["/api/documents/a%2Fb/revisions/r%2F1", "GET"], ["/api/documents/a%2Fb/revisions/r%2F1/restore", "POST"],
  ]);
  for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(body);
  expect(JSON.parse(fetcher.mock.calls[3]![1]!.body as string).expectedRevisionId).toBe("r5");
});

it.each([400, 401, 404, 409, 413, 415, 500, 503])("exposes safe structured status %i without server body/message/cause", async status => {
  const { client } = await import("./client");
  const revision = "00000000-0000-4000-8000-000000000001";
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "PRIVATE BODY", code: "revision_conflict", currentRevisionId: revision }, { status, headers: { "retry-after": "2" } }));
  await expect(client.getDocument("document")).rejects.toMatchObject({ status, code: "revision_conflict", currentRevisionId: revision, retryAfterSeconds: 2, message: `Document request failed (${status})` });
  if (status === 401) expect(client.connection()).toBe("unauthorized");
});

it("handles bare 401 and removes unrecognized error fields", async () => {
  const { client } = await import("./client");
  vi.mocked(fetch).mockResolvedValueOnce(new Response("PRIVATE BODY", { status: 401 }));
  await expect(client.getDocument("id")).rejects.toMatchObject({ status: 401, code: undefined });
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "private_content", currentRevisionId: "PRIVATE BODY" }, { status: 500, headers: { "retry-after": "PRIVATE BODY" } }));
  await expect(client.getDocument("id")).rejects.toMatchObject({ status: 500, code: undefined, currentRevisionId: undefined, retryAfterSeconds: undefined });
});

it("treats unreadable successful writes as unknown and never automatically retries", async () => {
  const { client } = await import("./client"); const fetcher = vi.mocked(fetch); fetcher.mockClear();
  fetcher.mockResolvedValueOnce(new Response("invalid JSON", { status: 200 }));
  await expect(client.restoreDocumentRevision("id", "r1", { expectedRevisionId: "r2" })).rejects.toMatchObject({ status: 0 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("checks actual encoded request bytes before sending", async () => {
  const { client } = await import("./client"); const fetcher = vi.mocked(fetch); fetcher.mockClear();
  await expect(client.createDocument({ title: "Fictional", contentFormat: "plain_text", content: "\u0001".repeat(400000) })).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("rechecks cookie authentication without discarding document state or adding a token", async () => {
  const { client } = await import("./client");
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(client.getDocument("id")).rejects.toMatchObject({ status: 401 });
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tasks: [], summaries: [] }));
  await client.reconnect();
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("/api/task-list");
});

it("sanitizes rejected transport errors and keeps abort signal on reads", async () => {
  const { client } = await import("./client");
  const abort = new AbortController();
  vi.mocked(fetch).mockRejectedValueOnce(new Error("PRIVATE RAW INPUT"));
  const error = await client.getDocument("id", abort.signal).catch(error => error);
  expect(error).toMatchObject({ status: 0, message: "Document request failed (0)" });
  expect(error).not.toHaveProperty("cause");
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal).toBe(abort.signal);
});
