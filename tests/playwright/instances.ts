import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The manual-check instances of the screen checks (docs/dev/M6-DESIGN.md §9.4): which state each one shows, its port on
 * this PC, its own fake Mailgun and the two seeded users. One place for the Playwright config, the specs and the seed
 * script (scripts/seed-m6-manual.ts), so they always agree. Pure: no Playwright, no database.
 *
 * Own-mailbox mode (docs/dev/MAIN-DOMAIN-DESIGN.md §9.4): the fifth state, `own`, is the owner's shape: the app sends
 * through example.com itself (standing for polygonparadise.com) on Mailgun's Free plan, From contact@example.com, with
 * no public address. Its fake Mailgun is started with `fakeArgs` (the domain, the region, the Free plan, "the MX isn't
 * Mailgun's" and the tracking settings the seeded Apply run left: review SCREENS-12), and its app without APP_PUBLIC_URL
 * (`publicAddress: false`, run-prod.mjs --no-public-address).
 *
 * Every address is loopback (http://127.0.0.1:<port>): no instance, fake or test ever reaches a real host
 * (M6-DESIGN §0.2 rule 13).
 */

/** The project folder (this file is tests/playwright/instances.ts). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const E2E_STATES = ["empty", "busy", "ready", "live", "own"] as const;
export type E2eState = (typeof E2E_STATES)[number];

export function isE2eState(value: unknown): value is E2eState {
  return typeof value === "string" && (E2E_STATES as readonly string[]).includes(value);
}

export type E2eInstance = {
  state: E2eState;
  /** The app's port: http://127.0.0.1:<port>. */
  port: number;
  /** The instance's own fake Mailgun (`node scripts/fake-mailgun.mjs --port …`). */
  fakeMailgunPort: number;
  /** The app port that fake Mailgun posts its signed webhooks to (`--app`). */
  fakeMailgunAppPort: number;
  /** false: the web app only, no background sender (busy: its stale backup, pauses and worker-down item stay). */
  worker: boolean;
  /**
   * The domain whose DKIM key signs the fake Mailgun's sending domain (`--dkim-authority`, SHARED-FROM-DESIGN §9.4):
   * example.com for ready and live, which run in shared-From mode; null for empty and busy (per-person).
   */
  dkimAuthority: string | null;
  /**
   * MAIN-DOMAIN-DESIGN §9.4: more flags for the fake Mailgun's command (after --port, --app and --dkim-authority), e.g.
   * the own state's `--domain example.com --region US --plan free --mx-elsewhere --settings-applied`. Absent = none.
   */
  fakeArgs?: string;
  /**
   * MAIN-DOMAIN-DESIGN §9.4: false = the instance has no public address at all (no APP_PUBLIC_URL; the app runs with
   * run-prod.mjs --no-public-address), like the owner's PC without remote access. Absent = a loopback public address.
   */
  publicAddress?: boolean;
};

/**
 * The shared From address of the ready and live states (SHARED-FROM-DESIGN §8 P6): every campaign email shows it, and
 * the fake Mailgun of those instances signs with its domain's key (E2E_DKIM_AUTHORITY).
 */
export const E2E_TEAM_FROM = "contact@example.com";
export const E2E_DKIM_AUTHORITY = "example.com";

/**
 * The own state (MAIN-DOMAIN-DESIGN §9.4): the sending domain is the domain of the own mailbox itself (example.com stands
 * for polygonparadise.com), and every email comes From contact@example.com.
 */
export const E2E_OWN_DOMAIN = "example.com";
export const E2E_OWN_FROM = "contact@example.com";

/**
 * §9.4 "Instances": empty 3101, busy 3102 (web only), ready 3103, live 3104, own 3105 (MAIN-DOMAIN-DESIGN §9.4); one fake
 * Mailgun each (empty shares 4010; own's is 4013, on the Free plan with its MX elsewhere). The own seed records a finished
 * "Apply recommended settings", so its fake starts with the settings Apply leaves (`--settings-applied`: tracking off,
 * unsubscribe handling on): otherwise the first catch-up would find tracking "switched back on" and pause sending, and
 * every own screen would show the paused app (review SCREENS-12).
 */
export const E2E_INSTANCES: Readonly<Record<E2eState, E2eInstance>> = {
  empty: { state: "empty", port: 3101, fakeMailgunPort: 4010, fakeMailgunAppPort: 3102, worker: true, dkimAuthority: null },
  busy: { state: "busy", port: 3102, fakeMailgunPort: 4010, fakeMailgunAppPort: 3102, worker: false, dkimAuthority: null },
  ready: { state: "ready", port: 3103, fakeMailgunPort: 4011, fakeMailgunAppPort: 3103, worker: true, dkimAuthority: E2E_DKIM_AUTHORITY },
  live: { state: "live", port: 3104, fakeMailgunPort: 4012, fakeMailgunAppPort: 3104, worker: true, dkimAuthority: E2E_DKIM_AUTHORITY },
  own: {
    state: "own",
    port: 3105,
    fakeMailgunPort: 4013,
    fakeMailgunAppPort: 3105,
    worker: true,
    dkimAuthority: null,
    fakeArgs: `--domain ${E2E_OWN_DOMAIN} --region US --plan free --mx-elsewhere --settings-applied`,
    publicAddress: false,
  },
};

/**
 * The fake Mailgun's flags after `--port`, for `state`: `--app http://127.0.0.1:<port>`, then `--dkim-authority` (ready,
 * live) and the instance's own `fakeArgs` (own). The Playwright config starts the fake with them, and the refusals below
 * and the seed script name them. `appPort`: the app's port of this run when it isn't the state's own (PP_E2E_BASE_URL);
 * a fake that posts to another instance (empty's, which busy's app receives) keeps its own target.
 */
export function fakeMailgunArgs(state: E2eState, appPort?: number): string {
  const i = E2E_INSTANCES[state];
  const app = i.fakeMailgunAppPort === i.port ? (appPort ?? i.port) : i.fakeMailgunAppPort;
  return [`--app http://127.0.0.1:${app}`, i.dkimAuthority ? `--dkim-authority ${i.dkimAuthority}` : "", i.fakeArgs ?? ""].filter(Boolean).join(" ");
}

/**
 * Why a fake Mailgun that already runs can't be used for `state` (null = fine): the ready and live fakes must sign with
 * example.com's key (SHARED-FROM-DESIGN §8 P6). `fakeState` is its `GET /__fake/state` answer.
 */
export function fakeDkimProblem(state: E2eState, fakeState: unknown): string | null {
  const { dkimAuthority, fakeMailgunPort } = E2E_INSTANCES[state];
  if (!dkimAuthority) return null;
  const got = fakeState && typeof fakeState === "object" ? (fakeState as { dkimAuthority?: unknown }).dkimAuthority : undefined;
  return got === dkimAuthority
    ? null
    : `The fake Mailgun on ${fakeMailgunPort} was started without --dkim-authority ${dkimAuthority}. Stop it and run again.`;
}

/**
 * MAIN-DOMAIN-DESIGN §9.4: why a fake Mailgun that already runs can't be used for the own state (null = fine, and always
 * null for the other states): it must behave like the Free plan with the domain's MX elsewhere (`receivesMail: false`,
 * `plan: "free"` in its `GET /__fake/state` answer), or replies would reach the app, which the owner's shape never does;
 * and with `--settings-applied` in `fakeArgs` its tracking must be as Apply leaves it (open and click off, unsubscribe
 * handling on), or the first catch-up pauses sending and every own screen shows the paused app (review SCREENS-12).
 */
export function fakeOwnMailboxProblem(state: E2eState, fakeState: unknown): string | null {
  const { fakeArgs, fakeMailgunPort } = E2E_INSTANCES[state];
  if (!fakeArgs || !/--mx-elsewhere/.test(fakeArgs)) return null;
  const s = fakeState && typeof fakeState === "object" ? (fakeState as { receivesMail?: unknown; plan?: unknown; tracking?: unknown }) : {};
  const applied = /--settings-applied/.test(fakeArgs);
  const ok = s.receivesMail === false && s.plan === "free" && (!applied || trackingAsApplied(s.tracking));
  return ok
    ? null
    : `The fake Mailgun on ${fakeMailgunPort} wasn't started with --plan free --mx-elsewhere${applied ? " --settings-applied" : ""}. Stop it and run again.`;
}

/** A fake's `tracking` (its `GET /__fake/state` answer) as "Apply recommended settings" leaves it. */
function trackingAsApplied(tracking: unknown): boolean {
  if (!tracking || typeof tracking !== "object") return false;
  const t = tracking as { open?: { active?: unknown }; click?: { active?: unknown }; unsubscribe?: { active?: unknown } };
  return t.open?.active === false && t.click?.active === false && t.unsubscribe?.active === true;
}

/** The fake Claude every instance shares (`node scripts/fake-claude.mjs --port 4020 --sites tests/fixtures/sites`). */
export const FAKE_CLAUDE_PORT = 4020;
/** The fixture websites the fake Claude and the reader use. */
export const WEB_FIXTURES_DIR = "tests/fixtures/sites";

/** The seeded users (§9.4); PP_E2E_OWNER_EMAIL / _PASSWORD and PP_E2E_MEMBER_EMAIL / _PASSWORD override them in the specs. */
export const E2E_USERS = {
  owner: { name: "Arslan", email: "arslan@example.com", password: "practice-owner-1", role: "OWNER" },
  member: { name: "Ali", email: "ali@example.com", password: "practice-member-1", role: "MEMBER" },
} as const;

/** Both users' time zone: every date the specs expect is written in it. */
export const E2E_TIME_ZONE = "Asia/Karachi";

/** Manual-check databases live here, never in data\test (the worker's clean-up empties it) and never data\app.db. */
export const MANUAL_CHECK_DIR = "data/manual-check";

/** "data/manual-check/m6-busy.db" (relative to the project folder). */
export function manualCheckDatabase(state: E2eState): string {
  return `${MANUAL_CHECK_DIR}/m6-${state}.db`;
}

/** The facts file the seed writes next to a database ("m6-busy.db" → "m6-busy.json"), absolute. */
export function manifestFileFor(database: string): string {
  const abs = path.resolve(ROOT, database);
  return abs.replace(/\.db$/i, "") + ".json";
}

/**
 * The base URL when it is exactly http://127.0.0.1:<port> (a trailing slash allowed), without the slash; else null.
 * Nothing else is ever accepted: not "localhost" (the hosts file can redirect it), not another host.
 */
export function loopbackBaseUrl(raw: string | null | undefined): string | null {
  const m = /^http:\/\/127\.0\.0\.1:(\d{2,5})\/?$/.exec((raw ?? "").trim());
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? `http://127.0.0.1:${port}` : null;
}

/** The state under test (PP_E2E_STATE), or a plain error that says how to set it. */
export function e2eStateFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): E2eState {
  const raw = (env.PP_E2E_STATE ?? "").trim();
  if (!isE2eState(raw)) {
    throw new Error(
      `Set PP_E2E_STATE to empty, busy, ready, live or own (it is "${raw}"). Example: $env:PP_E2E_STATE = "busy"; npm run test:e2e`,
    );
  }
  return raw;
}

/**
 * The app's base URL: PP_E2E_BASE_URL when set (refused unless http://127.0.0.1:<port>), else the state's own port.
 */
export function e2eBaseUrlFromEnv(state: E2eState, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = (env.PP_E2E_BASE_URL ?? "").trim();
  if (!raw) return `http://127.0.0.1:${E2E_INSTANCES[state].port}`;
  const url = loopbackBaseUrl(raw);
  if (!url) {
    throw new Error(
      `PP_E2E_BASE_URL must be http://127.0.0.1:<port> (it is "${raw}"): the screen checks never open a real address.`,
    );
  }
  return url;
}
