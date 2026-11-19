import type { DiffHunk } from "@agent-hub/shared";

export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Git includes context; Monaco groups only changes, sometimes combining several git hunks. */
export function matchingHunks(change: LineChange, hunks: Omit<DiffHunk, "patch">[]): Omit<DiffHunk, "patch">[] {
  const deletion = change.modifiedEndLineNumber === 0;
  const start = deletion ? change.originalStartLineNumber : change.modifiedStartLineNumber;
  const end = deletion ? change.originalEndLineNumber : change.modifiedEndLineNumber;
  const overlap = (h: Omit<DiffHunk, "patch">) => {
    const hStart = deletion ? h.oldStart : h.newStart;
    const lines = deletion ? h.oldLines : h.newLines;
    return lines ? Math.max(0, Math.min(end, hStart + lines - 1) - Math.max(start, hStart) + 1) : 0;
  };
  // All intersecting hunks belong to this block. Their source order is the reading order.
  return hunks.filter((h) => overlap(h) > 0).sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart);
}
