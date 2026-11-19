import type { QuotaResponse } from "@agent-hub/shared";

export interface QuotaState { data: QuotaResponse | null; loading: boolean; error: boolean; now: number }
interface Visibility {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
/** A single visible-document timer drives countdowns and due queries; cleanup suppresses late responses. */
export function quotaScheduler(doc: Visibility, query: (force: boolean) => Promise<QuotaResponse>, update: (state: QuotaState) => void) {
  let data: QuotaResponse | null = null;
  let loading = false;
  let error = false;
  let stopped = false;
  let due = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  const emit = () => { if (!stopped) update({ data, loading, error, now: Date.now() }); };
  const schedule = () => {
    clearTimeout(timer);
    if (stopped || doc.visibilityState !== "visible" || loading) return;
    const now = Date.now();
    const boundaries = Object.values(data ?? {}).flatMap(p => [Date.parse(p.manualRefreshAt),
      ...p.windows.flatMap(w => w.resetsAt ? [Date.parse(w.resetsAt)] : [])]).filter(time => time > now);
    timer = setTimeout(tick, Math.max(250, Math.min(30_000, due - now, ...boundaries.map(time => time - now))));
  };
  const refresh = (force = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (flight) return flight;
    loading = true; emit(); clearTimeout(timer);
    flight = query(force).then(result => {
      if (stopped) return;
      data = result; error = false; failures = 0;
      due = Math.max(Date.now() + 1_000, Math.min(...Object.values(result).map(p => Date.parse(p.nextRefreshAt))));
    }).catch(() => {
      if (stopped) return;
      error = true;
      due = Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(failures++, 3));
    }).finally(() => { loading = false; flight = undefined; emit(); schedule(); });
    return flight;
  };
  function tick() {
    clearTimeout(timer);
    if (stopped || doc.visibilityState !== "visible") return;
    emit();
    if (Date.now() >= due) void refresh();
    else schedule();
  }
  doc.addEventListener("visibilitychange", tick);
  // Initialization is authenticated by the caller, even when the tab starts hidden.
  void refresh();
  return { refresh, dispose() { stopped = true; clearTimeout(timer); doc.removeEventListener("visibilitychange", tick); } };
}
