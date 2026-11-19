import { DocumentWorkspace } from "@/components/document-workspace";
import { DocumentWorkspaceModel } from "@/lib/document-workspace-model";
import { AntigravityDialog } from "@/components/antigravity-dialog";
import { GoogleDialog, GOOGLE_RESULTS, type GoogleResult } from "@/components/google-dialog";
import { useQuota } from "@/components/quota-summary";
import { t, useLanguage } from "@/i18n";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { Sidebar } from "@/components/sidebar";
import { TaskView } from "@/components/task-view";
import { DevicesView } from "@/components/devices-view";
import { NewChat } from "@/components/new-chat";
import { PhoneBack } from "@/components/phone-back";
import { usePhoneNavigation } from "@/lib/use-phone-navigation";
import { cn } from "@/lib/utils";
import { client, useConnection, useTasks } from "@/lib/client";

export function App() {
  useLanguage();
  const tasks = useTasks();
  const connection = useConnection();
  const quota = useQuota(connection === "live" || connection === "reconnecting");
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("task"));
  const [googleResult] = useState<GoogleResult | undefined>(() => {
    const value = new URL(window.location.href).searchParams.get("google");
    return GOOGLE_RESULTS.find((result) => result === value);
  });
  const [antigravityOpen, setAntigravityOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(() => new URL(window.location.href).searchParams.has("google"));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("google")) { url.searchParams.delete("google"); history.replaceState(history.state, "", url); }
  }, []);
  const [newOpen, setNewOpen] = useState(false);
  const { phone, view: navigation, navigate, back } = usePhoneNavigation();
  const navigationView = navigation.screen === "list" || navigation.screen === "task" ? "tasks" : navigation.screen;
  const selectTask = (id: string) => {
    setSelectedId(id);
    navigate({ screen: "task", taskId: id });
  };
  // Until something is picked, show the most recent task.
  const currentId = navigation.screen === "task" ? navigation.taskId : selectedId;
  const selected = tasks.find((t) => t.id === currentId) ?? (currentId ? null : (tasks[0] ?? null));

  const roomTask = navigationView === "tasks" && selected?.workflow === "room" && selected.options.room ? selected : undefined;
  const view = roomTask ? "documents" : navigationView;
  const roomDocumentId = roomTask?.options.room?.documentId;

  const [documents] = useState(() => new DocumentWorkspaceModel(client, client));
  const documentState = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  useEffect(() => documents.setAuthorized(connection !== "unauthorized"), [connection, documents]);
  useEffect(() => {
    if (!documents.protectedDraft() && !documents.hasSuggestionMaterial() && documentState.createUnknown === null) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [documents, documentState.editor, documentState.pending, documentState.createUnknown, documentState.suggestions]);
  if (connection === "unauthorized" && view !== "documents") return <SignIn onDocuments={documentState.editor || documentState.createUnknown !== null || documents.hasSuggestionMaterial() ? () => navigate({ screen: "documents", ...(documentState.editor ? { documentId: documentState.editor.base.id } : {}) }) : undefined} />;

  return (
    <TooltipProvider>
      <div className="app-shell flex h-dvh bg-background text-foreground max-md:overflow-hidden">
        <div className={cn("min-w-0 shrink-0 max-md:h-full max-md:w-full", navigation.screen !== "list" && "max-md:hidden")}>
          <Sidebar
            onDocuments={() => navigate({ screen: "documents", ...(documentState.editor ? { documentId: documentState.editor.base.id } : {}) })}
            documentsOpen={view === "documents"}
            documentsDirty={documents.protectedDraft() || documents.hasSuggestionMaterial() || documentState.createUnknown !== null}
            onGoogle={() => setGoogleOpen(true)}
            onAntigravity={() => setAntigravityOpen(true)}
            quota={quota.state}
            refreshQuota={quota.refresh}
            tasks={tasks}
            selectedId={roomTask?.id ?? (view === "tasks" ? (selected?.id ?? null) : null)}
            connection={connection}
            onSelect={selectTask}
            onNew={() => setNewOpen(true)}
            onNewChat={() => navigate({ screen: "new-chat" })}
            devicesOpen={view === "devices"}
            onDevices={() => navigate({ screen: "devices" })}
          />
        </div>
        <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col", navigation.screen === "list" && "max-md:hidden")}>
          <DocumentWorkspace model={documents} state={documentState} active={view === "documents"} documentId={roomDocumentId ?? (navigation.screen === "documents" ? navigation.documentId : undefined)} initialRoom={roomTask}
            onDocument={documentId => { setSelectedId(null); navigate({ screen: "documents", ...(documentId ? { documentId } : {}) }); }} onBack={back} />
          {view === "documents" ? null : phone && navigation.screen === "list" ? null : view === "new-chat" ? (
            <ErrorBoundary label={t("app.newChat")}>
              <NewChat
                onBack={back}
                onCreated={selectTask}
              />
            </ErrorBoundary>
          ) : view === "devices" ? (
            <ErrorBoundary label={t("app.devices")}>
              <DevicesView onBack={back} />
            </ErrorBoundary>
          ) : selected ? (
            // keyed so switching tasks resets the tab, the scroll position and any caught crash
            <ErrorBoundary key={selected.id} label={t("app.taskView")}>
              <TaskView
                task={selected}
                onSelectTask={selectTask}
                onBack={back}
              />
            </ErrorBoundary>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="md:hidden"><PhoneBack onBack={back} /></div>
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{connection === "connecting" ? t("app.loading") : t("app.noTasks")}</div>
            </div>
          )}
        </main>
      </div>
      <AntigravityDialog open={antigravityOpen} onOpenChange={setAntigravityOpen} />
      <GoogleDialog open={googleOpen} onOpenChange={setGoogleOpen} result={googleResult} />
      <NewTaskDialog
        onGoogle={() => setGoogleOpen(true)}
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={async (input) => {
          const task = await client.createTask(input);
          selectTask(task.id);
        }}
      />
    </TooltipProvider>
  );
}

function SignIn({ onDocuments }: { onDocuments?: () => void }) {
  useLanguage();
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="max-w-md space-y-3 text-sm">
        <h1 className="text-base font-semibold">{t("auth.title")}</h1>
        <p className="text-muted-foreground">
          {t("auth.before")}{" "}
          <code className="rounded bg-muted px-1">{t("auth.tokenQuery")}</code> {t("auth.middle")} <code className="rounded bg-muted px-1">{t("auth.tokenPath")}</code> {t("auth.after")}
        </p>
        {onDocuments && <button className="underline" onClick={onDocuments}>{t("documents.title")}</button>}
      </div>
    </div>
  );
}
