import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
  REFERENCES_MAX_LINE,
  followUpDays,
  followUpDueAt,
  sentIdsOf,
  threadHeaders,
  trimReferences,
  type FollowUpTiming,
} from "@/core/sending/follow-up";
import { DEFAULT_WINDOW } from "@/core/sending/window";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const at = (iso: string) => new Date(iso);
const gated = (zone: string): FollowUpTiming => ({ zone, window: DEFAULT_WINDOW, gated: true, daysAsMinutes: false, mode: "LIVE" });

/** "Mon 28 Sep 09:00 +02:00" in the zone, for readable failures. */
function local(d: Date, zone: string): string {
  const z = Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(zone);
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][z.dayOfWeek - 1];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][z.month - 1];
  const hh = String(z.hour).padStart(2, "0");
  const mm = String(z.minute).padStart(2, "0");
  return `${day} ${z.day} ${month} ${hh}:${mm} ${z.offset}`;
}

describe("followUpDueAt: the M4-DESIGN §2.1 examples (window Mon–Fri 09:00–17:00)", () => {
  const rows: Array<[string, string, string, number, string, string]> = [
    ["inside the window", BERLIN, "2026-09-21T08:00:00Z", 3, "2026-09-24T08:00:00Z", "Thu 24 Sep 10:00 +02:00"],
    ["Sat → next window start", BERLIN, "2026-09-23T08:00:00Z", 3, "2026-09-28T07:00:00Z", "Mon 28 Sep 09:00 +02:00"],
    ["Sun → next window start", BERLIN, "2026-09-24T14:30:00Z", 3, "2026-09-28T07:00:00Z", "Mon 28 Sep 09:00 +02:00"],
    ["calendar days keep 16:45 across the March change", BERLIN, "2026-03-27T15:45:00Z", 3, "2026-03-30T14:45:00Z", "Mon 30 Mar 16:45 +02:00"],
    ["across the October change", BERLIN, "2026-10-23T14:45:00Z", 3, "2026-10-26T15:45:00Z", "Mon 26 Oct 16:45 +01:00"],
    ["US spring change", NEW_YORK, "2026-03-06T20:00:00Z", 3, "2026-03-09T19:00:00Z", "Mon 9 Mar 15:00 -04:00"],
    ["US autumn change", NEW_YORK, "2026-10-30T19:00:00Z", 3, "2026-11-02T20:00:00Z", "Mon 2 Nov 15:00 -05:00"],
    ["inside the window (4 days)", BERLIN, "2026-09-25T14:59:00Z", 4, "2026-09-29T14:59:00Z", "Tue 29 Sep 16:59 +02:00"],
  ];

  it.each(rows)("%s (%s)", (_why, zone, sent, days, dueIso, dueLocal) => {
    const due = followUpDueAt(at(sent), days, gated(zone));
    expect(local(due, zone)).toBe(dueLocal);
    expect(due.toISOString()).toBe(new Date(dueIso).toISOString());
  });

  it("uses calendar days, not 72 hours: across the spring change 3 days are 71 hours", () => {
    const sent = at("2026-03-27T15:45:00Z");
    expect(followUpDueAt(sent, 3, gated(BERLIN)).getTime() - sent.getTime()).toBe(71 * 3_600_000);
  });

  it("a dry run with 'Treat follow-up days as minutes': minutes, no window shift", () => {
    const t: FollowUpTiming = { zone: BERLIN, window: DEFAULT_WINDOW, gated: true, daysAsMinutes: true, mode: "DRY_RUN" };
    expect(followUpDueAt(at("2026-09-23T08:00:00Z"), 3, t).toISOString()).toBe("2026-09-23T08:03:00.000Z");
    // Saturday 10:00: still just three minutes later (the gates decide for a gated dry run).
    expect(followUpDueAt(at("2026-09-26T08:00:00Z"), 3, t).toISOString()).toBe("2026-09-26T08:03:00.000Z");
    expect(followUpDueAt(at("2026-09-26T08:00:00Z"), 3, { ...t, gated: false }).toISOString()).toBe("2026-09-26T08:03:00.000Z");
  });

  it("'Treat follow-up days as minutes' only applies to dry runs", () => {
    const t: FollowUpTiming = { ...gated(BERLIN), daysAsMinutes: true };
    expect(local(followUpDueAt(at("2026-09-21T08:00:00Z"), 3, t), BERLIN)).toBe("Thu 24 Sep 10:00 +02:00");
  });

  it("a dry run with 'Ignore sending hours' (not gated): no shift", () => {
    const t: FollowUpTiming = { zone: BERLIN, window: DEFAULT_WINDOW, gated: false, daysAsMinutes: false, mode: "DRY_RUN" };
    const due = followUpDueAt(at("2026-09-26T08:00:00Z"), 3, t); // Sat 10:00
    expect(local(due, BERLIN)).toBe("Tue 29 Sep 10:00 +02:00");
    expect(local(followUpDueAt(at("2026-09-23T08:00:00Z"), 3, t), BERLIN)).toBe("Sat 26 Sep 10:00 +02:00");
  });
});

