import { describe, expect, it } from "vitest";
import {
  companyCode,
  companySubline,
  lastContactSource,
  lastEmailedLabel,
  lastEmailedTitle,
  pageSummary,
  peopleSummary,
  toContactRow,
  TEST_LIST_NOT_EMAILED_TITLE,
} from "@/components/contacts/format";
import type { CompanySequence } from "@/components/campaigns/format";
import { lastContactAt } from "@/server/services/companies/filters";
import type { CompanyListRow } from "@/server/services/companies/query";

const NOW = new Date("2026-10-24T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("lastEmailedLabel", () => {
  it("names the sender and how long ago", () => {
    expect(
      lastEmailedLabel({ lastEmailedAt: daysAgo(12), lastEmailedByName: "Ali", importedLastContactAt: null }, NOW),
    ).toBe("Ali · 12 days ago");
  });

  it("says You for the viewer's own emails", () => {
    expect(
      lastEmailedLabel(
        { lastEmailedAt: daysAgo(1), lastEmailedByName: "Arslan", lastEmailedByViewer: true, importedLastContactAt: null },
        NOW,
      ),
    ).toBe("You · 1 day ago");
  });

  it("falls back to the old tool's date, then Never", () => {
    expect(lastEmailedLabel({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: daysAgo(12) }, NOW)).toBe(
      "Old tool · 12 days ago",
    );
    expect(lastEmailedLabel({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: null }, NOW)).toBe("Never");
  });

  it("shows whichever date is newer: this app's send or the old tool's date", () => {
    expect(
      lastEmailedLabel({ lastEmailedAt: daysAgo(3), lastEmailedByName: "Sara", importedLastContactAt: daysAgo(100) }, NOW),
    ).toBe("Sara · 3 days ago");
    expect(
      lastEmailedLabel({ lastEmailedAt: daysAgo(30), lastEmailedByName: "Sara", importedLastContactAt: daysAgo(2) }, NOW),
    ).toBe("Old tool · 2 days ago");
    // Same moment: the app's own email wins.
    expect(
      lastEmailedLabel({ lastEmailedAt: daysAgo(5), lastEmailedByName: "Sara", importedLastContactAt: daysAgo(5) }, NOW),
    ).toBe("Sara · 5 days ago");
  });

  it("names the source it shows (the same value the column sorts by)", () => {
    expect(lastContactSource({ lastEmailedAt: null, importedLastContactAt: null })).toBeNull();
    expect(lastContactSource({ lastEmailedAt: daysAgo(1), importedLastContactAt: null })).toBe("app");
    expect(lastContactSource({ lastEmailedAt: null, importedLastContactAt: daysAgo(1) })).toBe("old");
    expect(lastContactSource({ lastEmailedAt: daysAgo(9), importedLastContactAt: daysAgo(1) })).toBe("old");
    expect(lastContactSource({ lastEmailedAt: daysAgo(1), importedLastContactAt: daysAgo(9) })).toBe("app");
  });

  it("copes with a sender whose name is missing", () => {
    expect(lastEmailedLabel({ lastEmailedAt: daysAgo(2), lastEmailedByName: null, importedLastContactAt: null }, NOW)).toBe(
      "A teammate · 2 days ago",
    );
  });

  it("uses months for older dates", () => {
    expect(lastEmailedLabel({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: daysAgo(95) }, NOW)).toBe(
      "Old tool · 3 months ago",
    );
  });
});

describe("lastEmailedTitle", () => {
  it("gives the exact moment in the viewer's time zone", () => {
    const title = lastEmailedTitle(
      { lastEmailedAt: new Date("2026-10-12T09:30:00Z"), lastEmailedByName: "Ali", importedLastContactAt: null },
      "Asia/Karachi",
    );
    expect(title).toBe("Emailed by Ali on 12 Oct 2026, 14:30");
    expect(lastEmailedTitle({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: null }, "UTC")).toBeNull();
    expect(
      lastEmailedTitle({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: new Date("2025-03-01T10:00:00Z") }, "UTC"),
    ).toBe("Last contacted on 1 Mar 2025 (from the old tool)");
  });

  it("lists the newer date first when there are both", () => {
    expect(
      lastEmailedTitle(
        {
          lastEmailedAt: new Date("2026-09-01T09:30:00Z"),
          lastEmailedByName: "Ali",
          importedLastContactAt: new Date("2026-10-01T10:00:00Z"),
        },
        "UTC",
      ),
    ).toBe("Last contacted on 1 Oct 2026 (from the old tool). Emailed by Ali on 1 Sept 2026, 09:30");
    expect(
      lastEmailedTitle(
        { lastEmailedAt: new Date("2026-10-12T09:30:00Z"), lastEmailedByName: null, importedLastContactAt: new Date("2025-03-01T10:00:00Z") },
        "UTC",
      ),
    ).toBe("Emailed by a teammate on 12 Oct 2026, 09:30");
  });
});

