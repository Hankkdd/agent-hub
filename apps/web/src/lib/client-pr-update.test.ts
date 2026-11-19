import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("location", { href: "http://example.invalid/" });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tasks: [], summaries: [] })));
});
afterEach(() => vi.unstubAllGlobals());
it("sends the exact confirmed source/target observation and preserves API errors", async () => {
  const { client } = await import("./client");
  const revision = { head: "feature/task", headSha: "a".repeat(40), target: "release/v2", targetSha: "b".repeat(40), crossRepository: false };
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ stage: "noop" }));
  expect(await client.updatePr("worker", revision)).toEqual({ stage: "noop" });
  expect(fetch).toHaveBeenLastCalledWith("/api/tasks/worker/pr/update", expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true, revision }) }));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Approve in the original planner" }, { status: 409 }));
  await expect(client.updatePr("worker", revision)).rejects.toThrow("Approve in the original planner");
});

it("starts an explicitly confirmed abandonment and preserves refusal errors", async () => {
  const { client } = await import("./client");
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "abandon-operation", stage: "abandoning" }, { status: 202 }));
  expect(await client.abandonPrUpdate("worker")).toMatchObject({ id: "abandon-operation", stage: "abandoning" });
  expect(fetch).toHaveBeenLastCalledWith("/api/tasks/worker/pr/abandon-update", expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true }) }));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Reconcile uncertain publication first" }, { status: 409 }));
  await expect(client.abandonPrUpdate("worker")).rejects.toThrow("Reconcile uncertain publication first");
});
