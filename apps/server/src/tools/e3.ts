import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Longer than the limits e3sync applies itself (2 and 10 minutes), so its own error reaches the agent.
const QUERY_TIMEOUT_MS = 150_000;
const DOWNLOAD_TIMEOUT_MS = 660_000;

export interface E3Result {
  text: string;
  isError: boolean;
}

/**
 * Runs the user's e3sync tools on the host. Agents reach them through the tool server because Codex's
 * container has neither the binary nor the E3 cookie, and neither should enter it.
 */
export class E3Tools {
  constructor(private readonly bin: string) {}

  /**
   * One short-lived `e3sync mcp` per call, so a renewed cookie applies at once and nothing outlives a
   * turn. The transport passes only its default environment, never the Hub's tokens or webhook.
   */
  async call(name: "list_assignments" | "list_courses" | "list_materials" | "download_material", args: Record<string, unknown>, signal: AbortSignal): Promise<E3Result> {
    const client = new Client({ name: "agent-hub", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: this.bin, args: ["mcp"], stderr: "ignore" }), { signal });
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: name === "download_material" ? DOWNLOAD_TIMEOUT_MS : QUERY_TIMEOUT_MS,
      });
      const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      return { text, isError: result.isError === true };
    } catch (err) {
      return { text: `e3sync: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
