import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { DAY, email, enroll, makeCampaign, makeCompany, makeInbound, makePerson, makeUser, recipient } from "./world";

const t = await createTestDb("stops-company");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { stopCompany, stopCompaniesForStatus, STOP_SKIP_TEXT, STATUS_STOP_SKIP_TEXT } = await import("@/server/services/mail-events/stops");
const { retryEmail } = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** Company A (Anna, Ben) and B (Carl) in a LIVE campaign and a dry run. */
async function twoCampaigns() {
  const a = await makeCompany("Firma GmbH");
  const b = await makeCompany("Butikk AS");
  const n = Math.random().toString(36).slice(2, 7);
  const anna = await makePerson(a.id, `anna.${n}@firma.de`, "Anna Berg");
  const ben = await makePerson(a.id, `ben.${n}@firma.de`, "Ben Braun");
  const carl = await makePerson(b.id, `carl.${n}@butikk.no`, "Carl");
  const live = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
  const dry = await makeCampaign({ createdById: ownerId, mode: "DRY_RUN" });
  return { a, b, anna, ben, carl, live, dry };
}

async function reservationOpen(campaignId: number, companyId: number): Promise<boolean> {
  return (await db.companyReservation.count({ where: { campaignId, companyId, releasedAt: null } })) > 0;
}

