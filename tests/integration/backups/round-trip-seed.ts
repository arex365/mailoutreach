/**
 * Steps 1–3 of the restore round trip (tests/integration/backups/restore-round-trip.test.ts, M6-DESIGN §3.8), in a
 * process of their own, so the test process never holds the database open while restore.mjs replaces it (on Windows an
 * open handle makes deleting its -wal/-shm fail with EBUSY):
 *   1. real data with the test's fake Mailgun connected, Live mode, go-live on (set directly: the round trip isn't
 *      about the switch), a sender with a working reply route; a live campaign (first email only) to 3 people checked
 *      VALID by "mailgun-fake"; one round → email A sent;
 *   2. runBackup({kind: "MANUAL"}) → an app backup with its Backup row, through scripts/vacuum-into.mjs;
 *   3. two more rounds → emails B and C sent after the backup (the fake has 3 messages).
 * Prints one line "RT_RESULT {json}" and exits 0; any problem exits 1.
 *
 *   node --import tsx tests/integration/backups/round-trip-seed.ts
 *   env: DATABASE_URL (the test's own database), OUTREACH_MAILGUN_BASE_URL (the test's fake Mailgun, loopback),
 *        RT_START (the fixed clock's start, ISO). Nothing here reaches the network.
 */
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";
import { checklistRows, clearPacer, makeClock, render } from "../sending-m3/helpers";

// The test file uses the same domain and addresses (this script runs on import, so it is never imported).
const ROUND_TRIP_DOMAIN = "send.example.com";
const ROUND_TRIP_ADDRESSES = ["anna@round-trip-a.de", "ben@round-trip-b.de", "cleo@round-trip-c.de"] as const;

async function main(): Promise<void> {
  const start = process.env.RT_START;
  if (!process.env.DATABASE_URL || !process.env.OUTREACH_MAILGUN_BASE_URL || !start) {
    throw new Error("round-trip-seed needs DATABASE_URL, OUTREACH_MAILGUN_BASE_URL and RT_START.");
  }
  process.env.OUTREACH_TEST_RUN = "1";
  const clock = makeClock(new Date(start));
  const { db, dbWrite } = await import("@/server/db");
  const { setSetting } = await import("@/server/settings");
  const { setSecret } = await import("@/server/secrets");
  const { setState } = await import("@/server/state");
  const { getMailgunContext } = await import("@/server/mailgun/context");
  const { launchCampaign } = await import("@/server/services/campaigns/launch");
  const { sendingTick } = await import("@/server/services/sending/loop");
  const { runBackup } = await import("@/server/services/backups");
  const { recordTaskSuccess } = await import("../../../worker/periodic");
  const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });

  // 1. The fake Mailgun connected (as tests/integration/helpers/mailgun.ts writes it, without starting another fake).
  await setSetting("mailgun.domain", ROUND_TRIP_DOMAIN, null);
  await setSetting("mailgun.region", "EU", null);
  await setSecret("mailgun.apiKey", "key-fake-api", null);
  await setSecret("mailgun.webhookSigningKey", "key-fake-signing", null);
  const domain = await dbWrite((c) =>
    c.sendingDomain.upsert({
      where: { name: ROUND_TRIP_DOMAIN },
      create: { name: ROUND_TRIP_DOMAIN, region: "EU", active: true },
      update: { region: "EU", active: true },
    }),
  );
  const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  const member = await makeUser("Ali", { email: "ali@polygonparadise.test" });
  for (const [u, local] of [
    [owner, "arslan"],
    [member, "ali"],
  ] as const) {
    await dbWrite((c) =>
      c.senderAddress.create({
        data: { userId: u.id, domainId: domain.id, localPart: local, address: `${local}@${ROUND_TRIP_DOMAIN}`, routeStatus: "ok" },
      }),
    );
  }
  await setState("domain.check", {
    domain: ROUND_TRIP_DOMAIN,
    region: "EU",
    checkedAt: clock.now().toISOString(),
    lastVerifyAt: null,
    rows: checklistRows(),
    error: null,
  });
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: ROUND_TRIP_DOMAIN,
    mailboxes: [],
    headersOk: true,
    decidedAt: clock.now().toISOString(),
    decidedById: owner.id,
    note: null,
  });
  await setSettingValue("sending.testList", ["inbox@polygonparadise.test"]);
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
  // The daily backup and clean-up aren't part of the round trip.
  for (const name of ["backup.daily", "cleanup.daily"]) await recordTaskSuccess(name, clock.now());

  const recipients: Array<{ companyId: number; personId: number }> = [];
  for (const [i, email] of ROUND_TRIP_ADDRESSES.entries()) {
    const { company, people } = await makeCompany({ name: `Round Trip ${"ABC"[i]} Studio`, people: [{ name: `Person ${i + 1}`, email }] });
    await dbWrite((c) =>
      c.person.update({
        where: { id: people[0]!.id },
        data: {
          verificationStatus: "VALID",
          verificationRisk: "LOW",
          verifiedAt: new Date(clock.now().getTime() - 86_400_000),
          verificationProvider: "mailgun-fake",
        },
      }),
    );
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({
    name: "Round trip",
    createdById: owner.id,
    senderId: member.id,
    steps: [{ step: 0, subject: "3D models for your shop", body: "Hi {{first_name|there}}" }],
    recipients,
  });
  await launchCampaign(draft.id, owner.id, { now: clock.now(), mailgun });
  const tick = async () => {
    await clearPacer();
    const r = await sendingTick({ now: clock.now, render, mailgun, random: () => 0.5 });
    if (r.sent !== 1) throw new Error(`Expected one email to go at ${clock.now().toISOString()}, got ${JSON.stringify(r)}`);
  };
  await tick(); // A

  // 2. Back up now, through the real child process.
  clock.advance(60_000);
  const backup = await runBackup({ kind: "MANUAL", userId: owner.id, now: clock.now() });

  // 3. Two more emails after the backup.
  clock.advance(60_000);
  await tick(); // B
  clock.advance(60_000);
  await tick(); // C

  const emails = await db.outboundEmail.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" }, select: { id: true, status: true, toNorm: true } });
  const result = {
    backupFile: backup.filePath,
    backupFileName: backup.fileName,
    campaignId: draft.id,
    ownerId: owner.id,
    emails,
    clock: clock.now().toISOString(),
  };
  await db.$disconnect();
  process.stdout.write(`RT_RESULT ${JSON.stringify(result)}\n`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(`RT_ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
