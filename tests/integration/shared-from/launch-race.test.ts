import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LAUNCH_SETTINGS_CHANGED_TEXT } from "@/core/sending/from-address";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, setSettingValue } from "../campaigns/seed";
import { writeDomainCheck } from "../mailgun-setup/helpers";
import { resetSendingState, setupM3, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * SHARED-FROM-DESIGN F29: a launching campaign is still a draft, so the refusals of a From address or sending-domain
 * change never see it. The launch's last transaction therefore re-reads "mailgun.domain", "mailgun.fromAddress" and
 * "sending.goLive" and refuses when any of them changed since the launch read them: the draft stays a draft, what it
 * reserved is given back and the people it left out are ticked again. An unchanged launch goes through.
 */

const t = await createTestDb("shared-from-launch-race");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { launchCampaign, assertLaunchSettingsUnchanged } = await import("@/server/services/campaigns/launch");
const { CampaignError } = await import("@/server/services/campaigns/errors");

const TEAM = "contact@example.com";
const ALI = "ali@send.example.com";

let world: M3World;
let seq = 0;

/** A draft sent by Ali to one person per address (each at their own company); `checked` people have a valid check. */
async function draftTo(people: Array<{ email: string; checked: boolean }>, now: Date) {
  seq += 1;
  const recipients: Array<{ companyId: number; personId: number }> = [];
  for (const [i, p] of people.entries()) {
    const { company, people: made } = await makeCompany({
      name: `Race ${seq}-${i}`,
      people: [{ name: `Person ${i}`, email: p.email, verificationStatus: p.checked ? "VALID" : null, verifiedAt: p.checked ? now : null }],
    });
    recipients.push({ companyId: company.id, personId: made[0]!.id });
  }
  return makeDraft({ name: `Race campaign ${seq}`, createdById: world.owner.id, senderId: world.member.id, recipients });
}

/** Launches the draft; `race` runs just before the last transaction (a settings change arriving meanwhile). */
async function launch(campaignId: number, now: Date, race?: () => Promise<void>) {
  return launchCampaign(campaignId, world.owner.id, { now, mailgun: world.mailgun, beforeFinalize: race });
}

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  expect(err).toMatchObject({ code: "changed", message: LAUNCH_SETTINGS_CHANGED_TEXT });
}

beforeAll(async () => {
  world = await setupM3({ testList: ["r0@race-0.de", "r1@race-1.de", "r2@race-2.de", "r3@race-3.de", "r4@race-4.de", "r5@race-5.de"] });
});

beforeEach(async () => {
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("mailgun.domain", world.mg.domain);
  await setSettingValue("mailgun.fromAddress", TEAM);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: world.mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
    from: TEAM,
  });
  await writeDomainCheck(world.mg.domain, { "from-mx": "ok" });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the launch's last re-check", () => {
  it("the From address changed meanwhile: refused, the draft stays a draft; launched again unchanged, it goes through with the same rows", async () => {
    const clock = worldClock(world);
    const d = await draftTo([{ email: "r0@race-0.de", checked: false }], clock.now());
    await refusal(launch(d.id, clock.now(), () => setSettingValue("mailgun.fromAddress", null)));
    expect(await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "DRAFT", launchedAt: null, fromAddress: null, replyTo: null });
    const leftover = await db.outboundEmail.findMany({ where: { campaignId: d.id } });
    expect(leftover).toHaveLength(1);

    await setSettingValue("mailgun.fromAddress", TEAM);
    const res = await launch(d.id, clock.now());
    expect(res.status).toBe("RUNNING");
    expect(await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "RUNNING", fromAddress: TEAM, replyTo: ALI, launchedGoLive: false });
    const rows = await db.outboundEmail.findMany({ where: { campaignId: d.id } });
    expect(rows.map((r) => r.id)).toEqual(leftover.map((r) => r.id));
    expect(rows[0]).toMatchObject({ status: "QUEUED", fromAddress: `Ali from Polygon Paradise <${TEAM}>`, replyTo: ALI });
  });

  it("another shared From address meanwhile is refused too", async () => {
    const clock = worldClock(world);
    const d = await draftTo([{ email: "r1@race-1.de", checked: false }], clock.now());
    await refusal(launch(d.id, clock.now(), () => setSettingValue("mailgun.fromAddress", "hello@example.com")));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
  });

  it("go-live changed meanwhile: refused; what it reserved is given back and the people it left out are ticked again", async () => {
    await setSettingValue("sending.goLive", true);
    const clock = worldClock(world);
    const d = await draftTo(
      [
        { email: "checked@race-live.de", checked: true },
        { email: "unchecked@race-live.de", checked: false },
      ],
      clock.now(),
    );
    await refusal(launch(d.id, clock.now(), () => setSettingValue("sending.goLive", false)));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
    expect(await db.companyReservation.count({ where: { campaignId: d.id, releasedAt: null } })).toBe(0);
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: d.id }, orderBy: { id: "asc" } });
    expect(recipients.map((r) => [r.included, r.state])).toEqual([
      [true, "SCHEDULED"],
      [true, "PENDING"],
    ]);
  });

  it("the sending domain changed meanwhile: refused", async () => {
    const clock = worldClock(world);
    const d = await draftTo([{ email: "r2@race-2.de", checked: false }], clock.now());
    await refusal(launch(d.id, clock.now(), () => setSettingValue("mailgun.domain", "mail.other.example")));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
  });

  it("per-person mode races too, and an unchanged launch goes through", async () => {
    await setSettingValue("mailgun.fromAddress", null);
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: world.mg.domain,
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: world.owner.id,
      note: null,
    });
    const clock = worldClock(world);
    const d = await draftTo([{ email: "r3@race-3.de", checked: false }], clock.now());
    await refusal(launch(d.id, clock.now(), () => setSettingValue("mailgun.fromAddress", TEAM)));
    await setSettingValue("mailgun.fromAddress", null);
    const res = await launch(d.id, clock.now(), async () => undefined);
    expect(res.status).toBe("RUNNING");
    expect(await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ fromAddress: ALI, replyTo: null });
  });

  it("compares trimmed, lowercase values (empty = none)", async () => {
    await setSettingValue("mailgun.fromAddress", " Contact@Example.com ");
    await setSettingValue("mailgun.domain", "Send.Example.com");
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { domain: "send.example.com", teamFrom: "contact@example.com", goLive: false }))).resolves.toBeUndefined();
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { domain: "send.example.com", teamFrom: null, goLive: false }))).rejects.toThrow(
      LAUNCH_SETTINGS_CHANGED_TEXT,
    );
    await setSettingValue("mailgun.fromAddress", "  ");
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { domain: "send.example.com", teamFrom: null, goLive: false }))).resolves.toBeUndefined();
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { domain: "send.example.com", teamFrom: null, goLive: true }))).rejects.toThrow(
      LAUNCH_SETTINGS_CHANGED_TEXT,
    );
  });
});

