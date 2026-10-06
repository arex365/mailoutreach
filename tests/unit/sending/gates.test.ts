import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW } from "@/core/sending/window";
import { notPaused, parseCatchUpState, parsePacerState } from "@/core/system-state-parse";
import type { CatchUpState, ChecklistRow, PacerState } from "@/core/system-state";
import {
  MAX_SENDABLE_STEP,
  SEND_BATCH,
  compareCandidates,
  gateClass,
  isCatchUpReady,
  isFollowUpCatchUpReady,
  isLiveReady,
  isMainDomainMxOk,
  noProblems,
  outageHoldPending,
  planTick,
  type Candidate,
  type GateContext,
} from "@/server/services/sending/gates";
import type { TodayCap } from "@/server/services/sending/usage";

/**
 * The gates' pure parts (M3-DESIGN §4.3.2): which class an email is in, when the start-up check with Mailgun lets
 * emails go, when live settings count as ready, and planTick's order of holds and pacing inputs.
 */

/** Wednesday 23 Sep 2026, 10:00 in Berlin; the cap day (Asia/Karachi) ends at 19:00 UTC. */
const NOW = new Date("2026-09-23T08:00:00Z");
const DAY_END = new Date("2026-09-23T19:00:00Z");
const BERLIN = "Europe/Berlin";

let nextId = 0;
function cand(over: Partial<Candidate> = {}): Candidate {
  nextId += 1;
  return {
    id: nextId,
    campaignId: 1,
    recipientId: nextId,
    companyId: nextId,
    senderId: 1,
    step: 0,
    mode: "LIVE",
    toNorm: `p${nextId}@example.de`,
    dueAt: new Date(NOW.getTime() - 60_000),
    priorityRank: 1,
    zone: BERLIN,
    ignoreWindow: false,
    routeAddress: "ali@send.example.com",
    sendingDomainId: 1,
    campaignLaunchedAt: new Date(NOW.getTime() - 3_600_000),
    ...over,
  };
}

function today(over: Partial<TodayCap> = {}): TodayCap {
  return {
    capDay: "2026-09-23",
    capZone: "Asia/Karachi",
    dayStart: new Date("2026-09-22T19:00:00Z"),
    dayEnd: DAY_END,
    cap: 50,
    source: "warmup",
    aboveSchedule: false,
    override: null,
    warmupCap: 50,
    warmupStep: 0,
    warmupSteps: 20,
    maxCap: 1000,
    used: 0,
    testSends: 0,
    left: 50,
    bySender: new Map(),
    ...over,
  };
}

function ctx(over: Partial<GateContext> & { pacerOver?: Partial<PacerState> } = {}): GateContext {
  const { pacerOver, ...rest } = over;
  return {
    now: NOW,
    pause: notPaused(),
    today: today(),
    window: DEFAULT_WINDOW,
    defaultZone: BERLIN,
    minGapSeconds: 20,
    pacer: { ...parsePacerState(null), ...pacerOver },
    mailgun: { connected: true } as GateContext["mailgun"],
    catchUpReady: true,
    followUpCatchUpReady: true,
    outageHoldPending: false,
    practiceCopy: false,
    goLive: false,
    senderCaps: new Map([[1, null]]),
    restoreHold: false,
    liveReady: true,
    mainDomainMxOk: true,
    routeOk: new Map([["ali@send.example.com", true]]),
    problems: noProblems(),
    due: [{ zone: BERLIN, counted: true, senderId: 1, count: 1 }],
    ownMailbox: false,
    planLeft: null,
    planOpensAt: null,
    ...rest,
  };
}

describe("gateClass", () => {
  it("puts dry runs with 'Ignore sending hours' on the Milestone 2 path, everything else through the gates", () => {
    expect(gateClass({ mode: "DRY_RUN", ignoreWindow: true }, { practiceCopy: false })).toBe("ungated");
    expect(gateClass({ mode: "DRY_RUN", ignoreWindow: true }, { practiceCopy: true })).toBe("ungated");
    expect(gateClass({ mode: "DRY_RUN", ignoreWindow: false }, { practiceCopy: false })).toBe("gated-uncounted");
    expect(gateClass({ mode: "DRY_RUN", ignoreWindow: false }, { practiceCopy: true })).toBe("gated-counted");
    expect(gateClass({ mode: "TEST", ignoreWindow: false }, { practiceCopy: false })).toBe("gated-uncounted");
    expect(gateClass({ mode: "TEST", ignoreWindow: true }, { practiceCopy: false })).toBe("gated-uncounted");
    expect(gateClass({ mode: "LIVE", ignoreWindow: true }, { practiceCopy: false })).toBe("gated-counted");
  });
});

