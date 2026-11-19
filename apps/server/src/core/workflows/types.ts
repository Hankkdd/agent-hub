import type { VideoSourceOptions } from "../../media/video";
import type { FileDiff, Session, Task, TaskEvent, TaskEventPayload, HostInputComponents } from "@agent-hub/shared";
import type { Forge } from "../../workspace/forge";

/** Pictures for a turn, as files on this machine. */
export type TurnImages = { path: string; mime: string }[];

/** How a workflow run ended, for the task's status line. */
export interface Outcome {
  ok: boolean;
  limit?: Extract<TaskEventPayload, { type: "turn_result" }>["limit"];
  error?: string;
  /** What the sidebar says once it is idle, e.g. "Approved in round 2". */
  activity?: string;
  explain?: boolean;
}

/** The callbacks and configuration needed by the extracted workflows. */
export interface WorkflowDeps {
  video?: VideoSourceOptions;
  dataDir: string;
  referenceDirs?: string[];
  forge?: Forge;
  streamAgent(
    task: Task,
    session: Session,
    prompt: string,
    ac: AbortController,
    options: {
      round?: number;
      roomSelection?: import("@agent-hub/shared").RoomSelection;
      systemPrompt: string;
      turnContext?: string;
      readOnly?: boolean;
      referenceDirs?: string[];
      activity?: string;
      images?: TurnImages;
      inputDiagnostics?: HostInputComponents;
    },
  ): Promise<Outcome & { text: string }>;
  session(task: Task, role: Session["role"]): Session;
  append(taskId: string, sessionId: string | null, payload: TaskEventPayload): TaskEvent;
  patch(eventId: string, fields: Record<string, unknown>): void;
  setRunning(taskId: string, activity: string): void;
  publishTask(taskId: string): void;
  updateTitle(taskId: string, title: string): void;
  diff(taskId: string): Promise<FileDiff[]>;
  requests(taskId: string): string[];
  listTasks(): Task[];
  getTask(taskId: string): Task;
  events(taskId: string): TaskEvent[];
  /** Bounded observation of an existing bootstrap event; unavailable diagnostics never block planning. */
  previousProjectBootstrap?(taskId: string, sessionId: string, beforeSeq: number): { eventId: string; output: string } | undefined;
}
