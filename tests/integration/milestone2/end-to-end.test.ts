import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * Milestone 2 end to end, across the four work packages and with nothing mocked:
 *   Contacts selection → draft seeded from the A7 master template (templates) → audience with the
 *   engine's rules (wizard + engine) → Review exactly as it will be sent (templates) → per-person
 *   edit (engine) → launch (wizard → engine) → the worker's sending loop with the REAL renderer
 *   (engine + templates) → dry-run outbox, campaign page, Contacts "Sequence" column and company
 *   panel (pages) → the 30-day rule for the next campaign.
 *
 * Milestone 3 update (M3-DESIGN §1.6): on real data a dry run still ignores sending hours by default (the wizard's
 * "Ignore sending hours" switch is on), so it goes out at once as in Milestone 2, whatever the time. In the practice
 * copy the switch is off by default: the dry run follows sending hours, pacing and the daily limit like a live one.
 * That part runs on a fixed clock inside sending hours (the latest weekday 10:00 in Berlin), so it passes at any hour.
 *
 * Milestone 4 update (M4-DESIGN §1.3, §7.1): the dry run's follow-ups go out to the outbox when due, in the same thread
 * ("Re: <the first subject>", In-Reply-To/References of the email before), and "Simulate a reply" in the outbox does
 * what a real reply would do in a dry run on real data: it stops only this campaign's emails to that company, with
 * "Dry run:" labels, and changes no status.
 */

const t = await createTestDb("m2-end-to-end");
const { db, dbWrite } = await import("@/server/db");
const draft = await import("@/server/services/campaigns/draft");
const audience = await import("@/server/services/campaigns/audience");
const render = await import("@/server/services/render");
const queries = await import("@/server/services/campaigns/queries");
const { getCompanyDetail } = await import("@/server/services/companies/detail");
const { listCompanies } = await import("@/server/services/companies/query");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { toContactRow } = await import("@/components/contacts/format");
const { campaignHref, companySequenceLabel } = await import("@/components/campaigns/format");
const { emailedSummary, pickSequence } = await import("@/components/company-panel/emailed-text");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
const { UNSUBSCRIBE_PLACEHOLDER, UNSUBSCRIBE_PREVIEW_TEXT } = await import("@/core/templates/html");
const { simulateReply } = await import("@/server/services/mail-events/simulate");
const { listWaitingReplies } = await import("@/server/services/replies/waiting");
const { waitingReplyCount } = await import("@/server/notifications");
const { SendingLoop } = await import("../../../worker/sending");

const TZ = "Asia/Karachi";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const MINUTE = 60_000;

let arslan: { id: number; name: string };
let ali: { id: number; name: string };
/** The real-data dry run of the first test, continued by the Milestone 4 test. */
const realRun = { campaignId: 0, annaId: 0, inboxId: 0, printwerkId: 0 };

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  ali = await makeUser("Ali Khan", { email: "ali.khan@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" });
  await dbWrite((c) =>
    c.user.update({ where: { id: ali.id }, data: { signature: "Ali Khan\nPolygon Paradise · print-ready 3D models" } }),
  );
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** One pass of the background sender's loop, exactly as the worker runs it (lease held), on the real or a fixed clock. */
async function workerTick(now?: () => Date) {
  const loop = new SendingLoop({ ownsLease: async () => true, logger: quiet, now, random: () => 0.5 });
  const r = await loop.tick(new AbortController().signal);
  expect(r).not.toBeNull();
  return r!;
}

/**
 * The latest weekday 10:00 in Berlin at or before `now`: inside the default sending hours (Monday to Friday,
 * 9:00–17:00 in each recipient's zone; a company without a zone uses Berlin), and never in the future, so the 30-day
 * rule still sees the send.
 */
function lastWeekdayMorningInBerlin(now = new Date()): Date {
  let day = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO("Europe/Berlin").toPlainDate();
  for (let i = 0; i < 8; i++, day = day.subtract({ days: 1 })) {
    if (day.dayOfWeek > 5) continue;
    const at = day.toZonedDateTime({ timeZone: "Europe/Berlin", plainTime: Temporal.PlainTime.from("10:00") });
    if (at.epochMilliseconds <= now.getTime()) return new Date(at.epochMilliseconds);
  }
  throw new Error("No weekday morning in the last week.");
}

