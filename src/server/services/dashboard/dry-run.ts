import type { SendMode } from "@/generated/prisma/client";
import { capDayBounds, capDayOf, safeZone } from "@/core/sending/capday";
import { plural } from "@/core/text";
import { db } from "@/server/db";
import { waitingReplyWhere } from "@/server/notifications";
import { getSettings } from "@/server/settings";

/**
 * The dashboard's "Dry runs and test mode" tile (M6-DESIGN §4.3, PLAN B6.5 "shown separately"): dry runs and Mailgun's
 * test mode don't count as emailed and aren't in the Companies, Today or Domain health numbers, so they get their own
 * numbers. Read-only (§0.2 rule 8): two `groupBy`s and one count.
 */

export type DryRunSummary = {
  /** Emails of that mode sent this cap day (dry runs: into the outbox). */
  today: { dryRun: number; testMode: number };
  /** Campaigns of that mode that are running or scheduled. */
  running: { dryRun: number; testMode: number };
  /** Waiting replies to dry runs or test mode (`replyScope` "campaign"), which the bell doesn't count. */
  waitingReplies: number;
};

const SHOWN_MODES: SendMode[] = ["DRY_RUN", "TEST"];

/**
 * Today's dry-run and test-mode numbers. "Today" is the cap day in Setting "sending.capDayTimeZone" (midnight to
 * midnight there, DST-safe); the counts are OutboundEmail rows of that mode that are SENT with `sentAt` in the day;
 * "running" = campaigns of that mode in RUNNING or SCHEDULED. Null (the tile is hidden) in the practice copy, where dry
 * runs are the real thing and already in every other tile, and when every number is 0.
 *
 * The day's emails are found by `sentAt` alone and only the SENT groups are counted: a `status` condition in the SQL
 * would make SQLite read every SENT email ever sent through the (status, dueAt) index (review DASHBOARD-2).
 */
export async function loadDryRunSummary(now: Date): Promise<DryRunSummary | null> {
  const s = await getSettings(["practice.copy", "sending.capDayTimeZone"] as const);
  if (s["practice.copy"] === true) return null;
  const zone = safeZone(s["sending.capDayTimeZone"]);
  const { start, end } = capDayBounds(capDayOf(now, zone), zone);
  const [sent, campaigns, waitingReplies] = await Promise.all([
    db.outboundEmail
      .groupBy({
        by: ["mode", "status"],
        where: { mode: { in: SHOWN_MODES }, sentAt: { gte: start, lt: end } },
        _count: { _all: true },
      })
      .then((rows) => rows.filter((r) => r.status === "SENT")),
    db.campaign.groupBy({
      by: ["mode"],
      where: { mode: { in: SHOWN_MODES }, status: { in: ["RUNNING", "SCHEDULED"] } },
      _count: { _all: true },
    }),
    db.inboundMessage.count({ where: waitingReplyWhere(undefined, { dryRun: "only" }) }),
  ]);
  const of = (rows: ReadonlyArray<{ mode: SendMode | null; _count: { _all: number } }>, mode: SendMode) =>
    rows.find((r) => r.mode === mode)?._count._all ?? 0;
  const summary: DryRunSummary = {
    today: { dryRun: of(sent, "DRY_RUN"), testMode: of(sent, "TEST") },
    running: { dryRun: of(campaigns, "DRY_RUN"), testMode: of(campaigns, "TEST") },
    waitingReplies,
  };
  const any =
    summary.today.dryRun + summary.today.testMode + summary.running.dryRun + summary.running.testMode + summary.waitingReplies > 0;
  return any ? summary : null;
}

/**
 * The tile's lines (§4.3), each part left out when it is 0, a line left out when all its parts are:
 * "Dry run today: 40 emails in the outbox · 2 campaigns running", "Test mode today: 3 emails · 1 campaign running",
 * "Dry-run replies waiting: 1".
 */
export function dryRunLines(s: DryRunSummary): string[] {
  const lines: string[] = [];
  const running = (count: number) => `${plural(count, "campaign", "campaigns")} running`;
  const dry = [
    ...(s.today.dryRun > 0 ? [`${plural(s.today.dryRun, "email", "emails")} in the outbox`] : []),
    ...(s.running.dryRun > 0 ? [running(s.running.dryRun)] : []),
  ];
  if (dry.length > 0) lines.push(`Dry run today: ${dry.join(" · ")}`);
  const test = [
    ...(s.today.testMode > 0 ? [plural(s.today.testMode, "email", "emails")] : []),
    ...(s.running.testMode > 0 ? [running(s.running.testMode)] : []),
  ];
  if (test.length > 0) lines.push(`Test mode today: ${test.join(" · ")}`);
  if (s.waitingReplies > 0) lines.push(`Dry-run replies waiting: ${s.waitingReplies.toLocaleString("en-US")}`);
  return lines;
}
