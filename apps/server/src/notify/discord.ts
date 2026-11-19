/**
 * Two phone notification tiers: LOUD when a task needs the user or fails/is interrupted; SILENT
 * (SUPPRESS_NOTIFICATIONS) when implement, review or video finishes. Chat and plan finishes are omitted:
 * the user usually watches the conversation, and a ping per reply teaches them to mute the channel.
 * Traditional Chinese message text is an approved exception to the repository's English rule,
 * like the UI's zh-TW dictionary. Content uses labelled lines, PR links and task deep links.
 * Delivery is best effort, with no queue or retries.
 */
import type { TaskEvent, TaskReport, TaskStatus } from "@agent-hub/shared";
import type { Hub } from "../core/hub";

interface DiscordOptions {
  webhook?: string;
  mention?: string;
  publicUrl?: string;
  fetch?: typeof fetch;
}

/** Returns an unsubscribe function, or nothing when notifications are disabled. */
export function notifyDiscord(hub: Hub, options: DiscordOptions): (() => void) | undefined {
  const webhook = options.webhook?.trim();
  if (!webhook) return;
  if (!isDiscordWebhook(webhook)) {
    console.warn("Discord notifications disabled: invalid webhook URL");
    return;
  }

  const send = options.fetch ?? fetch;
  const mention = /^\d{1,20}$/.test(options.mention ?? "") ? options.mention : undefined;
  // Hub currently publishes ordinary transitions only as task updates. Track their previous status
  // too, without changing Hub; explicit status_change events advance this map to avoid double sends.
  // This state can be lost on restart: notifications are never replayed, but recovery events are live.
  const statuses = new Map(hub.listTasks().map((task) => [task.id, task.status]));

  async function notify(taskId: string, from: TaskStatus, to: TaskStatus, reason?: string, proposalTitle?: string, report?: TaskReport, question?: string): Promise<void> {
    const loud = question !== undefined || report !== undefined || proposalTitle !== undefined || to === "waiting_user" || to === "failed" || to === "interrupted";
    const finished = from === "running" && (to === "idle" || to === "done");
    const paused = to === "paused";
    if (!loud && !finished && !paused) return;
    const task = hub.getTask(taskId);
    if (task.options.reportsTo && !report) return;
    if (!loud && !paused && !["implement", "review", "video"].includes(task.workflow)) return;

    const prefix = loud && mention ? `<@${mention}> ` : "";
    const label = question !== undefined ? "需要你決定" : report ? ({ ready: "任務完成，等你確認", changes_requested: "任務需要修改，等你確認", failed: "任務失敗，等你確認", interrupted: "任務中斷，等你確認", needs_user: "任務需要你處理", conflict: "PR 衝突，等你決定是否更新", updated: "已更新既有 PR", update_failed: "PR 更新失敗，等你確認", update_interrupted: "PR 更新中斷，等你確認", update_abandoned: "已放棄 PR 更新" }[report.outcome]) : proposalTitle !== undefined ? "規劃完成，等你確認" : to === "waiting_user" ? "需要你處理" : to === "paused" ? "額度用完，暫停等待" : to === "failed" ? "任務失敗" : to === "interrupted" ? "任務中斷" : "完成";
    const description = question !== undefined ? [descriptionLine("問題", question.split(/\r?\n\s*\r?\n/, 1)[0]!, 300)]
      : report ? [reportDescription(report)]
      : proposalTitle !== undefined ? [descriptionLine("提案", proposalTitle, 300)]
      : statusDescription(to, reason, hub.events(taskId), task.title, task.options.quotaPause);
    const pr = report ? report.pr?.url ?? hub.listTasks().find((worker) => worker.id === report.taskId)?.workspace?.pr?.url
      : task.workspace?.pr?.url;
    const content = notificationContent(
      [`${prefix}${label}`, descriptionLine("任務", report?.title ?? task.title), ...description],
      [pr ? `PR：${pr}` : "", taskLink(options.publicUrl, taskId)],
    );
    const response = await send(webhook!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        ...(loud ? {} : { flags: 4096 }),
        allowed_mentions: loud && mention ? { parse: [], users: [mention] } : { parse: [] },
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok) console.warn(`Discord notification failed: HTTP ${response.status}`);
  }

  const reports = new Set(hub.listTasks().flatMap((t) => hub.events(t.id).flatMap((e) => e.type === "task_report" ? [e.id] : [])));
  const asks = new Set(hub.listTasks().flatMap((t) => hub.events(t.id).flatMap((e) => e.type === "ask" ? [e.id] : [])));
  const notifiedTurns = new Set<string>();
  return hub.subscribe((message) => {
    if (message.type === "event" && message.event.type === "ask") {
      const e = message.event;
      if (!e.answer && !e.superseded && !asks.has(e.id)) {
        asks.add(e.id);
        void notify(e.taskId, "running", "running", undefined, undefined, undefined, e.question)
          .catch(() => console.warn("Discord notification failed: no HTTP status"));
      }
      return;
    }
    if (message.type === "event" && message.event.type === "task_report") return;
    if (message.type === "event" && message.event.type === "plan_turn_end") {
      const e = message.event;
      if (e.ask || e.reports.length) notifiedTurns.add(e.taskId);
      for (const id of e.reports) {
        if (reports.has(id)) continue;
        reports.add(id);
        const report = hub.events(e.taskId).find((event) => event.id === id);
        if (!e.ask && report?.type === "task_report") {
          void notify(e.taskId, "running", "running", undefined, undefined, report.report)
            .catch(() => console.warn("Discord notification failed: no HTTP status"));
        }
      }
      return;
    }
    if (message.type === "event" && message.event.type === "task_proposal") {
      // Updating a proposal to Started republishes it; only its initial appearance needs a ping.
      if (!message.event.startedTaskId) {
        void notify(message.event.taskId, "running", "running", undefined, message.event.title)
          .catch(() => console.warn("Discord notification failed: no HTTP status"));
      }
      return;
    }
    let taskId: string;
    let from: TaskStatus | undefined;
    let to: TaskStatus;
    let reason: string | undefined;
    if (message.type === "event" && message.event.type === "status_change") {
      const event = message.event;
      taskId = event.taskId;
      from = event.from;
      to = event.to;
      reason = event.reason;
      if (statuses.get(taskId) === to) return;
    } else if (message.type === "task") {
      taskId = message.task.id;
      from = statuses.get(taskId);
      to = message.task.status;
      reason = message.task.activity ?? undefined;
    } else {
      if (message.type === "task_deleted") statuses.delete(message.taskId);
      return;
    }
    statuses.set(taskId, to);
    if (!from || from === to) return;
    if (to !== "running" && notifiedTurns.delete(taskId)) return;
    // Never log a fetch exception or response body: either could contain the secret webhook URL.
    void notify(taskId, from, to, reason).catch(() => console.warn("Discord notification failed: no HTTP status"));
  });
}

