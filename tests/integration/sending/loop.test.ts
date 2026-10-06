import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

// The templates work package implements the real renderer; the loop is tested against its signature.
const render = vi.hoisted(() => ({
  fail: false,
  calls: [] as Array<{ recipientId: number; step: number; purpose: string }>,
  /** Runs while the email is claimed ("Sending"), before rendering: something a teammate does meanwhile. */
  during: null as null | ((args: { recipientId: number }) => Promise<void>),
}));
vi.mock("@/server/services/render", () => ({
  renderCampaignEmail: async (args: { recipientId: number; step: number; purpose: string }) => {
    render.calls.push({ recipientId: args.recipientId, step: args.step, purpose: args.purpose });
    if (render.during) await render.during({ recipientId: args.recipientId });
    if (render.fail) throw new Error("The template has a problem.");
    return {
      subject: `Subject for ${args.recipientId}`,
      text: `Text for ${args.recipientId}`,
      html: `<p>Text for ${args.recipientId}</p>`,
      warnings: [],
    };
  },
  renderTemplatePreview: async () => {
    throw new Error("not used");
  },
}));

const t = await createTestDb("sending-loop");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { cancelCampaign, pauseCampaign, resumeCampaign, skipRecipient } = await import("@/server/services/campaigns/control");
const { getCampaignOverview } = await import("@/server/services/campaigns/queries");
const { CAMPAIGN_CANCELLED_MESSAGE, claimEmail, resetStuckDryRunSends } = await import("@/server/services/sending/claim");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const { DEFAULT_WINDOW } = await import("@/core/sending/window");
const { SendingLoop } = await import("../../../worker/sending");

let arslan: { id: number };
let ali: { id: number };
let n = 0;

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER" });
  ali = await makeUser("Ali");
});

