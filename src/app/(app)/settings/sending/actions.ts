"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { modeWords, stillSendingWarning } from "@/components/settings/sending/texts";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { logActivity } from "@/server/activity";
import { db } from "@/server/db";
import { enqueueJob } from "@/server/jobs";
import { GoLiveError, goLive } from "@/server/services/go-live";
import {
  REMOVE_SENDING_KEY_TEXTS,
  connectMailgun,
  forgetMailgunKeys,
  removeSendingKey,
  saveFromAddress,
  saveRetention,
} from "@/server/services/mailgun/connect";
import { loadGateInputs, modeBlockersFor, saveTestList } from "@/server/services/reply-test";
import { CampaignError } from "@/server/services/campaigns/errors";
import { pauseSending, resumeSending } from "@/server/services/sending/pause";
import { releaseOutageHold } from "@/server/services/sequences/holds";
import { getSetting, setSetting } from "@/server/settings";
import { plural } from "@/core/text";

/**
 * Settings › Sending & Mailgun (M3-DESIGN §5.2, M4-DESIGN §9.9, M6-DESIGN §2.5, SHARED-FROM-DESIGN §3.1). Every action
 * is Owner-only: keys, the sending domain, the From address, the sending mode, the test list, go-live, the global pause
 * and continuing follow-ups held after the PC was off (PLAN B7, SPEC §1).
 */

/**
 * M2's "Switch back to dry run" (kept for older links): sets the sending mode to dry run. The full mode choice is
 * setSendingModeAction.
 */
export async function switchToDryRunAction(): Promise<ActionResult<{ mode: "DRY_RUN" }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const before = await getSetting("sending.mode");
    if (before !== "DRY_RUN") {
      await setSetting("sending.mode", "DRY_RUN", user.id);
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: `${user.name} set sending to dry run`,
        data: { key: "sending.mode", from: before, to: "DRY_RUN" },
      });
    }
    revalidatePath("/", "layout");
    return { mode: "DRY_RUN" as const };
  }, "Sending is set to dry run. New campaigns fill the dry-run outbox.");
}

const connectSchema = z.object({
  region: z.enum(["EU", "US"], { error: "Choose the region you picked when you added the domain in Mailgun." }),
  domain: z.string({ error: "Enter the sending domain." }).max(300),
  apiKey: z.string().max(500).optional().nullable(),
  sendingKey: z.string().max(500).optional().nullable(),
  /** MAIN-DOMAIN-DESIGN O1, O7: "How the app sends"; absent = the saved mode (passed to connectMailgun). */
  replies: z.enum(["app", "own-mailbox"]).optional(),
});

/** "Save and connect": tests the key and domain with Mailgun, then saves them (M3-DESIGN §4.5.1). */
export async function connectMailgunAction(
  input: z.infer<typeof connectSchema>,
): Promise<ActionResult<{ domainState: string | null; detail: string | null }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(connectSchema, input);
    const out = await connectMailgun({ id: user.id, name: user.name }, data);
    if (!out.ok) {
      // Mailgun's own answer goes behind "Details" (fieldErrors.detail), never in the sentence itself.
      const fieldErrors: Record<string, string[]> = {};
      if (out.field) fieldErrors[out.field] = [out.error];
      if (out.detail) fieldErrors.detail = [out.detail];
      throw new UserError(out.error, fieldErrors);
    }
    message = out.message;
    // A domain change can end go-live (M6-DESIGN G8): the top bar and the dashboard change with it (R5).
    revalidatePath("/", "layout");
    return { domainState: out.domainState, detail: null };
  });
  return res.ok ? { ...res, message } : res;
}

const fromAddressSchema = z.object({
  fromAddress: z.string({ error: "Type the From address, or leave the box empty." }).max(320, { error: "That address is too long." }),
  confirmEndGoLive: z.boolean().optional(),
});

/**
 * "Save From address" (SHARED-FROM-DESIGN §3.1, F13): the shared From address every campaign email shows, or empty for
 * each person's own address. While live, the Owner confirms in the dialog that going live ends (`confirmEndGoLive`).
 * The toast is the service's sentence; the top bar, the dashboard and the go-live card change with it (R5).
 */
