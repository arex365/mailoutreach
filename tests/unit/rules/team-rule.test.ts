import { describe, expect, it } from "vitest";
import { DAY_MS, teamRule, usableCompanyDomain, withinDays, type TeamRuleInput, type TeamRuleSend } from "@/core/rules/team-rule";

const NOW = new Date("2026-10-20T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);

function send(over: Partial<TeamRuleSend> = {}): TeamRuleSend {
  return {
    toNorm: "anna@acme.de",
    companyId: 1,
    companyDomain: "acme.de",
    sentAt: daysAgo(12),
    campaignId: 7,
    campaignName: "Germany Q4",
    senderName: "Ali",
    step: 1,
    ...over,
  };
}

function input(over: Partial<TeamRuleInput> = {}): TeamRuleInput {
  return {
    companyId: 1,
    companyDomain: "acme.de",
    emailNorms: ["anna@acme.de", "info@acme.de"],
    importedLastContactAt: null,
    sends: [],
    externalSends: [],
    reservations: [],
    campaignId: 99,
    now: NOW,
    days: 30,
    ...over,
  };
}

describe("the 30-day team rule", () => {
  it("allows a company nobody has contacted", () => {
    expect(teamRule(input())).toBeNull();
  });

  it("blocks a company anyone emailed in the last 30 days, with who, when, campaign and step", () => {
    const block = teamRule(input({ sends: [send()] }));
    expect(block).toMatchObject({ kind: "emailed", matchedBy: "company", campaignId: 7, step: 1 });
    expect(block?.text).toBe("Emailed by Ali 12 days ago (Germany Q4, follow-up 1)");
  });

  it("counts emails from the person checking too (there is no 'own emails' exception)", () => {
    // The rule doesn't know or care who is asking: Ali's own email blocks Ali's new campaign.
    const block = teamRule(input({ sends: [send({ senderName: "Ali" })], campaignId: 100 }));
    expect(block?.text).toContain("Emailed by Ali");
  });

  it("uses the days setting, with exactly N days ago already allowed again", () => {
    const old = send({ sentAt: daysAgo(31) });
    expect(teamRule(input({ sends: [old] }))).toBeNull();
    expect(teamRule(input({ sends: [old], days: 45 }))?.kind).toBe("emailed");
    expect(teamRule(input({ sends: [send({ sentAt: daysAgo(30) })] }))).toBeNull();
    expect(teamRule(input({ sends: [send({ sentAt: new Date(daysAgo(30).getTime() + 60_000) })] }))?.kind).toBe("emailed");
    // 0 switches the history part off.
    expect(teamRule(input({ sends: [send({ sentAt: daysAgo(1) })], days: 0 }))).toBeNull();
  });

  it("matches another company record on the same website domain", () => {
    const block = teamRule(input({ sends: [send({ companyId: 55, toNorm: "sales@acme.de" })] }));
    expect(block).toMatchObject({ kind: "emailed", matchedBy: "domain" });
    expect(block?.text).toBe("Someone at acme.de was emailed by Ali 12 days ago (Germany Q4, follow-up 1)");
  });

  it("matches one of the company's addresses, even when the email was for another company", () => {
    const block = teamRule(
      input({ companyDomain: null, sends: [send({ companyId: 55, companyDomain: "other.de", toNorm: "info@acme.de", step: 0 })] }),
    );
    expect(block).toMatchObject({ kind: "emailed", matchedBy: "address" });
    expect(block?.text).toBe("info@acme.de was emailed by Ali 12 days ago (Germany Q4, first email)");
  });

  it("never matches on shared or free-mail domains", () => {
    const gmailSend = send({ companyId: 55, companyDomain: "gmail.com", toNorm: "someone.else@gmail.com" });
    // The stored domain is null for shared hosts…
    expect(teamRule(input({ companyDomain: null, emailNorms: ["anna@gmail.com"], sends: [gmailSend] }))).toBeNull();
    // …and even a shared domain stored by mistake never matches.
    expect(teamRule(input({ companyDomain: "gmail.com", emailNorms: ["anna@gmail.com"], sends: [gmailSend] }))).toBeNull();
    expect(
      teamRule(input({ companyDomain: "instagram.com", sends: [send({ companyId: 55, companyDomain: "instagram.com", toNorm: "x@y.z" })] })),
    ).toBeNull();
    // A null snapshot never equals a null company domain.
    expect(teamRule(input({ companyDomain: null, sends: [send({ companyId: 55, companyDomain: null, toNorm: "x@y.z" })] }))).toBeNull();
    // Extra shared domains from the settings count too.
    expect(
      teamRule(
        input({ companyDomain: "hosted.example", extraShared: new Set(["hosted.example"]), sends: [send({ companyId: 55, companyDomain: "hosted.example", toNorm: "x@y.z" })] }),
      ),
    ).toBeNull();
  });

  it("counts the old tool's last-contacted date", () => {
    const block = teamRule(input({ importedLastContactAt: daysAgo(12) }));
    expect(block).toMatchObject({ kind: "old-tool" });
    expect(block?.text).toBe("Contacted in the old tool 12 days ago");
    expect(teamRule(input({ importedLastContactAt: daysAgo(40) }))).toBeNull();
  });

  it("counts live sends found in Mailgun's logs", () => {
    const block = teamRule(input({ externalSends: [{ toNorm: "anna@acme.de", companyId: null, companyDomain: null, sentAt: daysAgo(3) }] }));
    expect(block).toMatchObject({ kind: "external", matchedBy: "address" });
    expect(block?.text).toBe("anna@acme.de was emailed 3 days ago (found in Mailgun's logs)");
  });

  it("reports the most recent contact when several match", () => {
    const block = teamRule(
      input({
        importedLastContactAt: daysAgo(20),
        sends: [send({ sentAt: daysAgo(15), senderName: "Sara" }), send({ sentAt: daysAgo(4), senderName: "Ali", step: 2 })],
      }),
    );
    expect(block?.text).toBe("Emailed by Ali 4 days ago (Germany Q4, follow-up 2)");
    expect(teamRule(input({ importedLastContactAt: daysAgo(2), sends: [send({ sentAt: daysAgo(4) })] }))?.kind).toBe("old-tool");
  });

  it("blocks a company waiting in another active campaign", () => {
    const block = teamRule(input({ reservations: [{ campaignId: 3, campaignName: "Norway prints", ownerName: "Sara" }] }));
    expect(block).toMatchObject({ kind: "reserved", campaignId: 3 });
    expect(block?.text).toBe("Waiting in Sara's campaign 'Norway prints'");
    // A recent email is reported before the reservation.
    expect(
      teamRule(input({ sends: [send()], reservations: [{ campaignId: 3, campaignName: "Norway prints", ownerName: "Sara" }] }))?.kind,
    ).toBe("emailed");
  });

  it("never blocks a campaign with its own sends or reservation (all steps, all people)", () => {
    const own = [send({ campaignId: 99, step: 0 }), send({ campaignId: 99, step: 2, toNorm: "info@acme.de", sentAt: daysAgo(1) })];
    expect(teamRule(input({ sends: own }))).toBeNull();
    expect(teamRule(input({ reservations: [{ campaignId: 99, campaignName: "Mine", ownerName: "Ali" }] }))).toBeNull();
    // Another campaign's email still blocks.
    expect(teamRule(input({ sends: [...own, send({ campaignId: 5 })] }))?.kind).toBe("emailed");
  });

  it("words emails without a sender or campaign name", () => {
    const block = teamRule(input({ sends: [send({ senderName: null, campaignName: null, step: 0 })] }));
    expect(block?.text).toBe("Emailed 12 days ago (first email)");
  });
});

describe("helpers", () => {
  it("withinDays", () => {
    expect(withinDays(daysAgo(1), NOW, 30)).toBe(true);
    expect(withinDays(new Date(NOW.getTime() + DAY_MS), NOW, 30)).toBe(true);
    expect(withinDays(daysAgo(30), NOW, 30)).toBe(false);
    expect(withinDays(daysAgo(1), NOW, 0)).toBe(false);
  });

  it("usableCompanyDomain", () => {
    expect(usableCompanyDomain("Acme.DE")).toBe("acme.de");
    expect(usableCompanyDomain("gmail.com")).toBeNull();
    expect(usableCompanyDomain("etsy.com")).toBeNull();
    expect(usableCompanyDomain("")).toBeNull();
    expect(usableCompanyDomain(null)).toBeNull();
  });
});
