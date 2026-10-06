/**
 * Test data for the campaign, rules and sending integration tests. Call createTestDb() first:
 * every helper imports the database lazily.
 */
import type { CompanyStatus, Priority, SendMode, SendStatus, VerificationStatus } from "@/generated/prisma/client";

const DAY = 86_400_000;
export const daysAgo = (d: number, now = new Date()) => new Date(now.getTime() - d * DAY);

async function write() {
  return (await import("@/server/db")).dbWrite;
}

export async function makeUser(name: string, opts: { role?: "OWNER" | "MEMBER"; email?: string; senderDisplayName?: string | null } = {}) {
  const dbWrite = await write();
  const email = opts.email ?? `${name.toLowerCase().replace(/\s+/g, ".")}@polygonparadise.test`;
  return dbWrite((c) =>
    c.user.create({
      data: { name, email, role: opts.role ?? "MEMBER", senderDisplayName: opts.senderDisplayName ?? `${name} from Polygon Paradise` },
    }),
  );
}

export type PersonSeed = {
  name?: string;
  email?: string | null;
  isGeneric?: boolean;
  verificationStatus?: VerificationStatus | null;
  verifiedAt?: Date | null;
  unsubscribedAt?: Date | null;
  deletedAt?: Date | null;
};

export async function makeCompany(opts: {
  name: string;
  domain?: string | null;
  status?: CompanyStatus;
  priority?: Priority;
  importedLastContactAt?: Date | null;
  deletedAt?: Date | null;
  people?: PersonSeed[];
}) {
  const dbWrite = await write();
  const rank = opts.priority === "HIGH" ? 1 : opts.priority === "LOW" ? 3 : 2;
  const company = await dbWrite((c) =>
    c.company.create({
      data: {
        name: opts.name,
        nameNorm: opts.name.toLowerCase(),
        domain: opts.domain === undefined ? `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.de` : opts.domain,
        website: opts.domain ? `https://${opts.domain}` : null,
        status: opts.status ?? "NOT_CONTACTED",
        priority: opts.priority ?? "NORMAL",
        priorityRank: rank,
        importedLastContactAt: opts.importedLastContactAt ?? null,
        lastContactAt: opts.importedLastContactAt ?? null,
        deletedAt: opts.deletedAt ?? null,
      },
    }),
  );
  const people = [];
  for (const [i, p] of (opts.people ?? []).entries()) {
    const email = p.email === undefined ? `person${i + 1}@${company.domain ?? "example.org"}` : p.email;
    people.push(
      await dbWrite((c) =>
        c.person.create({
          data: {
            companyId: company.id,
            name: p.name ?? `Person ${i + 1}`,
            email,
            emailNorm: email ? email.toLowerCase() : null,
            isGeneric: p.isGeneric ?? false,
            verificationStatus: p.verificationStatus ?? null,
            verifiedAt: p.verifiedAt ?? null,
            unsubscribedAt: p.unsubscribedAt ?? null,
            deletedAt: p.deletedAt ?? null,
            createdAt: new Date(Date.now() + i),
          },
        }),
      ),
    );
  }
  // Like the app's own writes: search (Contacts, the campaign pages, the wizard's recipient picker)
  // looks through Company.searchText, which covers the name, domain and every person.
  const { refreshCompanySearchText } = await import("@/server/company-search");
  await dbWrite((c) => refreshCompanySearchText(c, [company.id]));
  return { company, people };
}

export type StepSeed = { step: number; subject?: string | null; body?: string; delayDays?: number; enabled?: boolean };

export const DEFAULT_STEPS: StepSeed[] = [{ step: 0, subject: "3D models for {{company}}", body: "Hi {{first_name|there}}, …" }];

