import type { JobHandler } from "@/server/jobs";
import { evaluateWarmupDays } from "@/server/services/sending/warmup-days";
import { recordTaskSuccess } from "../periodic";
import type { JobDefinition } from "./types";

/**
 * Job "warmup.evaluate" (M3-DESIGN §4.3.8, §4.6): the hourly look at closed cap days for the
 * warm-up ramp (queued by the periodic task "warmup.hourly"). The same evaluation also runs after
 * every successful check with Mailgun (P6 wires it into the catch-up job's onSuccess).
 */

export const WARMUP_TASK_NAME = "warmup.hourly";

export const runWarmupEvaluateJob: JobHandler = async () => {
  const { evaluated, state } = await evaluateWarmupDays();
  await recordTaskSuccess(WARMUP_TASK_NAME);
  const rises = evaluated.filter((d) => d.result === "up").length;
  const summary =
    evaluated.length === 0
      ? "No closed days to look at yet."
      : `Looked at ${evaluated.length} day${evaluated.length === 1 ? "" : "s"}; the limit rose ${rises} time${rises === 1 ? "" : "s"}.`;
  return { summary, evaluated: evaluated.length, rises, step: state.step };
};

export const warmupEvaluateJob: JobDefinition = {
  handler: runWarmupEvaluateJob,
  label: "The warm-up check",
  whatToDo: "Nothing to do: it runs again within the hour. If this keeps failing, check Settings › Limits & warm-up.",
  link: "/settings/limits",
};
