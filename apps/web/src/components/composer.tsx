import { t, useLanguage } from "@/i18n";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUp, Loader2, Paperclip, Square, X } from "lucide-react";
import { MAX_IMAGES_PER_MESSAGE, type ImageUpload } from "@agent-hub/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { imagesIn, toUpload, type PendingImage } from "@/lib/images";
import { cn } from "@/lib/utils";

/**
 * Enter sends, Shift+Enter is a newline; IME composition (Chinese input) never sends. Pictures come in
 * by paste, drop, or the paperclip (which on a phone offers the photo library and the camera).
 */
export function Composer(props: {
  room?: boolean;
  initialText?: string;
  draft?: string;
  onDraft?: (value: string) => void;
  quoteBar?: ReactNode;
  running: boolean;
  onSend: (text: string, images: ImageUpload[]) => Promise<void>;
  onStop?: () => Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  useLanguage();
  const [localText, setLocalText] = useState(props.initialText ?? "");
  const text = props.draft ?? localText;
  const setText = props.onDraft ?? setLocalText;
  const [images, setImages] = useState<PendingImage[]>([]);
  const [adding, setAdding] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const [caret, setCaret] = useState(0);
  const localInput = useRef<HTMLTextAreaElement>(null);
  const input = props.inputRef ?? localInput;
  const mention = props.room && !mentionClosed ? /(?:^|\s)@([a-z]*)$/i.exec(text.slice(0, caret)) : null;
  const members = ["claude", "gpt"].filter(m => m.startsWith(mention?.[1]?.toLowerCase() ?? ""));
  const pickMention = (member: string) => {
    const start = text.slice(0, caret).lastIndexOf("@");
    const next = text.slice(0, start) + `@${member} ` + text.slice(caret);
    setText(next); setCaret(start + member.length + 2); setMentionClosed(true); input.current?.focus();
    queueMicrotask(() => input.current?.setSelectionRange(start + member.length + 2, start + member.length + 2));
  };
  const fileInput = useRef<HTMLInputElement>(null);

  const add = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_IMAGES_PER_MESSAGE - images.length;
    if (room <= 0) return setError(t("composer.imageLimit", { count: MAX_IMAGES_PER_MESSAGE }));
    setError(null);
    setAdding((n) => n + Math.min(room, files.length));
    for (const f of files.slice(0, room)) {
      try {
        const img = await toUpload(f);
        setImages((cur) => [...cur, img]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAdding((n) => n - 1);
      }
    }
  };

  const remove = (id: string) =>
    setImages((cur) => {
      const gone = cur.find((i) => i.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      return cur.filter((i) => i.id !== id);
    });

  const canSend = (text.trim() || images.length > 0) && adding === 0;
  const send = async () => {
    if (!canSend) return;
    const t = text.trim();
    const imgs = images;
    setError(null);
    setText("");
    setImages([]);
    try {
      await props.onSend(t, imgs.map(({ mime, data }) => ({ mime, data })));
      imgs.forEach((i) => URL.revokeObjectURL(i.preview));
    } catch (err) {
      // give the draft back so nothing typed or attached is lost
      setText(t);
      setImages(imgs);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className={cn("composer min-w-0 border-t max-md:shrink-0 p-3", dragging && "bg-accent/40")}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        const files = imagesIn(e.dataTransfer);
        if (files.length) {
          e.preventDefault();
          void add(files);
        }
      }}
    >
      <div className="mx-auto max-w-3xl">
        {props.quoteBar}
        {mention && members.length > 0 && <div role="listbox" aria-label={t("room.members")} className="mb-2 rounded border p-1">
          {members.map((m, i) => <button type="button" key={m} role="option" aria-selected={i === mentionIndex % members.length}
            className={cn("block w-full rounded p-2 text-left", i === mentionIndex % members.length && "bg-accent")}
            onMouseDown={e => e.preventDefault()} onClick={() => pickMention(m)}>{m === "claude" ? t("agent.claude") : t("room.gpt")}</button>)}
        </div>}
        {(images.length > 0 || adding > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <div key={img.id} className="relative">
                <img src={img.preview} alt="" className="size-16 rounded-md border object-cover" />
                <button
                  onClick={() => remove(img.id)}
                  className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 shadow-sm"
                  aria-label={t("composer.removePicture")}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {adding > 0 && (
              <div className="flex size-16 items-center justify-center rounded-md border">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Button size="icon" variant="ghost" onClick={() => fileInput.current?.click()} aria-label={t("composer.attachPictures")} title={t("composer.attachHint")}>
            <Paperclip />
          </Button>
          <Textarea
            ref={input}
            value={text}
            autoFocus={props.autoFocus}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setMentionClosed(false); setMentionIndex(0); }}
            onSelect={e => setCaret(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              const files = imagesIn(e.clipboardData);
              if (files.length) {
                e.preventDefault();
                void add(files);
              }
            }}
            onKeyDown={(e) => {
              if (mention && members.length && !e.nativeEvent.isComposing) {
                if (e.key === "Escape") { e.preventDefault(); setMentionClosed(true); return; }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMentionIndex(i => (i + (e.key === "ArrowDown" ? 1 : members.length - 1)) % members.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(members[mentionIndex % members.length]!); return; }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={props.placeholder ?? (props.running ? t("composer.queuedPlaceholder") : t("composer.placeholder"))}
            className="max-h-48 min-h-10 resize-none"
            rows={1}
          />
          {props.running && props.onStop && (
            <Button size="icon" variant="outline" onClick={() => void props.onStop!().catch((err) => setError(String(err)))} aria-label={t("composer.stop")}>
              <Square />
            </Button>
          )}
          <Button size="icon" onClick={() => void send()} disabled={!canSend} aria-label={t("composer.send")}>
            <ArrowUp />
          </Button>
        </div>
        {error && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div>}
      </div>
    </div>
  );
}
