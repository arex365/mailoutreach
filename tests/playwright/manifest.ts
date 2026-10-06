import fs from "node:fs";
import path from "node:path";
import type { CatchUpState } from "@/core/system-state";
import { ROOT, manifestFileFor, manualCheckDatabase, type E2eState } from "./instances";

/**
 * What the seed script (scripts/seed-m6-manual.ts) put into a manual-check database, written as JSON next to it
 * ("data/manual-check/m6-busy.json"). The specs read it for the ids to open and for the facts behind every sentence
 * they expect; sentences with a date are built at test time (the same formatters the app uses), so a run the day after
 * seeding still expects the right words.
 */

/**
 * 2: the manifest names the shared From address (`fromAddress`, SHARED-FROM-DESIGN §8 P6). 3: it names the way the app
 * sends (`replies`) and has the own state's facts (MAIN-DOMAIN-DESIGN §9.4). Older ones are reseeded.
 */
export const MANIFEST_VERSION = 3;

export type SeedUser = { id: number; name: string; email: string; password: string; role: "OWNER" | "MEMBER"; timeZone: string };
export type SeedRef = { id: number; name: string };

/** The busy state (§9.4): the facts behind its 14 attention items. */
export type BusyFacts = {
  /** Sending pause "health-bounce": the pill's reason and the fix text. */
  pause: { reason: string; fixText: string };
  /** The two paused campaigns: "Paused by Arslan" and one with a reason. */
  pausedCampaigns: SeedRef[];
  /** Waiting replies (the counting rule) per user, and the dry-run replies apart. */
  waiting: { owner: number; member: number; dryRun: number };
  aiLinesWaiting: number;
  unconfirmed: number;
  missingEmails: number;
  companies: number;
  /** The newest app backup (a Daily backup 40 hours old) and the labels of every kind listed. */
  newestBackup: { at: string; fileName: string };
  backupKinds: string[];
  /** The second folder that doesn't exist, set before the newest backup, which wasn't copied. */
  secondFolder: string;
  /** SystemState "mailgun.catchUp": failing for 3 hours, one old-domain problem. */
  catchUp: CatchUpState;
  checksPauseText: string;
  aiPauseText: string;
  dryRunCampaign: SeedRef;
  testListCampaign: SeedRef;
};

/** The ready state: everything green for go-live in fake mode. */
export type ReadyFacts = {
  /** The draft made "yesterday" that the go-live dialog lists. */
  draft: SeedRef & { people: number };
  testRunCampaign: SeedRef;
  /** The recommendation the card must show ("Try a practice restore …"). */
  restoreRecommendation: string;
  /**
   * The go-live dialog's From item, word for word (SHARED-FROM-DESIGN F21): the shared From address's, or, seeded
   * `--per-person`, the Owner's own From line as the example.
   */
  dialogFromItem: string;
};

/** The live state: ready + go-live 3 weekdays ago, warm-up step 2, two live campaigns, 180 live sends, a dry run today. */
export type LiveFacts = {
  goLiveAt: string;
  warmupStep: number;
  warmupCap: number;
  liveSends: number;
  bounces: number;
  campaigns: SeedRef[];
  dryRunCampaign: SeedRef;
};

/**
 * Shared-From mode (ready and live, SHARED-FROM-DESIGN §8 P6): what shared-from.spec.ts opens and expects besides the
 * From address itself.
 */
export type SharedFromFacts = {
  /** The Owner's own address on the sending domain: the Reply-To of the Owner's campaigns ("…, replies to <it>"). */
  ownerReplyTo: string;
  /** A draft by the Owner (its Sender step shows the From line, "Reply address" and the reminder). */
  draft: SeedRef;
  /** A running campaign by the Owner with follow-ups still to come (its page says "replies to" and the reminder). */
  campaign: SeedRef;
};

/**
 * The own state (MAIN-DOMAIN-DESIGN §9.4): what own-mailbox.spec.ts opens and expects. The app sends through `domain`
 * itself, every email From `from` with no Reply-To; go-live is off; one live campaign to the test list has follow-ups
 * due within 24 hours and nobody has read the own mailbox today.
 */
export type OwnFacts = {
  /** The own From address (Setting "mailgun.fromAddress"), e.g. contact@example.com. */
  from: string;
  /** The sending domain, the own mailbox's domain itself (example.com). */
  domain: string;
  /** The running live campaign to the test list (its page shows the reminder and the link to the inbox check). */
  campaign: SeedRef;
  /** A draft by the Owner (its Sender step shows the From line and no address). */
  draft: SeedRef;
  /** A test-mailbox company with a follow-up waiting (its panel shows They replied, whose confirmation says test only). */
  company: SeedRef;
  /** The companies the inbox check lists (follow-ups due within 24 hours), and how many follow-ups wait. */
  waitingCompanies: SeedRef[];
  followUpsDue: number;
  /** The unsubscribe-by-email address of the reply test's pasted original (its question names it). */
  mailtoAddress: string;
};

/** Ids the screen checks open (the live state; the empty state has none). */
export type ScreenFacts = {
  draft: SeedRef;
  campaign: SeedRef;
  company: SeedRef;
  masterTemplateId: number;
};

export type SeedManifest = {
  version: typeof MANIFEST_VERSION;
  state: E2eState;
  seededAt: string;
  /** Relative to the project folder, e.g. "data/manual-check/m6-busy.db". */
  database: string;
  port: number;
  users: { owner: SeedUser; member: SeedUser };
  /**
   * The From address every campaign email shows (Setting "mailgun.fromAddress"): contact@example.com in ready and live
   * (the shared From) and in own (the own From), null in empty, busy and a `--per-person` reseed (each sender's own
   * address is the From).
   */
  fromAddress: string | null;
  /**
   * How the app sends (Setting "mailgun.replies", MAIN-DOMAIN-DESIGN §9.4): "own-mailbox" in own (replies go straight to
   * the own mailbox, never through the app), "app" in every other state. Specs whose screens or data don't exist in
   * own-mailbox mode skip themselves by it.
   */
  replies: "own-mailbox" | "app";
  sendingDomain: string | null;
  testList: string[];
  secondFolder: string | null;
  /** The backups folder the app uses for this database, relative to the project folder. */
  backupFolder: string;
  busy?: BusyFacts;
  ready?: ReadyFacts;
  live?: LiveFacts;
  screens?: ScreenFacts;
  /** Set exactly when `fromAddress` is and `replies` is "app" (ready and live in shared-From mode). */
  sharedFrom?: SharedFromFacts;
  /** Set exactly when `replies` is "own-mailbox" (the own state). */
  own?: OwnFacts;
};

/** Reads the manifest of a state's database; a plain error says how to seed it when it is missing or old. */
export function readManifest(state: E2eState, database: string = manualCheckDatabase(state)): SeedManifest {
  const file = manifestFileFor(database);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `${path.relative(ROOT, file)} is missing. Seed the ${state} state first: node --import tsx scripts/seed-m6-manual.ts --state ${state}`,
    );
  }
  const parsed = JSON.parse(raw) as SeedManifest;
  if (parsed.version !== MANIFEST_VERSION || parsed.state !== state) {
    throw new Error(`${path.relative(ROOT, file)} belongs to another seed. Seed it again: node --import tsx scripts/seed-m6-manual.ts --state ${state}`);
  }
  return parsed;
}
