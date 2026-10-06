import { describe, expect, it } from "vitest";
import { DEFAULT_UNSUBSCRIBE_TEST } from "@/core/setting-types";
import {
  NOT_PAUSED,
  notPaused,
  parseCapOverride,
  parseCatchUpState,
  parseDomainCheckState,
  parseHealthBaseline,
  parseInstanceState,
  parseLogsFormState,
  parseMailgunSetupState,
  parseNotices,
  parseOutageState,
  parsePacerState,
  parsePauseState,
  parseRestoreState,
  parseSendingDayState,
  parseTunnelState,
  parseUnsubscribeTest,
  parseWarmupState,
  parseWebhookStats,
} from "@/core/system-state-parse";

const GARBAGE: unknown[] = [null, undefined, 42, "text", [], [1, 2], true, { unrelated: 1 }];

describe("every parser: lenient, never throws, garbage → default (§4.2.7)", () => {
  const cases: Array<[string, (v: unknown) => unknown, unknown]> = [
    ["pause", parsePauseState, NOT_PAUSED],
    ["health baseline", parseHealthBaseline, { since: null, resumedById: null, acknowledged: null, warnedBounceAt: null, warnedComplaintAt: null }],
    ["warmup", parseWarmupState, { domain: null, step: 0, lastEvaluatedCapDay: null, startedCapDay: null, history: [] }],
    [
      "pacer",
      parsePacerState,
      {
        nextSendAt: null,
        lastSentAt: null,
        lastGapSeconds: null,
        lastByClass: { counted: null, uncounted: null },
        backoffUntil: null,
        backoffReason: null,
        ambiguousStreak: 0,
        recentRejects: [],
        routeWaitSince: null,
        waiting: null,
      },
    ],
    ["sending day", parseSendingDayState, { capDay: null, capReachedNotifiedAt: null }],
    [
      "catch-up",
      parseCatchUpState,
      { lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, lastError: null, lastErrorKind: null, lastReason: null, lastSummary: null },
    ],
    [
      "outage",
      parseOutageState,
      {
        detectedAt: null,
        from: null,
        to: null,
        beyondLogRetention: false,
        beyondMessageRetention: false,
        handledAt: null,
        heldFor: null,
        heldTo: null,
        heldCount: 0,
      },
    ],
    [
      "restore",
      parseRestoreState,
      {
        status: "none",
        restoredFrom: null,
        scanFrom: null,
        markerAt: null,
        file: null,
        handledAt: null,
        report: null,
        acknowledgedAt: null,
        acknowledgedById: null,
      },
    ],
    ["mailgun setup", parseMailgunSetupState, { runAt: null, byUserId: null, jobId: null, steps: [], certificate: null }],
    ["domain check", parseDomainCheckState, { domain: null, region: null, checkedAt: null, lastVerifyAt: null, rows: [], error: null }],
    ["logs form", parseLogsFormState, { useDuration: false, learnedAt: null, messageIdForm: null, sendIdFilterOk: null, provenAt: null }],
    ["webhook stats", parseWebhookStats, { lastEventAt: null, lastInboundAt: null, lastRejectedAt: null, lastRejectReason: null, rejects: [] }],
    ["notices", parseNotices, {}],
    ["instance", parseInstanceState, null],
    ["cap override", parseCapOverride, null],
    ["unsubscribe test", parseUnsubscribeTest, DEFAULT_UNSUBSCRIBE_TEST],
  ];
  for (const [name, parse, expected] of cases) {
    it(name, () => {
      for (const g of GARBAGE) expect(parse(g)).toEqual(expected);
    });
  }

  it("tunnel defaults to unknown", () => {
    for (const g of GARBAGE) expect(parseTunnelState(g)).toMatchObject({ state: "unknown", readyConnections: 0, publicCheck: null });
  });
});

