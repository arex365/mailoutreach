import type { AiActor } from "@/server/services/ai/review";

/**
 * Seeding for the AI services tests (docs/dev/M5-DESIGN.md §8 P5). Every function imports the server modules when it
 * runs, so a test file can import this helper before `createTestDb()` has pointed DATABASE_URL at its own database.
 */

export type SeedUser = { id: number; name: string; role: "OWNER" | "MEMBER" };

export async function seedUsers(): Promise<{ owner: SeedUser; ali: SeedUser; sara: SeedUser }> {
  const { dbWrite } = await import("@/server/db");
  const make = (email: string, name: string, role: "OWNER" | "MEMBER") =>
    dbWrite((c) => c.user.create({ data: { email, name, role, timeZone: "Europe/Berlin" }, select: { id: true, name: true, role: true } }));
  const owner = await make("arslan@example.com", "Arslan", "OWNER");
  const ali = await make("ali@example.com", "Ali", "MEMBER");
  const sara = await make("sara@example.com", "Sara", "MEMBER");
  return { owner, ali, sara };
}

export function actorOf(u: SeedUser): AiActor {
  return { id: u.id, name: u.name, role: u.role };
}

export type CompanyInput = {
  name: string;
  website?: string | null;
  instagram?: string | null;
  personalLine?: string | null;
  personalLineSource?: string | null;
  personalLineUpdatedById?: number | null;
  personalLineUpdatedAt?: Date | null;
  country?: string | null;
  niche?: string | null;
  domain?: string | null;
  deletedAt?: Date | null;
};

export async function makeCompany(input: CompanyInput): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const row = await dbWrite((c) =>
    c.company.create({
      data: {
        name: input.name,
        nameNorm: input.name.toLowerCase(),
        website: input.website ?? null,
        instagram: input.instagram ?? null,
        personalLine: input.personalLine ?? null,
        personalLineSource: input.personalLineSource ?? (input.personalLine ? "manual" : null),
        personalLineUpdatedById: input.personalLineUpdatedById ?? null,
        personalLineUpdatedAt: input.personalLineUpdatedAt ?? null,
        country: input.country ?? null,
        niche: input.niche ?? null,
        domain: input.domain ?? null,
        deletedAt: input.deletedAt ?? null,
      },
      select: { id: true },
    }),
  );
  return row.id;
}

export type DraftInput = {
  companyId: number;
  jobId?: number | null;
  status?: "QUEUED" | "FETCHING" | "DRAFTING" | "READY" | "NO_LINE" | "FAILED" | "APPROVED" | "REJECTED";
  model?: string;
  line?: string | null;
  finalLine?: string | null;
  evidenceQuote?: string | null;
  evidenceSource?: string | null;
  evidenceUrl?: string | null;
  reasonIfNull?: string | null;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  calls?: number;
  draftedAt?: Date | null;
  readAttempts?: number;
  reviewAction?: string | null;
  reviewedById?: number | null;
  reviewedAt?: Date | null;
  homeSnapshotId?: number | null;
  pageSnapshotId?: number | null;
  flags?: Array<{ code: string; text: string }>;
  createdAt?: Date;
  requestId?: string | null;
};

export async function makeDraft(input: DraftInput): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const row = await dbWrite((c) =>
    c.aiDraft.create({
      data: {
        companyId: input.companyId,
        jobId: input.jobId ?? null,
        model: input.model ?? "claude-haiku-4-5-20251001",
        promptVersion: "pl-2026-09-26",
        status: input.status ?? "QUEUED",
        line: input.line ?? null,
        finalLine: input.finalLine ?? null,
        evidenceQuote: input.evidenceQuote ?? null,
        evidenceSource: input.evidenceSource ?? null,
        evidenceUrl: input.evidenceUrl ?? null,
        reasonIfNull: input.reasonIfNull ?? null,
        error: input.error ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        costUsd: input.costUsd ?? null,
        calls: input.calls ?? 0,
        draftedAt: input.draftedAt ?? null,
        readAttempts: input.readAttempts ?? 0,
        reviewAction: input.reviewAction ?? null,
        reviewedById: input.reviewedById ?? null,
        reviewedAt: input.reviewedAt ?? null,
        homeSnapshotId: input.homeSnapshotId ?? null,
        pageSnapshotId: input.pageSnapshotId ?? null,
        flags: input.flags ?? undefined,
        requestId: input.requestId ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
      select: { id: true },
    }),
  );
  return row.id;
}

/** An `ai.draftLines` job row in the given state (the runner is not involved). */
export async function makeAiJob(status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED" = "RUNNING", opts: { createdById?: number | null; runAt?: Date; result?: object } = {}): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const row = await dbWrite((c) =>
    c.job.create({
      data: {
        type: "ai.draftLines",
        status,
        payload: { source: "contacts", companyCount: 0, aboutUsd: 0, atMostUsd: 0, model: "claude-haiku-4-5-20251001" },
        createdById: opts.createdById ?? null,
        runAt: opts.runAt ?? new Date(),
        ...(opts.result ? { result: opts.result } : {}),
      },
      select: { id: true },
    }),
  );
  return row.id;
}

/** Saves the Anthropic key (a test key; nothing calls Anthropic in these tests). */
export async function saveAnthropicKey(userId: number): Promise<void> {
  const { setSecret } = await import("@/server/secrets");
  await setSecret("anthropic.apiKey", "sk-ant-fake-key-0000000000", userId);
}
