import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { t } from "@/i18n";
import { usePhone } from "@/lib/use-phone";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
const Monaco = lazy(() => import("./document-suggestion-monaco"));
/** No exception messages/causes or private models reach the generic logging boundary. */
class PrivateDiffBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* The fallback is sufficient; do not log editor data or exception causes. */ }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function PlainSuggestionComparison({ original, replacement }: { original: string; replacement: string }) {
  const [side, setSide] = useState<"original" | "replacement">("original");
  return <div data-suggestion-plain="" className="min-h-0 min-w-0 max-w-full space-y-2">
    <div className="flex flex-wrap gap-2"><Button variant={side === "original" ? "default" : "outline"} aria-pressed={side === "original"} onClick={() => setSide("original")}>{t("suggestions.original")}</Button>
      <Button variant={side === "replacement" ? "default" : "outline"} aria-pressed={side === "replacement"} onClick={() => setSide("replacement")}>{t("suggestions.candidate")}</Button></div>
    <Textarea readOnly value={side === "original" ? original : replacement} aria-label={t(side === "original" ? "suggestions.original" : "suggestions.candidate")}
      className="h-64 resize-none overflow-y-auto [field-sizing:fixed] text-base!" />
  </div>;
}
export function DocumentSuggestionDiff({ original, replacement }: { original: string; replacement: string }) {
  const phone = usePhone(), [plain, setPlain] = useState(false);
  const unavailable = useCallback(() => setPlain(true), []);
  const fallback = <PlainSuggestionComparison original={original} replacement={replacement} />;
  if (phone || plain) return <>{plain && <p role="status">{t("suggestions.diffFallback")}</p>}{fallback}</>;
  return <div className="min-h-0 min-w-0 max-w-full space-y-2">
    <Button variant="ghost" size="sm" onClick={unavailable}>{t("suggestions.plain")}</Button>
    <PrivateDiffBoundary fallback={fallback}><Suspense fallback={fallback}><Monaco original={original} replacement={replacement} onUnavailable={unavailable} /></Suspense></PrivateDiffBoundary>
  </div>;
}
