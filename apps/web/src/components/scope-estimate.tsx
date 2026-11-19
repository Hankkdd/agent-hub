import { scopeExceeded, type ScopeEstimate as Estimate } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";

export function estimateInput(maxFiles: string, maxChangedLines: string): Estimate | null {
  const parse = (s: string) => {
    if (!s.trim()) return undefined;
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) <= 0) throw new Error("Invalid estimate");
    return Number(s);
  };
  const files = parse(maxFiles), lines = parse(maxChangedLines);
  return files === undefined && lines === undefined ? null : { ...(files === undefined ? {} : { maxFiles: files }), ...(lines === undefined ? {} : { maxChangedLines: lines }) };
}

/** Shared presentation for desktop, phone, persisted snapshots and parent reports. */
export function ScopeEstimate({ estimate, filesChanged, additions, deletions, binaryFiles = 0 }: {
  estimate?: Estimate; filesChanged: number; additions: number; deletions: number; binaryFiles?: number;
}) {
  useLanguage();
  const exceeded = scopeExceeded(estimate, { filesChanged, additions, deletions });
  return <div className="text-xs" role={exceeded ? "status" : undefined}>
    <span>{t("scope.actual", { files: filesChanged, lines: additions + deletions })}</span>
    {estimate?.maxFiles !== undefined && <span> · {t("scope.filesEstimate", { count: estimate.maxFiles })}</span>}
    {estimate?.maxChangedLines !== undefined && <span> · {t("scope.linesEstimate", { count: estimate.maxChangedLines })}</span>}
    {binaryFiles > 0 && <div>{t("scope.binary", { count: binaryFiles })}</div>}
    {exceeded && <div className="text-amber-700 dark:text-amber-400">{t("scope.warning")}</div>}
  </div>;
}
