import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("location", { href: "http://example.invalid/" });
  vi.stubGlobal("EventSource", class {
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tasks: [], summaries: [] })));
});

afterEach(() => vi.unstubAllGlobals());

it("preserves API error messages and codes for both reads and commands", async () => {
  const { client, HttpError } = await import("./client");
  const fetcher = vi.mocked(fetch);
  fetcher.mockResolvedValueOnce(Response.json({ error: "fixed server message", code: "storage_error" }, { status: 400 }));
  await expect(client.googleStatus()).rejects.toMatchObject({ message: "fixed server message", code: "storage_error" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "fixed server message", code: "invalid_url" }, { status: 400 }));
  await expect(client.googleComplete("pasted URL")).rejects.toMatchObject({ message: "fixed server message", code: "invalid_url" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "existing caller message" }, { status: 400 }));
  await expect(client.googleConnect("drive.read")).rejects.toThrow("existing caller message");
  expect(new HttpError("message", "failed")).toBeInstanceOf(Error);
});

it("does not invent codes for network failures", async () => {
  const { client } = await import("./client");
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network failure"));
  await expect(client.googleDisconnect()).rejects.toMatchObject({ message: "network failure" });
});
