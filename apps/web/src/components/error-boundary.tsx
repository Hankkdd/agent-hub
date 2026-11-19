import { t, useLanguage } from "@/i18n";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Contains a render or effect crash to the region it happened in. Without one, React unmounts the
 * whole tree and the page goes blank with the cause only in the console.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback label={this.props.label} error={this.state.error} onRetry={() => this.setState({ error: null })} />;
  }
}

function ErrorFallback({ label, error, onRetry }: { label: string; error: Error; onRetry: () => void }) {
  useLanguage();
  return (
    <div className="m-4 rounded-lg border border-red-500/50 bg-red-500/5 p-4 text-sm">
      <div className="font-medium">{t("error.crashed", { label })}</div>
      <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">{error.message}</pre>
      <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
        {t("error.retry")}
      </Button>
    </div>
  );
}
