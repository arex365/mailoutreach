/**
 * Shared set-up for the Milestone 3 sending-engine tests (M3-DESIGN §8 P3): a fake Mailgun, a sender with a sending
 * address and a working reply route, a green domain checklist, the reply test passed, a test list, and helpers to
 * launch a campaign and run ticks of the sending loop with a fixed clock. Call createTestDb() first; every helper
 * imports the server modules lazily.
 *
 * Nothing here ever reaches a real Mailgun host: connectFakeMailgun points OUTREACH_MAILGUN_BASE_URL at the local fake.
 */
import type { ChecklistRow, ChecklistRowKey } from "@/core/system-state";
import type { RenderedEmail } from "@/core/templates/types";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

/** Wednesday 23 Sep 2026, 10:00 in Berlin (08:00 UTC): inside the default sending window. */
export const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");

/** A clock the tests move by hand. */
export type TestClock = { now: () => Date; set: (d: Date) => void; advance: (ms: number) => Date };

export function makeClock(start: Date = WEDNESDAY_10_BERLIN): TestClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d: Date) => {
      t = d.getTime();
    },
    advance: (ms: number) => {
      t += ms;
      return new Date(t);
    },
  };
}

/** A test clock that the fake Mailgun shares (its events and Logs windows follow the same time). */
export function worldClock(world: { mg: FakeConnection }, start: Date = WEDNESDAY_10_BERLIN): TestClock {
  const clock = makeClock(start);
  world.mg.fake.setNow(clock.now);
  return clock;
}

/** The renderer stub: the stored email carries Mailgun's unsubscribe placeholder, as real sends do. */
export const render = async (args: { recipientId: number; step: number }): Promise<RenderedEmail> => ({
  subject: `Hello ${args.recipientId}`,
  text: `Hi there\n\n--\nPolygon Paradise\nIf you'd rather not hear from us, unsubscribe here: %unsubscribe_url%`,
  html: `<p>Hi there</p><p>--<br>Polygon Paradise<br><a href="%unsubscribe_url%">%unsubscribe_url%</a></p>`,
  warnings: [],
});

export const GREEN_ROWS: ChecklistRowKey[] = [
  "mailgun-domain",
  "spf",
  "dkim",
  "mx",
  "tracking-cname",
  "https-links",
  "dmarc",
  "tracking-off",
  "unsubscribe",
  "spam-filter",
  "retention",
  "signing-key",
  "webhooks",
  "reply-routes",
  "sending-allowed",
  "remote-access",
];

export function checklistRows(overrides: Partial<Record<ChecklistRowKey, ChecklistRow["status"]>> = {}): ChecklistRow[] {
  return GREEN_ROWS.map((key) => ({
    key,
    group: "settings",
    status: overrides[key] ?? "ok",
    title: key,
    text: "",
    fix: null,
    records: [],
    detail: null,
  }));
}

export type M3World = {
  mg: FakeConnection;
  owner: { id: number; name: string };
  member: { id: number; name: string };
  senderAddress: string;
  /** Fresh Mailgun context loader with no retry waits and a short timeout (2 s). */
  mailgun: () => Promise<import("@/server/mailgun/context").MailgunContextResult>;
};

/**
 * Connects the fake Mailgun and makes everything "ready for live": the Owner (Arslan) and a Member (Ali), each with
 * a sending address whose reply route works, the domain checklist green, Setup A passed on this domain, mode LIVE,
 * go-live off, and the given test list.
 */
export async function setupM3(opts: { testList?: string[]; memberName?: string } = {}): Promise<M3World> {
  const mg = await connectFakeMailgun({ domain: "send.example.com" });
  const { dbWrite } = await import("@/server/db");
  const { setState } = await import("@/server/state");
  const { getMailgunContext } = await import("@/server/mailgun/context");
  const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  const member = await makeUser(opts.memberName ?? "Ali", { email: "ali@polygonparadise.test" });
  for (const [u, local] of [
    [owner, "arslan"],
    [member, "ali"],
  ] as const) {
    await dbWrite((c) =>
      c.senderAddress.create({
        data: { userId: u.id, domainId: mg.domainId, localPart: local, address: `${local}@${mg.domain}`, routeStatus: "ok" },
      }),
    );
  }
  await setState("domain.check", { domain: mg.domain, region: "EU", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows: checklistRows(), error: null });
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: owner.id,
    note: null,
  });
  await setSettingValue("sending.testList", opts.testList ?? []);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("practice.copy", false);
  return {
    mg,
    owner: { id: owner.id, name: owner.name },
    member: { id: member.id, name: member.name },
    senderAddress: `ali@${mg.domain}`,
    mailgun: () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 }),
  };
}

