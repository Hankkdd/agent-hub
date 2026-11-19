import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IMAGE_MIME, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, type ImageAttachment, type ImageUpload } from "@agent-hub/shared";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const FILE = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export class AttachmentError extends Error {}

/**
 * Pictures live in <dataDir>/attachments/<taskId>/, NOT in the task's working directory: in a worktree
 * task they would otherwise be committed with the agent's change and show up in the diff.
 */
export function attachmentsDir(dataDir: string, taskId: string): string {
  return path.join(dataDir, "attachments", taskId);
}

/** Check uploaded pictures without storing them. The bytes must really be the type they claim. */
export function validateImages(uploads: ImageUpload[] | undefined): Buffer[] {
  if (!uploads?.length) return [];
  if (uploads.length > MAX_IMAGES_PER_MESSAGE) throw new AttachmentError(`at most ${MAX_IMAGES_PER_MESSAGE} pictures per message`);
  return uploads.map((u) => {
    if (!(IMAGE_MIME as readonly string[]).includes(u.mime)) throw new AttachmentError(`unsupported picture type ${u.mime}; use PNG, JPEG, GIF or WebP`);
    const bytes = Buffer.from(u.data, "base64");
    if (bytes.length === 0) throw new AttachmentError("empty picture");
    if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError(`picture too large (${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB)`);
    if (!looksLike(bytes, u.mime)) throw new AttachmentError(`the file is not a ${u.mime} picture`);
    return bytes;
  });
}

/** Validate and store uploaded pictures. */
export function saveImages(dataDir: string, taskId: string, uploads: ImageUpload[] | undefined): ImageAttachment[] {
  const all = validateImages(uploads);
  if (all.length === 0) return [];
  const dir = attachmentsDir(dataDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return all.map((bytes, i) => {
    const mime = uploads![i]!.mime;
    const file = `${randomUUID()}.${EXT[mime]}`;
    fs.writeFileSync(path.join(dir, file), bytes);
    return { file, mime, size: bytes.length };
  });
}

/** Absolute path of a stored picture, or null if the name is not one of ours (no path tricks). */
export function attachmentPath(dataDir: string, taskId: string, file: string): string | null {
  if (!FILE.test(file)) return null;
  const p = path.join(attachmentsDir(dataDir, taskId), file);
  return fs.existsSync(p) ? p : null;
}

function looksLike(b: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return b.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp":
      return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}

/** Resolve only host-owned same-task historical pictures, without following aliases. */
export function historicalImage(dataDir: string, taskId: string, a: ImageAttachment): string | null {
  if (!FILE.test(a.file) || !(IMAGE_MIME as readonly string[]).includes(a.mime)) return null;
  const root = path.resolve(dataDir, "attachments");
  const dir = path.join(root, taskId);
  const file = path.join(dir, a.file);
  try {
    if (path.dirname(dir) !== root || fs.lstatSync(root).isSymbolicLink() ||
      fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== path.join(fs.realpathSync(root), taskId)) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || stat.size !== a.size) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== a.size) return null;
      const bytes = Buffer.alloc(a.size);
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== a.size || fs.fstatSync(fd).size !== a.size) return null;
      return looksLike(bytes, a.mime) ? file : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