/** A draft campaign with steps and recipients (included by default). */
export async function makeDraft(opts: {
  name: string;
  createdById: number;
  senderId?: number | null;
  steps?: StepSeed[];
  recipients?: Array<{ companyId: number; personId: number; emailNorm?: string; included?: boolean; warnings?: object }>;
  daysAsMinutes?: boolean;
  startAt?: Date | null;
}) {
  const dbWrite = await write();
  const { db } = await import("@/server/db");
  const campaign = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: opts.name,
        createdById: opts.createdById,
        senderId: opts.senderId === undefined ? opts.createdById : opts.senderId,
        daysAsMinutes: opts.daysAsMinutes ?? false,
        startAt: opts.startAt ?? null,
        steps: {
          create: (opts.steps ?? DEFAULT_STEPS).map((s) => ({
            step: s.step,
            subject: s.subject === undefined ? (s.step === 0 ? "Subject" : null) : s.subject,
            body: s.body ?? `Body of step ${s.step}`,
            delayDays: s.delayDays ?? (s.step === 0 ? 0 : 3),
            enabled: s.enabled ?? true,
          })),
        },
      },
    }),
  );
  for (const r of opts.recipients ?? []) {
    const person = await db.person.findUniqueOrThrow({ where: { id: r.personId } });
    await dbWrite((c) =>
      c.campaignRecipient.create({
        data: {
          campaignId: campaign.id,
          companyId: r.companyId,
          personId: r.personId,
          emailNorm: r.emailNorm ?? person.emailNorm ?? `none-${r.personId}`,
          included: r.included ?? true,
          warnings: r.warnings,
        },
      }),
    );
  }
  return campaign;
}

let seq = 0;

/**
 * A campaign (any status) with one already-sent (or other status) email, for history tests. A new campaign records its
 * launch flag as a launch would (M6-DESIGN §2.2): `launchedGoLive` when given, else Setting "sending.goLive" now, so
 * set go-live first when its live sends should count as "emailed".
 */
export async function makeSentEmail(opts: {
  campaignName?: string;
  campaignId?: number;
  createdById: number;
  senderId?: number;
  mode?: SendMode;
  status?: SendStatus;
  companyId: number;
  personId: number;
  toNorm: string;
  companyDomain?: string | null;
  sentAt: Date;
  step?: number;
  campaignStatus?: "RUNNING" | "FINISHED" | "PAUSED";
  /** The new campaign's `launchedGoLive`; default: Setting "sending.goLive" now. */
  launchedGoLive?: boolean;
}) {
  const dbWrite = await write();
  const { getSetting } = await import("@/server/settings");
  const launchedGoLive = opts.campaignId === undefined ? (opts.launchedGoLive ?? (await getSetting("sending.goLive")) === true) : undefined;
  const campaignId =
    opts.campaignId ??
    (
      await dbWrite((c) =>
        c.campaign.create({
          data: {
            name: opts.campaignName ?? "Old campaign",
            createdById: opts.createdById,
            senderId: opts.senderId ?? opts.createdById,
            status: opts.campaignStatus ?? "RUNNING",
            mode: opts.mode ?? "LIVE",
            launchedGoLive,
          },
        }),
      )
    ).id;
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({
      data: { campaignId, companyId: opts.companyId, personId: opts.personId, emailNorm: opts.toNorm, state: "FINISHED" },
    }),
  );
  seq += 1;
  const status = opts.status ?? "SENT";
  const email = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId,
        recipientId: recipient.id,
        personId: opts.personId,
        companyId: opts.companyId,
        senderId: opts.senderId ?? opts.createdById,
        step: opts.step ?? 0,
        mode: opts.mode ?? "LIVE",
        toEmail: opts.toNorm,
        toNorm: opts.toNorm,
        companyDomain: opts.companyDomain ?? null,
        companyName: "Snapshot",
        fromAddress: "Ali <ali@your-sending-domain>",
        subject: "s",
        text: "t",
        html: "h",
        messageId: `pp.seed${seq}.${Date.now()}@dry-run.invalid`,
        sendId: `seed-${seq}-${Date.now()}`,
        dueAt: opts.sentAt,
        status,
        sentAt: status === "SENT" ? opts.sentAt : null,
        claimedAt: status === "QUEUED" ? null : opts.sentAt,
      },
    }),
  );
  return { campaignId, recipientId: recipient.id, email };
}

export async function setSettingValue(key: string, value: unknown) {
  const dbWrite = await write();
  await dbWrite((c) =>
    c.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }),
  );
}