describe("parsePauseState", () => {
  it("reads the Milestone 2 shape {paused, reason}", () => {
    expect(parsePauseState({ paused: true, reason: "by the Owner" })).toEqual({
      ...NOT_PAUSED,
      also: [],
      paused: true,
      reason: "by the Owner",
    });
  });

  it("keeps valid causes and drops unknown kinds", () => {
    const s = parsePauseState({
      paused: true,
      reason: "7 of the last 200 emails bounced",
      kind: "health-bounce",
      fixText: "Open the bounced list…",
      since: "2026-09-23T10:00:00.000Z",
      byUserId: null,
      detail: { count: 7, sample: 200, window: 200, limit: 6, junk: "x" },
      also: [
        { kind: "manual", reason: "by Arslan", at: "2026-09-23T10:01:00.000Z", detail: null },
        { kind: "not-a-kind", reason: "?", at: "x" },
        "junk",
      ],
    });
    expect(s.kind).toBe("health-bounce");
    expect(s.detail).toEqual({ count: 7, sample: 200, window: 200, limit: 6 });
    expect(s.also).toEqual([{ kind: "manual", reason: "by Arslan", at: "2026-09-23T10:01:00.000Z", detail: null }]);
    expect(parsePauseState({ paused: true, kind: "made-up" }).kind).toBeNull();
    expect(parsePauseState({ paused: "yes" }).paused).toBe(false);
  });

  it("returns fresh objects, and NOT_PAUSED can't be changed", () => {
    const a = parsePauseState(null);
    a.also.push({ kind: "manual", reason: "x", at: "y", detail: null });
    expect(parsePauseState(null).also).toEqual([]);
    expect(NOT_PAUSED.also).toEqual([]);
    expect(Object.isFrozen(NOT_PAUSED)).toBe(true);
    expect(() => (NOT_PAUSED.also as unknown[]).push(1)).toThrow();
    const b = notPaused();
    b.also.push({ kind: "manual", reason: "x", at: "y", detail: null });
    expect(notPaused().also).toEqual([]);
  });
});

describe("the other shapes", () => {
  it("warm-up: valid days only, at most 60, newest last; step never negative", () => {
    const history = Array.from({ length: 70 }, (_, i) => ({
      day: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
      cap: 50,
      used: 30,
      result: "up",
      bounces: 0,
      bounceSample: 30,
      complaints: 0,
      complaintSample: 30,
      stepAfter: i,
    }));
    const s = parseWarmupState({ domain: "send.example.com", step: -3, lastEvaluatedCapDay: "2026-9-1", history: [...history, { day: "bad" }] });
    expect(s.step).toBe(0);
    expect(s.lastEvaluatedCapDay).toBeNull();
    expect(s.history).toHaveLength(60);
    expect(s.history[59]!.stepAfter).toBe(69);
  });

  it("pacer: keeps at most 3 rejects and a known waiting reason", () => {
    const rejects = [1, 2, 3, 4].map((i) => ({ at: `2026-09-23T10:0${i}:00.000Z`, toNorm: `a${i}@x.com`, message: "no" }));
    const s = parsePacerState({ recentRejects: rejects, waiting: { reason: "outside-hours", until: null, at: "2026-09-23T10:00:00Z" } });
    expect(s.recentRejects.map((r) => r.toNorm)).toEqual(["a2@x.com", "a3@x.com", "a4@x.com"]);
    expect(s.waiting?.reason).toBe("outside-hours");
    expect(parsePacerState({ waiting: { reason: "napping" } }).waiting).toBeNull();
  });

  it("pacer: each class's last send keeps its time and a jitter factor from 0.5 to 1.5 (else 1)", () => {
    const at = "2026-09-23T10:00:00.000Z";
    const s = parsePacerState({ lastByClass: { counted: { at, jitter: 1.37 }, uncounted: { at, jitter: 7 } } });
    expect(s.lastByClass).toEqual({ counted: { at, jitter: 1.37 }, uncounted: { at, jitter: 1 } });
    expect(parsePacerState({ lastByClass: { counted: { at: "soon", jitter: 1 }, uncounted: "x" } }).lastByClass).toEqual({
      counted: null,
      uncounted: null,
    });
    // Stored before the fix (only nextSendAt): nothing per class, so nothing is held by the old frozen time.
    expect(parsePacerState({ nextSendAt: at, lastSentAt: at }).lastByClass).toEqual({ counted: null, uncounted: null });
  });

  it("webhook stats: at most 10 rejects", () => {
    const rejects = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 23, 10, i)).toISOString());
    expect(parseWebhookStats({ rejects }).rejects).toEqual(rejects.slice(2));
  });

  it("notices: only dates survive", () => {
    expect(parseNotices({ "mailgun-auth": "2026-09-23T10:00:00.000Z", junk: 5, other: "not a date" })).toEqual({
      "mailgun-auth": "2026-09-23T10:00:00.000Z",
    });
  });

  it("restore: the report needs finishedAt", () => {
    const r = parseRestoreState({ status: "done", report: { finishedAt: "2026-09-23T10:00:00Z", mailgunChecked: false, passes: 2 } });
    expect(r.status).toBe("done");
    expect(r.report?.mailgunChecked).toBe(false);
    expect(r.report?.passes).toBe(2);
    expect(parseRestoreState({ status: "done", report: { mailgunChecked: true } }).report).toBeNull();
    expect(parseRestoreState({ status: "exploded" }).status).toBe("none");
  });

  it("domain check: rows with a known key, defaults for group and status", () => {
    const s = parseDomainCheckState({
      domain: "send.example.com",
      region: "EU",
      rows: [
        { key: "spf", group: "dns", status: "ok", title: "SPF", text: "t", fix: null, records: [{ type: "TXT", name: "@", value: "v", found: ["v"] }] },
        { key: "nope" },
        { key: "dkim", group: "weird", status: "weird" },
      ],
    });
    expect(s.rows.map((r) => r.key)).toEqual(["spf", "dkim"]);
    expect(s.rows[0]!.records[0]).toEqual({ type: "TXT", name: "@", fqdn: "", value: "v", priority: null, found: ["v"] });
    expect(s.rows[1]).toMatchObject({ group: "optional", status: "unknown" });
  });

  it("instance: all three fields or null", () => {
    expect(parseInstanceState({ dbPath: "C:/x/app.db", id: "abc", firstSeenAt: "2026-09-23T10:00:00Z" })).toEqual({
      dbPath: "C:/x/app.db",
      id: "abc",
      firstSeenAt: "2026-09-23T10:00:00Z",
    });
    expect(parseInstanceState({ dbPath: "C:/x/app.db", id: "abc" })).toBeNull();
  });

  it("tunnel: the three checks and the location of the Access redirect", () => {
    const s = parseTunnelState({
      state: "connected",
      readyConnections: 4,
      appProtectedCheck: { at: "2026-09-23T10:00:00Z", ok: true, status: 302, location: "https://team.cloudflareaccess.com/x", error: null },
    });
    expect(s.appProtectedCheck).toEqual({
      at: "2026-09-23T10:00:00Z",
      ok: true,
      status: 302,
      location: "https://team.cloudflareaccess.com/x",
      error: null,
    });
  });
});

