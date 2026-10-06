"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { roundUsd } from "@/core/money";
import type { VerificationPolicySetting } from "@/core/setting-types";
import {
  CHECK_KEY_TEXT,
  CHECK_SETTING_KEYS,
  checkSettingActivity,
  checkSettingsSchema,
  checkSettingsValuesFrom,
  STORED_CHECK_SETTING_KEYS,
  type CheckSettingsValues,
} from "@/components/settings/checks/check-settings";
import { logActivity } from "@/server/activity";
import { FAKE_KEY_PREFIX, isFakeMode } from "@/server/mailgun/base-url";
import { deleteSecret, secretInfo, setSecret } from "@/server/secrets";
import { getSettings, setSetting } from "@/server/settings";
import { cleanKey } from "@/server/services/mailgun/connect";
import { resumeChecks } from "@/server/services/verification/pause";
import { CheckRunError } from "@/server/services/verification/runs";
import { checksThisMonth } from "@/server/services/verification/spend";
import { startCheckRun } from "@/server/services/verification/start";

/**
 * Settings › Deliverability "Address checks" actions (Owner only, M5-DESIGN §2.4, §2.12, §6.6, §6.11): the check
 * policy and numbers, the separate address check key (saved without a test call: a test costs money), "Test address
 * checks" on one typed address (a check row only: never a person, a suppression or a campaign), and Resume checks.
 * Saving a key lifts a pause for a refused key; raising the monthly limit above this month's spend lifts the
 * monthly-limit pause. Every change is logged as `settings.updated` with its `data.key`.
 */

const PAGE = "/settings/deliverability";

const RESUMED = "Address checks resumed.";

/** The numeric Settings the card saves (every one a plain number). */
type NumericKey = (typeof CHECK_SETTING_KEYS)[keyof typeof CHECK_SETTING_KEYS];

function actorOf(user: SessionUser) {
  return { id: user.id, name: user.name };
}

/** The saved values as the card shows them (anything broken reads as its default). */
async function currentValues(): Promise<CheckSettingsValues> {
  return checkSettingsValuesFrom(await getSettings(STORED_CHECK_SETTING_KEYS));
}

/** Lifts a pause of these kinds; the sentence to add to the toast when it did. */
async function resumeIf(user: SessionUser, kinds: Array<"auth" | "monthly_limit">): Promise<string | null> {
  const res = await resumeChecks(actorOf(user), { onlyKinds: kinds });
  return res.message === RESUMED ? RESUMED : null;
}

/**
 * "Save check settings": the policy rows, the price, the included checks, how long results count, the monthly limit
 * and the checks at the same time. Changes apply from now on; nobody is checked again by it.
 */
export async function saveCheckSettingsAction(input: {
  deliverableHighRisk: string;
  catchAllLow: string;
  catchAllMedium: string;
  catchAllHigh: string;
  disposable: string;
  unknown: string;
  pricePerCheck: number | string;
  includedPerMonth: number | string;
  maxAgeDays: number | string;
  monthlyLimitUsd: number | string;
  concurrency: number | string;
  provider?: string;
}): Promise<ActionResult<{ changed: number; resumed: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(checkSettingsSchema, input);
    const next: CheckSettingsValues = {
      deliverableHighRisk: data.deliverableHighRisk,
      catchAllLow: data.catchAllLow,
      catchAllMedium: data.catchAllMedium,
      catchAllHigh: data.catchAllHigh,
      disposable: data.disposable,
      unknown: data.unknown,
      pricePerCheck: roundUsd(data.pricePerCheck),
      includedPerMonth: data.includedPerMonth,
      maxAgeDays: data.maxAgeDays,
      monthlyLimitUsd: roundUsd(data.monthlyLimitUsd),
      concurrency: data.concurrency,
    };
    const before = await currentValues();
    const changed: string[] = [];

    const policy: VerificationPolicySetting = {
      deliverableHighRisk: next.deliverableHighRisk,
      catchAllLow: next.catchAllLow,
      catchAllMedium: next.catchAllMedium,
      catchAllHigh: next.catchAllHigh,
      disposable: next.disposable,
      unknown: next.unknown,
    };
    const policyChanged = (Object.keys(policy) as Array<keyof VerificationPolicySetting>).some((k) => before[k] !== policy[k]);
    if (policyChanged) {
      await setSetting("verification.policy", policy, user.id);
      changed.push("verification.policy");
    }
    for (const [field, key] of Object.entries(CHECK_SETTING_KEYS) as Array<[keyof typeof CHECK_SETTING_KEYS, NumericKey]>) {
      if (before[field] === next[field]) continue;
      await setSetting(key as "verification.pricePerCheck", next[field], user.id);
      changed.push(key);
    }
    for (const key of changed) {
      const from = key === "verification.policy" ? pick(before) : before[fieldOf(key)];
      const to = key === "verification.policy" ? policy : next[fieldOf(key)];
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: checkSettingActivity(user.name, key, next),
        data: { key, from, to },
      });
    }

    // A higher limit than this month's spend lets paused checks go on (M5-DESIGN §2.12).
    let resumed: string | null = null;
    if (changed.includes("verification.monthlyLimitUsd") && next.monthlyLimitUsd > (await checksThisMonth()).costUsd) {
      resumed = await resumeIf(user, ["monthly_limit"]);
    }
    // A lifted pause also leaves the dashboard's attention list (M6-DESIGN §5.1 R5).
    if (resumed) revalidatePath("/", "layout");
    else if (changed.length > 0) revalidatePath(PAGE);
    message = changed.length === 0 ? "Nothing changed." : resumed ? `Check settings saved. ${resumed}` : "Check settings saved.";
    return { changed: changed.length, resumed: resumed !== null };
  });
  return res.ok ? { ...res, message } : res;
}