let seq = 0;

/**
 * A launched campaign in the current Setting "sending.mode" to one person per address (each at its own company),
 * sent by `senderId`, started at `now`.
 */
export async function launchTo(
  world: M3World,
  addresses: string[],
  opts: {
    now: Date;
    senderId?: number;
    name?: string;
    steps?: StepSeed[];
    ignoreWindow?: boolean;
    timeZone?: string | null;
    sameCompany?: boolean;
  },
): Promise<{ campaignId: number; companyIds: number[]; personIds: number[] }> {
  const { dbWrite } = await import("@/server/db");
  const { launchCampaign } = await import("@/server/services/campaigns/launch");
  seq += 1;
  const recipients: Array<{ companyId: number; personId: number }> = [];
  const companyIds: number[] = [];
  if (opts.sameCompany) {
    const { company, people } = await makeCompany({
      name: `Shared ${seq}`,
      people: addresses.map((email, i) => ({ name: `Person ${i}`, email })),
    });
    companyIds.push(company.id);
    for (const p of people) recipients.push({ companyId: company.id, personId: p.id });
  } else {
    const { db } = await import("@/server/db");
    for (const [i, email] of addresses.entries()) {
      // The same test mailbox in several campaigns is the same person (Person.emailNorm is unique).
      const existing = await db.person.findUnique({ where: { emailNorm: email.toLowerCase() }, select: { id: true, companyId: true } });
      if (existing) {
        companyIds.push(existing.companyId);
        recipients.push({ companyId: existing.companyId, personId: existing.id });
        continue;
      }
      const { company, people } = await makeCompany({ name: `M3 ${seq}-${i}`, people: [{ name: `Person ${i}`, email }] });
      companyIds.push(company.id);
      recipients.push({ companyId: company.id, personId: people[0]!.id });
    }
  }
  if (opts.timeZone !== undefined) {
    await dbWrite((c) => c.company.updateMany({ where: { id: { in: companyIds } }, data: { timeZone: opts.timeZone } }));
  }
  const draft = await makeDraft({
    name: opts.name ?? `M3 campaign ${seq}`,
    createdById: world.owner.id,
    senderId: opts.senderId ?? world.member.id,
    steps: opts.steps,
    recipients,
  });
  await launchCampaign(draft.id, world.owner.id, { now: opts.now, mailgun: world.mailgun, ignoreWindow: opts.ignoreWindow });
  return { campaignId: draft.id, companyIds, personIds: recipients.map((r) => r.personId) };
}

/** The loop's dependencies for a test tick: the fixed clock, the render stub, the fake Mailgun, a fixed random. */
export function tickDeps(world: M3World, clock: TestClock, extra: Record<string, unknown> = {}) {
  return { now: clock.now, render, mailgun: world.mailgun, random: () => 0.5, ...extra };
}

/** Lets the next gated email go straight away (the pacer's gap and any Mailgun back-off are forgotten). */
export async function clearPacer(): Promise<void> {
  const { dbWrite } = await import("@/server/db");
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pacer" } }));
}

/** Clears everything a test may have left behind that would block the next one (pause, pacer, restore). */
export async function resetSendingState(): Promise<void> {
  const { dbWrite } = await import("@/server/db");
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({
      where: { key: { in: ["sending.pause", "sending.pacer", "sending.day", "restore", "health.baseline", "notices", "mailgun.catchUp", "warmup"] } },
    });
    await c.campaign.updateMany({ where: { status: { in: ["RUNNING", "SCHEDULED", "PAUSED"] } }, data: { status: "CANCELLED" } });
    await c.outboundEmail.updateMany({ where: { status: { in: ["QUEUED", "SENDING", "UNKNOWN", "UNCONFIRMED"] } }, data: { status: "CANCELLED" } });
    await c.mailEvent.updateMany({ where: { processedAt: null }, data: { processedAt: new Date() } });
    await c.inboundMessage.updateMany({ where: { processedAt: null }, data: { processedAt: new Date() } });
  });
}
