/**
 * Seeding and the signed-in user for the AI screens' tests (docs/dev/M5-DESIGN.md §8 P9). The drafts, companies and
 * jobs come from the AI services' helpers (tests/integration/ai-services/seed.ts); this adds the session users the
 * Server Actions see and a few rows those helpers don't make. Every function imports server modules when it runs, so a
 * test file can import this before createTestDb().
 */
export { makeAiJob, makeCompany, makeDraft } from "../ai-services/seed";

/** The session user as `requireUserAction()` returns it. */
export type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };

/** The Owner (Arslan) and two Members (Ali, Sara), as session users. */
export async function seedSessionUsers(): Promise<{ owner: TestUser; ali: TestUser; sara: TestUser }> {
  const { dbWrite } = await import("@/server/db");
  const make = async (email: string, name: string, role: "OWNER" | "MEMBER"): Promise<TestUser> => {
    const u = await dbWrite((c) => c.user.create({ data: { email, name, role, timeZone: "Europe/Berlin" } }));
    return { id: u.id, email: u.email, name: u.name, role, timeZone: "Europe/Berlin", sessionId: 1 };
  };
  return {
    owner: await make("arslan@example.com", "Arslan", "OWNER"),
    ali: await make("ali@example.com", "Ali", "MEMBER"),
    sara: await make("sara@example.com", "Sara", "MEMBER"),
  };
}

/** Saves a test key as the Anthropic key (nothing calls Anthropic with it unless a test connects the fake Claude). */
export async function saveTestAnthropicKey(userId: number | null, key = "sk-ant-fake-key-0000000000"): Promise<void> {
  const { setSecret } = await import("@/server/secrets");
  await setSecret("anthropic.apiKey", key, userId);
}

/** A job of another type (the Stop buttons must never touch it). */
export async function makeOtherJob(type: "backup.run" | "mailgun.catchUp", status: "QUEUED" | "RUNNING" = "QUEUED"): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const row = await dbWrite((c) => c.job.create({ data: { type, status, payload: {}, runAt: new Date() }, select: { id: true } }));
  return row.id;
}

/** A company list with these companies. */
export async function makeList(name: string, companyIds: number[]): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const list = await dbWrite((c) => c.list.create({ data: { name }, select: { id: true } }));
  await dbWrite((c) => c.companyList.createMany({ data: companyIds.map((companyId) => ({ listId: list.id, companyId })) }));
  return list.id;
}
