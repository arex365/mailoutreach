"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { logActivity } from "@/server/activity";
import { getSettings, setSetting } from "@/server/settings";
import { loadEffectiveMaxDailyCap } from "@/server/services/mailgun/plan";
import { SenderCapError, saveSenderCaps } from "@/server/services/sending/sender-caps";
import { getTodayCap } from "@/server/services/sending/usage";
import { RULES_TEXT, saveRules } from "@/server/services/settings/rules";
import { capDayOf, safeZone } from "@/core/sending/capday";
import { validateLimits, validateTodayCap } from "@/components/settings/limits/limits-format";

/**
 * Server Actions for Settings › Limits & warm-up (M3-DESIGN §5.4, M6-DESIGN §5.3). Owner only: sending hours, the
 * maximum daily limit and warm-up settings ("Save limits"), today's limit ("Change today's limit",
 * confirmed in a dialog, and "Go back to the schedule"), each teammate's own daily limit, and "The 30-day rule"
 * card ("Save rules", with its impact confirmation). Every change is logged with who made it.
 */

const PAGE = "/settings/limits";

function refresh() {
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
}

const limitsInput = z.object({
  window: z.object({ days: z.array(z.number()), start: z.string(), end: z.string() }),
  defaultTimeZone: z.string(),
  maxDailyCap: z.number(),
  minGapSeconds: z.number(),
  capDayTimeZone: z.string(),
  warmupStartCap: z.number(),
  warmupSteps: z.number(),
  warmupMinUsePercent: z.number(),
});

function sameWindow(a: unknown, b: { days: number[]; start: string; end: string }): boolean {
  const w = (a ?? {}) as { days?: unknown; start?: unknown; end?: unknown };
  return (
    Array.isArray(w.days) &&
    w.days.length === b.days.length &&
    w.days.every((d, i) => d === b.days[i]) &&
    w.start === b.start &&
    w.end === b.end
  );
}

/** Shown after "Save limits" when a new cap-day zone sent today's changed limit back to the schedule. */
const OVERRIDE_CLEARED_MESSAGE =
  "Limits saved. The sending day now follows a different time zone, so today's limit follows the warm-up schedule again.";

/**
 * "Save limits": sending hours, the default zone, the maximum, the gap, the cap-day zone and the warm-up. A change of
 * the cap-day zone also ends a "today only" limit: that limit was confirmed for a day of the old zone, and would
 * otherwise be ignored today or apply on another day the Owner never confirmed.
 */
export async function saveLimitsAction(
  input: z.input<typeof limitsInput>,
): Promise<ActionResult<{ changed: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const raw = parseInput(limitsInput, input);
    const checked = validateLimits(raw);
    if (!checked.ok) {
      const fieldErrors = Object.fromEntries(Object.entries(checked.errors).map(([k, v]) => [k, v ? [v] : undefined]));
      throw new UserError("Some limits need fixing. Check the highlighted fields.", fieldErrors);
    }
    const v = checked.value;
    const current = await getSettings([
      "sending.window",
      "defaultTimeZone",
      "sending.maxDailyCap",
      "sending.minGapSeconds",
      "sending.capDayTimeZone",
      "warmup.startCap",
      "warmup.steps",
      "warmup.minUsePercent",
      "sending.capOverride",
    ] as const);
    const changed: string[] = [];
    let capOverrideCleared = false;
    if (!sameWindow(current["sending.window"], v.window)) {
      await setSetting("sending.window", v.window, user.id);
      changed.push("sending hours");
    }
    if (current["defaultTimeZone"] !== v.defaultTimeZone) {
      await setSetting("defaultTimeZone", v.defaultTimeZone, user.id);
      changed.push("the default time zone");
    }
    if (current["sending.maxDailyCap"] !== v.maxDailyCap) {
      await setSetting("sending.maxDailyCap", v.maxDailyCap, user.id);
      changed.push("the maximum daily limit");
    }
    if (current["sending.minGapSeconds"] !== v.minGapSeconds) {
      await setSetting("sending.minGapSeconds", v.minGapSeconds, user.id);
      changed.push("the smallest gap");
    }
    if (current["sending.capDayTimeZone"] !== v.capDayTimeZone) {
      await setSetting("sending.capDayTimeZone", v.capDayTimeZone, user.id);
      changed.push("the time zone of the sending day");
      if (current["sending.capOverride"]) {
        await setSetting("sending.capOverride", null, user.id);
        capOverrideCleared = true;
      }
    }
    if (current["warmup.startCap"] !== v.warmupStartCap) {
      await setSetting("warmup.startCap", v.warmupStartCap, user.id);
      changed.push("the warm-up start");
    }
    if (current["warmup.steps"] !== v.warmupSteps) {
      await setSetting("warmup.steps", v.warmupSteps, user.id);
      changed.push("the warm-up steps");
    }
    if (current["warmup.minUsePercent"] !== v.warmupMinUsePercent) {
      await setSetting("warmup.minUsePercent", v.warmupMinUsePercent, user.id);
      changed.push("the warm-up's use rule");
    }
    if (changed.length > 0) {
      const list = changed.length === 1 ? changed[0]! : `${changed.slice(0, -1).join(", ")} and ${changed[changed.length - 1]}`;
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: `${user.name} changed ${list}${capOverrideCleared ? ", and today's limit went back to the warm-up schedule" : ""}`,
        data: { page: "limits", changed, ...(capOverrideCleared ? { capOverrideCleared: true } : {}) },
      });
    }
    refresh();
    message = capOverrideCleared ? OVERRIDE_CLEARED_MESSAGE : "Limits saved.";
    return { changed: changed.length };
  });
  return res.ok ? { ...res, message } : res;
}

