# Polygon Paradise Outreach: for developers

The owner's manual is the [README](../../README.md) at the top of the folder, with the four guides in `docs\setup\`. This file is for whoever works on the code.

## Start here

1. Read [CONVENTIONS.md](CONVENTIONS.md) first, including its "M3: Mailgun rules", "M4: sequences and replies rules", "M5: address checks and AI rules" and M6 sections. It says how code is written here and which rules reviewers check.
2. Then [PLAN.md](../../PLAN.md) (what was planned, Part A for the owner and Part B technical) and [SPEC.md](../../SPEC.md) (the brief).
3. The design files say how each part was built and why:
   - [M3-DESIGN.md](M3-DESIGN.md): sending through Mailgun, the domain checklist, the reply test, backups and restores after a copy;
   - [M4-DESIGN.md](M4-DESIGN.md): follow-ups, replies and notifications;
   - [M5-DESIGN.md](M5-DESIGN.md): address checks, AI personal lines and the missing-emails round trip;
   - [M6-DESIGN.md](M6-DESIGN.md): the dashboard, settings polish, backups and restore, and going live;
   - [SHARED-FROM-DESIGN.md](SHARED-FROM-DESIGN.md): the shared From address (the owner's decision of 2026-09-27): every email From contact@polygonparadise.com, sent through mail.polygonparadise.com with each sender's own address as Reply-To; empty means per-person mode, as before.
   - [MAIN-DOMAIN-DESIGN.md](MAIN-DOMAIN-DESIGN.md): own-mailbox mode (the owner's final decision of 2026-09-27, Setting `mailgun.replies = "own-mailbox"`): sending through polygonparadise.com itself on Mailgun's Free plan, every email From contact@polygonparadise.com with no Reply-To, replies marked by hand (They replied) and the daily inbox check; its code map is `main-domain-code-map.md`.

   The code maps (`m3-code-map.md` to `m6-code-map.md`, `shared-from-code-map.md`), `m6-leftovers.md`, `m6-docs-audit.md` and the `research\` folder are the background to those designs.

**The code and its tests win over the design files.** The designs were written before the code; review fixes are named in the test headers, and where a design and the code disagree, the code and its tests are right.

## Layout

- `src\core\` pure logic shared by the web app, the worker and the tests; `src\server\` database and network code shared by both processes; `src\lib\` web-only helpers; `src\app\` routes; `src\components\` React components (`ui\` is shadcn).
- `worker\` the background sender (bundled into `dist\worker.mjs` by `node scripts\build-worker.mjs`, whose `--self-test` prints "packages ok").
- `scripts\` the Node and PowerShell scripts behind the `.bat` files; their helpers in `scripts\lib\` are unit-tested in `tests\unit\ops\`. The `.bat` and `.ps1` files stay ASCII with CRLF line endings (`tests\unit\ops\script-files.test.ts`).
- `tests\unit\`, `tests\integration\`, `tests\fixtures\`, `tests\playwright\` (the screen checks).
- `docs\setup\` the owner's guides. The app and the scripts cite their step numbers ("Going-live guide, step 3", `docs\setup\1-install.md, Troubleshooting`); `tests\unit\docs\guide-refs.test.ts` fails when a cited step or heading goes missing, so renumber a guide only together with those texts.

## Checks

- `npm run check` runs everything a change must pass: `next typegen`, `tsc --noEmit` (web and worker), `eslint` and the whole `vitest run`.
- While working, run only your own parts: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`, `npx eslint <paths>`, `npx vitest run <test paths>`.
- Never run tests or scripts against `data\app.db` (the owner's real data). Tests that need a database create their own with `createTestDb()` (`tests\integration\helpers\test-db.ts`).

## No real network, ever

Tests and manual checks never reach the real Mailgun, the real Anthropic API, Cloudflare or a real website:

- **Mailgun:** the local fake server in `tests\fake-mailgun\` (`connectFakeMailgun()` in tests; `node scripts\fake-mailgun.mjs --port 4010 --app http://127.0.0.1:3100` for manual checks). M3-DESIGN §6 describes it, M4-DESIGN §7.3 its reply presets (`POST /__fake/inbound` with `preset` "reply", "out-of-office", "unclear", "bounce-notice", "new-email" or "spam"), M5-DESIGN §7 its address-check route.
- **Claude:** the local fake in `tests\fake-claude\` (`connectFakeClaude()` in tests; `node scripts\fake-claude.mjs --port 4020 --sites tests\fixtures\sites` for manual checks).
- **Websites:** the saved fixture sites on `.example` addresses in `tests\fixtures\sites\`.
- `tests\setup\env.ts` sets `OUTREACH_TEST_RUN=1`, which makes every Mailgun call refuse anything but `http://127.0.0.1:<port>`, and a test run never checks a non-loopback public address. `scripts\run-prod.mjs` gives every test-run instance a loopback `APP_PUBLIC_URL`.

## Manual checks on a test database

Manual-check databases live in `data\manual-check\`, never in `data\test\` (the background sender's daily clean-up empties it) and never `data\app.db`.

- `node --import tsx scripts\seed-m5-manual.ts` writes `data\manual-check\m5.db` (M5-DESIGN §7.5).
- `node --import tsx scripts\seed-m6-manual.ts --state <empty|busy|ready|live|own|all>` writes `data\manual-check\m6-<state>.db`, the five states the screen checks use (M6-DESIGN §9.4; `own` is the owner's own-mailbox shape, MAIN-DOMAIN-DESIGN §9.4). Every seeded address is on `example.com` or a `.example` domain.
- Start an instance on such a database with its own fake Mailgun, the fake Claude and the fixture sites: set `OUTREACH_MAILGUN_BASE_URL`, `OUTREACH_ANTHROPIC_BASE_URL` and `OUTREACH_WEB_FIXTURES`, then `node scripts\run-prod.mjs --db data\manual-check\<file>.db` (it sets `OUTREACH_TEST_RUN=1` itself). When it has to upgrade such a database first, its "Before a database upgrade" backup goes to `backups\<file name>\`, the folder the app's `backupFolderFor` gives that database, never among the real app's backups.
- Rehearse a restore on such a database with `node scripts\restore.mjs <backup> --db data\manual-check\<file>.db --backups-dir backups\<file name>`: it needs no administrator rights. `restore.bat` passes every argument on when it asks Windows for permission, but with the services installed it always asks, so call `restore.mjs` directly.

## The screen checks (`npm run test:e2e`)

The Playwright + axe suite in `tests\playwright\` (config `playwright.config.ts`) checks the screens of running instances at laptop and phone width. It isn't part of `npm run check`: it needs built, running instances, so the lead runs it (M6-DESIGN §9.4):

1. Stop the services, run `next build` and `node scripts\build-worker.mjs`.
2. Seed the five databases (`--state all`, above).
3. Start one fake Mailgun per instance (`node scripts\fake-mailgun.mjs --port 4010 --app http://127.0.0.1:3102`, and 4011 for 3103, 4012 for 3104, both with `--dkim-authority example.com`; for the own state 4013 for 3105 with `--domain example.com --region US --plan free --mx-elsewhere --settings-applied`) and the fake Claude on port 4020. `--settings-applied` starts the fake with tracking off and unsubscribe handling on, as the own seed's recorded "Apply recommended settings" left them: without it the first catch-up pauses sending ("tracking is on in Mailgun") and every own screen shows the paused app. `tests\playwright\instances.ts` has each instance's flags; the run refuses a reused fake started without them.
4. In each instance's window set `APP_PUBLIC_URL=http://127.0.0.1:<its port>`, `OUTREACH_MAILGUN_BASE_URL=http://127.0.0.1:<its fake>`, `OUTREACH_ANTHROPIC_BASE_URL=http://127.0.0.1:4020` and `OUTREACH_WEB_FIXTURES=tests/fixtures/sites`, then start `node scripts\run-prod.mjs --db data\manual-check\m6-<state>.db --port <port> --host 127.0.0.1 --no-build --pid-file run\m6-<state>.pid --stop-file run\m6-<state>.stop --log-prefix m6-<state>-` for empty (3101), ready (3103), live (3104) and own (3105; without `APP_PUBLIC_URL` and with `--no-public-address`, like the owner's PC). The busy instance (3102) runs the web app only, without a background sender, so its old backup, pauses and "background sender" item stay: set also `DATABASE_URL=file:./data/manual-check/m6-busy.db` and `OUTREACH_TEST_RUN=1`, then `node node_modules\next\dist\bin\next start -H 127.0.0.1 -p 3102`.
5. Run the suite per state, for example `$env:PP_E2E_STATE = "busy"; $env:PP_E2E_BASE_URL = "http://127.0.0.1:3102"; npm run test:e2e`. The config refuses any base address that isn't `http://127.0.0.1:<port>`. `go-live.spec.ts` changes the `ready` database: reseed it right before that spec and again afterwards. Reseed `own` right before its run too: the go-live test in `own-mailbox.spec.ts` needs a checklist check less than an hour old. That age is the only reason it may skip; any other go-live blocker (a pause, above all) fails it with the card's list.

Steps 3 and 4 are optional: `playwright.config.ts` uses an instance (and its fakes) that already answers on the state's port, and otherwise starts them itself the same way (`run-prod.mjs --no-build`; busy as `next start` without a background sender) and stops them at the end. `PP_E2E_BASE_URL` defaults to the state's port; `$env:PP_E2E_NO_SERVER = "1"` starts nothing. Screenshots go to `test-results\shots\`, traces and failure screenshots to `test-results\runs\<state>\`, and the HTML report to `playwright-report\<state>\index.html`.

Never run `npx playwright install`: Chromium is already installed.