/**
 * Review SEND-3: the last re-check also sees a region-only reconnect (F28: a domain change) and pins the sending domain
 * to the row the snapshot's address was on, read together with that address, so a domain change or a region move
 * committed before the launch read its settings is caught as well.
 */
describe("the launch's last re-check: region and the snapshot's domain row (review SEND-3)", () => {
  const base = { domain: "send.example.com", teamFrom: TEAM, goLive: false } as const;

  /** Puts the region (setting and row) and the row's active flag back as the fake connection left them. */
  async function restoreDomain(): Promise<void> {
    await setSettingValue("mailgun.region", "EU");
    await dbWrite(async (c) => {
      await c.sendingDomain.update({ where: { id: world.mg.domainId }, data: { region: "EU", active: true } });
    });
  }

  it("a region-only reconnect meanwhile (the region setting and the domain row move together): refused, the draft stays a draft", async () => {
    const clock = worldClock(world);
    const d = await draftTo([{ email: "r4@race-4.de", checked: false }], clock.now());
    try {
      await refusal(
        launch(d.id, clock.now(), async () => {
          await setSettingValue("mailgun.region", "US");
          await dbWrite((c) => c.sendingDomain.update({ where: { id: world.mg.domainId }, data: { region: "US" } }));
        }),
      );
      expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
    } finally {
      await restoreDomain();
    }
    // Unchanged, the same draft launches.
    expect((await launch(d.id, clock.now())).status).toBe("RUNNING");
  });

  it("the region setting alone, or the snapshot's domain row alone, changing meanwhile is refused too", async () => {
    const clock = worldClock(world);
    const a = await draftTo([{ email: "r5@race-5.de", checked: false }], clock.now());
    try {
      await refusal(launch(a.id, clock.now(), () => setSettingValue("mailgun.region", "US")));
    } finally {
      await restoreDomain();
    }
    // The row the sender's address was read with was switched off (a domain change that committed before the launch
    // read the settings): the settings compare can't see it, the row check does.
    const rowChange = (data: { active?: boolean; region?: string }) => async () => {
      await dbWrite((c) => c.sendingDomain.update({ where: { id: world.mg.domainId }, data }));
    };
    try {
      await refusal(launch(a.id, clock.now(), rowChange({ active: false })));
    } finally {
      await restoreDomain();
    }
    try {
      await refusal(launch(a.id, clock.now(), rowChange({ region: "US" })));
    } finally {
      await restoreDomain();
    }
    expect((await db.campaign.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("DRAFT");
  });

  it("compares the region case-insensitively (a missing row is the default, EU) and the row by id, name and region", async () => {
    const row = { id: world.mg.domainId, name: "Send.Example.com", region: "eu" };
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, region: "eu", sendingDomain: row }))).resolves.toBeUndefined();
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, region: "US" }))).rejects.toThrow(LAUNCH_SETTINGS_CHANGED_TEXT);
    // Without `region` or `sendingDomain` nothing more is compared (the F29 callers before review SEND-3).
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, base))).resolves.toBeUndefined();
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, sendingDomain: null }))).resolves.toBeUndefined();
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, sendingDomain: { ...row, name: "mail.example.com" } }))).rejects.toThrow(
      LAUNCH_SETTINGS_CHANGED_TEXT,
    );
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, sendingDomain: { ...row, region: "US" } }))).rejects.toThrow(
      LAUNCH_SETTINGS_CHANGED_TEXT,
    );
    await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, sendingDomain: { ...row, id: 987_654 } }))).rejects.toThrow(
      LAUNCH_SETTINGS_CHANGED_TEXT,
    );
    await dbWrite((c) => c.setting.deleteMany({ where: { key: "mailgun.region" } }));
    try {
      await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, region: "EU" }))).resolves.toBeUndefined();
      await expect(dbTx((tx) => assertLaunchSettingsUnchanged(tx, { ...base, region: "US" }))).rejects.toThrow(LAUNCH_SETTINGS_CHANGED_TEXT);
    } finally {
      await restoreDomain();
    }
  });
});