describe("isCatchUpReady", () => {
  const started = new Date(NOW.getTime() - 5 * 60_000);
  const catchUp = (over: Partial<CatchUpState>): CatchUpState => ({ ...parseCatchUpState(null), ...over });

  it("is open without Mailgun or without a start time", () => {
    expect(isCatchUpReady({ connected: false, startedAt: started, now: NOW, catchUp: catchUp({}) })).toBe(true);
    expect(isCatchUpReady({ connected: true, startedAt: null, now: NOW, catchUp: catchUp({}) })).toBe(true);
  });

  it("opens once a catch-up succeeded since the start", () => {
    expect(isCatchUpReady({ connected: true, startedAt: started, now: NOW, catchUp: catchUp({}) })).toBe(false);
    const before = new Date(started.getTime() - 1_000).toISOString();
    expect(isCatchUpReady({ connected: true, startedAt: started, now: NOW, catchUp: catchUp({ lastSuccessAt: before }) })).toBe(false);
    const after = new Date(started.getTime() + 1_000).toISOString();
    expect(isCatchUpReady({ connected: true, startedAt: started, now: NOW, catchUp: catchUp({ lastSuccessAt: after }) })).toBe(true);
  });

  it("after 15 minutes a network or server failure opens it; an auth failure or no finished catch-up never does", () => {
    const later = new Date(started.getTime() + 15 * 60_000);
    const finished = new Date(started.getTime() + 60_000).toISOString();
    const failed = (kind: CatchUpState["lastErrorKind"]) => catchUp({ lastFinishedAt: finished, lastError: "x", lastErrorKind: kind });
    expect(isCatchUpReady({ connected: true, startedAt: started, now: new Date(later.getTime() - 1), catchUp: failed("network") })).toBe(false);
    expect(isCatchUpReady({ connected: true, startedAt: started, now: later, catchUp: failed("network") })).toBe(true);
    expect(isCatchUpReady({ connected: true, startedAt: started, now: later, catchUp: failed("server") })).toBe(true);
    expect(isCatchUpReady({ connected: true, startedAt: started, now: later, catchUp: failed("auth") })).toBe(false);
    expect(isCatchUpReady({ connected: true, startedAt: started, now: later, catchUp: catchUp({}) })).toBe(false);
  });
});

describe("follow-ups (M4-DESIGN §2.8.3, §2.10)", () => {
  const started = new Date(NOW.getTime() - 5 * 60_000);
  const catchUp = (over: Partial<CatchUpState>): CatchUpState => ({ ...parseCatchUpState(null), ...over });

  it("sends steps 0 to 3", () => {
    expect(MAX_SENDABLE_STEP).toBe(3);
  });

  it("the follow-ups' start-up check needs a success after the start, never the 15-minute fallback", () => {
    expect(isFollowUpCatchUpReady({ connected: false, startedAt: started, catchUp: catchUp({}) })).toBe(true);
    expect(isFollowUpCatchUpReady({ connected: true, startedAt: null, catchUp: catchUp({}) })).toBe(true);
    expect(isFollowUpCatchUpReady({ connected: true, startedAt: started, catchUp: catchUp({}) })).toBe(false);
    const failedLongAgo = catchUp({
      lastFinishedAt: new Date(started.getTime() + 60_000).toISOString(),
      lastError: "x",
      lastErrorKind: "network",
      lastSuccessAt: new Date(started.getTime() - 1_000).toISOString(),
    });
    // First emails open after 15 minutes of network failures; follow-ups don't.
    expect(isCatchUpReady({ connected: true, startedAt: started, now: new Date(started.getTime() + 16 * 60_000), catchUp: failedLongAgo })).toBe(true);
    expect(isFollowUpCatchUpReady({ connected: true, startedAt: started, catchUp: failedLongAgo })).toBe(false);
    const ok = catchUp({ lastSuccessAt: new Date(started.getTime() + 1_000).toISOString() });
    expect(isFollowUpCatchUpReady({ connected: true, startedAt: started, catchUp: ok })).toBe(true);
  });

  it("an outage is pending while a gap was found and not handled", () => {
    expect(outageHoldPending({ from: null, handledAt: null })).toBe(false);
    expect(outageHoldPending({ from: "2026-09-01T00:00:00.000Z", handledAt: null })).toBe(true);
    expect(outageHoldPending({ from: "2026-09-01T00:00:00.000Z", handledAt: "2026-09-08T00:00:00.000Z" })).toBe(false);
  });

  it("orders candidates follow-ups first, then High priority, then oldest due, then id", () => {
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const a = cand({ step: 0, priorityRank: 1, dueAt: at(50) });
    const b = cand({ step: 2, priorityRank: 3, dueAt: at(1) });
    const c = cand({ step: 1, priorityRank: 2, dueAt: at(5) });
    const d = cand({ step: 1, priorityRank: 1, dueAt: at(1) });
    const e = cand({ step: 1, priorityRank: 1, dueAt: at(9) });
    expect([a, b, c, d, e].sort(compareCandidates).map((x) => x.id)).toEqual([b.id, e.id, d.id, c.id, a.id]);
  });
});

