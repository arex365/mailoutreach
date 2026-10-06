import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { runCheckJob } from "../check-screens/check-job";

/**
 * The company panel's address checks (M5-DESIGN §6.5) on a temp database with the fake Mailgun: `lastCheck` and the
 * sequences' `recheckAt` from getCompanyDetail, the Check button (hidden without an email, off within 24 hours of a
 * real check), the toast of each one-address outcome (incl. a `temp…` throwaway, a refusal with Details, a skipped
 * suppressed address), the reason line, the "Did you mean" flow (changes the address and clears the check), the
 * checked date for the fake Mailgun in fake mode, the RECHECK sequence text, and the personal line's `draftState`.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/contacts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/dal", () => {
  const user = async () => {
    if (!auth.user) throw new Error("signed out");
    return auth.user;
  };
  return { requireUser: user, requireOwner: user, requireUserAction: user, requireOwnerAction: user, getUserOrNull: async () => auth.user };
});

const t = await createTestDb("company-panel-checks");
const { db, dbWrite } = await import("@/server/db");
const detail = await import("@/server/services/companies/detail");
const { CompanyPanel } = await import("@/components/company-panel/company-panel");
const { PersonalLineSection } = await import("@/components/company-panel/personal-line");
const { emailedSummary, pickSequence } = await import("@/components/company-panel/emailed-text");
const { checkPersonAction, checkRunViewAction } = await import("@/app/(app)/contacts/check-actions");
const { updatePersonAction } = await import("@/components/company-panel/actions");
const { panelCheckToast } = await import("@/components/checks/panel-check");
const { dateAtTimeText } = await import("@/components/checks/run-text");

const TZ = "Asia/Karachi";
const html = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

let mg: FakeConnection;
let user: TestUser;

async function company(name: string, emails: Array<string | null>) {
  const c = await dbWrite((x) => x.company.create({ data: { name, nameNorm: name.toLowerCase(), domain: `${name.toLowerCase().replace(/\W+/g, "")}.test` } }));
  const people = [];
  for (const [i, email] of emails.entries()) {
    people.push(
      await dbWrite((x) =>
        x.person.create({ data: { companyId: c.id, name: `Person ${i + 1}`, email, emailNorm: email ? email.toLowerCase() : null, createdAt: new Date(Date.now() + i) } }),
      ),
    );
  }
  return { company: c, people };
}

/** The panel's check of one person, run to the end by the stand-in check job; the finished run's view. */
async function checkPerson(personId: number) {
  const res = await checkPersonAction({ personId });
  if (!res.ok) throw new Error(res.error);
  await runCheckJob(res.data.jobId);
  const view = await checkRunViewAction({ jobId: res.data.jobId });
  if (!view.ok) throw new Error(view.error);
  return view.data;
}

async function renderPanel(companyId: number): Promise<string> {
  const el = await CompanyPanel({ companyId, user });
  return html(renderToStaticMarkup(createElement(TooltipProvider, null, el)));
}

/** Finds the first element of a component in a server component's returned tree. */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

beforeAll(async () => {
  mg = await connectFakeMailgun();
  const u = await dbWrite((c) => c.user.create({ data: { name: "Arslan", email: "arslan@pp.test", role: "OWNER" } }));
  user = { id: u.id, email: u.email, name: u.name, role: "OWNER", timeZone: TZ, sessionId: 1 };
  auth.user = user;
});

