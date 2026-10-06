import { describe, expect, it } from "vitest";
import {
  checkedText,
  emailedSummary,
  personalLineSourceText,
  personFlags,
  pickSequence,
  pickTestSend,
  sequenceStateText,
  stepLabel,
  stopReasonText,
  testSendText,
  wordCount,
  type SequenceInfo,
  type TestSendInfo,
} from "@/components/company-panel/emailed-text";

const NOW = new Date("2026-09-23T10:00:00Z");
const TZ = "Asia/Karachi";
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** A recipient row; by default on real data after go-live: a live campaign launched after it counts as emailed, a dry run doesn't. */
function seq(partial: Partial<SequenceInfo>): SequenceInfo {
  return {
    id: 1,
    campaignId: 1,
    campaignName: "Germany Q4",
    campaignMode: "LIVE",
    countsAsEmailed: (partial.campaignMode ?? "LIVE") === "LIVE",
    state: "WAITING",
    currentStep: 1,
    nextDueAt: null,
    stopReason: null,
    ...partial,
  };
}

describe("stepLabel", () => {
  it("names steps the way people say them", () => {
    expect(stepLabel(0)).toBe("first email");
    expect(stepLabel(1)).toBe("follow-up 1");
    expect(stepLabel(3)).toBe("follow-up 3");
    expect(stepLabel(null)).toBe("");
  });
});

describe("emailedSummary", () => {
  it("builds the full banner with the sequence state", () => {
    const s = emailedSummary(
      {
        lastEmailedAt: daysAgo(12),
        lastEmailedByName: "Ali",
        lastEmailedCampaignName: "Germany Q4",
        lastEmailedStep: 1,
        sequence: seq({ state: "WAITING", currentStep: 2, nextDueAt: new Date("2026-10-12T08:00:00Z") }),
      },
      TZ,
      NOW,
    );
    expect(s.emailed).toBe(true);
    expect(s.text).toBe("Emailed by Ali 12 days ago · Germany Q4 · follow-up 1 · waiting for follow-up 2 on 12 Oct");
  });

  it("says first email for step 0 and copes with a missing sender or campaign", () => {
    const s = emailedSummary(
      { lastEmailedAt: daysAgo(3), lastEmailedByName: null, lastEmailedCampaignName: null, lastEmailedStep: 0 },
      TZ,
      NOW,
    );
    expect(s.text).toBe("Emailed 3 days ago · first email");
  });

  it("falls back to the old tool's date", () => {
    const s = emailedSummary(
      {
        lastEmailedAt: null,
        lastEmailedByName: null,
        lastEmailedCampaignName: null,
        lastEmailedStep: null,
        importedLastContactAt: daysAgo(12),
      },
      TZ,
      NOW,
    );
    expect(s).toEqual({
      emailed: true,
      testOnly: false,
      parts: ["Contacted in the old tool 12 days ago"],
      text: "Contacted in the old tool 12 days ago",
    });
  });

  it("says Never emailed, plus a scheduled first email when there is one", () => {
    const base = { lastEmailedAt: null, lastEmailedByName: null, lastEmailedCampaignName: null, lastEmailedStep: null };
    expect(emailedSummary(base, TZ, NOW)).toEqual({ emailed: false, testOnly: false, parts: ["Never emailed"], text: "Never emailed" });
    const scheduled = emailedSummary(
      { ...base, sequence: seq({ state: "SCHEDULED", currentStep: 0, nextDueAt: new Date("2026-10-03T07:00:00Z") }) },
      TZ,
      NOW,
    );
    expect(scheduled.text).toBe("Never emailed · scheduled for 3 Oct");
    expect(scheduled.emailed).toBe(false);
  });

  it("prefers the app's own email over the old tool's date", () => {
    const s = emailedSummary(
      {
        lastEmailedAt: daysAgo(2),
        lastEmailedByName: "Sara",
        lastEmailedCampaignName: "Norway prints",
        lastEmailedStep: 0,
        importedLastContactAt: daysAgo(200),
      },
      TZ,
      NOW,
    );
    expect(s.text).toBe("Emailed by Sara 2 days ago · Norway prints · first email");
  });

  it("leads with the old tool's date when it's newer than the app's last email", () => {
    const s = emailedSummary(
      {
        lastEmailedAt: daysAgo(40),
        lastEmailedByName: "Sara",
        lastEmailedCampaignName: "Norway prints",
        lastEmailedStep: 0,
        importedLastContactAt: daysAgo(3),
      },
      TZ,
      NOW,
    );
    expect(s.emailed).toBe(true);
    expect(s.text).toBe("Contacted in the old tool 3 days ago · emailed by Sara 40 days ago · Norway prints · first email");
  });
});

