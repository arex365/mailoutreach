import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The Schedule step's go-live facts (M6-DESIGN §2.7, G11): `loadLaunchSummary` says whether go-live is on and whether
 * the draft was made before it; the launch action hands the step's tick (`confirmMadeBeforeGoLive`) through the draft
 * service to the engine (which refuses a LIVE launch of such a draft without it). The engine is replaced here by a
 * recorder: this file checks only what the wizard passes on.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
const engine = vi.hoisted(() => ({ calls: [] as Array<{ campaignId: number; opts: Record<string, unknown> }> }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
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
  return { AuthError, getUserOrNull: async () => auth.user, requireUserAction, requireOwnerAction: requireUserAction };
});
vi.mock("@/server/services/campaigns/launch", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/campaigns/launch")>();
  return {
    ...orig,
    launchCampaign: async (campaignId: number, _actorId: number, opts: Record<string, unknown> = {}) => {
      engine.calls.push({ campaignId, opts });
      return {
        campaignId,
        status: "RUNNING" as const,
        mode: "LIVE" as const,
        startAt: new Date(),
        queued: 1,
        rechecking: 0,
        newlyExcluded: 0,
        excludedReasons: [],
        excludedTotal: 0,
        lost: [],
        message: "Launched.",
      };
    },
  };
});

const t = await createTestDb("go-live-launch-summary");
const { db, dbWrite } = await import("@/server/db");
const { loadLaunchSummary, launchDraft } = await import("@/server/services/campaigns/draft");
const { launchAction } = await import("@/app/(app)/campaigns/[id]/setup/actions");

let owner: { id: number; name: string; email: string };
let draftId = 0;

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER" });
  const { company, people } = await makeCompany({ name: "Studio Nord", domain: "nord.example", people: [{ name: "Ola", email: "ola@nord.example" }] });
  const draft = await makeDraft({ name: "Made early", createdById: owner.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
  draftId = draft.id;
  // The draft was made yesterday.
  await dbWrite((c) => c.campaign.update({ where: { id: draftId }, data: { createdAt: new Date(Date.now() - 86_400_000) } }));
});

beforeEach(async () => {
  auth.user = { id: owner.id, email: owner.email, name: owner.name, role: "OWNER", timeZone: "Europe/Berlin", sessionId: 1 };
  engine.calls = [];
  await setSettingValue("sending.goLive", false);
  await setSettingValue("sending.goLiveAt", null);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("loadLaunchSummary and go-live", () => {
  it("before go-live: not live, not 'made before go-live'", async () => {
    expect(await loadLaunchSummary(draftId)).toMatchObject({ goLive: false, madeBeforeGoLive: false });
  });

  it("after go-live: a draft older than go-live is 'made before go-live', a newer one isn't", async () => {
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", new Date(Date.now() - 3_600_000).toISOString());
    expect(await loadLaunchSummary(draftId)).toMatchObject({ goLive: true, madeBeforeGoLive: true });
    await setSettingValue("sending.goLiveAt", new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(await loadLaunchSummary(draftId)).toMatchObject({ goLive: true, madeBeforeGoLive: false });
  });

  it("a go-live time without go-live (ended by a domain change) makes no draft 'made before go-live'", async () => {
    await setSettingValue("sending.goLiveAt", new Date(Date.now() - 3_600_000).toISOString());
    expect(await loadLaunchSummary(draftId)).toMatchObject({ goLive: false, madeBeforeGoLive: false });
  });
});

describe("the launch hands the tick on", () => {
  it("launchDraft passes confirmMadeBeforeGoLive to the engine only when given", async () => {
    await launchDraft({ id: owner.id, name: owner.name }, draftId, { confirmMadeBeforeGoLive: true });
    await launchDraft({ id: owner.id, name: owner.name }, draftId, {});
    expect(engine.calls.map((c) => c.opts.confirmMadeBeforeGoLive)).toEqual([true, undefined]);
  });

  it("launchAction passes the Schedule step's tick", async () => {
    expect(await launchAction({ campaignId: draftId, confirmMadeBeforeGoLive: true })).toMatchObject({ ok: true });
    expect(await launchAction({ campaignId: draftId })).toMatchObject({ ok: true });
    expect(engine.calls.map((c) => c.opts.confirmMadeBeforeGoLive)).toEqual([true, undefined]);
  });
});
