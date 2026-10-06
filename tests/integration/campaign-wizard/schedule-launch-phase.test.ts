import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The Schedule step counts only what the launch will really send (M5-DESIGN §6.1; M5 review SCREENS-09), from a
 * seeded database: `campaignLaunchCheckAudience` says which companies launch leaves out entirely and where the
 * unchecked people are, and the page's "They're for N companies" and recipients' times leave them out.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/campaigns",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/auth/dal", () => {
  const user = async () => {
    if (!auth.user) throw new Error("signed out");
    return auth.user;
  };
  return { requireUser: user, requireOwner: user, requireUserAction: user, requireOwnerAction: user, getUserOrNull: async () => auth.user };
});

const t = await createTestDb("schedule-launch-phase");
const { db, dbWrite } = await import("@/server/db");
const { campaignLaunchCheckAudience, campaignLaunchCheckNote } = await import("@/server/services/verification/select");
const { default: ScheduleStepPage } = await import("@/app/(app)/campaigns/[id]/setup/schedule/page");

const html = (s: string) => s.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const DAY = 24 * 3_600_000;

let mg: FakeConnection;
let owner: TestUser;
let draftId: number;

/** A Mailgun result from yesterday (a real provider, so it counts). */
async function checked(personId: number) {
  await dbWrite((c) =>
    c.person.update({
      where: { id: personId },
      data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(Date.now() - DAY), verificationProvider: "mailgun" },
    }),
  );
}

async function zone(companyId: number, timeZone: string | null) {
  await dbWrite((c) => c.company.update({ where: { id: companyId }, data: { timeZone } }));
}

/**
 * 6 ticked people at 4 companies: A (Oslo) one checked and one unchecked, B (no zone) one unchecked, C (Berlin) one
 * checked, D (Oslo) two unchecked. Launch sends 2 emails, to A and C.
 */
async function seed() {
  const a = await makeCompany({ name: "Launch Phase A", people: [{ name: "Anna Checked" }, { name: "Arne Unchecked" }] });
  const b = await makeCompany({ name: "Launch Phase B", people: [{ name: "Berit Unchecked" }] });
  const c = await makeCompany({ name: "Launch Phase C", people: [{ name: "Carl Checked" }] });
  const d = await makeCompany({ name: "Launch Phase D", people: [{ name: "Dora Unchecked" }, { name: "Dag Unchecked" }] });
  await zone(a.company.id, "Europe/Oslo");
  await zone(b.company.id, null);
  await zone(c.company.id, "Europe/Berlin");
  await zone(d.company.id, "Europe/Oslo");
  await checked(a.people[0]!.id);
  await checked(c.people[0]!.id);
  const recipients = [a, b, c, d].flatMap((x) => x.people.map((p) => ({ companyId: x.company.id, personId: p.id })));
  return makeDraft({ name: "Norway launch phase", createdById: owner.id, recipients, startAt: new Date(Date.now() + 2 * DAY) });
}

beforeAll(async () => {
  mg = await connectFakeMailgun();
  const u = await makeUser("Arslan", { role: "OWNER" });
  owner = { id: u.id, email: u.email, name: u.name, role: "OWNER", timeZone: "Europe/Berlin", sessionId: 1 };
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
  await setSettingValue("defaultTimeZone", "Europe/Berlin");
  draftId = (await seed()).id;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the Schedule step's launch phase", () => {
  it("says which companies launch leaves out and where the unchecked people are", async () => {
    const audience = await campaignLaunchCheckAudience(draftId);
    expect(audience).toMatchObject({ unchecked: 4, secondCheck: 0, companiesLeftOut: 2 });
    expect([...audience.uncheckedZones].sort((x, y) => String(x.timeZone).localeCompare(String(y.timeZone)))).toEqual([
      { timeZone: "Europe/Oslo", people: 3 },
      { timeZone: null, people: 1 },
    ]);
    // The note's own shape is unchanged.
    expect(await campaignLaunchCheckNote(draftId)).toEqual({ unchecked: 4, secondCheck: 0 });
  });

  it("counts the emails, companies and recipients' times the launch will really send", async () => {
    auth.user = owner;
    const el = await ScheduleStepPage({ params: Promise.resolve({ id: String(draftId) }), searchParams: Promise.resolve({}) } as never);
    const out = html(renderToStaticMarkup(el));
    expect(out).toContain("2 emails will be sent. They're for 2 companies");
    expect(out).toContain("4 people with unchecked addresses will be left out when you launch.");
    expect(out).toMatch(/In the recipients' time: \d\d:\d\d in Berlin for 1 person and \d\d:\d\d in Oslo for 1 person\./);
    // Only B had no zone of its own, and B is left out.
    expect(out).not.toContain("with no country or time zone set");
    expect(out).not.toContain("for 4 companies");
  });
});