describe("stopCompany (a reply stops the company, M4-DESIGN §2.6)", () => {
  it("stops the company in every campaign: the replier gets `replied`, everyone else `company_replied`; other companies untouched", async () => {
    const w = await twoCampaigns();
    const liveAnna = await enroll(w.live, w.anna);
    const liveBen = await enroll(w.live, w.ben, { first: true });
    const liveCarl = await enroll(w.live, w.carl);
    const dryAnna = await enroll(w.dry, w.anna);
    const dryBen = await enroll(w.dry, w.ben);
    const reply = await makeInbound({ kind: "REPLY", companyId: w.a.id });
    const now = new Date();

    const res = await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.ben.id], replierEmails: [w.ben.emailNorm!.toUpperCase()], inboundId: reply.id, now }),
    );
    expect(res.stopped).toBe(4);
    expect(res.campaignIds).toEqual([w.live.id, w.dry.id].sort((x, y) => x - y));

    for (const r of [liveAnna, dryAnna]) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: reply.id, nextDueAt: null });
      expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: someone at the company replied" });
    }
    for (const r of [liveBen, dryBen]) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: reply.id });
      expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: they replied" });
    }
    // Company B keeps going, and keeps its reservation; A's reservations are released (nothing open there).
    expect(await recipient(liveCarl.recipientId)).toMatchObject({ state: "WAITING", stopReason: null });
    expect((await email(liveCarl.queuedId!)).status).toBe("QUEUED");
    expect(await reservationOpen(w.live.id, w.b.id)).toBe(true);
    expect(await reservationOpen(w.live.id, w.a.id)).toBe(false);
    expect(await reservationOpen(w.dry.id, w.a.id)).toBe(false);
  });

  it("an unknown colleague's reply: the person the email went to gets `replied`, the others `company_replied`", async () => {
    const w = await twoCampaigns();
    const anna = await enroll(w.live, w.anna);
    const ben = await enroll(w.live, w.ben);
    const reply = await makeInbound({ kind: "REPLY", companyId: w.a.id, fromEmail: "jonas@firma.de" });
    await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.anna.id], replierEmails: ["jonas@firma.de"], inboundId: reply.id, now: new Date() }),
    );
    expect((await recipient(anna.recipientId)).stopReason).toBe("replied");
    expect((await recipient(ben.recipientId)).stopReason).toBe("company_replied");
  });

  it("campaign scope stops only that campaign", async () => {
    const w = await twoCampaigns();
    const liveAnna = await enroll(w.live, w.anna);
    const dryAnna = await enroll(w.dry, w.anna);
    const dryBen = await enroll(w.dry, w.ben);
    const reply = await makeInbound({ kind: "REPLY", companyId: w.a.id, campaignId: w.dry.id, replyScope: "campaign" });
    const res = await dbTx((tx) =>
      stopCompany(tx, {
        companyId: w.a.id,
        replierPersonIds: [w.anna.id],
        replierEmails: [w.anna.emailNorm!],
        inboundId: reply.id,
        campaignId: w.dry.id,
        now: new Date(),
      }),
    );
    expect(res).toEqual({ stopped: 2, campaignIds: [w.dry.id] });
    expect(await recipient(liveAnna.recipientId)).toMatchObject({ state: "WAITING", stopReason: null });
    expect((await email(liveAnna.queuedId!)).status).toBe("QUEUED");
    expect((await recipient(dryAnna.recipientId)).stopReason).toBe("replied");
    expect((await recipient(dryBen.recipientId)).stopReason).toBe("company_replied");
    expect(await reservationOpen(w.live.id, w.a.id)).toBe(true);
  });

  it("ranks: an earlier bounce stays `bounced`; a later reply from the colleague upgrades `company_replied` to `replied`", async () => {
    const w = await twoCampaigns();
    const anna = await enroll(w.live, w.anna, { state: "STOPPED", stopReason: "bounced", queuedStep: null });
    const ben = await enroll(w.live, w.ben);
    const first = await makeInbound({ kind: "REPLY", companyId: w.a.id });
    const r1 = await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.anna.id], replierEmails: [w.anna.emailNorm!], inboundId: first.id, now: new Date() }),
    );
    expect(r1.stopped).toBe(1);
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced", stoppedByInboundId: null });
    expect(await recipient(ben.recipientId)).toMatchObject({ stopReason: "company_replied", stoppedByInboundId: first.id });

    const second = await makeInbound({ kind: "REPLY", companyId: w.a.id });
    const r2 = await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.ben.id], replierEmails: [w.ben.emailNorm!], inboundId: second.id, now: new Date() }),
    );
    expect(r2).toEqual({ stopped: 0, campaignIds: [] });
    expect(await recipient(ben.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: second.id });
    // Ben's email skipped by the weaker stop now says why he really stopped.
    expect(await email(ben.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: they replied" });
    expect((await recipient(anna.recipientId)).stopReason).toBe("bounced");
  });

  it("overwrites `failed` (so Retry can never reopen them), but never a status, a cancellation or a hand skip", async () => {
    const w = await twoCampaigns();
    const anna = await enroll(w.live, w.anna, { state: "STOPPED", stopReason: "failed", queuedStep: null });
    const failedEmail = await dbWrite((c) =>
      c.outboundEmail.create({
        data: {
          campaignId: w.live.id,
          recipientId: anna.recipientId,
          personId: w.anna.id,
          companyId: w.a.id,
          senderId: ownerId,
          step: 1,
          mode: "LIVE",
          toEmail: w.anna.email!,
          toNorm: w.anna.emailNorm!,
          companyName: "Firma GmbH",
          fromAddress: "Ali <ali@send.example.com>",
          subject: "Re: Hello",
          text: "Again",
          html: "",
          messageId: `pp.failed.${Date.now()}@send.example.com`,
          sendId: `send-failed-${Date.now()}`,
          dueAt: new Date(Date.now() - DAY),
          status: "FAILED",
          lastError: "Mailgun refused it",
        },
      }),
    );
    const ben = await enroll(w.live, w.ben, { state: "STOPPED", stopReason: "failed", queuedStep: null });
    const dryAnna = await enroll(w.dry, w.anna, { state: "STOPPED", stopReason: "status:CLIENT", queuedStep: null });
    const dryBen = await enroll(w.dry, w.ben, { state: "STOPPED", stopReason: "Skipped by Sara", queuedStep: null });
    const reply = await makeInbound({ kind: "REPLY", companyId: w.a.id });
    await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.anna.id], replierEmails: [w.anna.emailNorm!], inboundId: reply.id, now: new Date() }),
    );
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: reply.id });
    expect((await recipient(ben.recipientId)).stopReason).toBe("company_replied");
    expect((await recipient(dryAnna.recipientId)).stopReason).toBe("status:CLIENT");
    expect((await recipient(dryBen.recipientId)).stopReason).toBe("Skipped by Sara");

    const refused = await retryEmail(failedEmail.id, ownerId).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(CampaignError);
    expect(refused).toMatchObject({ code: "stopped" });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: failedEmail.id } })).status).toBe("FAILED");
  });

  it("stops held recipients too, clearing their hold fields", async () => {
    const w = await twoCampaigns();
    const anna = await enroll(w.live, w.anna, { state: "HELD", holdReason: "outage,possible-reply" });
    const reply = await makeInbound({ kind: "REPLY", companyId: w.a.id });
    const res = await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.anna.id], replierEmails: [w.anna.emailNorm!], inboundId: reply.id, now: new Date() }),
    );
    expect(res.stopped).toBe(1);
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", holdReason: null, heldAt: null });
    expect(await email(anna.queuedId!)).toEqual({ status: "SKIPPED", lastError: STOP_SKIP_TEXT.replied });
  });

  it("releases the campaign's reservation on the company once nothing is open there, and only there", async () => {
    const w = await twoCampaigns();
    await enroll(w.live, w.anna);
    const other = await makeCompany("Elsewhere");
    const dora = await makePerson(other.id, `dora.${Date.now()}@elsewhere.test`);
    await enroll(w.live, dora);
    const reply = await makeInbound({ kind: "REPLY", companyId: w.a.id });
    await dbTx((tx) =>
      stopCompany(tx, { companyId: w.a.id, replierPersonIds: [w.anna.id], replierEmails: [], inboundId: reply.id, now: new Date() }),
    );
    expect(await reservationOpen(w.live.id, w.a.id)).toBe(false);
    expect(await reservationOpen(w.live.id, other.id)).toBe(true);
  });
});

