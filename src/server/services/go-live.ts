import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { capDayOf, safeZone } from "@/core/sending/capday";
import { nextHealthSince } from "@/core/sending/health-since";
import { warmupTable } from "@/core/sending/caps";
import { senderHeaders } from "@/core/sending/from-address";
import { MODE_GATE_TEXTS } from "@/core/sending/mode-gates";
import { repliesOf, type RepliesMode } from "@/core/sending/own-mailbox";
import { warmupLine } from "@/core/sending/warmup-line";
import type { PlanLimits } from "@/core/mailgun/plan";
import { parseCapOverride, parseDomainCheckState, parsePauseState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { STATE_KEYS, type DomainCheckState, type PauseState } from "@/core/system-state";
import { logActivity } from "../activity";
import { db, dbTx, type Tx } from "../db";
import { notifyUsers } from "../notifications";
import { SETTING_DEFAULTS, getSettings, setSettingIn, type SettingKey, type SettingValue } from "../settings";
import { loadEffectiveMaxDailyCap, loadPlanLimits } from "./mailgun/plan";
import { loadTeamFrom, type TeamFromState } from "./mailgun/team-from";
import {
  goLiveBlockersFor,
  goLiveRecommendationsFor,
  loadGateInputs,
  normaliseTestList,
  spamPlacementsOf,
  type GateInputs,
} from "./reply-test";
import { loadWarmupProgress, startWarmupAtGoLive } from "./sending/warmup-days";

/**
 * The go-live switch (PLAN A8 item 6, B6.5, M6-DESIGN §2.4–§2.6): the card's view and `goLive()`, the only writer of
 * `sending.goLive = true`, `sending.goLiveAt`, `sending.goLiveDomain` and `sending.healthSinceGoLiveAt` (§0.2 rule 6;
 * review REPLIES-02). Going live is one-way per sending
 * domain (G1): only a domain change in connectMailgun ends it (G8). It refuses while any "Before going live:" item is
 * left, re-reads its inputs inside its transaction, switches Sending mode to Live (G4), removes today's hand-set limit
 * (G5), logs `sending.goLive`, tells every active user (`sending.wentLive`) and then restarts the warm-up (§2.6).
 *
 * Shared From address (SHARED-FROM-DESIGN §2.7, F12, F13, F21): a From address change also ends go-live (the second
 * writer of `sending.goLive = false`, in connect.ts); `goLive()` records the From address (`sending.goLiveFrom`), needs
 * the dialog's spam-placement tick while the reply test recorded a spam placement, and re-reads the From address in its
 * transaction. The view carries the From line for the card and the dialog, in both modes.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O14, O15, O20, O23, §3.4): the view carries the own From and whether the
 * http-links tick is needed (`ownMailbox`); `goLive()` needs the replies tick always and the http-links tick while the
 * https-links row isn't "ok", records the own From as `sending.goLiveFrom`, re-reads the way of sending and the plan in
 * its transaction, and starts the warm-up from the plan's effective maximum (90 on Free). App mode is unchanged.
 */

/** A refusal in plain words (the blockers joined with " ", or "Something changed while going live…"). */
export class GoLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoLiveError";
  }
}

export type GoLiveView = {
  practiceCopy: boolean;
  live: boolean;
  /** Setting "sending.goLiveAt". */
  at: Date | null;
  /** That Setting row's updatedById → User.name. */
  byName: string | null;
  /** The current sending domain. */
  domain: string | null;
  /** Live before, on another domain (a domain change ended go-live, G8): that domain; else null. */
  endedOnDomain: string | null;
  /** §2.4, "Before going live:" (empty once live). */
  blockers: string[];
  /** §2.4, "Recommended first:" (empty once live, and in the practice copy). */
  recommendations: string[];
  /**
   * Drafts that will send real email when launched after go-live (G11): DRAFT campaigns with an included person not on
   * the test list, the most people first. At most 5, plus the count of the rest.
   */
  drafts: { items: { id: number; name: string; people: number }[]; more: number };
  /** Today's hand-set limit that go-live removes (G5), or null. */
  capOverrideToday: number | null;
  /** Live only: `warmupLine(step, table, loadWarmupToday(now))` (§2.6). */
  warmupLine: string | null;
  // ── the shared From address (SHARED-FROM-DESIGN §3.3) ──
  /** The shared From address (valid, today's); null in per-person mode. */
  from: string | null;
  /** The Owner's per-person From line ("Arslan from Polygon Paradise <arslan@send.example.com>"), or null without an address. */
  ownFromExample: string | null;
  /** The reply test's spam placements ("Outlook.com (tess@outlook.com)"): the dialog then needs the extra tick (F12). */
  spamPlacements: string[];
  /** Not live, live before on this same domain with another From address (F13): that From (null = per-person); else null. */
  endedOnFrom: { was: string | null } | null;
  /**
   * MAIN-DOMAIN-DESIGN O14, O20: own-mailbox mode's own From ("" while none fits), the sending domain, and whether the
   * dialog needs the http-links tick (the https-links row isn't "ok"). Null or absent = app mode.
   */
  ownMailbox?: { from: string; domain: string; httpLinksTick: boolean } | null;
};