describe("sequenceStateText", () => {
  it("covers every state that is shown", () => {
    expect(sequenceStateText(seq({ state: "FINISHED" }), TZ, NOW)).toBe("finished");
    expect(sequenceStateText(seq({ state: "HELD", holdReason: "outage" }), TZ, NOW)).toBe(
      "on hold: replies may have been missed while the PC was off",
    );
    expect(sequenceStateText(seq({ state: "HELD" }), TZ, NOW)).toBe("on hold");
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "replied" }), TZ, NOW)).toBe("stopped because they replied");
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: null }), TZ, NOW)).toBe("stopped");
    expect(sequenceStateText(seq({ state: "RECHECK" }), TZ, NOW)).toBe("waiting for re-check");
    expect(sequenceStateText(seq({ state: "PENDING" }), TZ, NOW)).toBeNull();
    expect(sequenceStateText(seq({ state: "EXCLUDED" }), TZ, NOW)).toBeNull();
    expect(sequenceStateText(null, TZ, NOW)).toBeNull();
  });

  it("says when a RECHECK recipient's second address check is due, in the viewer's zone (M5-DESIGN §2.7)", () => {
    const recheckAt = new Date("2026-09-27T09:05:00Z");
    expect(sequenceStateText(seq({ state: "RECHECK", currentStep: 0, recheckAt }), TZ, NOW)).toBe("waiting for re-check on 27 Sept at 14:05");
    expect(sequenceStateText(seq({ state: "RECHECK", currentStep: 0, recheckAt: recheckAt.toISOString() }), "Europe/Berlin", NOW)).toBe(
      "waiting for re-check on 27 Sept at 11:05",
    );
    // Only while RECHECK.
    expect(sequenceStateText(seq({ state: "FINISHED", recheckAt }), TZ, NOW)).toBe("finished");
    // The dry-run and test-list suffixes still follow.
    expect(sequenceStateText(seq({ state: "RECHECK", recheckAt, campaignMode: "DRY_RUN" }), TZ, NOW)).toBe(
      "waiting for re-check on 27 Sept at 14:05 (dry run)",
    );
  });

  it("says an address check stopped the sequence (stop code invalid)", () => {
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "invalid" }), TZ, NOW)).toBe(
      "stopped because the address check said not to email it",
    );
    expect(stopReasonText("invalid")).toBe("the address check said not to email it");
  });

  it("shows dates in the viewer's time zone", () => {
    // 20:00 UTC on 11 Oct is already 12 Oct in Pakistan (UTC+5).
    const s = seq({ state: "WAITING", currentStep: 2, nextDueAt: new Date("2026-10-11T20:00:00Z") });
    expect(sequenceStateText(s, "Asia/Karachi", NOW)).toBe("waiting for follow-up 2 on 12 Oct");
    expect(sequenceStateText(s, "Europe/London", NOW)).toBe("waiting for follow-up 2 on 11 Oct");
  });

  it("labels dry-run and test campaigns", () => {
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "DRY_RUN" }), TZ, NOW)).toBe("finished (dry run)");
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "TEST" }), TZ, NOW)).toBe("finished (test)");
  });

  it("drops the dry-run label where a dry run counts as emailed (practice copy), like the Contacts column", () => {
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "DRY_RUN", countsAsEmailed: true }), TZ, NOW)).toBe("finished");
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "DRY_RUN", countsAsEmailed: false }), TZ, NOW)).toBe(
      "finished (dry run)",
    );
    // A test campaign never counts as emailed.
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "TEST", countsAsEmailed: false }), TZ, NOW)).toBe("finished (test)");
  });

  it("handles a scheduled follow-up and a waiting first email", () => {
    const due = new Date("2026-10-03T07:00:00Z");
    expect(sequenceStateText(seq({ state: "SCHEDULED", currentStep: 1, nextDueAt: due }), TZ, NOW)).toBe(
      "follow-up 1 scheduled for 3 Oct",
    );
    expect(sequenceStateText(seq({ state: "WAITING", currentStep: 0, nextDueAt: due }), TZ, NOW)).toBe(
      "waiting for the first email on 3 Oct",
    );
    expect(sequenceStateText(seq({ state: "WAITING", currentStep: 2, nextDueAt: null }), TZ, NOW)).toBe(
      "waiting for follow-up 2",
    );
  });
});

