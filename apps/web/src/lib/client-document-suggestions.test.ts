import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal("location", { href: "http://example.invalid/" }); vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tasks: [], summaries: [] })));
});
afterEach(() => vi.unstubAllGlobals());
it("uses five typed routes with encoded identities, no-store/auth and stable exact payload", async () => {
  const { client } = await import("./client"); const fetcher = vi.mocked(fetch); fetcher.mockClear(); fetcher.mockImplementation(async () => Response.json({}));
  const body = { importRequestId: "stable-request-key", source: "manual_import" as const, baseRevisionId: "r1", selection: { startUtf16: 1, endUtf16: 3, originalText: "😀" }, replacementText: "中文\n " };
  await client.importDocumentSuggestion("a/b", body); await client.listDocumentSuggestions("a/b", { limit: 2, offset: 4, status: "pending", importRequestId: "key/slash" });
  await client.getDocumentSuggestion("a/b", "s/1"); await client.acceptDocumentSuggestion("a/b", "s/1", { expectedRevisionId: "r1" }); await client.rejectDocumentSuggestion("a/b", "s/1");
  expect(fetcher.mock.calls.map(([u]) => u)).toEqual(["/api/documents/a%2Fb/suggestions", "/api/documents/a%2Fb/suggestions?limit=2&offset=4&status=pending&importRequestId=key%2Fslash", "/api/documents/a%2Fb/suggestions/s%2F1", "/api/documents/a%2Fb/suggestions/s%2F1/accept", "/api/documents/a%2Fb/suggestions/s%2F1/reject"]);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(body);
  for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
});
it.each(["import_key_conflict", "selection_mismatch", "suggestion_rejected", "suggestion_already_accepted", "lf_required", "no_change"])("keeps allowlisted code %s but never exposes response text", async code => {
  const { client } = await import("./client"); vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code, error: "FICTIONAL_PRIVATE_TEXT" }, { status: 409 }));
  await expect(client.acceptDocumentSuggestion("d", "s", { expectedRevisionId: "r1" })).rejects.toMatchObject({ status: 409, code, message: "Document request failed (409)" });
});
it("bare 401 preserves auth signal and unreadable success is unknown without retries", async () => {
  const { client } = await import("./client"); const fetcher = vi.mocked(fetch); fetcher.mockClear();
  fetcher.mockResolvedValueOnce(new Response("bad ack", { status: 200 }));
  await expect(client.acceptDocumentSuggestion("d", "s", { expectedRevisionId: "r1" })).rejects.toMatchObject({ status: 0 }); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(new Response("private", { status: 401 }));
  await expect(client.listDocumentSuggestions("d")).rejects.toMatchObject({ status: 401 }); expect(client.connection()).toBe("unauthorized");
});