/** The company panel's banner text, built the way company-panel.tsx builds it. */
function panelBanner(detail: NonNullable<Awaited<ReturnType<typeof getCompanyDetail>>>): string {
  return emailedSummary(
    {
      lastEmailedAt: detail.lastEmailedAt,
      lastEmailedByName: detail.lastEmailedBy?.name ?? null,
      lastEmailedCampaignName: detail.lastEmailedCampaignName,
      lastEmailedStep: detail.lastEmailedStep,
      importedLastContactAt: detail.importedLastContactAt,
      sequence: pickSequence(detail.sequences),
    },
    TZ,
  ).text;
}

async function recipientOf(campaignId: number, personId: number) {
  return db.campaignRecipient.findUniqueOrThrow({ where: { campaignId_personId: { campaignId, personId } } });
}

describe("Milestone 2 on real data: a dry run from a Contacts selection to the outbox", () => {
  it("sends exactly what Review showed, and leaves the companies untouched", async () => {
    const printwerk = await makeCompany({ name: "Printwerk", domain: "printwerk.de", people: [{ name: "Anna Schmidt", email: "anna@printwerk.de" }] });
    await dbWrite((c) => c.company.update({ where: { id: printwerk.company.id }, data: { personalLine: "Your dragon range is lovely." } }));
    const figuren = await makeCompany({
      name: "Figurenhaus",
      domain: "figurenhaus.de",
      people: [{ name: "General inbox", email: "info@figurenhaus.de", isGeneric: true }],
    });
    const client = await makeCompany({ name: "Clientco", domain: "clientco.de", status: "CLIENT", people: [{ name: "Cora", email: "cora@clientco.de" }] });
    const anna = printwerk.people[0]!;
    const inbox = figuren.people[0]!;

    // Contacts › "Email these companies": a draft seeded from the A7 master sequence (templates package).
    const d = await draft.createDraft(arslan, { companyIds: [printwerk.company.id, figuren.company.id, client.company.id], timeZone: TZ });
    const steps = await draft.getDraftSteps(d.id);
    expect(steps.map((s) => [s.step, s.enabled, s.delayDays])).toEqual(MASTER_SEQUENCE.steps.map((s) => [s.step, s.enabled, s.delayDays]));
    expect(steps[0]!.subject).toBe(MASTER_SEQUENCE.steps[0]!.subject);
    expect(await db.activityLog.count({ where: { type: "template.created", actorId: null } })).toBe(1);

    // Audience: the engine's rules decide (the Client company is excluded with its reason).
    const snap = await audience.loadAudienceSnapshot(d.id);
    const byName = new Map(snap.companies.map((c) => [c.name, c]));
    expect(byName.get("Printwerk")!.section).toBe("included");
    expect(byName.get("Figurenhaus")!.section).toBe("included");
    expect(byName.get("Clientco")!.section).toBe("excluded");
    expect(byName.get("Clientco")!.blockedReason).toMatch(/Client/);

    // Sender: Ali (the templates' {{sender_name}} and signature, the engine's From line).
    await draft.setDraftSender(arslan, d.id, ali.id);

    // Review: Anna gets her own subject (engine's RecipientEdit through the wizard).
    const annaRow = await recipientOf(d.id, anna.id);
    await draft.editDraftRecipientEmail(arslan, d.id, annaRow.id, 0, {
      subject: "A question for {{company}}",
      body: MASTER_SEQUENCE.steps[0]!.body,
    });
    const annaReview = await draft.loadReviewDetail(d.id, anna.id);
    expect(annaReview.renderError).toBeNull();
    expect(annaReview.emails.map((e) => e.step)).toEqual([0, 1, 2]); // follow-up 3 is switched off
    const annaFirst = annaReview.emails[0]!;
    expect(annaFirst.edited).toBe(true);
    expect(annaFirst.email.subject).toBe("A question for Printwerk");
    expect(annaFirst.email.text).toMatch(/^(Hi|Hello) Anna,\n\nYour dragon range is lovely\.\n\nI'm Ali Khan from Polygon Paradise\./);
    expect(annaFirst.email.text).toContain(`\nAli Khan\nPolygon Paradise · print-ready 3D models\n\n--\n`);
    expect(annaFirst.email.text).toContain(UNSUBSCRIBE_PREVIEW_TEXT);
    expect(annaReview.emails[1]!.email.subject).toBe("Re: A question for Printwerk");

    const inboxReview = await draft.loadReviewDetail(d.id, inbox.id);
    const inboxFirst = inboxReview.emails[0]!;
    // General inbox, no personal line: "there", and the empty line is gone.
    expect(inboxFirst.email.text).toMatch(/^(Hi|Hello) there,\n\nI'm Ali Khan from Polygon Paradise\./);
    expect(inboxFirst.email.warnings).toEqual([]);
    expect(["Print-ready 3D models for Figurenhaus", "3D models for Figurenhaus"]).toContain(inboxFirst.email.subject);

    // Launch (wizard → engine), then one round of the background sender with the real renderer.
    const launched = await draft.launchDraft(arslan, d.id);
    expect(launched).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 2 });
    expect(campaignHref({ id: d.id, status: "RUNNING", wizardStep: 6 })).toBe(`/campaigns/${d.id}`);
    // Real data: "Ignore sending hours" is on by default, so the dry run doesn't wait for sending hours (M2 behaviour).
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).ignoreWindow).toBe(true);

    const tick = await workerTick();
    expect(tick).toMatchObject({ picked: 2, sent: 2, skipped: 0, retried: 0, failed: 0 });

    // The dry-run outbox (pages) holds exactly what Review showed, apart from the unsubscribe link.
    const outbox = await queries.listOutbox({ campaignId: d.id });
    expect(outbox.rows.map((r) => r.toEmail).sort()).toEqual(["anna@printwerk.de", "info@figurenhaus.de"]);
    const annaSent = await queries.getOutboxEmail(outbox.rows.find((r) => r.toEmail === "anna@printwerk.de")!.id);
    expect(annaSent).not.toBeNull();
    expect(annaSent!.subject).toBe("A question for Printwerk");
    expect(annaSent!.text).toBe(annaFirst.email.text.replace(UNSUBSCRIBE_PREVIEW_TEXT, UNSUBSCRIBE_PLACEHOLDER));
    expect(annaSent!.fromAddress).toBe("Ali from Polygon Paradise <ali.khan@your-sending-domain>");
    expect(annaSent!.messageId).toMatch(/@dry-run\.invalid$/);
    const inboxSent = await queries.getOutboxEmail(outbox.rows.find((r) => r.toEmail === "info@figurenhaus.de")!.id);
    expect(inboxSent!.subject).toBe(inboxFirst.email.subject);
    expect(inboxSent!.text).toBe(inboxFirst.email.text.replace(UNSUBSCRIBE_PREVIEW_TEXT, UNSUBSCRIBE_PLACEHOLDER));

    // Follow-up 1 is prepared and threads under the subject Anna actually received.
    const annaAfter = await recipientOf(d.id, anna.id);
    expect(annaAfter).toMatchObject({ state: "WAITING", currentStep: 1 });
    const followUp = await render.renderCampaignEmail({ recipientId: annaAfter.id, step: 1, purpose: "send" });
    expect(followUp.subject).toBe("Re: A question for Printwerk");

    // Campaign page and list (pages): running, first emails all sent, follow-ups waiting.
    const overview = await queries.getCampaignOverview(d.id);
    expect(overview).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", countsAsReal: false, audience: 2 });
    expect(overview!.steps.find((s) => s.step === 0)).toMatchObject({ sent: 2 });
    expect(overview!.steps.find((s) => s.step === 1)).toMatchObject({ waiting: 2 });
    const running = await queries.listCampaigns("running");
    expect(running.items.find((c) => c.id === d.id)?.firstEmail).toEqual({ sent: 2, planned: 2 });

    // On real data a dry run doesn't touch the company…
    const pw = await db.company.findUniqueOrThrow({ where: { id: printwerk.company.id } });
    expect(pw).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null, firstContactedAt: null });
    expect(await db.activityLog.count({ where: { campaignId: d.id, type: "email.sent", mode: "DRY_RUN" } })).toBe(2);

    // …and Contacts' "Sequence" column and the company panel both say it's a dry run.
    const listed = await listCompanies(parseCompanyFilters({ sort: "created", dir: "desc", size: "200" }));
    const row = listed.rows.find((r) => r.id === printwerk.company.id)!;
    expect(toContactRow(row, { timeZone: TZ }).sequenceLabel).toMatch(/^Waiting for follow-up 1 on .+ \(dry run\)$/);
    const detail = await getCompanyDetail(printwerk.company.id);
    expect(detail!.sequences.map((s) => s.countsAsEmailed)).toEqual([false]);
    expect(panelBanner(detail!)).toMatch(/^Never emailed · waiting for follow-up 1 on .+ \(dry run\)$/);
    Object.assign(realRun, { campaignId: d.id, annaId: anna.id, inboxId: inbox.id, printwerkId: printwerk.company.id });
  });

  it("Milestone 4: sends the follow-ups in the same thread when due; a simulated reply stops only this campaign's emails to Anna", async () => {
    const { campaignId, annaId, inboxId, printwerkId } = realRun;
    expect(campaignId).toBeGreaterThan(0);
    const firsts = await db.outboundEmail.findMany({ where: { campaignId, step: 0 }, orderBy: { id: "asc" } });
    const due = await db.outboundEmail.findMany({ where: { campaignId, step: 1 }, orderBy: { id: "asc" } });
    expect(due.map((e) => e.status)).toEqual(["QUEUED", "QUEUED"]);
    // Nothing goes before its day (3 calendar days; the dry run ignores sending hours, so no shift).
    for (const f of due) {
      const first = firsts.find((e) => e.recipientId === f.recipientId)!;
      expect(f.dueAt.getTime() - first.sentAt!.getTime()).toBeGreaterThanOrEqual(3 * 24 * 60 * MINUTE - 60 * MINUTE);
    }
    const early = await workerTick(() => new Date(Math.min(...due.map((e) => e.dueAt.getTime())) - MINUTE));
    expect(early.sent).toBe(0);

    // When due, both follow-ups go to the outbox, threaded under the email before.
    const at = new Date(Math.max(...due.map((e) => e.dueAt.getTime())) + MINUTE);
    const tick = await workerTick(() => at);
    expect(tick).toMatchObject({ sent: 2, failed: 0 });
    const sent = await db.outboundEmail.findMany({ where: { campaignId, step: 1 }, orderBy: { id: "asc" } });
    for (const f of sent) {
      const first = firsts.find((e) => e.recipientId === f.recipientId)!;
      expect(f.status).toBe("SENT");
      expect(f.subject).toBe(`Re: ${first.subject}`);
      expect(f.inReplyTo).toBe(first.messageId);
      expect(f.references).toBe(first.messageId);
      expect(f.text).not.toMatch(/wrote:/); // no quoted original (A5.11)
    }
    const annaFollowUp = sent.find((e) => e.personId === annaId)!;
    expect((await recipientOf(campaignId, annaId)).currentStep).toBe(2);

    // Outbox › Simulate › Reply on Anna's follow-up: a dry run on real data stops only this campaign's emails to
    // Printwerk; the company's status doesn't change and the notification says "Dry run:".
    const res = await simulateReply(arslan, annaFollowUp.id, "reply", { now: at });
    expect(res.message).toBe(
      "Simulated a reply from anna@printwerk.de. In a dry run it only stops this campaign's emails to Printwerk; statuses don't change.",
    );
    const reply = await db.inboundMessage.findFirstOrThrow({ where: { source: "SIMULATED", outboundEmailId: annaFollowUp.id } });
    expect(reply).toMatchObject({ kind: "REPLY", replyScope: "campaign", changesStatus: false, linkMethod: "simulated", assigneeId: ali.id });
    expect(await recipientOf(campaignId, annaId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: reply.id });
    const annaNext = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, personId: annaId, step: 2 } });
    expect(annaNext).toMatchObject({ status: "SKIPPED", lastError: "Stopped: they replied" });
    // Figurenhaus goes on: its follow-up 2 waits for its day.
    expect(await recipientOf(campaignId, inboxId)).toMatchObject({ state: "WAITING", currentStep: 2 });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId, personId: inboxId, step: 2 } })).status).toBe("QUEUED");
    // Real data: the company and person keep their status and have no reply date.
    expect(await db.company.findUniqueOrThrow({ where: { id: printwerkId } })).toMatchObject({ status: "NOT_CONTACTED", repliedAt: null });
    expect((await db.person.findUniqueOrThrow({ where: { id: annaId } })).repliedAt).toBeNull();
    // Only the campaign's sender is told, with the dry-run label; the reply is listed but not counted in the bell's line.
    const notes = await db.notification.findMany({ where: { type: { startsWith: "reply." } } });
    expect(notes.map((n) => [n.userId, n.type, n.title])).toEqual([[ali.id, "reply.received", "Dry run: New reply from Printwerk"]]);
    const waiting = await listWaitingReplies({ id: ali.id, role: "MEMBER", timeZone: TZ }, { scope: "mine", now: at });
    expect(waiting.rows.map((r) => [r.id, r.label])).toEqual([[reply.id, "Dry run"]]);
    expect(await waitingReplyCount(ali.id)).toBe(0);
    // The timeline has the reply with its first lines; Contacts says who replied, still marked as a dry run.
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "reply.received", campaignId } });
    expect(activity).toMatchObject({ companyId: printwerkId, personId: annaId, mode: "DRY_RUN" });
    expect((activity.data as { snippet?: string }).snippet).toContain("Thanks, this sounds interesting.");
    const seqs = await queries.companySequences([printwerkId]);
    expect(companySequenceLabel(seqs.get(printwerkId)!, TZ)!.text).toBe("Stopped: they replied (dry run)");
    // A second click on the same button changes nothing.
    expect((await simulateReply(arslan, annaFollowUp.id, "reply", { now: at })).message).toBe("Already simulated.");
  });
});

