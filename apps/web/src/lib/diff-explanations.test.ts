import { describe, expect, it } from "vitest";
import { matchingHunks } from "./diff-explanations";

const hunk = (start: number, lines = 5) => ({ id: `file:${start}:${start}`, path: "file", oldStart: start, oldLines: lines, newStart: start, newLines: lines });
describe("Monaco block to git hunk mapping", () => {
  it("matches split Monaco blocks against the same git context range", () => {
    const hunks = [hunk(1, 10), hunk(30)];
    for (const start of [2, 6]) expect(matchingHunks({ originalStartLineNumber: start, originalEndLineNumber: start, modifiedStartLineNumber: start, modifiedEndLineNumber: start }, hunks)).toEqual([hunks[0]]);
  });
  it("shows all hunks intersecting a combined Monaco block in source order", () => {
    expect(matchingHunks({ originalStartLineNumber: 3, originalEndLineNumber: 24, modifiedStartLineNumber: 3, modifiedEndLineNumber: 24 }, [hunk(20), hunk(1), hunk(50)])).toEqual([hunk(1), hunk(20)]);
  });
  it("uses the original side for pure deletions, including deleted files", () => {
    const deletion = { ...hunk(1), newStart: 0, newLines: 0 };
    expect(matchingHunks({ originalStartLineNumber: 1, originalEndLineNumber: 5, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }, [deletion])).toEqual([deletion]);
  });
  it("matches additions against the modified side and ignores non-overlapping hunks", () => {
    const addition = { ...hunk(1), oldStart: 0, oldLines: 0 };
    expect(matchingHunks({ originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 3 }, [addition, hunk(10)])).toEqual([addition]);
  });
});
