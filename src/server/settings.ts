import { DEFAULT_AI_PRICES } from "@/core/ai/types";
import type { MailgunPlan } from "@/core/mailgun/plan";
import type { RepliesMode } from "@/core/sending/own-mailbox";
import {
  DEFAULT_UNSUBSCRIBE_TEST,
  type AiCustomModel,
  type AiPrices,
  type CapOverride,
  type HealthSinceGoLive,
  type UnsubscribeTestSetting,
  type VerificationPolicySetting,
} from "@/core/setting-types";
import { db, dbWrite, type Tx } from "./db";

/**
 * Owner-edited configuration. Every setting has a default here, so a fresh
 * database works without any rows. Worker-owned state lives in SystemState (state.ts).
 */
export const SETTING_DEFAULTS = {
  // Sending (Milestone 2–3)
  "sending.mode": "DRY_RUN" as "DRY_RUN" | "TEST" | "LIVE",
  /**
   * True only through goLive(); set back to false only in connect.ts: by a sending-domain change (M6-DESIGN §0.2 rule 6,
   * G8) or a From address change (saveFromAddress, SHARED-FROM-DESIGN §0.2 rule 9, F13).
   */
  "sending.goLive": false,
  /** When go-live was switched on (ISO), written only by goLive(); kept after a domain change ends it (M6-DESIGN §7.1). */
  "sending.goLiveAt": null as string | null,
  /** The sending domain go-live was switched on for, written only by goLive() (M6-DESIGN §7.1). */
  "sending.goLiveDomain": null as string | null,
  /**
   * The shared From address go-live was switched on with (null = per-person mode), written only by goLive()
   * (SHARED-FROM-DESIGN §7.1, F13); kept after a From change ends go-live, for "You were live with …".
   */
  "sending.goLiveFrom": null as string | null,
  /**
   * Since when bounces and complaints count on real data: the first go-live on the go-live domain, written only by
   * goLive() (review REPLIES-02). Going live again on the same domain after a From change keeps it; null or a value of
   * another go-live = count from "sending.goLiveAt" (read it only through `healthGoLiveAt`, @/core/sending/health-since).
   */
  "sending.healthSinceGoLiveAt": null as HealthSinceGoLive | null,
  "sending.testList": [] as string[],
  "sending.window": { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  "sending.maxDailyCap": 1000,
  "sending.capDayTimeZone": "Asia/Karachi",
  "sending.minGapSeconds": 20,
  /** The Owner's confirmed change of TODAY's limit (M3-DESIGN §2.1); ignored on any other cap day. */
  "sending.capOverride": null as CapOverride | null,
  // Warm-up and health
  "warmup.startCap": 50,
  "warmup.steps": 20,
  "warmup.minUsePercent": 50,
  "warmup.healthyBouncePercent": 2,
  "warmup.healthyComplaintPercent": 0.05,
  "health.bounceWindow": 200,
  "health.bouncePercent": 3,
  "health.complaintWindow": 1000,
  "health.complaintPercent": 0.1,
  // Team rule and reservations
  "teamRule.days": 30,
  "reservations.pausedExpiryDays": 14,
  // Address checks
  "verification.provider": "mailgun",
  "verification.pricePerCheck": 0.012,
  "verification.maxAgeDays": 90,
  "verification.policy": {
    deliverableHighRisk: "block",
    catchAllLow: "send",
    catchAllMedium: "block",
    catchAllHigh: "block",
    disposable: "block",
    unknown: "recheck",
  } as VerificationPolicySetting,
  /** Checks the Mailgun plan includes each office month (0 on Foundation, M5-DESIGN §2.10). */
  "verification.includedPerMonth": 0,
  /** Address checks running at the same time in a check run (at most CHECK_CONCURRENCY_MAX). */
  "verification.concurrency": 2,
  /** Dollars of address checks per office month; starts refuse and runs pause above it (M5-DESIGN D28). */
  "verification.monthlyLimitUsd": 100,
  // Email footer and links
  "footer.companyName": "Polygon Paradise",
  "footer.address": "55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan",
  "footer.unsubscribeText": "If you'd rather not hear from us, unsubscribe here:",
  "portfolioUrl": "https://www.polygonparadise.com",
  // Time zones
  "defaultTimeZone": "Europe/Berlin",
  // Import / matching
  "sharedDomains.extra": [] as string[],
  // Backups
  "backups.keep": 14,
  "backups.secondFolder": null as string | null,
  // Mailgun (Milestone 3)
  "mailgun.region": "EU" as "EU" | "US",
  "mailgun.domain": null as string | null,
  /**
   * The shared From address every campaign email shows, e.g. contact@polygonparadise.com (SHARED-FROM-DESIGN §2.2, F2);
   * null = per-person mode (each sender's own address is the From, today's behaviour). Written only by saveFromAddress;
   * read only through loadTeamFrom() (@/server/services/mailgun/team-from), never raw.
   */
  "mailgun.fromAddress": null as string | null,
  /**
   * How the app sends (MAIN-DOMAIN-DESIGN O1, §7.1): "app" (the default: replies come back through Mailgun routes,
   * per-person or shared-From mode) or "own-mailbox" (the sending domain is the Owner's own mailbox domain, every email
   * From the own From, no Reply-To, replies land in that mailbox only). Written only by saveConnection (connect.ts),
   * with "mailgun.domain" and "mailgun.region"; read only through loadTeamFrom(), loadPlanLimits() and
   * getMailgunContext(), each through repliesOf() (anything but exactly "own-mailbox" reads as "app").
   */
  "mailgun.replies": "app" as RepliesMode,
  /**
   * The Mailgun plan the Owner chose (MAIN-DOMAIN-DESIGN O22, §7.1); null = not chosen ("Not sure"). Written by
   * saveRetentionAction with the retention numbers, and once by saveConnection on the first own-mailbox connect while it
   * is null ("free", with 1/1 days). Read only through loadPlanLimits() (planOf()).
   */
  "mailgun.plan": null as MailgunPlan | null,
  "mailgun.logRetentionDays": 5,
  "mailgun.messageRetentionDays": 1,
  /** The real-reply test that decides the unsubscribe setup (PLAN A4.5, B6.8). */
  "mailgun.unsubscribeTest": DEFAULT_UNSUBSCRIBE_TEST as UnsubscribeTestSetting,
  /** Optional: the day the Owner bought the sending domain ("YYYY-MM-DD"), for the checklist's age row. */
  "mailgun.domainRegisteredOn": null as string | null,
  // Remote access (Milestone 6)
  /** "We don't use Cloudflare Access" (M6-DESIGN G7): the remote-access row accepts an open sign-in page. */
  "remoteAccess.accessOff": false,
  // AI
  "ai.model": "claude-haiku-4-5-20251001",
  "ai.monthlyLimitUsd": 20,
  /** Dollars per million tokens per model id (Settings › AI). */
  "ai.prices": DEFAULT_AI_PRICES as AiPrices,
  /** "Another Claude model", checked with models.retrieve (M5-DESIGN §3.5.1); null = none. */
  "ai.customModel": null as AiCustomModel | null,
  // True only in the practice copy's database (written by scripts/make-demo-data.ts, PLAN.md B6.5).
  "practice.copy": false,
} as const;

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? Widen<U>[]
        : T extends object
          ? { -readonly [K in keyof T]: Widen<T[K]> }
          : T;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = K extends "sending.mode"
  ? "DRY_RUN" | "TEST" | "LIVE"
  : K extends "mailgun.region"
    ? "EU" | "US"
    : K extends
          | "backups.secondFolder"
          | "mailgun.domain"
          | "mailgun.domainRegisteredOn"
          | "mailgun.fromAddress"
          | "sending.goLiveAt"
          | "sending.goLiveDomain"
          | "sending.goLiveFrom"
      ? string | null
      : K extends "sending.capOverride"
        ? CapOverride | null
        : K extends "sending.healthSinceGoLiveAt"
          ? HealthSinceGoLive | null
          : K extends "mailgun.unsubscribeTest"
            ? UnsubscribeTestSetting
            : K extends "verification.policy"
              ? VerificationPolicySetting
              : K extends "ai.prices"
                ? AiPrices
                : K extends "ai.customModel"
                  ? AiCustomModel | null
                  : K extends "mailgun.replies"
                    ? RepliesMode
                    : K extends "mailgun.plan"
                      ? MailgunPlan | null
                      : Widen<(typeof SETTING_DEFAULTS)[K]>;

/**
 * A key's default. Array and object defaults (the test list, the sending window, the reply test…) are copied, so a
 * caller that changes the value it got (e.g. pushes to an array) never changes the default for the whole process.
 */
function defaultOf<K extends SettingKey>(key: K): SettingValue<K> {
  const v = SETTING_DEFAULTS[key];
  return (v !== null && typeof v === "object" ? structuredClone(v) : v) as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) return defaultOf(key);
  return row.value as SettingValue<K>;
}

export async function getSettings<K extends SettingKey>(keys: readonly K[]): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = await db.setting.findMany({ where: { key: { in: [...keys] } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as { [P in K]: SettingValue<P> };
  for (const k of keys) {
    out[k] = (map.has(k) ? map.get(k) : defaultOf(k)) as SettingValue<typeof k>;
  }
  return out;
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  userId: number | null,
): Promise<void> {
  await dbWrite((c) =>
    c.setting.upsert({
      where: { key },
      create: { key, value: value as never, updatedById: userId },
      update: { value: value as never, updatedById: userId },
    }),
  );
}

/** One setting inside an open transaction (M6-DESIGN §2.5, §5.3: go-live and the rule settings write several settings and their activity together). */
export async function setSettingIn<K extends SettingKey>(
  tx: Tx,
  key: K,
  value: SettingValue<K>,
  userId: number | null,
): Promise<void> {
  await tx.setting.upsert({
    where: { key },
    create: { key, value: value as never, updatedById: userId },
    update: { value: value as never, updatedById: userId },
  });
}
