import type { JobHandler } from "@/server/jobs";

/** What the Owner is told when a task has failed for good. */
export type FailureNotice = {
  title: string;
  body: string;
  link?: string | null;
  /** Notification type; "task.failed" when not given. */
  type?: string;
};

export type JobDefinition = {
  handler: JobHandler;
  /** How the task is named in plain words, e.g. "The import". */
  label: string;
  /** What the Owner can do when it has failed for good, e.g. "Open Import and try again." */
  whatToDo: string;
  /** Page to open from the notification. */
  link?: string | null;
  /** A custom notification for the final failure (instead of "A background task failed"). */
  failureNotice?: (payload: unknown, error: string) => FailureNotice;
};

/** Job type (e.g. "backup.run") → how to run it. */
export type JobRegistry = Readonly<Record<string, JobDefinition>>;