describe("lastEmailedTitle: the replied line (M4-DESIGN §6 row 6)", () => {
  it("adds a line saying when the company replied", () => {
    expect(
      lastEmailedTitle(
        { lastEmailedAt: new Date("2026-10-12T09:30:00Z"), lastEmailedByName: "Ali", importedLastContactAt: null, repliedAt: daysAgo(2) },
        "Asia/Karachi",
        NOW,
      ),
    ).toBe("Emailed by Ali on 12 Oct 2026, 14:30\nReplied 2 days ago");
    expect(
      lastEmailedTitle(
        {
          lastEmailedAt: new Date("2026-09-01T09:30:00Z"),
          lastEmailedByName: "Ali",
          importedLastContactAt: new Date("2026-10-01T10:00:00Z"),
          repliedAt: daysAgo(1),
        },
        "UTC",
        NOW,
      ),
    ).toBe("Last contacted on 1 Oct 2026 (from the old tool). Emailed by Ali on 1 Sept 2026, 09:30\nReplied 1 day ago");
  });

  it("says only the reply for a company nobody emailed, and nothing new without one", () => {
    expect(
      lastEmailedTitle({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: null, repliedAt: daysAgo(3) }, "UTC", NOW),
    ).toBe("Replied 3 days ago");
    expect(
      lastEmailedTitle({ lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: null, repliedAt: null }, "UTC", NOW),
    ).toBeNull();
  });

  it("comes through toContactRow from the query's repliedAt", () => {
    const row: CompanyListRow = {
      id: 9,
      name: "Firma GmbH",
      website: null,
      domain: "firma.de",
      profileKey: null,
      country: null,
      niche: null,
      priority: "NORMAL",
      status: "REPLIED",
      createdAt: new Date("2026-01-05T10:00:00Z"),
      lastEmailedAt: daysAgo(5),
      lastEmailedById: 3,
      lastEmailedByName: "Ali",
      lastEmailedByViewer: true,
      importedLastContactAt: null,
      repliedAt: daysAgo(2),
      peopleCount: 1,
      emailCount: 1,
      tags: [],
      customFields: {},
    };
    const out = toContactRow(row, { timeZone: "UTC" }, NOW);
    expect(out.lastEmailedLabel).toBe("You · 5 days ago");
    expect(out.lastEmailedTitle).toMatch(/^Emailed by you on .+\nReplied 2 days ago$/);
  });
});

describe("lastEmailedTitle: test emails before going live (M6-DESIGN §2.2, L18)", () => {
  const never = { lastEmailedAt: null, lastEmailedByName: null, importedLastContactAt: null };

  it("explains the Never of a company whose current sequence is a test-list send", () => {
    expect(lastEmailedTitle({ ...never, testListSequence: true }, "UTC", NOW)).toBe(TEST_LIST_NOT_EMAILED_TITLE);
    expect(TEST_LIST_NOT_EMAILED_TITLE).toBe("Test emails before going live don't count as emailed.");
    expect(lastEmailedTitle({ ...never, testListSequence: true, repliedAt: daysAgo(1) }, "UTC", NOW)).toBe(
      "Test emails before going live don't count as emailed.\nReplied 1 day ago",
    );
    // After the old tool's date, which the column shows then.
    expect(lastEmailedTitle({ ...never, importedLastContactAt: new Date("2025-03-01T10:00:00Z"), testListSequence: true }, "UTC", NOW)).toBe(
      "Last contacted on 1 Mar 2025 (from the old tool)\nTest emails before going live don't count as emailed.",
    );
  });

  it("says nothing of it when the app emailed the company, or the sequence isn't a test-list send", () => {
    expect(
      lastEmailedTitle({ lastEmailedAt: new Date("2026-10-12T09:30:00Z"), lastEmailedByName: "Ali", importedLastContactAt: null, testListSequence: true }, "UTC", NOW),
    ).toBe("Emailed by Ali on 12 Oct 2026, 09:30");
    expect(lastEmailedTitle({ ...never, testListSequence: false }, "UTC", NOW)).toBeNull();
  });

  it("comes through toContactRow from the company's sequences", () => {
    const base: CompanyListRow = {
      id: 11,
      name: "Test mailboxes",
      website: null,
      domain: null,
      profileKey: null,
      country: null,
      niche: null,
      priority: "NORMAL",
      status: "NOT_CONTACTED",
      createdAt: new Date("2026-01-05T10:00:00Z"),
      lastEmailedAt: null,
      lastEmailedById: null,
      lastEmailedByName: null,
      lastEmailedByViewer: false,
      importedLastContactAt: null,
      peopleCount: 1,
      emailCount: 1,
      tags: [],
      customFields: {},
    };
    const sequence: CompanySequence = {
      id: 1,
      companyId: 11,
      campaignId: 4,
      campaignName: "Test run",
      campaignStatus: "FINISHED",
      campaignMode: "LIVE",
      countsAsEmailed: false,
      personId: 21,
      state: "FINISHED",
      currentStep: 1,
      nextDueAt: null,
      stopReason: null,
      updatedAt: daysAgo(2),
    };
    const out = toContactRow({ ...base, sequences: [sequence] }, { timeZone: "UTC" }, NOW);
    expect(out).toMatchObject({ lastEmailedLabel: "Never", lastEmailedTitle: TEST_LIST_NOT_EMAILED_TITLE, sequenceLabel: "Finished (test list)" });
    // A live campaign launched after go-live isn't a test-list send.
    const counted = toContactRow({ ...base, sequences: [{ ...sequence, countsAsEmailed: true }] }, { timeZone: "UTC" }, NOW);
    expect(counted.lastEmailedTitle).toBeNull();
    expect(toContactRow(base, { timeZone: "UTC" }, NOW).lastEmailedTitle).toBeNull();
  });
});

