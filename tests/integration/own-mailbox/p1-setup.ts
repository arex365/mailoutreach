/**
 * Shared set-up for P1's own-mailbox sending tests (docs/dev/MAIN-DOMAIN-DESIGN.md §8 P1): the owner's shape against the
 * fake Mailgun on the Free plan whose domain's mail stays elsewhere (`receivesMail: false`), example.com standing for
 * polygonparadise.com. Mode own-mailbox, From contact@example.com, plan Free, nobody with a sending address, the
 * own-mailbox checklist green (stored for this mode), the by-hand reply test passed, a test list, mode LIVE, go-live off.
 * Call createTestDb() first; every helper imports the server modules lazily.
 *
 * Nothing here ever reaches a real Mailgun host: connectFakeMailgun points OUTREACH_MAILGUN_BASE_URL at the local fake.
 */
import type { ChecklistRow, ChecklistRowKey } from "@/core/system-state";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";
import type { M3World } from "../sending-m3/helpers";

export const DOMAIN = "example.com";
export const OWN = `contact@${DOMAIN}`;
export const ALI_LINE = `Ali from Polygon Paradise <${OWN}>`;

/** The rows own-mailbox mode builds (no mx, spam-filter, retention, reply-routes, from-spf), all "ok". */
export const OWN_ROWS: ChecklistRowKey[] = [
  "mailgun-domain",
  "spf",
  "dkim",
  "tracking-cname",
  "https-links",
  "dmarc",
  "from-mx",
  "tracking-off",
  "unsubscribe",
  "signing-key",
  "webhooks",
  "sending-allowed",
  "remote-access",
];

export function ownRows(overrides: Partial<Record<ChecklistRowKey, ChecklistRow["status"]>> = {}): ChecklistRow[] {
  return OWN_ROWS.map((key) => ({
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

/** Stores the domain check: own-mailbox rows by default, or rows stored for another mode (`replies`). */
export async function storeCheck(rows: ChecklistRow[] = ownRows(), replies: "own-mailbox" | "app" | null = "own-mailbox"): Promise<void> {
  const { setState } = await import("@/server/state");
  await setState("domain.check", {
    domain: DOMAIN,
    region: "US",
    checkedAt: new Date().toISOString(),
    lastVerifyAt: null,
    rows,
    error: null,
    ...(replies ? { replies } : {}),
  });
}

/** The by-hand reply test passed for example.com, the own From and own-mailbox mode (MAIN-DOMAIN-DESIGN O13). */
export async function passReplyTest(ownerId: number, over: Record<string, unknown> = {}): Promise<void> {
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: DOMAIN,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: ownerId,
    note: null,
    from: OWN,
    replies: "own-mailbox",
    ...over,
  });
}

/**
 * Connects the fake (Free plan, mail elsewhere) in own-mailbox mode with From contact@example.com and plan Free, and
 * makes everything ready for live: the Owner (Arslan) and a Member (Ali), neither with a sending address.
 */
export async function setupOwnMailbox(opts: { testList?: string[] } = {}): Promise<M3World> {
  const mg = await connectFakeMailgun({
    domain: DOMAIN,
    region: "US",
    replies: "own-mailbox",
    fromAddress: OWN,
    plan: "free",
    fake: { domain: DOMAIN, region: "US", plan: "free", receivesMail: false },
  });
  const { getMailgunContext } = await import("@/server/mailgun/context");
  const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  const member = await makeUser("Ali", { email: "ali@polygonparadise.test" });
  await storeCheck();
  await passReplyTest(owner.id);
  await setSettingValue("sending.testList", opts.testList ?? []);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("practice.copy", false);
  return {
    mg,
    owner: { id: owner.id, name: owner.name },
    member: { id: member.id, name: member.name },
    senderAddress: OWN,
    mailgun: () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 }),
  };
}

let seq = 0;

/**
 * A draft (not launched) to one person per address, each at their own company (a known address reuses its person),
 * sent by Ali. `daysAsMinutes`: follow-up delays in minutes (the test campaigns' switch).
 */
export async function draftTo(
  world: M3World,
  addresses: string[],
  opts: { steps?: StepSeed[]; daysAsMinutes?: boolean; name?: string } = {},
): Promise<{ draftId: number; companyIds: number[]; personIds: number[] }> {
  const { db } = await import("@/server/db");
  seq += 1;
  const recipients: Array<{ companyId: number; personId: number }> = [];
  for (const [i, email] of addresses.entries()) {
    const existing = await db.person.findUnique({ where: { emailNorm: email.toLowerCase() }, select: { id: true, companyId: true } });
    if (existing) {
      recipients.push({ companyId: existing.companyId, personId: existing.id });
      continue;
    }
    const { company, people } = await makeCompany({ name: `Own ${seq}-${i}`, people: [{ name: `Person ${i}`, email }] });
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({
    name: opts.name ?? `Own campaign ${seq}`,
    createdById: world.owner.id,
    senderId: world.member.id,
    steps: opts.steps,
    daysAsMinutes: opts.daysAsMinutes,
    recipients,
  });
  return { draftId: draft.id, companyIds: recipients.map((r) => r.companyId), personIds: recipients.map((r) => r.personId) };
}

/** A launched campaign (Setting "sending.mode" decides the mode) to one person per address. */
export async function launchOwn(
  world: M3World,
  addresses: string[],
  opts: { now: Date; steps?: StepSeed[]; daysAsMinutes?: boolean; ignoreWindow?: boolean },
): Promise<{ campaignId: number; companyIds: number[]; personIds: number[] }> {
  const { launchCampaign } = await import("@/server/services/campaigns/launch");
  const d = await draftTo(world, addresses, opts);
  await launchCampaign(d.draftId, world.owner.id, { now: opts.now, mailgun: world.mailgun, ignoreWindow: opts.ignoreWindow });
  return { campaignId: d.draftId, companyIds: d.companyIds, personIds: d.personIds };
}
