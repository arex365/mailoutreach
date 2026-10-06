import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser } from "../campaigns/seed";
import type { OutageHoldSummary } from "@/server/services/sequences/holds";

/**
 * Settings › Sending & Mailgun after the PC was off (M4-DESIGN §2.8.3, §9.9): the four outage lines of the "Check with
 * Mailgun" card (found and not held yet, held with one row per sender, nothing held any more, replies recovered without
 * their text), the "Continue Ali's follow-ups" rows, and continueFollowUpsAction (Owner only).
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }) }));
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
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});

const t = await createTestDb("sequences-settings-sending");
const { db, dbWrite } = await import("@/server/db");
const { buildOutageView } = await import("@/app/(app)/settings/sending/load");
const { continueFollowUpsAction } = await import("@/app/(app)/settings/sending/actions");
const { OutageLines } = await import("@/components/settings/sending/check-with-mailgun");

const ZONE = "Europe/Berlin";
const NOW = new Date("2026-10-10T10:00:00Z");
const ctx = { zone: ZONE, now: NOW, logRetentionDays: 5 };
const recent = { detectedAt: "2026-10-09T08:00:00.000Z" };

function summary(over: Partial<OutageHoldSummary> = {}): OutageHoldSummary {
  return {
    detected: true,
    applied: true,
    from: "2026-10-03T06:00:00.000Z",
    to: "2026-10-09T06:00:00.000Z",
    total: 0,
    textOnly: false,
    bySender: [],
    ...over,
  };
}

let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: ZONE, sessionId: 1 };
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali"));
});

beforeEach(() => {
  auth.user = owner;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the outage lines (§9.9)", () => {
  it("found, hold not applied yet (amber)", () => {
    expect(buildOutageView(summary({ applied: false }), recent, ctx)).toEqual({
      tone: "warning",
      line: "The PC was off for more than 5 days, so the app can't be sure it saw every reply. Follow-ups are waiting while the app puts them on hold.",
      senders: [],
      colleagues: null,
    });
  });

  it("held, people still held: one row per sender, switched-off senders named so, and the colleagues' line", () => {
    const view = buildOutageView(
      summary({
        total: 16,
        bySender: [
          { userId: 2, name: "Ali", active: true, held: 8, firstEmailsWaiting: 3 },
          { userId: 3, name: "Sara", active: false, held: 3, firstEmailsWaiting: 1 },
          { userId: null, name: "Unknown sender", active: false, held: 1, firstEmailsWaiting: 0 },
          { userId: 4, name: "Omar", active: true, held: 0, firstEmailsWaiting: 0 },
        ],
      }),
      recent,
      ctx,
    )!;
    expect(view.tone).toBe("warning");
    // SPEC-03: the dates are the replies that may have been missed, not the PC's off-time.
    expect(view.line).toBe(
      "Replies from 3 Oct to 9 Oct may have been missed while the PC was off. Follow-ups of 12 people are on hold until their sender has checked their inbox:",
    );
    expect(view.senders.map((s) => s.label)).toEqual(["Ali · 8 people", "Sara (switched off) · 3 people", "Campaigns whose sender account is gone · 1 person"]);
    expect(view.senders[0]).toEqual({
      senderId: 2,
      label: "Ali · 8 people",
      buttonLabel: "Continue Ali's follow-ups",
      dialogTitle: "Continue Ali's follow-ups?",
      dialogText:
        "Only do this after Ali has looked through their inbox for replies that arrived from 3 Oct to 9 Oct. Anyone who replied must not get a follow-up.",
    });
    expect(view.colleagues).toBe("First emails to 4 other people at those companies continue once everyone who emailed their company has checked.");
    const html = renderToStaticMarkup(createElement(OutageLines, { view }));
    expect(html).toContain("Continue Ali&#x27;s follow-ups");
    expect(html).toContain("Sara (switched off) · 3 people");
    expect(html).toContain("First emails to 4 other people");
    expect(html).not.toMatch(/\bbg-(primary|brand)\b/);
  });

  it("held and nobody left, or nothing held: a neutral line for 7 days after it was found", () => {
    expect(buildOutageView(summary(), recent, ctx)).toEqual({
      tone: "neutral",
      line: "Replies from 3 Oct to 9 Oct may have been missed while the PC was off. No follow-ups are on hold now.",
      senders: [],
      colleagues: null,
    });
    expect(buildOutageView(summary(), { detectedAt: "2026-09-30T08:00:00.000Z" }, ctx)).toBeNull();
    expect(buildOutageView(summary({ detected: false, from: null, to: null }), recent, ctx)).toBeNull();
  });

  it("only Mailgun's message retention was passed: the replies recovered without their text", () => {
    expect(buildOutageView(summary({ textOnly: true, from: null, to: null }), recent, ctx)).toEqual({
      tone: "neutral",
      line: "Some replies were recovered without their text, because the PC was off longer than Mailgun keeps received messages. They're on Replies waiting for an answer as possible replies.",
      senders: [],
      colleagues: null,
    });
    expect(buildOutageView(summary({ textOnly: true, from: null, to: null }), { detectedAt: "2026-09-01T00:00:00.000Z" }, ctx)).toBeNull();
  });

  it("dates follow the viewer's zone", () => {
    const view = buildOutageView(summary({ applied: true, total: 1, bySender: [{ userId: 2, name: "Ali", active: true, held: 1, firstEmailsWaiting: 0 }] }), recent, {
      ...ctx,
      zone: "America/Los_Angeles",
    })!;
    expect(view.line).toMatch(/^Replies from 2 Oct to 8 Oct may have been missed /);
  });
});

describe("continueFollowUpsAction (Owner only)", () => {
  async function heldFor(senderId: number, people: number, colleagues = 0) {
    const { company, people: ps } = await makeCompany({
      name: `Held for ${senderId}-${Math.random().toString(36).slice(2, 7)}`,
      people: Array.from({ length: people + colleagues }, (_, i) => ({ name: `P${i}` })),
    });
    const d = await makeDraft({
      name: "Live held",
      createdById: owner.id,
      senderId,
      recipients: ps.map((p) => ({ companyId: company.id, personId: p.id })),
    });
    await dbWrite(async (c) => {
      await c.campaign.update({ where: { id: d.id }, data: { status: "RUNNING", mode: "LIVE" } });
      const rs = await c.campaignRecipient.findMany({ where: { campaignId: d.id }, orderBy: { id: "asc" } });
      for (const [i, r] of rs.entries()) {
        await c.campaignRecipient.update({
          where: { id: r.id },
          data: { state: "HELD", holdReason: "outage", heldAt: NOW, currentStep: i < people ? 1 : 0 },
        });
      }
    });
    return d.id;
  }

  it("refuses a Member and changes nothing", async () => {
    const id = await heldFor(member.id, 2);
    auth.user = member;
    expect(await continueFollowUpsAction({ senderId: member.id })).toEqual({ ok: false, error: "Only the Owner can do this." });
    expect(await db.campaignRecipient.count({ where: { campaignId: id, state: "HELD" } })).toBe(2);
  });

  it("the Owner continues a sender's follow-ups (and colleagues' first emails with nothing left to wait for)", async () => {
    const id = await heldFor(member.id, 2, 1);
    const res = await continueFollowUpsAction({ senderId: member.id });
    expect(res).toMatchObject({ ok: true, message: "Follow-ups of 4 people continue. First emails to 1 other person continue too." });
    expect(await db.campaignRecipient.count({ where: { campaignId: id, state: "HELD" } })).toBe(0);
    expect(await db.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { id: "asc" }, select: { state: true, holdReason: true } })).toEqual([
      { state: "WAITING", holdReason: null },
      { state: "WAITING", holdReason: null },
      { state: "SCHEDULED", holdReason: null },
    ]);
    // Nothing left: the plain sentence.
    expect(await continueFollowUpsAction({ senderId: member.id })).toEqual({ ok: false, error: "Nothing is on hold for Ali." });
  });
});
