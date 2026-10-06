import fs from "node:fs";
import path from "node:path";
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import {
  E2E_INSTANCES,
  E2E_TIME_ZONE,
  FAKE_CLAUDE_PORT,
  ROOT,
  WEB_FIXTURES_DIR,
  e2eBaseUrlFromEnv,
  e2eStateFromEnv,
  fakeMailgunArgs,
  manualCheckDatabase,
} from "./tests/playwright/instances";

/**
 * The Playwright + axe screen checks (docs/dev/M6-DESIGN.md §9.4), run by the lead in step S, one seeded state at a
 * time:
 *
 *   node --import tsx scripts/seed-m6-manual.ts --state busy
 *   $env:PP_E2E_STATE = "busy"; npm run test:e2e
 *
 * PP_E2E_STATE picks the state (empty, busy, ready, live, own) and PP_E2E_BASE_URL the app (default: that state's port,
 * refused unless it is http://127.0.0.1:<port>, so no real address is ever opened).
 *
 * The app: when an instance already answers at the base URL (started by hand as §9.4 says), it is used as it is.
 * Otherwise this config starts the state's instance on its seeded database under data\manual-check\ (never data\test\,
 * never data\app.db) with its own fake Mailgun, the fake Claude and the fixture sites, a loopback APP_PUBLIC_URL (none
 * for own) and OUTREACH_TEST_RUN=1 (scripts/run-prod.mjs sets both for a database other than the app's own; the
 * web-only busy instance gets them here), and stops what it started afterwards. The app must be built first
 * (`next build` and `node scripts/build-worker.mjs`): run-prod never builds here (--no-build). PP_E2E_NO_SERVER=1
 * starts nothing.
 *
 * Output: test-results\runs\<state>\ (Playwright empties it at every run), screenshots in test-results\shots\ (kept
 * across the state runs) and the report in playwright-report\<state>\.
 *
 * Shared From address (docs/dev/SHARED-FROM-DESIGN.md §8 P6, §9.4): ready and live run in shared-From mode, so their fake
 * Mailgun signs with example.com's key: this config starts it with `--dkim-authority example.com`, and before any test
 * (tests/playwright/fake-check.ts) it asks the fake that answers, whether started here or by hand, for its
 * `GET /__fake/state` and refuses to run when its DKIM authority differs. By hand:
 *
 *   node scripts/fake-mailgun.mjs --port 4011 --app http://127.0.0.1:3103 --dkim-authority example.com
 *
 * Own-mailbox mode (docs/dev/MAIN-DOMAIN-DESIGN.md §9.4): the own state (3105) is the owner's shape. Its fake Mailgun
 * (4013) is started with the instance's `fakeArgs` (example.com, US, the Free plan, the MX elsewhere, and the tracking
 * settings the seeded Apply run left, so the first catch-up doesn't pause sending: review SCREENS-12) and checked the
 * same way; its app has no public address at all: no APP_PUBLIC_URL here, and run-prod.mjs gets --no-public-address
 * (which empties it for the app and the background sender, whatever this window or .env says). By hand:
 *
 *   node --import tsx scripts/seed-m6-manual.ts --state own
 *   node scripts/fake-mailgun.mjs --port 4013 --app http://127.0.0.1:3105 --domain example.com --region US --plan free --mx-elsewhere --settings-applied
 *   $env:PP_E2E_STATE = "own"; npm run test:e2e
 */

const state = e2eStateFromEnv();
const baseURL = e2eBaseUrlFromEnv(state);
const instance = E2E_INSTANCES[state];
const appPort = Number(new URL(baseURL).port);

type WebServer = NonNullable<Extract<PlaywrightTestConfig["webServer"], readonly unknown[]>>[number];

/** The fakes and the app for this state (each reused when it already answers). */
function webServers(): WebServer[] {
  const database = manualCheckDatabase(state);
  if (!fs.existsSync(path.join(ROOT, database))) {
    throw new Error(`${database} doesn't exist yet. Seed it first: node --import tsx scripts/seed-m6-manual.ts --state ${state}`);
  }
  const fake = `http://127.0.0.1:${instance.fakeMailgunPort}`;
  // The own state has no public address (MAIN-DOMAIN-DESIGN §9.4): none here, and run-prod.mjs empties it.
  const noPublicAddress = instance.publicAddress === false;
  const env: Record<string, string> = {
    ...(noPublicAddress ? {} : { APP_PUBLIC_URL: baseURL }),
    OUTREACH_MAILGUN_BASE_URL: fake,
    OUTREACH_ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_CLAUDE_PORT}`,
    OUTREACH_WEB_FIXTURES: WEB_FIXTURES_DIR,
  };
  const app: WebServer = instance.worker
    ? {
        name: `app ${state}`,
        command:
          `node scripts/run-prod.mjs --db ${database} --port ${appPort} --host 127.0.0.1 --no-build ` +
          `--pid-file run/m6-${state}.pid --stop-file run/m6-${state}.stop --log-prefix m6-${state}-` +
          (noPublicAddress ? " --no-public-address" : ""),
        url: `${baseURL}/api/health`,
        env,
        reuseExistingServer: true,
        timeout: 180_000,
      }
    : {
        // The busy instance runs without the background sender (§9.4), so it is the web app alone.
        name: `app ${state} (web only)`,
        command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${appPort}`,
        url: `${baseURL}/api/health`,
        env: { ...env, DATABASE_URL: `file:./${database}`, OUTREACH_TEST_RUN: "1" },
        reuseExistingServer: true,
        timeout: 120_000,
      };
  return [
    {
      name: "fake Mailgun",
      // --app, --dkim-authority (ready, live) and the instance's own flags (own: example.com, US, Free, MX elsewhere).
      command: `node scripts/fake-mailgun.mjs --port ${instance.fakeMailgunPort} ${fakeMailgunArgs(state, appPort)}`,
      url: `${fake}/__fake/state`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      name: "fake Claude",
      command: `node scripts/fake-claude.mjs --port ${FAKE_CLAUDE_PORT} --sites ${WEB_FIXTURES_DIR}`,
      url: `http://127.0.0.1:${FAKE_CLAUDE_PORT}/__fake/requests`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    app,
  ];
}

export default defineConfig({
  testDir: "tests/playwright",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: `test-results/runs/${state}`,
  reporter: [["list"], ["html", { outputFolder: `playwright-report/${state}`, open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    locale: "en-GB",
    timezoneId: E2E_TIME_ZONE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The phone runs first, so go-live.spec.ts checks the dialog at 390 px before the laptop run switches go-live on.
  projects: [
    {
      name: "phone",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    { name: "laptop", use: { browserName: "chromium", viewport: { width: 1366, height: 800 } } },
  ],
  webServer: process.env.PP_E2E_NO_SERVER === "1" ? undefined : webServers(),
  // Runs after the servers are up (started or reused): a ready/live fake without example.com's DKIM key is refused.
  globalSetup: "./tests/playwright/fake-check.ts",
});
