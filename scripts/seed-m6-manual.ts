/// <reference types="node" />
/**
 * The manual-check databases of Milestone 6 (docs/dev/M6-DESIGN.md §9.4) for the lead's screen checks and the
 * Playwright + axe suite (tests/playwright). Nothing here talks to Mailgun, Anthropic, Cloudflare or any website: the
 * data is built through the app's own services (companies, drafts, launches, the sending loop with a stand-in
 * transport, the reply processor, the event store, backups) for instances that run against the local fakes.
 *
 *   node --import tsx scripts/seed-m6-manual.ts --state all      all five, each from scratch
 *   node --import tsx scripts/seed-m6-manual.ts --state ready    one of: empty, busy, ready, live, own
 *   … --state busy --db data/manual-check/m6-busy-2.db           another file (only inside data\manual-check\)
 *   … --state ready --per-person                                 ready (or live) without the shared From address
 *
 * Shared From address (docs/dev/SHARED-FROM-DESIGN.md §8 P6, §9.4): ready and live run in shared-From mode, the owner's
 * shape: every campaign email shows From contact@example.com (E2E_TEAM_FROM) with the sender's display name, and each
 * sender's own address on send.example.com is the Reply-To. The From address is saved first, its change time before
 * the checklist's check (so going live's freshness rule holds); the checklist has the main domain's two rows (titled
 * with example.com); the reply test passed for that From address, with its reply-test emails and one pasted original;
 * live records the From address it went live with; every campaign and email carries the team From line and Reply-To.
 * Their instances' fake Mailgun signs with example.com's key (--dkim-authority example.com, playwright.config.ts).
 * busy stays per-person, so both vocabularies ("Reply address", "Sending address") are on the screens; `--per-person`
 * seeds ready or live the way they were before (the go-live spec's per-person dialog, go-live.spec.ts).
 *
 * Each run deletes the state's database (and its -wal/-shm, its .instance note, a RESTORED marker left for it, the
 * app backups in its backups\<name>\ folder and its second-copy folder) and creates it again from the migrations, with
 * the clock at the real now, so "36 hours" and "today" hold when the instance runs. Only data\manual-check\ is ever
 * written (never data\test\, which the worker's daily clean-up empties, never data\app.db or the practice copy's
 * data\demo.db), plus the app's own backups folder for that database (backups\m6-<state>\, where the app instance
 * looks for them).
 *
 * The states (both users sign in with the password printed at the end; time zone Asia/Karachi):
 *  - empty: Arslan (Owner) and Ali (Member) only, the default templates, no Mailgun settings, no backup;
 *  - busy: not live; 60 companies (8 without an email, statuses spread), replies waiting Arslan 3 · Ali 1 plus a
 *    dry-run reply, 12 AI lines to review, two paused dry runs ("Paused by Arslan", one with a reason), a running dry
 *    run with emails today, a running live campaign to the test list with 2 unconfirmed emails, the newest backup 40
 *    hours old and not copied to a second folder that isn't there, the check with Mailgun failing for 3 hours and an
 *    old domain unchecked, address checks and AI drafting paused, and sending paused for bounces. Its instance runs
 *    the web app only (no background sender), so the dashboard also says the background sender isn't running;
 *  - ready: everything green for going live in fake mode: the Domain checklist checked now, Setup A, the reply test
 *    passed, reply routes working, a live test email to the test list sent and delivered, a fresh backup copied to
 *    data\manual-check\second-copy\ (with its marker), and the draft "Germany Q4" made yesterday in dry run. Reseed it
 *    right before go-live.spec.ts: the switch needs a check less than an hour old;
 *  - live: ready as of the moment of going live, which was the third weekday before today (the rows goLive() writes,
 *    M6-DESIGN §0.2 rule 6), warm-up step 2 after two weekdays that moved it up, two live campaigns with 180 emails
 *    sent (130 on a weekend day) and 2 bounces, and a dry run today;
 *  - own (docs/dev/MAIN-DOMAIN-DESIGN.md §9.4): the owner's own-mailbox shape. Mailgun "connected" in own-mailbox mode
 *    to example.com itself (US, the Free plan, 1 day of logs), From contact@example.com (saved before the check), no
 *    sending address; the Domain checklist's rows built by the app's own builder from own-mailbox facts with no public
 *    address (all done, the https-links, webhooks and remote-access rows information only), stored for this mode with
 *    the last good MX; the reply test passed by hand (the pasted original with an http link and a mailto: address, the
 *    unsubscribe-by-email answer Yes) with its test emails; go-live off; one running live campaign to the test list
 *    whose first emails were delivered yesterday (the live test) and whose follow-ups are due now, and nobody has read
 *    contact@ today (the dashboard's inbox-check item, the Notifications page's card); a draft for the Sender step. Its
 *    instance has no public address (run-prod.mjs --no-public-address) and its fake Mailgun runs with
 *    --domain example.com --region US --plan free --mx-elsewhere --settings-applied (the seeded Apply run switched
 *    tracking off and unsubscribe handling on, so the fake starts that way: otherwise the first catch-up pauses sending
 *    and every own screen shows the paused app, review SCREENS-12).
 * Long values for the phone-width checks (scripts/lib/seed-m6-values.ts LONG_VALUES): ready and live have a prospect
 * with a long name, website host and address in "Germany Q4" (on Contacts' first page); live names its dry run and a
 * second draft at about 80 characters and has that prospect's AI line approved; busy has a long test-list address and
 * a switched-off teammate with a long address.
 *
 * Every address in the data is on example.com (or a subdomain) or a *.example domain, and the script checks that before
 * it finishes, so no instance can email a real person even if a fake is missing. Each state also checks its own facts
 * through the app's read services (e.g. the go-live blockers of `ready`) and writes them to data\manual-check\
 * m6-<state>.json, which the specs read.
 *
 * DATABASE_URL points at the test database BEFORE any server module is imported. APP_ENCRYPTION_KEY comes from .env
 * (or the file DOTENV_CONFIG_PATH names), so the instance started on this database can read the saved fake keys;
 * .env's own database is refused, and its public address is never used (the seed sets a loopback one first).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import type { SendMode } from "@/generated/prisma/client";
import { PROMPT_VERSION } from "@/core/ai/prompt";
import { HAIKU_MODEL } from "@/core/ai/types";
import { APPLY_STEP_TEXTS, buildChecklistRows, checklistTitle, type ChecklistFacts, type DmarcFind, type TwoAnswers } from "@/core/dns/checklist";
import type { CompanyStatusValue } from "@/core/labels";
import { catchUpFailing, oldDomainLines } from "@/core/mailgun/catch-up-status";
import { planLimits } from "@/core/mailgun/plan";
import type { NormalizedEvent } from "@/core/mailgun/events";
import type { HeaderPair, ParsedInbound } from "@/core/mailgun/inbound";
import { REPLY_TEST_SUBJECT } from "@/core/reply-test";
import type { ReplyTestOriginal, UnsubscribeTestSetting } from "@/core/setting-types";
import { addCapDays, capDayBounds, capDayOf, capDayOfWeek, type CapDay } from "@/core/sending/capday";
import { evaluateHealth } from "@/core/sending/health";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { domainOfAddress, formatFromHeader } from "@/core/sending/from-address";
import { GO_LIVE_RECOMMENDATION_TEXTS, MODE_GATE_TEXTS } from "@/core/sending/mode-gates";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import {
  STATE_KEYS,
  type CatchUpState,
  type CheckStatus,
  type ChecklistGroup,
  type ChecklistRow,
  type ChecklistRowKey,
  type SetupStep,
} from "@/core/system-state";
import { parseCatchUpState, parseTunnelState, parseWarmupState } from "@/core/system-state-parse";
import { formatShortDate } from "@/core/time/format";
import { checkPauseText } from "@/core/verification/words";
import type { EmailTransport, OutgoingMessage, TransportResult } from "@/server/services/sending/transport";
import { databasePathFromUrl, parseEnv } from "./lib/env-file.mjs";
import { LONG_VALUES, isSafeAddress, madeUpCompanyName, madeUpDomain } from "./lib/seed-m6-values";
import {
  E2E_INSTANCES,
  E2E_OWN_DOMAIN,
  E2E_OWN_FROM,
  E2E_STATES,
  E2E_TEAM_FROM,
  E2E_TIME_ZONE,
  E2E_USERS,
  FAKE_CLAUDE_PORT,
  MANUAL_CHECK_DIR,
  WEB_FIXTURES_DIR,
  fakeMailgunArgs,
  isE2eState,
  manifestFileFor,
  manualCheckDatabase,
  type E2eState,
} from "../tests/playwright/instances";
import {
  MANIFEST_VERSION,
  type BusyFacts,
  type LiveFacts,
  type OwnFacts,
  type ReadyFacts,
  type ScreenFacts,
  type SeedManifest,
  type SeedRef,
  type SeedUser,
  type SharedFromFacts,
} from "../tests/playwright/manifest";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");
process.chdir(ROOT);

const { values: args } = parseArgs({
  options: { state: { type: "string" }, db: { type: "string" }, "per-person": { type: "boolean" } },
  strict: true,
});

function refuse(message: string): never {
  console.log(`  [x]  ${message}`);
  process.exit(1);
}

/** `--state all`: each state in a process of its own (the database client is bound to one file per process). */
function seedAll(): never {
  if (args.db) refuse("--db works with one state only, not with --state all.");
  if (args["per-person"]) refuse("--per-person works with --state ready or --state live only, not with --state all.");
  for (const s of E2E_STATES) {
    const run = spawnSync(process.execPath, [...process.execArgv, SELF, "--state", s], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}

if (args.state === "all") seedAll();
if (!isE2eState(args.state)) refuse(`Say which state to seed: --state empty, busy, ready, live, own or all (not "${args.state ?? ""}").`);
const state: E2eState = args.state;
const instance = E2E_INSTANCES[state];
if (args["per-person"] && state !== "ready" && state !== "live") {
  refuse(`--per-person works with --state ready or --state live only: ${state} is always per-person.`);
}
/**
 * The shared From address of this state (SHARED-FROM-DESIGN §8 P6): ready and live run in shared-From mode unless
 * `--per-person` says otherwise; empty and busy are per-person (null).
 */
const teamFrom: string | null = (state === "ready" || state === "live") && !args["per-person"] ? E2E_TEAM_FROM : null;
/**
 * The own From of the own state (MAIN-DOMAIN-DESIGN §9.4): every email comes from it, sent through its own domain;
 * null in every other state.
 */
const ownFrom: string | null = state === "own" ? E2E_OWN_FROM : null;

// ───────────────────────── where it writes (refused anywhere else) ─────────────────────────

const lower = (p: string) => path.resolve(p).toLowerCase();
const rel = (p: string) => path.relative(ROOT, p) || p;
const manualDir = path.join(ROOT, MANUAL_CHECK_DIR);
const target = path.resolve(ROOT, args.db ?? manualCheckDatabase(state));
{
  const inside = path.relative(lower(manualDir), lower(target));
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    refuse(`Test databases live in data\\manual-check\\ only, so ${target} is refused.`);
  }
  if (!/^[A-Za-z0-9._-]+\.db$/.test(path.basename(target))) {
    refuse("The database file name must end in .db and use only letters, digits, dots, dashes and underscores.");
  }
  const base = path.basename(target).toLowerCase();
  if (base === "app.db") refuse("The test data can't be written into app.db (your real data).");
  if (base === "demo.db") refuse("demo.db is the practice copy's database. Pick another name.");
}
const envFile = process.env.DOTENV_CONFIG_PATH ? path.resolve(ROOT, process.env.DOTENV_CONFIG_PATH) : path.join(ROOT, ".env");
if (!fs.existsSync(envFile)) refuse("There is no .env yet. Run setup.bat first (it creates the encryption key the app uses).");
{
  const realUrl = parseEnv(fs.readFileSync(envFile, "utf8")).DATABASE_URL;
  if (realUrl && lower(databasePathFromUrl(realUrl, ROOT)) === lower(target)) refuse("That file is the database in .env (your real data).");
}

/** The app's backups folder for this database (backupFolderFor: backups\<file name without .db>\); checked again below. */
const backupsRoot = path.join(ROOT, "backups");
const backupDir = path.join(backupsRoot, path.basename(target).replace(/\.db$/i, ""));
/** The second backup folder of ready (the design's data\manual-check\second-copy\) and live (one of its own). */
const secondDir =
  state === "ready" || state === "live"
    ? path.join(manualDir, lower(target) === lower(path.join(ROOT, manualCheckDatabase("ready"))) ? "second-copy" : `second-copy-${path.basename(target, ".db")}`)
    : null;

// Loopback only, BEFORE .env is read (dotenv never replaces a variable that is set): the real public address, the real
// Mailgun and Anthropic can't be reached from here. No Mailgun or Claude call is made at all; the Mailgun address is a
// loopback port nothing listens on, so a mistaken call would fail at once instead of reaching anything.
// The own state has no public address at all, like its instance (run-prod.mjs --no-public-address): empty, not unset.
Object.assign(process.env, {
  APP_PUBLIC_URL: instance.publicAddress === false ? "" : `http://127.0.0.1:${instance.port}`,
  OUTREACH_TEST_RUN: "1",
  OUTREACH_MAILGUN_BASE_URL: "http://127.0.0.1:49999",
  OUTREACH_ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_CLAUDE_PORT}`,
  OUTREACH_WEB_FIXTURES: WEB_FIXTURES_DIR,
});
dotenv.config({ path: envFile, quiet: true });
if (!process.env.APP_ENCRYPTION_KEY) refuse(`${rel(envFile)} has no APP_ENCRYPTION_KEY. Run setup.bat first.`);
const databaseUrl = "file:" + target.replace(/\\/g, "/");
process.env.DATABASE_URL = databaseUrl;

// ───────────────────────── a clean start ─────────────────────────

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    refuse(
      code === "EBUSY" || code === "EPERM"
        ? `${rel(file)} is in use. Stop the app instance that runs on it (close its window), then run this again.`
        : `Couldn't delete ${rel(file)} (${code || String(err)}).`,
    );
  }
}

