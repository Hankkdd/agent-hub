export function clampWidth(width: number, min: number, max: number, viewportWidth: number): number {
  return Math.min(Math.max(width, min), max, viewportWidth * 0.6);
}

export function readWidth(key: string, defaultWidth: number): number {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && saved.trim() !== "") {
      const width = Number(saved);
      if (Number.isFinite(width) && width > 0) return width;
    }
  } catch {
    // Storage is optional, including when access to localStorage itself is blocked.
  }
  return defaultWidth;
}

export function saveWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // Resizing must still work when storage is unavailable or full.
  }
}