beforeEach(async () => {
  await dbWrite((c) => c.setting.upsert({ where: { key: "practice.copy" }, create: { key: "practice.copy", value: false }, update: { value: false } }));
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("checking a person from the panel", () => {
  it("gives the last check's reasons and did-you-mean, and turns Check off for 24 hours", async () => {
    const c = await company("Yaho Studio", ["anna@yaho.test", null]);
    const before = await renderPanel(c.company.id);
    expect(before).toContain('aria-label="Check anna@yaho.test"');
    // No email: no Check button for that person.
    expect(before.match(/aria-label="Check /g)).toHaveLength(1);

    const view = await checkPerson(c.people[0]!.id);
    expect(view.single).toMatchObject({ outcome: "checked", status: "INVALID", decision: "undeliverable" });
    expect(panelCheckToast("anna@yaho.test", view).text).toBe("anna@yaho.test doesn't exist. It's on the do-not-email list now.");

    const d = (await detail.getCompanyDetail(c.company.id))!;
    expect(d.people[0]!.lastCheck).toEqual({
      reasons: ["no_mx"],
      didYouMean: "anna@yahoo.test",
      isRole: false,
      checkedByRealProvider: true,
      checkedWithin24h: true,
    });
    expect(d.people[1]!.lastCheck).toBeNull();

    const after = await renderPanel(c.company.id);
    expect(after).toContain("anna@yaho.test was checked today already.");
    expect(after).toContain('aria-disabled="true"');
    expect(after).toContain("This domain can't receive email.");
    expect(after).toContain("Did you mean anna@yahoo.test?");
    // The fake Mailgun's results count in fake mode: no "by the test checker".
    expect(after).toMatch(/checked \d{1,2} [A-Z][a-z]{2,3}</);
    expect(after).not.toContain("by the test checker");
    // A day later the button is back.
    const tomorrow = (await detail.getCompanyDetail(c.company.id, { now: new Date(Date.now() + 25 * 3_600_000) }))!;
    expect(tomorrow.people[0]!.lastCheck?.checkedWithin24h).toBe(false);
  });

  it("changes the address with Did you mean, which clears the check", async () => {
    const c = await company("Yaho Two", ["ben@yaho.test"]);
    await checkPerson(c.people[0]!.id);
    const d = (await detail.getCompanyDetail(c.company.id))!;
    const suggestion = d.people[0]!.lastCheck!.didYouMean!;
    expect(suggestion).toBe("ben@yahoo.test");
    const res = await updatePersonAction({ personId: c.people[0]!.id, name: "Person 1", email: suggestion, role: "" });
    expect(res).toMatchObject({ ok: true, message: "Saved. The new address needs checking again." });
    const person = await db.person.findUniqueOrThrow({ where: { id: c.people[0]!.id } });
    expect(person).toMatchObject({ email: "ben@yahoo.test", verificationStatus: null, verifiedAt: null, verificationUnknowns: 0 });
    const after = (await detail.getCompanyDetail(c.company.id))!;
    expect(after.people[0]!.lastCheck).toBeNull();
    const out = await renderPanel(c.company.id);
    expect(out).not.toContain("Did you mean");
    expect(out).toContain('aria-label="Check ben@yahoo.test"');
  });

  it("toasts a throwaway address, a refusal with Details, and a suppressed address that wasn't checked", async () => {
    const c = await company("Toast Co", ["temp1@valid.test", "refused@valid.test", "gone@valid.test"]);
    const temp = await checkPerson(c.people[0]!.id);
    expect(panelCheckToast("temp1@valid.test", temp)).toEqual({
      tone: "info",
      text: "temp1@valid.test is a throwaway address. Your check settings skip it.",
      detail: null,
    });

    mg.fake.setValidation("refused@valid.test", { status: 400, body: { message: "refused@valid.test can't be validated" } });
    const refused = await checkPerson(c.people[1]!.id);
    const toast = panelCheckToast("refused@valid.test", refused);
    expect(toast).toMatchObject({ tone: "error", text: "Mailgun couldn't check refused@valid.test." });
    // Mailgun's words behind Details, without the address.
    expect(toast.detail).toContain("can't be validated");
    expect(toast.detail).not.toContain("refused@valid.test");

    await dbWrite((x) => x.suppression.create({ data: { emailNorm: "gone@valid.test", reason: "MANUAL", source: "manual" } }));
    const skipped = await checkPerson(c.people[2]!.id);
    expect(panelCheckToast("gone@valid.test", skipped).text).toBe("gone@valid.test is on the do-not-email list, so it wasn't checked.");
  });

  it("uses the test checker in the practice copy, which never counts", async () => {
    await dbWrite((x) => x.setting.update({ where: { key: "practice.copy" }, data: { value: true } }));
    const c = await company("Practice Co", ["pia@valid.test"]);
    const view = await checkPerson(c.people[0]!.id);
    expect(view.single).toMatchObject({ outcome: "checked", status: "VALID" });
    const d = (await detail.getCompanyDetail(c.company.id))!;
    expect(d.people[0]!.verificationProvider).toBe("fake");
    // The test checker never counts: the button stays on, and the date says who checked it.
    expect(d.people[0]!.lastCheck).toMatchObject({ checkedByRealProvider: false, checkedWithin24h: false });
    expect(await renderPanel(c.company.id)).toContain("by the test checker");
  });
});

describe("RECHECK sequences and the personal line's draft state", () => {
  it("says when the second check is due, and whether a line is being drafted or waits for review", async () => {
    const c = await company("Recheck Co", ["rex@valid.test"]);
    const campaign = await dbWrite((x) =>
      x.campaign.create({ data: { name: "Germany Q4", mode: "LIVE", status: "RUNNING", createdById: user.id, senderId: user.id, launchedAt: new Date() } }),
    );
    const recheckAt = new Date(Date.now() + 24 * 3_600_000);
    await dbWrite((x) =>
      x.campaignRecipient.create({
        data: { campaignId: campaign.id, companyId: c.company.id, personId: c.people[0]!.id, emailNorm: "rex@valid.test", state: "RECHECK", recheckAt },
      }),
    );
    const d = (await detail.getCompanyDetail(c.company.id))!;
    expect(d.sequences[0]).toMatchObject({ state: "RECHECK", recheckAt });
    const text = emailedSummary(
      { lastEmailedAt: null, lastEmailedByName: null, lastEmailedCampaignName: null, lastEmailedStep: null, sequence: pickSequence(d.people[0]!.sequences) },
      TZ,
    ).text;
    expect(text).toBe(`Never emailed · waiting for re-check on ${dateAtTimeText(recheckAt, TZ)} (test list)`);
    expect(await renderPanel(c.company.id)).toContain(`waiting for re-check on ${dateAtTimeText(recheckAt, TZ)}`);

    const lineView = async () => {
      const el = await CompanyPanel({ companyId: c.company.id, user });
      return (findElement(el, PersonalLineSection)?.props.view as { draftState?: string | null } | undefined)?.draftState;
    };
    expect(await lineView()).toBeNull();
    const draft = await dbWrite((x) => x.aiDraft.create({ data: { companyId: c.company.id, model: "claude-haiku-4-5-20251001", promptVersion: "pl-2026-09-26", status: "DRAFTING" } }));
    expect(await lineView()).toBe("drafting");
    await dbWrite((x) => x.aiDraft.update({ where: { id: draft.id }, data: { status: "READY" } }));
    expect(await lineView()).toBe("waiting");
  });
});