export type GoLiveResult = { alreadyLive: boolean; at: Date; modeBefore: "DRY_RUN" | "TEST" | "LIVE" };

/** Drafts shown by name in the card's dialog; the rest are "and 2 more". */
export const GO_LIVE_DRAFTS_SHOWN = 5;

function modeOf(v: unknown): "DRY_RUN" | "TEST" | "LIVE" {
  return v === "TEST" || v === "LIVE" ? v : "DRY_RUN";
}

function instantOrNull(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * DRAFT campaigns that would send real email when launched after go-live (G11): the included people who aren't on the
 * test list, per draft (one groupBy over the drafts' recipients). Most people first, then the oldest draft.
 */
async function draftsSendingRealEmail(testList: readonly string[]): Promise<GoLiveView["drafts"]> {
  const drafts = await db.campaign.findMany({
    where: { status: "DRAFT" },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  if (drafts.length === 0) return { items: [], more: 0 };
  const groups = await db.campaignRecipient.groupBy({
    by: ["campaignId"],
    where: {
      campaignId: { in: drafts.map((d) => d.id) },
      included: true,
      ...(testList.length > 0 ? { emailNorm: { notIn: [...testList] } } : {}),
    },
    _count: { _all: true },
  });
  const people = new Map(groups.map((g) => [g.campaignId, g._count._all]));
  const all = drafts
    .map((d) => ({ id: d.id, name: d.name, people: people.get(d.id) ?? 0 }))
    .filter((d) => d.people > 0)
    .sort((a, b) => b.people - a.people || a.id - b.id);
  return { items: all.slice(0, GO_LIVE_DRAFTS_SHOWN), more: Math.max(0, all.length - GO_LIVE_DRAFTS_SHOWN) };
}

/** Who switched go-live on: the "sending.goLiveAt" row's updatedById. */
async function goLiveByName(): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: "sending.goLiveAt" }, select: { updatedById: true } });
  if (!row?.updatedById) return null;
  const user = await db.user.findUnique({ where: { id: row.updatedById }, select: { name: true } });
  return user?.name ?? null;
}

/**
 * The card's view from gate inputs already loaded (Settings › Sending & Mailgun loads them once for the whole page).
 * Reads only; the drafts and the warm-up line are loaded here.
 */
export async function goLiveViewFrom(gate: GateInputs): Promise<GoLiveView> {
  const now = gate.now;
  const live = gate.goLive;
  const at = instantOrNull(gate.goLiveAt);
  let line: string | null = null;
  if (live) {
    const progress = await loadWarmupProgress(now);
    line = warmupLine(progress.step, progress.table, progress.today);
  }
  const endedOnDomain = !live && gate.goLiveDomain && gate.goLiveDomain !== gate.domain ? gate.goLiveDomain : null;
  const owner = gate.owner;
  const own = gate.replies === "own-mailbox";
  // The From evidence belongs to (O15): the shared From in app mode (exactly today's), the own From here.
  const evidenceFrom = own ? gate.evidenceFrom : gate.teamFrom;
  return {
    practiceCopy: gate.practiceCopy,
    live,
    at,
    byName: at ? await goLiveByName() : null,
    domain: gate.domain,
    endedOnDomain,
    blockers: live ? [] : goLiveBlockersFor(gate),
    recommendations: live ? [] : goLiveRecommendationsFor(gate),
    drafts: live || gate.practiceCopy ? { items: [], more: 0 } : await draftsSendingRealEmail(gate.testList),
    capOverrideToday: live ? null : gate.capOverrideToday,
    warmupLine: line,
    from: gate.teamFrom,
    ownFromExample:
      owner && gate.ownerAddress && !own
        ? // The per-person From line, from the one place every From line comes from (SHARED-FROM-DESIGN §0.2 rule 5).
          senderHeaders({ displayName: (owner.senderDisplayName ?? "").trim() || owner.name, senderAddress: gate.ownerAddress.address, teamFrom: null }).from
        : null,
    spamPlacements: live ? [] : gate.spamPlacements,
    endedOnFrom:
      !live && !endedOnDomain && gate.goLiveAt && gate.goLiveDomain && gate.goLiveDomain === gate.domain && gate.goLiveFrom !== evidenceFrom
        ? { was: gate.goLiveFrom }
        : null,
    ...(own ? { ownMailbox: { from: gate.ownFrom ?? "", domain: gate.domain ?? "", httpLinksTick: gate.httpsLinksOk !== true } } : {}),
  };
}