describe("sequenceStateText: Milestone 4 words (M4-DESIGN §2.12)", () => {
  const due = new Date("2026-09-20T07:00:00Z"); // 20 Sep, before NOW
  const later = new Date("2026-10-12T07:00:00Z");

  it("says a due first email is waiting, and an overdue follow-up waits since its date", () => {
    expect(sequenceStateText(seq({ state: "SCHEDULED", currentStep: 0, nextDueAt: later }), TZ, NOW)).toBe("scheduled for 12 Oct");
    expect(sequenceStateText(seq({ state: "SCHEDULED", currentStep: 0, nextDueAt: due }), TZ, NOW)).toBe("waiting for the first email");
    expect(sequenceStateText(seq({ state: "WAITING", currentStep: 2, nextDueAt: later }), TZ, NOW)).toBe(
      "waiting for follow-up 2 on 12 Oct",
    );
    expect(sequenceStateText(seq({ state: "WAITING", currentStep: 2, nextDueAt: due }), TZ, NOW)).toBe(
      "waiting for follow-up 2 since 20 Sept",
    );
    expect(sequenceStateText(seq({ state: "WAITING", currentStep: 1, nextDueAt: NOW }), TZ, NOW)).toMatch(/since/);
  });

  it("words each hold reason, the possible reply first", () => {
    expect(sequenceStateText(seq({ state: "HELD", holdReason: "possible-reply" }), TZ, NOW)).toBe(
      "on hold: a possible reply needs checking",
    );
    expect(sequenceStateText(seq({ state: "HELD", holdReason: "outage,possible-reply" }), TZ, NOW)).toBe(
      "on hold: a possible reply needs checking",
    );
    expect(sequenceStateText(seq({ state: "HELD", holdReason: "outage" }), TZ, NOW)).toBe(
      "on hold: replies may have been missed while the PC was off",
    );
    // A stale reason on a row that isn't held any more says nothing about a hold.
    expect(sequenceStateText(seq({ state: "WAITING", currentStep: 1, nextDueAt: later, holdReason: "outage" }), TZ, NOW)).toBe(
      "waiting for follow-up 1 on 12 Oct",
    );
  });

  it("words the reply and status stops", () => {
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "replied" }), TZ, NOW)).toBe("stopped because they replied");
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "company_replied" }), TZ, NOW)).toBe(
      "stopped because someone at the company replied",
    );
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "status:CLIENT" }), TZ, NOW)).toBe(
      "stopped because the company was marked Client",
    );
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "status:NOT_INTERESTED" }), TZ, NOW)).toBe(
      "stopped because the company was marked Not interested",
    );
    // M3 codes keep their texts.
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "unsubscribed" }), TZ, NOW)).toBe("stopped because they unsubscribed");
    expect(sequenceStateText(seq({ state: "STOPPED", stopReason: "Skipped by Sara" }), TZ, NOW)).toBe("stopped because skipped by Sara");
  });

  it("adds (test list) to live emails of a campaign launched before go-live, from countsAsEmailed (M6-DESIGN §2.2)", () => {
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "LIVE", countsAsEmailed: false }), TZ, NOW)).toBe(
      "finished (test list)",
    );
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "LIVE", countsAsEmailed: true }), TZ, NOW)).toBe("finished");
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "DRY_RUN", countsAsEmailed: false }), TZ, NOW)).toBe(
      "finished (dry run)",
    );
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "DRY_RUN", countsAsEmailed: true }), TZ, NOW)).toBe("finished");
    expect(sequenceStateText(seq({ state: "FINISHED", campaignMode: "TEST", countsAsEmailed: false }), TZ, NOW)).toBe("finished (test)");
    expect(
      sequenceStateText(seq({ state: "STOPPED", stopReason: "replied", campaignMode: "LIVE", countsAsEmailed: false }), TZ, NOW),
    ).toBe("stopped because they replied (test list)");
  });
});

