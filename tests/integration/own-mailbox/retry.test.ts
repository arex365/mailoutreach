import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SendMode } from "@/generated/prisma/client";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { resetSendingState, type M3World } from "../sending-m3/helpers";
import { ALI_LINE, DOMAIN, OWN, passReplyTest, setupOwnMailbox, storeCheck } from "./p1-setup";

/**
 * Retry in own-mailbox mode (docs/dev/MAIN-DOMAIN-DESIGN.md O16, §2.3, §8 P1): a test or live email goes back to the
 * queue only when its campaign's snapshot is an own-mailbox one with today's own From and no Reply-To; a shared-From or
 * per-person snapshot from before the switch is refused with `RETRY_FROM_TEXTS.nowOwnMailbox`, and no fitting own From
 * answers with its own sentence. An email that itself wouldn't pass the sender check (review SEND-6) is refused with
 * `RETRY_FROM_TEXTS.emailDoesntFit` instead of pausing all sending again. Dry runs are never refused.
 */

const t = await createTestDb("own-mailbox-retry");
const { db, dbWrite } = await import("@/server/db");
const { retryEmail, retryEmailProblem, retrySnapshotProblem, RETRY_FROM_TEXTS } = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { getPauseState } = await import("@/server/services/sending/pause");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");

let world: M3World;
let seq = 0;

/**
 * A finished campaign with one FAILED first email, launched with this snapshot. `own` overrides the row itself (its own
 * From line, reply address, Message-ID domain, error), for an email that doesn't match its campaign's snapshot.
 */
async function failedEmail(
  snapshot: { mode: SendMode; fromAddress: string; fromLine: string; replyTo: string | null },
  own: { fromLine?: string; replyTo?: string | null; messageIdDomain?: string; lastError?: string } = {},
): Promise<number> {
  seq += 1;
  const email = `r${seq}@retry-${seq}.de`;
  const { company, people } = await makeCompany({ name: `Retry ${seq}`, people: [{ name: "Rita", email }] });
  return dbWrite(async (c) => {
    const campaign = await c.campaign.create({
      data: {
        name: `Retry campaign ${seq}`,
        createdById: world.owner.id,
        senderId: world.member.id,
        status: "FINISHED",
        mode: snapshot.mode,
        fromName: "Ali from Polygon Paradise",
        fromAddress: snapshot.fromAddress,
        replyTo: snapshot.replyTo,
        launchedAt: new Date(),
        launchedGoLive: false,
      },
    });
    const recipient = await c.campaignRecipient.create({
      data: { campaignId: campaign.id, companyId: company.id, personId: people[0]!.id, emailNorm: email, state: "STOPPED", stopReason: "failed" },
    });
    const row = await c.outboundEmail.create({
      data: {
        campaignId: campaign.id,
        recipientId: recipient.id,
        personId: people[0]!.id,
        companyId: company.id,
        senderId: world.member.id,
        step: 0,
        mode: snapshot.mode,
        toEmail: email,
        toNorm: email,
        companyName: company.name,
        fromAddress: own.fromLine ?? snapshot.fromLine,
        replyTo: own.replyTo !== undefined ? own.replyTo : snapshot.replyTo,
        subject: "Hello",
        text: "Hi",
        html: "<p>Hi</p>",
        messageId: `pp.retry${seq}@${own.messageIdDomain ?? (snapshot.mode === "DRY_RUN" ? "dry-run.invalid" : DOMAIN)}`,
        sendId: `retry-${seq}`,
        dueAt: new Date(),
        status: "FAILED",
        lastError: own.lastError ?? "Mailgun refused this email.",
      },
    });
    return row.id;
  });
}

async function refusal(p: Promise<unknown>): Promise<InstanceType<typeof CampaignError>> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  return err as InstanceType<typeof CampaignError>;
}

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: [] });
});