/** The "Go live" card's view (§2.5): state, blockers, recommendations, drafts, today's override and the warm-up line. */
export async function loadGoLiveView(now: Date = new Date()): Promise<GoLiveView> {
  return goLiveViewFrom(await loadGateInputs(now));
}

// ───────────────────────── the switch ─────────────────────────

/** The settings goLive() re-reads inside its transaction. */
const IN_TX_KEYS = [
  "sending.goLive",
  "sending.goLiveAt",
  "sending.goLiveDomain",
  "sending.healthSinceGoLiveAt",
  "sending.mode",
  "sending.testList",
  "sending.capOverride",
  "sending.capDayTimeZone",
  "practice.copy",
  "mailgun.domain",
  "mailgun.unsubscribeTest",
  "mailgun.fromAddress",
] as const satisfies readonly SettingKey[];

type InTxSettings = { [K in (typeof IN_TX_KEYS)[number]]: SettingValue<K> };

/** getSettings inside the open transaction (same defaults), so the re-read sees exactly what the switch commits over. */
async function readSettingsIn(tx: Tx): Promise<InTxSettings> {
  const rows = await tx.setting.findMany({ where: { key: { in: [...IN_TX_KEYS] } }, select: { key: true, value: true } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<string, unknown>;
  for (const k of IN_TX_KEYS) out[k] = map.has(k) ? map.get(k) : SETTING_DEFAULTS[k];
  return out as InTxSettings;
}

const lower = (v: unknown): string | null => (typeof v === "string" ? v.trim().toLowerCase() || null : null);

/** The plan limits as one comparable value (MAIN-DOMAIN-DESIGN O22). */
function planKey(limits: PlanLimits | null | undefined): string {
  return limits ? `${limits.plan}:${limits.assumed ? "assumed" : "chosen"}` : "none";
}

/**
 * Whether what the check was made on still holds (§2.5 step 2): the practice copy flag, the sending domain, the reply
 * test (setup, result, its domain and, SHARED-FROM-DESIGN §3.4, its From address), the saved From address, the reply
 * test's spam placements (F12), the test list, the pause and the Domain checklist's check time.
 *
 * MAIN-DOMAIN-DESIGN §8 P4: also the way of sending and the plan (`team` and `limits`, re-read inside the transaction
 * through `loadTeamFrom(tx)` and `loadPlanLimits(tx)`, the only readers of the mode setting, §0.2 rule 5), the mode the
 * reply test was decided in and the mode the checklist was checked in.
 */
function sameInputs(
  gate: GateInputs,
  s: InTxSettings,
  pause: PauseState,
  check: DomainCheckState,
  team: Pick<TeamFromState, "replies">,
  limits: PlanLimits | null,
): boolean {
  const domain = (s["mailgun.domain"] ?? "").trim().toLowerCase() || null;
  const replyTest = parseUnsubscribeTest(s["mailgun.unsubscribeTest"]);
  const testList = normaliseTestList(s["sending.testList"]);
  const gateReplies: RepliesMode = gate.replies === "own-mailbox" ? "own-mailbox" : "app";
  const spam = spamPlacementsOf(replyTest, testList, gateReplies === "own-mailbox" ? gate.evidenceFrom : gate.teamFrom);
  return (
    (s["practice.copy"] === true) === gate.practiceCopy &&
    domain === gate.domain &&
    lower(s["mailgun.fromAddress"]) === gate.teamFromSaved &&
    team.replies === gateReplies &&
    planKey(limits) === planKey(gate.planLimits) &&
    replyTest.setup === gate.setting.setup &&
    replyTest.status === gate.setting.status &&
    replyTest.domain === gate.setting.domain &&
    lower(replyTest.from) === lower(gate.setting.from) &&
    (replyTest.replies ?? null) === (gate.setting.replies ?? null) &&
    spam.length === gate.spamPlacements.length &&
    spam.every((a, i) => a === gate.spamPlacements[i]) &&
    testList.length === gate.testList.length &&
    testList.every((a, i) => a === gate.testList[i]) &&
    pause.paused === gate.pause.paused &&
    check.domain === gate.check.domain &&
    check.checkedAt === gate.check.checkedAt &&
    repliesOf(check.replies) === repliesOf(gate.check.replies)
  );
}

function alreadyLive(s: { "sending.goLiveAt": string | null; "sending.mode": unknown }, now: Date): GoLiveResult {
  return { alreadyLive: true, at: instantOrNull(s["sending.goLiveAt"]) ?? now, modeBefore: modeOf(s["sending.mode"]) };
}

/**
 * The only writer of go-live = true (§0.2 rule 6; §2.5 steps):
 *  1. already live → `alreadyLive` (no check, no write); otherwise the gate inputs are loaded and any blocker refuses
 *     with GoLiveError (the sentences joined with " "), nothing written;
 *  2. one transaction: go-live re-read (already live → `alreadyLive`), the inputs re-read and compared (a difference →
 *     "Something changed while going live. Check the list again.", nothing written); then `sending.goLive`,
 *     `sending.goLiveAt`, `sending.goLiveDomain` and `sending.mode = "LIVE"` (all by the actor), today's hand-set limit
 *     removed, the `sending.goLive` activity and a `sending.wentLive` notification for every active user;
 *  3. after the commit the warm-up restarts at step 0 (a failure is logged and never undoes go-live: the next hourly
 *     warm-up check repairs it).
 * `opts.confirmSpamPlacement` (SHARED-FROM-DESIGN F12): the Owner ticked "I know the reply test's email landed in
 * spam…" in the dialog; while the reply test recorded a spam placement, going live refuses without it
 * (`GO_LIVE_COPY.spamPlacementRequired`, before the transaction, which re-reads the answers through sameInputs). The
 * transaction also writes `sending.goLiveFrom` (the shared From address, null in per-person mode), and the activity
 * carries `from` (and `spamPlacementConfirmed` when the tick was needed).
 * Review REPLIES-02: it also writes `sending.healthSinceGoLiveAt` (`nextHealthSince`): bounces and complaints keep
 * counting from the first go-live on this sending domain when the Owner goes live again after a From change, and start
 * again only on another domain. The warm-up still restarts at every go-live.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O14, O20): after the blockers, and before the transaction, it refuses without
 * `opts.confirmOwnMailbox` (`GO_LIVE_COPY.ownMailboxRequired`) and, while the https-links row isn't "ok", without
 * `opts.confirmHttpLinks` (`GO_LIVE_COPY.httpLinksRequired`), in that order, then the spam-placement tick; it writes
 * `sending.goLiveFrom` = the own From (O15) and the activity's data gains `replies`, `ownMailboxConfirmed` and
 * `httpLinksConfirmed`. In every mode the warm-up's start cap comes from `loadEffectiveMaxDailyCap()` (O23).
 */
export async function goLive(
  actor: { id: number; name: string },
  opts: {
    now?: Date;
    confirmSpamPlacement?: boolean;
    /** MAIN-DOMAIN-DESIGN O14: own-mailbox mode's replies tick (`GO_LIVE_COPY.ownMailboxTick`), checked here. */
    confirmOwnMailbox?: boolean;
    /** MAIN-DOMAIN-DESIGN O14, O20: the http-links tick while the https-links row isn't "ok", checked here. */
    confirmHttpLinks?: boolean;
  } = {},
): Promise<GoLiveResult> {
  const now = opts.now ?? new Date();
  const first = await getSettings(["sending.goLive", "sending.goLiveAt", "sending.mode"] as const);
  if (first["sending.goLive"] === true) return alreadyLive(first, now);

  const gate = await loadGateInputs(now);
  const blockers = goLiveBlockersFor(gate);
  if (blockers.length > 0) throw new GoLiveError(blockers.join(" "));
  const domain = gate.domain;
  if (!domain) throw new GoLiveError(MODE_GATE_TEXTS.connect);
  const own = gate.replies === "own-mailbox";
  // Own-mailbox mode (O14, O20): the replies tick always, the http-links tick while the https-links row isn't "ok".
  const httpLinksConfirmed = own && gate.httpsLinksOk !== true;
  if (own && opts.confirmOwnMailbox !== true) throw new GoLiveError(GO_LIVE_COPY.ownMailboxRequired);
  if (httpLinksConfirmed && opts.confirmHttpLinks !== true) throw new GoLiveError(GO_LIVE_COPY.httpLinksRequired);
  const spamPlacementConfirmed = gate.spamPlacements.length > 0;
  if (spamPlacementConfirmed && opts.confirmSpamPlacement !== true) throw new GoLiveError(GO_LIVE_COPY.spamPlacementRequired);
  // The From evidence belongs to (O15): the shared From in app mode, the own From here.
  const goLiveFrom = own ? gate.evidenceFrom : gate.teamFrom;
  const w = await getSettings(["warmup.startCap", "warmup.steps"] as const);
  // MAIN-DOMAIN-DESIGN O23: the table's maximum never above the plan's limit minus the reserve (90 on Free).
  const { maxCap } = await loadEffectiveMaxDailyCap();
  const startCap = warmupTable(Number(w["warmup.startCap"]), maxCap, Number(w["warmup.steps"]))[0] ?? 50;

  const result = await dbTx(async (tx): Promise<GoLiveResult> => {
    const s = await readSettingsIn(tx);
    if (s["sending.goLive"] === true) return alreadyLive(s, now);
    const pauseRow = await tx.systemState.findUnique({ where: { key: STATE_KEYS.pause }, select: { value: true } });
    const checkRow = await tx.systemState.findUnique({ where: { key: STATE_KEYS.domainCheck }, select: { value: true } });
    const team = await loadTeamFrom(tx);
    const limits = await loadPlanLimits(tx);
    if (!sameInputs(gate, s, parsePauseState(pauseRow?.value ?? null), parseDomainCheckState(checkRow?.value ?? null), team, limits)) {
      throw new GoLiveError(GO_LIVE_COPY.changed);
    }

    const modeBefore = modeOf(s["sending.mode"]);
    const override = parseCapOverride(s["sending.capOverride"]);
    const capOverrideCleared = override && override.capDay === capDayOf(now, safeZone(s["sending.capDayTimeZone"])) ? override.cap : null;
    const at = now.toISOString();
    // Health counts from the first go-live on this sending domain (review REPLIES-02), read before this go-live
    // overwrites "sending.goLiveAt" and "sending.goLiveDomain": going live again after a From change keeps it.
    const healthSince = nextHealthSince(
      { goLiveAt: s["sending.goLiveAt"], goLiveDomain: s["sending.goLiveDomain"], healthSince: s["sending.healthSinceGoLiveAt"] },
      domain,
      at,
    );
    await setSettingIn(tx, "sending.goLive", true, actor.id);
    await setSettingIn(tx, "sending.goLiveAt", at, actor.id);
    await setSettingIn(tx, "sending.goLiveDomain", domain, actor.id);
    await setSettingIn(tx, "sending.healthSinceGoLiveAt", healthSince, actor.id);
    await setSettingIn(tx, "sending.goLiveFrom", goLiveFrom, actor.id);
    await setSettingIn(tx, "sending.mode", "LIVE", actor.id);
    if (capOverrideCleared !== null) await setSettingIn(tx, "sending.capOverride", null, actor.id);
    await logActivity(
      {
        actorId: actor.id,
        type: "sending.goLive",
        summary: GO_LIVE_COPY.activity(actor.name, domain),
        data: {
          at,
          domain,
          modeFrom: modeBefore,
          modeTo: "LIVE",
          capOverrideCleared,
          from: goLiveFrom,
          ...(spamPlacementConfirmed ? { spamPlacementConfirmed: true } : {}),
          ...(own ? { replies: "own-mailbox", ownMailboxConfirmed: true, httpLinksConfirmed } : {}),
        },
      },
      tx,
    );
    const users = await tx.user.findMany({ where: { active: true }, select: { id: true }, orderBy: { id: "asc" } });
    await notifyUsers(
      users.map((u) => u.id),
      {
        type: "sending.wentLive",
        title: GO_LIVE_COPY.notificationTitle,
        body: GO_LIVE_COPY.notificationBody(actor.name, startCap),
        link: "/dashboard",
      },
      tx,
    );
    return { alreadyLive: false, at: now, modeBefore };
  });

  if (!result.alreadyLive) {
    try {
      await startWarmupAtGoLive(now);
    } catch (err) {
      // Go-live stays on: evaluateWarmupDays restarts the ramp at the go-live day on its next hourly run (§2.6).
      console.error("[go-live] couldn't restart the warm-up; the next warm-up check does it", err);
    }
  }
  return result;
}