function descriptionLine(label: string, value: string, limit = 1999): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text ? `${label}：${truncate(text, limit)}` : "";
}

function reportDescription(report: TaskReport): string {
  return `結果：${[
    `審查 ${report.rounds} 輪`,
    { passed: "測試通過", failed: "測試失敗", none: "未執行測試" }[report.test],
    `${report.filesChanged} 個檔案 +${report.additions} −${report.deletions}`,
    ...(report.findings.length ? [`${report.findings.length} 項審查意見`] : []),
  ].join("・")}`;
}

function statusDescription(status: TaskStatus, reason: string | undefined, events: TaskEvent[], title: string, pause?: { agent: string; resetsAt: string | null }): string[] {
  const latestTurn = events.filter(event => event.type === "turn_result").at(-1);
  if (status === "failed" && /^(Claude|Codex) usage limit reached$/.test(reason ?? "") && latestTurn?.limit) {
    const { agent, resetsAt } = latestTurn.limit;
    const reset = resetsAt ? new Date(resetsAt) : null;
    const time = reset ? new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset) : null;
    const date = reset && reset.toDateString() !== new Date().toDateString() ? `${reset.getMonth() + 1}/${reset.getDate()} ` : "";
    reason = `${agent === "claude" ? "Claude" : "Codex"} 額度已用完，${time ? `約 ${date}${time} 重置` : "重置時間未知"}`;
  }
  if (status === "paused" && pause) {
    const reset = pause.resetsAt ? new Date(pause.resetsAt) : null;
    const time = reset ? new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset) : null;
    const date = reset && reset.toDateString() !== new Date().toDateString() ? `${reset.getMonth() + 1}/${reset.getDate()} ` : "";
    reason = `${pause.agent === "claude" ? "Claude" : "Codex"} 額度已用完，${time ? `約 ${date}${time} 重置後自動繼續` : "重置時間未知"}`;
  }
  const firstMessage = events.find((event) => event.type === "user_message");
  const firstLine = firstMessage?.type === "user_message"
    ? firstMessage.text.split(/\r?\n/).find((line) => line.trim())?.trim()
    : undefined;
  return [
    reason && ["waiting_user", "failed", "interrupted", "paused"].includes(status) ? descriptionLine("原因", reason, 300) : "",
    firstLine && firstLine.replace(/\s+/g, " ") !== title.replace(/\s+/g, " ").trim() ? descriptionLine("說明", firstLine, 120) : "",
  ];
}

function taskLink(publicUrl: string | undefined, taskId: string): string {
  if (!publicUrl || publicUrl.length > 500) return "";
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.searchParams.set("task", taskId);
    return `開啟：${url.toString()}`;
  } catch {
    return "";
  }
}

function notificationContent(lines: string[], links: string[]): string {
  const suffix = links.filter(Boolean).map((line) => `\n${line}`).join("");
  return truncate(lines.filter(Boolean).join("\n"), 1999 - suffix.length) + suffix;
}

function isDiscordWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.origin === "https://discord.com" || url.origin === "https://discordapp.com")
      && !url.username && !url.password && url.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  // Avoid splitting a surrogate pair when a title or reason includes a character outside the BMP.
  return value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
