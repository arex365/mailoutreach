import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The Activity page and outage holds (M4-DESIGN §3.11, §6 row 11): `followups.*` entries sit under "Emails &
 * replies", and their second line gives the dates from `data.from`/`data.to` in the viewer's own time zone.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  redirect: (href: string) => {
    throw new Error(`redirect ${href}`);
  },
}));
vi.mock("@/lib/auth/dal", () => ({
  requireUser: async () => {
    if (!auth.user) throw new Error("redirect /login");
    return auth.user;
  },
}));

const t = await createTestDb("activity-followups");
const { db, dbWrite } = await import("@/server/db");
const { default: ActivityPage } = await import("@/app/(app)/activity/page");
const { ACTIVITY_KIND_PREFIXES, followUpsDatesLine, parseActivityFilters } = await import("@/components/activity/activity-filters");
const { buildActivityWhere } = await import("@/app/(app)/activity/activity-query");

// The outage window as the hold stored it (UTC instants): late on 2 Oct UTC is 3 Oct in Berlin and Karachi.
const FROM = "2026-10-02T23:30:00.000Z";
const TO = "2026-10-09T08:00:00.000Z";

let userId = 0;

async function renderPage(timeZone: string, search: Record<string, string> = {}) {
  auth.user = { id: userId, email: "arslan@pp.test", name: "Arslan", role: "OWNER", timeZone, sessionId: 1 };
  const el = await ActivityPage({ params: Promise.resolve({}), searchParams: Promise.resolve(search) } as never);
  return renderToStaticMarkup(el);
}

beforeAll(async () => {
  const u = await dbWrite((c) => c.user.create({ data: { name: "Arslan", email: "arslan@pp.test", role: "OWNER" } }));
  userId = u.id;
  await dbWrite((c) =>
    c.activityLog.createMany({
      data: [
        {
          actorId: null,
          type: "followups.held",
          summary: "Follow-ups of 12 people were put on hold because the PC was off too long to check for replies",
          data: { from: FROM, to: TO, count: 12 },
          at: new Date("2026-10-09T09:00:00Z"),
        },
        {
          actorId: u.id,
          type: "followups.released",
          summary: "Arslan checked their inbox: follow-ups of 8 people continue",
          data: { count: 8, senderId: u.id, from: FROM, to: TO },
          at: new Date("2026-10-09T10:00:00Z"),
        },
        { actorId: u.id, type: "company.notes", summary: "Arslan updated the notes", data: { from: FROM, to: TO }, at: new Date("2026-10-09T11:00:00Z") },
        // Milestone 5: address checks and AI lines sit with companies and people.
        {
          actorId: u.id,
          type: "verify.run",
          summary: "Arslan checked 40 addresses for Germany Q4: 33 can be emailed, 2 don't exist, 1 is rated high risk.",
          at: new Date("2026-10-09T12:00:00Z"),
        },
        { actorId: u.id, type: "ai.run", summary: "Arslan asked Claude to draft lines for 30 companies (about $0.17).", at: new Date("2026-10-09T12:30:00Z") },
        { actorId: u.id, type: "ai.rejected", summary: "Arslan rejected an AI line", at: new Date("2026-10-09T13:00:00Z") },
      ],
    }),
  );
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("followUpsDatesLine", () => {
  // The window is worded as the replies that may have been missed, not the PC's off-time (review SPEC-03).
  it("writes the window in the viewer's zone, only for followups.* entries with real dates", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    expect(followUpsDatesLine("followups.held", { from: FROM, to: TO }, "Europe/Berlin", now)).toBe("Replies from 3 Oct to 9 Oct may have been missed.");
    expect(followUpsDatesLine("followups.held", { from: FROM, to: TO }, "America/New_York", now)).toBe(
      "Replies from 2 Oct to 9 Oct may have been missed.",
    );
    expect(followUpsDatesLine("followups.held", { from: FROM, to: TO }, "Europe/Berlin", new Date("2027-01-05T00:00:00Z"))).toBe(
      "Replies from 3 Oct 2026 to 9 Oct 2026 may have been missed.",
    );
    expect(followUpsDatesLine("company.notes", { from: FROM, to: TO }, "Europe/Berlin", now)).toBeNull();
    expect(followUpsDatesLine("followups.held", { from: "soon", to: TO }, "Europe/Berlin", now)).toBeNull();
    expect(followUpsDatesLine("followups.held", { count: 3 }, "Europe/Berlin", now)).toBeNull();
    expect(followUpsDatesLine("followups.held", null, "Europe/Berlin", now)).toBeNull();
    expect(followUpsDatesLine("followups.held", [FROM, TO], "Europe/Berlin", now)).toBeNull();
  });

  it("groups followups.* with emails and replies", () => {
    expect(ACTIVITY_KIND_PREFIXES.emails).toEqual(["email.", "reply.", "campaign.", "followups."]);
    const where = buildActivityWhere(parseActivityFilters(new URLSearchParams("kind=emails")), "UTC");
    expect(JSON.stringify(where)).toContain('"startsWith":"followups."');
  });
});

describe("the Activity page", () => {
  it("shows the dates of an outage hold in the viewer's time zone", async () => {
    const berlin = await renderPage("Europe/Berlin");
    expect(berlin).toContain("Follow-ups of 12 people were put on hold because the PC was off too long to check for replies");
    expect(berlin.match(/Replies from 3 Oct(?: 2026)? to 9 Oct(?: 2026)? may have been missed\./g)?.length).toBe(2);
    const newYork = await renderPage("America/New_York");
    expect(newYork).toMatch(/Replies from 2 Oct(?: 2026)? to 9 Oct(?: 2026)? may have been missed\./);
  });

  it("lists them under Emails & replies, and never adds the line to other entries", async () => {
    const emails = await renderPage("Europe/Berlin", { kind: "emails" });
    expect(emails).toContain("Arslan checked their inbox: follow-ups of 8 people continue");
    expect(emails).not.toContain("Arslan updated the notes");
    const companies = await renderPage("Europe/Berlin", { kind: "companies" });
    expect(companies).toContain("Arslan updated the notes");
    expect(companies).not.toContain("The PC was off");
  });

  it("lists address checks and AI lines under Companies & people, not under Emails & replies", async () => {
    const companies = await renderPage("Europe/Berlin", { kind: "companies" });
    expect(companies).toContain("Arslan checked 40 addresses for Germany Q4: 33 can be emailed, 2 don&#x27;t exist, 1 is rated high risk.");
    expect(companies).toContain("Arslan asked Claude to draft lines for 30 companies (about $0.17).");
    expect(companies).toContain("Arslan rejected an AI line");
    const emails = await renderPage("Europe/Berlin", { kind: "emails" });
    expect(emails).not.toContain("Arslan rejected an AI line");
    expect(emails).not.toContain("draft lines for 30 companies");
  });
});
