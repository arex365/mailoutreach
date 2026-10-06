/// <reference types="node" />
/**
 * A test database for the lead's Milestone 5 screen checks (docs/dev/M5-DESIGN.md §7.5, §9.4). Nothing here talks to
 * Mailgun, Anthropic or any website: the database is made ready for the three local fakes (the fake Mailgun, the fake
 * Claude and the fixture sites) that the lead starts next to the app.
 *
 *   node --import tsx scripts/seed-m5-manual.ts                     fill data/manual-check/m5.db (only when it's empty)
 *   node --import tsx scripts/seed-m5-manual.ts --reset             delete it and create it again
 *   node --import tsx scripts/seed-m5-manual.ts --db <path>         another file (never data/app.db, the practice copy's
 *                                                                   data/demo.db, .env's database or data/test/)
 *
 * It creates (and prints) an Owner and a Member with a password, and:
 *  - Mailgun "connected" to the fake's defaults (domain send.example.com, EU, key-fake-api, signing key
 *    key-fake-signing), both sending addresses with a working reply route, the domain checklist green, the reply test
 *    passed, a test list, and go-live on (so the Verify step has work). Go-live is written as the rows goLive() writes
 *    (M6-DESIGN §0.2 rule 6: the service itself would refuse, because a seed has no running background sender and no
 *    delivered live test): sending.goLive, sending.goLiveAt, sending.goLiveDomain, sending.healthSinceGoLiveAt and
 *    sending.mode Live by the Owner,
 *    the "went live" activity and everyone's notification in one transaction, then the warm-up restarted at today;
 *  - the fake Claude's key sk-ant-fake-key as the Anthropic key;
 *  - list "M5 websites": one company per fixture site (tests/fixtures/sites, `.example` origins), each with a person;
 *  - list "M5 address checks": 13 companies with one person each on the fake Mailgun's validate test domains
 *    (M5-DESIGN §9.3 Part B), one of them checked 10 days ago, and a draft campaign "Germany Q4 (checks)" to them;
 *    plus "Typo Studio" (x@yaho.test, not in the campaign) for the company panel's "Did you mean" flow;
 *  - list "M5 missing emails": three companies without an email address (Export for Claude) and one with.
 * The daily backup, the daily clean-up and the 6-hour domain check are recorded as just done, so the first day of
 * checks writes no backup of this database and asks no DNS server anything.
 *
 * DATABASE_URL is pointed at the test database BEFORE any server module is imported; APP_ENCRYPTION_KEY comes from
 * .env, so the app started on this database (scripts/run-prod.mjs --db …) can read the saved keys. Only that key of
 * .env matters here, and .env's own database is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { databasePathFromUrl, parseEnv } from "./lib/env-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const { values: args } = parseArgs({
  options: { reset: { type: "boolean", default: false }, db: { type: "string" } },
  strict: true,
});

const target = path.resolve(ROOT, args.db ?? "data/manual-check/m5.db");

function sameFile(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function refuse(message: string): never {
  console.log(`  [x]  ${message}`);
  process.exit(1);
}

// Never the real data, the practice copy, or a folder the worker's daily clean-up empties. The env file is .env
// (DOTENV_CONFIG_PATH may name another one, as for dotenv itself: a build check that must not read the real .env).
const envFile = process.env.DOTENV_CONFIG_PATH ? path.resolve(ROOT, process.env.DOTENV_CONFIG_PATH) : path.join(ROOT, ".env");
if (!fs.existsSync(envFile)) refuse("There is no .env yet. Run setup.bat first (it creates the encryption key the app uses).");
if (path.basename(target).toLowerCase() === "app.db") refuse("The test data can't be written into app.db (your real data).");
if (sameFile(target, path.join(ROOT, "data", "demo.db"))) refuse("data\\demo.db is the practice copy. Use data\\manual-check\\m5.db.");
if (path.resolve(target).toLowerCase().startsWith(path.join(ROOT, "data", "test").toLowerCase() + path.sep)) {
  refuse("data\\test is emptied by the daily clean-up (files older than a day). Use data\\manual-check\\m5.db.");
}
const realUrl = parseEnv(fs.readFileSync(envFile, "utf8")).DATABASE_URL;
if (realUrl && sameFile(databasePathFromUrl(realUrl, ROOT), target)) refuse("That file is the database in .env (your real data).");

dotenv.config({ path: envFile, quiet: true });
const databaseUrl = "file:" + target.replace(/\\/g, "/");
process.env.DATABASE_URL = databaseUrl;

if (args.reset) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(target + suffix, { force: true });
  console.log(`  Deleted ${path.relative(ROOT, target)}.`);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const migrate = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1", DOTENV_CONFIG_QUIET: "true" },
  encoding: "utf8",
  windowsHide: true,
});
if (migrate.status !== 0) {
  console.log(`${migrate.stdout ?? ""}${migrate.stderr ?? ""}`);
  refuse("Creating the test database failed (prisma migrate deploy).");
}

// Server modules only now, after DATABASE_URL points at the test database.
const { db, dbTx, dbWrite } = await import("@/server/db");
const { hashPassword } = await import("@/lib/auth/password");
const { setSetting, setSettingIn } = await import("@/server/settings");
const { logActivity } = await import("@/server/activity");
const { notifyUsers } = await import("@/server/notifications");
const { startWarmupAtGoLive } = await import("@/server/services/sending/warmup-days");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { setSecret } = await import("@/server/secrets");
const { setState } = await import("@/server/state");
const { createList } = await import("@/server/services/lists");
const { createCompany } = await import("@/server/services/companies/create");
const draft = await import("@/server/services/campaigns/draft");
const { STATE_KEYS } = await import("@/core/system-state");
type ChecklistRow = import("@/core/system-state").ChecklistRow;
type ChecklistRowKey = import("@/core/system-state").ChecklistRowKey;

const PASSWORD = "manual-check-m5";
const DOMAIN = "send.example.com";
const MAILGUN_KEY = "key-fake-api";
const SIGNING_KEY = "key-fake-signing";
const CLAUDE_KEY = "sk-ant-fake-key";

/** One company per fixture site: what drafting should give (M5-DESIGN §7.3). */
const WEBSITE_COMPANIES: Array<{ name: string; website: string; country?: string; person: { name?: string; email: string; role?: string } }> = [
  { name: "Figuren Werkstatt", website: "https://www.figuren-werkstatt.example", country: "DE", person: { name: "Anna Berg", email: "anna@figuren-werkstatt.example", role: "Owner" } },
  { name: "Butikk AS", website: "https://butikk.example", country: "NO", person: { name: "Ola Nordmann", email: "ola@butikk.example" } },
  { name: "Grid Shop", website: "https://www.gridshop.example", country: "GB", person: { email: "info@gridshop.example" } },
  { name: "Cookie Banner Figures", website: "https://cookie-banner.example", person: { name: "Clara Keks", email: "clara@cookie-banner.example" } },
  { name: "Latin Figuren", website: "https://latin1.example", country: "DE", person: { name: "Lena Müller", email: "lena@latin1.example" } },
  { name: "JS Meta Studio", website: "https://js-meta.example", person: { name: "Jonas Meta", email: "jonas@js-meta.example" } },
  { name: "Hidden Text Studio", website: "https://hidden-text.example", person: { name: "Hanna Hidden", email: "hanna@hidden-text.example" } },
  { name: "Injection Minis", website: "https://injection.example", person: { name: "Ivan Inject", email: "ivan@injection.example" } },
  { name: "Redirect Studio", website: "https://redirect-www.example", person: { name: "Rita Redirect", email: "rita@redirect-www.example" } },
  { name: "Slow Robots Studio", website: "https://crawl-delay.example", person: { name: "Carl Crawl", email: "carl@crawl-delay.example" } },
  { name: "Parked Co", website: "https://parked-domain.example", person: { name: "Pat Parker", email: "pat@parked-domain.example" } },
  { name: "Placeholder Co", website: "https://placeholder.example", person: { name: "Paula Place", email: "paula@placeholder.example" } },
  { name: "JS Only Co", website: "https://js-only.example", person: { name: "Jan Only", email: "jan@js-only.example" } },
  { name: "Blocked Co", website: "https://blocked.example", person: { name: "Bea Block", email: "bea@blocked.example" } },
  { name: "Robots Deny Co", website: "https://robots-deny.example", person: { name: "Rob Deny", email: "rob@robots-deny.example" } },
  { name: "Robots Bot Co", website: "https://robots-bot.example", person: { name: "Bo Bot", email: "bo@robots-bot.example" } },
  { name: "Robots Claude Co", website: "https://robots-claude.example", person: { name: "Cleo Claude", email: "cleo@robots-claude.example" } },
  { name: "No AI Co", website: "https://noai.example", person: { name: "Nora Noai", email: "nora@noai.example" } },
  { name: "Redirect Private Co", website: "https://redirect-private.example", person: { name: "Priya Private", email: "priya@redirect-private.example" } },
  { name: "Redirect Loop Co", website: "https://redirect-loop.example", person: { name: "Leo Loop", email: "leo@redirect-loop.example" } },
  { name: "Cyrillic Studio", website: "https://cyrillic.example", person: { name: "Kira Kirill", email: "kira@cyrillic.example" } },
  { name: "Insta Creator", website: "https://www.instagram.com/insta.creator", person: { name: "Ivy Stone", email: "ivy@insta-creator.example" } },
];

