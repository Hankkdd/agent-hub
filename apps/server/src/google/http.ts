import type { GoogleErrorCode } from "@agent-hub/shared";

export class GoogleError extends Error {
  constructor(readonly code: GoogleErrorCode, message: string) {
    super(message);
  }
}

/** No response text or transport errors escape: either can include credentials. */
export class GoogleHttp {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new GoogleError("failed", "Google network destination refused");
    }
    if (
      !["https://oauth2.googleapis.com", "https://www.googleapis.com"].includes(u.origin) ||
      u.username || u.password
    ) {
      throw new GoogleError("failed", "Google network destination refused");
    }

    let response: Response;
    try {
      response = await this.fetcher(u.href, {
        ...init,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GoogleError("failed", "Google request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new GoogleError("failed", "Google redirect refused");
    }
    return response;
  }
}
