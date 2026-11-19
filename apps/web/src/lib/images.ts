import { t } from "@/i18n";
import { IMAGE_MIME, MAX_IMAGE_BYTES, type ImageUpload } from "@agent-hub/shared";

/** A picture picked or pasted in the composer, ready to send, with a preview URL for the thumbnail. */
export interface PendingImage extends ImageUpload {
  id: string;
  preview: string;
}

// Not crypto.randomUUID: that exists only in a secure context, and the app is served over plain http on
// the tailnet, where it threw and no picture could be added. This id only keys thumbnails.
let seq = 0;

/** Longest side sent to the model. Models scale pictures down anyway; a phone photo is ~4000px and several MB. */
const MAX_SIDE = 2048;

/** Turn a File into an upload: large pictures are scaled down (as JPEG) in the browser first. */
export async function toUpload(file: File): Promise<PendingImage> {
  if (!file.type.startsWith("image/")) throw new Error(t("images.notPicture", { name: file.name || t("images.unnamed") }));
  let blob: Blob = file;
  let mime = file.type;
  const needsResize = !(IMAGE_MIME as readonly string[]).includes(mime) || file.size > 1_500_000 || (await longestSide(file)) > MAX_SIDE;
  if (needsResize) {
    blob = await downscale(file);
    mime = "image/jpeg";
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(t("images.tooLarge"));
  return { id: `img-${++seq}`, mime, data: await base64(blob), preview: URL.createObjectURL(blob) };
}

/** Pictures in a paste or drop, if any. */
export function imagesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter((f) => f.type.startsWith("image/"));
}

async function longestSide(file: Blob): Promise<number> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return 0;
  const side = Math.max(bmp.width, bmp.height);
  bmp.close();
  return side;
}

async function downscale(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("images.encodeFailed")))), "image/jpeg", 0.85));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