describe("emailedSummary: the replied part (M4-DESIGN §6 row 2)", () => {
  const base = { lastEmailedAt: null, lastEmailedByName: null, lastEmailedCampaignName: null, lastEmailedStep: null };

  it("ends the banner with replied … after the sequence", () => {
    const s = emailedSummary(
      {
        lastEmailedAt: daysAgo(12),
        lastEmailedByName: "Ali",
        lastEmailedCampaignName: "Germany Q4",
        lastEmailedStep: 1,
        sequence: seq({ state: "STOPPED", stopReason: "replied" }),
        repliedAt: daysAgo(2),
      },
      TZ,
      NOW,
    );
    expect(s.text).toBe("Emailed by Ali 12 days ago · Germany Q4 · follow-up 1 · stopped because they replied · replied 2 days ago");
    expect(s.emailed).toBe(true);
  });

  it("says Never emailed · replied … for a company that wrote first", () => {
    const s = emailedSummary({ ...base, repliedAt: daysAgo(2) }, TZ, NOW);
    expect(s.text).toBe("Never emailed · replied 2 days ago");
    expect(s.emailed).toBe(false);
    expect(emailedSummary({ ...base, repliedAt: null }, TZ, NOW).text).toBe("Never emailed");
  });
});

describe("emailedSummary: test emails (M4 review NOTIFY-01)", () => {
  const base = { lastEmailedAt: null, lastEmailedByName: null, lastEmailedCampaignName: null, lastEmailedStep: null };
  const sent = new Date("2026-09-21T09:00:00Z"); // 21 Sept, 14:00 in Pakistan
  const testList: TestSendInfo = { sentAt: sent, mode: "LIVE", step: 0, campaignId: 1, campaignName: "Test mailboxes" };

  it("says a test email went to a test-list mailbox that replied, never 'Never emailed'", () => {
    const s = emailedSummary(
      {
        ...base,
        testSend: testList,
        sequence: seq({ campaignId: 1, state: "STOPPED", stopReason: "replied", campaignMode: "LIVE", countsAsEmailed: false }),
      },
      TZ,
      NOW,
    );
    expect(s.text).toBe(
      "Test email sent 21 Sept (test list, doesn't count as emailed) · Test mailboxes · first email · stopped because they replied",
    );
    expect(s.text).not.toMatch(/Never emailed/);
    // Still not "emailed" for filters and the 30-day rule.
    expect(s.emailed).toBe(false);
    expect(s.testOnly).toBe(true);
  });

  it("says so while the follow-up waits, and after go-live (no suffix any more) too", () => {
    const due = new Date("2026-09-25T07:00:00Z");
    const waiting = seq({ campaignId: 1, state: "WAITING", currentStep: 1, nextDueAt: due, campaignMode: "LIVE", countsAsEmailed: false });
    expect(emailedSummary({ ...base, testSend: testList, sequence: waiting }, TZ, NOW).text).toBe(
      "Test email sent 21 Sept (test list, doesn't count as emailed) · Test mailboxes · first email · waiting for follow-up 1 on 25 Sept",
    );
    // Sent before go-live, looked at after it: the stored send still says it went to the test list.
    const after = seq({ campaignId: 1, state: "FINISHED", campaignMode: "LIVE", countsAsEmailed: true });
    expect(emailedSummary({ ...base, testSend: { ...testList, step: 1 }, sequence: after }, TZ, NOW).text).toBe(
      "Test email sent 21 Sept (test list, doesn't count as emailed) · Test mailboxes · follow-up 1 · finished",
    );
  });

  it("keeps the suffix of another campaign's sequence, and the replied part last", () => {
    const dry = seq({ id: 9, campaignId: 7, state: "WAITING", currentStep: 1, nextDueAt: null, campaignMode: "DRY_RUN" });
    const s = emailedSummary({ ...base, testSend: testList, sequence: dry, repliedAt: daysAgo(1) }, TZ, NOW);
    expect(s.text).toBe(
      "Test email sent 21 Sept (test list, doesn't count as emailed) · Test mailboxes · first email · waiting for follow-up 1 (dry run) · replied 1 day ago",
    );
  });

  it("words Mailgun's test mode as not delivered", () => {
    const s = emailedSummary(
      {
        ...base,
        testSend: { sentAt: sent, mode: "TEST", step: 0, campaignId: 3, campaignName: "Mode check" },
        sequence: seq({ campaignId: 3, state: "FINISHED", campaignMode: "TEST", countsAsEmailed: false }),
      },
      TZ,
      NOW,
    );
    expect(s.text).toBe("Sent in test mode 21 Sept (not delivered) · Mode check · first email · finished");
    expect(s.emailed).toBe(false);
    expect(s.testOnly).toBe(true);
  });

  it("keeps 'Never emailed' when nothing was sent, and lets a counted email or the old tool win", () => {
    expect(emailedSummary({ ...base, testSend: null }, TZ, NOW).text).toBe("Never emailed");
    // A dry run on real data sends nothing: no test send, the dry-run suffix stays.
    expect(
      emailedSummary({ ...base, sequence: seq({ state: "FINISHED", campaignMode: "DRY_RUN", countsAsEmailed: false }) }, TZ, NOW).text,
    ).toBe("Never emailed · finished (dry run)");
    const counted = emailedSummary(
      { ...base, lastEmailedAt: daysAgo(2), lastEmailedByName: "Ali", lastEmailedCampaignName: "Germany Q4", lastEmailedStep: 0, testSend: testList },
      TZ,
      NOW,
    );
    expect(counted.text).toBe("Emailed by Ali 2 days ago · Germany Q4 · first email");
    expect(counted.testOnly).toBe(false);
    expect(emailedSummary({ ...base, importedLastContactAt: daysAgo(5), testSend: testList }, TZ, NOW).text).toBe(
      "Contacted in the old tool 5 days ago",
    );
  });

  it("writes the date in the viewer's zone", () => {
    // 20:00 UTC on 23 Sept is already 24 Sept in Pakistan.
    const late = { ...testList, sentAt: new Date("2026-09-23T20:00:00Z") };
    expect(testSendText(late, "Asia/Karachi", NOW)).toBe("Test email sent 24 Sept (test list, doesn't count as emailed)");
    expect(testSendText(late, "Europe/London", NOW)).toBe("Test email sent 23 Sept (test list, doesn't count as emailed)");
  });
});

