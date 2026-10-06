import type { MailgunPlan } from "@/core/mailgun/plan";
import type { RepliesMode } from "@/core/sending/own-mailbox";
import { startFakeMailgun, type FakeMailgun, type FakeMailgunOptions } from "../../fake-mailgun/server";

/**
 * Points the app at a fresh fake Mailgun server for one integration test file (M3-DESIGN §6.4). Call it AFTER
 * createTestDb(): it writes Settings, Secrets and a SendingDomain row into the test database.
 *
 *   const t = await createTestDb("x");
 *   const mg = await connectFakeMailgun();              // fake.origin is now OUTREACH_MAILGUN_BASE_URL
 *   const ctx = await getMailgunContext();              // connected to mg.domain through the fake
 *   …
 *   afterAll(() => mg.stop());
 *
 * Keys are always test keys (key-fake-…), which the real Mailgun never gets.
 *
 * Shared From address (SHARED-FROM-DESIGN §7.8): `fromAddress` writes Setting "mailgun.fromAddress" (a string turns
 * shared-From mode on, null clears it; left out = the setting isn't touched, per-person mode in a fresh database), and
 * `dkimAuthority` (or `fake.dkimAuthority`) names the domain whose DKIM key signs, e.g. "example.com".
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §7.8): `replies` writes Setting "mailgun.replies" and `plan` Setting
 * "mailgun.plan" (left out = not touched: app mode and no plan in a fresh database). `replies: "own-mailbox"` needs a fake
 * started with `receivesMail: false` (throws otherwise: a test would prove replies it can never see), and no
 * SenderAddress is ever created here. The usual shape:
 *
 *   connectFakeMailgun({ domain: "example.com", region: "US", replies: "own-mailbox", fromAddress: "contact@example.com",
 *     plan: "free", fake: { plan: "free", receivesMail: false } })
 */
export type FakeConnection = {
  fake: FakeMailgun;
  domain: string;
  domainId: number;
  apiKey: string;
  signingKey: string | null;
  /** The fake's DKIM authority (the domain itself unless one was given). */
  dkimAuthority: string;
  /** Closes the fake and puts OUTREACH_MAILGUN_BASE_URL back. */
  stop: () => Promise<void>;
};

export async function connectFakeMailgun(
  opts: {
    domain?: string;
    region?: "EU" | "US";
    fake?: FakeMailgunOptions;
    fromAddress?: string | null;
    dkimAuthority?: string;
    /** MAIN-DOMAIN-DESIGN §7.8: writes Setting "mailgun.replies"; "own-mailbox" needs `fake.receivesMail: false`. */
    replies?: RepliesMode;
    /** MAIN-DOMAIN-DESIGN §7.8: writes Setting "mailgun.plan" (null = "Not sure"). */
    plan?: MailgunPlan | null;
  } = {},
): Promise<FakeConnection> {
  if (opts.replies === "own-mailbox" && opts.fake?.receivesMail !== false) {
    throw new Error(
      'connectFakeMailgun: replies "own-mailbox" needs a fake started with receivesMail: false (the domain\'s MX is the mail provider\'s, so no reply ever reaches Mailgun).',
    );
  }
  const domain = (opts.domain ?? opts.fake?.domain ?? "send.example.com").toLowerCase();
  const region = opts.region ?? opts.fake?.region ?? "EU";
  const apiKey = opts.fake?.apiKey ?? "key-fake-api";
  const signingKey = opts.fake?.signingKey === undefined ? "key-fake-signing" : opts.fake.signingKey;
  if (!apiKey.startsWith("key-fake-")) throw new Error("connectFakeMailgun: the fake's API key must start with key-fake-.");
  const dkimAuthority = opts.dkimAuthority ?? opts.fake?.dkimAuthority;

  const fake = await startFakeMailgun({ ...opts.fake, domain, region, apiKey, signingKey, ...(dkimAuthority ? { dkimAuthority } : {}) });
  const previous = process.env.OUTREACH_MAILGUN_BASE_URL;
  process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;

  const { setSetting } = await import("@/server/settings");
  const { setSecret, deleteSecret } = await import("@/server/secrets");
  const { dbWrite } = await import("@/server/db");
  await setSetting("mailgun.domain", domain, null);
  await setSetting("mailgun.region", region, null);
  if (opts.fromAddress !== undefined) await setSetting("mailgun.fromAddress", opts.fromAddress, null);
  if (opts.replies !== undefined) await setSetting("mailgun.replies", opts.replies, null);
  if (opts.plan !== undefined) await setSetting("mailgun.plan", opts.plan, null);
  await setSecret("mailgun.apiKey", apiKey, null);
  if (signingKey) await setSecret("mailgun.webhookSigningKey", signingKey, null);
  else await deleteSecret("mailgun.webhookSigningKey");
  const row = await dbWrite(async (c) => {
    await c.sendingDomain.updateMany({ where: { name: { not: domain } }, data: { active: false } });
    return c.sendingDomain.upsert({
      where: { name: domain },
      create: { name: domain, region, active: true },
      update: { region, active: true },
    });
  });

  return {
    fake,
    domain,
    domainId: row.id,
    apiKey,
    signingKey,
    dkimAuthority: fake.dkimAuthority,
    stop: async () => {
      if (previous === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
      else process.env.OUTREACH_MAILGUN_BASE_URL = previous;
      await fake.close();
    },
  };
}