if (path.dirname(backupDir) !== backupsRoot || !/^[A-Za-z0-9._-]+$/.test(path.basename(backupDir)) || path.basename(backupDir).toLowerCase() === "demo") {
  refuse(`Unexpected backups folder ${backupDir}.`);
}
for (const suffix of ["", "-wal", "-shm", "-journal", ".instance"]) removeFile(target + suffix);
removeFile(manifestFileFor(target));
{
  // A restore rehearsal's marker names the database it was for; only this database's is removed.
  const marker = path.join(path.dirname(target), "RESTORED");
  if (fs.existsSync(marker)) {
    try {
      const m = JSON.parse(fs.readFileSync(marker, "utf8")) as { db?: unknown };
      if (typeof m.db === "string" && m.db.toLowerCase() === path.basename(target).toLowerCase()) removeFile(marker);
    } catch {
      // Not readable: it isn't ours to judge.
    }
  }
}
// This database's app backups (app-…): the backups folder itself and anything else in it stay.
if (fs.existsSync(backupDir)) {
  for (const name of fs.readdirSync(backupDir)) if (/^app-/i.test(name)) removeFile(path.join(backupDir, name));
}
if (secondDir) fs.rmSync(secondDir, { recursive: true, force: true });

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

// ───────────────────────── the app's services (only now, on the test database) ─────────────────────────

const { db, dbTx, dbWrite } = await import("@/server/db");
const { hashPassword } = await import("@/lib/auth/password");
const { setSetting } = await import("@/server/settings");
const { setSecret } = await import("@/server/secrets");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { waitingReplyWhere } = await import("@/server/notifications");
const { getSendingLabel } = await import("@/server/sending-state");
const { createList } = await import("@/server/services/lists");
const { createCompany } = await import("@/server/services/companies/create");
const { ensureDefaultTemplates, getMasterTemplate } = await import("@/server/services/templates");
const draftService = await import("@/server/services/campaigns/draft");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { pauseCampaign } = await import("@/server/services/campaigns/control");
const { sendOneEmail } = await import("@/server/services/sending/loop");
const { DryRunTransport } = await import("@/server/services/sending/transport");
const { claimEmail } = await import("@/server/services/sending/claim");
const { UNCONFIRMED_MESSAGE } = await import("@/server/services/sending/reconcile");
const { renderCampaignEmail } = await import("@/server/services/render");
const { simulateReply } = await import("@/server/services/mail-events/simulate");
const { storeInbound } = await import("@/server/services/mail-events/inbound-store");
const { applyMailEventNow } = await import("@/server/services/mail-events/apply");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { processInboundMessage } = await import("@/server/services/replies/process");
const backups = await import("@/server/services/backups");
const { checkDatabaseInstance } = await import("@/server/services/sending/restore");
const { getPauseState, pauseSending } = await import("@/server/services/sending/pause");
const { getChecksPause, pauseChecks } = await import("@/server/services/verification/pause");
const { getAiPause, pauseAi } = await import("@/server/services/ai/pause");
const { aiQueueCounts } = await import("@/server/services/ai/queue");
const { approveDraft } = await import("@/server/services/ai/review");
const { aiPauseText } = await import("@/server/anthropic/errors");
const { evaluateWarmupDays, startWarmupAtGoLive } = await import("@/server/services/sending/warmup-days");
const { getTodayCap, loadHealthCounts } = await import("@/server/services/sending/usage");
const { loadGoLiveView } = await import("@/server/services/go-live");
const { replyTestMessageId } = await import("@/server/services/test-send");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { getCampaignOverview } = await import("@/server/services/campaigns/queries");
const { waitingReplyCountsByUser } = await import("@/server/services/dashboard/replies");
const { unconfirmedEmails } = await import("@/server/services/dashboard/unconfirmed");
const { loadInboxCheck } = await import("@/server/services/sending/inbox-check");
const { APPLY_TEXTS } = await import("@/server/services/mailgun/apply-settings");

if (lower(backups.backupFolderFor(target, ROOT)) !== lower(backupDir)) refuse(`The app keeps this database's backups elsewhere (${backups.backupFolderFor(target, ROOT)}).`);

// ───────────────────────── time and small helpers ─────────────────────────

const SECOND_MS = 1000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date();
const ZONE = E2E_TIME_ZONE;
/** The sending domain: Mailgun's subdomain, or in the own state the own mailbox's domain itself (MAIN-DOMAIN-DESIGN O7). */
const DOMAIN = state === "own" ? E2E_OWN_DOMAIN : "send.example.com";
const OLD_DOMAIN = "mail.example.com";
const MAILGUN_KEY = "key-fake-api";
const SIGNING_KEY = "key-fake-signing";
const CLAUDE_KEY = "sk-ant-fake-key";
const MODEL = HAIKU_MODEL;
/** The busy state's second folder: a USB stick that isn't plugged in (the seed never touches it). */
const BUSY_SECOND_FOLDER = "E:\\Outreach backups";

/** `ms` before now. */
const ago = (ms: number) => new Date(now.getTime() - ms);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const iso = (d: Date) => d.toISOString();

type Actor = { id: number; name: string };
/** What each state adds to the manifest (the run adds the rest: version, state, time, database, port, users, From, mode). */
type SeedFacts = Omit<SeedManifest, "version" | "state" | "seededAt" | "database" | "port" | "users" | "fromAddress" | "replies">;
type SeedCompany = { id: number; name: string; domain: string; personId: number | null; personName: string | null; email: string | null };

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`Seed check failed (${state}): ${message}`);
}

/** `count` moments spread evenly over [from, to). */
function spread(from: Date, to: Date, count: number): Date[] {
  const span = Math.max(0, to.getTime() - from.getTime());
  return Array.from({ length: count }, (_, i) => new Date(from.getTime() + Math.floor((span * (i + 0.5)) / Math.max(1, count))));
}

/** Two queues mixed in proportion (A, A, B, A, A, B…), so both campaigns send every day. */
function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && i * b.length <= j * a.length)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

/** "2026-09-22_14-05-00" in the PC's local time, as the scripts name their backups. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ───────────────────────── made-up companies (every address on *.example) ─────────────────────────

// The names come from scripts/lib/seed-m6-values.ts (madeUpCompanyName), where they are unit-tested.
const FIRST = ["Anna", "Jonas", "Lena", "Felix", "Mia", "Paul", "Emma", "Lukas", "Sofia", "Noah", "Clara", "Elias", "Ida", "Ole", "Nora", "Henrik", "Maja", "Lars", "Freya", "Sven"] as const;
const LAST = ["Berg", "Weber", "Hansen", "Fischer", "Larsen", "Wagner", "Nilsen", "Becker", "Holm", "Richter", "Dahl", "Koch", "Lund", "Vogel", "Strand", "Keller", "Moen", "Braun", "Sand", "Wolf"] as const;
const NICHES = ["Figurines", "Miniatures", "Tabletop terrain", "Resin kits", "3D printing service", "Collectibles"] as const;
const COUNTRIES_DE = ["DE", "AT", "CH"] as const;
const COUNTRIES_NORDIC = ["NO", "SE", "DK"] as const;
const COUNTRIES_ALL = ["DE", "NL", "GB", "NO", "AT", "SE", "DK", "CH"] as const;

let companySeq = 0;

type CompanySpec = { name: string; domain: string; country: string; niche: string; person: { name: string; email: string } | null };

/** The next made-up company: unique name and *.example domain, one named person unless `withPerson` is false. */
function nextCompany(countries: readonly string[] = COUNTRIES_ALL, withPerson = true): CompanySpec {
  const i = companySeq++;
  const name = madeUpCompanyName(i);
  const domain = madeUpDomain(name);
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]!;
  return {
    name,
    domain,
    country: countries[i % countries.length]!,
    niche: NICHES[i % NICHES.length]!,
    person: withPerson ? { name: `${first} ${last}`, email: `${first.toLowerCase()}@${domain}` } : null,
  };
}

async function addCompany(spec: CompanySpec, actor: Actor, opts: { status?: CompanyStatusValue; listId?: number | null } = {}): Promise<SeedCompany> {
  const res = await createCompany(
    {
      name: spec.name,
      website: `https://www.${spec.domain}`,
      country: spec.country,
      niche: spec.niche,
      status: opts.status,
      listId: opts.listId ?? null,
      person: spec.person,
    },
    actor,
    { force: true },
  );
  if (res.kind !== "created") throw new Error(`${spec.name}: ${res.message}`);
  return { id: res.companyId, name: res.companyName, domain: spec.domain, personId: res.personId, personName: spec.person?.name ?? null, email: spec.person?.email ?? null };
}

async function addCompanies(count: number, actor: Actor, opts: { countries?: readonly string[]; status?: CompanyStatusValue; listId?: number | null; withPerson?: boolean } = {}): Promise<SeedCompany[]> {
  const out: SeedCompany[] = [];
  for (let i = 0; i < count; i++) out.push(await addCompany(nextCompany(opts.countries, opts.withPerson ?? true), actor, opts));
  return out;
}

async function newList(name: string, actor: Actor): Promise<number> {
  const res = await createList(name, actor);
  if (!res.ok) throw new Error(res.error);
  return res.list.id;
}

/** Address checks by the fake Mailgun (VALID, low risk): they count for live sending while the app uses the fake (D10). */
async function markChecked(companies: readonly SeedCompany[], checkedAt: Date): Promise<void> {
  const people = companies.filter((c): c is SeedCompany & { personId: number; email: string } => c.personId !== null && c.email !== null);
  for (let i = 0; i < people.length; i += 200) {
    const chunk = people.slice(i, i + 200);
    await dbTx(async (tx) => {
      await tx.person.updateMany({
        where: { id: { in: chunk.map((p) => p.personId) } },
        data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: checkedAt, verificationProvider: "mailgun-fake", verificationUnknowns: 0 },
      });
      await tx.verificationCheck.createMany({
        data: chunk.map((p) => ({
          personId: p.personId,
          emailNorm: p.email.toLowerCase(),
          provider: "mailgun-fake",
          status: "VALID" as const,
          risk: "LOW" as const,
          costUsd: 0.012,
          source: "contacts",
          checkedAt,
        })),
      });
    });
  }
}

// ───────────────────────── users, Mailgun, the checklist ─────────────────────────

const replyInboxOf = (name: string) => `${name.toLowerCase()}.replies@example.com`;

async function makeUsers(): Promise<{ owner: SeedUser; member: SeedUser }> {
  const out = {} as { owner: SeedUser; member: SeedUser };
  for (const key of ["owner", "member"] as const) {
    const u = E2E_USERS[key];
    const passwordHash = await hashPassword(u.password);
    const row = await dbWrite((c) =>
      c.user.create({
        data: {
          email: u.email,
          name: u.name,
          role: u.role,
          passwordHash,
          timeZone: ZONE,
          replyInbox: replyInboxOf(u.name),
          senderDisplayName: `${u.name} from Polygon Paradise`,
          signature: `${u.name}\nPolygon Paradise`,
          createdAt: ago((key === "owner" ? 60 : 45) * DAY),
        },
      }),
    );
    out[key] = { id: row.id, name: row.name, email: u.email, password: u.password, role: u.role, timeZone: ZONE };
  }
  return out;
}

const actorOf = (u: SeedUser): Actor => ({ id: u.id, name: u.name });

/** The main domain of the shared From address (example.com), or null in per-person mode. */
const TEAM_ORG: string | null = teamFrom ? domainOfAddress(teamFrom) : null;
/** The made-up mail provider fake mode answers with for the main domain's MX (SHARED-FROM-DESIGN §5). */
const FAKE_MAIL_PROVIDER_MX = "mx.mail-provider.invalid";

type ChecklistSeed = { key: ChecklistRowKey; group: ChecklistGroup; status: CheckStatus; text: string };

/**
 * The Domain checklist's rows (checklist.ts's groups and titles), every one done, as checked at `checkedAt`. Shared-From
 * mode (SHARED-FROM-DESIGN §3.2): the DKIM, DMARC, reply-test and Gmail-dashboard rows speak of the From address and
 * its domain, and the main domain's two rows follow DMARC, titled with the From domain (checklistTitle(key,
 * "example.com")); per-person mode keeps exactly the rows of before.
 */
