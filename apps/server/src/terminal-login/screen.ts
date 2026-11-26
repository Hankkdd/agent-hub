import xterm from "@xterm/headless";
import { TERMINAL_SIZE } from "./terminal";
const { Terminal } = xterm;

export class LoginScreen {
  private terminal = new Terminal({ ...TERMINAL_SIZE, scrollback: 0, allowProposedApi: true });
  private pending = Promise.resolve();
  private queued = 0;
  private hidden: string[] = [];
  hide(text: string) { if (text) this.hidden.push(text); }
  write(data: Buffer) {
    // Bound queued output as well as the terminal's scrollback; a noisy CLI cannot retain a transcript.
    if (this.queued + data.length > 256 * 1024) return;
    this.queued += data.length;
    this.pending = this.pending.then(() => new Promise<void>(resolve => {
      this.terminal.write(data, () => { this.queued -= data.length; resolve(); });
    }));
  }
  async read() {
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.viewportY; i < buffer.viewportY + TERMINAL_SIZE.rows; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    let text = lines.join("\n");
    // Some TUIs insert hard newlines inside links instead of letting the terminal soft-wrap.
    // Only whole URL-character lines qualify; prose with internal spaces must remain separate.
    const continuation = /(https:\/\/[^\s<>"'`]+)[ \t]*\n[ \t]*([A-Za-z0-9._~%!$&()*+,;=:@/?#\[\]\-]+)[ \t]*(?=\n|$)/g;
    let joined = text.replace(continuation, "$1$2");
    while (joined !== text) {
      text = joined;
      joined = text.replace(continuation, "$1$2");
    }
    for (const hidden of this.hidden) text = text.split(hidden).join("[REDACTED]");
    const links: string[] = [];
    // Protect whole HTTPS URLs while redacting token-like runs elsewhere, including soft wraps.
    text = text.replace(/https:\/\/[^\s<>"'`]+|(?:ya29\.|1\/\/)[A-Za-z0-9._~+\/-]+|[A-Za-z0-9_+\/-]{40,}={0,2}/g, value => {
      if (value.startsWith("https://")) {
        try { const url = new URL(value); if (!url.username && !url.password) { links.push(url.href); return value; } } catch { /* redact malformed links */ }
      }
      return "[REDACTED]";
    });
    return { screen: text.split("\n"), links: [...new Set(links)] };
  }
  async dispose() { await this.pending; this.terminal.dispose(); this.hidden = []; }
}
