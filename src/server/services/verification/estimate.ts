import { estimateChecks, type CheckEstimate } from "@/core/verification/estimate";
import { FAKE_SERVER_PROVIDER, TEST_CHECKER_PROVIDER } from "@/core/verification/types";
import { NO_CHECK_KEY_TEXT } from "@/core/verification/words";
import { assertKeyMatchesTarget, isFakeMode } from "@/server/mailgun/base-url";
import { NOT_CONNECTED_TEXT } from "@/server/mailgun/context";
import { getSecret, type SecretKey } from "@/server/secrets";
import { getSettings } from "@/server/settings";
import { checksThisMonth } from "./spend";

/**
 * Which checker a new run would use, at what price, and what it would cost (M5-DESIGN §2.2, §2.10). No client is
 * built and nothing is called: the start screens only need to know whether checks can run and what they cost.
 */

export type CheckerInfo = {
  /** "mailgun" | "mailgun-fake" | "fake" (the test checker, in the practice copy). */
  provider: string;
  /** Dollars per answered check (0 for the test checker). */
  pricePerCheck: number;
  practiceCopy: boolean;
  /** Why checks can't run right now (no key, an unreadable key, a key that doesn't fit the server), else null. */
  notReady: string | null;
};

/** Setting "verification.pricePerCheck" as a usable number (the default $0.012 when broken). */
export function priceFromSetting(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0.012;
}

/** A secret, or "unreadable" when it can't be decrypted (the app's encryption key changed). */
async function readSecret(name: SecretKey): Promise<string | null | "unreadable"> {
  try {
    return await getSecret(name);
  } catch {
    return "unreadable";
  }
}

/**
 * The checker a run would use, with the same rule as `getVerifier` (M5-DESIGN §2.2): the practice copy uses the free
 * test checker; otherwise Mailgun with the saved address check key, else the Mailgun key. Its texts are Mailgun's
 * NOT_CONNECTED_TEXT ones, so every screen says the same.
 */
export async function resolveChecker(): Promise<CheckerInfo> {
  const s = await getSettings(["practice.copy", "verification.pricePerCheck"] as const);
  if (s["practice.copy"] === true) {
    return { provider: TEST_CHECKER_PROVIDER, pricePerCheck: 0, practiceCopy: true, notReady: null };
  }
  const provider = isFakeMode() ? FAKE_SERVER_PROVIDER : "mailgun";
  const pricePerCheck = priceFromSetting(s["verification.pricePerCheck"]);
  let key = await readSecret("verification.apiKey");
  if (key !== "unreadable" && !key) key = await readSecret("mailgun.apiKey");
  let notReady: string | null = null;
  if (key === "unreadable") notReady = NOT_CONNECTED_TEXT.unreadable;
  else if (!key) notReady = NO_CHECK_KEY_TEXT;
  else {
    try {
      assertKeyMatchesTarget(key);
    } catch {
      notReady = NOT_CONNECTED_TEXT.mismatch;
    }
  }
  return { provider, pricePerCheck, practiceCopy: false, notReady };
}

/** Everything an estimate needs, loaded once so a screen can price several counts. */
export type CheckPricing = {
  checker: CheckerInfo;
  /** Setting "verification.includedPerMonth". */
  includedPerMonth: number;
  /** Real checks this office month. */
  usedThisMonth: number;
  /** What they cost. */
  spentUsd: number;
};

/** The checker, the plan's included checks and this office month's checks. */
export async function loadCheckPricing(now: Date = new Date()): Promise<CheckPricing> {
  const [checker, s, month] = await Promise.all([
    resolveChecker(),
    getSettings(["verification.includedPerMonth"] as const),
    checksThisMonth(now),
  ]);
  const included = Number(s["verification.includedPerMonth"]);
  return {
    checker,
    includedPerMonth: Number.isFinite(included) && included > 0 ? Math.floor(included) : 0,
    usedThisMonth: month.count,
    spentUsd: month.costUsd,
  };
}

/** The estimate for `count` addresses with loaded pricing (the test checker never uses up included checks). */
export function estimateFor(pricing: CheckPricing, count: number): CheckEstimate {
  return estimateChecks({
    count,
    pricePerCheck: pricing.checker.pricePerCheck,
    includedPerMonth: pricing.includedPerMonth,
    usedThisMonth: pricing.checker.provider === TEST_CHECKER_PROVIDER ? 0 : pricing.usedThisMonth,
    provider: pricing.checker.provider,
  });
}

/** What checking `count` addresses would cost now (M5-DESIGN §2.10). */
export async function checkCostEstimate(count: number, now: Date = new Date()): Promise<CheckEstimate> {
  return estimateFor(await loadCheckPricing(now), count);
}