function checklistSeeds(checkedAt: Date): ChecklistSeed[] {
  const org = TEAM_ORG;
  const decided = formatShortDate(iso(plus(checkedAt, -2 * DAY)), ZONE, checkedAt);
  const team: ChecklistSeed[] =
    teamFrom && org
      ? [
          { key: "from-mx", group: "dns", status: "ok", text: `Mail for ${org} goes to your mail provider (${FAKE_MAIL_PROVIDER_MX}), not to Mailgun. Keep it that way.` },
          { key: "from-spf", group: "dns", status: "ok", text: `${org}'s SPF record is fine (1 of 10 DNS lookups). The app's emails don't use it; they use ${DOMAIN}'s.` },
        ]
      : [];
  return [
    { key: "mailgun-domain", group: "mailgun", status: "ok", text: `Mailgun knows ${DOMAIN} and has checked its DNS records.` },
    { key: "spf", group: "dns", status: "ok", text: "The SPF record includes Mailgun." },
    {
      key: "dkim",
      group: "dns",
      status: "ok",
      text: org ? `Your emails carry ${org}'s digital signature (2048-bit), which matches your From address.` : "Mailgun's signing key is published (2048-bit).",
    },
    { key: "mx", group: "dns", status: "ok", text: "Replies go to Mailgun." },
    { key: "tracking-cname", group: "dns", status: "ok", text: `email.${DOMAIN} points to Mailgun.` },
    { key: "https-links", group: "dns", status: "ok", text: "Unsubscribe links use https." },
    { key: "dmarc", group: "dns", status: "ok", text: org ? `${org}'s policy: monitor only. Right for now.` : "Policy: quarantine." },
    ...team,
    { key: "tracking-off", group: "settings", status: "ok", text: "Open and click tracking are off." },
    { key: "unsubscribe", group: "settings", status: "ok", text: "Mailgun adds the unsubscribe link and header." },
    { key: "spam-filter", group: "settings", status: "ok", text: "Spam is marked, never deleted." },
    { key: "retention", group: "settings", status: "ok", text: "Replies are kept for 3 days." },
    { key: "signing-key", group: "settings", status: "ok", text: "The webhook signing key is saved." },
    { key: "webhooks", group: "settings", status: "ok", text: "Mailgun reports deliveries, bounces, complaints and unsubscribes to the app." },
    { key: "reply-routes", group: "settings", status: "ok", text: "Replies reach Arslan and Ali." },
    { key: "sending-allowed", group: "settings", status: "ok", text: `Mailgun accepts emails from ${DOMAIN}.` },
    { key: "monthly-limit", group: "settings", status: "ok", text: "Mailgun stops at 10,000 emails a month." },
    { key: "remote-access", group: "connection", status: "ok", text: "Remote access works." },
    {
      key: "reply-test",
      group: "connection",
      status: "ok",
      text: teamFrom
        ? `Setup A passed on ${decided} with the From address ${teamFrom}: replies arrive in your inbox, unsubscribe links work, and the test email passed DMARC.`
        : "Passed with Setup A.",
    },
    {
      key: "postmaster",
      group: "optional",
      status: "info",
      text: org ? `Optional: see how Gmail rates ${org}, the domain in your From address.` : "Optional: add the domain to Gmail's Postmaster Tools.",
    },
    { key: "domain-age", group: "optional", status: "ok", text: "Bought more than 30 days ago." },
  ];
}

function checklistRows(checkedAt: Date): ChecklistRow[] {
  return checklistSeeds(checkedAt).map((r) => ({
    key: r.key,
    group: r.group,
    status: r.status,
    // The main domain's rows are titled with the From domain, never the sending domain (SHARED-FROM-DESIGN §3.2).
    title: checklistTitle(r.key, (r.key === "from-mx" || r.key === "from-spf") && TEAM_ORG ? TEAM_ORG : DOMAIN),
    text: r.text,
    fix: null,
    records: [],
    detail: null,
  }));
}

/**
 * Shared-From mode: the reply test's emails to each test-list mailbox, sent with the shared From address (TestSend rows
 * with `teamFrom`, SHARED-FROM-DESIGN F26) at `sentAt`, and what the Owner's pasted original of the first one showed
 * (F25): the return address and the unsubscribe mailto on the sending domain, DMARC pass, signed by the main domain.
 */
async function teamReplyTestEmails(owner: SeedUser, testList: readonly string[], sentAt: Date): Promise<ReplyTestOriginal> {
  const from = teamFrom!;
  const sends: Array<{ id: number; to: string }> = [];
  for (const to of testList) {
    const messageId = replyTestMessageId(9001, to, DOMAIN);
    sends.push(
      await dbWrite((c) =>
        c.testSend.create({
          data: { userId: owner.id, to, subject: REPLY_TEST_SUBJECT, mode: "TEST", purpose: "REPLY_TEST", status: "SENT", messageId, providerId: messageId, teamFrom: from, sentAt },
          select: { id: true, to: true },
        }),
      ),
    );
  }
  const first = sends[0]!;
  return {
    domain: DOMAIN,
    from,
    address: first.to,
    testSendId: first.id,
    returnPathDomain: DOMAIN,
    returnPathOk: true,
    dmarc: "pass",
    dkimSigner: TEAM_ORG,
    mailtoDomain: DOMAIN,
    mailtoOk: true,
    readAt: iso(plus(sentAt, 30 * MINUTE)),
  };
}

/**
 * Mailgun "connected" to the fake's defaults (send.example.com, EU, key-fake-api, key-fake-signing), both users with a
 * sending address whose reply route works, the checklist green as of `checkedAt`, the reply test passed with Setup A,
 * the test list, and the fake Claude's key. Returns the SendingDomain id.
 *
 * Shared-From mode (ready and live, SHARED-FROM-DESIGN §8 P6): Setting "mailgun.fromAddress" is written first and its
 * change time put three days before `checkedAt` (going live needs a check newer than the last From change, and only
 * evidence sent after it counts, F26); the reply test passed for that From address, with its emails and one original.
 */
async function connectFakeMailgun(owner: SeedUser, member: SeedUser, checkedAt: Date, testList: string[]): Promise<number> {
  await setSetting("practice.copy", false, owner.id);
  await setSetting("mailgun.domain", DOMAIN, owner.id);
  await setSetting("mailgun.region", "EU", owner.id);
  if (teamFrom) {
    await setSetting("mailgun.fromAddress", teamFrom, owner.id);
    await dbWrite((c) => c.setting.update({ where: { key: "mailgun.fromAddress" }, data: { updatedAt: plus(checkedAt, -3 * DAY) } }));
  }
  await setSecret("mailgun.apiKey", MAILGUN_KEY, owner.id);
  await setSecret("mailgun.webhookSigningKey", SIGNING_KEY, owner.id);
  await setSecret("anthropic.apiKey", CLAUDE_KEY, owner.id);
  const domain = await dbWrite((c) => c.sendingDomain.create({ data: { name: DOMAIN, region: "EU", active: true, createdAt: ago(40 * DAY) } }));
  for (const u of [owner, member]) {
    const local = u.name.toLowerCase();
    await dbWrite((c) =>
      c.senderAddress.create({
        data: {
          userId: u.id,
          domainId: domain.id,
          localPart: local,
          address: `${local}@${DOMAIN}`,
          routeStatus: "ok",
          forwardTo: replyInboxOf(u.name),
          routeCheckedAt: checkedAt,
          mailgunRouteId: `seed-route-${local}`,
        },
      }),
    );
  }
  await setState(STATE_KEYS.domainCheck, { domain: DOMAIN, region: "EU", checkedAt: iso(checkedAt), lastVerifyAt: iso(checkedAt), rows: checklistRows(checkedAt), error: null });
  const decidedAt = plus(checkedAt, -2 * DAY);
  const passed: UnsubscribeTestSetting = {
    setup: "A",
    status: "passed",
    domain: DOMAIN,
    mailboxes: [],
    headersOk: true,
    decidedAt: iso(decidedAt),
    decidedById: owner.id,
    note: null,
  };
  // Shared-From mode: the pass belongs to the From address (F12), with the reply test's emails and pasted original.
  const replyTest: UnsubscribeTestSetting = teamFrom
    ? { ...passed, from: teamFrom, original: await teamReplyTestEmails(owner, testList, plus(decidedAt, -2 * HOUR)) }
    : passed;
  await setSetting("mailgun.unsubscribeTest", replyTest, owner.id);
  await setSetting("sending.testList", testList, owner.id);
  return domain.id;
}

/** The warm-up ramp of the current domain at step 0 (before go-live nothing is judged beyond the test list). */
async function warmupAtStart(anchor: Date): Promise<void> {
  await setState(STATE_KEYS.warmup, {
    domain: DOMAIN,
    step: 0,
    lastEvaluatedCapDay: addCapDays(capDayOf(anchor, ZONE), -1),
    startedCapDay: capDayOf(plus(anchor, -12 * DAY), ZONE),
    history: [],
  });
}

function catchUpOk(when: Date): CatchUpState {
  return {
    lastStartedAt: iso(plus(when, -MINUTE)),
    lastFinishedAt: iso(when),
    lastSuccessAt: iso(when),
    lastError: null,
    lastErrorKind: null,
    lastReason: "hourly",
    lastSummary: { domains: [DOMAIN], eventsApplied: 4, suppressionsAdded: 0, suppressionsPushed: 0, inboundStored: 0, duplicatesFound: 0 },
  };
}

/** Remote access as the monitor would record it on a PC with a healthy tunnel (the instances run in fake mode). */
async function tunnelConnected(when: Date): Promise<void> {
  const ok = { at: iso(when), ok: true, status: 200, error: null };
  await setState(STATE_KEYS.tunnel, {
    checkedAt: iso(when),
    state: "connected",
    readyConnections: 4,
    port: 20241,
    connectorId: "seed-connector",
    version: "2026.9.1",
    versionWarning: null,
    downSince: null,
    notifiedAt: null,
    publicCheck: ok,
    webhookPathCheck: ok,
    appProtectedCheck: { ...ok, status: 302, location: "https://team.cloudflareaccess.example/cdn-cgi/access/login" },
    selfCheckNonce: null,
  });
}

/** Periodic tasks recorded as just done, so the first hours of a worker neither back up nor ask anyone anything. */
async function tasksDone(tasks: Record<string, Date>): Promise<void> {
  for (const [name, at] of Object.entries(tasks)) await setState(`task.${name}`, { lastSuccessAt: iso(at) });
}

// ───────────────────────── campaigns, sending, replies, events ─────────────────────────

async function draftCampaign(actor: Actor, name: string, companies: readonly SeedCompany[], createdAt: Date): Promise<SeedRef> {
  const d = await draftService.createDraft(actor, { companyIds: companies.map((c) => c.id), name, timeZone: ZONE, now: createdAt });
  return { id: d.id, name: d.name };
}

async function launchAt(campaign: SeedRef, actor: Actor, when: Date): Promise<void> {
  const res = await launchCampaign(campaign.id, actor.id, { now: when });
  check(res.queued > 0, `${campaign.name} launched without anyone to email (${res.message})`);
}

async function queued(campaignId: number): Promise<Array<{ id: number; toNorm: string }>> {
  return db.outboundEmail.findMany({ where: { campaignId, step: 0, status: "QUEUED" }, orderBy: { id: "asc" }, select: { id: true, toNorm: true } });
}

/** Mailgun as the fake would answer: accepted at once, with our own Message-ID. Refuses any address that isn't ours to use. */
class SeedMailgunTransport implements EmailTransport {
  constructor(
    readonly mode: SendMode,
    private readonly acceptedAt: Date,
  ) {}

  async send(message: OutgoingMessage): Promise<TransportResult> {
    if (!isSafeAddress(message.toNorm)) throw new Error(`Refusing to "send" to ${message.toNorm}: not an example address.`);
    return { providerId: message.messageId, acceptedAt: this.acceptedAt };
  }
}

/** One email through the sending loop's own claim, checks, rendering and markSent, as if sent at `when`. */
async function sendAt(emailId: number, when: Date): Promise<void> {
  const outcome = await sendOneEmail(emailId, {
    now: () => when,
    gatedEmailId: emailId,
    transportFor: (mode) => (mode === "DRY_RUN" ? new DryRunTransport(() => when) : new SeedMailgunTransport(mode, when)),
  });
  check(outcome === "sent", `email #${emailId} wasn't sent (${outcome})`);
}

/** A claimed email whose hand-over the reconciler couldn't confirm: "Unconfirmed", waiting for Retry or Skip. */
async function leaveUnconfirmed(emailId: number, when: Date): Promise<void> {
  check(await claimEmail(emailId, when), `email #${emailId} couldn't be claimed`);
  const row = await db.outboundEmail.findUniqueOrThrow({ where: { id: emailId }, select: { recipientId: true, step: true } });
  const rendered = await renderCampaignEmail({ recipientId: row.recipientId, step: row.step, purpose: "send" });
  await dbWrite((c) =>
    c.outboundEmail.update({
      where: { id: emailId },
      data: { subject: rendered.subject, text: rendered.text, html: rendered.html, status: "UNCONFIRMED", lastError: UNCONFIRMED_MESSAGE },
    }),
  );
}