describe("pickTestSend", () => {
  const at = (iso: string) => new Date(iso);

  it("prefers a delivered test-list email over Mailgun's test mode, then the newest", () => {
    const rows = [
      { id: 1, mode: "TEST" as const, sentAt: at("2026-09-22T09:00:00Z") },
      { id: 2, mode: "LIVE" as const, sentAt: at("2026-09-20T09:00:00Z") },
      { id: 3, mode: "LIVE" as const, sentAt: at("2026-09-21T09:00:00Z") },
    ];
    expect(pickTestSend(rows)?.id).toBe(3);
    expect(pickTestSend(rows.filter((r) => r.mode === "TEST"))?.id).toBe(1);
  });

  it("ignores other modes and missing dates", () => {
    expect(pickTestSend([])).toBeNull();
    expect(
      pickTestSend([
        { id: 1, mode: "DRY_RUN" as unknown as "LIVE", sentAt: at("2026-09-22T09:00:00Z") },
        { id: 2, mode: "LIVE" as const, sentAt: "not a date" },
      ]),
    ).toBeNull();
  });
});

describe("personFlags (people rows)", () => {
  const none = { unsubscribedAt: null, bouncedAt: null, complainedAt: null, repliedAt: null, suppressed: false };

  it("flags a reply with its date in the viewer's zone", () => {
    // 20:00 UTC on 2 Oct is already 3 Oct in Pakistan.
    expect(personFlags({ ...none, repliedAt: new Date("2026-10-02T20:00:00Z") }, TZ, NOW)).toEqual([
      { label: "Replied", tone: "good", title: "Replied on 3 Oct" },
    ]);
    expect(personFlags({ ...none, repliedAt: new Date("2025-10-02T08:00:00Z") }, TZ, NOW)[0]!.title).toBe("Replied on 2 Oct 2025");
  });

  it("keeps the other flags, and Blocked only for a suppression without another reason", () => {
    const at = new Date("2026-09-01T08:00:00Z");
    expect(personFlags({ ...none, unsubscribedAt: at, suppressed: true }, TZ, NOW).map((f) => f.label)).toEqual(["Unsubscribed"]);
    expect(personFlags({ ...none, bouncedAt: at, repliedAt: at }, TZ, NOW).map((f) => f.label)).toEqual(["Bounced", "Replied"]);
    expect(personFlags({ ...none, complainedAt: at }, TZ, NOW)[0]).toEqual({
      label: "Complained",
      tone: "danger",
      title: "Marked an email as spam on 1 Sept",
    });
    expect(personFlags({ ...none, suppressed: true }, TZ, NOW)).toEqual([
      { label: "Blocked", tone: "danger", title: "This address is on the do-not-email list." },
    ]);
    expect(personFlags(none, TZ, NOW)).toEqual([]);
  });
});

