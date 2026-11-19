import { PhoneBack } from "@/components/phone-back";
import { t, useLanguage } from "@/i18n";
import { defaultAgent, defaultEffort } from "@agent-hub/shared";
import { effortLabel } from "@/components/status";
import { Composer } from "@/components/composer";
import { client, label } from "@/lib/client";

/**
 * A blank chat with the defaults (no dialog): the task is created by the first message, pictures
 * included. For anything else (a repo, a review, a video, another agent) there is New task.
 */
export function NewChat({ onCreated, onBack }: { onBack: () => void; onCreated: (taskId: string) => void }) {
  useLanguage();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b max-md:shrink-0 px-4 py-2.5 max-md:px-2">
        <PhoneBack onBack={onBack} />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">{t("app.newChat")}</h1>
          <div className="text-xs text-muted-foreground max-md:truncate">
            {t("newChat.subtitle", { agent: label(defaultAgent("chat")), effort: effortLabel(defaultEffort("chat")) })}
          </div>
        </div>
      </header>
      <div className="flex flex-1 items-center max-md:min-h-0 max-md:overflow-y-auto justify-center p-6 text-center text-sm text-muted-foreground">
        {t("newChat.empty")}
      </div>
      <Composer
        running={false}
        autoFocus
        placeholder={t("newChat.placeholder")}
        onSend={async (text, images) => {
          const task = await client.createTask({ title: "", workflow: "chat", message: text, images });
          onCreated(task.id);
        }}
      />
    </div>
  );
}
