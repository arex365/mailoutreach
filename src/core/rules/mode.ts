/**
 * Sending modes and what counts as "really emailed" (PLAN.md A5.1, B6.5). Pure and browser-safe.
 *
 * Each campaign keeps the mode it was launched with for its whole life. Only real sends count
 * as contact (company status, "emailed" fields, the 30-day rule, reservations). In the practice
 * copy (Setting "practice.copy", only ever true in data/demo.db) a dry run behaves like live for
 * the app's own state, so people can try the whole flow without sending anything.
 *
 * Two words (M3-DESIGN §0.3): "counted" (countsAsReal: the daily limit, warm-up and health) and
 * "emailed" (countsAsEmailed: the 30-day rule, reservations, company status, lastEmailed*), which
 * leaves out LIVE sends of a campaign launched before go-live (they can only reach the test list;
 * M6-DESIGN §2.2 judges this per campaign by `Campaign.launchedGoLive`, never by today's switch).
 * "Test-list only" (testListOnly, M6-DESIGN §2.3) says which sends may only reach the test list.
 */

/** Mirrors the Prisma enum SendMode. */
export type SendModeValue = "DRY_RUN" | "TEST" | "LIVE";

export const SEND_MODES: readonly SendModeValue[] = ["DRY_RUN", "TEST", "LIVE"];

/**
 * True when a send in this mode counts as a real email: always for LIVE, and for DRY_RUN only in
 * the practice copy. TEST (Mailgun's test mode) never counts.
 */
export function countsAsReal(mode: SendModeValue | null | undefined, practiceCopy: boolean): boolean {
  return mode === "LIVE" || (practiceCopy && mode === "DRY_RUN");
}

/** The modes whose sends count as real, for database filters (`mode: { in: realModes(p) }`). */
export function realModes(practiceCopy: boolean): SendModeValue[] {
  return practiceCopy ? ["LIVE", "DRY_RUN"] : ["LIVE"];
}

/**
 * "Emailed" (PLAN A5.1, M3-DESIGN §1.7, M6-DESIGN §2.2): every counted send except LIVE sends of a campaign launched
 * before go-live (they could only reach the test list). Judged per campaign by its launch flag, never by today's switch:
 * a pre-go-live test campaign still running after go-live stays "not emailed", so the test mailboxes never become
 * Contacted or blocked by the 30-day rule. Database filters use `emailedSendWhere` (@/server/services/emailed).
 */
export function countsAsEmailed(
  mode: SendModeValue | null | undefined,
  ctx: {
    practiceCopy: boolean;
    /**
     * The campaign's `launchedGoLive`: true only when it was launched after go-live. Only an explicit true counts
     * (false for launches before go-live, null for drafts).
     */
    launchedGoLive: boolean | null | undefined;
  },
): boolean {
  return countsAsReal(mode, ctx.practiceCopy) && !(mode === "LIVE" && ctx.launchedGoLive !== true);
}

/**
 * Test-list-only sending (M6-DESIGN §2.3): Mailgun's test mode always, live before go-live. `goLive` is today's setting
 * in the draft and at launch, and the campaign's launch flag at send time.
 */
export function testListOnly(mode: SendModeValue | null | undefined, goLive: boolean): boolean {
  return mode === "TEST" || (mode === "LIVE" && !goLive);
}

/** "Dry run" / "Test" / "Live". */
export function modeLabel(mode: SendModeValue | null | undefined): string {
  if (mode === "TEST") return "Test";
  if (mode === "LIVE") return "Live";
  return "Dry run";
}