describe("isLiveReady", () => {
  const row = (key: ChecklistRow["key"], status: ChecklistRow["status"]): ChecklistRow => ({
    key,
    group: "settings",
    status,
    title: key,
    text: "",
    fix: null,
    records: [],
    detail: null,
  });

  it("needs Setup A and neither tracking nor unsubscribe handling turned bad", () => {
    expect(isLiveReady("A", [])).toBe(true);
    expect(isLiveReady("B", [])).toBe(false);
    expect(isLiveReady("A", [row("tracking-off", "bad")])).toBe(false);
    expect(isLiveReady("A", [row("unsubscribe", "bad")])).toBe(false);
    expect(isLiveReady("A", [row("unsubscribe", "unknown"), row("dkim", "bad")])).toBe(true);
  });
});

describe("planTick", () => {
  it("while paused sends nothing at all, not even dry runs", () => {
    const plan = planTick([cand({ mode: "DRY_RUN", ignoreWindow: true })], [cand()], ctx({ pause: { ...notPaused(), paused: true, reason: "by Arslan" } }));
    expect(plan.ungated).toEqual([]);
    expect(plan.next).toBeNull();
    expect(plan.waiting).toEqual({ reason: "paused", until: null });
  });

  it("sends at most 25 ungated dry runs and one gated email per tick", () => {
    const ungated = Array.from({ length: 30 }, () => cand({ mode: "DRY_RUN", ignoreWindow: true }));
    const gated = [cand(), cand()];
    const plan = planTick(ungated, gated, ctx());
    expect(plan.ungated).toHaveLength(SEND_BATCH);
    expect(plan.next?.id).toBe(gated[0]!.id);
    expect(plan.nextCounted).toBe(true);
    expect(plan.waiting).toBeNull();
  });

  it("holds Mailgun emails for a restore check, Mailgun not connected, the start-up check and a back-off; dry runs still go", () => {
    const live = cand();
    const dry = cand({ mode: "DRY_RUN" });
    for (const [over, reason] of [
      [{ restoreHold: true }, "restore-check"],
      [{ mailgun: { connected: false, reason: "no-key", text: "" } }, "mailgun-not-connected"],
      [{ practiceCopy: true }, "mailgun-not-connected"],
      [{ catchUpReady: false }, "catch-up"],
    ] as const) {
      const plan = planTick([], [live, dry], ctx(over as Partial<GateContext>));
      expect(plan.next?.id).toBe(dry.id);
      expect(plan.waiting).toEqual({ reason, until: null });
    }
    const until = new Date(NOW.getTime() + 60_000);
    const plan = planTick([], [live, dry], ctx({ pacerOver: { backoffUntil: until.toISOString(), backoffReason: "rate-limited" } }));
    expect(plan.next?.id).toBe(dry.id);
    expect(plan.waiting).toEqual({ reason: "rate-limited", until });
  });

  it("drifted live settings and a broken reply route hold live emails only; test-mode emails go", () => {
    const live = cand();
    const test = cand({ mode: "TEST" });
    let plan = planTick([], [live, test], ctx({ liveReady: false }));
    expect(plan.next?.id).toBe(test.id);
    expect(plan.nextCounted).toBe(false);
    expect(plan.waiting?.reason).toBe("live-not-ready");

    plan = planTick([], [live, test], ctx({ routeOk: new Map([["ali@send.example.com", false]]) }));
    expect(plan.next?.id).toBe(test.id);
    expect(plan.waiting?.reason).toBe("reply-route");
    expect(plan.routeHeld?.id).toBe(live.id);
  });

  it("SHARED-FROM F27: a bad from-mx row holds live emails right after drifted live settings; test-mode emails go", () => {
    const live = cand();
    const test = cand({ mode: "TEST" });
    const dry = cand({ mode: "DRY_RUN" });
    let plan = planTick([], [live, test, dry], ctx({ mainDomainMxOk: false }));
    expect(plan.next?.id).toBe(test.id);
    expect(plan.waiting).toEqual({ reason: "main-domain-mx", until: null });
    // Drifted live settings are named first; the hold comes before the reply route's.
    plan = planTick([], [live], ctx({ mainDomainMxOk: false, liveReady: false }));
    expect(plan.waiting?.reason).toBe("live-not-ready");
    plan = planTick([], [live], ctx({ mainDomainMxOk: false, routeOk: new Map([["ali@send.example.com", false]]) }));
    expect(plan.waiting?.reason).toBe("main-domain-mx");
    expect(plan.routeHeld).toBeNull();
    // Dry runs and test mode never wait for it.
    expect(planTick([], [dry], ctx({ mainDomainMxOk: false })).next?.id).toBe(dry.id);
    expect(planTick([], [test], ctx({ mainDomainMxOk: false })).next?.id).toBe(test.id);
  });

  it("SHARED-FROM F27: only a 'bad' from-mx row holds; warn, unknown, ok or no row (never checked, per-person) hold nothing", () => {
    const row = (status: ChecklistRow["status"]): ChecklistRow => ({
      key: "from-mx",
      group: "dns",
      status,
      title: "Mail for example.com stays with your mail provider (MX)",
      text: "",
      fix: null,
      records: [],
      detail: null,
    });
    expect(isMainDomainMxOk([])).toBe(true);
    expect(isMainDomainMxOk([row("bad")])).toBe(false);
    for (const status of ["ok", "warn", "unknown", "info"] as const) expect(isMainDomainMxOk([row(status)]), status).toBe(true);
    // Another row being bad (the sending domain's own MX) is the Live gate's business, not this hold's.
    expect(isMainDomainMxOk([{ ...row("bad"), key: "mx" }])).toBe(true);
    // Review SECURITY-3: per-person mode (nothing saved) is never held, not even by a bad row stored before the From was
    // cleared; a saved From (fitting or not) keeps the hold.
    expect(isMainDomainMxOk([row("bad")], null)).toBe(true);
    expect(isMainDomainMxOk([row("bad")], "contact@example.com")).toBe(false);
    expect(isMainDomainMxOk([row("ok")], "contact@example.com")).toBe(true);
    expect(isMainDomainMxOk([row("bad")], undefined)).toBe(false);
  });

  it("SHARED-FROM §2.3: the reply-route hold is keyed by the route address (the Reply-To in shared-From mode)", () => {
    // Shared-From campaign: From contact@example.com, Reply-To ali@send.example.com → the route address is Ali's.
    const team = cand({ routeAddress: "ali@send.example.com" });
    expect(planTick([], [team], ctx()).next?.id).toBe(team.id);
    const broken = planTick([], [team], ctx({ routeOk: new Map([["ali@send.example.com", false], ["contact@example.com", true]]) }));
    expect(broken.waiting?.reason).toBe("reply-route");
    expect(broken.routeHeld?.id).toBe(team.id);
    // Nothing is ever looked up for the shared From address itself: it has no route.
    const other = cand({ routeAddress: "sara@send.example.com" });
    expect(planTick([], [other], ctx({ routeOk: new Map([["contact@example.com", true]]) })).waiting?.reason).toBe("reply-route");
  });

  it("skips an address with an unprocessed report or reply and takes the next one", () => {
    const a = cand();
    const b = cand();
    const plan = planTick([], [a, b], ctx({ problems: { pending: new Set([a.id]), possibleReply: new Set() } }));
    expect(plan.next?.id).toBe(b.id);
    expect(plan.waiting).toEqual({ reason: "pending-events", until: null });
  });

  it("skips a company with a possible reply nobody has decided, dry runs included, and takes the next one (M4 §2.5.1)", () => {
    const a = cand();
    const dry = cand({ mode: "DRY_RUN" });
    const b = cand();
    const plan = planTick([], [a, dry, b], ctx({ problems: { pending: new Set(), possibleReply: new Set([a.id, dry.id]) } }));
    expect(plan.next?.id).toBe(b.id);
    expect(plan.waiting).toEqual({ reason: "possible-reply", until: null });
    // An unprocessed reply is named first when both hold the same email.
    const both = planTick([], [a], ctx({ problems: { pending: new Set([a.id]), possibleReply: new Set([a.id]) } }));
    expect(both.waiting?.reason).toBe("pending-events");
  });

  it("follow-ups wait for a successful check with Mailgun after the start; first emails keep the fallback (M4 §2.8.3 rule 2)", () => {
    const follow = cand({ step: 1 });
    const first = cand();
    const plan = planTick([], [follow, first], ctx({ catchUpReady: true, followUpCatchUpReady: false }));
    expect(plan.next?.id).toBe(first.id);
    expect(plan.waiting).toEqual({ reason: "catch-up", until: null });
    // Dry-run follow-ups never wait for Mailgun.
    const dry = cand({ step: 2, mode: "DRY_RUN" });
    expect(planTick([], [dry], ctx({ followUpCatchUpReady: false })).next?.id).toBe(dry.id);
  });

  it("an outage found but not held yet holds TEST/LIVE follow-ups only; first emails and dry runs go (M4 §2.8.3 rule 1)", () => {
    const live = cand({ step: 1 });
    const test = cand({ step: 2, mode: "TEST" });
    const dry = cand({ step: 1, mode: "DRY_RUN" });
    const first = cand();
    let plan = planTick([], [live, test, first], ctx({ outageHoldPending: true }));
    expect(plan.next?.id).toBe(first.id);
    expect(plan.waiting).toEqual({ reason: "outage-hold", until: null });
    plan = planTick([], [live, dry], ctx({ outageHoldPending: true }));
    expect(plan.next?.id).toBe(dry.id);
    // Once the hold is applied, the gate is open (held recipients aren't candidates at all).
    expect(planTick([], [live], ctx({ outageHoldPending: false })).next?.id).toBe(live.id);
  });

  it("today's limit and a sender's own limit hold counted emails only", () => {
    const live = cand();
    const test = cand({ mode: "TEST" });
    let plan = planTick([], [live, test], ctx({ today: today({ left: 0, used: 50 }) }));
    expect(plan.capReached).toBe(true);
    expect(plan.next?.id).toBe(test.id);
    expect(plan.waiting).toEqual({ reason: "cap-reached", until: DAY_END });

    const other = cand({ senderId: 2 });
    plan = planTick(
      [],
      [live, other],
      ctx({ senderCaps: new Map([[1, 10], [2, null]]), today: today({ bySender: new Map([[1, 10]]) }) }),
    );
    expect(plan.next?.id).toBe(other.id);
    expect(plan.waiting).toEqual({ reason: "sender-cap", until: DAY_END });
  });

  it("waits for the pacer's gap: nothing goes before it", () => {
    // The last live email went at 10:00 Berlin; one more is due: 7 hours open → 2 intervals of 3.5 hours.
    const last = { lastSentAt: NOW.toISOString(), lastByClass: { counted: { at: NOW.toISOString(), jitter: 1 }, uncounted: null } };
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const plan = planTick([], [cand()], ctx({ now: later, pacerOver: last }));
    expect(plan.next).toBeNull();
    expect(plan.waiting).toEqual({ reason: "pacing", until: new Date(NOW.getTime() + 3.5 * 3_600_000) });
    // Once that time has come, it goes.
    const due = planTick([], [cand()], ctx({ now: new Date(NOW.getTime() + 3.5 * 3_600_000), pacerOver: last }));
    expect(due.next).not.toBeNull();
    // A frozen "next send" stored before this fix holds nothing by itself.
    const old = planTick([], [cand()], ctx({ now: later, pacerOver: { nextSendAt: new Date(NOW.getTime() + 7 * 3_600_000).toISOString() } }));
    expect(old.next).not.toBeNull();
  });

  it("recomputes the gap every tick: more due emails (a campaign launched after the send) shorten the wait at once", () => {
    const last = { lastSentAt: NOW.toISOString(), lastByClass: { counted: { at: NOW.toISOString(), jitter: 1 }, uncounted: null } };
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const withDue = (count: number) => ctx({ now: later, pacerOver: last, due: [{ zone: BERLIN, counted: true, senderId: 1, count }] });
    // 1 due: 25,200 s / 2. 4 due: / 5 = 84 minutes. 20 due (and room for them): / 21 = 20 minutes.
    expect(planTick([], [cand()], withDue(1)).waiting?.until).toEqual(new Date(NOW.getTime() + 12_600_000));
    expect(planTick([], [cand()], withDue(4)).waiting?.until).toEqual(new Date(NOW.getTime() + 5_040_000));
    expect(planTick([], [cand()], withDue(20)).waiting?.until).toEqual(new Date(NOW.getTime() + 1_200_000));
    // 400 due, but today's limit allows only 50 more: 25,200 s / 51 ≈ 8 minutes, so it still waits.
    expect(planTick([], [cand()], withDue(400)).waiting?.until).toEqual(new Date(NOW.getTime() + Math.round((25_200 / 51) * 1000)));
    // With room for all 400: 25,200 s / 401 ≈ 1 minute, already passed: it goes.
    const big = ctx({ now: later, pacerOver: last, today: today({ left: 1000 }), due: [{ zone: BERLIN, counted: true, senderId: 1, count: 400 }] });
    expect(planTick([], [cand()], big).next).not.toBeNull();
  });

  it("one class never waits for the other's gap; two gated sends are never closer than the smallest gap", () => {
    // A live email went at 10:00 with one more live email due (3.5 hours); a big dry run with the switch off is due too.
    const pacerOver = { lastSentAt: NOW.toISOString(), lastByClass: { counted: { at: NOW.toISOString(), jitter: 1 }, uncounted: null } };
    const due = [
      { zone: BERLIN, counted: true, senderId: 1, count: 1 },
      { zone: BERLIN, counted: false, senderId: 1, count: 500 },
    ];
    const live = cand();
    const dry = cand({ mode: "DRY_RUN" });
    // 10 seconds after the live send: nothing (the smallest gap is 20 s).
    let plan = planTick([], [live, dry], ctx({ now: new Date(NOW.getTime() + 10_000), pacerOver, due }));
    expect(plan.next).toBeNull();
    expect(plan.waiting).toEqual({ reason: "pacing", until: new Date(NOW.getTime() + 20_000) });
    // 20 seconds after: the dry run takes its turn, the live email keeps its own gap.
    plan = planTick([], [live, dry], ctx({ now: new Date(NOW.getTime() + 20_000), pacerOver, due }));
    expect(plan.next?.id).toBe(dry.id);
    expect(plan.nextCounted).toBe(false);
    expect(plan.waiting).toEqual({ reason: "pacing", until: new Date(NOW.getTime() + 12_600_000) });
  });

  it("gives an email whose window closes before its planned time a last turn just before the close (GATES-01)", () => {
    // 16:50 Berlin (14:50 UTC): a live email went; 1 due in Berlin (closes 17:00) and 5 in New York (open until 21:00 UTC).
    const at = new Date("2026-09-23T14:50:00Z");
    const pacerOver = { lastSentAt: at.toISOString(), lastByClass: { counted: { at: at.toISOString(), jitter: 1.5 }, uncounted: null } };
    const due = [
      { zone: BERLIN, counted: true, senderId: 1, count: 1 },
      { zone: "America/New_York", counted: true, senderId: 1, count: 5 },
    ];
    const ny = cand({ zone: "America/New_York" });
    const berlin = cand();
    // Open until the cap day ends at 19:00 UTC: 4 h 10 min = 15,000 s; 6 due → 15,000 / 7 × 1.5 ≈ 53.6 minutes.
    const planned = at.getTime() + Math.round((15_000 / 7) * 1.5 * 1000);
    let plan = planTick([], [ny, berlin], ctx({ now: new Date("2026-09-23T14:59:30Z"), pacerOver, due }));
    expect(plan.next).toBeNull();
    // The earliest paced turn is Berlin's last chance at 16:59:40 Berlin.
    expect(plan.waiting).toEqual({ reason: "pacing", until: new Date("2026-09-23T14:59:40Z") });
    plan = planTick([], [ny, berlin], ctx({ now: new Date("2026-09-23T14:59:45Z"), pacerOver, due }));
    expect(plan.next?.id).toBe(berlin.id);
    expect(plan.waiting).toEqual({ reason: "pacing", until: new Date(planned) });
  });

  it("paces a capped sender by what their own limit still allows, not by all their due emails (GATES-03)", () => {
    const pacerOver = { lastSentAt: NOW.toISOString(), lastByClass: { counted: { at: NOW.toISOString(), jitter: 1 }, uncounted: null } };
    const capped = ctx({
      now: new Date(NOW.getTime() + 60_000),
      pacerOver,
      senderCaps: new Map([[1, 10]]),
      today: today({ left: 1000 }),
      due: [{ zone: BERLIN, counted: true, senderId: 1, count: 500 }],
    });
    const plan = planTick([], [cand()], capped);
    expect(plan.pace.counted.dueCount).toBe(10);
    // 10 emails over the 7 hours left: 11 intervals of about 38 minutes, not 500 emails a minute apart.
    expect(plan.waiting).toEqual({ reason: "pacing", until: new Date(NOW.getTime() + Math.round((25_200 / 11) * 1000)) });
    // Several senders: each adds at most what they have left.
    const two = planTick(
      [],
      [cand()],
      ctx({
        senderCaps: new Map([[1, 10], [2, null], [3, 4]]),
        today: today({ left: 1000, bySender: new Map([[1, 3], [3, 4]]) }),
        due: [
          { zone: BERLIN, counted: true, senderId: 1, count: 300 },
          { zone: "America/New_York", counted: true, senderId: 1, count: 200 },
          { zone: BERLIN, counted: true, senderId: 2, count: 25 },
          { zone: BERLIN, counted: true, senderId: 3, count: 9 },
        ],
      }),
    );
    expect(two.pace.counted.dueCount).toBe(7 + 25);
  });

  it("practice copy: dry runs with 'Ignore sending hours' stay within today's limit and each sender's own limit (GATES-04)", () => {
    const ungated = Array.from({ length: 25 }, () => cand({ mode: "DRY_RUN", ignoreWindow: true }));
    let plan = planTick(ungated, [], ctx({ practiceCopy: true, due: [], today: today({ left: 3, used: 47 }) }));
    expect(plan.ungated).toHaveLength(3);
    expect(plan.capReached).toBe(true);
    expect(plan.waiting).toEqual({ reason: "cap-reached", until: DAY_END });
    // The gated dry runs after them get what is left: nothing.
    const gatedDry = cand({ mode: "DRY_RUN" });
    plan = planTick(ungated.slice(0, 3), [gatedDry], ctx({ practiceCopy: true, today: today({ left: 3, used: 47 }) }));
    expect(plan.ungated).toHaveLength(3);
    expect(plan.next).toBeNull();
    expect(plan.waiting).toEqual({ reason: "cap-reached", until: DAY_END });
    // A sender's own limit: 1 left for sender 1; sender 2's go.
    const mixed = [cand({ mode: "DRY_RUN", ignoreWindow: true }), cand({ mode: "DRY_RUN", ignoreWindow: true }), cand({ mode: "DRY_RUN", ignoreWindow: true, senderId: 2 })];
    plan = planTick(mixed, [], ctx({ practiceCopy: true, due: [], senderCaps: new Map([[1, 5], [2, null]]), today: today({ bySender: new Map([[1, 4]]) }) }));
    expect(plan.ungated.map((c) => c.id)).toEqual([mixed[0]!.id, mixed[2]!.id]);
    expect(plan.capReached).toBe(false);
    expect(plan.waiting).toEqual({ reason: "sender-cap", until: DAY_END });
    // On real data these dry runs count toward nothing: all 25 go whatever the limit.
    plan = planTick(ungated, [], ctx({ practiceCopy: false, due: [], today: today({ left: 0, used: 50 }) }));
    expect(plan.ungated).toHaveLength(25);
    expect(plan.capReached).toBe(false);
  });

  it("with no candidate in an open zone: outside hours until the first window opens, or nothing due", () => {
    const tokyo = planTick([], [], ctx({ due: [{ zone: "Asia/Tokyo", counted: true, senderId: 1, count: 4 }] }));
    // 17:00 in Tokyo; Thursday 09:00 there is 00:00 UTC.
    expect(tokyo.waiting).toEqual({ reason: "outside-hours", until: new Date("2026-09-24T00:00:00Z") });
    expect(planTick([], [], ctx({ due: [] })).waiting).toEqual({ reason: "nothing-due", until: null });
  });

  it("paces only the rows that can really go today: capped senders and zones closed for the rest of the day don't count", () => {
    const plan = planTick(
      [],
      [cand()],
      ctx({
        senderCaps: new Map([[1, null], [2, 5]]),
        today: today({ bySender: new Map([[2, 5]]) }),
        due: [
          { zone: BERLIN, counted: true, senderId: 1, count: 10 },
          { zone: BERLIN, counted: true, senderId: 2, count: 7 },
          { zone: "Pacific/Auckland", counted: true, senderId: 1, count: 5 },
          { zone: BERLIN, counted: false, senderId: 1, count: 3 },
        ],
      }),
    );
    // Berlin is open 10:00–17:00 today: 7 hours left.
    expect(plan.pace).toEqual({
      counted: { dueCount: 10, openSecondsLeft: 7 * 3600 },
      uncounted: { dueCount: 3, openSecondsLeft: 7 * 3600 },
    });
  });
});

