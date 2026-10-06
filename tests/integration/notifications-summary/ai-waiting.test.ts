import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * GET /api/notifications/summary gains `aiWaiting` (docs/dev/M5-DESIGN.md §6.7): how many AI lines wait for review,
 * which the bell hands to the sidebar's "AI lines" badge. Drafts of deleted companies and drafts replaced by a Try
 * again don't count; neither do drafts still being written or already reviewed.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
vi.mock("@/lib/auth/dal", () => ({ getUserOrNull: async () => auth.user }));

const t = await createTestDb("notifications-summary-ai");
const { db, dbWrite } = await import("@/server/db");
const { GET } = await import("@/app/api/notifications/summary/route");

let member: TestUser;

async function company(name: string, deleted = false): Promise<number> {
  const row = await dbWrite((c) =>
    c.company.create({ data: { name, nameNorm: name.toLowerCase(), website: "https://x.example", deletedAt: deleted ? new Date() : null } }),
  );
  return row.id;
}

async function draft(companyId: number, status: "QUEUED" | "READY" | "APPROVED" | "NO_LINE", reviewAction: string | null = null) {
  await dbWrite((c) =>
    c.aiDraft.create({ data: { companyId, model: "claude-haiku-4-5-20251001", promptVersion: "pl-2026-09-26", status, reviewAction } }),
  );
}

async function poll(): Promise<{ status: number; body: { aiWaiting?: number } }> {
  const res = await GET(new Request("http://localhost:3000/api/notifications/summary"));
  return { status: res.status, body: (await res.json()) as { aiWaiting?: number } };
}

beforeAll(async () => {
  const u = await dbWrite((c) => c.user.create({ data: { name: "Ali", email: "ali@pp.test", role: "MEMBER" } }));
  member = { id: u.id, email: u.email, name: u.name, role: "MEMBER", timeZone: "Europe/Berlin", sessionId: 1 };
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the summary's AI lines count", () => {
  it("is 0 with nothing to review", async () => {
    auth.user = member;
    const res = await poll();
    expect(res.status).toBe(200);
    expect(res.body.aiWaiting).toBe(0);
  });

  it("counts the lines waiting for review, for everyone (Members too)", async () => {
    const a = await company("A");
    const b = await company("B");
    const gone = await company("Gone", true);
    await draft(a, "READY");
    await draft(b, "READY");
    await draft(gone, "READY"); // a deleted company's draft isn't reviewable
    await draft(a, "QUEUED"); // still being written
    await draft(b, "APPROVED");
    await draft(b, "NO_LINE", "retried");
    auth.user = member;
    expect((await poll()).body.aiWaiting).toBe(2);
  });

  it("isn't given without a session", async () => {
    auth.user = null;
    const res = await poll();
    expect(res.status).toBe(401);
    expect(res.body.aiWaiting).toBeUndefined();
  });
});
