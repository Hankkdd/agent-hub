import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rocket } from "lucide-react";
import { FooterButton } from "./sidebar";
import { setLanguage, t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: {}, label: vi.fn() }));

it("footer buttons show an icon with a short caption and keep the full name for screen readers", () => {
  setLanguage("zh-TW");
  const html = renderToStaticMarkup(<FooterButton icon={Rocket} label={t("footer.deploy")} title={t("deploy.title")} />);
  expect(html).toContain("<svg");
  expect(html).toContain(`>${t("footer.deploy")}</span>`);
  expect(html).toContain(`aria-label="${t("deploy.title")}"`);
  expect(renderToStaticMarkup(<FooterButton icon={Rocket} label="x" title="y" active />)).toContain("bg-sidebar-accent text-foreground");
});

it("every footer caption has both translations", () => {
  for (const key of ["footer.devices", "footer.google", "footer.antigravity", "footer.deploy", "footer.languageEn", "footer.languageZh"] as const) {
    setLanguage("zh-TW"); const zh = t(key);
    setLanguage("en"); expect(t(key)).not.toBe(key); expect(zh).not.toBe(key);
  }
  setLanguage("zh-TW");
});
