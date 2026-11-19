import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { t, useLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import { clampWidth, readWidth, saveWidth } from "@/lib/resizable-width";

export function ResizablePanel({ children, className, storageKey, defaultWidth, minWidth, maxWidth, side = "right" }: {
  side?: "left" | "right";
  children: ReactNode;
  className?: string;
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}) {
  useLanguage();
  const [preferredWidth, setPreferredWidth] = useState(() => readWidth(storageKey, defaultWidth));
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const width = clampWidth(preferredWidth, minWidth, maxWidth, viewportWidth);

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function updateWidth(next: number) {
    const bounded = clampWidth(next, minWidth, maxWidth, window.innerWidth);
    setPreferredWidth(bounded);
    saveWidth(storageKey, bounded);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointerId === event.pointerId) {
      updateWidth(current.startWidth + (event.clientX - current.startX) * (side === "left" ? -1 : 1));
    }
  }

  return (
    <div
      className={cn("relative min-w-0 shrink-0 md:w-[var(--panel-width)] md:max-w-full", className)}
      style={{ "--panel-width": `${width}px` } as CSSProperties}
    >
      {children}
      <div
        role="separator"
        aria-label={t("panel.resize")}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={Math.min(maxWidth, viewportWidth * 0.6)}
        aria-valuenow={width}
        tabIndex={0}
        className={cn("absolute inset-y-0 z-10 hidden w-1.5 touch-none cursor-col-resize select-none hover:bg-ring/40 focus-visible:bg-ring/40 focus-visible:outline-none md:block", side === "left" ? "left-0" : "right-0")}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: event.currentTarget.parentElement!.getBoundingClientRect().width };
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          move(event);
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => updateWidth(defaultWidth)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home") {
            event.preventDefault();
            updateWidth(event.key === "Home" ? defaultWidth : width + (event.key === "ArrowLeft" ? -10 : 10));
          }
        }}
      />
    </div>
  );
}