let replySeq = 0;

/** A reply as Mailgun's notify would store it, then the one reply processor (classify, link, assign, stop, notify). */
async function receiveReply(input: { to: string; from: string; fromName: string; subject: string; text: string; inReplyTo: string | null; receivedAt: Date }): Promise<void> {
  replySeq += 1;
  const messageIdHeader = `seed-reply-${replySeq}.${input.receivedAt.getTime()}@${input.from.split("@")[1]}`;
  const headers: HeaderPair[] = [
    ["From", `${input.fromName} <${input.from}>`],
    ["To", input.to],
    ["Subject", input.subject],
    ["Message-Id", `<${messageIdHeader}>`],
  ];
  if (input.inReplyTo) headers.push(["In-Reply-To", `<${input.inReplyTo}>`], ["References", `<${input.inReplyTo}>`]);
  headers.push(["Content-Type", "text/plain; charset=utf-8"]);
  const parsed: ParsedInbound = {
    recipient: input.to,
    fromEmail: input.from,
    fromName: input.fromName,
    subject: input.subject,
    snippet: input.text.replace(/\s+/g, " ").trim().slice(0, 300),
    messageIdHeader,
    inReplyTo: input.inReplyTo,
    references: input.inReplyTo ? [input.inReplyTo] : [],
    headers,
    storageKey: `seed-m6-${state}-${replySeq}`,
    messageUrl: null,
    receivedAt: input.receivedAt,
    envelopeSender: input.from,
    strippedText: input.text,
    bodyText: input.text,
    bodyAvailable: true,
  };
  const stored = await dbTx((tx) => storeInbound(tx, parsed, "NOTIFY"));
  await processInboundMessage(stored.id, { now: plus(input.receivedAt, 30_000) });
}

/** A Mailgun event for one of our emails, stored as a webhook would (delivered, or a permanent bounce). */
async function mailEvent(emailId: number, type: "delivered" | "failed", when: Date): Promise<void> {
  const e = await db.outboundEmail.findUniqueOrThrow({ where: { id: emailId }, select: { messageId: true, sendId: true, toNorm: true } });
  const bounce = type === "failed";
  const ev: NormalizedEvent = {
    dedupeKey: `seed-${type}-${emailId}:${iso(when).slice(0, 10)}`,
    providerEventId: `seed-${type}-${emailId}`,
    type,
    severity: bounce ? "permanent" : null,
    reason: bounce ? "bounce" : null,
    occurredAt: when,
    messageId: e.messageId,
    recipient: e.toNorm,
    userVariables: { send_id: e.sendId },
    tags: [],
    isTestMode: false,
    domain: DOMAIN,
    deliveryStatus: bounce
      ? { code: 550, message: "5.1.1 The email account that you tried to reach does not exist.", description: null, bounceType: "hard" }
      : { code: 250, message: "OK", description: null, bounceType: null },
    raw: { seed: true },
  };
  await applyMailEventNow(ev, "WEBHOOK", { now: when });
}

/** The event lane's work for the stored events (notifications and activity). */
async function processEvents(when: Date): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await processPendingMailEvents({ now: when })).processed === 0) return;
}

// ───────────────────────── AI lines waiting for review ─────────────────────────

const QUOTES = [
  "Every figure is sculpted by hand in our own studio.",
  "We print tabletop terrain for clubs all over Europe.",
  "Our resin kits come unpainted, ready for your own colours.",
  "Small batches, big details: we love one-off commissions.",
  "We have been casting miniatures since 2009.",
  "Fantasy and sci-fi figures for collectors and gamers.",
] as const;
const LINES = [
  "Your hand-sculpted figures caught my eye; our 3D models could speed up the first sculpt.",
  "Terrain for clubs all over Europe is a lot of printing; we model scenery that prints cleanly.",
  "Unpainted resin kits need crisp detail, which is exactly what our models are built for.",
  "One-off commissions are our favourite kind of project too.",
  "After fifteen years of casting you know good masters; we make them print-ready.",
  "Collectors notice detail, and our fantasy and sci-fi models are made for close looks.",
] as const;

async function aiLinesToReview(companies: readonly SeedCompany[], by: Actor, at: Date): Promise<void> {
  for (const [i, c] of companies.entries()) {
    const quote = QUOTES[i % QUOTES.length]!;
    const url = `https://www.${c.domain}/`;
    const text = `${c.name}\n\nAbout us\n${quote} Orders ship worldwide within two weeks.`;
    const snapshot = await dbWrite((tx) =>
      tx.websiteSnapshot.create({
        data: { companyId: c.id, url, finalUrl: url, pageKind: "homepage", httpStatus: 200, title: c.name, contentType: "text/html", bytes: text.length * 2, text, chars: text.length, lang: "en", fetchedAt: at },
      }),
    );
    await dbWrite((tx) =>
      tx.aiDraft.create({
        data: {
          companyId: c.id,
          createdById: by.id,
          model: MODEL,
          promptVersion: PROMPT_VERSION,
          status: "READY",
          line: LINES[i % LINES.length]!,
          evidenceQuote: quote,
          evidenceSource: "homepage",
          evidenceUrl: url,
          flags: [],
          inputTokens: 3000,
          outputTokens: 120,
          costUsd: 0.0036,
          calls: 1,
          draftedAt: at,
          homeSnapshotId: snapshot.id,
          createdAt: plus(at, -2 * MINUTE),
        },
      }),
    );
  }
}

// ───────────────────────── the states ─────────────────────────

async function seedEmpty(): Promise<SeedFacts> {
  // The default sequences, as the Templates page adds them on first open, without their activity line (so the
  // dashboard's "Recent team activity" stays empty however the checks visit the pages).
  await ensureDefaultTemplates();
  await dbWrite((c) => c.activityLog.deleteMany({ where: { type: "template.created" } }));
  await checkDatabaseInstance({ now, markerSeen: false });
  await tunnelConnected(ago(2 * MINUTE));
  // No backup: Settings › Backups says "No backup has been made yet." (and the worker makes none for 12 hours).
  await tasksDone({ "backup.daily": now, "cleanup.daily": now });
  check((await db.company.count()) === 0, "the empty state has companies");
  check((await db.activityLog.count()) === 0, "the empty state has activity");
  return { sendingDomain: null, testList: [], secondFolder: null, backupFolder: rel(backupDir).replace(/\\/g, "/") };
}