describe("Milestone 2 in the practice copy: a first-email-only campaign finishes and counts as contact", () => {
  it("contacts the company, finishes the campaign, and the 30-day rule holds for the next one", async () => {
    await setSettingValue("practice.copy", true);
    const resin = await makeCompany({ name: "Resinworks", domain: "resinworks.de", people: [{ name: "Olaf Berg", email: "olaf@resinworks.de" }] });

    const d = await draft.createDraft(ali, { companyIds: [resin.company.id], timeZone: TZ });
    await draft.renameDraft(ali, d.id, "Practice run");
    const first = MASTER_SEQUENCE.steps[0]!;
    await draft.saveDraftSteps(ali, d.id, [{ step: 0, enabled: true, subject: first.subject, body: first.body, delayDays: 0 }]);
    const review = await draft.loadReviewDetail(d.id, resin.people[0]!.id);

    // The practice copy's default: the dry run follows sending hours and takes a pacing turn (M3-DESIGN §1.6).
    const at = lastWeekdayMorningInBerlin();
    const launched = await draft.launchDraft(ali, d.id, { now: at });
    expect(launched).toMatchObject({ status: "RUNNING", queued: 1 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).ignoreWindow).toBe(false);
    const tick = await workerTick(() => at);
    expect(tick.sent).toBe(1);
    expect(tick.finished).toEqual([d.id]);

    const sent = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.id, step: 0 } });
    expect(sent.status).toBe("SENT");
    expect(sent.subject).toBe(review.emails[0]!.email.subject);
    expect(sent.text).toBe(review.emails[0]!.email.text.replace(UNSUBSCRIBE_PREVIEW_TEXT, UNSUBSCRIBE_PLACEHOLDER));

    // Practice copy: a dry run is real contact (compare-and-set Not contacted → Contacted).
    const company = await db.company.findUniqueOrThrow({ where: { id: resin.company.id } });
    expect(company.status).toBe("CONTACTED");
    expect(company.lastEmailedAt).not.toBeNull();
    expect(company.firstContactedById).toBe(ali.id);

    // Finished: the campaign, its notification (Ali is creator and sender: one), the list tab.
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("FINISHED");
    const notes = await db.notification.findMany({ where: { type: "campaign.finished", link: `/campaigns/${d.id}` } });
    expect(notes.map((n) => [n.userId, n.title])).toEqual([[ali.id, "Practice run finished"]]);
    const finished = await queries.listCampaigns("finished");
    expect(finished.items.find((c) => c.id === d.id)?.progress).toEqual({ done: 1, total: 1 });

    // Contacts column and company panel agree: no "(dry run)" in the practice copy.
    const seqs = await queries.companySequences([resin.company.id]);
    expect(companySequenceLabel(seqs.get(resin.company.id)!, TZ)!.text).toBe("Finished");
    const detail = await getCompanyDetail(resin.company.id);
    expect(detail!.sequences.map((s) => s.countsAsEmailed)).toEqual([true]);
    expect(panelBanner(detail!)).toMatch(/^Emailed by Ali Khan .* · Practice run · first email · finished$/);

    // The 30-day rule: a new campaign with the same company leaves it out, with the reason in words.
    const next = await draft.createDraft(arslan, { companyIds: [resin.company.id], timeZone: TZ });
    const snap = await audience.loadAudienceSnapshot(next.id);
    expect(snap.companies[0]).toMatchObject({ section: "excluded" });
    expect(snap.companies[0]!.blockedReason).toMatch(/^Emailed by Ali Khan .*\(Practice run, first email\)$/);
    expect(snap.totals.people).toBe(0);
  });
});