const todayCapInput = z.object({ cap: z.number(), confirmed: z.boolean() });

/**
 * "Change today's limit" (confirmed in the dialog): the Owner's limit for TODAY's cap day only
 * (Setting "sending.capOverride"; ignored on any other day), at most the maximum daily limit in force
 * (`loadEffectiveMaxDailyCap()`: never above the Mailgun plan's daily limit minus the test reserve, MAIN-DOMAIN-DESIGN
 * O23). Logged as "sending.capOverride".
 */
export async function setTodayCapAction(input: z.input<typeof todayCapInput>): Promise<ActionResult<{ cap: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(todayCapInput, input);
    const [s, effective] = await Promise.all([getSettings(["sending.capDayTimeZone"] as const), loadEffectiveMaxDailyCap()]);
    const maxCap = effective.maxCap;
    const checked = validateTodayCap(data.cap, maxCap);
    if (!checked.ok) throw new UserError(checked.error, { cap: [checked.error] });
    if (!data.confirmed) throw new UserError("Confirm the change in the dialog first.");
    const now = new Date();
    const today = await getTodayCap(now);
    const capDay = capDayOf(now, safeZone(s["sending.capDayTimeZone"]));
    await setSetting("sending.capOverride", { capDay, cap: checked.value, byUserId: user.id, at: now.toISOString() }, user.id);
    const above = checked.value > today.warmupCap;
    await logActivity({
      actorId: user.id,
      type: "sending.capOverride",
      summary: `${user.name} changed today's limit to ${checked.value.toLocaleString("en-US")}${above ? ` (above the warm-up schedule of ${today.warmupCap.toLocaleString("en-US")})` : ""}`,
      data: { capDay, cap: checked.value, warmupCap: today.warmupCap },
    });
    refresh();
    return { cap: checked.value };
  }, "Today's limit changed. It goes back to the warm-up schedule tomorrow.");
}

/** "Go back to the schedule": today's limit follows the warm-up schedule again. */
export async function clearTodayCapAction(): Promise<ActionResult<null>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const s = await getSettings(["sending.capOverride"] as const);
    if (s["sending.capOverride"]) {
      await setSetting("sending.capOverride", null, user.id);
      await logActivity({
        actorId: user.id,
        type: "sending.capOverride",
        summary: `${user.name} set today's limit back to the warm-up schedule`,
        data: { cleared: true },
      });
    }
    refresh();
    return null;
  }, "Today's limit follows the warm-up schedule again.");
}

const senderCapsInput = z.object({
  caps: z.array(z.object({ userId: z.number().int().positive(), dailyCap: z.number().nullable() })).max(500),
});

/** Each teammate's own daily limit (User.dailyCap): 1–10,000, or empty for "No limit of their own". */
export async function saveSenderCapsAction(input: z.input<typeof senderCapsInput>): Promise<ActionResult<{ changed: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(senderCapsInput, input);
    try {
      const res = await saveSenderCaps({ id: user.id, name: user.name }, data.caps);
      refresh();
      return res;
    } catch (err) {
      if (err instanceof SenderCapError) {
        throw new UserError(err.message, err.userId ? { [`cap-${err.userId}`]: [err.message] } : undefined);
      }
      throw err;
    }
  }, "Sender limits saved.");
}

/** A day box as a number: an empty or unreadable box arrives as NaN, which the service refuses with its sentence. */
const dayNumber = (error: string) => z.union([z.number(), z.nan()], { error });

const rulesInput = z.object({
  teamRuleDays: dayNumber(RULES_TEXT.teamRuleDays),
  pausedExpiryDays: dayNumber(RULES_TEXT.pausedExpiryDays),
  // 200 lines of at most 253 characters each, with room for blank lines.
  sharedDomains: z.string({ error: "Write one domain per line, like example.com." }).max(100_000, { error: RULES_TEXT.tooManyDomains }),
  confirmed: z.boolean().optional(),
});

/**
 * "Save rules" on "The 30-day rule" card (M6-DESIGN §5.3): the rule's length, how long a paused campaign keeps its
 * companies, and the Owner's shared email domains. A change that affects campaigns first comes back as
 * `needsConfirm.lines` (nothing written); the card shows them and calls again with `confirmed: true`.
 */
export async function saveRulesAction(input: {
  teamRuleDays: number;
  pausedExpiryDays: number;
  sharedDomains: string;
  confirmed?: boolean;
}): Promise<ActionResult<{ needsConfirm?: { lines: string[] } }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { confirmed, ...values } = parseInput(rulesInput, input);
    const out = await saveRules({ id: user.id, name: user.name }, values, { confirmed: confirmed === true });
    if (out.fieldErrors) throw new UserError(out.message, out.fieldErrors);
    message = out.message;
    if (out.needsConfirm) return { needsConfirm: out.needsConfirm };
    // The rules decide who may be emailed everywhere (Contacts, the wizard, the dashboard).
    refresh();
    return {};
  });
  return res.ok ? { ...res, message } : res;
}