async function seedBusy(owner: SeedUser, member: SeedUser): Promise<SeedFacts> {
  const O = actorOf(owner);
  const A = actorOf(member);
  // Tia's address is a long one, so the Test list card is checked with it on a phone (review SCREENS-08).
  const testList = ["tess@inbox-one.example", "tom@inbox-two.example", LONG_VALUES.testAddress];
  await connectFakeMailgun(owner, member, ago(20 * MINUTE), testList);
  // A switched-off teammate with a long address, for Settings › Team on a phone (review SCREENS-12). Switched off, so
  // no reply, route, count or notification involves them.
  await dbWrite((c) =>
    c.user.create({
      data: { email: LONG_VALUES.teammate.email, name: LONG_VALUES.teammate.name, role: "MEMBER", active: false, timeZone: ZONE, createdAt: ago(30 * DAY) },
    }),
  );
  await warmupAtStart(now);
  await checkDatabaseInstance({ now: ago(3 * HOUR), markerSeen: false });

  // 60 companies: 3 test mailboxes, 8 without an email address, 49 with one in every status.
  const germany = await newList("Germany Q4 prospects", O);
  const nordics = await newList("Nordics", A);
  const mailboxes = await newList("Test mailboxes", O);
  const testers = ["Tess", "Tom", "Tia"];
  const testCompanies: SeedCompany[] = [];
  for (const [i, email] of testList.entries()) {
    testCompanies.push(
      await addCompany(
        { name: `Test mailbox ${testers[i]}`, domain: email.split("@")[1]!, country: "DE", niche: "Test mailbox", person: { name: `${testers[i]} Tester`, email } },
        O,
        { listId: mailboxes },
      ),
    );
  }
  await addCompanies(8, O, { withPerson: false, listId: germany });
  const byStatus = new Map<CompanyStatusValue, SeedCompany[]>();
  const statusPlan: Array<[CompanyStatusValue, number]> = [
    ["NOT_CONTACTED", 25],
    ["CONTACTED", 10],
    ["REPLIED", 5],
    ["CLIENT", 3],
    ["NOT_INTERESTED", 4],
    ["DO_NOT_CONTACT", 2],
  ];
  for (const [status, count] of statusPlan) {
    const made: SeedCompany[] = [];
    for (let i = 0; i < count; i++) made.push(await addCompany(nextCompany(), i % 2 === 0 ? O : A, { status, listId: i % 3 === 2 ? nordics : germany }));
    byStatus.set(status, made);
  }
  const fresh = byStatus.get("NOT_CONTACTED")!;

  // 12 AI lines waiting for review.
  await aiLinesToReview(fresh.slice(0, 12), A, ago(5 * HOUR));

  // Two paused dry runs and a running one (sending mode: dry run).
  const germanyQ4 = await draftCampaign(O, "Germany Q4", fresh.slice(0, 8), ago(4 * DAY));
  await launchAt(germanyQ4, O, ago(3 * DAY));
  for (const [i, e] of (await queued(germanyQ4.id)).slice(0, 4).entries()) await sendAt(e.id, plus(ago(3 * DAY), (i + 1) * 3 * MINUTE));
  await pauseCampaign(germanyQ4.id, O.id, { now: ago(DAY) });

  const nordicsCampaign = await draftCampaign(A, "Nordics", fresh.slice(8, 14), ago(3 * DAY));
  await launchAt(nordicsCampaign, A, ago(2 * DAY));
  for (const [i, e] of (await queued(nordicsCampaign.id)).slice(0, 3).entries()) await sendAt(e.id, plus(ago(2 * DAY), (i + 1) * 4 * MINUTE));
  await pauseCampaign(nordicsCampaign.id, A.id, { reason: "Waiting for the new price list", now: ago(20 * HOUR) });

  // The running dry run sends today (the cap day in Karachi), then someone simulates a reply to its first email.
  const todayStart = capDayBounds(capDayOf(now, ZONE), ZONE).start;
  let dryFrom = new Date(Math.max(todayStart.getTime() + MINUTE, now.getTime() - 2 * HOUR));
  if (now.getTime() - dryFrom.getTime() < 2 * MINUTE) dryFrom = ago(2 * HOUR);
  const spring = await draftCampaign(A, "Spring figures (dry run)", fresh.slice(14, 25), plus(dryFrom, -20 * MINUTE));
  await launchAt(spring, A, plus(dryFrom, -10 * MINUTE));
  const springQueue = (await queued(spring.id)).slice(0, 8);
  const springTimes = spread(dryFrom, ago(MINUTE), springQueue.length);
  for (const [i, e] of springQueue.entries()) await sendAt(e.id, springTimes[i]!);
  await simulateReply(A, springQueue[0]!.id, "reply", { now: ago(30 * SECOND_MS) });

  // A live campaign to the test list (before go-live it can only reach it): one sent, two unconfirmed.
  await setSetting("sending.mode", "LIVE", owner.id);
  const rehearsal = await draftCampaign(A, "Mailbox rehearsal", testCompanies, ago(6 * HOUR));
  await launchAt(rehearsal, A, ago(5 * HOUR));
  const rehearsalQueue = await queued(rehearsal.id);
  check(rehearsalQueue.length === 3, `the test-list campaign queued ${rehearsalQueue.length} emails, not 3`);
  const tess = rehearsalQueue.find((r) => r.toNorm === testList[0])!;
  await sendAt(tess.id, ago(4 * HOUR));
  for (const r of rehearsalQueue.filter((r) => r.id !== tess.id)) await leaveUnconfirmed(r.id, plus(ago(4 * HOUR), 2 * MINUTE));
  await dbWrite((c) => c.sendingDomain.update({ where: { name: DOMAIN }, data: { lastLiveSendAt: ago(4 * HOUR) } }));

  // Replies waiting for an answer: Tess answers Ali's live email; three contacts write to Arslan.
  const sent = await db.outboundEmail.findUniqueOrThrow({ where: { id: tess.id }, select: { subject: true, messageId: true } });
  await receiveReply({
    to: `ali@${DOMAIN}`,
    from: testList[0]!,
    fromName: "Tess Tester",
    subject: `Re: ${sent.subject}`,
    text: "Hi Ali,\n\nThis one arrived in my inbox, not in spam, and the links work.\n\nTess",
    inReplyTo: sent.messageId,
    receivedAt: ago(3 * HOUR),
  });
  const contacted = byStatus.get("CONTACTED")!.slice(0, 3);
  const ownerReplies = [
    { subject: "Figures for our spring range", text: "Hi Arslan,\n\nThanks for getting in touch last month. Could you send a few examples and your prices for a small batch?\n\nBest regards," },
    { subject: "Question about 3D models", text: "Hello Arslan,\n\nWe spoke at the fair. Do you also make models for resin printing? We would like to hear more.\n\nKind regards," },
    { subject: "Your email from September", text: "Hi Arslan,\n\nSorry for the late answer. Yes, we are interested. When could we have a short call?\n\nThanks," },
  ];
  for (const [i, c] of contacted.entries()) {
    const r = ownerReplies[i]!;
    await receiveReply({ to: `arslan@${DOMAIN}`, from: c.email!, fromName: c.personName!, subject: r.subject, text: `${r.text}\n${c.personName}`, inReplyTo: null, receivedAt: ago((5 - i * 1.5) * HOUR) });
  }

  // Backups: daily, Back up now, and the newest daily 40 hours old; update.bat's own backup. The second folder (a
  // stick that isn't plugged in) was chosen before the newest backup, which therefore should have been copied.
  const first = await backups.runBackup({ kind: "AUTO", now: ago(4 * DAY + 2 * HOUR) });
  await backups.runBackup({ kind: "MANUAL", userId: member.id, now: ago(3 * DAY) });
  const newest = await backups.runBackup({ kind: "AUTO", now: ago(40 * HOUR) });
  fs.copyFileSync(path.join(backupDir, first.fileName), path.join(backupDir, `app-preupdate-${localStamp(ago(5 * DAY))}.db`));
  await setSetting("backups.secondFolder", BUSY_SECOND_FOLDER, owner.id);
  await dbWrite((c) => c.setting.update({ where: { key: "backups.secondFolder" }, data: { updatedAt: ago(6 * DAY) } }));

  // The check with Mailgun failing for 3 hours, and an older domain it couldn't check for 2 days.
  await dbWrite((c) => c.sendingDomain.create({ data: { name: OLD_DOMAIN, region: "EU", active: false, lastLiveSendAt: ago(20 * DAY), createdAt: ago(90 * DAY) } }));
  await setState(STATE_KEYS.catchUp, {
    lastStartedAt: iso(ago(12 * MINUTE)),
    lastFinishedAt: iso(ago(11 * MINUTE)),
    lastSuccessAt: iso(ago(3 * HOUR)),
    lastError: "Mailgun didn't answer in time.",
    lastErrorKind: "network",
    lastReason: "hourly",
    lastSummary: { domains: [DOMAIN, OLD_DOMAIN], eventsApplied: 2, suppressionsAdded: 0, suppressionsPushed: 0, inboundStored: 1, duplicatesFound: 0 },
    oldDomains: [{ domain: OLD_DOMAIN, since: iso(ago(2 * DAY + 3 * HOUR)), lastAt: iso(ago(11 * MINUTE)), text: "Mailgun didn't answer in time." }],
  } satisfies CatchUpState);

  // Address checks and AI drafting paused, and sending paused for bounces (after every send above).
  const checksText = checkPauseText("auth");
  await pauseChecks("auth", checksText, null, { now: ago(2 * HOUR) });
  const aiText = aiPauseText("key_rejected", { model: MODEL });
  await pauseAi("key_rejected", { text: aiText, until: null, model: MODEL, now: ago(90 * MINUTE) });
  const verdict = evaluateHealth(
    { bounces: 7, bounceSample: 200, complaints: 0, complaintSample: 200 },
    { bounceWindow: 200, bouncePercent: 3, complaintWindow: 1000, complaintPercent: 0.1 },
    { bounce: false, complaint: false },
  );
  const pause = verdict.pause!;
  await pauseSending({ kind: pause.kind, reason: pause.reason, fixText: pause.fixText, detail: pause.detail, now: ago(50 * MINUTE) });

  await tunnelConnected(ago(2 * MINUTE));
  await tasksDone({ "backup.daily": ago(40 * HOUR), "cleanup.daily": now, "mailgun.domainCheck.6h": now });

  // The facts, read back through the app's own services.
  const waiting = await waitingReplyCountsByUser();
  const waitingOf = (id: number) => waiting.find((w) => w.userId === id)?.count ?? 0;
  const dryRunWaiting = await db.inboundMessage.count({ where: waitingReplyWhere(undefined, { dryRun: "only" }) });
  check(waitingOf(owner.id) === 3 && waitingOf(member.id) === 1 && dryRunWaiting === 1, `replies waiting: ${JSON.stringify(waiting)} and ${dryRunWaiting} dry-run`);
  const aiWaiting = (await aiQueueCounts()).waiting;
  check(aiWaiting === 12, `${aiWaiting} AI lines to review, not 12`);
  const unconfirmed = (await unconfirmedEmails()).count;
  check(unconfirmed === 2, `${unconfirmed} unconfirmed emails, not 2`);
  const paused = await db.campaign.count({ where: { status: "PAUSED" } });
  check(paused === 2, `${paused} paused campaigns, not 2`);
  const missing = await db.company.count({ where: { deletedAt: null, people: { none: { deletedAt: null, email: { not: null } } } } });
  check(missing === 8, `${missing} companies without an email, not 8`);
  const companies = await db.company.count({ where: { deletedAt: null } });
  check(companies === 60, `${companies} companies, not 60`);
  const status = await backups.backupStatus(now);
  check(status.age === "stale" && status.newest?.fileName === newest.fileName, `the newest backup is ${status.age} (${status.newest?.fileName})`);
  check(status.lastCopyFailed && !status.workerRunning, `copy failed ${status.lastCopyFailed}, worker running ${status.workerRunning}`);
  const kinds = [...new Set((await backups.listBackups()).map((b) => backups.backupKindText(b.kind)))];
  for (const k of ["Daily backup", "Back up now", "Before an update"]) check(kinds.includes(k), `no "${k}" backup listed`);
  const catchUp = (await readTyped(STATE_KEYS.catchUp, parseCatchUpState)).value;
  check(catchUpFailing(catchUp) && oldDomainLines(catchUp, ZONE, now).length === 1, "the check with Mailgun isn't failing with one old domain");
  const sendingPause = await getPauseState();
  check(sendingPause.paused && sendingPause.kind === "health-bounce", "sending isn't paused for bounces");
  check((await getChecksPause(now)).paused && (await getAiPause(now)).paused, "address checks or AI drafting aren't paused");
  const running = await db.campaign.count({ where: { status: "RUNNING" } });
  check(running === 2, `${running} running campaigns, not 2 (the dry run and the test-list campaign)`);
  const switchedOff = await db.user.count({ where: { email: LONG_VALUES.teammate.email, active: false } });
  check(switchedOff === 1 && (await db.user.count({ where: { active: true } })) === 2, "the switched-off teammate is missing, or a third teammate is active");

  const busy: BusyFacts = {
    pause: { reason: sendingPause.reason, fixText: sendingPause.fixText },
    pausedCampaigns: [germanyQ4, nordicsCampaign],
    waiting: { owner: waitingOf(owner.id), member: waitingOf(member.id), dryRun: dryRunWaiting },
    aiLinesWaiting: aiWaiting,
    unconfirmed,
    missingEmails: missing,
    companies,
    newestBackup: { at: iso(status.newest!.at), fileName: newest.fileName },
    backupKinds: ["Daily backup", "Back up now", "Before an update"],
    secondFolder: BUSY_SECOND_FOLDER,
    catchUp,
    checksPauseText: checksText,
    aiPauseText: aiText,
    dryRunCampaign: spring,
    testListCampaign: rehearsal,
  };
  return { sendingDomain: DOMAIN, testList, secondFolder: BUSY_SECOND_FOLDER, backupFolder: rel(backupDir).replace(/\\/g, "/"), busy };
}

/**
 * The From address facts of ready and live, read back through the app's own services (SHARED-FROM-DESIGN §8 P6):
 * shared-From mode — the saved From address fits and changed before the checklist's check, the checklist has the main
 * domain's MX row, the reply test passed for it with its original, and each launched campaign and every one of its
 * emails carries the team From line with the sender's own address as Reply-To; per-person mode (`--per-person`) —
 * none of that anywhere.
 */
async function checkFromAddress(checkedAt: Date, launched: readonly SeedRef[]): Promise<void> {
  const team = await loadTeamFrom();
  check(team.address === teamFrom && team.problem === null, `the From address is "${team.saved ?? "empty"}" (${team.problem ?? "fits"}), not "${teamFrom ?? "empty"}"`);
  const stored = (await db.systemState.findUniqueOrThrow({ where: { key: STATE_KEYS.domainCheck } })).value as { checkedAt?: string; rows?: ChecklistRow[] };
  const fromMx = (stored.rows ?? []).find((r) => r.key === "from-mx");
  check(stored.checkedAt === iso(checkedAt), `the checklist was checked at ${stored.checkedAt}, not ${iso(checkedAt)}`);
  check(
    teamFrom ? fromMx?.status === "ok" && fromMx.title === checklistTitle("from-mx", TEAM_ORG ?? "") : fromMx === undefined,
    `the main domain's MX row is ${fromMx ? `"${fromMx.title}" (${fromMx.status})` : "missing"}`,
  );
  const replyTest = (await db.setting.findUniqueOrThrow({ where: { key: "mailgun.unsubscribeTest" } })).value as UnsubscribeTestSetting;
  check((replyTest.from ?? null) === teamFrom, `the reply test passed for "${replyTest.from ?? "each person's own address"}"`);
  if (teamFrom) {
    check(team.changedAt !== null && team.changedAt.getTime() < checkedAt.getTime(), "the From address changed after the checklist's check");
    const counted = await db.testSend.count({ where: { purpose: "REPLY_TEST", teamFrom, sentAt: { gte: team.changedAt! } } });
    check(counted > 0 && replyTest.original?.from === teamFrom, "the reply test has no email or pasted original for the From address");
  }
  for (const c of launched) {
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: c.id }, select: { fromName: true, fromAddress: true, replyTo: true, senderId: true } });
    const own = (await db.senderAddress.findFirstOrThrow({ where: { userId: campaign.senderId!, retiredAt: null }, select: { address: true } })).address;
    const emails = await db.outboundEmail.findMany({ where: { campaignId: c.id }, select: { fromAddress: true, replyTo: true } });
    const wanted = teamFrom
      ? { from: teamFrom, replyTo: own, line: formatFromHeader(campaign.fromName ?? "", teamFrom) }
      : { from: own, replyTo: null, line: formatFromHeader(campaign.fromName ?? "", own) };
    check(campaign.fromAddress === wanted.from && campaign.replyTo === wanted.replyTo, `${c.name} was launched with From ${campaign.fromAddress} and Reply-To ${campaign.replyTo}`);
    check(
      emails.length > 0 && emails.every((e) => e.fromAddress === wanted.line && e.replyTo === wanted.replyTo),
      `${c.name}'s emails don't all show "${wanted.line}" with Reply-To ${wanted.replyTo}`,
    );
  }
}

/**
 * What shared-from.spec.ts opens (shared-From mode only; undefined per person): the Owner's own address (the Reply-To
 * the campaign page names), a draft for the wizard's Sender step, and a running campaign of the Owner's whose page shows
 * "replies to …" and the reminder, checked against the page's own overview (follow-ups still to come).
 */
async function sharedFromFacts(owner: SeedUser, draft: SeedRef, campaign: SeedRef): Promise<SharedFromFacts | undefined> {
  if (!teamFrom) return undefined;
  const ownerReplyTo = (await db.senderAddress.findFirstOrThrow({ where: { userId: owner.id, retiredAt: null }, select: { address: true } })).address;
  const o = await getCampaignOverview(campaign.id);
  check(
    o !== null && o.status === "RUNNING" && o.fromAddress === teamFrom && o.replyTo === ownerReplyTo,
    `${campaign.name} isn't a running shared-From campaign replying to ${ownerReplyTo}`,
  );
  check(o!.recipientCounts.active > 0 && o!.steps.some((s) => s.step > 0 && s.enabled), `${campaign.name} has no follow-ups to come`);
  const d = await db.campaign.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true, senderId: true } });
  check(d.status === "DRAFT" && d.senderId === owner.id, `${draft.name} isn't the Owner's draft`);
  return { ownerReplyTo, draft, campaign };
}

type ReadyPart = { draft: SeedRef & { people: number }; testRun: SeedRef; testCompany: SeedCompany; prospects: SeedCompany[]; testList: string[] };

/**
 * Everything green for going live, as of `anchor` (now for `ready`; the moment before going live for `live`): the
 * checklist checked at `anchor`, a live test email to Tess sent and delivered, a fresh Back up now copied to the second
 * folder, and the draft "Germany Q4" made a day earlier in dry run (so it ticked every eligible prospect).
 */
