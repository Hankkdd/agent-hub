import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { DeployStatus } from "@agent-hub/shared";
import { setLanguage, t } from "@/i18n";
import { DeployDialog, deployDisabledReason } from "./deploy-dialog";

const harness = vi.hoisted(() => ({ status: null as DeployStatus | null, cursor: 0 }));
vi.mock("@/lib/client", () => ({ client: {} }));
vi.mock("@/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => react.useState(harness.cursor++ === 0 ? harness.status : initial) };
});
vi.mock("./ui/dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Dialog: Wrapper, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper, DialogDescription: Wrapper };
});
const status: DeployStatus = {
  enabled: true, current: { sha: "a".repeat(40), subject: "Current subject" },
  target: { sha: "b".repeat(40), subject: "Target subject" }, pending: [{ sha: "b".repeat(40), subject: "Target subject" }],
  dirty: false, last: null, history: null, deploying: false,
};
function render(next: DeployStatus | null) {
  harness.status = next; harness.cursor = 0;
  return renderToStaticMarkup(<DeployDialog open onOpenChange={() => {}} tasks={[]} />);
}
it.each(["en", "zh-TW"] as const)("renders localized disabled reasons and disables confirmation in %s", (language) => {
  setLanguage(language);
  for (const reason of ["not_enabled", "not_git_checkout", "unit_not_installed"] as const) {
    const html = render({ ...status, enabled: false, disabledReason: reason });
    expect(html).toContain(t(`deploy.${reason}`));
    expect(html).toContain('disabled=""');
  }
  const html = render({ ...status, dirty: true });
  expect(html).toContain(t("deploy.dirty"));
  expect(html).toContain("aaaaaaaa"); expect(html).toContain("Current subject");
  expect(html).toContain("bbbbbbbb"); expect(html).toContain("Target subject");
  expect(render(status)).not.toContain('disabled=""');
  setLanguage("zh-TW");
});
it("covers loading, active tasks, empty pending lists and deployment locks", () => {
  expect(deployDisabledReason(null, [], false)).toBe("deploy.loading");
  for (const state of ["running", "waiting_user"] as const) expect(deployDisabledReason(status, [{ status: state }], false)).toBe("deploy.tasks");
  expect(deployDisabledReason({ ...status, pending: [] }, [], false)).toBe("deploy.empty");
  expect(deployDisabledReason({ ...status, deploying: true }, [], false)).toBe("deploy.running");
  expect(deployDisabledReason(status, [], true)).toBe("deploy.running");
});
it("renders a scrollable failure log and a completed deploy SHA", () => {
  const html = render({ ...status, last: { sha: "c".repeat(40), requestedAt: "", outcome: "failed", log: "build failed\nlast log line" } });
  expect(html).toContain("cccccccc"); expect(html).toContain("build failed\nlast log line");
  expect(html).toMatch(/<pre[^>]*overflow-auto/);
});
