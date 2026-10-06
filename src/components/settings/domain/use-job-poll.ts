"use client";

import { useEffect, useRef } from "react";

/** The fields of GET /api/jobs/:id the settings pages use (see toPublicJob in src/server/jobs.ts). */
export type PolledJob = {
  id: number;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  progressDone: number;
  progressTotal: number;
  summary: string | null;
  error: string | null;
  /** A queued job that waits until this instant (ISO), e.g. a check run deferred after a rate limit. */
  waitingUntil?: string | null;
};

export const JOB_POLL_MS = 2_000;

/**
 * Follows a background task (GET /api/jobs/:id every 2 s) while `jobId` is set: `onProgress` runs whenever its progress
 * or status changes, `onDone` once when it has finished (done, failed or cancelled). Stops on unmount.
 */
export function useJobPoll(
  jobId: number | null,
  handlers: { onProgress?: (job: PolledJob) => void; onDone: (job: PolledJob | null) => void },
): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    if (jobId === null) return;
    let stopped = false;
    let last = "";
    let failures = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (stopped) return;
        if (!res.ok) {
          stopped = true;
          ref.current.onDone(null);
          return;
        }
        const job = (await res.json()) as PolledJob;
        failures = 0;
        const key = `${job.status}:${job.progressDone}/${job.progressTotal}`;
        if (key !== last) {
          last = key;
          ref.current.onProgress?.(job);
        }
        if (job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELLED") {
          stopped = true;
          ref.current.onDone(job);
        }
      } catch {
        // The office network blinked: keep trying for a while, then give up quietly.
        failures += 1;
        if (failures >= 15 && !stopped) {
          stopped = true;
          ref.current.onDone(null);
        }
      }
    };
    void tick();
    const timer = setInterval(() => {
      if (!stopped) void tick();
    }, JOB_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobId]);
}