beforeEach(async () => {
  render.fail = false;
  render.calls = [];
  render.during = null;
  await setSettingValue("practice.copy", false);
  // Leave nothing due from earlier tests.
  await dbWrite((c) => c.campaign.updateMany({ where: { status: { in: ["RUNNING", "SCHEDULED"] } }, data: { status: "CANCELLED" } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function campaignWith(
  people: Array<{ priority?: "HIGH" | "NORMAL" | "LOW" }>,
  opts: { steps?: StepSeed[]; startAt?: Date; name?: string } = {},
) {
  n += 1;
  const recipients = [];
  const companies = [];
  for (const [i, p] of people.entries()) {
    const { company, people: ps } = await makeCompany({
      name: `Loop ${n}-${i}`,
      priority: p.priority,
      people: [{ name: `Person ${i}`, email: `p${i}@loop${n}-${i}.de` }],
    });
    companies.push(company);
    recipients.push({ companyId: company.id, personId: ps[0]!.id });
  }
  const draft = await makeDraft({ name: opts.name ?? `Loop campaign ${n}`, createdById: arslan.id, senderId: ali.id, steps: opts.steps, recipients });
  const res = await launchCampaign(draft.id, arslan.id, { startAt: opts.startAt });
  return { campaignId: draft.id, companies, launch: res };
}

describe("the sending loop", () => {
  it("sends due first emails to the dry-run outbox, finishes the campaign and tells the sender and creator", async () => {
    const { campaignId } = await campaignWith([{}, {}], { name: "Germany Q4" });
    const r = await loop.sendingTick();
    expect(r).toMatchObject({ picked: 2, sent: 2, skipped: 0, retried: 0, failed: 0, finished: [campaignId] });
    const rows = await db.outboundEmail.findMany({ where: { campaignId } });
    for (const row of rows) {
      expect(row.status).toBe("SENT");
      expect(row.subject).toBe(`Subject for ${row.recipientId}`);
      expect(row.text).toBe(`Text for ${row.recipientId}`);
      expect(row.providerId).toBe(`dry-run:${row.messageId}`);
      expect(row.sentAt).not.toBeNull();
    }
    expect(render.calls.every((c) => c.purpose === "send" && c.step === 0)).toBe(true);
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("FINISHED");
    expect(campaign.finishedAt).not.toBeNull();
    const notes = await db.notification.findMany({ where: { type: "campaign.finished", link: `/campaigns/${campaignId}` }, orderBy: { userId: "asc" } });
    expect(notes.map((x) => [x.userId, x.title, x.body])).toEqual([
      [arslan.id, "Germany Q4 finished", "2 emails went to the dry-run outbox."],
      [ali.id, "Germany Q4 finished", "2 emails went to the dry-run outbox."],
    ]);
    // Nothing more to do.
    expect((await loop.sendingTick()).picked).toBe(0);
  });

  it("sends High priority companies first, then the oldest due", async () => {
    const { campaignId, companies } = await campaignWith([{ priority: "LOW" }, { priority: "NORMAL" }, { priority: "HIGH" }]);
    // Milestone 3: dry runs with "Ignore sending hours" (the default) are the ungated candidates, ordered as before.
    const { ungated, gated } = await gates.pickCandidates(new Date(), { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin" });
    expect(gated).toEqual([]);
    expect(ungated.map((c) => c.companyId)).toEqual([companies[2]!.id, companies[1]!.id, companies[0]!.id]);
    expect(ungated.every((c) => c.campaignId === campaignId)).toBe(true);
    expect("pickDueEmails" in loop).toBe(false);
  });

  it("waits for a scheduled start, then promotes the campaign and sends", async () => {
    const start = new Date(Date.now() + 60 * 60_000);
    const { campaignId } = await campaignWith([{}], { startAt: start });
    expect((await loop.sendingTick()).sent).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("SCHEDULED");
    const later = new Date(start.getTime() + 1_000);
    const r = await loop.sendingTick({ now: () => later });
    expect(r).toMatchObject({ promoted: 1, sent: 1 });
  });

  it("sends the follow-up when it is due, in the same thread, and then finishes (Milestone 4)", async () => {
    const { campaignId } = await campaignWith([{}], {
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 0 },
      ],
    });
    expect((await loop.sendingTick()).sent).toBe(1);
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
    const followUp = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } });
    expect(followUp).toMatchObject({ status: "QUEUED", inReplyTo: first.messageId, references: first.messageId });
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).state).toBe("WAITING");
    const r = await loop.sendingTick({ now: () => new Date(Date.now() + 60_000) });
    expect(r).toMatchObject({ picked: 1, sent: 1, finished: [campaignId] });
    expect(render.calls.map((c) => c.step)).toEqual([0, 1]);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: followUp.id } })).toMatchObject({ status: "SENT" });
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).state).toBe("FINISHED");
  });

  it("sends follow-ups before first emails in the ungated batch (B6.6)", async () => {
    const early = await campaignWith([{}], {
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 0 },
      ],
    });
    expect((await loop.sendingTick()).sent).toBe(1);
    const later = await campaignWith([{ priority: "HIGH" }]);
    const { ungated } = await gates.pickCandidates(new Date(Date.now() + 60_000), { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin" });
    expect(ungated.map((c) => [c.campaignId, c.step])).toEqual([
      [early.campaignId, 1],
      [later.campaignId, 0],
    ]);
  });

  it("skips someone who can't be emailed any more, with the reason", async () => {
    const { campaignId } = await campaignWith([{}, {}]);
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId }, orderBy: { id: "asc" } });
    await dbWrite((c) => c.person.update({ where: { id: rec.personId }, data: { unsubscribedAt: new Date() } }));
    const r = await loop.sendingTick();
    expect(r).toMatchObject({ sent: 1, skipped: 1, finished: [campaignId] });
    const skipped = await db.outboundEmail.findFirstOrThrow({ where: { recipientId: rec.id } });
    expect(skipped).toMatchObject({ status: "SKIPPED", lastError: "Unsubscribed", subject: "" });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    const note = await db.notification.findFirstOrThrow({ where: { userId: ali.id, type: "campaign.finished", link: `/campaigns/${campaignId}` } });
    expect(note.body).toBe("1 email went to the dry-run outbox. 1 email was skipped.");
    expect(await db.activityLog.count({ where: { campaignId, type: "email.skipped", mode: "DRY_RUN" } })).toBe(1);
  });

  it("puts an email back in the queue when it can't be prepared, and gives up after 5 tries", async () => {
    const { campaignId } = await campaignWith([{}]);
    render.fail = true;
    const r = await loop.sendingTick();
    expect(r).toMatchObject({ sent: 0, retried: 1 });
    let row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "Couldn't prepare this email: The template has a problem." });
    expect(row.dueAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    // Not due again straight away.
    expect((await loop.sendingTick()).picked).toBe(0);

    for (let i = 2; i <= 5; i++) {
      await dbWrite((c) => c.outboundEmail.update({ where: { id: row.id }, data: { dueAt: new Date(Date.now() - 1_000) } }));
      await loop.sendingTick();
    }
    row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(row).toMatchObject({ status: "FAILED", attempts: 5 });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({ state: "STOPPED", stopReason: "failed" });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
  });

  it("doesn't send for a paused campaign, and carries on after resume", async () => {
    const { campaignId } = await campaignWith([{}]);
    await pauseCampaign(campaignId, arslan.id);
    expect((await loop.sendingTick()).picked).toBe(0);
    await resumeCampaign(campaignId, arslan.id);
    expect((await loop.sendingTick()).sent).toBe(1);
  });

  it("claims nothing without the lease, and stops between emails when asked", async () => {
    const { campaignId } = await campaignWith([{}, {}]);
    const noLease = await loop.sendingTick({ ownsLease: async () => false });
    expect(noLease).toMatchObject({ stopped: true, sent: 0 });
    const aborted = new AbortController();
    aborted.abort();
    expect(await loop.sendingTick({ signal: aborted.signal })).toMatchObject({ stopped: true, picked: 0 });
    let calls = 0;
    const r = await loop.sendingTick({ ownsLease: async () => ++calls <= 2 });
    expect(r).toMatchObject({ sent: 1, stopped: true });
    expect(await db.outboundEmail.count({ where: { campaignId, status: "QUEUED" } })).toBe(1);
  });

  it("in the practice copy, counts as real contact and holds the company", async () => {
    await setSettingValue("practice.copy", true);
    const { campaignId, companies } = await campaignWith([{}]);
    expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(1);
    expect((await loop.sendingTick()).sent).toBe(1);
    const c = await db.company.findUniqueOrThrow({ where: { id: companies[0]!.id } });
    expect(c).toMatchObject({ status: "CONTACTED", lastEmailedById: ali.id, firstContactedById: ali.id });
    expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(0);
  });

  it("the worker's loop runs maintenance and ticks, and waits for the email in hand", async () => {
    const { campaignId } = await campaignWith([{}]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const worker = new SendingLoop({ ownsLease: async () => true, logger });
    const r = await worker.tick(new AbortController().signal);
    expect(r?.sent).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^Sending: 1 sent, campaign #\d+ finished$/));
    expect(await worker.waitForIdle(100)).toBe(true);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");

    // run() stops as soon as its signal is aborted (shutdown or lease lost).
    const stop = new AbortController();
    const running = worker.run(stop.signal);
    stop.abort();
    const started = Date.now();
    await running;
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("emails put back in the queue after something changed", () => {
  it("never sends to someone who was skipped while their email was claimed, even after a restart put it back", async () => {
    await setSettingValue("practice.copy", true);
    const { campaignId, companies } = await campaignWith([{}]);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    // The worker claimed the email and then stopped (power cut): it stays "Sending".
    expect(await claimEmail(row.id, new Date(Date.now() - 5 * 60_000))).toBe(true);
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    expect((await skipRecipient(rec.id, ali.id)).sendingNow).toBe(true);
    // Hours later the worker starts again and puts the email back in the queue.
    expect(await resetStuckDryRunSends(new Date())).toBe(1);

    const r = await loop.sendingTick();
    expect(r).toMatchObject({ sent: 0, skipped: 1, finished: [campaignId] });
    expect(render.calls).toHaveLength(0);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Skipped by Ali",
      subject: "",
    });
    // The person keeps the stop reason they were given; nothing counts as contact.
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({
      state: "STOPPED",
      stopReason: "Skipped by Ali",
    });
    expect(await db.company.findUniqueOrThrow({ where: { id: companies[0]!.id } })).toMatchObject({
      status: "NOT_CONTACTED",
      lastEmailedAt: null,
    });
    expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(0);
    expect(await db.activityLog.count({ where: { campaignId, type: "email.sent" } })).toBe(0);
    const log = await db.activityLog.findFirstOrThrow({ where: { campaignId, type: "email.skipped" } });
    expect(log.summary).toMatch(/^First email to p0@loop\d+-0\.de skipped by Ali$/);
  });

  it("a skip that lands while the email is being prepared also stops its next try", async () => {
    const { campaignId } = await campaignWith([{}]);
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    render.fail = true;
    render.during = async () => {
      await skipRecipient(rec.id, ali.id);
    };
    expect(await loop.sendingTick()).toMatchObject({ sent: 0, retried: 1 });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(row.status).toBe("QUEUED");

    render.fail = false;
    render.during = null;
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await loop.sendingTick({ now: () => later })).toMatchObject({ sent: 0, skipped: 1, finished: [campaignId] });
    expect(render.calls).toHaveLength(1);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SKIPPED", lastError: "Skipped by Ali" });
  });

  it("an email being prepared when its campaign is cancelled is cancelled too, not put back", async () => {
    const { campaignId } = await campaignWith([{}]);
    render.fail = true;
    render.during = async () => {
      await cancelCampaign(campaignId, arslan.id);
    };
    expect(await loop.sendingTick()).toMatchObject({ sent: 0, retried: 0, failed: 0 });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_CANCELLED_MESSAGE,
      claimedAt: null,
    });
    expect((await getCampaignOverview(campaignId))!.emailsWaiting).toBe(0);
  });

  it("an email of a cancelled campaign that got back in the queue is cancelled, by the loop or the maintenance", async () => {
    const a = await campaignWith([{}]);
    const b = await campaignWith([{}]);
    await cancelCampaign(a.campaignId, arslan.id);
    await cancelCampaign(b.campaignId, arslan.id);
    const rowA = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: a.campaignId } });
    const rowB = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: b.campaignId } });
    // As an older version could leave them: back in the queue after the cancel.
    await dbWrite((c) => c.outboundEmail.updateMany({ where: { id: { in: [rowA.id, rowB.id] } }, data: { status: "QUEUED" } }));
    expect((await getCampaignOverview(b.campaignId))!.emailsWaiting).toBe(1);

    expect(await loop.sendOneEmail(rowA.id)).toBe("not-running");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: rowA.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_CANCELLED_MESSAGE,
    });
    const m = await loop.runSendingMaintenance(new Date());
    expect(m.cancelled).toBeGreaterThanOrEqual(1);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: rowB.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: CAMPAIGN_CANCELLED_MESSAGE,
    });
    expect((await getCampaignOverview(b.campaignId))!.emailsWaiting).toBe(0);
    expect(render.calls).toHaveLength(0);
  });

  it("words why a finished, stopped or left-out person's email isn't sent", () => {
    expect(loop.closedRecipientMessage("STOPPED", "Skipped by Sara.")).toBe("Skipped by Sara");
    expect(loop.closedRecipientMessage("STOPPED", "replied")).toBe("This person's emails were stopped");
    expect(loop.closedRecipientMessage("STOPPED", null)).toBe("This person's emails were stopped");
    expect(loop.closedRecipientMessage("FINISHED", null)).toBe("All of this person's emails were already sent");
    expect(loop.closedRecipientMessage("EXCLUDED", "Unsubscribed")).toBe("This person was left out of the campaign");
  });

  it("an email of a paused campaign goes back in the queue as it was", async () => {
    const { campaignId } = await campaignWith([{}]);
    await pauseCampaign(campaignId, arslan.id);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect(await loop.sendOneEmail(row.id)).toBe("not-running");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "QUEUED", attempts: 0, claimedAt: null });
  });
});

describe("maintenance", () => {
  it("resets stuck dry-run sends and finishes campaigns with nothing left", async () => {
    const { campaignId } = await campaignWith([{}]);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: row.id }, data: { status: "SENDING", claimedAt: new Date(Date.now() - 5 * 60_000) } }));
    const m = await loop.runSendingMaintenance(new Date());
    expect(m.reset).toBe(1);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("QUEUED");
    expect((await loop.sendingTick()).sent).toBe(1);

    // A running campaign whose last email was skipped by hand elsewhere gets finished by the sweep.
    const other = await campaignWith([{}]);
    await dbWrite((c) => c.outboundEmail.updateMany({ where: { campaignId: other.campaignId }, data: { status: "CANCELLED" } }));
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: other.campaignId }, data: { state: "STOPPED" } }));
    expect((await loop.runSendingMaintenance(new Date())).finished).toEqual([other.campaignId]);
  });

  it("retry delays grow: 1, 5, 15, 60 minutes", () => {
    expect([1, 2, 3, 4, 5].map((a) => loop.sendRetryDelayMs(a) / 60_000)).toEqual([1, 5, 15, 60, 60]);
  });
});