describe("stopReasonText", () => {
  it("puts stored reasons into words", () => {
    expect(stopReasonText("unsubscribed")).toBe("they unsubscribed");
    expect(stopReasonText("BOUNCED")).toBe("the email bounced");
    expect(stopReasonText("complained")).toBe("they marked it as spam");
    expect(stopReasonText("company_replied")).toBe("someone at the company replied");
    expect(stopReasonText("status:CLIENT")).toBe("the company was marked Client");
    expect(stopReasonText("status:DO_NOT_CONTACT")).toBe("the company was marked Do not contact");
  });
  it("keeps sentences and humanises unknown codes", () => {
    expect(stopReasonText("Someone at Acme replied.")).toBe("someone at Acme replied");
    expect(stopReasonText("weird_new_reason")).toBe("weird new reason");
    expect(stopReasonText("")).toBe("");
    expect(stopReasonText(null)).toBe("");
  });
});

describe("pickSequence", () => {
  it("prefers an active sequence over a newer finished one", () => {
    const rows = [
      seq({ id: 1, campaignId: 1, state: "WAITING", nextDueAt: new Date("2026-10-01T00:00:00Z") }),
      seq({ id: 2, campaignId: 2, state: "FINISHED" }),
    ];
    expect(pickSequence(rows)?.id).toBe(1);
  });

  it("prefers real campaigns over dry runs, then the soonest next step", () => {
    const rows = [
      seq({ id: 1, campaignId: 3, campaignMode: "DRY_RUN", state: "WAITING", nextDueAt: new Date("2026-09-24T00:00:00Z") }),
      seq({ id: 2, campaignId: 2, campaignMode: "LIVE", state: "WAITING", nextDueAt: new Date("2026-10-05T00:00:00Z") }),
      seq({ id: 3, campaignId: 2, campaignMode: "LIVE", state: "SCHEDULED", nextDueAt: new Date("2026-09-30T00:00:00Z") }),
    ];
    expect(pickSequence(rows)?.id).toBe(3);
  });

  it("otherwise uses the most recent campaign", () => {
    const rows = [
      seq({ id: 5, campaignId: 4, state: "FINISHED", updatedAt: new Date("2026-09-01T00:00:00Z") }),
      seq({ id: 6, campaignId: 7, state: "STOPPED", stopReason: "replied", updatedAt: new Date("2026-08-01T00:00:00Z") }),
      seq({ id: 7, campaignId: 7, state: "FINISHED", updatedAt: new Date("2026-08-15T00:00:00Z") }),
    ];
    expect(pickSequence(rows)?.id).toBe(7);
  });

  it("ignores drafts and exclusions", () => {
    expect(pickSequence([seq({ state: "PENDING" }), seq({ state: "EXCLUDED" })])).toBeNull();
    expect(pickSequence([])).toBeNull();
  });
});