async function seedReadyAt(owner: SeedUser, member: SeedUser, anchor: Date, second: string): Promise<ReadyPart> {
  const O = actorOf(owner);
  const testList = ["tess@test-mailbox.example"];
  await connectFakeMailgun(owner, member, anchor, testList);
  await warmupAtStart(anchor);
  await checkDatabaseInstance({ now: plus(anchor, -3 * HOUR), markerSeen: false });
  const germany = await newList("Germany Q4 prospects", O);
  const mailboxes = await newList("Test mailboxes", O);
  const testCompany = await addCompany(
    { name: "Test mailboxes", domain: "test-mailbox.example", country: "DE", niche: "Test mailbox", person: { name: "Tess Tester", email: testList[0]! } },
    O,
    { listId: mailboxes },
  );
  const prospects = await addCompanies(30, O, { countries: COUNTRIES_DE, listId: germany });
  // One prospect with a long name, website host and address (LONG_VALUES): the wizard's steps and Contacts' first page
  // show it on a phone (review SCREENS-05 and the Review step).
  prospects.push(await addCompany(LONG_VALUES.company, O, { listId: germany }));
  await markChecked(prospects, plus(anchor, -10 * DAY));

  // Made yesterday in dry run: every eligible prospect is ticked (the go-live dialog lists it, G11).
  const draft = await draftCampaign(O, "Germany Q4", prospects, plus(anchor, -DAY));
  await draftService.setWizardStep(draft.id, 6);

  // The live test (§0.3): a live campaign to the test list, sent and delivered on this domain.
  await setSetting("sending.mode", "LIVE", owner.id);
  const testRun = await draftCampaign(O, "Test run", [testCompany], plus(anchor, -100 * MINUTE));
  await launchAt(testRun, O, plus(anchor, -90 * MINUTE));
  const [tessEmail] = await queued(testRun.id);
  await sendAt(tessEmail!.id, plus(anchor, -89 * MINUTE));
  await mailEvent(tessEmail!.id, "delivered", plus(anchor, -87 * MINUTE));
  await processEvents(plus(anchor, -86 * MINUTE));
  await dbWrite((c) => c.sendingDomain.update({ where: { name: DOMAIN }, data: { lastLiveSendAt: plus(anchor, -89 * MINUTE) } }));
  await setState(STATE_KEYS.catchUp, catchUpOk(plus(anchor, -5 * MINUTE)));

  // A fresh backup, copied to the second folder (runBackup writes the folder's marker with this database's id).
  fs.mkdirSync(second, { recursive: true });
  await setSetting("backups.secondFolder", second, owner.id);
  const backup = await backups.runBackup({ kind: "MANUAL", userId: owner.id, now: plus(anchor, -HOUR) });
  check(backup.copiedTo === second, `the backup wasn't copied to the second folder (${backup.copyError ?? "no error"})`);
  check(fs.existsSync(path.join(second, backups.SECOND_FOLDER_MARKER)), "the second folder has no marker");
  await tunnelConnected(plus(anchor, -2 * MINUTE));

  const people = await db.campaignRecipient.count({ where: { campaignId: draft.id, included: true } });
  check(people === prospects.length, `the draft ticked ${people} of ${prospects.length} prospects`);
  return { draft: { ...draft, people }, testRun, testCompany, prospects, testList };
}

async function seedReady(owner: SeedUser, member: SeedUser): Promise<SeedFacts> {
  const part = await seedReadyAt(owner, member, now, secondDir!);
  await tasksDone({ "backup.daily": ago(HOUR), "cleanup.daily": now, "mailgun.domainCheck.6h": now });

  // Without a background sender here, its blocker is the only one left; the instance's worker lifts it.
  const view = await loadGoLiveView(now);
  check(
    JSON.stringify(view.blockers) === JSON.stringify([MODE_GATE_TEXTS.workerStopped]),
    `go-live blockers besides the background sender: ${JSON.stringify(view.blockers)}`,
  );
  check(view.recommendations.includes(GO_LIVE_RECOMMENDATION_TEXTS.restore), "the practice-restore recommendation is missing");
  check(
    view.drafts.items.some((d) => d.id === part.draft.id && d.people === part.draft.people),
    `the go-live dialog doesn't list ${part.draft.name}: ${JSON.stringify(view.drafts)}`,
  );
  const label = (await getSendingLabel()).label.text;
  check(label === "Test list only", `the top bar says "${label}"`);
  // The go-live dialog names the From address (F21): the shared one, or the Owner's own From line per person.
  check(view.from === teamFrom, `the go-live card's From address is ${view.from ?? "each person's own"}`);
  check(teamFrom !== null || view.ownFromExample === formatFromHeader(`${owner.name} from Polygon Paradise`, `${owner.name.toLowerCase()}@${DOMAIN}`), "the Owner's own From line is missing");
  await checkFromAddress(now, [part.testRun]);
  const dialogFromItem = view.from
    ? GO_LIVE_COPY.dialogTeamFromItem(view.from, domainOfAddress(view.from) ?? "")
    : GO_LIVE_COPY.dialogOwnFromItem(view.ownFromExample ?? "");

  const ready: ReadyFacts = { draft: part.draft, testRunCampaign: part.testRun, restoreRecommendation: GO_LIVE_RECOMMENDATION_TEXTS.restore, dialogFromItem };
  const sharedFrom = await sharedFromFacts(owner, part.draft, part.testRun);
  return {
    sendingDomain: DOMAIN,
    testList: part.testList,
    secondFolder: secondDir,
    backupFolder: rel(backupDir).replace(/\\/g, "/"),
    ready,
    ...(sharedFrom ? { sharedFrom } : {}),
  };
}

/** The last three weekdays before today (Karachi), newest first: the go-live day is the third. */
function lastWeekdays(today: CapDay, count: number): CapDay[] {
  const out: CapDay[] = [];
  for (let d = addCapDays(today, -1); out.length < count; d = addCapDays(d, -1)) if (capDayOfWeek(d) <= 5) out.push(d);
  return out;
}