export async function saveFromAddressAction(
  input: z.infer<typeof fromAddressSchema>,
): Promise<ActionResult<{ fromAddress: string | null; goLiveEnded: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(fromAddressSchema, input);
    const out = await saveFromAddress({ id: user.id, name: user.name }, data);
    if (!out.ok) throw new UserError(out.error, out.field ? { [out.field]: [out.error] } : undefined);
    message = out.message;
    revalidatePath("/", "layout");
    return { fromAddress: out.fromAddress, goLiveEnded: out.goLiveEnded };
  });
  return res.ok ? { ...res, message } : res;
}

/** No input; `strict` refuses anything else sent along. */
const removeSendingKeySchema = z.object({}).strict();

/**
 * "Remove the sending key" (Settings › Sending & Mailgun › Advanced, review SCREENS-01): deletes only the domain sending
 * key; the API key then sends. The way out the key pause names when Mailgun refuses the sending key after the From
 * address was set.
 */
export async function removeSendingKeyAction(input: z.infer<typeof removeSendingKeySchema> = {}): Promise<ActionResult<{ removed: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    parseInput(removeSendingKeySchema, input ?? {});
    const out = await removeSendingKey({ id: user.id, name: user.name });
    message = out.removed ? REMOVE_SENDING_KEY_TEXTS.removed : REMOVE_SENDING_KEY_TEXTS.nothingSaved;
    revalidatePath("/settings", "layout");
    return { removed: out.removed };
  });
  return res.ok ? { ...res, message } : res;
}

/** "Remove saved keys": deletes the API key, the sending key and the webhook signing key. */
export async function forgetMailgunKeysAction(): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    await forgetMailgunKeys({ id: user.id, name: user.name });
    revalidatePath("/settings", "layout");
    return null;
  }, "The saved Mailgun keys are removed. Emails through Mailgun wait until you connect again.");
}

/** Test and live campaigns that can still send through Mailgun (scheduled or running). */
async function activeMailgunCampaigns(): Promise<Array<{ name: string; mode: string }>> {
  const rows = await db.campaign.findMany({
    where: { mode: { in: ["TEST", "LIVE"] }, status: { in: ["SCHEDULED", "RUNNING"] } },
    select: { name: true, mode: true },
    orderBy: { id: "asc" },
    take: 20,
  });
  return rows.map((r) => ({ name: r.name, mode: r.mode ?? "DRY_RUN" }));
}

const modeSchema = z.object({ mode: z.enum(["DRY_RUN", "TEST", "LIVE"], { error: "Choose a sending mode." }) });

/**
 * Sets the sending mode for new campaigns. Test mode needs a connected Mailgun; Live needs every liveModeBlockers item
 * clear (DNS, tracking off, unsubscribe on, webhooks, signing key, Mailgun accepting emails); never Test or Live in the
 * practice copy. Campaigns keep the mode they were launched with.
 */
export async function setSendingModeAction(input: z.infer<typeof modeSchema>): Promise<ActionResult<{ mode: string; warning: string | null }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { mode } = parseInput(modeSchema, input);
    const gate = await loadGateInputs();
    const blockers = modeBlockersFor(mode, gate);
    if (blockers.length > 0) throw new UserError(blockers.join(" "));
    const before = gate.mode;
    // "live (test list only)" before go-live, "live" after it (M6-DESIGN §2.7).
    const words = modeWords(gate.goLive);
    let warning: string | null = null;
    if (before !== mode) {
      if (before !== "DRY_RUN") warning = stillSendingWarning(await activeMailgunCampaigns());
      await setSetting("sending.mode", mode, user.id);
      await logActivity({
        actorId: user.id,
        type: "sending.modeChanged",
        summary: `${user.name} set sending to ${words[mode]}`,
        data: { from: before, to: mode },
      });
    }
    message = before === mode ? `Sending is already set to ${words[mode]}.` : `Sending is set to ${words[mode]}.${warning ? ` ${warning}` : ""}`;
    revalidatePath("/", "layout");
    return { mode, warning };
  });
  return res.ok ? { ...res, message } : res;
}

