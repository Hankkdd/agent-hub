import fs from "node:fs";
import path from "node:path";
import { GoogleAccount, GoogleError } from "./auth";
import type { StepReporter, VideoMeta } from "../media/video";

export interface DriveSource {
  fileId: string;
  resourceKey?: string;
}

/** Only explicitly classified Drive failures may reach task events. */
class DriveError extends Error {}

const ID = /^[A-Za-z0-9_-]{10,200}$/;

export function parseDriveUrl(value: string): DriveSource | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.hostname !== "drive.google.com" ||
      url.username || url.password || value.split("/")[2]?.includes("@") ||
      url.port || /%|\\/.test(value.split("?")[0]!)
    ) {
      return null;
    }
    const match = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(?:view|preview|edit))?$/.exec(url.pathname);
    const fileId = match?.[1] ?? (["/open", "/uc"].includes(url.pathname) ? url.searchParams.get("id") : null);
    const resourceKey = url.searchParams.get("resourcekey");
    if (!fileId || !ID.test(fileId) || (resourceKey !== null && !ID.test(resourceKey))) return null;
    // Reject URL-normalized traversal as well as encoded path tricks.
    if (value.split("?")[0]!.split("/").some((part) => part === "." || part === "..")) return null;
    return { fileId, ...(resourceKey !== null ? { resourceKey } : {}) };
  } catch {
    return null;
  }
}

export const DRIVE_SIZE_LIMIT = 2 * 1024 ** 3;
const RESERVE = 512 * 1024 ** 2;

export interface DriveOptions {
  sizeLimit?: number;
  timeoutMs?: number;
  statfs?: typeof fs.promises.statfs;
}

const EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

interface DriveMetadata {
  name?: string;
  mimeType?: string;
  size?: string;
  videoMediaMetadata?: { durationMillis?: string };
  owners?: { displayName?: string }[];
  capabilities?: { canDownload?: boolean };
}

/** Google HTTP happens on the host. Neither endpoint URLs nor credentials enter Docker. */
export async function downloadDrive(
  source: DriveSource,
  google: GoogleAccount,
  dir: string,
  report: StepReporter,
  taskSignal: AbortSignal,
  options: DriveOptions = {},
): Promise<{ meta: VideoMeta; file: string }> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000);
  const signal = AbortSignal.any([taskSignal, timeout]);
  const step = report.step("Google Drive", `download ${source.fileId}`);
  const limit = options.sizeLimit ?? DRIVE_SIZE_LIMIT;
  const headers: Record<string, string> = source.resourceKey
    ? { "X-Goog-Drive-Resource-Keys": `${source.fileId}/${source.resourceKey}` }
    : {};
  const endpoint = `https://www.googleapis.com/drive/v3/files/${source.fileId}`;
  const checked = async (url: string) => {
    signal.throwIfAborted();
    const response = await google.request("drive.read", url, { headers, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const email = google.status().account?.email ?? "the connected Google account";
      if (response.status === 403) throw new DriveError(`no permission to read this file as ${email}`);
      if (response.status === 404) throw new DriveError(`file not found, or not shared with ${email}`);
      throw new DriveError(`Google Drive request failed (${response.status})`);
    }
    return response;
  };

  let file: string | undefined;
  let handle: fs.promises.FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    const fields = "id,name,mimeType,size,videoMediaMetadata(durationMillis)," +
      "owners(displayName),capabilities(canDownload)";
    const response = await checked(`${endpoint}?supportsAllDrives=true&fields=${fields}`);
    const metadata = await response.json().catch(() => {
      throw new DriveError("Invalid Google Drive metadata");
    }) as DriveMetadata;
    const mime = metadata.mimeType ?? "unknown";
    if (!mime.startsWith("video/") && !mime.startsWith("audio/")) {
      throw new DriveError(`Google Drive file is not video or audio (type: ${mime})`);
    }
    if (metadata.capabilities?.canDownload === false) {
      throw new DriveError("the owner disabled downloading for viewers");
    }
    const size = metadata.size === undefined ? null : Number(metadata.size);
    if (size !== null && (!Number.isFinite(size) || size < 0)) {
      throw new DriveError("Invalid Google Drive file size");
    }
    if (size !== null && size > limit) {
      throw new DriveError(`Google Drive file exceeds the ${limit} byte download limit`);
    }
    const disk = await (options.statfs ?? fs.promises.statfs)(dir);
    if (Number(disk.bavail) * Number(disk.bsize) <= (size ?? limit) + RESERVE) {
      throw new DriveError("Not enough disk space for Google Drive download (512 MiB reserve required)");
    }
    file = `source.${EXTENSIONS[mime] ?? "bin"}`;
    handle = await fs.promises.open(path.join(dir, `${file}.part`), "wx", 0o600);
    const media = await checked(`${endpoint}?alt=media&supportsAllDrives=true`);
    if (!media.body) throw new DriveError("Google Drive download has no body");
    reader = media.body.getReader();
    const cancel = () => {
      void reader?.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      let bytes = 0;
      let lastReported = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw new DriveError(`Google Drive stream exceeds the ${limit} byte download limit`);
        await handle.writeFile(chunk.value);
        if (Date.now() - lastReported >= 1000) {
          step.progress(`${bytes} / ${size ?? "?"} bytes`);
          lastReported = Date.now();
        }
      }
      if (size !== null && bytes !== size) {
        throw new DriveError("Google Drive download interrupted (file size mismatch)");
      }
      step.done(`downloaded ${bytes} bytes`);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    await handle.close();
    handle = undefined;
    await fs.promises.rename(path.join(dir, `${file}.part`), path.join(dir, file));
    const duration = Number(metadata.videoMediaMetadata?.durationMillis);
    const meta: VideoMeta = {
      id: source.fileId,
      title: metadata.name ?? "(untitled)",
      uploader: metadata.owners?.[0]?.displayName ?? null,
      duration: Number.isFinite(duration) && duration >= 0 ? duration / 1000 : null,
      url: `https://drive.google.com/file/d/${source.fileId}/view`,
      extractor: "GoogleDrive",
      language: null,
      subtitles: [],
      autoCaptions: [],
    };
    completed = true;
    return { meta, file };
  } catch (err) {
    let message = "Google Drive download interrupted";
    if (taskSignal.aborted) message = "Google Drive download stopped";
    else if (timeout.aborted) message = "Google Drive download timed out";
    else if (err instanceof DriveError || err instanceof GoogleError) message = err.message;
    step.done(message, true);
    throw new Error(message);
  } finally {
    await reader?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    if (file) {
      await fs.promises.rm(path.join(dir, `${file}.part`), { force: true });
      if (!completed) await fs.promises.rm(path.join(dir, file), { force: true });
    }
  }
}