describe("lastContactAt (the stored column)", () => {
  it("is the newer of the two dates, or null", () => {
    const a = daysAgo(10);
    const b = daysAgo(3);
    expect(lastContactAt(null, null)).toBeNull();
    expect(lastContactAt(a, null)).toBe(a);
    expect(lastContactAt(undefined, b)).toBe(b);
    expect(lastContactAt(a, b)).toBe(b);
    expect(lastContactAt(b, a)).toBe(b);
  });
});

describe("peopleSummary", () => {
  it("counts people and emails", () => {
    expect(peopleSummary(2, 1)).toEqual({ text: "2 people · 1 email", missingEmail: false });
    expect(peopleSummary(1, 1)).toEqual({ text: "1 person · 1 email", missingEmail: false });
    expect(peopleSummary(3, 3)).toEqual({ text: "3 people · 3 emails", missingEmail: false });
  });

  it("says No email when nobody has an address", () => {
    expect(peopleSummary(2, 0)).toEqual({ text: "No email", missingEmail: true });
    expect(peopleSummary(0, 0)).toEqual({ text: "No email", missingEmail: true });
  });
});

describe("small labels", () => {
  it("company codes", () => {
    expect(companyCode(1042)).toBe("C-1042");
  });

  it("sublines show the host or the profile", () => {
    expect(companySubline("https://www.acme.de", null)).toBe("acme.de");
    expect(companySubline("https://acme.de/shop/", null)).toBe("acme.de/shop");
    expect(companySubline("https://www.instagram.com/anna", "instagram.com/anna")).toBe("instagram.com/anna");
    expect(companySubline(null, null)).toBeNull();
  });

  it("page summary", () => {
    expect(pageSummary(2, 30, 1480)).toBe("Page 2 of 30 · 1,480 companies");
    expect(pageSummary(1, 1, 1)).toBe("Page 1 of 1 · 1 company");
  });
});

describe("toContactRow", () => {
  it("pre-formats a row for the browser", () => {
    const row: CompanyListRow = {
      id: 7,
      name: "Acme 3D",
      website: "https://www.acme3d.de",
      domain: "acme3d.de",
      profileKey: null,
      country: "DE",
      niche: "miniatures",
      priority: "HIGH",
      status: "CONTACTED",
      createdAt: new Date("2026-01-05T10:00:00Z"),
      lastEmailedAt: daysAgo(12),
      lastEmailedById: 3,
      lastEmailedByName: "Ali",
      lastEmailedByViewer: false,
      importedLastContactAt: null,
      peopleCount: 2,
      emailCount: 1,
      tags: [{ id: 1, name: "resin" }],
      customFields: { members: "1200" },
    };
    const out = toContactRow(row, { timeZone: "Europe/Berlin" }, NOW);
    expect(out).toMatchObject({
      id: 7,
      code: "C-7",
      subline: "acme3d.de",
      countryCode: "DE",
      countryName: "Germany",
      lastEmailedLabel: "Ali · 12 days ago",
      addedLabel: "5 Jan 2026",
      tags: [{ id: 1, name: "resin" }],
      custom: { members: "1200" },
    });
    // Everything the browser gets must be plain data.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
