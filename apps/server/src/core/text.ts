export function firstLine(s: string): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
