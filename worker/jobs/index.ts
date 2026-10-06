import { plural } from "@/core/text";
import { redactText } from "@/server/jobs";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { runImportCommitJob } from "@/server/services/imports/commit";
import { applyOutageHold, type OutageHoldResult } from "@/server/services/sequences/holds";
import { runHealthCheck } from "@/server/services/sending/health-check";
import { evaluateWarmupDays } from "@/server/services/sending/warmup-days";
import { errorText, log, type Logger } from "../log";
import { createAiDraftLinesJob, type AiDeps } from "./ai-draft-lines";
import { backupJob } from "./backup";
import { cleanupJob } from "./cleanup";
import { applySettingsJob } from "./mailgun-apply-settings";
import { createCatchUpJob } from "./mailgun-catch-up";
import { checkDomainJob } from "./mailgun-check-domain";
import { createRestoreScanJob } from "./mailgun-restore-scan";
import { syncRoutesJob } from "./mailgun-sync-routes";
import { syncSuppressionsJob } from "./mailgun-sync-suppressions";
import { sendTestEmailJob } from "./send-test-email";
import { createVerifyAddressesJob } from "./verify-addresses";
import { warmupEvaluateJob } from "./warmup-evaluate";
import type { JobRegistry } from "./types";

export type { FailureNotice, JobDefinition, JobRegistry } from "./types";

/**
 * Job priorities (M3-DESIGN §4.6; the runner takes the highest first). Enqueuers pass them; they live here so the
 * worker's own enqueues (start-up, periodic tasks) and the tests agree with the rest of the app.
 *
 * The two Milestone 5 types run in lanes of their own (M5-DESIGN §0.3 "Lane"), so their numbers only order them
 * against each other; their starters pass their own per source (checks: wizard 20, Contacts and lists 10, panel and
 * Settings 25, the re-check sweep 30, §2.5; drafting: Contacts and lists 10, panel, Regenerate and Try again 25,
 * §3.9.1). These are the defaults.
 */
export const JOB_PRIORITIES = {
  "send.testEmail": 60,
  "mailgun.catchUp": 50,
  "mailgun.restoreScan": 40,
  "mailgun.applySettings": 30,
  "mailgun.syncRoutes": 30,
  "mailgun.checkDomain": 20,
  "warmup.evaluate": 20,
  "verify.addresses": 20,
  "mailgun.syncSuppressions": 10,
  "ai.draftLines": 10,
} as const;

export type JobRegistryDeps = {
  /** Tests: the Mailgun context used by the catch-up and the warm-up evaluation after it (e.g. fast retries). */
  mailgun?: () => Promise<MailgunContextResult>;
  /**
   * Tests: the clock of the catch-up and of what runs after it, of the restore check with Mailgun (with `mailgun`, so
   * its log window follows the test's clock, never the PC's date), and of the address checks and AI drafting.
   */
  now?: () => Date;
  /** Where the steps after a check with Mailgun, the address checks and AI drafting log. Default: the worker log. */
  logger?: Logger;
  /**
   * Tests (M5-DESIGN §9.3 Part A): what AI drafting uses instead of its defaults, e.g. a website reader over the
   * fixture sites with no waiting between requests, or a stubbed Claude. Missing: the real reader and the saved key.
   */
  ai?: Partial<AiDeps>;
};

/**
 * The worker's logger for AI drafting (AiLogger): the same timestamped lines as every task, marked "[ai]" like the
 * drafting job's own console logger, with the error's text redacted (anything shaped like a key), because an Anthropic
 * SDK message can quote a request.
 */
export function workerAiLogger(logger: Logger): NonNullable<AiDeps["logger"]> {
  return {
    info: (m) => logger.info(`[ai] ${m}`),
    warn: (m) => logger.warn(`[ai] ${m}`),
    error: (m, err) => logger.error(`[ai] ${m}`, err === undefined ? undefined : redactText(errorText(err))),
  };
}