/** The fake Mailgun's validate test addresses (M5-DESIGN §7.1, §9.3 Part B). */
const CHECK_ADDRESSES = [
  "anna@valid.test",
  "medium1@valid.test",
  "risky1@valid.test",
  "ok@catchall-low.test",
  "ok@catchall-medium.test",
  "temp1@valid.test",
  "bad1@valid.test",
  "x@disposable.test",
  "g@greylist.test",
  "t@timeout.test",
  "info@role.test",
  "flaky2@valid.test",
  "f@fresh.test",
];

/** The domain checklist's rows, all fine (the Live gate reads them). */
const GREEN_ROWS: ChecklistRowKey[] = [
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

async function makeUser(input: { email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; replyInbox: string }, passwordHash: string) {
  return dbWrite((c) =>
    c.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        timeZone: input.timeZone,
        passwordHash,
        replyInbox: input.replyInbox,
        senderDisplayName: `${input.name} from Polygon Paradise`,
        signature: `${input.name}\nPolygon Paradise`,
      },
    }),
  );
}

async function list(name: string, actor: { id: number; name: string }): Promise<number> {
  const res = await createList(name, actor);
  if (!res.ok) throw new Error(res.error);
  return res.list.id;
}

async function company(
  input: { name: string; website?: string | null; country?: string; listId: number; person: { name?: string | null; email?: string | null; role?: string } | null },
  actor: { id: number; name: string },
): Promise<{ companyId: number; personId: number | null }> {
  const res = await createCompany(
    { name: input.name, website: input.website ?? null, country: input.country ?? null, listId: input.listId, person: input.person },
    actor,
    { force: true },
  );
  if (res.kind !== "created") throw new Error(`${input.name}: ${res.message}`);
  return { companyId: res.companyId, personId: res.personId };
}

