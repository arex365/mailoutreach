import { effectiveMaxDailyCap, planLimits, planOf, type PlanLimits } from "@/core/mailgun/plan";
import { repliesOf } from "@/core/sending/own-mailbox";
import { db, type DbOrTx } from "@/server/db";
import { SETTING_DEFAULTS } from "@/server/settings";

/**
 * The Mailgun plan limits in force (MAIN-DOMAIN-DESIGN O22–O26, §7.4). Settings only (no Mailgun, no secrets, no
 * writes): the dashboard and the worker may call them. Pass `tx` to read inside an open transaction.
 */

/** The plan limits in force (O22): Settings "mailgun.plan" and "mailgun.replies", one query. Settings only. */
export async function loadPlanLimits(reader: DbOrTx = db): Promise<PlanLimits | null> {
  const rows = await reader.setting.findMany({
    where: { key: { in: ["mailgun.plan", "mailgun.replies"] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return planLimits(planOf(value("mailgun.plan")), repliesOf(value("mailgun.replies")));
}

/**
 * The maximum daily limit every cap, warm-up table and cap-override check uses (O23): Setting "sending.maxDailyCap"
 * (its default when missing), never above the plan's limit minus the reserve. The only reader of the raw setting besides
 * the Limits form. `limits` is returned too, for callers that also show the plan line.
 */
export async function loadEffectiveMaxDailyCap(reader: DbOrTx = db): Promise<{ maxCap: number; limits: PlanLimits | null }> {
  const [row, limits] = await Promise.all([
    reader.setting.findUnique({ where: { key: "sending.maxDailyCap" }, select: { value: true } }),
    loadPlanLimits(reader),
  ]);
  const saved = row ? row.value : SETTING_DEFAULTS["sending.maxDailyCap"];
  return { maxCap: effectiveMaxDailyCap(saved, limits), limits };
}
