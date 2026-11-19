import type { AgentKind, ProviderQuota, QuotaReading, QuotaResponse } from "@agent-hub/shared";
import type { AgentAdapter } from "../agents/types";

const INTERVAL = 5 * 60_000;
const COOLDOWN = 10_000;
interface Entry {
  reading: QuotaReading;
  updatedAt: number | null;
  attemptedAt: number;
  due: number;
  failures: number;
  flight?: Promise<ProviderQuota>;
  ac?: AbortController;
}
/** One service per Hub's configured adapter/login pair; never writes task events. */
export class QuotaService {
  private entries = new Map<AgentKind, Entry>();
  private closed = false;
  constructor(private agents: Partial<Record<AgentKind, AgentAdapter>>, private now = Date.now) {}

  /** Scheduler decisions can use a recovered cache entry without waiting for other providers. */
  peek(provider: AgentKind): ProviderQuota | undefined {
    const entry = this.entries.get(provider);
    return entry ? this.snapshot(provider, entry) : undefined;
  }

  /** Read only: instrumentation must never refresh shared-account quota. */
  cached(provider: AgentKind): import("@agent-hub/shared").InvocationQuota {
    const entry = this.entries.get(provider);
    if (!entry) return { status: "unknown", sampledAt: null, stale: true, windows: [] };
    const value = this.snapshot(provider, entry);
    return { status: value.status, sampledAt: value.updatedAt, stale: value.stale || value.updatedAt === null,
      windows: value.windows.slice(0, 8).map(w => ({ id: w.id.slice(0, 80), bucket: w.bucket.slice(0, 80),
        durationMins: w.durationMins, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt })) };
  }

  async read(force = false): Promise<QuotaResponse> {
    const [claude, codex] = await Promise.all([this.provider("claude", force), this.provider("codex", force)]);
    // Unlike the two general-purpose agents, Gemini exists only with an available chat adapter.
    const gemini = this.agents.gemini ? await this.provider("gemini", force) : undefined;
    return { claude, codex, ...(gemini ? { gemini } : {}) };
  }
  private snapshot(provider: AgentKind, entry: Entry): ProviderQuota {
    const now = this.now();
    const stale = entry.updatedAt !== null && (now >= entry.updatedAt + INTERVAL || ["error", "unavailable", "missing_login"].includes(entry.reading.status) ||
      entry.reading.windows.some(w => w.resetsAt !== null && Date.parse(w.resetsAt) <= now));
    return { ...entry.reading, provider, updatedAt: entry.updatedAt === null ? null : new Date(entry.updatedAt).toISOString(), stale,
      nextRefreshAt: new Date(entry.due).toISOString(), manualRefreshAt: new Date(entry.attemptedAt + COOLDOWN).toISOString() };
  }
  private provider(provider: AgentKind, force: boolean): Promise<ProviderQuota> {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { reading: { status: "unknown", windows: [] }, updatedAt: null, attemptedAt: -COOLDOWN, due: 0, failures: 0 };
      this.entries.set(provider, entry);
    }
    if (entry.flight) return entry.flight;
    const now = this.now();
    if (this.closed || (force ? now < entry.attemptedAt + COOLDOWN : now < entry.due)) return Promise.resolve(this.snapshot(provider, entry));
    entry.attemptedAt = now;
    entry.ac = new AbortController();
    const current = entry;
    const query = async () => {
      let reading: QuotaReading;
      try { reading = await this.agents[provider]?.queryQuota(current.ac!.signal) ?? { status: "unavailable", windows: [] }; }
      catch { reading = { status: "error", windows: [] }; }
      const completed = this.now();
      if (reading.status === "ok" || reading.status === "unknown") {
        current.reading = reading;
        current.updatedAt = completed;
        current.failures = 0;
        // Ignore already-past resets returned again by the source, preventing a refresh loop.
        const resets = reading.windows.flatMap(w => w.resetsAt && Date.parse(w.resetsAt) > completed ? [Date.parse(w.resetsAt)] : []);
        current.due = Math.max(completed + COOLDOWN, Math.min(completed + INTERVAL, ...resets));
      } else {
        current.reading = { status: reading.status, windows: current.reading.windows };
        current.failures++;
        current.due = completed + Math.min(INTERVAL, 60_000 * 2 ** Math.min(current.failures - 1, 3));
      }
      return this.snapshot(provider, current);
    };
    current.flight = query().finally(() => { current.flight = undefined; current.ac = undefined; });
    return current.flight;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) entry.ac?.abort();
    await Promise.all([...this.entries.values()].map(e => e.flight));
  }
}
