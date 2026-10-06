import {
  averageCallTokens,
  DRAFT_PROMPT_VERSION,
  perCompanyUsd,
  runCostUsd,
  type CompanyCost,
  type TokenSample,
} from "@/core/ai/estimate";
import { resolveProfile, type ResolvedProfile } from "@/core/ai/types";
import { roundUsd } from "@/core/money";
import { monthBounds } from "@/core/time/month";
import { db } from "@/server/db";
import { getSettings } from "@/server/settings";
import { monthSpendUsd, parseDraftFlags, systemTokensFor } from "./drafts";

/**
 * The cost estimate before a drafting run (docs/dev/M5-DESIGN.md §3.3): the start dialog's "About $0.17, at most $0.32
 * with Claude Haiku 4.5", this month's spend against the limit, and the numbers the start puts in the job's payload
 * (always the server's own, never the browser's). The math is @/core/ai/estimate; here it gets its inputs:
 *  - the profile of the chosen model (Settings "ai.model", "ai.customModel", "ai.prices");
 *  - the measured system-prompt tokens (SystemState "ai.tokens") or the profile's default;
 *  - running averages of the model's last 50 drafted drafts once there are 10 (drafts whose cost is partly an
 *    estimate are left out: their tokens aren't real; so are drafts that were never billed: an error answer isn't a
 *    call, M5 review AI-8), else the profile defaults;
 *  - the office month's spend (drafts by `draftedAt`, Setting "sending.capDayTimeZone").
 * In the practice copy everything costs $0 and no limit applies (§3.12).
 */

export type AiRunEstimate = {
  companies: number;
  model: string;
  modelLabel: string;
  aboutUsd: number;
  atMostUsd: number;
  monthly: { limitUsd: number; spentUsd: number; leftUsd: number; monthLabel: string; resetLabel: string };
  /** Spent ≥ limit: starts are refused. */
  overLimit: boolean;
  /** Spent + at most > limit: the dialog warns "This may reach your monthly limit…". */
  mayReachLimit: boolean;
  /** The practice copy: made-up lines for free (every amount 0, no limit). */
  practiceCopy: boolean;
  /** The model has no price (a custom model without prices): nothing can be estimated and starts are refused. */
  priceMissing: boolean;
  /** One company's "about" and "at most" (unrounded): panel, Regenerate and Try again runs use one company's. */
  perCompany: CompanyCost;
};

/** Drafts looked at for the running averages (a few extra, because cost-estimated ones are left out). */
const SAMPLE_TAKE = 80;

/** The token inputs of one model's estimate: measured or default system tokens, and averages or defaults. */
async function estimateTokens(profile: ResolvedProfile): Promise<{ systemTokens: number; avgPageTokens: number; avgOutputTokens: number }> {
  const systemTokens = await systemTokensFor(profile.id, DRAFT_PROMPT_VERSION);
  const rows = await db.aiDraft.findMany({
    where: {
      model: profile.id,
      draftedAt: { not: null },
      calls: { gt: 0 },
      costUsd: { gt: 0 },
      inputTokens: { gt: 0 },
      outputTokens: { not: null },
    },
    orderBy: [{ draftedAt: "desc" }, { id: "desc" }],
    take: SAMPLE_TAKE,
    select: { inputTokens: true, outputTokens: true, calls: true, flags: true },
  });
  const samples: TokenSample[] = rows
    .filter((r) => !parseDraftFlags(r.flags).some((f) => f.code === "cost-estimated"))
    .map((r) => ({ inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, calls: r.calls }));
  const avg = averageCallTokens(samples, systemTokens);
  return {
    systemTokens,
    avgPageTokens: avg ? avg.pageTokens : profile.defaultPageTokens,
    avgOutputTokens: avg ? avg.outputTokens : profile.defaultOutputTokens,
  };
}

/**
 * The estimate for drafting `count` companies with the current model (or `opts.model`, e.g. each Settings › AI radio:
 * `aboutUsd(estimateDraftRun(300, now, {model}).aboutUsd)`), and this office month's spend against the limit.
 */
export async function estimateDraftRun(count: number, now: Date = new Date(), opts: { model?: string } = {}): Promise<AiRunEstimate> {
  const s = await getSettings([
    "ai.model",
    "ai.customModel",
    "ai.prices",
    "ai.monthlyLimitUsd",
    "sending.capDayTimeZone",
    "practice.copy",
  ] as const);
  const practiceCopy = s["practice.copy"] === true;
  const model = opts.model?.trim() || s["ai.model"];
  const profile = resolveProfile(model, s["ai.customModel"], s["ai.prices"]);
  const bounds = monthBounds(now, s["sending.capDayTimeZone"]);
  const limitUsd = Number.isFinite(Number(s["ai.monthlyLimitUsd"])) ? Math.max(0, Number(s["ai.monthlyLimitUsd"])) : 0;
  const spentUsd = await monthSpendUsd(now);
  const companies = Math.max(0, Math.floor(count));

  const perCompany: CompanyCost = practiceCopy
    ? { aboutUsd: 0, maxUsd: 0 }
    : (perCompanyUsd(profile, await estimateTokens(profile)) ?? { aboutUsd: 0, maxUsd: 0 });
  const priceMissing = !practiceCopy && profile.prices === null;
  const { aboutUsd, atMostUsd } = runCostUsd(companies, perCompany);
  return {
    companies,
    model: profile.id,
    modelLabel: profile.label,
    aboutUsd,
    atMostUsd,
    monthly: {
      limitUsd,
      spentUsd,
      leftUsd: roundUsd(Math.max(0, limitUsd - spentUsd)),
      monthLabel: bounds.label,
      resetLabel: bounds.resetLabel,
    },
    overLimit: !practiceCopy && spentUsd >= limitUsd,
    mayReachLimit: !practiceCopy && roundUsd(spentUsd + atMostUsd) > limitUsd,
    practiceCopy,
    priceMissing,
    perCompany,
  };
}
