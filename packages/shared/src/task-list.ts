/** Rebuildable sidebar facts; transcripts remain on-demand. */
export interface TaskListSummary {
  taskId: string;
  project: { id: string; name: string } | null;
  pendingAsk: boolean;
  awaitingAcceptance: boolean;
  /**
   * A transcript-only video task (opened through the API) that nobody has written in since: the only
   * user message is the one with the URL. The sidebar keeps these out of the main lists.
   */
  transcriptOnlyUntouched?: boolean;
}