describe("stopCompaniesForStatus (a person set the status, M4-DESIGN §2.7)", () => {
  it("stops every open recipient of 50 companies in one call with `status:CLIENT`; stopped ones stay as they are", async () => {
    const campaign = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
    const dry = await makeCampaign({ createdById: ownerId, mode: "DRY_RUN" });
    const companies: number[] = [];
    const open: Array<{ recipientId: number; queuedId: number | null }> = [];
    for (let i = 0; i < 50; i++) {
      const c = await makeCompany(`Client ${i}`);
      companies.push(c.id);
      const p = await makePerson(c.id, `p${i}.${Date.now()}@client${i}.test`);
      open.push(await enroll(i % 2 === 0 ? campaign : dry, p, i % 3 === 0 ? { first: true } : {}));
    }
    const bouncedPerson = await makePerson(companies[0]!, `bounced.${Date.now()}@client0.test`);
    const bounced = await enroll(campaign, bouncedPerson, { state: "STOPPED", stopReason: "bounced", queuedStep: null });
    const outside = await makeCompany("Not a client");
    const outsider = await enroll(campaign, await makePerson(outside.id, `x.${Date.now()}@outside.test`));

    const res = await dbTx((tx) => stopCompaniesForStatus(tx, { companyIds: companies, status: "CLIENT", now: new Date() }));
    expect(res.stopped).toBe(50);
    expect(res.campaignIds).toEqual([campaign.id, dry.id].sort((x, y) => x - y));
    for (const r of open) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "status:CLIENT", holdReason: null });
      expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: the company was marked Client" });
    }
    expect((await recipient(bounced.recipientId)).stopReason).toBe("bounced");
    expect((await recipient(outsider.recipientId)).state).toBe("WAITING");
    expect(await reservationOpen(campaign.id, companies[0]!)).toBe(false);
    expect(await reservationOpen(campaign.id, outside.id)).toBe(true);
  });

  it("clears the hold of held recipients, writes nothing for no companies, and has a sentence per status", async () => {
    const campaign = await makeCampaign({ createdById: ownerId });
    const c = await makeCompany("Held Co");
    const held = await enroll(campaign, await makePerson(c.id, `held.${Date.now()}@held.test`), { state: "HELD", holdReason: "outage" });
    await dbTx((tx) => stopCompaniesForStatus(tx, { companyIds: [c.id], status: "DO_NOT_CONTACT", now: new Date() }));
    expect(await recipient(held.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "status:DO_NOT_CONTACT", holdReason: null, heldAt: null });
    expect(await email(held.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: the company was marked Do not contact" });
    expect(await dbTx((tx) => stopCompaniesForStatus(tx, { companyIds: [], status: "REPLIED", now: new Date() }))).toEqual({ stopped: 0, campaignIds: [] });
    expect(STATUS_STOP_SKIP_TEXT).toEqual({
      REPLIED: "Stopped: the company was marked Replied",
      CLIENT: "Stopped: the company was marked Client",
      NOT_INTERESTED: "Stopped: the company was marked Not interested",
      DO_NOT_CONTACT: "Stopped: the company was marked Do not contact",
    });
  });
});