/** The six policy rows of a values object (for the activity's `from`). */
function pick(v: CheckSettingsValues): VerificationPolicySetting {
  return {
    deliverableHighRisk: v.deliverableHighRisk,
    catchAllLow: v.catchAllLow,
    catchAllMedium: v.catchAllMedium,
    catchAllHigh: v.catchAllHigh,
    disposable: v.disposable,
    unknown: v.unknown,
  };
}

/** The values field that a numeric Setting key saves. */
function fieldOf(key: string): keyof typeof CHECK_SETTING_KEYS {
  const hit = (Object.entries(CHECK_SETTING_KEYS) as Array<[keyof typeof CHECK_SETTING_KEYS, string]>).find(([, k]) => k === key);
  return hit ? hit[0] : "pricePerCheck";
}

/**
 * "Save key": a separate address check key (optional; without one the Mailgun key is used). Trimmed and stripped of
 * zero-width characters; saved without a test call. A test key (key-fake-…) only in fake mode, and only there.
 */
export async function saveVerificationKeyAction(input: { key: string }): Promise<ActionResult<{ last4: string }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(z.object({ key: z.string({ error: CHECK_KEY_TEXT.paste }).max(500, { error: CHECK_KEY_TEXT.paste }) }), input);
    const key = cleanKey(data.key);
    const field = (text: string) => new UserError(text, { key: [text] });
    if (!key) throw field(CHECK_KEY_TEXT.paste);
    if ((await getSettings(["practice.copy"] as const))["practice.copy"] === true) throw new UserError(CHECK_KEY_TEXT.practiceCopy);
    const fake = isFakeMode();
    const isTestKey = key.startsWith(FAKE_KEY_PREFIX);
    if (fake && !isTestKey) throw field(CHECK_KEY_TEXT.realKeyInFakeMode);
    if (!fake && isTestKey) throw field(CHECK_KEY_TEXT.testKey);

    await setSecret("verification.apiKey", key, user.id);
    await logActivity({
      actorId: user.id,
      type: "settings.updated",
      summary: `${user.name} saved a separate key for address checks`,
      data: { key: "verification.apiKey" },
    });
    const resumed = await resumeIf(user, ["auth"]);
    if (resumed) revalidatePath("/", "layout");
    else revalidatePath(PAGE);
    message = resumed ? `${CHECK_KEY_TEXT.saved} ${resumed}` : CHECK_KEY_TEXT.saved;
    return { last4: key.slice(-4) };
  });
  return res.ok ? { ...res, message } : res;
}

/** "Use the Mailgun key instead": removes the separate address check key. */
export async function removeVerificationKeyAction(): Promise<ActionResult<{ removed: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const info = await secretInfo("verification.apiKey");
    if (!info.set) {
      message = CHECK_KEY_TEXT.notSaved;
      return { removed: false };
    }
    await deleteSecret("verification.apiKey");
    await logActivity({
      actorId: user.id,
      type: "settings.updated",
      summary: `${user.name} removed the separate key for address checks`,
      data: { key: "verification.apiKey" },
    });
    revalidatePath(PAGE);
    message = CHECK_KEY_TEXT.removed;
    return { removed: true };
  });
  return res.ok ? { ...res, message } : res;
}

/**
 * "Check it" on Settings › Deliverability "Test address checks": one typed address, checked by the check job (the
 * screen follows the job and reads its one-address result). Stored as a check row only.
 */
export async function testCheckAction(input: { email: string }): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(
      z.object({ email: z.string({ error: "Enter an email address." }).trim().min(1, { error: "Enter an email address." }).max(320) }),
      input,
    );
    try {
      const started = await startCheckRun({ id: user.id, name: user.name, role: user.role }, { source: "settings", address: data.email });
      return { jobId: started.jobId };
    } catch (err) {
      if (err instanceof CheckRunError) {
        throw new UserError(err.message, err.code === "bad-address" ? { email: [err.message] } : undefined);
      }
      throw err;
    }
  });
}

/** "Resume checks" (the paused banner's primary): lets waiting check runs go on at once. */
export async function resumeChecksAction(): Promise<ActionResult<null>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const out = await resumeChecks(actorOf(user));
    // The dashboard shows a checks pause too (M6-DESIGN §5.1 R5).
    revalidatePath("/", "layout");
    message = out.message;
    return null;
  });
  return res.ok ? { ...res, message } : res;
}
