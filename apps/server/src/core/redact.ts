/** Shared secret redaction for host and task logs. */
export function redactSecrets(output: string, hubToken: string | null): string {
  const trimmedToken = hubToken?.trim();
  if (trimmedToken) {
    if (hubToken && hubToken !== trimmedToken) output = output.split(hubToken).join("[redacted]");
    output = output.split(trimmedToken).join("[redacted]");
  }
  output = output.replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
    try {
      const url = new URL(value);
      if ([...url.searchParams.keys()].some((key) => /^(?:code|access_token|refresh_token|id_token|token|state)$/i.test(key)))
        return `${url.origin}[redacted]`;
    } catch { /* Leave non-URLs to the remaining redactors. */ }
    return value;
  });
  output = output
    .replace(/Authorization:\s*[^\r\n]+/gi, "Authorization: [redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\S+/gi, "[redacted]")
    .replace(/((["'])(?:token|secret|password|api[_-]?key|access_token|refresh_token|id_token|client_secret)\2\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      (_match, prefix: string, _keyQuote: string, value: string) => `${prefix}${value[0]}[redacted]${value[0]}`)
    .replace(/\b(token|secret|password|api[_-]?key|access_token|refresh_token|id_token|client_secret)=\S+/gi, "$1=[redacted]");
  return output.replace(/\b(Set-Cookie|Cookie):[^\r\n]*/gi, "$1: [redacted]");
}