async function seedLive(owner: SeedUser, member: SeedUser): Promise<SeedFacts> {
  const O = actorOf(owner);
  const A = actorOf(member);
  const today = capDayOf(now, ZONE);
  const [w0, w1, w2] = lastWeekdays(today, 3) as [CapDay, CapDay, CapDay];
  // 14:00 in Karachi (11:00 in Berlin) on the third weekday before today.
  const goLiveAt = plus(capDayBounds(w2, ZONE).start, 14 * HOUR);
  const part = await seedReadyAt(owner, member, plus(goLiveAt, -30 * MINUTE), secondDir!);

  // Go live: the rows goLive() writes (§0.2 rule 6: a seed has no worker, so the service itself would refuse).
  await setSetting("sending.goLive", true, owner.id);
  await setSetting("sending.goLiveAt", iso(goLiveAt), owner.id);
  await setSetting("sending.goLiveDomain", DOMAIN, owner.id);
  // Since when bounces and complaints count (review REPLIES-02): a first go-live on this domain counts from itself.
  await setSetting("sending.healthSinceGoLiveAt", { since: iso(goLiveAt), goLiveAt: iso(goLiveAt), domain: DOMAIN }, owner.id);
  // The From address it went live with (SHARED-FROM-DESIGN F13): null per person, so no "go live again" item.
  await setSetting("sending.goLiveFrom", teamFrom, owner.id);
  await setSetting("sending.mode", "LIVE", owner.id);
  await setSetting("sending.capOverride", null, owner.id);
  await dbWrite((c) =>
    c.activityLog.create({
      data: {
        at: goLiveAt,
        actorId: owner.id,
        type: "sending.goLive",
        summary: GO_LIVE_COPY.activity(owner.name, DOMAIN),
        data: { at: iso(goLiveAt), domain: DOMAIN, modeFrom: "LIVE", modeTo: "LIVE", capOverrideCleared: null, from: teamFrom },
      },
    }),
  );
  await dbWrite((c) =>
    c.notification.createMany({
      data: [owner, member].map((u) => ({
        userId: u.id,
        type: "sending.wentLive",
        title: GO_LIVE_COPY.notificationTitle,
        body: GO_LIVE_COPY.notificationBody(owner.name),
        link: "/dashboard",
        createdAt: goLiveAt,
      })),
    }),
  );
  await startWarmupAtGoLive(goLiveAt);

  // Two live campaigns launched an hour after going live, to prospects checked before.
  const de = await addCompanies(110, O, { countries: COUNTRIES_DE, listId: await newList("Figure studios DE", O) });
  const nordic = await addCompanies(70, A, { countries: COUNTRIES_NORDIC, listId: await newList("Nordic print shops", A) });
  await markChecked([...de, ...nordic], plus(goLiveAt, -3 * DAY));
  const figure = await draftCampaign(O, "Figure studios DE", de, plus(goLiveAt, 20 * MINUTE));
  const print = await draftCampaign(A, "Nordic print shops", nordic, plus(goLiveAt, 25 * MINUTE));
  await launchAt(figure, O, plus(goLiveAt, HOUR));
  await launchAt(print, A, plus(goLiveAt, HOUR + 5 * MINUTE));
  const order = interleave(await queued(figure.id), await queued(print.id));

  // Sends per weekday: 48 of 50 and 57 of 59 (each at least half: up), 25 of 69 (hold), and 50 today on a weekday.
  const plan: Array<{ day: CapDay; count: number; from: Date; to: Date }> = [];
  for (const [day, count] of [
    [w2, 48],
    [w1, 57],
    [w0, 25],
  ] as const) {
    const start = capDayBounds(day, ZONE).start;
    const from = day === w2 ? plus(goLiveAt, HOUR + 10 * MINUTE) : plus(start, 12 * HOUR + 30 * MINUTE);
    plan.push({ day, count, from, to: plus(start, 19 * HOUR + 30 * MINUTE) });
  }
  if (capDayOfWeek(today) <= 5) {
    const start = capDayBounds(today, ZONE).start;
    const from = new Date(Math.max(start.getTime() + 30 * MINUTE, now.getTime() - 6 * HOUR));
    const to = ago(2 * MINUTE);
    if (to.getTime() - from.getTime() >= 10 * MINUTE) plan.push({ day: today, count: 50, from, to });
  }
  const sentOn = new Map<CapDay, Array<{ id: number; at: Date }>>();
  let next = 0;
  for (const d of plan) {
    const list: Array<{ id: number; at: Date }> = [];
    for (const t of spread(d.from, d.to, d.count)) {
      const e = order[next++]!;
      await sendAt(e.id, t);
      list.push({ id: e.id, at: t });
    }
    sentOn.set(d.day, list);
  }
  const liveSends = next;
  const lastSend = [...sentOn.values()].flat().reduce((a, b) => (b.at.getTime() > a.getTime() ? b.at : a), goLiveAt);
  await dbWrite((c) => c.sendingDomain.update({ where: { name: DOMAIN }, data: { lastLiveSendAt: lastSend } }));

  // Two bounces among the second day's emails.
  const bounced = [sentOn.get(w1)![4]!, sentOn.get(w1)![20]!];
  for (const b of bounced) await mailEvent(b.id, "failed", plus(b.at, 12 * MINUTE));
  await processEvents(plus(bounced[1]!.at, 15 * MINUTE));

  // The check with Mailgun has just run; the closed days are judged as the hourly warm-up would.
  await setState(STATE_KEYS.catchUp, catchUpOk(ago(MINUTE)));
  await evaluateWarmupDays({ now });

  // A dry run today (sending mode back to Live afterwards).
  await setSetting("sending.mode", "DRY_RUN", owner.id);
  const springCompanies = await addCompanies(15, A, { listId: await newList("Spring figures", A) });
  const todayStart = capDayBounds(today, ZONE).start;
  let dryFrom = new Date(Math.max(todayStart.getTime() + MINUTE, now.getTime() - 90 * MINUTE));
  if (now.getTime() - dryFrom.getTime() < 2 * MINUTE) dryFrom = ago(90 * MINUTE);
  // A long name (LONG_VALUES), so Campaigns' Running tab is checked with one on a phone (review SCREENS-06).
  const spring = await draftCampaign(A, LONG_VALUES.runningCampaign, springCompanies, plus(dryFrom, -20 * MINUTE));
  await launchAt(spring, A, plus(dryFrom, -10 * MINUTE));
  const springQueue = (await queued(spring.id)).slice(0, 10);
  const springTimes = spread(dryFrom, ago(MINUTE), springQueue.length);
  for (const [i, e] of springQueue.entries()) await sendAt(e.id, springTimes[i]!);
  await setSetting("sending.mode", "LIVE", owner.id);

  // The long values on the other screens the checks open (LONG_VALUES): a draft with a long name (Campaigns › Drafts),
  // and the long company's AI line, approved by Ali (AI lines › Approved), so no line waits for review and the Member's
  // dashboard still has nothing that needs attention.
  const longCompany = part.prospects.find((c) => c.domain === LONG_VALUES.company.domain)!;
  const longDraft = await draftCampaign(O, LONG_VALUES.draftCampaign, [longCompany], ago(3 * HOUR));
  await aiLinesToReview([longCompany], A, ago(5 * HOUR));
  const longLine = await db.aiDraft.findFirstOrThrow({ where: { companyId: longCompany.id, status: "READY" }, select: { id: true } });
  await approveDraft({ id: member.id, name: member.name, role: member.role }, longLine.id, { now: ago(4 * HOUR) });

  // Today's daily backup, copied to the second folder too.
  const daily = await backups.runBackup({ kind: "AUTO", now: ago(2 * HOUR) });
  check(daily.copiedTo === secondDir, `the daily backup wasn't copied (${daily.copyError ?? "no error"})`);
  await tunnelConnected(ago(2 * MINUTE));
  await tasksDone({ "backup.daily": ago(2 * HOUR), "cleanup.daily": now, "mailgun.domainCheck.6h": now });

  // The facts, read back through the app's own services.
  const warmup = (await readTyped(STATE_KEYS.warmup, parseWarmupState)).value;
  check(warmup.step === 2 && warmup.domain === DOMAIN, `warm-up is at step ${warmup.step} for ${warmup.domain}, not step 2`);
  const cap = await getTodayCap(now);
  check(cap.cap === 69, `today's limit is ${cap.cap}, not 69`);
  const health = await loadHealthCounts({ since: goLiveAt, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
  check(health.bounces === 2, `${health.bounces} bounces counted since going live, not 2`);
  const liveRunning = await db.campaign.count({ where: { status: "RUNNING", mode: "LIVE", launchedGoLive: true } });
  check(liveRunning === 2, `${liveRunning} live campaigns launched after going live are running, not 2`);
  const label = (await getSendingLabel()).label.text;
  check(label === "Sending live", `the top bar says "${label}"`);
  await checkFromAddress(plus(goLiveAt, -30 * MINUTE), [part.testRun, figure, print]);
  const wentLiveWith = (await db.setting.findUnique({ where: { key: "sending.goLiveFrom" } }))?.value ?? null;
  check(wentLiveWith === teamFrom, `went live with the From address ${JSON.stringify(wentLiveWith)}, not ${JSON.stringify(teamFrom)}`);
  const aiWaiting = (await aiQueueCounts()).waiting;
  check(aiWaiting === 0, `${aiWaiting} AI lines wait for review in the live state, not 0`);
  const approvedLong = await db.aiDraft.count({ where: { companyId: longCompany.id, status: "APPROVED" } });
  check(approvedLong === 1, "the long company's AI line isn't approved");
  const drafts = await db.campaign.findMany({ where: { status: "DRAFT" }, select: { id: true }, orderBy: { id: "asc" } });
  check(drafts.length === 2 && drafts.some((d) => d.id === longDraft.id), `${drafts.length} drafts in the live state, not 2`);
  const master = await getMasterTemplate();

  const live: LiveFacts = { goLiveAt: iso(goLiveAt), warmupStep: warmup.step, warmupCap: cap.cap, liveSends, bounces: health.bounces, campaigns: [figure, print], dryRunCampaign: spring };
  const screens: ScreenFacts = { draft: part.draft, campaign: figure, company: { id: de[0]!.id, name: de[0]!.name }, masterTemplateId: master.id };
  const sharedFrom = await sharedFromFacts(owner, part.draft, figure);
  return {
    sendingDomain: DOMAIN,
    testList: part.testList,
    secondFolder: secondDir,
    backupFolder: rel(backupDir).replace(/\\/g, "/"),
    live,
    screens,
    ...(sharedFrom ? { sharedFrom } : {}),
  };
}

// ───────────────────────── the own state (MAIN-DOMAIN-DESIGN §9.4) ─────────────────────────

/** The unsubscribe-by-email address the own state's pasted original showed (Mailgun's `u+…@<domain>` shape). */
const OWN_MAILTO = `u+seed@${E2E_OWN_DOMAIN}`;
/** The fake Mailgun's DKIM key (tests/fake-mailgun/state.ts dnsRecords): the value its instance's checks compare. */
const FAKE_DKIM_VALUE = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyQIDAQAB";

/**
 * What an own-mailbox domain check sees for the own state as of `checkedAt` (the facts the app's runDomainCheck gathers,
 * here written out): Mailgun has example.com (US) with SPF, DKIM and tracking verified and its MX "unverified" for good;
 * Apply left tracking off, unsubscribe handling on and the certificate "not in plan"; the domain's own DNS is a mail
 * provider's (fake mode's made-up one, MAIN-DOMAIN-DESIGN §5: GoDaddy-style _spfm includes reaching Mailgun, 4 lookups,
 * the provider's MX, DMARC p=none); no public address; the Free plan; the reply test passed by hand.
 */
function ownChecklistFacts(checkedAt: Date, replyTest: UnsubscribeTestSetting): ChecklistFacts {
  const d = DOMAIN;
  const both = <T,>(value: T): TwoAnswers<T> => ({ a: { ok: true, value }, b: { ok: true, value } });
  const find: DmarcFind = {
    at: d,
    policy: { p: "none", sp: null, rua: [], adkim: null, aspf: null, raw: "v=DMARC1; p=none" },
    duplicates: false,
    inherited: false,
    error: null,
  };
  const dmarc = { a: find, b: find, ruaAuthorized: {} };
  const txt = both([`v=spf1 include:dc-1._spfm.${d} include:dc-2._spfm.${d} ~all`]);
  const names = [`dc-1._spfm.${d}`, "_spf.mail-provider.invalid", `dc-2._spfm.${d}`, "mailgun.org"];
  const mx = both([{ priority: 10, exchange: FAKE_MAIL_PROVIDER_MX }]);
  const record = (recordType: string, name: string | null, value: string, valid: string) => ({
    recordType,
    name,
    value,
    priority: recordType === "MX" ? "10" : null,
    valid,
    isActive: true,
    cached: [] as string[],
  });
  return {
    domain: d,
    region: "US",
    now: checkedAt,
    timeZone: ZONE,
    mailgun: {
      ok: true,
      value: {
        state: "active",
        isDisabled: false,
        disabledReason: null,
        spamAction: "disabled",
        webPrefix: "email",
        webScheme: "http",
        messageTtl: 86_400,
        webhooksRedactPii: false,
        sending: [
          record("TXT", d, "v=spf1 include:mailgun.org ~all", "valid"),
          record("TXT", `pdk1._domainkey.${d}`, FAKE_DKIM_VALUE, "valid"),
          record("CNAME", `email.${d}`, "mailgun.org", "valid"),
        ],
        receiving: [record("MX", null, "mxa.mailgun.org", "unverified"), record("MX", null, "mxb.mailgun.org", "unverified")],
      },
    },
    verifyError: null,
    dns: {
      txt,
      spfLookups: { count: 4, complete: true, names },
      dkim: [{ name: `pdk1._domainkey.${d}`, recordType: "TXT", expected: FAKE_DKIM_VALUE, answers: both([FAKE_DKIM_VALUE]), proxied: null, doubled: null }],
      mx,
      tracking: { host: `email.${d}`, expected: "mailgun.org", cname: both(["mailgun.org."]), a: null, doubled: null },
      dmarc,
    },
    certificate: { ok: true, value: { status: "none", error: null } },
    setupCertificate: "not-in-plan",
    tracking: { ok: true, value: { openActive: false, clickActive: false, unsubscribeActive: true, htmlFooter: "", textFooter: "" } },
    unsubscribeSetup: "A",
    messageRetentionDays: 1,
    webhooks: { url: null, map: { ok: true, value: {} } },
    signingKey: { saved: true, matches: true, problem: null },
    routes: { senders: [], catchAllRouteId: null, listsError: null },
    queues: { ok: true, value: { regularDisabled: false, reason: null } },
    pause: [],
    monthlyLimit: { ok: true, value: null },
    tunnel: parseTunnelState(null),
    publicUrl: null,
    fakeMode: true,
    replyTest: {
      status: replyTest.status,
      setup: replyTest.setup,
      domain: replyTest.domain,
      decidedAt: replyTest.decidedAt,
      from: replyTest.from ?? null,
      ...(replyTest.replies ? { replies: replyTest.replies } : {}),
    },
    domainRegisteredOn: "2024-08-22",
    from: {
      address: E2E_OWN_FROM,
      domain: d,
      problem: null,
      signingDomain: d,
      originalSigner: d,
      originalPasted: true,
      dns: { txt, spfLookups: { count: 4, complete: true, dangling: [], names }, mx, dmarc },
    },
    ownMailbox: true,
    plan: planLimits("free", "own-mailbox"),
    lastGoodMx: null,
  };
}

/**
 * The steps an own-mailbox "Apply recommended settings" without a public address records on the Free plan (§2.8, §4).
 * Tracking off and unsubscribe handling on are recorded as done, so the own instance's fake Mailgun must start in that
 * state (`--settings-applied` in E2E_INSTANCES.own.fakeArgs, checked in seedOwn): the catch-up's drift check pauses
 * sending when a step recorded as done no longer holds in Mailgun (review SCREENS-12).
 */
function ownApplySteps(at: Date): SetupStep[] {
  const step = (key: SetupStep["key"], ok: boolean | null, text: string): SetupStep => ({ key, ok, text, detail: null, at: iso(at) });
  return [
    step("public-address", null, OWN_MAILBOX_TEXTS.applyNoPublicAddress),
    step("tracking-open", true, APPLY_TEXTS.openOff),
    step("tracking-click", true, APPLY_TEXTS.clickOff),
    step("unsubscribe", true, APPLY_TEXTS.unsubscribeOn),
    step("spam-filter", null, OWN_MAILBOX_TEXTS.applyNotNeeded),
    step("retention", null, OWN_MAILBOX_TEXTS.applyNotNeeded),
    // Review DOMAIN-3, SCREENS-06: on the Free plan the certificate is "not in the plan" (no result, not a failure), the
    // https step says the links use http, and without a public address the webhooks are optional.
    step("certificate", null, APPLY_TEXTS.certNotInPlan),
    step("https", null, APPLY_STEP_TEXTS.httpsNotInPlanOwn),
    step("signing-key", true, APPLY_TEXTS.signingKeySaved),
    step("webhooks", null, APPLY_STEP_TEXTS.webhooksOptionalOwn),
    step("routes", null, OWN_MAILBOX_TEXTS.applyNotNeeded),
  ];
}

async function seedOwn(owner: SeedUser): Promise<SeedFacts> {
  const O = actorOf(owner);
  const from = ownFrom!;
  const checkedAt = now;
  // Two test mailboxes, never on the sending domain (the test list refuses those, contact@ included).
  const testList = ["tess@test-mailbox.example", "tom@inbox-two.example"];

  // "Save and connect" in own-mailbox mode (the first connect sets the Free plan with 1/1 days), then the own From,
  // saved three days before the checklist's check (going live needs a check newer than the last change).
  await setSetting("practice.copy", false, owner.id);
  await setSetting("mailgun.domain", DOMAIN, owner.id);
  await setSetting("mailgun.region", "US", owner.id);
  await setSetting("mailgun.replies", "own-mailbox", owner.id);
  await setSetting("mailgun.plan", "free", owner.id);
  await setSetting("mailgun.logRetentionDays", 1, owner.id);
  await setSetting("mailgun.messageRetentionDays", 1, owner.id);
  await setSetting("mailgun.domainRegisteredOn", "2024-08-22", owner.id);
  await setSetting("mailgun.fromAddress", from, owner.id);
  await dbWrite((c) => c.setting.update({ where: { key: "mailgun.fromAddress" }, data: { updatedAt: plus(checkedAt, -3 * DAY) } }));
  await setSecret("mailgun.apiKey", MAILGUN_KEY, owner.id);
  await setSecret("mailgun.webhookSigningKey", SIGNING_KEY, owner.id);
  await setSecret("anthropic.apiKey", CLAUDE_KEY, owner.id);
  await dbWrite((c) => c.sendingDomain.create({ data: { name: DOMAIN, region: "US", active: true, createdAt: ago(40 * DAY) } }));
  await setSetting("sending.testList", testList, owner.id);
  await setSetting("sending.mode", "LIVE", owner.id);
  await setSetting("sending.goLive", false, owner.id);
  await warmupAtStart(now);
  await checkDatabaseInstance({ now: ago(3 * HOUR), markerSeen: false });

  // The reply test by hand, passed two days ago: its emails From the own From (delivered, one unsubscribe clicked) and
  // what the pasted original showed (return address on the domain, DMARC pass, an http link and a mailto: address).
  const decidedAt = plus(checkedAt, -2 * DAY);
  const sentAt = plus(decidedAt, -2 * HOUR);
  const sends: Array<{ id: number; to: string }> = [];
  for (const to of testList) {
    const messageId = replyTestMessageId(9001, to, DOMAIN);
    sends.push(
      await dbWrite((c) =>
        c.testSend.create({
          data: { userId: owner.id, to, subject: REPLY_TEST_SUBJECT, mode: "LIVE", purpose: "REPLY_TEST", status: "SENT", messageId, providerId: messageId, teamFrom: from, sentAt },
          select: { id: true, to: true },
        }),
      ),
    );
  }
  for (const [i, s] of sends.entries()) {
    const events = [{ type: "delivered", at: plus(sentAt, (i + 1) * MINUTE) }, ...(i === 0 ? [{ type: "unsubscribed", at: plus(sentAt, 40 * MINUTE) }] : [])];
    for (const e of events) {
      await dbWrite((c) =>
        c.mailEvent.create({
          data: { dedupeKey: `seed-own-${e.type}-${s.id}`, type: e.type, occurredAt: e.at, recipient: s.to, testSendId: s.id, isTestMode: false, source: "LOGS", raw: { seed: true }, processedAt: e.at },
        }),
      );
    }
  }
  const replyTest: UnsubscribeTestSetting = {
    setup: "A",
    status: "passed",
    domain: DOMAIN,
    mailboxes: testList.map((address) => ({
      address,
      provider: "other" as const,
      inboxOk: true,
      authOk: null,
      authFromHeaders: false,
      placementOk: true,
      dmarcOk: "pass" as const,
      dmarcFromHeaders: false,
    })),
    headersOk: true,
    decidedAt: iso(decidedAt),
    decidedById: owner.id,
    note: null,
    from,
    replies: "own-mailbox",
    mailtoArrived: true,
    original: {
      domain: DOMAIN,
      from,
      address: sends[0]!.to,
      testSendId: sends[0]!.id,
      returnPathDomain: DOMAIN,
      returnPathOk: true,
      dmarc: "pass",
      dkimSigner: DOMAIN,
      mailtoDomain: DOMAIN,
      mailtoOk: true,
      readAt: iso(plus(sentAt, 30 * MINUTE)),
      unsubscribeScheme: "http",
      mailtoAddress: OWN_MAILTO,
    },
  };
  await setSetting("mailgun.unsubscribeTest", replyTest, owner.id);

  // "Apply recommended settings" ran before the check; the checklist's rows come from the app's own builder, built for
  // own-mailbox mode with no public address, and are stored for this mode with the last good MX. The instance's fake
  // Mailgun must agree with the tracking steps recorded here, or the first catch-up pauses sending (review SCREENS-12).
  check(
    /(^|\s)--settings-applied(\s|$)/.test(E2E_INSTANCES.own.fakeArgs ?? ""),
    "the own instance's fake Mailgun doesn't start with --settings-applied, but the seed records Apply's tracking steps as done",
  );
  await setState(STATE_KEYS.mailgunSetup, {
    runAt: iso(plus(checkedAt, -10 * MINUTE)),
    byUserId: owner.id,
    jobId: null,
    steps: ownApplySteps(plus(checkedAt, -10 * MINUTE)),
    certificate: { host: `email.${DOMAIN}`, status: "not-in-plan", startedAt: null, lastPolledAt: null, error: null },
  });
  const rows = buildChecklistRows(ownChecklistFacts(checkedAt, replyTest), { keyBits: 1024 });
  await setState(STATE_KEYS.domainCheck, {
    domain: DOMAIN,
    region: "US",
    checkedAt: iso(checkedAt),
    lastVerifyAt: iso(checkedAt),
    rows,
    error: null,
    replies: "own-mailbox",
    lastGoodMx: [{ priority: 10, host: FAKE_MAIL_PROVIDER_MX }],
  });

  // The test mailboxes' companies, prospects, and a draft of the Owner's (the wizard's Sender step).
  const mailboxes = await newList("Test mailboxes", O);
  const testCompanies: SeedCompany[] = [];
  for (const [i, email] of testList.entries()) {
    const name = ["Tess", "Tom"][i]!;
    testCompanies.push(
      await addCompany(
        { name: `Test mailbox ${name}`, domain: email.split("@")[1]!, country: "DE", niche: "Test mailbox", person: { name: `${name} Tester`, email } },
        O,
        { listId: mailboxes },
      ),
    );
  }
  const prospects = await addCompanies(12, O, { countries: COUNTRIES_DE, listId: await newList("Germany Q4 prospects", O) });
  await markChecked(prospects, plus(checkedAt, -10 * DAY));
  const draft = await draftCampaign(O, "Germany Q4", prospects, plus(checkedAt, -DAY));
  await draftService.setWizardStep(draft.id, 6);

  // The live test with its follow-ups (before go-live it reaches the test list only): the first emails went yesterday
  // and were delivered; the follow-ups are due now (written, so they are due whatever the day of the week), and wait for
  // today's inbox check, which nobody has done.
  const firstAt = ago(25 * HOUR);
  const rehearsal = await draftCampaign(O, "Mailbox rehearsal", testCompanies, plus(firstAt, -20 * MINUTE));
  await launchAt(rehearsal, O, plus(firstAt, -10 * MINUTE));
  const firsts = await queued(rehearsal.id);
  check(firsts.length === 2, `the live test queued ${firsts.length} emails, not 2`);
  for (const [i, e] of firsts.entries()) {
    await sendAt(e.id, plus(firstAt, i * 2 * MINUTE));
    await mailEvent(e.id, "delivered", plus(firstAt, (i * 2 + 2) * MINUTE));
  }
  await processEvents(plus(firstAt, 10 * MINUTE));
  await dbWrite((c) => c.sendingDomain.update({ where: { name: DOMAIN }, data: { lastLiveSendAt: plus(firstAt, 2 * MINUTE) } }));
  await dbWrite((c) => c.outboundEmail.updateMany({ where: { campaignId: rehearsal.id, step: 1, status: "QUEUED" }, data: { dueAt: ago(10 * MINUTE) } }));
  await setState(STATE_KEYS.catchUp, catchUpOk(ago(5 * MINUTE)));

  // A fresh backup (no second folder: the Owner hasn't chosen one), and the periodic tasks just done.
  await backups.runBackup({ kind: "MANUAL", userId: owner.id, now: ago(HOUR) });
  await tasksDone({ "backup.daily": ago(HOUR), "cleanup.daily": now, "mailgun.domainCheck.6h": now });

  // The facts, read back through the app's own services.
  const team = await loadTeamFrom();
  check(
    team.replies === "own-mailbox" && team.ownFrom === from && team.address === null && team.problem === null,
    `the own From is "${team.saved ?? "empty"}" (${team.problem ?? team.replies})`,
  );
  check((await db.senderAddress.count()) === 0, "someone has a sending address in own-mailbox mode");
  const notDone = rows.filter((r) => r.status !== "ok" && r.status !== "info").map((r) => `${r.key}: ${r.status}`);
  check(notDone.length === 0, `checklist rows not done: ${notDone.join(", ")}`);
  const keys = rows.map((r) => r.key);
  check(keys.includes("from-mx") && !keys.includes("mx") && !keys.includes("reply-routes"), `the rows aren't own-mailbox mode's: ${keys.join(", ")}`);
  const info = rows.filter((r) => r.status === "info").map((r) => r.key);
  for (const k of ["https-links", "webhooks", "remote-access"] as const) check(info.includes(k), `the ${k} row isn't information only`);
  check(rows.every((r) => r.records.every((x) => x.type.toUpperCase() !== "MX")), "a checklist row has an MX record box");
  const view = await loadGoLiveView(now);
  check(
    JSON.stringify(view.blockers) === JSON.stringify([MODE_GATE_TEXTS.workerStopped]),
    `go-live blockers besides the background sender: ${JSON.stringify(view.blockers)}`,
  );
  check(view.ownMailbox?.from === from && view.ownMailbox.httpLinksTick === true, `the go-live card's own-mailbox part: ${JSON.stringify(view.ownMailbox)}`);
  check(view.spamPlacements.length === 0, "the reply test recorded a spam placement");
  const label = (await getSendingLabel()).label.text;
  check(label === "Test list only", `the top bar says "${label}"`);
  const o = await getCampaignOverview(rehearsal.id);
  check(o !== null && o.status === "RUNNING" && o.fromAddress === from && o.replyTo === null, `${rehearsal.name} isn't a running own-mailbox campaign`);
  check(o!.steps.some((s) => s.step > 0 && s.enabled), `${rehearsal.name} has no follow-ups`);
  const line = formatFromHeader(`${owner.name} from Polygon Paradise`, from);
  const emails = await db.outboundEmail.findMany({ where: { campaignId: rehearsal.id }, select: { fromAddress: true, replyTo: true, messageId: true } });
  check(
    emails.length === 4 && emails.every((e) => e.fromAddress === line && e.replyTo === null && e.messageId.endsWith(`@${DOMAIN}`)),
    `${rehearsal.name}'s emails don't all show "${line}" without a Reply-To`,
  );
  const inbox = await loadInboxCheck(now);
  check(!inbox.today && inbox.waitingTotal === 2 && inbox.waiting.length === 2, `the inbox check: ${JSON.stringify(inbox)}`);

  const own: OwnFacts = {
    from,
    domain: DOMAIN,
    campaign: rehearsal,
    draft,
    company: { id: testCompanies[0]!.id, name: testCompanies[0]!.name },
    waitingCompanies: inbox.waiting.map((w) => ({ id: w.companyId, name: w.companyName })),
    followUpsDue: inbox.waitingTotal,
    mailtoAddress: OWN_MAILTO,
  };
  return { sendingDomain: DOMAIN, testList, secondFolder: null, backupFolder: rel(backupDir).replace(/\\/g, "/"), own };
}

// ───────────────────────── every address, checked ─────────────────────────

/** Every address in the data is on example.com (or a subdomain) or a *.example domain (§9.4). */
async function checkAddresses(): Promise<void> {
  const found: string[] = [];
  for (const u of await db.user.findMany({ select: { email: true, replyInbox: true } })) found.push(u.email, ...(u.replyInbox ? [u.replyInbox] : []));
  for (const p of await db.person.findMany({ where: { email: { not: null } }, select: { email: true } })) found.push(p.email!);
  for (const s of await db.senderAddress.findMany({ select: { address: true, forwardTo: true } })) found.push(s.address, ...(s.forwardTo ? [s.forwardTo] : []));
  for (const e of await db.outboundEmail.findMany({ select: { toNorm: true } })) found.push(e.toNorm);
  for (const m of await db.inboundMessage.findMany({ select: { fromEmail: true, toAddress: true } })) found.push(m.fromEmail, m.toAddress);
  for (const s of await db.suppression.findMany({ select: { emailNorm: true } })) found.push(s.emailNorm);
  // The shared From address and every address a campaign, an email or a test email was sent with or to.
  for (const c of await db.campaign.findMany({ select: { fromAddress: true, replyTo: true } })) found.push(...[c.fromAddress, c.replyTo].filter((a): a is string => Boolean(a)));
  for (const e of await db.outboundEmail.findMany({ select: { replyTo: true } })) if (e.replyTo) found.push(e.replyTo);
  for (const s of await db.testSend.findMany({ select: { to: true, teamFrom: true } })) found.push(s.to, ...(s.teamFrom ? [s.teamFrom] : []));
  const testList = await db.setting.findUnique({ where: { key: "sending.testList" } });
  if (Array.isArray(testList?.value)) found.push(...testList.value.map(String));
  const fromAddress = await db.setting.findUnique({ where: { key: "mailgun.fromAddress" } });
  if (typeof fromAddress?.value === "string" && fromAddress.value) found.push(fromAddress.value);
  const bad = [...new Set(found.filter((a) => !isSafeAddress(a)))];
  check(bad.length === 0, `addresses outside example.com and *.example: ${bad.join(", ")}`);
}

// ───────────────────────── run ─────────────────────────

let exitCode = 0;
try {
  const users = await makeUsers();
  const facts =
    state === "empty"
      ? await seedEmpty()
      : state === "busy"
        ? await seedBusy(users.owner, users.member)
        : state === "ready"
          ? await seedReady(users.owner, users.member)
          : state === "live"
            ? await seedLive(users.owner, users.member)
            : await seedOwn(users.owner);
  await checkAddresses();
  const manifest: SeedManifest = {
    version: MANIFEST_VERSION,
    state,
    seededAt: iso(now),
    database: rel(target).replace(/\\/g, "/"),
    port: instance.port,
    users,
    fromAddress: teamFrom ?? ownFrom,
    replies: ownFrom ? "own-mailbox" : "app",
    ...facts,
  };
  fs.writeFileSync(manifestFileFor(target), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`  ${state}: ${rel(target)} is ready (facts in ${rel(manifestFileFor(target))}).`);
  console.log(
    ownFrom
      ? `  Emails show From ${ownFrom} and go out through ${DOMAIN} itself; replies go straight to that mailbox. No public address.`
      : teamFrom
        ? `  Emails show From ${teamFrom} (each sender's own address is the Reply-To).`
        : "  Emails come from each sender's own address (no From address).",
  );
  console.log(`  Sign in as ${users.owner.email} / ${users.owner.password} (Owner) or ${users.member.email} / ${users.member.password} (Member).`);
  // The fake's flags other than --port and --app: --dkim-authority (ready, live), or the own state's own ones.
  const fakeFlags = fakeMailgunArgs(state).replace(/^--app \S+\s*/, "");
  console.log(
    instance.worker
      ? `  Its instance: http://127.0.0.1:${instance.port} with the fake Mailgun on port ${instance.fakeMailgunPort}${
          fakeFlags ? ` (started with ${fakeFlags})` : ""
        } (docs/dev/M6-DESIGN.md §9.4).`
      : `  Its instance: http://127.0.0.1:${instance.port}, the web app only (no background sender), with the fake Mailgun on port ${instance.fakeMailgunPort}.`,
  );
  console.log(`  Screen checks: $env:PP_E2E_STATE = "${state}"; npm run test:e2e`);
} catch (err) {
  exitCode = 1;
  console.log(`  [x]  Seeding ${state} failed.`);
  console.log(`       ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  await db.$disconnect().catch(() => undefined);
}
process.exit(exitCode);