const testListSchema = z.object({ addresses: z.array(z.string().max(320)).max(50) });

/** Saves the whole test list (≤ 10, valid, not on a sending domain); a teammate's reply inbox only warns. */
export async function saveTestListAction(
  input: z.infer<typeof testListSchema>,
): Promise<ActionResult<{ addresses: string[]; warnings: string[] }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const { addresses } = parseInput(testListSchema, input);
    const res = await saveTestList({ id: user.id, name: user.name }, addresses);
    if (!res.ok) throw new UserError(res.error, { address: [res.error] });
    // The go-live checklist and the dashboard read the test list too (M6-DESIGN §5.1 R5).
    revalidatePath("/", "layout");
    return { addresses: res.value, warnings: res.warnings };
  }, "Test list saved.");
}

const pauseSchema = z.object({ why: z.string().max(200).optional().nullable() });

/** "Pause all sending": stops every campaign, dry runs included, until someone resumes. */
export async function pauseAllAction(input: z.infer<typeof pauseSchema>): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const { why } = parseInput(pauseSchema, input);
    const reason = (why ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || `by ${user.name}`;
    await pauseSending({
      kind: "manual",
      reason,
      fixText: "Click Resume sending in Settings › Sending & Mailgun when you're ready.",
      byUserId: user.id,
    });
    revalidatePath("/", "layout");
    return null;
  }, "All sending is paused. Nothing is sent until you click Resume sending.");
}

const resumeSchema = z.object({ confirmRestoreRisk: z.boolean().optional() });

/** "Resume sending" (M3-DESIGN §4.2.6): refused with the plain reason when a restore risk isn't confirmed. */
export async function resumeSendingAction(input: z.infer<typeof resumeSchema> = {}): Promise<ActionResult<{ summary: string }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { confirmRestoreRisk } = parseInput(resumeSchema, input ?? {});
    const out = await resumeSending({ actorId: user.id, actorName: user.name, confirmRestoreRisk: confirmRestoreRisk === true });
    if (!out.resumed) throw new UserError(out.summary);
    message = "Sending is resumed.";
    revalidatePath("/", "layout");
    return { summary: out.summary };
  });
  return res.ok ? { ...res, message } : res;
}

const retentionSchema = z.object({
  logRetentionDays: z.number({ error: "Enter a number of days." }).int({ error: "Use whole days." }).min(1, { error: "Use 1 to 30 days." }).max(30, { error: "Use 1 to 30 days." }),
  messageRetentionDays: z.number({ error: "Enter a number of days." }).int({ error: "Use whole days." }).min(1, { error: "Use 1 to 7 days." }).max(7, { error: "Use 1 to 7 days." }),
  /** MAIN-DOMAIN-DESIGN O22: "Your Mailgun plan" (null = Not sure); absent = unchanged. */
  plan: z.enum(["free", "basic", "foundation", "scale"]).nullable().optional(),
});

/**
 * "Your Mailgun plan keeps event logs for [5] days and stored replies for [1] day." and, under Advanced, "Your Mailgun
 * plan" (MAIN-DOMAIN-DESIGN O22, §3.1): the numbers and the plan (null = Not sure, absent = unchanged) are saved with
 * their activity in one transaction (`saveRetention`). A plan caps the daily limit and the log retention everywhere, so
 * every page that shows them is refreshed. In own-mailbox mode Apply leaves Mailgun's stored-reply retention alone, so
 * the toast never asks for it there.
 */