/**
 * Applies the outage hold (M4-DESIGN §2.8.3: after the PC was off longer than Mailgun keeps its logs, the follow-ups
 * that may have had an unseen reply, and everyone else open at those companies, wait until their senders have checked
 * their inbox) and logs what it did. Nothing to do (no outage found, or already handled) logs nothing. Throws when
 * the hold fails, so the caller logs it in its own words; the hold is single-flight and idempotent, so the catch-up's
 * onSuccess, the start-up and the 5-minute sending maintenance may all call it.
 */
export async function applyOutageHoldLogged(now: Date, logger: Logger = log): Promise<OutageHoldResult> {
  const res = await applyOutageHold({ now });
  if (res.applied) {
    logger.info(
      res.held > 0
        ? `The PC was off too long to check every reply: put ${plural(res.held, "person", "people")} on hold until their senders have checked their inbox`
        : "The PC was off for a while; nobody needed to be put on hold",
    );
  }
  return res;
}

/** Runs one step after a check with Mailgun; a failure is logged and never stops the next step or the catch-up. */
async function afterCatchUpStep(logger: Logger, failure: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    logger.error(failure, err);
  }
}

/**
 * Every job type the background sender can run (PLAN.md B8, M3-DESIGN §4.6). An unknown type fails with "Unknown
 * task type". `campaign.finishCheck` stays unregistered on purpose (unused: the sending loop runs the finish checks).
 *
 * After every complete check with Mailgun (`mailgun.catchUp`), in this order (M4-DESIGN §10 P6): the outage hold (so
 * follow-ups that may have missed a reply are held before the sending gate opens for them), the warm-up evaluation of
 * the closed cap days, and the health check (B1 "catch up, then evaluate closed days, then send"; §4.3.8). Each step's
 * failure is logged and never stops the next one, nor fails the catch-up.
 *
 * Milestone 5 (M5-DESIGN §8 P11): the address checks (`verify.addresses`, the `checks` lane) and AI drafting
 * (`ai.draftLines`, the `ai` lane) use the worker's clock and logger; AI drafting also takes `deps.ai`.
 */
export function createJobRegistry(deps: JobRegistryDeps = {}): JobRegistry {
  const now = () => (deps.now ? deps.now() : new Date());
  const logger = deps.logger ?? log;
  return {
    "import.commit": {
      handler: runImportCommitJob,
      label: "The import",
      whatToDo: "Open Import to see what was saved, then try the import again.",
      link: "/import",
    },
    "backup.run": backupJob,
    "system.cleanup": cleanupJob,
    // Mail events, sync and checks (P4).
    "mailgun.catchUp": createCatchUpJob({
      mailgun: deps.mailgun,
      now: deps.now,
      onSuccess: async () => {
        await afterCatchUpStep(logger, "Couldn't put follow-ups on hold after the PC was off; the sending maintenance tries again in 5 minutes", () =>
          applyOutageHoldLogged(now(), logger),
        );
        await afterCatchUpStep(logger, "The warm-up evaluation after the check with Mailgun hit a problem; the hourly check tries again", () =>
          evaluateWarmupDays({ now: now(), mailgun: deps.mailgun }),
        );
        await afterCatchUpStep(logger, "The health check after the check with Mailgun hit a problem; it runs again after the next check", () =>
          runHealthCheck({ now: now() }),
        );
      },
    }),
    "mailgun.syncSuppressions": syncSuppressionsJob,
    "mailgun.checkDomain": checkDomainJob,
    // Mailgun setup and sender identity (P5).
    "mailgun.applySettings": applySettingsJob,
    "mailgun.syncRoutes": syncRoutesJob,
    "send.testEmail": sendTestEmailJob,
    // Sending engine (P3).
    "mailgun.restoreScan": createRestoreScanJob({ now: deps.now, mailgun: deps.mailgun }),
    "warmup.evaluate": warmupEvaluateJob,
    // Address checks and AI personal lines (Milestone 5), each in a lane of its own.
    "verify.addresses": createVerifyAddressesJob({ now: deps.now, logger }),
    "ai.draftLines": createAiDraftLinesJob({ now: deps.now, logger: workerAiLogger(logger), ...deps.ai }),
  };
}

/** The registry the worker runs with. */
export const JOB_REGISTRY: JobRegistry = createJobRegistry();
