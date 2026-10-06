import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser } from "../campaigns/seed";

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  redirect: (href: string) => {
    throw new Error(`redirect ${href}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireUser: async () => {
      if (!auth.user) throw new Error("redirect /login");
      return auth.user;
    },
  };
});

const t = await createTestDb("wizard-new-campaign");
const { db, dbWrite } = await import("@/server/db");
const { createDraftAction } = await import("@/app/(app)/campaigns/new/actions");
const { default: NewCampaignPage } = await import("@/app/(app)/campaigns/new/page");

let member: TestUser;
let listId: number;

beforeAll(async () => {
  const u = await makeUser("Ali");
  member = { id: u.id, email: u.email, name: u.name, role: "MEMBER", timeZone: "Asia/Karachi", sessionId: 1 };
  const a = await makeCompany({ name: "List One", people: [{ name: "Anna", email: "anna@list-one.de" }] });
  const b = await makeCompany({ name: "List Two", people: [{ name: "Ben", email: "ben@list-two.de" }] });
  const list = await dbWrite((c) => c.list.create({ data: { name: "Germany Q4" } }));
  await dbWrite((c) => c.companyList.createMany({ data: [a.company.id, b.company.id].map((companyId) => ({ companyId, listId: list.id })) }));
  listId = list.id;
});

beforeEach(() => {
  auth.user = member;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function renderPage(search: Record<string, string>): Promise<string> {
  const el = await NewCampaignPage({ params: Promise.resolve({}), searchParams: Promise.resolve(search) } as never);
  return renderToStaticMarkup(el);
}

describe("starting a campaign (SEC-4: nothing changes on GET)", () => {
  it("opening /campaigns/new only asks; it never creates a draft", async () => {
    const before = await db.campaign.count();
    const blank = await renderPage({});
    expect(blank).toContain("Start a new campaign?");
    expect(blank).toContain("Start the campaign");
    expect(blank).toContain("It starts empty");
    const withList = await renderPage({ list: String(listId) });
    expect(withList).toContain("every company in the list Germany Q4");
    const gone = await renderPage({ list: "999999" });
    expect(gone).toContain("That list doesn&#x27;t exist any more");
    expect(await db.campaign.count()).toBe(before);
  });

  it("the button's Server Action starts a blank draft, or one with every company in a list", async () => {
    const blank = await createDraftAction({});
    expect(blank.ok).toBe(true);
    if (!blank.ok) return;
    expect(blank.data.href).toBe(`/campaigns/${blank.data.id}/setup/audience`);
    const c = await db.campaign.findUniqueOrThrow({ where: { id: blank.data.id } });
    expect(c).toMatchObject({ status: "DRAFT", createdById: member.id, senderId: member.id });

    const fromList = await createDraftAction({ listId });
    expect(fromList.ok).toBe(true);
    if (!fromList.ok) return;
    const listed = await db.campaign.findUniqueOrThrow({ where: { id: fromList.data.id } });
    expect(listed.name).toBe("Germany Q4");
    expect(await db.campaignRecipient.count({ where: { campaignId: fromList.data.id } })).toBe(2);

    // A double click reuses the draft instead of making a second one.
    const again = await createDraftAction({ listId });
    expect(again.ok && again.data.id).toBe(fromList.data.id);

    const missing = await createDraftAction({ listId: 999_999 });
    expect(missing.ok && missing.data.href).toMatch(/\/setup\/audience\?notice=list-gone$/);
  });

  it("checks who is signed in and what came in", async () => {
    const bad = await createDraftAction({ listId: -3 });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/Open the list on Contacts and try again/);

    auth.user = null;
    const before = await db.campaign.count();
    const out = await createDraftAction({});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/session has ended/);
    expect(await db.campaign.count()).toBe(before);
  });
});