export async function saveRetentionAction(input: z.infer<typeof retentionSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(retentionSchema, input);
    const out = await saveRetention({ id: user.id, name: user.name }, data);
    message =
      out.messageChanged && out.replies !== "own-mailbox"
        ? "Saved. Click Apply recommended settings on the Domain checklist so Mailgun keeps stored replies that long."
        : "Saved.";
    revalidatePath("/", "layout");
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

const continueSchema = z.object({
  senderId: z.number({ error: "Something about this page is out of date. Refresh it and try again." }).int().positive().nullable(),
});

/**
 * "Continue Ali's follow-ups" (M4-DESIGN §2.8.3, §9.9): the Owner releases the outage hold of one sender's people
 * (`senderId` null = campaigns whose sender account is gone), after that sender has checked their inbox. Colleagues'
 * first emails at companies where nobody emailed is still held go on too. Toast: "Follow-ups of 8 people continue."
 */
export async function continueFollowUpsAction(
  input: z.infer<typeof continueSchema>,
): Promise<ActionResult<{ released: number; firstEmails: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { senderId } = parseInput(continueSchema, input);
    let out: { released: number; firstEmails: number };
    try {
      out = await releaseOutageHold({ id: user.id, name: user.name, role: user.role }, { senderId });
    } catch (err) {
      if (err instanceof CampaignError) throw new UserError(err.message);
      throw err;
    }
    const colleagues = plural(out.firstEmails, out.released > 0 ? "other person" : "person", out.released > 0 ? "other people" : "people");
    message =
      out.released > 0
        ? `Follow-ups of ${plural(out.released, "person", "people")} continue.${out.firstEmails > 0 ? ` First emails to ${colleagues} continue too.` : ""}`
        : `First emails to ${colleagues} continue.`;
    revalidatePath("/settings/sending");
    revalidatePath("/notifications");
    revalidatePath("/campaigns", "layout");
    return out;
  });
  return res.ok ? { ...res, message } : res;
}

const goLiveSchema = z.object({
  confirm: z.literal(true, { error: GO_LIVE_COPY.confirmRequired }),
  /** SHARED-FROM-DESIGN F12: the dialog's spam-placement tick (checked by goLive()). */
  confirmSpamPlacement: z.boolean().optional(),
  /** MAIN-DOMAIN-DESIGN O14: own-mailbox mode's replies tick (checked by goLive()). */
  confirmOwnMailbox: z.boolean().optional(),
  /** MAIN-DOMAIN-DESIGN O14, O20: the http-links tick (checked by goLive()). */
  confirmHttpLinks: z.boolean().optional(),
});

/**
 * "Go live" (M6-DESIGN §2.5): the Owner confirms in the dialog, goLive() checks everything again and switches it on
 * (one-way per sending domain). Refusals are the "Before going live:" sentences, or "Something changed while going
 * live. Check the list again."; a second click answers "You're already live." The top bar, the sidebar and the
 * dashboard change with it (R5).
 */
export async function goLiveAction(input: z.infer<typeof goLiveSchema>): Promise<ActionResult<{ at: string; alreadyLive: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const parsed = goLiveSchema.safeParse(input);
    if (!parsed.success) throw new UserError(GO_LIVE_COPY.confirmRequired, { confirm: [GO_LIVE_COPY.confirmRequired] });
    let out: Awaited<ReturnType<typeof goLive>>;
    try {
      out = await goLive(
        { id: user.id, name: user.name },
        {
          confirmSpamPlacement: parsed.data.confirmSpamPlacement === true,
          confirmOwnMailbox: parsed.data.confirmOwnMailbox === true,
          confirmHttpLinks: parsed.data.confirmHttpLinks === true,
        },
      );
    } catch (err) {
      if (err instanceof GoLiveError) throw new UserError(err.message);
      throw err;
    }
    message = out.alreadyLive ? GO_LIVE_COPY.alreadyLive : GO_LIVE_COPY.toast;
    revalidatePath("/", "layout");
    return { at: out.at.toISOString(), alreadyLive: out.alreadyLive };
  });
  return res.ok ? { ...res, message } : res;
}

/** "Check with Mailgun now": queues a catch-up (bounces, unsubscribes, complaints and replies Mailgun has). */
export async function checkWithMailgunAction(): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const gate = await loadGateInputs();
    if (!gate.connected) throw new UserError(gate.connectionText ?? "Connect Mailgun first.");
    const job = await enqueueJob({
      type: "mailgun.catchUp",
      payload: { reason: "manual" },
      dedupeKey: "mailgun:catchup",
      priority: 50,
      createdById: user.id,
    });
    revalidatePath("/settings/sending");
    return { jobId: job.id };
  }, "Checking with Mailgun. This takes a minute or two.");
}