async function seed(): Promise<void> {
  if ((await db.user.count()) > 0) {
    console.log(`  ${path.relative(ROOT, target)} already has its test data.`);
    console.log("  To start it over: node --import tsx scripts/seed-m5-manual.ts --reset");
    return;
  }
  const now = new Date();
  const passwordHash = await hashPassword(PASSWORD);
  const ownerRow = await makeUser(
    { email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: "Asia/Karachi", replyInbox: "arslan.inbox@example.org" },
    passwordHash,
  );
  const memberRow = await makeUser(
    { email: "ali@polygonparadise.test", name: "Ali", role: "MEMBER", timeZone: "Europe/Berlin", replyInbox: "ali.inbox@example.org" },
    passwordHash,
  );
  const owner = { id: ownerRow.id, name: ownerRow.name, role: "OWNER" as const };
  const member = { id: memberRow.id, name: memberRow.name, role: "MEMBER" as const };

  // Mailgun, "connected" to the fake's defaults, and ready for live sending (as the M3 test helpers do).
  await setSetting("practice.copy", false, owner.id);
  await setSetting("mailgun.domain", DOMAIN, owner.id);
  await setSetting("mailgun.region", "EU", owner.id);
  await setSecret("mailgun.apiKey", MAILGUN_KEY, owner.id);
  await setSecret("mailgun.webhookSigningKey", SIGNING_KEY, owner.id);
  const domain = await dbWrite((c) => c.sendingDomain.create({ data: { name: DOMAIN, region: "EU", active: true } }));
  for (const [user, local] of [
    [ownerRow, "arslan"],
    [memberRow, "ali"],
  ] as const) {
    await dbWrite((c) =>
      c.senderAddress.create({ data: { userId: user.id, domainId: domain.id, localPart: local, address: `${local}@${DOMAIN}`, routeStatus: "ok" } }),
    );
  }
  const rows: ChecklistRow[] = GREEN_ROWS.map((key) => ({ key, group: "settings", status: "ok", title: key, text: "", fix: null, records: [], detail: null }));
  await setState(STATE_KEYS.domainCheck, { domain: DOMAIN, region: "EU", checkedAt: now.toISOString(), lastVerifyAt: null, rows, error: null });
  await setSetting(
    "mailgun.unsubscribeTest",
    { setup: "A", status: "passed", domain: DOMAIN, mailboxes: [], headersOk: true, decidedAt: now.toISOString(), decidedById: owner.id, note: null },
    owner.id,
  );
  await setSetting("sending.testList", ["arslan.inbox@example.org"], owner.id);
  // Go live: the rows goLive() writes, in one transaction (§0.2 rule 6), then the warm-up restart it does after it. A
  // minute before the draft below is made, so that draft isn't one "made before you went live" (G11).
  const goLiveAt = new Date(now.getTime() - 60_000);
  await dbTx(async (tx) => {
    await setSettingIn(tx, "sending.goLive", true, owner.id);
    await setSettingIn(tx, "sending.goLiveAt", goLiveAt.toISOString(), owner.id);
    await setSettingIn(tx, "sending.goLiveDomain", DOMAIN, owner.id);
    // Since when bounces and complaints count (review REPLIES-02): a first go-live on this domain counts from itself.
    await setSettingIn(tx, "sending.healthSinceGoLiveAt", { since: goLiveAt.toISOString(), goLiveAt: goLiveAt.toISOString(), domain: DOMAIN }, owner.id);
    await setSettingIn(tx, "sending.mode", "LIVE", owner.id);
    await logActivity(
      {
        actorId: owner.id,
        type: "sending.goLive",
        summary: GO_LIVE_COPY.activity(owner.name, DOMAIN),
        data: { at: goLiveAt.toISOString(), domain: DOMAIN, modeFrom: "DRY_RUN", modeTo: "LIVE", capOverrideCleared: null },
      },
      tx,
    );
    await notifyUsers(
      [owner.id, member.id],
      { type: "sending.wentLive", title: GO_LIVE_COPY.notificationTitle, body: GO_LIVE_COPY.notificationBody(owner.name), link: "/dashboard" },
      tx,
    );
  });
  await startWarmupAtGoLive(goLiveAt);
  // The fake Claude's test key.
  await setSecret("anthropic.apiKey", CLAUDE_KEY, owner.id);
  // Nothing heavy on the first day: no backup of this database, no clean-up, no DNS questions.
  for (const task of ["backup.daily", "cleanup.daily", "mailgun.domainCheck.6h"]) {
    await setState(`task.${task}`, { lastSuccessAt: now.toISOString() });
  }

  // Companies whose websites are the fixture sites (AI drafting).
  const websites = await list("M5 websites", owner);
  for (const c of WEBSITE_COMPANIES) await company({ ...c, listId: websites }, owner);

  // Companies with one person each on the validate test domains (address checks), and a draft campaign to them.
  const checks = await list("M5 address checks", owner);
  const checkCompanies: number[] = [];
  for (const [i, email] of CHECK_ADDRESSES.entries()) {
    const made = await company({ name: `Check ${String.fromCharCode(65 + i)} Studio`, listId: checks, person: { name: `Person ${i + 1}`, email } }, owner);
    checkCompanies.push(made.companyId);
    if (email === "f@fresh.test" && made.personId) {
      await dbWrite((c) =>
        c.person.update({
          where: { id: made.personId! },
          data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(now.getTime() - 10 * 86_400_000), verificationProvider: "mailgun-fake" },
        }),
      );
    }
  }
  const campaign = await draft.createDraft(member, { companyIds: checkCompanies, timeZone: "Europe/Berlin", now });
  await draft.renameDraft(member, campaign.id, "Germany Q4 (checks)");
  // Not in the campaign: the company panel's "Did you mean x@yahoo.test?" flow (its domain can't receive email).
  await company({ name: "Typo Studio", listId: checks, person: { name: "Xena Typo", email: "x@yaho.test" } }, owner);

  // The missing-emails round trip: three companies without an email, one with.
  const missing = await list("M5 missing emails", owner);
  for (const name of ["Round A Figures", "Round B Prints", "Round C Models"]) {
    await company({ name, website: `https://${name.split(" ")[1]!.toLowerCase()}-round.example`, listId: missing, person: null }, owner);
  }
  await company({ name: "Round D Resin", website: "https://d-round.example", listId: missing, person: { name: "Dave Moss", email: "dave@d-round.example" } }, owner);

  console.log(`  Test data for the address-check and AI screen checks is in ${path.relative(ROOT, target)}.`);
  console.log(`  Sign in as arslan@polygonparadise.test (Owner) or ali@polygonparadise.test (Member), password ${PASSWORD}`);
  console.log(`  Draft campaign "Germany Q4 (checks)" (13 people) is on the Campaigns page; lists: M5 websites, M5 address checks, M5 missing emails.`);
}

try {
  await seed();
} finally {
  await db.$disconnect();
}