beforeEach(async () => {
  await resetSendingState();
  await setSettingValue("mailgun.replies", "own-mailbox");
  await setSettingValue("mailgun.fromAddress", OWN);
  await passReplyTest(world.owner.id);
  await storeCheck();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Retry in own-mailbox mode (O16)", () => {
  it("an own-mailbox snapshot (today's own From, no Reply-To) goes back to the queue", async () => {
    for (const mode of ["TEST", "LIVE"] as const) {
      const id = await failedEmail({ mode, fromAddress: OWN, fromLine: ALI_LINE, replyTo: null });
      const res = await retryEmail(id, world.owner.id, { confirmDuplicateRisk: true });
      expect(res.status, mode).toBe("QUEUED");
      expect((await db.outboundEmail.findUniqueOrThrow({ where: { id } })).status).toBe("QUEUED");
    }
  });

  it("a shared-From or per-person snapshot from before the switch is refused with nowOwnMailbox", async () => {
    const shared = await failedEmail({ mode: "LIVE", fromAddress: "contact@example.com", fromLine: ALI_LINE, replyTo: "ali@send.example.com" });
    expect(await refusal(retryEmail(shared, world.owner.id))).toMatchObject({ code: "from-changed", message: RETRY_FROM_TEXTS.nowOwnMailbox });
    const perPerson = await failedEmail({ mode: "TEST", fromAddress: "ali@send.example.com", fromLine: "Ali <ali@send.example.com>", replyTo: null });
    expect(await refusal(retryEmail(perPerson, world.owner.id))).toMatchObject({ code: "from-changed", message: RETRY_FROM_TEXTS.nowOwnMailbox });
    // Another own From (the From was changed since).
    const other = await failedEmail({ mode: "LIVE", fromAddress: "info@example.com", fromLine: "Ali <info@example.com>", replyTo: null });
    expect(await refusal(retryEmail(other, world.owner.id))).toMatchObject({ message: RETRY_FROM_TEXTS.nowOwnMailbox });
    expect(RETRY_FROM_TEXTS.nowOwnMailbox).toBe(
      "This campaign was launched with another From address or before replies went to your own mailbox. Start a new campaign to email this person again.",
    );
  });

  it("with no fitting own From the refusal is the From address problem", async () => {
    await setSettingValue("mailgun.fromAddress", null);
    const id = await failedEmail({ mode: "LIVE", fromAddress: OWN, fromLine: ALI_LINE, replyTo: null });
    expect(await refusal(retryEmail(id, world.owner.id))).toMatchObject({ code: "from-changed", message: OWN_MAILBOX_TEXTS.fromMissing(DOMAIN) });
  });

  it("review SEND-6: an email that would still fail the sender check (it didn't send after two blocks) is refused, and nothing pauses", async () => {
    const own = { mode: "LIVE" as const, fromAddress: OWN, fromLine: ALI_LINE, replyTo: null };
    const offDomainId = await failedEmail(own, { messageIdDomain: "dry-run.invalid", lastError: OWN_MAILBOX_TEXTS.senderBlockedTwice });
    const err = await refusal(retryEmail(offDomainId, world.owner.id));
    expect(err).toMatchObject({ code: "from-changed", message: RETRY_FROM_TEXTS.emailDoesntFit(OWN) });
    expect(err.message).toBe(
      "This email was prepared for another sending setup, so it can't go out from contact@example.com. Start a new campaign to email this person again.",
    );
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: offDomainId } })).toMatchObject({
      status: "FAILED",
      lastError: OWN_MAILBOX_TEXTS.senderBlockedTwice,
    });
    expect((await getPauseState()).paused).toBe(false);

    // The row's own From line or a reply address on the row (the campaign's snapshot fits): refused the same way.
    const otherLine = await failedEmail(own, { fromLine: "Ali <info@example.com>" });
    expect(await refusal(retryEmail(otherLine, world.owner.id))).toMatchObject({ code: "from-changed", message: RETRY_FROM_TEXTS.emailDoesntFit(OWN) });
    const withReply = await failedEmail({ ...own, mode: "TEST" }, { replyTo: "ali@example.com" });
    expect(await refusal(retryEmail(withReply, world.owner.id))).toMatchObject({ code: "from-changed" });

    // The check itself: app mode and dry runs are never refused by it; a fitting email isn't either.
    const team = await loadTeamFrom();
    const fits = { mode: "LIVE" as const, fromAddress: ALI_LINE, replyTo: null, messageId: `pp.x@${DOMAIN}` };
    expect(retryEmailProblem(fits, team)).toBeNull();
    expect(retryEmailProblem({ ...fits, messageId: "pp.x@dry-run.invalid" }, team)).toBe(RETRY_FROM_TEXTS.emailDoesntFit(OWN));
    expect(retryEmailProblem({ ...fits, messageId: "pp.x@dry-run.invalid" }, { ...team, replies: "app" })).toBeNull();
    expect(retryEmailProblem({ ...fits, mode: "DRY_RUN", messageId: "pp.x@dry-run.invalid" }, team)).toBeNull();
  });

  it("dry runs are never refused", async () => {
    const id = await failedEmail({ mode: "DRY_RUN", fromAddress: "ali@your-sending-domain", fromLine: "Ali <ali@your-sending-domain>", replyTo: null });
    expect((await retryEmail(id, world.owner.id)).status).toBe("QUEUED");
  });

  it("app mode keeps today's rules (the own-mailbox branch needs the mode)", async () => {
    const team = await loadTeamFrom();
    const own = { mode: "LIVE" as const, fromAddress: OWN, replyTo: null };
    expect(retrySnapshotProblem(own, team)).toBeNull();
    // Without the mode (an older caller's state): per-person rule — a saved From makes a snapshot without Reply-To stale.
    const appShape = { address: team.address, saved: team.saved, domain: team.domain, problem: team.problem };
    expect(retrySnapshotProblem(own, appShape)).toBe(RETRY_FROM_TEXTS.nowShared(OWN));
    expect(retrySnapshotProblem(own, { ...team, replies: "app" })).toBe(RETRY_FROM_TEXTS.nowShared(OWN));
    expect(retrySnapshotProblem({ ...own, mode: "DRY_RUN" }, team)).toBeNull();
  });
});