describe("followUpDueAt: the weekday spread of the A7 sequence (+3, +4, +7; each step sent the day it is due)", () => {
  const table: Array<[string, string, string[]]> = [
    ["Mon", "2026-09-21T08:00:00Z", ["Thu", "Mon", "Mon"]],
    ["Tue", "2026-09-22T08:00:00Z", ["Fri", "Tue", "Tue"]],
    ["Wed", "2026-09-23T08:00:00Z", ["Mon", "Fri", "Fri"]],
    ["Thu", "2026-09-24T08:00:00Z", ["Mon", "Fri", "Fri"]],
    ["Fri", "2026-09-25T08:00:00Z", ["Mon", "Fri", "Fri"]],
  ];
  it.each(table)("first email on %s", (_day, first, want) => {
    let sent = at(first);
    const got: string[] = [];
    for (const delay of [3, 4, 7]) {
      sent = followUpDueAt(sent, delay, gated(BERLIN));
      got.push(local(sent, BERLIN).slice(0, 3));
    }
    expect(got).toEqual(want);
  });
});

describe("followUpDueAt: odd inputs", () => {
  it("an invalid zone falls back to Europe/Berlin", () => {
    const due = followUpDueAt(at("2026-09-23T08:00:00Z"), 3, gated("Not/A_Zone"));
    expect(due.toISOString()).toBe("2026-09-28T07:00:00.000Z");
  });

  it("delay 0: inside the window it stays, outside it moves to the next start; ungated it stays", () => {
    expect(followUpDueAt(at("2026-09-23T08:00:00Z"), 0, gated(BERLIN)).toISOString()).toBe("2026-09-23T08:00:00.000Z");
    expect(followUpDueAt(at("2026-09-26T08:00:00Z"), 0, gated(BERLIN)).toISOString()).toBe("2026-09-28T07:00:00.000Z");
    expect(followUpDueAt(at("2026-09-26T08:00:00Z"), 0, { ...gated(BERLIN), gated: false }).toISOString()).toBe("2026-09-26T08:00:00.000Z");
  });

  it("negative, NaN and fractional delays", () => {
    const sent = at("2026-09-21T08:00:00Z");
    expect(followUpDueAt(sent, -2, gated(BERLIN)).toISOString()).toBe(sent.toISOString());
    expect(followUpDueAt(sent, Number.NaN, gated(BERLIN)).toISOString()).toBe(sent.toISOString());
    expect(followUpDueAt(sent, Number.POSITIVE_INFINITY, gated(BERLIN)).toISOString()).toBe(sent.toISOString());
    expect(local(followUpDueAt(sent, 2.9, gated(BERLIN)), BERLIN)).toBe("Wed 23 Sep 10:00 +02:00");
    expect(followUpDays("3" as unknown)).toBe(0);
    expect(followUpDays(90)).toBe(90);
  });

  it("gives an invalid sent time back unchanged", () => {
    expect(Number.isNaN(followUpDueAt(new Date(Number.NaN), 3, gated(BERLIN)).getTime())).toBe(true);
  });
});