describe("personal line and check texts", () => {
  it("says where a personal line came from", () => {
    const at = new Date("2026-03-03T09:00:00Z");
    expect(personalLineSourceText("manual", "Ali", at, TZ, NOW)).toBe("Written by Ali on 3 Mar");
    expect(personalLineSourceText("import", null, at, TZ, NOW)).toBe("Imported");
    expect(personalLineSourceText("ai", "Sara", at, TZ, NOW)).toBe("AI, approved by Sara on 3 Mar");
    expect(personalLineSourceText(null, null, null, TZ, NOW)).toBe("");
  });

  it("shows when an address was checked", () => {
    const at = new Date("2026-03-03T09:00:00Z");
    expect(checkedText(at, "mailgun", TZ, NOW)).toBe("checked 3 Mar");
    expect(checkedText(at, "fake", TZ, NOW)).toBe("checked 3 Mar by the test checker");
    expect(checkedText(null, null, TZ, NOW)).toBe("");
    expect(checkedText(new Date("2025-03-03T09:00:00Z"), "mailgun", TZ, NOW)).toBe("checked 3 Mar 2025");
  });

  it("names the test checker for any provider that doesn't count for real sending (M5-DESIGN §6.5)", () => {
    const at = new Date("2026-03-03T09:00:00Z");
    // The fake Mailgun's results count only while the app talks to it (fake mode).
    expect(checkedText(at, "mailgun-fake", TZ, NOW)).toBe("checked 3 Mar by the test checker");
    expect(checkedText(at, "mailgun-fake", TZ, NOW, new Set(["mailgun", "zerobounce", "neverbounce", "mailgun-fake"]))).toBe("checked 3 Mar");
    expect(checkedText(at, "zerobounce", TZ, NOW)).toBe("checked 3 Mar");
    expect(checkedText(at, "someone-else", TZ, NOW)).toBe("checked 3 Mar by the test checker");
    // A result stored without a provider counts as real, as eligibility reads it.
    expect(checkedText(at, null, TZ, NOW)).toBe("checked 3 Mar");
  });

  it("counts words", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  Your dragon  busts are great ")).toBe(5);
  });
});