describe("Owner settings with a structure", () => {
  it("cap override: needs a cap day, a whole number ≥ 0, who and when", () => {
    const ok = { capDay: "2026-09-23", cap: 300.7, byUserId: 1, at: "2026-09-23T10:00:00Z" };
    expect(parseCapOverride(ok)).toEqual({ ...ok, cap: 300 });
    expect(parseCapOverride({ ...ok, cap: -1 })).toBeNull();
    expect(parseCapOverride({ ...ok, capDay: "23.09.2026" })).toBeNull();
    expect(parseCapOverride({ ...ok, byUserId: "1" })).toBeNull();
    expect(parseCapOverride({ ...ok, at: "later" })).toBeNull();
    expect(parseCapOverride({ ...ok, cap: 0 })?.cap).toBe(0);
  });

  it("unsubscribe test: old stored shapes parse fine", () => {
    const old = {
      setup: "A",
      status: "passed",
      testSendId: 12,
      sentAt: "2026-09-20T10:00:00Z",
      mailboxes: [
        { address: "a@outlook.com", provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: true, testSendId: 3 },
        { address: "b@gmail.com", inboxOk: "yes", authOk: "maybe", authFromHeaders: true },
        { provider: "gmail" },
      ],
      headersOk: true,
    };
    const s = parseUnsubscribeTest(old);
    expect(s.domain).toBeNull();
    expect(s.status).toBe("passed");
    expect(s.mailboxes).toEqual([
      { address: "a@outlook.com", provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: true },
      { address: "b@gmail.com", provider: "other", inboxOk: null, authOk: null, authFromHeaders: false },
    ]);
    expect(s).not.toHaveProperty("testSendId");
  });

  it("unsubscribe test: never hands out the shared default object", () => {
    const s = parseUnsubscribeTest(undefined);
    s.mailboxes.push({ address: "x@y.com", provider: "other", inboxOk: null, authOk: null, authFromHeaders: false });
    expect(DEFAULT_UNSUBSCRIBE_TEST.mailboxes).toEqual([]);
  });
});