describe("threading headers (M4-DESIGN §2.2)", () => {
  const id0 = "pp.aaaaaaaaaaaaaaaaaaaaaaaa@send.example.com";
  const id1 = "pp.bbbbbbbbbbbbbbbbbbbbbbbb@send.example.com";
  const id2 = "pp.cccccccccccccccccccccccc@send.example.com";

  it("step 1 answers step 0; step 2 answers step 1 with the chain oldest first", () => {
    const step1 = threadHeaders({ messageId: id0, providerId: id0, references: null, mode: "LIVE" });
    expect(step1).toEqual({ inReplyTo: id0, references: id0 });
    const step2 = threadHeaders({ messageId: id1, providerId: null, references: step1.references, mode: "LIVE" });
    expect(step2).toEqual({ inReplyTo: id1, references: `${id0} ${id1}` });
    const step3 = threadHeaders({ messageId: id2, providerId: id2, references: step2.references, mode: "LIVE" });
    expect(step3).toEqual({ inReplyTo: id2, references: `${id0} ${id1} ${id2}` });
  });

  it("after Mailgun rewrote the id: In-Reply-To is Mailgun's, References carry ours then Mailgun's", () => {
    const rewritten = "20260923080000.abc123@send.example.com";
    const step1 = threadHeaders({ messageId: id0, providerId: `<${rewritten.toUpperCase()}>`, references: null, mode: "LIVE" });
    expect(step1).toEqual({ inReplyTo: rewritten, references: `${id0} ${rewritten}` });
    const step2 = threadHeaders({ messageId: id1, providerId: id1, references: step1.references, mode: "TEST" });
    expect(step2).toEqual({ inReplyTo: id1, references: `${id0} ${rewritten} ${id1}` });
  });

  it("never repeats an id", () => {
    const h = threadHeaders({ messageId: id1, providerId: id1, references: `${id0} ${id1} <${id0}>`, mode: "LIVE" });
    expect(h.references).toBe(`${id0} ${id1}`);
  });

  it("sentIdsOf ignores a dry run's provider id and ids without '@'", () => {
    expect(sentIdsOf({ messageId: id0, providerId: `dry-run:${id0}`, mode: "DRY_RUN" })).toEqual([id0]);
    expect(sentIdsOf({ messageId: id0, providerId: "other@mailgun.org", mode: "DRY_RUN" })).toEqual([id0]);
    expect(sentIdsOf({ messageId: id0, providerId: "no-at-sign", mode: "LIVE" })).toEqual([id0]);
    expect(sentIdsOf({ messageId: id0, providerId: "Other@Mailgun.org", mode: "TEST" })).toEqual([id0, "other@mailgun.org"]);
    expect(sentIdsOf({ messageId: `<${id0.toUpperCase()}>`, providerId: null, mode: "LIVE" })).toEqual([id0]);
    const dry = threadHeaders({ messageId: id0, providerId: `dry-run:${id0}`, references: null, mode: "DRY_RUN" });
    expect(dry).toEqual({ inReplyTo: id0, references: id0 });
  });
});

describe("trimReferences (RFC 5537 §3.4.4)", () => {
  const longId = (i: number) => `pp.${String(i).padStart(24, "0")}@a-rather-long-sending-domain.example.com`;
  const lineLength = (ids: string[]) => "References: ".length + ids.map((id) => `<${id}>`).join(" ").length;

  it("keeps short chains as they are", () => {
    const ids = [longId(1), longId(2), longId(3), longId(4)];
    expect(trimReferences(ids)).toEqual(ids);
  });

  it("past 998 characters drops ids after the first, keeping the first and the last two", () => {
    const ids = Array.from({ length: 20 }, (_, i) => longId(i));
    expect(lineLength(ids)).toBeGreaterThan(REFERENCES_MAX_LINE);
    const out = trimReferences(ids);
    expect(lineLength(out)).toBeLessThanOrEqual(REFERENCES_MAX_LINE);
    expect(out[0]).toBe(ids[0]);
    expect(out.slice(-2)).toEqual(ids.slice(-2));
    expect(out).toEqual([ids[0], ...ids.slice(ids.length - out.length + 1)]);
  });

  it("never drops below the first and the last two, and drops duplicates", () => {
    const ids = [longId(1), longId(2), longId(3), longId(4)];
    expect(trimReferences(ids, 10)).toEqual([ids[0], ids[2], ids[3]]);
    expect(trimReferences([longId(1), longId(2), longId(1), longId(3)])).toEqual([longId(1), longId(2), longId(3)]);
  });
});