describe("own-mailbox mode and the Mailgun plan (MAIN-DOMAIN-DESIGN O9, O10, O23, O33)", () => {
  const opens = new Date(NOW.getTime() + 5 * 3_600_000);

  it("a used-up plan holds TEST and LIVE emails until room opens; dry runs go", () => {
    const live = cand();
    const test = cand({ mode: "TEST" });
    const dry = cand({ mode: "DRY_RUN" });
    let plan = planTick([], [live, test, dry], ctx({ planLeft: 0, planOpensAt: opens }));
    expect(plan.next?.id).toBe(dry.id);
    expect(plan.waiting).toEqual({ reason: "plan-limit", until: opens });
    // Without a known time the line has none.
    plan = planTick([], [test], ctx({ planLeft: 0, planOpensAt: null }));
    expect(plan.next).toBeNull();
    expect(plan.waiting).toEqual({ reason: "plan-limit", until: null });
  });

  it("room left, or no daily limit (null), holds nothing", () => {
    const live = cand();
    expect(planTick([], [live], ctx({ planLeft: 1, planOpensAt: opens })).next?.id).toBe(live.id);
    expect(planTick([], [live], ctx({ planLeft: null, planOpensAt: null })).next?.id).toBe(live.id);
  });

  it("the plan limit comes right after a Mailgun back-off and before drifted live settings", () => {
    const live = cand();
    const until = new Date(NOW.getTime() + 60_000);
    const backoff = planTick([], [live], ctx({ planLeft: 0, planOpensAt: opens, pacerOver: { backoffUntil: until.toISOString(), backoffReason: "rate-limited" } }));
    expect(backoff.waiting).toEqual({ reason: "rate-limited", until });
    const drifted = planTick([], [live], ctx({ planLeft: 0, planOpensAt: opens, liveReady: false }));
    expect(drifted.waiting).toEqual({ reason: "plan-limit", until: opens });
    const catchUp = planTick([], [live], ctx({ planLeft: 0, planOpensAt: opens, catchUpReady: false }));
    expect(catchUp.waiting?.reason).toBe("catch-up");
  });

  it("own-mailbox mode never waits on a reply route (there is none)", () => {
    const live = cand({ routeAddress: "contact@example.com" });
    const routes = new Map<string, boolean>();
    const app = planTick([], [live], ctx({ routeOk: routes }));
    expect(app.waiting?.reason).toBe("reply-route");
    const own = planTick([], [live], ctx({ routeOk: routes, ownMailbox: true }));
    expect(own.next?.id).toBe(live.id);
    expect(own.routeHeld).toBeNull();
  });

  it("the sending domain's own from-mx row holds live emails in own-mailbox mode, even without a saved From", () => {
    const row: ChecklistRow = {
      key: "from-mx",
      group: "dns",
      status: "bad",
      title: "Mail for example.com stays with your mail provider (MX)",
      text: "",
      fix: null,
      records: [],
      detail: null,
    };
    // loadGateContext passes the saved From or, with none, the sending domain in this mode.
    expect(isMainDomainMxOk([row], "example.com")).toBe(false);
    const live = cand({ routeAddress: "contact@example.com" });
    const plan = planTick([], [live], ctx({ ownMailbox: true, mainDomainMxOk: false, routeOk: new Map() }));
    expect(plan.waiting).toEqual({ reason: "main-domain-mx", until: null });
  });

  it("a live follow-up that waits for today's inbox check is skipped, named, and kept for the notice; the next one goes", () => {
    const follow = cand({ step: 1 });
    const first = cand();
    const problems = { ...noProblems(), inboxCheck: new Set([follow.id]) };
    const plan = planTick([], [follow, first], ctx({ ownMailbox: true, problems }));
    expect(plan.next?.id).toBe(first.id);
    expect(plan.waiting).toEqual({ reason: "inbox-check", until: null });
    expect(plan.inboxHeld?.id).toBe(follow.id);
    // It comes after a possible reply of the same company, and before today's limit.
    const both = planTick([], [follow], ctx({ ownMailbox: true, problems: { ...problems, possibleReply: new Set([follow.id]) } }));
    expect(both.waiting?.reason).toBe("possible-reply");
    expect(both.inboxHeld).toBeNull();
    const capped = planTick([], [follow], ctx({ ownMailbox: true, problems, today: today({ left: 0, used: 50 }) }));
    expect(capped.waiting?.reason).toBe("inbox-check");
    // Nothing held: inboxHeld stays null.
    expect(planTick([], [first], ctx({ ownMailbox: true })).inboxHeld).toBeNull();
  });
});
