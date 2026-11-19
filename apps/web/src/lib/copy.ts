import { t } from "@/i18n";
/**
 * Copy text. navigator.clipboard exists only in a secure context, and the app is plain http on the
 * tailnet, so fall back to a hidden textarea and execCommand, which still works there.
 */
export async function copyText(text: string): Promise<void> {
  // This is the guarded fallback the lint rule points everyone else to.
  // eslint-disable-next-line no-restricted-properties
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  const focused = document.activeElement as HTMLElement | null;
  const parent = focused?.closest('[role="dialog"]') ?? document.body;
  parent.appendChild(ta);
  try {
    ta.select();
    if (!document.execCommand("copy")) throw new Error(t("copy.failed"));
  } finally {
    ta.remove();
    focused?.focus();
  }
}
