# Milestone 6 build design: Finish and go live

Written 2026-09-27 by the architect, for the lead and the build agents. It turns PLAN.md A8 item 6 (and the M6 parts of
A1, A6, A9 item 5, B6.5, B6.6, B6.7, B6.14, B7, B8, B11 and B12) and SPEC §11, §12, §13, "Testing and definition of
done" and the README list into decisions, contracts, screens, copy and work packages that 3–5 engineers per wave can
build in parallel without talking to each other.

Sources, all read in full: `SPEC.md`; `PLAN.md` (A1, A3 Q7–Q12, A5, A6, A8, A9, B1, B4, B6.1, B6.5–B6.8, B6.14, B7, B8,
B10, B11, B12); `docs/dev/CONVENTIONS.md`; `docs/dev/M5-DESIGN.md` (§0, §5, §8, §9, §10, the format); `docs/dev/M3-DESIGN.md`
§9.3; the M6 rows of `docs/dev/M4-DESIGN.md` (§1.4, §4, §5.1); `docs/dev/m6-code-map.md`, `docs/dev/m6-leftovers.md`,
`docs/dev/m6-docs-audit.md`; and the code they point at (`core/rules/mode.ts`, `core/rules/eligibility.ts`,
`core/sending/{label,mode-gates,warmup}.ts`, `core/dns/checklist.ts` remote-access row, `core/system-state*.ts`,
`server/settings.ts`, `server/sending-state.ts`, `server/mailgun/send-guard.ts`, `server/notifications.ts`,
`server/services/{backups,eligibility,reply-test}.ts`, `server/services/sending/{warmup-days,restore,gates}.ts`,
`server/services/checks/tunnel.ts`, `server/services/mailgun/catch-up.ts`, `server/services/ai/queue.ts`,
`app/(app)/settings/{sending,backups}/**`, `components/settings/**`, `components/contacts/get-started.tsx`,
`components/shell/sending-pill.tsx`, `lib/auth/dal.ts`, `worker/{main,periodic,schedule,index}.ts`,
`worker/jobs/{backup,cleanup}.ts`, `scripts/{restore,run-prod}.mjs`, `scripts/lib/backups.mjs`, `tests/setup/env.ts`,
`vitest.config.ts`, `package.json`, `package-lock.json`, `prisma/schema.prisma`, the M5 end-to-end test).

Where this file and PLAN.md disagree, this file wins for M6; every difference is listed in §10.2 (technical, the lead
confirms) or §10.3 (visible to the owner).

**Revised 2026-09-27 after the spec and risk critiques.** Every finding was checked against PLAN, SPEC and the code;
accepted ones are applied in place, and §11 lists every finding with its decision (accepted, accepted with a change, or
rejected) and a one-line reason. The main changes: going live now also needs Mailgun connected, Setup A, a fresh
checklist and a *delivered* live test on the current domain, and it re-checks its inputs inside its transaction;
changing the sending domain ends go-live (go live again on the new domain); a campaign launched before go-live stays
test-list-only at every layer (send-time re-check and Mailgun client guard included); drafts made before go-live need a
confirmation; health numbers count from go-live and today's hand-set limit is removed; backups run off the event loop,
are checked by SQLite, keep 14 daily + 5 Back up now, happen at least once a day, and the second folder is safer
(marker file, drive checks, save-then-grant); restore.bat is safer (free space, version, practice copy, atomic swap,
admin only for the real database); the dashboard gets the "Replies waiting for an answer" list and reads go-live from
settings only; test runs never reach a real public address.

**Nothing in M6 may ever call the real Mailgun, the real Anthropic API, a real website or Cloudflare during the build,
the tests or the lead's checks.** Mailgun is the local fake (`tests/fake-mailgun/**`), Claude the local fake
(`tests/fake-claude/**`), websites the fixture sites, remote-access checks an injected `fetchImpl`, DNS the fake
`DnsLookup`. Playwright runs only against the app started by `scripts/run-prod.mjs --db data/manual-check/<file>.db`
(which sets `OUTREACH_TEST_RUN=1`) with the fakes. Nobody on the build side opens `data/app.db`, not even read-only. The
owner's Q8–Q12 are still unanswered: during the build the "Go live" switch is exercised only against the fake Mailgun;
the owner switches it on for real by following the new going-live guide (§6.4).

---

## 0. How to use this document

### 0.1 Order of work

| Step | Who | What | Blocks |
|---|---|---|---|
| **C** (contracts) | Lead, before wave 1 | Stop the services and every `next dev`/worker window. Make htmlparser2 and encoding-sniffer direct dependencies (§7.5) and prove `npm ci` rebuilds the tree. Apply the schema comment edits and the data-only migration `20260927120000_m6_go_live` (§7.6–§7.7); `npx prisma generate`. Write the contract files and edits of §7.8–§7.9 (including two moves of existing code, behaviour unchanged). Edit `tests/setup/env.ts` (L16) and delete `data\test-unit.db`, `-shm`, `-wal`. Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json` and `npx vitest run`: everything passes unchanged (the contract edits keep behaviour; the new options are unused until the packages use them). | everything |
| **Wave 1** | P1, P2, P3, P4, P5 in parallel | P1 the "emailed" rule and the test-list guard at every layer (eligibility, send-time re-check, loop, Mailgun client), the launch's "made before go-live" refusal. P2 the go-live switch, checklist and recommendations, warm-up start and line, health counted from go-live, the domain change ending go-live, mode words (wizard, Verify, top bar fallback) and Settings › Sending & Mailgun. P3 backups (off the event loop, checked, per-kind retention, daily guarantee, second-folder safety), restore safety (app, worker, scripts, Settings › Backups), the test-run public-address guard. P4 the dashboard's building blocks (waiting replies per person and the viewer's list, reply rate, pipeline, dry-run numbers, unconfirmed emails, team activity, Mailgun configured) and the old-domain catch-up state. P5 settings polish on every other settings page, the new rule settings with their confirmation, the Access opt-out and the Member-refusal sweep. | wave 2 |
| **Wave 2** | P6, P7, P8, P9 in parallel | P6 the final README, guides 1–3, the new guide 4, the developer README and the owner-facing script texts. P7 the dashboard, its attention list, "Get started" and the landing-page switch. P8 the M6 end-to-end tests (SPEC definition of done with dashboard numbers; go-live against the fake Mailgun). P9 the Playwright + axe suite, its config and the M6 manual-check seed script. | P10 |
| **Final** | P10 (one agent) | Integration: the dashboard-view assertions of the M6 end-to-end tests (§9.3 "P10" lines), doc lists (activity, notifications, notice keys), activity filters, the old milestone end-to-end tests and seed script, the "no Milestone text" test (strings and JSX only in code) and doc-reference checks, CONVENTIONS "M6", PLAN/M3/M4 header notes (L22, L23), full `npm run check`, the worker bundle self-test. | step S |
| **S** (screens) | Lead, after P10 | Stop the services; `next build` and `node scripts/build-worker.mjs`; seed the four manual-check databases (§9.4); start one fake Mailgun per instance, the fake Claude and the app instances with loopback public addresses; run `npm run test:e2e` (Playwright + axe) and the manual checks of §9.5, including the restore rehearsal on a test copy. | milestone review |

### 0.2 Rules for every builder (in addition to `docs/dev/CONVENTIONS.md`)

1. Only edit your **owned paths** (§8). Contract files from step C are read-only for everyone: if one is wrong or
   missing something, STOP and report it in your final answer (the lead fixes it and tells the others).
2. Code against the interfaces in this document. In wave 2 you may import from wave-1 packages (their exports named
   here), the contract files and existing code, never from a wave-2 peer. Cross-package wiring inside wave 2 is P10's.
3. Every user-visible sentence in this document is the copy to use. Change wording only to fix grammar; keep meaning.
   No "Milestone N", no PLAN question numbers (Q8…), no builder's voice ("I", "tell me") in any screen, script or doc.
4. No new npm packages beyond §7.5. `@playwright/test` 1.63.0 and `@axe-core/playwright` 4.13.0 are already installed
   (dev), and Chromium 1243 is already in `%LOCALAPPDATA%\ms-playwright`; never run `npx playwright install`.
5. **No real network** (see the paragraph above). Manual-check databases live in `data\manual-check\`, never in
   `data\test\` (the worker's clean-up empties it) and never `data\app.db`.
6. **Go-live has two doors.** `sending.goLive = true`, `sending.goLiveAt`, `sending.goLiveDomain`, the removal of
   today's hand-set limit and the warm-up restart at go-live are written only by `goLive()`
   (`src/server/services/go-live.ts`, P2). `sending.goLive = false` is written only by a sending-domain change in
   `connectMailgun` (`src/server/services/mailgun/connect.ts`, P2, §2.8): go-live is one-way per sending domain.
   Tests may still set `sending.goLive` directly when they test something else, and the manual-check seed scripts
   (P9's and P10's update of `seed-m5-manual.ts`) write the same rows `goLive()` would (a seed has no running worker and
   no delivered live test, so the service's blockers would refuse); new tests of go-live itself call the service or the
   action.
7. **"Emailed" and "test-list only" are judged per campaign, never from today's switch** (§2.2, §2.3). Code that
   decides the 30-day rule, reservations, company status, `lastEmailed*`/`firstContacted*`, "changes status" for a
   reply, the " (test list)" suffix, the send-time re-check and the Mailgun client guard's `testListOnly` passes the
   campaign's `launchedGoLive`. Today's `sending.goLive` is read only by: eligibility in the draft and at launch (the
   test-list rule), the top-bar label, the mode words, the gates, the go-live card and the dashboard.
8. **The dashboard only reads.** Its loaders never write, never call Mailgun, never call `getMailgunContext` (which
   decrypts keys and may write) or `loadGateInputs`, and every list query has a `take` (≤ 10). One loader per tile, all
   started together (§4.6). Client components get plain strings and numbers only.
9. **Backups:** only `runBackup` (`server/services/backups.ts`) writes app backups (through the child process
   `scripts/vacuum-into.mjs`, never on the worker's event loop), only the scripts write script backups
   (`scripts/lib/backups.mjs makeBackup`), and only `pruneBackupFolders` (P3) deletes backup files.
10. **Settings pages follow §5.1** (one orange button, sentence case, Owner guard, toast on every save, empty states,
    errors with the fix, phone width).
11. Commands: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`, `npx eslint <owned paths>`,
    `npx vitest run <own test paths>`. Never `next build/dev/start`, `npm install`, `prisma migrate *`,
    `npx playwright test` (the lead runs the suite in step S).
12. **Layers** (CONVENTIONS "Layout"): `src/core/**` never imports `src/components/**`, `src/server/**` or
    `src/app/**`; `src/server/**` never imports `src/app/**` or `src/components/**`. Page-level loaders that combine
    server services with component helpers live in `src/app/**` (e.g. `src/app/(app)/dashboard/load.ts`).
13. **No test run reaches a real host.** A test run (`OUTREACH_TEST_RUN=1`, Vitest) never fetches a non-loopback
    public address (P3's guard in `checkPublicAddress`), `run-prod.mjs` gives every test-run instance a loopback
    `APP_PUBLIC_URL`, and manual-check instances use the fake Mailgun, the fake Claude and the fixture sites (§9.4).

### 0.3 Words used in this document

| Word | Meaning |
|---|---|
| **Go-live** | Setting `sending.goLive = true`, written by `goLive()`; `sending.goLiveAt` holds when (ISO), `sending.goLiveDomain` on which sending domain, and the `sending.goLiveAt` row's `updatedById` who. One-way per sending domain: only a domain change ends it (§2.8). |
| **Launch flag** | `Campaign.launchedGoLive`: `sending.goLive` at the campaign's launch. After the M6 migration it is `true`/`false` for every launched campaign; `null` only for drafts. |
| **Counted** | `countsAsReal(mode, practiceCopy)`: LIVE, and DRY_RUN in the practice copy. Daily limit, warm-up, health, reply linking. Unchanged. |
| **Emailed** | `countsAsEmailed(mode, {practiceCopy, launchedGoLive})`: counted, except LIVE sends of a campaign launched before go-live. 30-day rule, reservations, company status, `lastEmailed*`, `firstContacted*`, "changes status". |
| **Test-list send** | A LIVE send of a campaign launched before go-live (it could only reach test-list mailboxes). Counted, never emailed, before and after go-live. |
| **Test-list only** | `testListOnly(mode, goLive)` = TEST always, LIVE before go-live: such sends may only reach the test list. At send time `goLive` is the campaign's launch flag. |
| **App backup** | A backup the background sender makes (`app-YYYY-MM-DD-HHmmss-xxxx.db`, kinds Daily / Back up now), with a `Backup` row. The newest 14 daily and 5 Back up now are kept. |
| **Live test** | The go-live proof (§2.4): a SENT LIVE email of a campaign on the current sending domain, to an address on the current test list, with a `delivered` event and no permanent failure. |
| **Script backup** | A backup a script makes (`app-preupdate-…`, `app-prerestore-…`, `app-premigrate-….db`): Before an update / Before a restore / Before a database upgrade. No row. |
| **Attention item** | One line in the dashboard's "Needs your attention" list: text, tone, optional link (§4.2). |
| **Tile** | One dashboard section after the attention list (§4.3). |
| **Quiet time** | A moment when no gated email (TEST/LIVE, or a dry run that keeps sending hours) is due with its window open (§3.5). The daily backup prefers it but never waits for it past 20:00 of a day without a backup (review fix BACKUPS-8, §12: past 20:00 only while a quiet slot is still ahead that day, so 22:00 at the latest with the default hours). |
| **Manual-check database** | A seeded test database in `data\manual-check\` (P9's seed script), used by the lead and Playwright. |

---

## 1. Scope

### 1.1 PLAN A8 item 6, bullet by bullet

| A8 M6 bullet | Built by | Main modules |
|---|---|---|
| The dashboard | P4 (data blocks), P7 (page, attention list, landing) | `src/server/services/dashboard/**`, `src/core/dashboard/**`, `src/app/(app)/dashboard/**`, `src/components/dashboard/**` |
| Settings polish | P5 (every page but Sending and Backups), P2 (Sending & Mailgun), P3 (Backups) | `src/app/(app)/settings/**`, `src/components/settings/**` |
| Backups: "Back up now" | exists (M1); P3 adds tests, the kind vocabulary, its own retention (newest 5), the off-loop vacuum and SQLite's check | `server/services/backups.ts`, `scripts/vacuum-into.mjs`, Settings › Backups |
| Backups: a second folder | exists (M1); P3 adds network/mapped-drive/drive-root/practice-copy refusals, the marker file, save-then-grant, the first copy on save, safe copies, the drive and OneDrive warnings; P7 the dashboard's copy-failed item | `checkSecondFolder`, `runBackup`, `service-acl` |
| Backups: the dashboard's old-backup warning | P3 (`backupStatus`), P7 (attention items) | §3.6, §4.2 |
| Backups: a tested restore | P3 (automated round trip, "Last restore", script backups listed, restore.bat labels), lead (manual rehearsal) | §3.7, §3.8 |
| The final README and guides | P6 | `README.md`, `docs/setup/**`, `docs/dev/README.md` |
| The full automated end-to-end test | P8 (+ P3's restore round trip) | `tests/integration/milestone6/**`, `tests/integration/backups/restore-round-trip.test.ts` |
| Go-live checklist; switch on "Go live" (with confirmation) | P2 | §2.4, §2.5 |
| Switch new campaigns to live | P2 (`goLive()` sets `sending.mode = "LIVE"`; the wizard confirms drafts made before go-live), P1 (launch refusal) | §2.5, §2.7 |
| Warm-up starts | P2 (`startWarmupAtGoLive`, self-healing in `evaluateWarmupDays`; health counted from go-live) | §2.6 |
| *You'll test:* the dashboard numbers | P8 Part A asserts them; P7 page; guide 4 step 11 | §9.3 |
| *You'll test:* a backup and a restore | P3 round trip; lead rehearsal (§9.5); guide 4 step 5; README "Backups and restore" | §3.8 |
| *You'll test:* a PC restart | owner, guide 4 step 4 (services must be installed first, m6-leftovers §E) | §6.4 |
| *You'll test:* the first real, small campaign together | owner, guide 4 step 10 | §6.4 |

### 1.2 SPEC sections

| SPEC | M6 part | Where |
|---|---|---|
| §3 "The number of days is a setting" (30-day rule) | Owner editor for `teamRule.days` | §5.3 |
| §11 Dashboard | attention first (replies per user, AI lines, paused campaigns, missing emails), then the viewer's replies waiting for an answer (PLAN Q7, A6), pipeline + reply rate, sent today vs cap + warm-up, bounce/complaint rates with thresholds, active campaigns with progress, recent team activity | §4 |
| §12 Settings | Owner: every listed item exists; M6 adds the 30-day rule length (plus the shared-domain list and the paused-reservation expiry from B6.14). Everyone: profile, signature, time zone, notification preferences | §5 |
| §13 Backups | daily (at least once a day, §3.5), keep 14 daily (plus 5 Back up now, §3.3), "Back up now", README restore | §3, §6.2 |
| Testing and DoD: type-check, lint, tests, production build on Windows | P10 `npm run check`; lead `next build` in step S | §9 |
| Testing and DoD: end-to-end dry-run check steps 1–5 | P8 Part A (dashboard numbers included) | §9.3 |
| README for a non-developer (7 topics) | P6 | §6.2, §10.4 |

### 1.3 PLAN Part B sections, M6 parts

| Section | M6 part | Package |
|---|---|---|
| A1 cost table | wrong "5,000 address checks included": the README is the reference; PLAN gets a header note | P6, P10 |
| A6 Dashboard row, wording table, empty states, errors | the dashboard in A6's words ("You 3 · Ali 1", the worker sentence); the warm-up line becomes "Warm-up step 9 of 20: 177 a day. …" because A6's "day 9 … tomorrow's limit 207" was untrue on hold days (§2.6, §10.3) | P7, P2 |
| A6 status label | unchanged four labels; after go-live Test mode still reads "Test list only" and is true (§2.7); the label's fallback no longer hard-codes "not live" | P2 |
| A9 item 5 | second backup folder (USB, second disk or OneDrive) + a copy of `.env`: Get started step 4, guide 4 step 5 | P7, P6 |
| B6.5 | go-live switch with confirmation; the guard off for live after go-live only for campaigns launched after it; "a dry-run campaign is never sent after switching to live" tested across the flip; dry-run numbers shown separately on the dashboard | P1, P2, P4, P7, P8 |
| B6.6 | warm-up table and rules unchanged; the ramp restarts at go-live (§2.6) and health counts from go-live; health next to Mailgun's limits on the dashboard | P2, P7 |
| B6.7 | restore report kept after Resume ("Last restore", with who resumed); tested round trip; a safer restore.bat (§3.7) | P3 |
| B6.14 | backups: quiet time from the sending windows with a daily guarantee, keep 14 daily + 5 Back up now, second folder, 36-hour and disk-space dashboard warnings, `update.bat` backs up first (exists); settings list complete (shared domains, paused-reservation expiry) | P3, P5, P7 |
| B7 | new server actions (§8); `GET /api/campaigns/:id/progress` stays unbuilt (the dashboard and campaign page refresh with `router.refresh`); the Member-refusal sweep over every `"use server"` file | P2, P3, P5, P10 |
| B8 | no new job types; `backup.daily` due rule uses quiet time and a daily guarantee; `--backup` CLI option removed (unused) | P3 |
| B11 | restore.bat labels and safety; update delivery documented (delete the code folders first); Node 24 download route in every script text; firewall, antivirus, cloudflared-version and Node-26 lines in the README; the app folder out of Pictures/OneDrive (guide 4 step 4, status.bat) | P3, P6 |
| B12 | E2E step 6 dashboard tiles; Playwright + axe screen checks committed (signed-out pages included); Owner-only actions refused for Members (one sweep) | P8, P9, P5 |

### 1.4 What earlier milestones left for M6, and the decisions (m6-leftovers L1–L23, code map, docs audit)

| # | Leftover | Decision | Package |
|---|---|---|---|
| L1 | "Emailed" follows today's go-live | **Fix**: judged per campaign by the launch flag; the data migration makes old launches explicit (§2.2) | P1 (step C contract) |
| L2 | Label and mode texts don't know go-live; the guard lets Test mode reach anyone after go-live | **Fix**: Test mode stays test-list-only for good (G3), so the label stays true; a campaign launched before go-live stays test-list-only at every layer (G2); mode words, wizard badge, Schedule line, Verify step, top-bar fallback and confirmation become go-live-aware (§2.7) | P1 (guard, eligibility, re-check), P2 (words) |
| L3 | Go-live wiring (switch, time, mode, Access exception, test mailboxes) | **Fix** (§2.4, §2.5, §2.8); a domain change ends go-live (G8) | P2, P5 (Access switch UI) |
| L4 | Warm-up doesn't start at go-live | **Fix**: restart at go-live, self-healing if the restart failed; health counted from go-live (§2.6) | P2 |
| L5 | Script backups invisible, never pruned, never copied | **Fix**: listed with their kind, pruned (newest 3 per kind, never younger than 14 days), not copied to the second folder (documented); the practice copy never copies; scripts' `.tmp-*` leftovers removed (§3.2–§3.4) | P3 |
| L6 | README lacks team, moving PCs, go-live, misfiled reply | **Document** (§6.2) | P6 |
| L7 | A regained lease skips the fresh check with Mailgun | **Fix**: `holdLease` moves `startedAt` to now before `startup()` every time | P3 |
| L8 | `app.db` alone copied to the same path on a new PC | **Fix**: `InstanceState.host` (JSON, contract) compared when the note is missing | P3 |
| L9 | Outage hold on retried / later-launched recipients invisible per row | **Defer** the per-row text (§1.5): needs a >5-day outage plus a Retry or a new TEST/LIVE launch during the hold; the send gate holds them only while HELD rows of that sender or company exist, so M6's dashboard item (shown while the outage is found and not yet applied, or while anyone is held) names the hold and says "Emails you retried after that wait too." | P7 (item) |
| L10 | Old-domain catch-up problems only logged | **Fix**: kept in `CatchUpState.oldDomains` (contract), shown on Sending & Mailgun and the dashboard, Owner notice after 24 hours | P4 (writer), P2, P7 (readers) |
| L11 | `teamRule.days`, `sharedDomains.extra`, `reservations.pausedExpiryDays` have no screen | **Fix**: card "The 30-day rule" on Limits & warm-up, with an impact confirmation and one transaction (§5.3) | P5 |
| L12 | "Milestone 6" placeholders, landing on Contacts | **Fix**: dashboard replaces `ComingLater` (deleted); home is `/dashboard` (§4.5); texts in §2.7; code comments may keep "Milestone" (the test reads strings and JSX only, §8 P10) | P7, P2, P6, P10 |
| L13 | htmlparser2 / encoding-sniffer only via cheerio | **Fix** in step C (§7.5); cheerio stays a dependency | Lead |
| L14 | No Playwright/axe suite | **Fix**: a small committed suite (§9.4), run by the lead in step S | P9, lead |
| L15 | Clean-up deletes any `data\test` file older than a day | **Fix**: only `createTestDb` names (`<name>-<pid>-<ms>-<rand>.db` and its `-wal`/`-shm`/`-journal`) and build-worker's throw-away database; never `*.instance` | P3 |
| L16 | `tests/setup/env.ts` default DB next to `app.db` | **Fix** in step C (§7.9) | Lead |
| L17 | Backup quiet window fixed 22:00–08:00 PKT | **Fix**: quiet time from the sending windows, fixed window as fallback, a daily guarantee at 20:00, overdue at 30 h (§3.5) | P3 |
| L18 | "Last emailed: Never" for a test mailbox | **Fix + document**: tooltip on that cell (§2.2); README sentence | P1, P6 |
| L19 | `AiDraft.readAttempts` comment outdated | **Fix** in step C (comment only) | Lead |
| L20 | `OUTREACH_BACKUP_DIR` set but unread | **Fix**: remove the line | P3 |
| L21 | `countsAsReal` alias on company sequences | **Fix** with L1 | P1 |
| L22 | M3/M4 designs lack their review fixes | **Document**: header line "The code and its tests win; review fixes are named in test headers" and fix M3 §4.3.7 | P10 |
| L23 | CONVENTIONS package list, PLAN B7 route list | **Document** | P10 |
| map §2.7 | `worker --backup=KIND` unused | **Remove** it (`worker/index.ts`, `backupOnce` in `worker/main.ts`) | P3 |
| map §2.7.1 | Restore report gone after Resume | **Fix**: "Last restore" card on Settings › Backups; `resumeSending` records who resumed after any restore (§3.7) | P3 |
| map §5.2 | Mixed save styles, Members sent to /contacts, Notifications metadata title, Team title from a client component, Footer card without header, Domain's Apply always orange | **Fix** (§5.1, §5.2) | P5, P7 |
| map §5.3 | `verification.provider` read nowhere | **Keep** the key; Settings › Deliverability shows "Address checks by Mailgun" (read-only); no editor until another provider exists | P5 |
| audit 0.5 | restore.bat says "Backup" for daily and Back up now | **Fix**: restore.mjs reads the `Backup` rows (read-only) for the kind; one vocabulary everywhere (§3.2) | P3 |
| audit 0.6 | Second-folder hint suggests a network share | **Fix**: network paths and mapped network drives refused; save-then-grant with install-services.bat; hint rewritten (§3.4) | P3 |
| audit §2.6 | "…then run setup.bat again" texts miss update.bat for services | **Fix**: one sentence everywhere (§5.2), owners named per file | P2, P5 |
| owner PC | The app lives in `C:\Users\polyg\Pictures\outreach` and OneDrive is signed in | **Fix + document**: go-live recommendation, status.bat warning, guide 4 step 4 moves it to `C:\Outreach` | P2, P3, P6 |
| audit 0.10 | Node 26 becomes "LTS" | **Fix**: every script text names the 24.x route (§6.6) | P6 |
| audit 0.11 | `.env` has unread `MAILGUN_*` lines | **Document**: guide 4 step 1 says to delete them; the app never reads `.env` for keys | P6 |

### 1.5 Deferred (not built in M6)

| Item | Why it can wait | Hook left |
|---|---|---|
| L9 per-row "On hold" text for recipients the outage hold covers after a Retry or a later launch | rare (needs a >5-day outage plus a Retry/launch during it); the gate holds them and the dashboard names the hold | `outageHeldIds(cands)` in `gates.ts` can be called read-side |
| A "switch off" for go-live on the same domain ("back to test list only") | one-way is simpler and safe; Pause all sending, Dry run and pausing a campaign stop sending at once (G1); a domain change already ends go-live (G8) | the per-campaign rule (§2.2) makes an off-switch safe |
| `update.bat <zip>` that copies a new version itself, or a shipped file list that removes deleted files (docs audit Q-A option b) | the zip + extract + delete-code-folders + copy + `update.bat` procedure is documented (§6.1) | `update.mjs` step list |
| Exact per-person impact counts for the rule settings ("23 people would be skipped") | needs a full eligibility run over running campaigns; company-level counts are cheap and enough to decide (§5.3) | `saveRules` confirmation lines |
| A supervisor (start.bat) warning for an app folder in Pictures/OneDrive | status.bat and the go-live card already say it (§3.9, §2.4) | `riskyAppFolder` |
| An in-app Help page rendering the README and guides | needs a Markdown renderer package; the docs are plain-text readable | guide references are checked by a test (§6.7) |
| Editable `backups.keep` | SPEC fixes 14 | `normalizeKeep` |
| A verification provider picker | only Mailgun is built | `verification.provider`, `other-maps.ts` |
| `GET /api/campaigns/:id/progress` (B7) | pages refresh with `LiveRefresh` | — |
| Undo a real reply (M4 D27) | rare; README explains the manual way (§6.2) | `CampaignRecipient.stoppedByInboundId` |
| Charts on the dashboard | numbers and neutral progress bars read faster for this team | — |
| Everything in m6-leftovers §D | reasons there | — |

---

## 2. Go live

### 2.1 Decisions

| # | Decision | Why |
|---|---|---|
| **G1** | **The switch is one-way per sending domain.** There is no "switch off" in the app. To stop sending: Pause all sending, set Sending mode to Dry run, or pause the campaign. Only a sending-domain change ends go-live (G8). | PLAN only asks for a switch with confirmation; a way back would need rules for running live campaigns. Pausing already stops everything within seconds. |
| **G2** | **"Emailed" and "test-list only" are judged per campaign** by its launch flag (§2.2, §2.3). A LIVE send counts as emailed only when its campaign was launched after go-live, and a LIVE campaign launched before go-live stays test-list-only at every layer (eligibility at send, the loop's final check, the Mailgun client guard). | M3 §9.3's question. The per-send `sentAt >= goLiveAt` rule would make a pre-go-live test campaign still running after go-live mark the "Test mailboxes" companies Contacted and block them for 30 days; judging "test-list only" by today's switch would let a pre-go-live campaign reach anyone added to it. |
| **G3** | **Test mode (Mailgun's test mode) stays test-list-only for good.** | It exists only to check the connection; after go-live it would bill every prospect and deliver nothing. It also keeps the top-bar label ("Test list only") true. |
| **G4** | **Going live sets Sending mode to Live** ("switch new campaigns to live", A8). Campaigns already running keep their launch mode (B6.5). | A8 names it; it makes the label "Sending live" at once. |
| **G5** | **Warm-up restarts at go-live**: step 0 (50 a day), started today, closed days before today never judged again, history cleared; `evaluateWarmupDays` repairs a restart that didn't happen. Before go-live nothing changes (test-list days are still judged, and the Limits page says the ramp starts at go-live). Going live also removes today's hand-set limit, so day one really starts at 50. | A8 "warm-up starts"; PLAN A5.13 "starts at 50". Test-list sends can't reach 25 a day with 2–3 mailboxes, so nothing real is lost; a 1,000 limit set while testing must not carry into day one. |
| **G6** | **The top-bar label rules don't change** (A6's four labels). After go-live: Live mode → "Sending live"; Test mode with no live campaign → "Test list only" (true, G3); Dry run with a live campaign running → "Sending live". | `sendingLabel` already takes `goLive`; only tests are added. |
| **G7** | **Cloudflare Access is optional** (SPEC). A new Owner setting "We don't use Cloudflare Access" (`remoteAccess.accessOff`, default off, so Access stays required as recommended) turns the remote-access row's "anyone can reach your sign-in page" into ok-with-a-note, and adds a recommendation line to the go-live card. | M3 §9.3 last note; Q11 still unanswered, default = Access. |
| **G8** | **A sending-domain change ends go-live.** `connectMailgun` with a new domain (already refused while any TEST/LIVE campaign is active) writes `sending.goLive = false` in its transaction; new LIVE campaigns reach only the test list until the Owner goes live again on the new domain, through the full checklist (DMARC, https links, spam filter, retention, routes, remote access, a delivered live test on the new domain). The warm-up restarts for the new domain as today, and again at the new go-live. Guide 4 step 13 explains it. | Keeping go-live on would let live campaigns start on a domain whose DMARC, links and retention were never checked. No running campaign is affected (the change is refused while any sends). Earlier campaigns keep their launch flag, so their emails stay "emailed". |
| **G9** | **Test mailboxes after go-live are ordinary companies.** Their earlier test-list sends stay "not emailed" (G2). The test list stays: Test mode, the reply test and the "internal senders" rule (replies from them hold nothing) still use it. A LIVE campaign that includes them after go-live counts like any other. | Docs audit Q-E. |
| **G10** | **Go-live blockers** beyond `goLiveBlockers` today: Mailgun connected, a Domain checklist checked within the hour (and after the Access choice last changed), Setup A, a delivered live test on the current domain (§0.3 "Live test"), and the background sender running; "warn" rows say what needs attention. `goLive()` re-reads its inputs inside its transaction. **Recommendations** (never block): domain age, Mailgun's monthly limit, address checks tried, a second backup folder, a backup newer than 36 hours, the Access warning, the app folder outside Pictures/OneDrive, a practice restore, reading the templates, testing the AI model. | A8 "go-live checklist"; the task's "test list tried"; the critiques: stale or last-moment inputs, Setup B, a bounced or old-domain test. |
| **G11** | **Drafts made before go-live need a confirmation.** A draft built in Dry run ticks every eligible prospect; after go-live it would launch Live to all of them. The go-live dialog lists such drafts, and the wizard's Schedule step asks for a tick before launching a draft created before `sending.goLiveAt`; `launch()` refuses without it. | Nobody should send real email by launching an old draft without noticing. |
| **G12** | **Bounces and complaints count from go-live** on real data: the health check, Domain health and the warm-up judge sends since `max(healthBaseline.since, sending.goLiveAt)`. | Rehearsal bounces to test mailboxes must not start real sending near the auto-pause or hold the warm-up. |

### 2.2 The "emailed" rule (L1, L21)

**Contract** (step C, `src/core/rules/mode.ts`, code in §7.8): `countsAsEmailed(mode, {practiceCopy, launchedGoLive})`
returns `countsAsReal(mode, practiceCopy) && !(mode === "LIVE" && launchedGoLive !== true)`. During step C the old
`goLive` option is still accepted (deprecated); P1 moves every caller to `launchedGoLive`, then deletes the `goLive`
option and `emailedModes` from the file. `testListOnly(mode, goLive)` is new (§2.3).

**Database filter** (P1, new `src/server/services/emailed.ts`):

```ts
/** OutboundEmail rows that count as "emailed" (M6-DESIGN §2.2): DRY_RUN in the practice copy, LIVE of a campaign launched after go-live. */
export function emailedSendWhere(practiceCopy: boolean): Prisma.OutboundEmailWhereInput {
  const live: Prisma.OutboundEmailWhereInput = { mode: "LIVE", campaign: { launchedGoLive: true } };
  return practiceCopy ? { OR: [{ mode: "DRY_RUN" }, live] } : live;
}
```

`loadHistory` (services/eligibility.ts) takes this fragment instead of `modes` for both its SENT queries and its
MAYBE_SENT query (spread it with `AND: [fragment]` so it never collides with the other `OR`s). The join is on
`Campaign.id` (primary key); P1 re-runs `tests/integration/sending/query-plans.test.ts` and keeps every history query
on its `(companyId|companyDomain|toNorm, sentAt)` index. `ExternalSend` rows (found after a restore) always count:
they may be real sends made after the backup, and a restore can't know which campaign they belonged to (conservative;
§10.1).

**Call sites** (all P1):

| Place | Today | M6 |
|---|---|---|
| `server/services/eligibility.ts:347-357` `loadHistory(… emailedModes …)` | today's switch | `emailedSendWhere(practiceCopy)` |
| `server/services/eligibility.ts:620` `testListCountsAsChecked` at send | `!(launchedGoLive ?? goLive)` | `rec.campaign.mode === "TEST" \|\| rec.campaign.launchedGoLive !== true` (§2.3) |
| `server/services/eligibility.ts:609-613` `recheckRecipient`'s `settings` at send | today's `settings.goLive` (so `not-on-test-list` vanishes for a pre-go-live campaign after the flip) | for TEST and LIVE: `settings: {...settings, goLive: rec.campaign.launchedGoLive === true}` (the campaign's world at launch; §2.3) |
| `server/services/campaigns/launch.ts:437` `takesReservations` | `goLive: settings.goLive` | `launchedGoLive: settings.goLive` (the flag this launch writes; same value) |
| `server/services/sending/loop.ts:744` `ensureReservation` | today's switch | the row's `campaign.launchedGoLive` (add it to the candidate select) |
| `server/services/sending/loop.ts:554` final check | `!guard.goLive && !testList.has` | `testListOnly(row.mode, row.campaign.launchedGoLive === true) && !testList.has(toNorm)` |
| `server/services/sending/mark-sent.ts:329` `recordRealContact` | today's switch | the email's campaign's flag (select it with the row) |
| `server/services/campaigns/control.ts:71-75, 224, 486` resume, retry | today's switch | each campaign's flag |
| `server/services/companies/detail.ts:342-351` | today's switch; `countsAsReal: emailed` alias | each campaign's flag; the alias field removed (L21) |
| `server/services/campaigns/queries.ts:969-1023` `companySequences` | today's switch; `countsAsReal` alias | each campaign's flag; alias removed |
| `core/replies/kind.ts:66-82` `replyScope` | `goLive` for everything | new input `launchedGoLive: boolean \| null` for a LIVE link (the linked email's campaign); `goLive` (today) only for the `company`/no-email branch |
| `server/services/replies/input.ts:128-148`, `process.ts:248, 567, 677`, `actions.ts:369-373` | pass `goLive` | also pass the linked email's `campaign.launchedGoLive` |
| `components/company-panel/emailed-text.ts:39-49, 171-176, 236`, `company-panel.tsx:146`, `components/campaigns/format.ts:809-861` | `countsAsEmailed ?? countsAsReal` | `countsAsEmailed` only (L21) |
| `components/contacts/format.ts:51-56` "Last emailed" | "Never" | unchanged text; when the company's newest sequence is a test-list send, the cell's `title` is "Test emails before going live don't count as emailed." (L18) |

`countsAsReal` / `realModes` (caps, warm-up, health, reply linking, `mail-events/apply.ts:127`) don't change. The
campaign overview's `countsAsReal` (`queries.ts:493`, campaign page `:229`) is the "counted" meaning and stays.

**Migration** (step C, §7.7): every launched campaign with `launchedGoLive IS NULL` (launched before M5, when go-live
was impossible) gets `false`, so the flag is never null after launch and nothing needs a `?? goLive` fallback.

### 2.3 The test-list guard before and after go-live (L2)

| Layer | Before go-live | After go-live | Code (package) |
|---|---|---|---|
| Eligibility in the draft and at launch (`personReasons`) | TEST and LIVE: not on the test list → blocking `not-on-test-list` | TEST: still blocking; LIVE: no test-list rule | `core/rules/eligibility.ts:334-343` uses `testListOnly(ctx.mode, ctx.goLive)` (P1) |
| Reason text | "Not on the test list (until you go live, only test-list addresses get real email)" (LIVE, unchanged) | TEST: "Not on the test list (Test mode only emails your test list)" | P1 |
| Test list counts as checked (draft, launch) | `onTestList && !goLive` | `onTestList && mode === "TEST"` | `countsAsChecked = onTestList && (testListCountsAsChecked ?? (ctx.mode === "TEST" \|\| !ctx.goLive))` (P1) |
| Same, at send (judged at launch, M5 D31) | `launchedGoLive !== true` | TEST always; LIVE launched after go-live: no | services/eligibility.ts:620 (P1) |
| Re-check at send (`recheckRecipient` → `personReasons`) | test-list rule for TEST/LIVE | TEST always; LIVE by the campaign's launch flag (not today's switch) | `settings.goLive` replaced by `launchedGoLive === true` for the evaluation (P1, §2.2) |
| Launch gate `liveLaunchBlockers` | empty test list blocks a LIVE launch | empty test list no longer blocks a LIVE launch | new optional ctx `goLive?: boolean` (default false = today's behaviour); `emptyTestListLaunch` only when `!goLive` (P2); `launch.ts` passes it (P1) |
| Launch of a draft made before go-live (G11) | — | LIVE launch of a campaign with `createdAt < sending.goLiveAt` needs `confirmMadeBeforeGoLive: true`, else `Tick the box to confirm that this draft now sends real email.` | `launch()` input field (contract, §7.8; P1 enforces, P2's wizard sends it) |
| `modeWarnings` | TEST/LIVE with an empty list warn | TEST still warns; LIVE doesn't | P2 |
| Loop final check (`finalCheckLocked`) | skip `NOT_ON_TEST_LIST` | TEST always; LIVE judged by the launch flag | P1 |
| Mailgun client guard (`checkSendGuard`) | campaign/reply-test mail only to the test list | a campaign email passes to anyone only when `guard.goLive && testMode !== true && testListOnly === false`; everything else (reply test, TEST, a pre-go-live LIVE campaign, a campaign email without the flag: fail closed) → test list only; self-test → own inbox (unchanged) | `send-guard.ts:37-53` with `Pick<…, "to" \| "purpose" \| "guard" \| "testMode" \| "testListOnly">`; `SendMessageInput.testListOnly?: boolean` (`server/mailgun/types.ts`); `buildSendInput` sets it from `testListOnly(mode, campaign.launchedGoLive === true)`, which `OutgoingMessage` carries from the loop's claim select (P1) |

### 2.4 The go-live checklist

`goLiveBlockers(rows, ctx)` (P2, `core/sending/mode-gates.ts`) keeps its sentences and gains optional inputs (absent =
satisfied, so existing callers are unchanged; the contract adds them in step C, §7.8):

```ts
ctx: {
  replyTestPassed: boolean; paused: boolean; practiceCopy: boolean; sendersWithoutRoute: string[];
  /** M6: Mailgun connected (domain and a usable key). */
  connected?: boolean;
  /** M6: the Domain checklist was checked within the last hour, without an error, after the Access choice last changed. */
  checkFresh?: boolean;
  /** M6: the unsubscribe setup chosen with the reply test (live campaigns need "A"). */
  setup?: UnsubscribeSetup;
  /** M6: the live test (§0.3): none yet, sent but not delivered, or delivered. */
  liveTest?: "none" | "sent" | "delivered";
  /** M6: the background sender's heartbeat is fresh (getWorkerStatus().running). */
  workerRunning?: boolean;
}
```

The full list, in display order (heading **"Before going live:"**):

| # | Blocker sentence | Condition |
|---|---|---|
| — | `The practice copy never sends real email.` (only line) | practice copy (unchanged) |
| — | `Connect Mailgun first.` (`MODE_GATE_TEXTS.connect`, only line) | `connected === false` |
| 1 | `The Domain checklist was last checked more than an hour ago. Click Check again on the Domain checklist, then come back.` | `checkFresh === false`: `check.checkedAt` null or older than 60 minutes, `check.error` set, or `checkedAt` older than the `remoteAccess.accessOff` Setting row's `updatedAt` (rows of another domain are already dropped by `loadGateInputs`) |
| 2–17 | missing or "bad": `<row title>: not done yet (Domain checklist).`; "warn", "unknown", "info" or "off": `<row title>: needs attention: <row text without its final period> (Domain checklist).` | each `GO_LIVE_ROW_KEYS` row not "ok" (remote-access "ok" includes the Access opt-out, §2.8) |
| 18 | `Live campaigns need Setup A (Mailgun's unsubscribe handling). Settings › Domain checklist › Reply test.` (`MODE_GATE_TEXTS.setupA`) | `setup` given and not `"A"` (a Setup B reply-test pass also sets `replyTestPassedOnDomain`, but `liveLaunchBlockers` refuses every LIVE launch without A) |
| 19 | `The reply test hasn't passed yet.` | reply test not passed on the current domain (unchanged) |
| 20 | `Sending is paused.` | pause on (unchanged) |
| 21 | `<names> has/have no working reply route.` | unchanged |
| 22 | `Send one live campaign to your test list first, and check that it arrived (Going-live guide, step 3).` | `liveTest === "none"` |
| 22 | `The live test email hasn't been confirmed as delivered yet. Wait a few minutes, then open this page again.` | `liveTest === "sent"` |
| 23 | `The background sender isn't running. Double-click start.bat on the office PC.` | `workerRunning === false` |

**The live test** (`loadGateInputs`, P2): `"delivered"` when an OutboundEmail exists with mode LIVE, status SENT,
`campaign.sendingDomainId` = the current `SendingDomain.id`, `toNorm` on the current test list, a MailEvent `delivered`
linked to it and no permanent `failed` event; `"sent"` when such a row exists without the `delivered` event (or with a
permanent failure); `"none"` otherwise. Two indexed queries (`OutboundEmail` by campaign domain + mode + status, then
its events), `take: 20`.

`goLiveRecommendations(ctx)` (new, P2, same file; heading **"Recommended first:"**; never blocks), in this order:

| Sentence | Condition |
|---|---|
| `Your sending domain is less than 30 days old. Wait before real campaigns (Domain checklist › Domain age).` | `domain-age` row present and not "ok" |
| `Set Mailgun's monthly safety limit (Mailgun guide, step 9).` | `monthly-limit` row present and not "ok" |
| `Try address checks once (Settings › Deliverability): after going live, live campaigns only email checked addresses.` | no `VerificationCheck` row with a Mailgun result exists yet (P2 reads the M5 table; a count, no decryption) |
| `Choose a second backup folder in Settings › Backups, so a copy survives if this PC's disk fails.` | `backups.secondFolder` empty |
| `Make a backup first: the newest is more than 36 hours old (Settings › Backups).` / `Make a first backup in Settings › Backups.` | newest app backup older than 36 h / none |
| `Cloudflare Access is off, so anyone who finds the address sees the app's sign-in page.` | `remoteAccess.accessOff` |
| `The app folder is inside <Pictures>, which OneDrive, a sync program or Windows' ransomware protection can take over. Move it to C:\Outreach first (Going-live guide, step 4).` | `riskyAppFolder(process.cwd(), env)` (P2, pure, `core/sending/app-folder.ts`) names Desktop, Documents, Pictures, `OneDrive*`, Dropbox or Google Drive in the path (the name in the sentence is the one found) |
| `Try a practice restore before you go live (Going-live guide, step 5).` | no restore yet that was resumed (`STATE_KEYS.restore.resumedAt` and `acknowledgedAt` both null) |
| `Read your master template and follow-ups once: they go to real prospects from now on (Templates).` | always before go-live |
| `Test the AI model once (Settings › AI).` | always before go-live |

`loadGateInputs` (P2, `server/services/reply-test.ts`) adds `goLiveAt: string | null`, `goLiveDomain: string | null`,
`checkFresh`, `liveTest`, `workerRunning` (`getWorkerStatus(now)`), `accessOff` (+ its row's `updatedAt`),
`secondFolder`, `newestBackupAt` (the newest app-backup `Backup` row's `createdAt`), `restoreDone`, `checksTried`,
`appFolder` (`process.cwd()`) and `capOverrideToday` (`sending.capOverride` when it is for today's cap day), and passes
them in `goLiveBlockersFor(gate)` (now also `connected`, `setup: gate.setting.setup`) and the new
`goLiveRecommendationsFor(gate)`. `loadGateInputs` still calls `getMailgunContext` (decrypts keys): only the settings
pages and `goLive()` use it, never the dashboard (§0.2 rule 8).

### 2.5 The switch

**Service** (P2, new `src/server/services/go-live.ts`):

```ts
export class GoLiveError extends Error {}                         // message = the blockers joined with " "
export type GoLiveView = {
  practiceCopy: boolean;
  live: boolean;
  at: Date | null;                   // Setting "sending.goLiveAt"
  byName: string | null;             // that Setting row's updatedById → User.name
  domain: string | null;             // the current sending domain
  /** Live before, on another domain (a domain change ended go-live, G8): that domain; else null. */
  endedOnDomain: string | null;
  blockers: string[];                // §2.4, "Before going live:"
  recommendations: string[];         // §2.4, "Recommended first:"
  /** Drafts that will send real email when launched after go-live (G11): DRAFT campaigns with an included person not on the test list. At most 5, plus the count of the rest. */
  drafts: { items: { id: number; name: string; people: number }[]; more: number };
  /** Today's hand-set limit that go-live removes (G5), or null. */
  capOverrideToday: number | null;
  warmupLine: string | null;         // live only: warmupLine(…) (§2.6)
};
export async function loadGoLiveView(now?: Date): Promise<GoLiveView>;
export type GoLiveResult = { alreadyLive: boolean; at: Date; modeBefore: "DRY_RUN" | "TEST" | "LIVE" };
/** The only writer of go-live = true (§0.2 rule 6). Refuses with GoLiveError while any blocker is left. */
export async function goLive(actor: { id: number; name: string }, opts?: { now?: Date }): Promise<GoLiveResult>;
```

`goLive` steps:
1. Already live (`sending.goLive` true) → return `{alreadyLive: true, at: <sending.goLiveAt>, …}` (no check, no write,
   no activity). Otherwise `gate = await loadGateInputs(now)`; `blockers = goLiveBlockersFor(gate)`; non-empty →
   `throw new GoLiveError(blockers.join(" "))` (no write).
2. One `dbTx` (it takes the write lock first, as every `dbTx`): re-read `sending.goLive` inside it (already true →
   `alreadyLive`, nothing written); re-read with `tx` `practice.copy`, `mailgun.domain`, `mailgun.unsubscribeTest`,
   `sending.testList`, the pause state and `domain.check`'s `checkedAt`; any difference from `gate` → `throw new
   GoLiveError("Something changed while going live. Check the list again.")` (nothing written). Then
   `setSettingIn(tx, "sending.goLive", true, actor.id)`, `setSettingIn(tx, "sending.goLiveAt", now.toISOString(),
   actor.id)`, `setSettingIn(tx, "sending.goLiveDomain", gate.domain, actor.id)`, `setSettingIn(tx, "sending.mode",
   "LIVE", actor.id)` (G4), and, when `gate.capOverrideToday` is set, `setSettingIn(tx, "sending.capOverride", null,
   actor.id)` (G5); `logActivity({actorId, type: "sending.goLive", summary: "<name> went live on <domain>", data: {at,
   domain, modeFrom, modeTo: "LIVE", capOverrideCleared: <cap> | null}}, tx)`; `notifyUsers(<every active user id>,
   {type: "sending.wentLive", …}, tx)` (copy below; `notifyUsers` already skips switched-off users and
   de-duplicates).
3. After the commit: `await startWarmupAtGoLive(now)` (§2.6); a failure is logged and never undoes go-live, and
   `evaluateWarmupDays` repairs it on its next hourly run (§2.6). Health counting from go-live needs no write (G12).

**Action** (P2, `src/app/(app)/settings/sending/actions.ts`):

```ts
const goLiveSchema = z.object({ confirm: z.literal(true, { error: "Tick the box to confirm." }) });
export async function goLiveAction(input: z.infer<typeof goLiveSchema>): Promise<ActionResult<{ at: string; alreadyLive: boolean }>>;
```

`requireOwnerAction()` inside `runAction`; `GoLiveError` → `UserError(message)`; message on success **"You're live. New
campaigns now email everyone eligible, and warm-up has started."**, already live: **"You're already live."**;
`revalidatePath("/", "layout")`. The action reads the clock with `new Date()`; tests that call it on a fixed clock fake
`Date` around the call (§9.3).

**The card** (P2, `src/components/settings/sending/go-live-card.tsx` + `go-live-dialog.tsx`; anchor `#go-live` on
Settings › Sending & Mailgun, after "Test list"). Title **"Go live"**, or **"Go live on send2.example.com"** after a
domain change ended go-live (G8).

| State | Description | Content |
|---|---|---|
| Practice copy | `The practice copy never sends real email, so it can't go live.` | nothing else |
| Not live, blockers | `When you go live, new live campaigns email everyone eligible, not only your test list, and warm-up starts.` After a domain change instead: `You were live on mail.example.com. After the change to send2.example.com, live campaigns only reach your test list until you go live on it.` | disabled `Switch` labelled "Go live"; "Before going live:" list; "Recommended first:" list; `Step by step: Going-live guide (docs\setup\4-going-live.md).` |
| Not live, ready | same description | enabled `Switch` (toggling opens the dialog); "Recommended first:" list if any; the guide line |
| Live | `Live on send.example.com since 27 Sep 2026, 14:05 (switched on by Arslan). New live campaigns email everyone eligible.` | checked, disabled `Switch`; the warm-up line (§2.6, e.g. `Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.`); `This can't be switched off. To stop sending at any time, use Pause all sending.` |

A checked `Switch` shows the "selected" fill (A6's selected-item row), which isn't a button and doesn't count toward
§5.1 R1. The page's one orange button is the dialog's confirm while it is open, otherwise §5.1 R1's precedence on this
page: Resume sending (paused) › Save and connect (not connected) › none.

**The dialog** (P2; full screen below 640 px):

- Title: **Go live?**
- Body (a list; the conditional items only when they apply):
  - `New campaigns send real email to everyone eligible, not only your test list. Sending mode switches to Live.`
  - `Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 1,000 in about 4 weeks.`
  - `Bounces and complaints are counted from now on; your test emails don't count.`
  - (override) `Today's limit you set by hand (400) is removed: today sends at most 50.`
  - (drafts) `These drafts will send real email when launched: "Germany Q4" (412 people), "Spain" (80 people). Check them before launching.` (at most 5 names, then `and 2 more`)
  - `Campaigns already running keep the mode they were launched with.`
  - `Your test mailboxes become normal companies: emailing them in a live campaign from now on counts as emailed.`
  - `This can't be switched off. To stop sending at any time, use Pause all sending.`
- Checkbox (required): `I understand that real prospects will get emails from now on.`
- Buttons: **Go live** (orange, disabled until ticked) · **Not yet** (outline).
- While saving: "Going live…"; an error shows the refusal sentences under the checkbox and keeps the dialog open.

**Notification** `sending.wentLive` (to every active user, via `notifyUsers`): title **"The app is live"**, body
**"<Owner name> switched on Go live. Sending mode is now Live: the next campaign anyone launches sends real email to
everyone eligible. Warm-up has started at 50 a day."**, link `/dashboard`. No pop-up group (`notificationFilterOf` files
it under "Sending and system").

**Activity** `sending.goLive`: summary **"Arslan went live on send.example.com"**, data `{at, domain, modeFrom, modeTo,
capOverrideCleared}`.

### 2.6 Warm-up at go-live (L4)

P2 adds to `server/services/sending/warmup-days.ts`:

```ts
/** Go-live (M6-DESIGN §2.6, G5): the ramp starts today at step 0; closed days before today are never judged. */
export async function startWarmupAtGoLive(now: Date): Promise<WarmupState>;
```

It uses `updateTyped(STATE_KEYS.warmup, parseWarmupState, …)` with the same settings `evaluateWarmupDays` reads:
`{domain: <current mailgun.domain, trimmed, lower-case>, step: 0, lastEvaluatedCapDay: <yesterday>, startedCapDay:
<today>, history: []}` in `sending.capDayTimeZone`. Today's `sending.capOverride` was already removed by `goLive()`'s
transaction (G5). The next hourly `warmup.evaluate` judges today once it closes, as every day.

**Self-healing** (P2, `evaluateWarmupDays`): on real data, when `sending.goLive` is true, `sending.goLiveAt` is set and
`state.startedCapDay` is null or earlier than `capDayOf(goLiveAt)`, it first restarts the ramp exactly as
`startWarmupAtGoLive(goLiveAt)` would (as it already does for a domain change), then evaluates. So a crash or a
`StateConflictError` after go-live's commit costs at most an hour.

**Health counted from go-live** (G12, P2): new pure `healthCountingSince(baselineSince: string | null, goLiveAt: string
| null, practiceCopy: boolean): Date | null` (`core/sending/health-since.ts`) = the later of the two on real data, the
baseline alone in the practice copy. The health check (`server/services/sending/health-check.ts`), Domain health
(`loadHealthView` in `server/services/mail-events/deliverability.ts`) and `evaluateWarmupDays` (instead of `since:
null`) use it. `sinceNote` reads `Counting since you went live on 27 Sep.` when the result equals `goLiveAt`. The
half-limit warnings clear themselves at the next health check (the counts drop).

**The warm-up line** (replaces `warmupProgressText` on every screen; the old function stays for its tests until P10
removes unused exports): new pure `warmupLine(step, table, today)` (step-C contract, `core/sending/warmup-line.ts`,
§7.8), where `today: WarmupToday | null` comes from P2's new `loadWarmupToday(now)`
(`server/services/sending/warmup-days.ts`: the open cap day's counted sends, its sending-day flag and
`isHealthyForWarmup` over the counts `evaluateWarmupDays` would use). `null` gives the "otherwise" text, which is always
true, so wave-1 peers (P5's Limits page) use `warmupLine(step, table, null)`; P2 (go-live card) and P7 (dashboard) pass
`loadWarmupToday(now)`:

| Case | Text |
|---|---|
| last step | `Warm-up finished: 1,000 a day.` |
| today is a sending day, at least `minUsePercent` of today's limit used, healthy so far | `Warm-up step 3 of 20: 69 a day. Tomorrow 80, if today's numbers stay healthy.` |
| otherwise | `Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.` |

"Step N" is the ramp's step (1-based), not a count of days: holds keep the step (§10.3).

Limits & warm-up (P5) shows under "Warm-up schedule":
- before go-live (real data): **"Warm-up starts when you go live. Until then only emails to your test list count, so
  the limit usually stays at 50."**;
- after go-live: **"Warm-up started when you went live on 27 Sep."** plus the warm-up line;
- the practice copy: the warm-up line (its ramp runs like live).

### 2.7 Words before and after go-live (P2 unless noted)

| Where | Before go-live (kept) | After go-live |
|---|---|---|
| `MODE_WORDS.LIVE` (toasts, activity) | `live (test list only)` | `live` |
| `MODE_OPTION_TEXTS.LIVE.title` | `Live (test list only)` | `Live` |
| `MODE_OPTION_TEXTS.LIVE.text` | unchanged | `Real emails from your sending domain to everyone eligible, inside sending hours and under the daily limit.` |
| `MODE_OPTION_TEXTS.TEST.text` (both) | `Emails go to Mailgun's test mode, only to your test list: accepted, never delivered, and billed like normal emails. Use it only to check the connection.` | same |
| `liveConfirmText(testList, goLive)` | `Real emails will go to your test-list addresses only: <list>, and to your own reply inbox when you click Send me a test. Everyone else is left out until you go live. Switch to live?` ("(Milestone 6)" removed) | `New campaigns will send real email to everyone eligible, inside sending hours and under the daily limit. Switch to live?` |
| `TEST_LIST_TEXTS.hint` | unchanged | `Test mode only emails these addresses, and the reply test uses them. Emails to them in a live campaign now count as emailed.` |
| Test list card description | `The mailboxes that can receive real email before you go live.` | `The mailboxes Test mode and the reply test use.` |
| Wizard badge `wizardModeText(mode, goLive)` | `Live (test list only)` | `Live`; every wizard page passes `goLive` (today only Verify does) |
| Schedule step `modeLine({mode, practiceCopy, goLive})` (`campaign-wizard/format.ts:223-233`, called as `modeLine(summary)` in `schedule-step.tsx:477`; `LaunchSummary` in `campaigns/draft.ts:1164` gains `goLive: boolean` and `madeBeforeGoLive: boolean`, and `ScheduleSummary` mirrors them) | unchanged | LIVE: `It sends real email to everyone in this campaign, inside their working hours and under the daily limit.` |
| Schedule step, draft made before go-live (G11) | — | LIVE and `madeBeforeGoLive`: a required checkbox above Launch, `This draft was made before you went live. It now sends real email to 412 people.`; the launch action passes `confirmMadeBeforeGoLive: true` |
| Verify step (`components/checks/verify-model.ts:193`) | `beforeGoLive = mode !== "DRY_RUN" && !goLive` | `testListOnly(view.mode, view.goLive)`; its TEST text: `Test mode only emails your test list, and those addresses count as checked.` (LIVE before go-live keeps today's text) |
| Top-bar label | unchanged rules | unchanged rules (G6); P2 adds `label.test.ts` cases for `goLive: true` × each mode × live/test campaigns. The fallback `labelFromState` (`components/shell/sending-pill.tsx:19-33`) no longer hard-codes `goLive: false`: when the full label can't load it shows `Status unavailable` (neutral, tooltip `The sending status couldn't be loaded. Refresh the page.`) for every non-paused state |
| Sequence suffix " (test list)" (`sequenceSuffix`) | on test-list sends | still on test-list sends (they stay not emailed, G2) |
| "The 30-day rule" wherever it names its length | "30-day rule" | the name stays; the Limits card adds `Now 21 days.` when the setting isn't 30, and the README says the name stays (§5.3) |
| Go-live card | §2.5 | §2.5 |

Every "Milestone 6" string in `src/` goes: the dashboard placeholder (P7), the Go live card and `liveConfirmText`
(P2). P10's `no-milestone-text` test (§8 P10) reads string literals and JSX text only, so code comments may keep their
milestone history.

### 2.8 Test mailboxes, a domain change and the Access opt-out

- **Test mailboxes (G9).** Nothing changes in the data at go-live. The dialog and guide 4 step 7 say it. Dashboard
  counts include those companies (they are companies).
- **Domain change after go-live (G8).** P2, `server/services/mailgun/connect.ts` `saveConnection`: when `oldDomain` is
  set and `sending.goLive` is true, `upsertSetting(tx, "sending.goLive", false, actor.id)` in the same transaction
  (`sending.goLiveAt` and `sending.goLiveDomain` stay, for the card's "You were live on …"); the
  `mailgun.domainChanged` activity data gains `goLiveEnded: true`; the connect result message appends ` You were live
  on mail.example.com: go live again on send2.example.com when its checklist is green (Settings › Sending & Mailgun ›
  Go live).` The dashboard's `go-live-again` item (§4.2) and "Get started" step 5 say the same. Guide 4 step 13: "the
  new domain starts its own warm-up at 50, live campaigns reach only your test list until you go live on it, and going
  live needs the whole checklist again".
- **Access opt-out (G7).**
  - Setting `remoteAccess.accessOff` (boolean, default `false`; §7.1).
  - P5: Settings › System, Remote access card: a `Switch` **"We don't use Cloudflare Access"** with the hint
    `Recommended: keep Access on. Without it, anyone who finds the address sees the app's sign-in page; the app's own
    sign-in still protects your data.` Turning it on opens a confirm dialog (title `Turn off the Access check?`, body
    = the hint, buttons **Turn it off** (destructive) / **Cancel**); turning it off needs no dialog. Action
    `saveAccessChoiceAction({accessOff: boolean})` (Owner) saves, logs `settings.updated` (`data.key
    "remoteAccess.accessOff"`), queues `mailgun.checkDomain` (dedupe `mailgun:domain-check`, priority 20) so the row
    updates, and toasts `Saved. The Domain checklist checks remote access again in a minute.`
  - P2: `core/dns/checklist.ts` `ChecklistFacts.accessOff?: boolean` (filled by `services/checks/domain-check.ts`); in
    `remoteAccessRow`, when `!t.appProtectedCheck.ok && f.accessOff`, the row is **"ok"** with the text `Remote access
    works. Cloudflare Access is off (Settings › System), so the app's own sign-in is the only login.` (degraded and
    version warnings still apply after it). P5's remote-access card shows the same sentence instead of "Only your team
    gets past Cloudflare's login".

---

## 3. Backups and restore

### 3.1 What exists and what changes

| Part | Today (M1–M5) | M6 (P3 unless noted) |
|---|---|---|
| Daily backup | `backup.daily` periodic task, `VACUUM INTO` on the worker's event loop, keep 14 shared with Back up now, `Backup` row | `VACUUM INTO` + `PRAGMA quick_check` in a child process (`scripts/vacuum-into.mjs`); due rule uses quiet time with a daily guarantee; overdue at 30 h (§3.5); keep 14 daily (§3.3) |
| Back up now | everyone, `backup.run {kind: "MANUAL"}` | same child process; its own retention (newest 5), so it never pushes out a daily backup; tests for the actions |
| Second folder | Owner setting, copy after each app backup, keep 14 there, `backup.copyFailed` notice | network paths, mapped network drives, drive roots, another install's folder and the practice copy refused; saved even when the web process can't write there yet (then install-services.bat); a first copy on save; copies through a `.tmp` name with a free-space and size check; a marker file; same-drive, removable-drive and OneDrive warnings; hint rewritten; dashboard item when the last copy failed (§3.4) |
| Script backups | `app-preupdate/prerestore/premigrate-….db`, no row, never pruned, never listed | listed with their kind, pruned after each app backup (§3.3), not copied (documented); their `.tmp-*` leftovers removed |
| Old-backup warning | Settings › Backups only, not when there is none | Settings › Backups and the dashboard, including "never" (§3.6); a disk-space warning too |
| restore.bat | lists every `*.db` in `backups\`, label "Backup" for app backups, "Settings > …"; admin rights asked before anything; no free-space, version or practice-copy check; the backup copied straight over `app.db` | labels from the `Backup` rows, one vocabulary, "›"; admin rights only for the real database; free space, version, practice-copy and other-database checks before stopping the app; the current data saved or nothing changes; the backup put in place through a checked temporary file and a rename (§3.7) |
| Restore report | only inside the pause card while the restore pause is on | also a "Last restore" card on Settings › Backups, kept after Resume, with who resumed (§3.7) |
| Tested restore | pieces tested separately | one automated round trip (§3.8) + the lead's rehearsal (§9.5) |
| `worker --backup=KIND` | exists, unused | removed |
| Copy safety | whole-folder copy, move and swap detected | also `app.db` alone copied to the same path on another PC (L8, §3.7) |
| install-services.bat | any grant failure (an unplugged stick, a FAT/exFAT stick) stops it after the services are set up | the second folder is granted separately; a failure there is a warning (§3.4) |

### 3.2 Names and kinds: one vocabulary

| File name | Kind (`BackupListKind`) | Label everywhere (app, restore.bat, docs) | Row | Made by |
|---|---|---|---|---|
| `app-YYYY-MM-DD-HHmmss-xxxx.db` | `AUTO` | **Daily backup** | yes | the background sender, daily |
| same pattern | `MANUAL` | **Back up now** | yes | "Back up now" |
| same pattern, no row (e.g. made after the backup that was restored) | `null` | **Backup** | no | — |
| `app-preupdate-YYYY-MM-DD_HH-MM-SS(-N).db` | `PRE_UPDATE` | **Before an update** | no | `update.bat` |
| `app-prerestore-…` | `PRE_RESTORE` | **Before a restore** | no | `restore.bat` |
| `app-premigrate-…` | `PRE_MIGRATE` | **Before a database upgrade** | no | `setup.bat`, start.bat's supervisor |

- `BACKUP_KIND_LABELS` (`server/services/backups.ts`) becomes `Record<BackupListKind, string>` with the labels above
  ("Automatic"/"Manual" go). `BackupListKind = BackupKindValue | "PRE_MIGRATE"`. The Prisma enum doesn't change
  (script backups never get rows; `PRE_UPDATE`/`PRE_RESTORE` rows stay possible but unwritten).
- New pure module `src/core/backups/names.ts` (P3): `SCRIPT_BACKUP_PATTERN =
  /^app-(preupdate|prerestore|premigrate)-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.db$/`,
  `scriptBackupKind(name)`, `scriptBackupDate(name)` (local time, as `scripts/lib/backups.mjs parseBackupTime`), and
  `scriptBackupsToDelete(files, now)` (§3.3). `scripts/lib/backups.mjs` keeps its own copy of the rules (scripts don't
  import TypeScript); `tests/unit/ops/backups.test.ts` pins both to the same table.
- `listBackups()` returns app and script backups together, newest first: `BackupListItem` gains `source: "app" |
  "script"` and `kind: BackupListKind | null`. A `-wal` companion (a raw-copy fallback made by a script) is never
  listed on its own.
- `scripts/restore.mjs chooseBackup`: before listing, reads `SELECT fileName, kind FROM Backup` from the current
  database **read-only** (better-sqlite3 `{readonly: true, fileMustExist: true}`, any error → no kinds) and labels app
  backups `Daily backup` / `Back up now` / `Backup`; script backups keep `backupKindLabel`. The final box says
  `Settings › Sending & Mailgun` (the console is UTF-8).

### 3.3 Retention: 14 in both places, and script backups

- **App backups**, in the backups folder and in the second folder, **per kind**: the newest `backups.keep` (14) daily
  backups (row kind `AUTO`, or no row) and the newest `MANUAL_BACKUP_KEEP = 5` Back up now backups (row kind `MANUAL`);
  the backup just made is never deleted (unchanged `protect` rule). Kinds come from the `Backup` rows read **before**
  rows of vanished files are deleted; a second-folder file without a row counts as daily. So any number of Back up now
  clicks never pushes out a daily backup. (Review fix BACKUPS-1, §12: a file without a row now counts toward neither
  kind and is deleted only once its name's date is more than `backups.keep` days old, so a restore of an older backup
  doesn't push daily backups out.)
- **Script backups** (main folder only): after every app backup, `pruneBackupFolders` also deletes script backups
  beyond **the newest 3 of each kind**, but **never one younger than 14 days** (`SCRIPT_BACKUP_KEEP = 3`,
  `SCRIPT_BACKUP_MIN_AGE_DAYS = 14`, age from the name, else the file time), together with a `-wal` companion of the
  same name. The undo backup of a recent restore therefore always survives two weeks.
- **Leftovers**: `pruneBackupFolders` deletes the scripts' `app-*.db.tmp-<pid>-<ms>` files and the app's `.db.tmp`
  files older than a day (main folder), and the second folder's `app-*.db.tmp` older than a day.
- Script backups are **not** copied to the second folder: the daily backup there is at most a day older, and the
  second folder is for a failed disk, not for undoing an update. README and guide 4 say so.
- README and guide 1 stop saying "the last 14 are kept" without the second half (§6.2).

### 3.4 The second folder

`checkSecondFolder(input, deps?)` (P3; `deps` injects `fs`, `driveTypeOf` and the instance id for tests) rules, in this
order, each with its sentence:

| Case | Result |
|---|---|
| empty | `Enter the full path of a folder, for example D:\Backups.` |
| longer than 240 characters | unchanged sentence |
| a network path (`\\server\share\…`) | `Network folders don't work while the app runs as a Windows service. Pick a folder on another drive, a USB stick or a OneDrive folder.` |
| not absolute | `Enter the full path, starting with the drive letter, for example D:\Backups.` |
| a drive root (`E:\`) | `Pick a folder on that drive, for example E:\Outreach backups.` (service-acl never grants a whole drive) |
| inside the app's folder (the project root, which contains `backups\`) | `Pick a folder outside the app's folder, so a copy survives if this folder is lost.` |
| a mapped network drive (`driveTypeOf("Z")` = `"remote"`) | `That drive letter points to a network folder, which doesn't work while the app runs as a Windows service. Pick a folder on another drive, a USB stick or a OneDrive folder.` |
| missing (`ENOENT`) / a file | unchanged sentences (examples say `D:\Backups`, never a network share) |
| `outreach-backups.json` in the folder names another `instanceId` | `This folder holds backups of another copy of the app. Pick an empty folder.` |
| `stat` or the write probe fails with `EPERM`/`EACCES` | **saved**, with `warning: "The app can't write there yet. If it runs as a Windows service, run install-services.bat on the office PC now; otherwise give it permission in the folder's Properties › Security. Until then copies fail and the dashboard says so."` (the web service account can't see a folder nobody granted it yet, e.g. under `C:\Users\<you>\OneDrive`) |
| ok, a OneDrive folder (a path segment `OneDrive` or `OneDrive - …`) | ok, `warning: "OneDrive keeps an online copy only while it is signed in and syncing on this PC. 14 daily and 5 Back up now backups need about 1.2 GB of OneDrive space."` (19 × the database size, `formatBytes`) |
| ok, a removable drive (`driveTypeOf` = `"removable"`) | ok, `warning: "Copies fail while the stick is unplugged; the dashboard tells you."` |
| ok, otherwise on the same drive letter as the app | ok, `warning: "This folder is on the same drive as the app (C:). A copy there doesn't help if this drive fails."` |

- `driveTypeOf(letter)` (P3, `server/services/backups.ts`): `powershell.exe -NoProfile -NonInteractive -Command
  "[System.IO.DriveInfo]::new('Z').DriveType"` with a 10-second timeout → `"remote"` (Network), `"removable"`,
  `"fixed"`, else `"unknown"`; any error → `"unknown"` (never refuses on its own).
- `FolderCheck` becomes `{ok: true; folder: string; warning: string | null} | {ok: false; error: string}`.
- **Saving** (`saveSecondFolderAction`, Owner): writes the setting; writes the marker `outreach-backups.json`
  (`{instanceId: <SystemState instance.id>, host: os.hostname(), savedAt}`) when the folder is writable (else
  `runBackup` writes it at the first copy); queues `backup.run {kind: "MANUAL"}` (dedupe `backup:manual`) so the
  background sender proves it can write there; message `Saved. The first copy is being made now; this page shows
  whether it worked.` + `" " + warning` when there is one + (unless the warning already says it) ` If the app runs as a
  Windows service, run install-services.bat on the office PC so the background sender may write there.`
- **Practice copy**: `saveSecondFolderAction` refuses with `The practice copy doesn't copy its backups to a second
  folder.`, and `runBackup` never copies in the practice copy (its backups can't mix with the real ones there).
- **Copying** (`runBackup`): no marker → write it (a folder saved before M6); a marker with another `instanceId` → no
  copy and no prune, copy error `this folder belongs to another copy of the app`; free space in the second folder below
  the backup's size + 5 MB → copy error `that drive is full`; else copy to `<name>.tmp`, compare its size with the
  backup, rename to `<name>`; any error deletes the `.tmp`. `copyFailureReason` maps `EFBIG` to `the drive is formatted
  FAT32, which can't hold files over 4 GB`. Prune there per kind (§3.3) only after a good copy.
- **install-services.bat** (P3: `scripts/lib/service-acl.mjs`, `scripts/service-acl.mjs`, and the grant part of
  `scripts/install-services.ps1`): `serviceWriteFolders` returns the second folder separately; `grantServiceAccess`
  grants the app's folders first (a failure there is `ok: false`, as today), then the second folder without creating
  it: missing, a drive root, or an icacls failure (FAT/exFAT has no permissions) gives `ok: true` with `warning:
  "Couldn't give the background sender access to the second backup folder (E:\Backups): <reason>. Copies there fail
  until the drive is plugged in and install-services.bat runs again."`, which install-services.ps1 prints with
  `Write-Attention` and continues.
- The form's hint (`second-folder-form.tsx`): `A folder on another drive, a USB stick or a OneDrive folder, for example
  D:\Backups (not a network folder or a mapped network drive). After saving, run install-services.bat on the office PC
  if the app runs as a Windows service.`
- The card description: `Also copy every daily and Back up now backup to another drive, a USB stick or a OneDrive
  folder, so a copy survives if this PC's disk fails. The newest 14 daily and 5 Back up now backups are kept there too.`
- Copy failures keep today's `backup.copyFailed` notification; `backupStatus()` reports `lastCopyFailed` (the newest
  app backup's row has `copiedTo = null` while a second folder is set and that backup is newer than the setting's
  `updatedAt`; always `false` in the practice copy), which the dashboard shows (§4.2 `backup-copy-failed`).

### 3.5 Quiet time for the daily backup (L17)

- `isBackupDue(now, lastSuccess, timeZone, quiet?: boolean | null)` (`worker/schedule.ts`), in this order: never →
  now; clock went back → now; **< 12 h → no**; **no backup yet on today's date in `timeZone` and the hour there is 20:00
  or later → now** (`DAILY_BACKUP_BY_HOUR = 20`, the daily guarantee: with worldwide recipients the sending windows can
  cover a whole weekday in Pakistan time, and a 30-hour rhythm alone would skip some days); < 24 h → no; **≥ 30 h →
  now** (`BACKUP_OVERDUE_MS = 30 * HOUR_MS`, was 36, so the 36-hour warning only shows when backups really fail); else
  `quiet ?? isQuietHour(now, timeZone)`. So there is at least one daily backup per calendar day while the PC is on, and
  at most two.
- `DueContext` (`worker/periodic.ts`) gains `sendingQuiet: boolean | null`, computed once per `checkPeriodicTasks` run
  by the new `backupQuietNow(now)` (P3, `server/services/backups.ts`): settings `sending.window`, `defaultTimeZone`,
  `practice.copy`; `loadDueStats(now, {defaultZone, practiceCopy})`; quiet = no entry with `count > 0` whose zone has
  `isWindowOpen(now, zone, window)`. Any error → `null` (the fixed 22:00–08:00 window decides, as today).
- `VACUUM INTO` is a plain read in WAL mode, so this is only B6.14's wording, not sending safety.
- **Off the event loop** (P3): `runBackup` no longer runs `VACUUM INTO` on the worker's thread (better-sqlite3 is
  synchronous: a large database would freeze heartbeats, the lease and an in-flight Mailgun request). It spawns
  `process.execPath scripts/vacuum-into.mjs --db <file> --out <folder>\<name>.tmp --json` (new, P3; uses
  `scripts/lib/sqlite.mjs` `vacuumInto` and `quickCheck`): `VACUUM INTO` the `.tmp`, then `PRAGMA quick_check` on it,
  then prints `{ok, size}` or `{ok: false, error, check}`; 30-minute timeout. `runBackup` awaits it, renames the `.tmp`
  only on `ok`, else deletes it, prunes nothing and fails with `The backup file failed SQLite's check (<check>). The
  previous backups were kept. Try Back up now again; if it fails again, the database may be damaged: see "Backups and
  restore" in the README.` The in-process `backupInProgress` lock stays. Tests inject `RunBackupOptions.vacuum` (a
  function returning the same result).

### 3.6 The old-backup warning

`backupStatus(now)` (P3):

```ts
export type BackupStatus = {
  /** Newest app backup (Daily or Back up now); script backups don't count here. */
  newest: { at: Date; kind: BackupListKind | null; fileName: string } | null;
  age: "ok" | "stale" | "never";          // backupAge(newest?.at ?? null, now).state (contract, §7.8)
  secondFolder: string | null;            // null in the practice copy
  lastCopyFailed: boolean;                 // §3.4; false in the practice copy
  workerRunning: boolean;
  /** Free bytes on the data folder's drive (fsp.statfs), null when unknown. */
  freeBytes: number | null;
  /** app.db + its -wal, in bytes. */
  dbBytes: number;
  /** freeBytes below max(2 GB, 3 × dbBytes). */
  diskLow: boolean;
};
export async function backupStatus(now?: Date): Promise<BackupStatus>;
```

| Where | stale (> 36 h) | never |
|---|---|---|
| Settings › Backups banner (`role="alert"`, warning tone) | `The last backup is more than 36 hours old.` + worker-aware line (unchanged) | `No backup has been made yet.` + `Click Back up now to make the first one.` (worker running) / `The background sender isn't running, so no automatic backups are made. Double-click start.bat on the office PC.` |
| Dashboard attention (§4.2) | `backup-old` | `backup-never` |

A low disk shows as the dashboard's `disk-low` item and as a line on Settings › Backups: `The office PC's disk is almost
full (1.2 GB free). Backups and sending stop when it's full.`

### 3.7 Restore

- **restore.bat** (§3.2 labels). It still lists only `backups\` (30 newest); a backup in the second folder is restored
  with `restore.bat "<full path>"` (README says how).
- **restore.mjs safety** (P3, `scripts/restore.mjs`, `scripts/lib/restore-marker.mjs`), in this order:
  1. Administrator rights only for the app's own database: the `servicesInstalled() && !isElevated()` refusal moves
     inside `if (isAppDatabase)` (tests and the lead's rehearsal on `data\manual-check\…` keep working after the
     owner installs the services).
  2. After choosing and before `stopApp`, the chosen file is opened **read-only**: (a) every `_prisma_migrations`
     name must exist in `prisma\migrations`, else `This backup was made by a newer version of the app. Update the app
     first, then restore it.`; (b) its `practice.copy` setting must equal the target database's (when the target
     exists), else `This backup belongs to the practice copy, not the real app (or the other way round). Pick another
     backup.`; (c) when its SystemState `instance.id` differs from the target's: `This backup comes from another
     database (expected when moving to a new PC). Type yes to go on:` (a second `yes`; `--yes` answers both).
  3. Free space on the database's drive ≥ 2.2 × (database + `-wal`) + the backup's size, else `There isn't enough free
     disk space for a safe restore: about 1.4 GB is needed and 0.9 GB is free. Nothing was changed.` (before stopping
     anything).
  4. The "Before a restore" backup: any failure (disk full, the raw-copy fallback failing too) → `startAgain()` and
     `Couldn't save your current data first (<reason>), so nothing was changed.` + the restart sentence.
  5. `putInPlace(source)`: copy to `data\app.db.restore-<pid>.tmp` (a `-wal` companion copied beside it and folded in
     with `PRAGMA wal_checkpoint(TRUNCATE)`), `PRAGMA quick_check` on the temporary file, then delete `app.db`'s
     `-wal`/`-shm` and `renameSync` it over `app.db`. Any error before the rename leaves `app.db` untouched and deletes
     the temporary file; `swapInBackup` catches `putInPlace` errors (a source on an unplugged stick, `EBUSY`,
     `ENOSPC`), puts the marker back and returns `{ok: false, stage: "copy", error}`, and restore.mjs calls
     `startAgain()` with `Couldn't put the backup in place (<reason>). Your data is as it was before, and nothing else
     changed.` An error after the rename puts the saved copy back the same way.
  The final box says `Settings › Sending & Mailgun`.
- **Settings › Backups** gets these cards (order: warning, Last backup + Back up now, **Last restore**, Saved backups,
  Second copy, How to restore a backup):
  - **Last restore** (only when `STATE_KEYS.restore.status !== "none"`), from `lastRestoreView(zone, now)` (P3):
    - `Restored on 27 Sep at 14:05 from the backup of 26 Sep, 22:14.`
    - the text of `restoreReportLines()` (contract move, §7.9) and its details;
    - one of: `Sending was resumed by Arslan on 27 Sep at 14:40.` (from the new `resumedAt/resumedById`, else
      `acknowledgedAt/ById`); while the restore pause is on, `Sending stays paused until the Owner reads this and clicks
      Resume in Settings › Sending & Mailgun.`; resumed while the check still runs (status pending/scanning), `Sending
      was resumed while the check is still running; emails through Mailgun wait until it finishes.`
  - `resumeSending` (P3, `server/services/sending/pause.ts`) writes `restore.resumedAt/resumedById` (contract fields,
    §7.8) whenever the resumed pause's kinds include `"restore"`, after the pause is cleared (a failed write is logged,
    never undoes the resume).
  - **Saved backups**: app and script backups; Kind column uses §3.2 labels; Second copy column `Copied` / `Not
    copied` for app backups and `—` for script backups.
  - **How to restore a backup** (exact list):
    1. `On the office PC, double-click restore.bat. If Windows asks for permission, click Yes.`
    2. `Type the number of the backup you want (the newest is at the top, with its date and kind), then type yes.`
    3. `Wait while it stops the app, saves your current data as "Before a restore", puts the backup in place and starts the app again.`
    4. `Open the app: sending stays paused while it checks Mailgun for emails sent after the backup (about 35 minutes). Read the report in Settings › Sending & Mailgun, then click Resume sending.`

    Then: `Changed your mind? Run restore.bat again and pick the backup marked "Before a restore".` · `A backup in the
    second folder: type restore.bat followed by the file's full path.` · the `.env` paragraph (unchanged) · `Moving to
    a new PC: see "Backups and restore" in the README.`
- **Copy safety (L8)**: `checkDatabaseInstance` writes `host: os.hostname()` into `InstanceState` (contract adds the
  optional field); `copyCause(current, note, dbPath, host)` returns `"other-computer"` when the note is missing and
  `current.host` exists and differs (case-insensitive). A renamed PC costs one Resume (README sentence).

### 3.8 The tested restore (automated round trip, P3)

`tests/integration/backups/restore-round-trip.test.ts` (fake Mailgun, fixed clock, a folder of its own like the M5
end-to-end test so `RESTORED` is its own). Steps 1–3 run in a child `tsx` process
(`tests/integration/backups/round-trip-seed.ts`, with the same fixed clock and the fake Mailgun's port) so the test
process never holds the database open while restore.mjs deletes `-wal`/`-shm` (on Windows an open handle makes that
fail with `EBUSY`); steps 5–10 run in the test process, which opens the database only after step 4:

1. Real-data configuration with the fake Mailgun connected (M3 helpers), sending mode Live, go-live on (set directly:
   this test isn't about the switch), a sender with a route. A LIVE campaign (first email only) to 3 people checked
   VALID by `mailgun-fake` (D10 of M5); tick once → 1 email sent (row A).
2. `runBackup({kind: "MANUAL", userId})` → an app backup with a `Backup` row (through `scripts/vacuum-into.mjs`, the
   real child process).
3. Tick twice more → rows B and C sent after the backup (the fake has 3 messages).
4. Run `node scripts/restore.mjs <backup> --yes --db <test db> --backups-dir <folder>` as a child process (a non-app
   database: no stop/start, no administrator rights needed even with the services installed). Exit code 0; `RESTORED`
   beside the database has `version 3`; an `app-prerestore-….db` exists in `<folder>`.
5. The restored database has row A sent and B, C still queued (the backup's state).
6. Start the worker's start-up (`BackgroundWorker` with the fake Mailgun, the clock, `fetchImpl` answering the health
   route in-process): `checkDatabaseInstance` doesn't pause for a copy (marker seen); `handleRestoreMarker` pauses
   (`kind: "restore"`), the restore state is `pending`, the marker is gone.
7. Run the jobs → scan pass 1: B and C matched (by Message-ID or send id) and marked sent; report `passes: 1`,
   `matched… = 2`; the Owner has `restore.checked`. Advance 35 minutes, run the jobs → `passes: 2`.
8. `GET /api/health` (the route handler, in-process) answers `ok: true`: the app starts on the restored data.
9. `lastRestoreView(zone, now)` gives the lines of §3.7 with "stays paused"; `resumeSendingAction({})` as the Owner,
   called with `Date` faked to the test clock (`vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(clock.now())`,
   restored afterwards) → resumed; `restore.resumedById` = Arslan; `lastRestoreView` now says "Sending was resumed by
   Arslan …".
10. Tick through the window → the fake still has exactly 3 messages (nothing sent twice), and the campaign finishes.

Plus (same package): `tests/integration/backups/actions.test.ts` (`backUpNowAction` for a Member queues one job, a
second click returns the same job; `saveSecondFolderAction` refused for a Member, for a network path, a drive root, a
mapped network drive (injected `driveTypeOf`), inside the app folder, another install's marker, in the practice copy;
saved with the warning for `EPERM` (injected fs), OneDrive, removable and same-drive; saving writes the marker and
queues one backup; `clearSecondFolderAction`), `tests/integration/backups/run-backup.test.ts` (an injected slow vacuum
keeps the worker's heartbeat saving; a failed `quick_check` renames nothing and prunes nothing; per-kind retention:
twenty Back up now backups leave all 14 daily ones; a second-folder copy goes through `.tmp`, a size mismatch or
`ENOSPC` leaves no `app-….db` there; a marker of another install blocks copy and prune; `EFBIG` wording),
`tests/integration/backups/script-backups.test.ts` (listing and pruning with fake file times: newest 3 per kind kept, a
5-day-old fourth kept, `-wal` companion deleted with its file, `.tmp-*` leftovers older than a day deleted, app backups
untouched), `tests/unit/worker/schedule.test.ts` (quiet argument, the 12-hour minimum, the 20:00 daily guarantee — a
weekday with no quiet hour still gets exactly one backup — and 30 h), `tests/unit/ops/service-acl.test.ts` (the second
folder granted separately; missing, drive root or icacls failure → warning with `ok: true`), the L7 case in
`tests/integration/worker/wake-gap.test.ts` (a lease lost and taken again moves `startedAt`, so Mailgun emails wait for
a new check), the L8 case in `tests/integration/sending-m3/restore-safety.test.ts`, the `resumedAt` cases in
`tests/integration/sending-m3/pause-resume.test.ts` (or the file that tests `resumeSending` today), and
`tests/unit/ops/restore-script.test.ts`: labels from rows; a non-app database with the services installed needs no
elevation (injected `servicesInstalled`/`isElevated`); a backup with an unknown migration, the practice-copy mismatch
and the other-database second `yes`; too little free space; the prerestore backup failing (app started again, nothing
changed); the source vanishing mid-copy (app.db unchanged, marker put back, app started again).

### 3.9 Smaller backup and worker items (P3)

- L7: `worker/main.ts holdLease()` sets `this.startedAt.setTime(this.now().getTime())` before `this.startup()` on every
  lease it takes. The comment at `gates.ts:626-627` ("the lease [is] lost") is then true as written; nobody edits
  `gates.ts` for this.
- L15: `worker/jobs/cleanup.ts` deletes in `data\test\` only names matching
  `/^[A-Za-z0-9._-]+-\d+-\d{10,}-\d+\.db(?:-wal|-shm|-journal)?$/` (createTestDb's `<name>-<pid>-<ms>-<rand>.db`) and
  `/^build-worker-\d+-\d{10,}\.db(?:-wal|-shm|-journal)?$/` (`scripts/build-worker.mjs:69`), never `*.instance`, and
  still never the live database.
- L20: remove `OUTREACH_BACKUP_DIR` from `scripts/start-demo.mjs`.
- `worker/index.ts`, `worker/main.ts`: remove `--backup=KIND` and `backupOnce`; comments no longer mention it.
- `scripts/status.ps1`: one more line, `Newest backup: 27 Sep 22:14, Daily backup (7 hours ago)` or `Newest backup:
  none yet`, from the newest **app** backup file in `backups\` (the `app-YYYY-MM-DD-HHmmss-xxxx.db` pattern; script
  backups don't hide failed daily ones), its kind from the `Backup` row read-only (else `Backup`); and, when the app
  folder is under Desktop, Documents, Pictures, `OneDrive*`, Dropbox or Google Drive, `Write-Attention "The app folder
  is inside Pictures, which OneDrive, a sync program or Windows' ransomware protection can take over. Move it to
  C:\Outreach (docs\setup\4-going-live.md, step 4)."`
- **Test runs never reach a real host** (§0.2 rule 13): `scripts/run-prod.mjs`'s `testRunEnv` also sets
  `APP_PUBLIC_URL=http://127.0.0.1:<port>` unless the environment already has a loopback one; `checkPublicAddress`
  (`server/services/checks/tunnel.ts`) returns without fetching when `isTestRun()` and the public address isn't
  loopback (`publicCheck` error `Test run: the public address isn't checked.`). Tests: `tests/unit/ops/run-prod.test.ts`
  (the env) and a `checkPublicAddress` case with a spy `fetchImpl` that must not be called.

---

## 4. The dashboard

`/dashboard` (P7) is home for everyone (Owner and Members see the same page; Owner-only links are plain text or left
out for Members). The page's first line is `const user = await requireUser()` (CONVENTIONS "Auth"). Title
**"Dashboard"** (metadata and `PageHeader`), description **"What needs your attention first, then how sending is
going."**

### 4.1 Layout

Order on every width: (1) **Get started** (when shown, §4.4), (2) **Needs your attention**, (3) **Replies waiting for an
answer** (§4.2a), (4) the tiles.

| Width | Layout |
|---|---|
| ≥ 1024 px | Attention and Replies: full width. Tiles on a 12-column grid: row 1 **Companies** (7) · **Today** (5); row 2 **Active campaigns** (7) · **Domain health** (5); row 3 **Recent team activity** (7) · **Dry runs and test mode** (5, only when shown; otherwise Activity takes 12). |
| 640–1023 px | Two columns in the same order. |
| < 640 px (phone, ≥ 360 px) | One column: Attention, Replies, Companies, Today, Active campaigns, Domain health, Recent team activity, Dry runs. Status counts as a 2-column grid; campaigns as stacked cards; activity lines clamp to two lines; every link is a full-width row (44 px tap height). No horizontal scrolling. |

Each tile is `<section aria-labelledby>` with an `h2`, a one-line body and at most one "more" link in its footer
(`variant="ghost"`, never orange). The page has **no orange button** except "Get started"'s next step when shown (its
one primary link, rendered as `<Button asChild>` so it carries `data-slot="button" data-variant="default"`; §9.4).
Numbers use `tabular-nums`. No charts; progress bars stay neutral.

### 4.2 Needs your attention

Heading **"Needs your attention"**. A `<ul>` of items; each item = tone icon (`CircleAlert` danger, `TriangleAlert`
warning, a neutral dot for info; never orange), the text, an optional second line, and an optional link at the end
(Owner-only links shown only to the Owner; Members see `Ask the Owner to fix this.` instead where marked "O"). Empty:
**"Nothing needs your attention right now."** At most 15 items; beyond that `and 3 more` (no link).

Items in display order (P7 `src/core/dashboard/attention.ts` builds them from the loaded facts; pure; every
time-dependent or component-worded sentence arrives already formatted in `AttentionFacts`, so core imports nothing from
`src/components/**` or `src/server/**`):

| # | Key | Tone | When | Text (exact) | Link |
|---|---|---|---|---|---|
| 1 | `sending-paused` | danger | `getPauseState().paused` | `pausedWithReason("Sending is paused", reason)` + `.`; second line = `fixText` | O: `Open Sending & Mailgun` → `/settings/sending` |
| 2 | `worker-down` | danger | `!getWorkerStatus(now).running` | lastSeen known: `The background sender hasn't checked in since 14:02, so no emails are going out. Restart the PC or double-click start.bat.` (time in the viewer's zone; `formatShortDate` prefix when not today); never seen: `The background sender isn't running, so no emails are going out. Double-click start.bat on the office PC.` (P5's `workerDownText`, called by the loader) | — |
| 3 | `restore-check` | warning | `restoreHoldActive(restore)` and the restore status is pending/scanning | `Emails through Mailgun wait while the app checks Mailgun after the restore (about 35 minutes).` | O: `Open Sending & Mailgun` |
| 4 | `disk-low` | warning | `backupStatus().diskLow` | `The office PC's disk is almost full (1.2 GB free). Backups and sending stop when it's full.` | `Backups` → `/settings/backups` (everyone may open it) |
| 5 | `replies-waiting` | info | any waiting reply (§4.3 rule) | `Replies waiting for an answer: You 3 · Ali 1` (`waitingRepliesLine`, P4) | `Open replies` → `/notifications#replies` |
| 6 | `ai-lines` | info | `aiQueueCounts().waiting > 0` | `12 AI lines to review` / `1 AI line to review` | `Review` → `/ai-lines` |
| 7 | `paused-campaigns` | warning | paused campaigns (`listCampaigns("paused", {pageSize: 3})`) | one item per campaign: `“Germany Q4” is paused.`; second line `pausedText(pausedAt, pauseReason, zone)` (the campaign page's existing sentence, which says why) | `Open` → `/campaigns/<id>`; overflow item `2 more paused campaigns` → `/campaigns?tab=paused` |
| 8 | `unconfirmed` | warning | `unconfirmedEmails().count > 0` (P4) | `3 emails need a decision: the app isn't sure they were sent. Choose Retry or Skip.` / `1 email needs …` | `Open` → `/campaigns/<firstCampaignId>` |
| 9 | `outage-hold` | warning | `outageHoldSummary()`: `detected && (!applied \|\| held + firstEmailsWaiting > 0)` (the send gate holds retried or later-launched people only while HELD rows of their sender or company exist, so this covers L9's case) | people counted: `Follow-ups to 12 people are on hold: the PC was off for more than 5 days, so replies may have been missed. Emails you retried after that wait too.`; none counted yet: `Some emails wait: the PC was off for more than 5 days, so replies may have been missed.` | O: `Continue follow-ups` → `/settings/sending#outage`; Members: `Check your inbox` → `/notifications` |
| 10 | `missing-emails` | info | missing-email count > 0 | `38 companies have no email address.` / `1 company has …` | `Missing email view` → `/contacts?view=missing-email` |
| 11 | `backup-never` / `backup-old` | warning | `backupStatus().age` | never: `No backup has been made yet. Click Back up now in Settings › Backups.`; stale: `The last backup is from 25 Sep, more than 36 hours ago. Check that the office PC and the background sender are on, or click Back up now.` | `Backups` → `/settings/backups` (everyone may open it) |
| 12 | `backup-copy-failed` | warning | `backupStatus().lastCopyFailed` | `The last backup couldn't be copied to the second folder (D:\Backups). Check that the drive is plugged in.` | `Backups` |
| 13 | `second-folder-missing` | info | Owner only; real data, go-live on, no second folder ("Get started" step 4 covers it before go-live) | `No second backup folder yet. Choose one in Settings › Backups so a copy survives if this PC's disk fails.` | `Backups` |
| 14 | `go-live-again` | warning | real data, `sending.goLive` false and `sending.goLiveDomain` set and different from the current domain (G8) | Owner: `You changed the sending domain to send2.example.com. Live campaigns only reach your test list until you go live on it.`; Member: `Live campaigns only reach the test list until the Owner goes live on send2.example.com.` | O: `Open Go live` → `/settings/sending#go-live` |
| 15 | `tunnel-down` | warning | a public address is set and `remoteAccessView(...)` is in a bad state (down, not running, public check failing) | `Remote access is down since 14:02: remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run status.bat.` (no time known: `Remote access is down: …`) | O: `Open System` → `/settings/system` |
| 16 | `mailgun-check` | warning | `catchUpFailing(catchUp)` (contract move, §7.9), Mailgun configured, and no success for more than 2 hours (`lastSuccessAt`, else `lastStartedAt`), so one hourly blip raises nothing | the failing line of `catchUpStatusLine` (`The app hasn't been able to check Mailgun since 14:02. Bounces and unsubscribes may be late.`) | O: `Open Sending & Mailgun` |
| 17 | `old-domain` | warning | `oldDomainLines(catchUp, zone, now)` non-empty (P4) | each line, e.g. `Mailgun's logs for the old domain mail.example.com haven't been checked since 25 Sep. Replies and bounces to its last emails may be missed.` | O: `Open Sending & Mailgun` |
| 18 | `checklist` | warning | go-live on and any `GO_LIVE_ROW_KEYS` row is "bad" | `Something on the Domain checklist needs fixing: <row title>.` (first bad row; `and 2 more` appended) | O: `Open the checklist` → `/settings/domain` |
| 19 | `checks-paused` | warning | `getChecksPause(now).paused` | the pause `text` | O: `Open Deliverability` → `/settings/deliverability#checks` |
| 20 | `ai-paused` | warning | `getAiPause(now).paused` | the pause `text` | O: `Open AI settings` → `/settings/ai` |

Rules: items 1–4 stop or hold sending and come first; 5, 6, 7 and 10 are SPEC §11's four; a failing loader drops only
its own item and logs `[dashboard] <key>: <error>` (the page never fails because one source did).

### 4.2a Replies waiting for an answer (PLAN Q7, A6; M4-DESIGN §4.3)

The list PLAN promised on the dashboard in M6 (it stays on the Notifications page too). P7, from P4's
`listWaitingReplies(viewer, {scope: "mine", take: 5})` (P4 adds the `take` option, ≤ 50):
- Heading **"Replies waiting for an answer"**, description `Yours, oldest first. The app can't see your inbox: click
  Answered once you've replied.`
- Up to 5 cards, the existing `src/components/replies/reply-card.tsx` with its M4 actions (**Answered**, **No answer
  needed** and the rest, unchanged), wired to the existing `src/app/(app)/notifications/reply-actions.ts`; after an
  action the page refreshes.
- Footer link `All replies` → `/notifications#replies`, with `(3 more)` when `total > 5`.
- Empty: `No replies are waiting for you.`
- Busy state: the section renders in P7's render test and in P9's busy spec.

### 4.3 The tiles

**Companies** (pipeline; P4 `loadPipeline(now)`):
- Line `1,240 companies` (`1 company`).
- Six rows in `COMPANY_STATUSES` order with the status chip (word + muted colour, "Do not contact" with `Ban`) and the
  count; each row links to `/contacts?status=<STATUS>` (build with `companyFiltersToParams`).
- `replyRateText`: `Reply rate: 20% (1 of 5 companies you emailed replied)`, singular `(0 of 1 company you emailed
  replied)`; none emailed: `No companies emailed yet.` `replyRate30Text` (second line, only when any company was first
  emailed in the last 30 days): `Last 30 days: 8% (5 of 60)`.
- **Reply rate definition** (P4, §10.2 D8): emailed = companies (not deleted) with `firstContactedAt` set; replied = those
  with `repliedAt` set. Last 30 days = the same, restricted to `firstContactedAt >= now − 30 days`. Percent: whole
  number from 10 %, one decimal below (`4.5%`), `0%` for none. Dry runs on real data never set these fields, so they
  never count; the practice copy counts like live.
- Footer link `Open Contacts` → `/contacts`. Empty (0 companies): `No companies yet. Import a spreadsheet or paste rows
  from Excel to get started.` + link-button `Import companies` → `/import`.

**Today** (`getTodayCap(now, {practiceCopy})`, warm-up state, go-live from settings, P4's `mailgunConfigured()`):
- Big number `37` with `of 50 today` and a neutral `ProgressBar` (used/cap).
- Lines, in this order, each only when it applies:
  - `Includes 2 "Send me a test" emails.` / `Includes 1 "Send me a test" email.` (`testSends > 0`);
  - `Today's limit was changed by hand.` (an override for today; `+ " It's above the warm-up schedule."` when
    `aboveSchedule`);
  - `Today's limit is reached; the rest go out tomorrow.` (`left === 0`);
  - warm-up: real data after go-live and the practice copy: P2's `warmupLine(step, table, loadWarmupToday(now))` (§2.6,
    e.g. `Warm-up step 9 of 20: 177 a day. It goes up to 207 after a weekday with at least half the limit used and
    healthy numbers.`); real data before go-live with Mailgun configured: `Warm-up starts when you go live.` + second
    line `Until then, real email only reaches your test list.`;
  - Mailgun not configured (real data): `Nothing goes through Mailgun yet: new campaigns run as dry runs.` with O link
    `Connect Mailgun` → `/settings/sending`.
- Footer: O `Limits & warm-up` → `/settings/limits`.

**Domain health** (`loadHealthView(viewer.timeZone, now)`, which counts from go-live, G12): P5's `HealthCard` with the
new `compact` prop (no card chrome, two rows: bounces and complaints, each with the count line, "your limit" and
"Mailgun's limit", plus `sinceNote`). The loader passes the client component only the numbers and strings it shows
(never `HealthView.counts`' email ids). No sends yet (sample 0): real data `No emails sent through Mailgun yet, so
there's nothing to measure.`; practice copy `No emails sent yet, so there's nothing to measure.` Footer: O
`Deliverability` → `/settings/deliverability`.

**Active campaigns** (`listCampaigns("running", {pageSize: 5})`, then `"scheduled"` to fill up to 5; `countCampaignsByTab()`
for the rest): each row = name (link `/campaigns/<id>`), `Ali · Live` (sender · `modeLabel`), `ProgressBar` and the
progress text from `toCampaignListView(c, zone, now)`. `+ 3 more` → `/campaigns?tab=running`. Empty: `No campaigns are
sending right now.` + link `Go to Campaigns` → `/campaigns`. Footer `All campaigns`.

**Recent team activity** (P4 `recentTeamActivity(now, 8)`: one `findMany` with `take: 8`, no count, `at >= now − 30
days`, `NOT: {type: {startsWith: "email."}}` so per-email rows (`email.sent` is written for every email) never fill the
tile; ordered by the `at` index): 8 rows, `summary · 12 min ago` (`timeAgo`), dry-run rows with a `Dry run` badge
(`mode`). Empty: `Nothing yet. Changes you and your team make will show here.` Footer `All activity` → `/activity`.

**Dry runs and test mode** (B6.5 "shown separately"; P4 `loadDryRunSummary(now)`; hidden when it returns `null`: the
practice copy, or every number 0):
- Description: `Dry runs and Mailgun's test mode don't count as emailed and aren't in Companies, Today or Domain health.`
- `Dry run today: 40 emails in the outbox · 2 campaigns running` (parts with 0 left out)
- `Test mode today: 3 emails · 1 campaign running`
- `Dry-run replies waiting: 1` (waiting replies with `replyScope "campaign"`, M4 §4.1)
- Footer `Open the dry-run outbox` → `/campaigns/outbox`.
- "Today" = the cap day in `sending.capDayTimeZone` (`capDayBounds(capDayOf(now, zone), zone)`); counts = OutboundEmail
  of that mode with `status SENT` and `sentAt` in the day; running = campaigns of that mode in RUNNING or SCHEDULED.

**Waiting replies rule** (P4, one definition for the bell, the dashboard and M4's line): processed, unanswered, kind in
`WAITING_KINDS`, `replyScope` null or not `"campaign"`, grouped by `assigneeId`, active users only.
`waitingRepliesLine(rows, viewerId)`: the viewer first as `You`, then others by count (desc) and name; at most 4 names,
then `· 2 more people`; users with 0 left out; `null` when the total is 0. Format: `Replies waiting for an answer: You 3
· Ali 1`.

### 4.4 "Get started" (moved from Contacts)

`src/components/dashboard/get-started.tsx` (P7; `components/contacts/get-started.tsx` is deleted, its `mailgunStep`
moves with it unchanged and its unit test moves to `tests/unit/dashboard/get-started.test.ts`).

- Shown: to the **Owner** while `sending.goLive` is false (so again after a domain change ended go-live, G8, with steps
  1–4 already done); to **Members** only while there are no companies; in the **practice copy** to everyone while
  there are no companies (steps 1–3 only). Never a "Hide this" link.
- Card title **"Get started"**; description Owner: `Five steps to your first real campaign. You can come back to these
  any time.`; Member: `Your first campaign starts with your companies.` (they see steps 1 and 3); practice copy:
  `Three steps to try everything here. Nothing is ever sent from the practice copy.`
- Steps (each with a done state `CircleCheck` + done text; the first not-done step is the card's one primary link):

| # | Who | Title | Text | Done when / done text | Link |
|---|---|---|---|---|---|
| 1 | all | Import companies | `Upload a spreadsheet or paste rows from Excel or Google Sheets.` | companies > 0 / `Companies imported` | `/import` |
| 2 | Owner | Invite your team | `Create invite links for your teammates.` | another active user or an unexpired invite / `Team invited` | `/settings/team` |
| 3 | all | `mailgunStep(state, isOwner)` (unchanged words) | — | connected / `Mailgun connected` | as today |
| 4 | Owner | Protect your data | `Choose a second backup folder and keep a copy of the .env file somewhere safe.` | `backups.secondFolder` set / `Second backup folder set` | `/settings/backups` |
| 5 | Owner | Go live | `When the checklist is green, switch on Go live. Until then, real email only reaches your test list.` | never (the card hides at go-live) | `/settings/sending#go-live` |

### 4.5 The landing page switch (P7)

| File | Today | M6 |
|---|---|---|
| `src/app/(app)/page.tsx` | redirect `/contacts` | redirect `/dashboard` |
| `src/app/(auth)/actions.ts:19` `safeNext` default | `/contacts` | `/dashboard` |
| `src/app/(auth)/actions.ts:107` setup | `/contacts?welcome=1` | `/dashboard` |
| `src/app/(auth)/login/page.tsx:18`, `reset/actions.ts:10`, `invite/actions.ts:10` | `/contacts` | `/dashboard` |
| `src/lib/auth/dal.ts:38` `requireOwner` | `/contacts?notice=owner-only` | `/dashboard?notice=owner-only`; the dashboard mounts `NoticeToast` (moved to `src/components/shell/notice-toast.tsx`; Contacts imports it from there) with the same text `Only the Owner can open that page.` |
| `src/components/error-copy.ts:30` not-found | `Go to Contacts` | `Go to the dashboard` → `/dashboard` |
| `src/components/shell/sidebar.tsx:106, 122` logo | `/contacts` | `/dashboard` |
| `src/components/page-header.tsx:57-85` `ComingLater` | used by the dashboard | deleted (no user left) |
| `src/app/(app)/contacts/page.tsx:56, 70-71, 106` | "Get started" + `?welcome=1` | removed; the no-companies empty state (A6 text) stays |
| `src/app/api/export/_lib/download-response.ts`, other "Go to Contacts" buttons | Contacts | unchanged (they are about contacts) |
| `src/proxy.ts` | drops `next` only for `/` | unchanged |

### 4.6 Loading, performance and refresh

- `loadDashboard(viewer, now)` (P7, `src/app/(app)/dashboard/load.ts`: a page-level loader, because it combines server
  services with component wording such as `workerDownText` and `pausedText`; §0.2 rule 12) starts every loader at once
  with `Promise.allSettled` and returns one `DashboardView`; a rejected loader becomes an empty tile or a dropped item
  and a `console.error` line; the page itself only fails when the session does.
- Go-live comes from `getSettings(["sending.goLive", "sending.goLiveAt", "sending.goLiveDomain", "mailgun.domain",
  "practice.copy"])`, and "Mailgun set up" from P4's read-only `mailgunConfigured()` (domain set and a `Secret` row
  `mailgun.apiKey` exists, real data; no decryption, no write). The dashboard never calls `getMailgunContext`,
  `loadGateInputs` or `loadGoLiveView` (§0.2 rule 8).
- Every list has a `take` (paused 3, campaigns 5, replies 5, activity 8, attention ≤ 15); every number is a
  `count`/`groupBy`; no per-row query (no N+1). Company counts use `countCompaniesByStatus({})` (status index) and the
  missing-email count is one `db.company.count` with the same `where` the Missing email view uses (`buildCompanyWhere`
  of the parsed `view=missing-email` filters), not `getContactsSidebar` (which also counts every list). Reply-rate
  counts scan `Company` once each (4 counts; ≈ 5 ms at 10,000 rows, no new index). Team activity never counts the log.
- Client components get plain strings and numbers only (no Prisma rows, no `HealthView.counts` id lists).
- Target: < 150 ms server time at post-go-live volumes (P7 adds a timing test on a seeded integration database with
  10,000 companies, 100,000 OutboundEmail rows, 100,000 ActivityLog rows (most `email.sent`) and 20,000 MailEvent rows,
  inserted with recursive-CTE `INSERT … SELECT` for speed: `loadDashboard` under 1 s on the test machine, a generous
  bound that catches an N+1 or a full count).
- The page is dynamic (reads at request). `LiveRefresh({active: true, intervalMs: 60_000})` refreshes it every minute
  while the tab is visible (stops while hidden); the bell keeps its own 20-second poll. No SSE (B6.14).

### 4.7 Types (P7 owns; P10's end-to-end lines read them)

```ts
// src/core/dashboard/attention.ts (pure)
export type AttentionKey =
  | "sending-paused" | "worker-down" | "restore-check" | "disk-low" | "replies-waiting" | "ai-lines"
  | "paused-campaigns" | "unconfirmed" | "outage-hold" | "missing-emails" | "backup-never" | "backup-old"
  | "backup-copy-failed" | "second-folder-missing" | "go-live-again" | "tunnel-down" | "mailgun-check" | "old-domain"
  | "checklist" | "checks-paused" | "ai-paused";
export type AttentionItem = {
  key: AttentionKey;
  tone: "danger" | "warning" | "info";
  text: string;
  detail: string | null;
  link: { href: string; label: string } | null;
};
/** One field per source of §4.2, all already loaded; sentences that need component wording or a time zone arrive formatted (e.g. `workerDown: string | null`, `pausedCampaigns: {id, name, pausedLine}[]`). P7 defines the fields. */
export type AttentionFacts = { /* see P7 */ };
export function attentionItems(facts: AttentionFacts, viewer: { id: number; role: "OWNER" | "MEMBER" }, now: Date): AttentionItem[];

// src/app/(app)/dashboard/load.ts
export type DashboardView = {
  practiceCopy: boolean;
  goLive: { live: boolean; at: string | null; domain: string | null; endedOnDomain: string | null };
  getStarted: GetStartedView | null;
  attention: AttentionItem[];
  replies: { rows: WaitingReplyView[]; total: number } | null;   // §4.2a
  pipeline: PipelineView | null;            // P4
  today: TodayView | null;
  health: HealthTileView | null;            // strings and numbers only, from loadHealthView
  campaigns: { items: CampaignListView[]; more: number } | null;
  activity: TeamActivityRow[] | null;       // P4
  dryRun: DryRunSummary | null;             // P4; null = hidden
};
export async function loadDashboard(viewer: SessionUser, now?: Date): Promise<DashboardView>;
```

---

## 5. Settings polish

### 5.1 Rules for every settings page (reviewers check these)

| # | Rule |
|---|---|
| R1 | **One orange button per page**, the page's main action. Precedence where a page has several candidates: a pause card's Resume › "Save and connect" (not connected) › the page's main save. Every other button is `outline`/`secondary`/`ghost`/`destructive`. Domain checklist: **Apply recommended settings** is orange only while a row that Apply fixes (tracking-off, unsubscribe, spam-filter, retention, signing-key, webhooks, reply-routes, https-links) isn't "ok"; otherwise outline. Backups: **Back up now** is orange for everyone (its main action). Team: **Invite a teammate**. Notifications and System: none. Limits: **Save limits** (the new rules card saves with an outline **Save rules**). |
| R2 | Metadata title = nav label = page heading (Notifications: "Notifications", not "Notification settings"). Every page starts with the server-rendered `SettingsTitle` (Team: moved out of the client `TeamManager`). |
| R3 | Every section is a `Card` with `CardHeader` (title + one-sentence description). Email footer gets `CardTitle` **"Footer text"** with `The last lines of every email. Mailgun adds the personal unsubscribe link.` Domain checklist: Apply and Check again move from the title row into the first card's header actions. |
| R4 | **Every save shows a toast**: `toast.success(res.message ?? "Saved.")`, errors as field errors plus the sentence; a computed message is fine. No silent save. Technical text only behind "Details". |
| R5 | `revalidatePath("/", "layout")` for anything the top bar, the sidebar or the dashboard shows (mode, pause, resume, go-live, test list, limits, thresholds, second folder, rules); the page's own path otherwise. |
| R6 | Owner pages start with `requireOwner()` (Members go to `/dashboard?notice=owner-only`), actions with `requireOwnerAction()`; Settings › Backups is the only mixed page (the second-folder form is read-only for Members, with `Only the Owner can change this.`). |
| R7 | Sentence case; the separator in paths is "›"; no "Milestone", no Q-numbers; plain words from A6's wording table. |
| R8 | Every list has an empty state with one next step: test list (`TEST_LIST_TEXTS.empty`), per-sender limits (`Nobody has a sending address yet. Each person adds one in Settings › My profile.`), do-not-email list (`Nobody is on the do-not-email list.`), backups (§3.6), team (`Only you so far. Click Invite a teammate to create an invite link.`). |
| R9 | Errors say what went wrong and how to fix it; field errors under the field; the form keeps its values after an error. |
| R10 | At 360–640 px: the settings nav is the scrolling tab row; forms are one column; tables scroll inside their card (`overflow-x-auto`) or collapse to rows; dialogs open full screen. |

### 5.2 Page by page

| Page | Owner package | M6 changes |
|---|---|---|
| My profile | P5 | R1–R10 check; toast `Profile saved.`; reply-route line unchanged |
| Notifications | P5 | metadata title (R2); no orange |
| Backups | P3 | §3 (warning incl. never, Last restore, script backups, kinds, second-folder rules and hint, restore steps) |
| Sending & Mailgun | P2 | Go live card (§2.5), mode and test-list words (§2.7), old-domain lines on "Check with Mailgun" (`oldDomainLines`), no "Milestone"; R1 precedence Resume › Save and connect |
| Domain checklist | P5 | R1 Apply rule, R3 header actions; remote-access row text (P2, §2.8) |
| Limits & warm-up | P5 | warm-up wording (§2.6); the new card **"The 30-day rule"** (§5.3); toasts |
| Deliverability | P5 | read-only line in "Address checks": `Address checks by Mailgun.`; `HealthCard` gets `compact?: boolean` (used by the dashboard); R5 |
| Email footer | P5 | R3 card header |
| AI | P5 | R1–R10 check only |
| Team | P5 | R2 title from the server page; R8 empty state; R1 Invite |
| System | P5 | Remote access card: the Access switch (§2.8); "This installation" address line `To change it, run setup.bat again, then update.bat if the app runs as a Windows service, then click Apply recommended settings.` (was "To change it, run setup.bat again.") |
| Nav (`settings-nav.tsx`) | P5 | order unchanged (pinned by `tests/unit/setup-core/ui.test.ts`); the comment "the five sending pages" → "the sending pages" |

**One sentence for "the public address isn't set yet"** (docs audit §2.6): `Follow the Cloudflare guide
(docs\setup\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).` Owners:
`src/core/mailgun/routes.ts:142` (P2), `src/core/dns/checklist.ts:802, 935` (P2),
`src/app/(app)/settings/sending/page.tsx:158` (P2), `src/components/settings/access-link-display.tsx:8` (P5),
`src/components/settings/remote-access-card.tsx:33` (P5), `src/app/(app)/settings/system/page.tsx:105` (P5). The
`notHttps` sentence (`routes.ts:143`) becomes `The public address must start with https://. Run setup.bat again to
change it (and update.bat if the app runs as a Windows service).` (P2).

### 5.3 New settings: "The 30-day rule" card (L11)

On Settings › Limits & warm-up, after "Sending hours and limits" (anchor `#rules`). Title **"The 30-day rule"**;
description `Who may email a company that a teammate emailed recently.`

| Field | Setting | Validation (exact error) | Help text |
|---|---|---|---|
| `Days a company stays with whoever emailed it` | `teamRule.days` (30) | whole number 1–365: `Use a whole number of days from 1 to 365.` | `Nobody else can add the company to a campaign during these days. It's checked at launch and before every email.` |
| `Days a paused campaign keeps its companies` | `reservations.pausedExpiryDays` (14) | 1–90: `Use a whole number of days from 1 to 90.` | `After that, other campaigns may email those companies; whoever launched the paused campaign and the Owner are told.` |
| `Shared email domains` (textarea, one per line) | `sharedDomains.extra` ([]) | each line a domain (`tldts` registrable domain or host, no `@`, no `/`), at most 200 lines: `Line 3 isn't a domain. Write it like example.com.`; duplicates of the built-in list are dropped silently | `Domains many unrelated companies use, like gmail.com. The app never groups companies, applies the 30-day rule or links replies by these domains. Built in: gmail.com, outlook.com, … (N).` (the built-in list from `@/core/shared-domains`, collapsed) |

When `teamRule.days` isn't 30, the card description adds `Now 21 days.` (the rule keeps its name everywhere; README
says so).

Service (P5, new `src/server/services/settings/rules.ts`): `loadRulesView()`, `saveRules(actor, input, {confirmed})`:
validates; then, unless `confirmed`, computes the impact of the changed keys and returns `{needsConfirm: {lines}}`
without writing when there is any line:

| Change | Line (exact) | Cheap query |
|---|---|---|
| `teamRule.days` lowered below 30 | `Companies become free for teammates after 21 days instead of 30, so two people may email the same company sooner.` | none |
| `teamRule.days` raised | `12 companies in running campaigns were emailed by a teammate between 30 and 45 days ago; their people are skipped from their next email on.` (only when the count > 0) | companies with `lastEmailedAt` in `[now − new, now − old)` that have a not-finished recipient in a RUNNING/SCHEDULED campaign whose sender isn't `lastEmailedById` |
| a new `sharedDomains.extra` domain used by companies | `12 companies use firma.example. The app would stop grouping them, and replies from it would no longer stop follow-ups there.` (one line per such domain) | `company.count` by `domain` (index) |
| `reservations.pausedExpiryDays` lowered | `3 paused campaigns would release their 40 companies now.` (only when > 0) | paused campaigns with `pausedAt < now − new days`, and their active reservations |

The card shows the lines in a confirm dialog (title `Save these rules?`, buttons **Save anyway** (orange, the dialog's
primary) / **Cancel**); **Save anyway** calls again with `confirmed: true`. Writing: one `dbTx` for all changed keys
(`setSettingIn`) and their activities (one `settings.updated` per changed key, `data {key, from, to}`, summary e.g.
`Arslan set the 30-day rule to 21 days`); returns the message `Rules saved. They apply to new launches and to every
email from now on.` Action `saveRulesAction(input: {teamRuleDays, pausedExpiryDays, sharedDomains, confirmed?})` in
`settings/limits/actions.ts` (Owner) returns `ActionResult<{needsConfirm?: {lines: string[]}}>`. Companies already
grouped stay as they are (README sentence).

### 5.4 The Member-refusal sweep (B7, P5)

`tests/integration/security/owner-actions.test.ts`: finds every `"use server"` file under `src/app/**` (a glob plus a
check of the first statement), and in each, with the TypeScript parser, every exported function whose body calls
`requireOwnerAction()` (today 11 files, e.g. `settings/deliverability/check-actions.ts` and `ai-lines/actions.ts`'s
`resumeAiAction`, which a fixed module list would miss). It imports those modules, calls each such function with `{}`
as a Member (the `@/lib/auth/dal` mock of `tests/integration/sending-m3/settings-actions.test.ts`) and expects `{ok:
false, error: "Only the Owner can do this."}`; before and after, it snapshots `Setting`, `SystemState`, `Secret`,
`Job`, `User`, `AccessLink`, `ActivityLog`, `Notification`, `Suppression` and `Backup` rows and expects no change. A
second check lists every exported function of those files that does **not** call `requireOwnerAction()` and compares it
with an explicit allowlist of everyone-actions (e.g. `backUpNowAction`, the reply actions), so a new everyone-action
must be listed on purpose.

---

## 6. Docs, script texts and in-app help (P6, wave 2)

P6 writes against this design's copy (§2–§5), which is final; P10 re-checks every quoted label against `src/` after
wave 2 (§8 P10). Plain words, second person, no builder's voice ("I'll", "until I", "tell me"), no Q-numbers, no
"Milestone". Headings keep the numbers the app cites (§6.7).

### 6.1 Decisions on the docs audit's open questions

| Q | Decision |
|---|---|
| Q-A How updates arrive | A zip of the new version. README "Updating": (1) stop.bat; (2) right-click the zip › Properties › **Unblock** › OK; (3) **Extract all** to a new folder (never run anything from inside the zip); (4) in the app folder, delete the folders `src`, `worker`, `scripts`, `prisma`, `tests`, `docs` and `public` (never `data`, `backups`, `logs`, `run`, `tools` or the `.env` file), so files the new version no longer has can't break the build; (5) copy everything from the extracted folder into the app folder **except** `.env`, `data\`, `backups\`, `logs\`, `run\` and `tools\nssm.exe` (say "Replace the files in the destination" for the rest); (6) double-click update.bat (it backs up first, so a mistake in step 4 can be undone with restore.bat). An `update.bat <zip>` or a shipped file list is deferred (§1.5). |
| Q-B Access optional or required | Optional (SPEC), recommended; default required; the Owner can switch the check off (G7). Guide 3 gets a box "Skipping Cloudflare Access". |
| Q-C Whose name replaces "I" | No name: "the person who set up the app for you" once in the README ("Getting help"), everywhere else plain instructions. |
| Q-D How the owner reads the docs | Accept plain text: the README's first lines say `These files are easiest to read in a browser or VS Code; in Notepad they show as plain text, which still works.` No Help page (§1.5). |
| Q-E Test mailboxes after go-live | G9; guide 4 step 7. |
| Q-F Second folder | USB, second disk or OneDrive only; network paths and mapped network drives refused (§3.4); save first, then run install-services.bat (hint, save message, README, guide 4 step 5). |
| Q-G Script backups | Pruned: newest 3 per kind, never younger than 14 days; not copied (§3.3). |
| Q8–Q12 | Guide 4 step 1 says where each answer goes (sending domain: Settings › Sending & Mailgun; plan: Mailgun; test mailboxes: the Test list; app address and Access: guide 3; PC hours: guide 1 §6–7), without question numbers. |

### 6.2 README.md: the owner's manual (final outline)

| # | Section | Content (sources) |
|---|---|---|
| 1 | Polygon Paradise Outreach | what it is in 8 lines (three background programs, one data file, the practice copy); the reading tip (Q-D) |
| 2 | Start here | ticked order: guide 1 (30 min) → guide 2 (about an hour over 1–2 days) → guide 3 (45 min + up to 24 h waiting) → guide 4 (going live); what to have ready (a sending domain, maybe one for the app, Mailgun Foundation with business verification, Cloudflare account and card, an Anthropic account with credit, 2–3 test mailboxes); put the app in `C:\Outreach`, never in Desktop, Documents, Pictures, OneDrive or Dropbox. Then four short subsections (3–6 lines each plus a link to the guide), with exactly these headings, which `readme-topics.test.ts` pins: **"Install and first run"** (guide 1; Node 24 only from nodejs.org's 24.x folder, never winget's Node 26 without update.bat; the firewall sentence of PLAN B11: `If Windows asks whether to allow Node.js through the firewall, tick only "Private networks" (untick "Public networks") and click Allow. If you clicked Cancel by mistake, run setup-pc.bat again: it removes the block rule that Cancel creates.`), **"Mailgun, DNS and reply routes"** (guide 2 §4–§8, §15), **"Tracking off, unsubscribe on"** (guide 2 §11), **"Cloudflare Tunnel and optional Access"** (guide 3, its "Skipping Cloudflare Access" box; never cloudflared 2026.8.0 or 2026.8.1) |
| 3 | Everyday use | the dashboard first (attention list, your "Replies waiting for an answer" with **Answered**, the numbers); Contacts, lists, statuses; a campaign in six steps (one line each); replies (the app can't see your inbox: click **Answered**); notifications; AI lines; address checks; missing emails with Claude; the top-bar label table with the after-go-live meanings (§2.7) |
| 4 | Your team (SPEC) | Settings › Team › **Invite a teammate** › **Create invite link** (72 h, once; office link and "works anywhere" link; **New invite link** when expired); add remote staff to Cloudflare's **Outreach staff** policy (guide 3 step 4); each person fills Settings › My profile (**Sending address**, **Reply inbox**, signature, time zone) until "Reply route: working"; **Switch off** / **Switch back on**; **Make Owner** (exactly one Owner); **Reset password link** (not for yourself: the Owner uses reset-password.bat at the PC); per-sender limits (Settings › Limits & warm-up); after 5 wrong passwords a person waits a minute |
| 5 | Sending safely | sending hours; the daily limit and warm-up (50 → 1,000 in about 4 weeks; "step N of 20" goes up one step after a weekday with at least half the limit used and healthy numbers, holds otherwise); the health auto-pause and Resume (numbers count from going live); **Pause all sending**; the 30-day rule (its length is a setting; the name stays "30-day rule"); what going live changes, and that changing the sending domain later means going live again (link guide 4) |
| 6 | When the PC is off, and keeping it awake (SPEC) | today's "PC is off" section + setup-pc.bat and active hours (European hours = afternoon and evening in Pakistan); on battery the laptop still sleeps |
| 7 | Backups and restore (SPEC) | at least one daily backup per day (by 20:00 when no quiet moment came), the newest 14 daily kept plus the newest 5 **Back up now** (anyone), each checked by SQLite; the second copy (USB/second disk/OneDrive; save it, then run install-services.bat; not a network folder or mapped drive; a first copy is made on saving); the 36-hour and disk-space warnings (dashboard and Settings › Backups), script backups (Before an update/restore/upgrade: newest 3 of each, at least 14 days), restore steps (§3.7's list), what restore.bat refuses (a backup from a newer version or from the practice copy) and when it asks twice (another database), the report and Resume, undo ("Before a restore"), restoring from the second folder (`restore.bat "<full path>"`), a practice restore before going live (guide 4 step 5), **moving to a new PC** (copy `.env` + the newest backup → guide 1 on the new PC → restore.bat, answer yes twice → Resume once; the old PC must be switched off first), keeping `.env` safe |
| 8 | Updating | §6.1 Q-A (with the delete-the-code-folders step); Node.js updates (24.x only: stop.bat → install → update.bat; install-services.bat again if Node moved); cloudflared monthly (never 2026.8.0 or 2026.8.1); Windows Update active hours |
| 9 | The double-click scripts | the single table (moved here from guide 1 §9), including `uninstall-services.bat` |
| 10 | Troubleshooting | symptom → where (guide 1 §12, guide 2 §18, guide 3 §16) + the audit §6 items without another home: disk full, second folder unplugged, clock wrong ("Set time automatically"), `.env` lost, an antivirus quarantining `tools\nssm.exe` or the Prisma engine (PLAN B11: restore it from quarantine, add the app folder as an exclusion, run update.bat), a reply filed as real that was automatic (set the company's status back by hand, then put the person in a new campaign), "Last emailed: Never" for test mailboxes (L18), a renamed PC asks for one Resume (L8), the app folder moved (one Resume) |
| 11 | What it costs | one correct table: Mailgun Foundation about $35/month, address checks about $0.012 each (Foundation includes none), domains, Cloudflare $0 (Access asks for a card), Claude about $1.69 per 300 lines with Haiku, the app's own monthly limits ($100 checks, $20 AI) |
| 12 | Where things live | `data\app.db`, `.env`, `backups\` (and `backups\demo\` for the practice copy), the second folder, `logs\` ("the newest file"), `run\`, `tools\`, `docs\setup\` |
| 13 | Words used here, getting help, for developers | a short glossary from PLAN A10 (dry run, Test mode, live, go live, test list, warm-up, the 30-day rule, reply route, practice copy, background sender, Owner/Member); "the person who set up the app for you"; one line: "Developers: see docs/dev/README.md" |

Removed from the README: the status line and "Installing the Milestone 5 update" (lines 5 and 7), the "(after go-live,
Milestone 6)" row, the developer history (moved to `docs/dev/README.md`).

### 6.3 Guides 1–3

| Guide | Changes |
|---|---|
| 1-install | §1 Node: `Install Node.js 24 (not 26): open https://nodejs.org/dist/latest-v24.x/ and download the file ending in -x64.msi. Any 24.x from 24.18 works; the app refuses 26.` Remove "until I say so", "Milestone 3". Add UAC ("Windows Command Processor", the first window closes and a new one opens), SmartScreen/Unblock, Smart App Control (one line), the delayed start after a restart (1–2 minutes), battery sleep, "put the app folder in `C:\Outreach`, never in Desktop, Documents, Pictures, OneDrive or Dropbox (a sync program or Windows' ransomware protection can take the database over)", Node updates (stop.bat → install → update.bat; install-services.bat again if Node moved). §9 becomes one paragraph + link to README "The double-click scripts" and "Backups and restore" (the kind labels of §3.2). §11 → link to README "Where things live"; logs are "the newest file in `logs\`". Keep the heading "12. Troubleshooting" (scripts cite it). |
| 2-mailgun-and-dns | Keep §1–§18 (numbers stable). Remove Q-numbers, milestone words, "tell me"; "Setup A (the normal setup)" / "Setup B (check only)" with the letters kept; §13 quotes `liveConfirmText` before go-live (§2.7) and says the mode name changes to "Live" after going live; fix the §18 quote to the app's text (`These are Mailgun's mail servers for the other region (…); your domain is in the EU region.`); §17 → one line + README link. §19 "Test follow-ups and replies" and §20 "Address checks and AI lines" lose "(Milestone N)" in the headings; their test parts move to guide 4 step 3 ("rehearsal"), the setup parts (Validations on, "Test address checks", the Anthropic key and Console limit) stay as §19 "Address checks and the Anthropic key"; the old §20 anchor is gone (P10's reference test catches any link to it). Say the Mailgun key goes into Settings › Sending & Mailgun, never into `.env`. |
| 3-cloudflare | Remove "(Q11)"; add the box **"Skipping Cloudflare Access"** (what happens, the Settings › System switch, the go-live recommendation line); add "Staff joining or leaving" (edit the Outreach staff list); mark the §16 registry edit "only if the tunnel keeps showing Degraded". Step numbers unchanged (the app cites steps 5, 6, 7). |

### 6.4 New `docs/setup/4-going-live.md` ("Going-live guide"; step numbers are fixed, the app cites 3, 5 and 8)

| Step | Heading | Content |
|---|---|---|
| 1 | Before you start | the sending domain at least 30 days old (Domain age row), Mailgun business verification approved, Foundation plan and the monthly safety limit (guide 2 §9), Validations on, the Anthropic key saved (optional), everyone's profile and sending address, where each open decision is entered (§6.1), delete `MAILGUN_*` lines from `.env` (the key lives in Settings); **read and confirm the earlier change lists** with the person who set up the app (the default answers to the build's open questions and the behaviour changes of the sending, follow-up and address-check updates; §10.3 item 29) |
| 2 | The Domain checklist is all green | the 16 row titles of `CHECKLIST_ROW_TITLES` for `GO_LIVE_ROW_KEYS` in the screen's words (a "needs attention" row too), **Check again** within the hour before going live, Setup A, the reply test, not paused, every sender's reply route; "Before going live:" lists what's left |
| 3 | Rehearse with your test mailboxes | a live campaign to the test list and wait until the go-live card no longer says "hasn't been confirmed as delivered" (the go-live blocker), a reply that stops follow-ups, an out-of-office that doesn't, one address check, 20 AI lines, the Claude round trip (moved from guide 2 §19/§20) |
| 4 | The PC | the app folder in `C:\Outreach` (if it is in Pictures, Documents, Desktop or OneDrive: stop.bat → uninstall-services.bat → move the folder → install-services.bat → open the app and click Resume once, because the database moved), services installed (`install-services.bat`), setup-pc done, active hours set, **the restart test** (restart, wait 2 minutes, status.bat all green, the dashboard shows no "background sender" item) |
| 5 | Backups and a practice restore | second copy: save it in Settings › Backups, **then** run install-services.bat, then check Settings › Backups says the first copy worked; `.env` copied to a USB stick or password manager; **a practice restore on the real data, right after Back up now, when nobody is working** (`Anything changed in between is lost, and sending pauses for about 35 minutes.`): restore.bat → pick the newest ("Back up now") → yes → open the app → read the report in Settings › Sending & Mailgun → Resume sending; then look at Settings › Backups "Last restore" (what the owner will see, in words) |
| 6 | Settings to check once | Email footer, portfolio URL, **your master template and follow-ups** (they go to real prospects from now on), sending hours, daily maximum (1,000), per-sender limits, health thresholds, **the 30-day rule**, address check rules and monthly limit, the AI limit and model (Settings › AI › test the model; Haiku 4.5's retirement may come from late November 2026: pick Sonnet 5 if drafting stops with "model not found") |
| 7 | Your test mailboxes after going live | G9 in plain words; keep the "Test mailboxes" list out of real campaigns |
| 8 | Switch on Go live | Settings › Sending & Mailgun › **Go live**; the dialog's exact text (§2.5), including the drafts it lists and the removed hand-set limit; what changes: label **Sending live**, new live campaigns email everyone eligible, mode Live, campaigns keep their launch mode, Test mode stays test-list-only, a draft made earlier asks for a tick before it launches, bounces count from now; **it can't be switched off** (Pause all sending stops everything) |
| 9 | Warm-up | the table (50, 59, 69, 80, 94, 110, 129, 151, 177, 207, 242, 283, 332, 389, 455, 533, 624, 730, 855, 1,000); one step up after a weekday with at least half the limit used and healthy numbers, otherwise the step holds; about 4 weeks at the earliest; where to see `Warm-up step 9 of 20: 177 a day. …` (dashboard, Limits & warm-up) and what "Tomorrow 207, if today's numbers stay healthy" means; overriding with confirmation |
| 10 | Your first real campaign | 20–30 checked addresses from one list; Verify, Review, Schedule; what to watch on the dashboard the next day (sent today, bounces, replies waiting) |
| 11 | The first weeks | daily 5 minutes (attention list, replies, AI lines); weekly (backup age, Domain checklist green, status.bat); monthly (cloudflared update, Node 24.x update via update.bat, Mailgun and Anthropic invoices against the app's limits); the dashboard numbers explained (reply rate definition, dry runs shown apart) |
| 12 | If something goes wrong | auto-pause (what the numbers mean, fix the list, Resume); Pause all sending; a complaint; remote access down; the PC off for more than 5 days (follow-ups held, "Continue follow-ups") |
| 13 | Changing the sending domain later | G8: going live ends; live campaigns reach only the test list until you go live again on the new domain (the whole checklist, the reply test and a delivered live test on it); new warm-up at 50; old domain checked for 60 days (the dashboard's old-domain item) |

### 6.5 `docs/dev/README.md` (new, developers)

Today's README "For developers" section, plus: where the designs are (M3–M6), CONVENTIONS, the manual-check seeds
(`scripts/seed-m5-manual.ts`, `scripts/seed-m6-manual.ts`), `npm run check`, `npm run test:e2e` (how the lead starts the
instances, §9.4), and "the code and its tests win over the design files".

### 6.6 Owner-facing script texts (P6)

Every "Install Node.js 24.21.0 from https://nodejs.org" becomes `Install Node.js 24 (not 26) from
https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi)` in: `restore.bat:42`, `reset-password.bat:18`,
`setup.bat:20, 26`, `start.bat:47`, `start-demo.bat:14`, `update.bat:35`, `stop.bat:36`, `scripts/update.mjs:127`,
`scripts/setup.mjs:218`, `scripts/install-services.ps1:28, 34`, and `scripts/lib/node-check.mjs:36, 43, 50`
(`RECOMMENDED_NODE` stays "24.21.0"; the messages name the folder). `.bat` files keep CRLF
(`tests/unit/ops/script-files.test.ts`). `scripts/reset-password.ts`: "The app must be running (start.bat) …" →
`The app must be running (status.bat shows it) for the link to open.`

### 6.7 In-app help references

The app cites guides as `(<Guide title>, step N)` and `docs\setup\<file>` (e.g. `Cloudflare guide, step 5`,
`Mailgun guide, step 9`, `Going-live guide, step 3`). P6 adds `tests/unit/docs/guide-refs.test.ts`: it scans `src/**`,
`scripts/**` (`.ts`, `.mjs`, `.ps1`) and the `.bat` files for three forms: `(Install|Mailgun|Cloudflare|Going-live)
guide, step (\d+)` (Install → `1-install.md`, Mailgun → `2-mailgun-and-dns.md`, Cloudflare → `3-cloudflare.md`,
Going-live → `4-going-live.md`); `docs\\setup\\([\w.-]+\.md), step (\d+)` (e.g. `scripts/status.ps1:44`); and
`docs\\setup\\([\w.-]+\.md), (Troubleshooting)` (e.g. `install-services.ps1:228`, `ops-common.ps1:221`, `update.mjs:118`);
plus any bare `docs\\setup\\[\w.-]+\.md`. It asserts the file exists and has a heading `## <N>. ` (step forms) or a
heading containing "Troubleshooting" (the named form); the guides' H1s stay "Install guide", "Mailgun and DNS guide",
"Cloudflare guide (remote access)" and the new "Going-live guide". It also checks README/guide links to
`docs/setup/*.md#anchors` resolve to a heading. Renumbering a guide therefore fails a test instead of breaking a screen.

---

## 7. Settings, state, schema, packages and contracts (step C)

### 7.1 Settings (`SETTING_DEFAULTS`, Owner-edited; JSON rows, no migration)

| Key | Default | New? | Written by | Read by |
|---|---|---|---|---|
| `sending.goLive` | `false` | existing | `true` only by `goLive()` (P2); `false` only by a domain change in `connectMailgun` (P2, G8) | eligibility (draft/launch), guard (with the campaign flag), label, words, gates, go-live card, dashboard |
| `sending.goLiveAt` | `null` (`string \| null`, ISO) | **new** | only `goLive()` | go-live card, dashboard, health counting (G12), warm-up self-healing, drafts made before go-live (G11), guide |
| `sending.goLiveDomain` | `null` (`string \| null`) | **new** | only `goLive()` | go-live card ("Live on …", "You were live on …"), dashboard `go-live-again` |
| `sending.mode` | `"DRY_RUN"` | existing | `setSendingModeAction`, `goLive()` | unchanged |
| `sending.capOverride` | `null` | existing | + cleared by `goLive()` when it is for today (G5) | unchanged |
| `remoteAccess.accessOff` | `false` | **new** | `saveAccessChoiceAction` (P5) | the remote-access row (P2), the remote-access card (P5), go-live recommendations |
| `teamRule.days` | `30` | existing, **editor new** | `saveRulesAction` (P5) | eligibility |
| `reservations.pausedExpiryDays` | `14` | existing, **editor new** | `saveRulesAction` | reservations |
| `sharedDomains.extra` | `[]` | existing, **editor new** | `saveRulesAction` | eligibility, imports, company create, AI selection |
| `backups.secondFolder` | `null` | existing | `saveSecondFolderAction` (P3, stricter checks) | `runBackup`, `backupStatus` |
| `backups.keep`, `verification.provider` | 14, "mailgun" | existing | nobody (no editor, §1.5) | unchanged |

### 7.2 SystemState (JSON, no migration)

| Key | Change | Written by | Read by |
|---|---|---|---|
| `instance` (`InstanceState`) | + optional `host: string` | `checkDatabaseInstance` (P3) | `copyCause` (P3) |
| `mailgun.catchUp` (`CatchUpState`) | + optional `oldDomains: OldDomainProblemState[]` (≤ 10) | the catch-up run (P4) | Sending & Mailgun card (P2), dashboard (P7) via `oldDomainLines` |
| `warmup` (`WarmupState`) | no shape change; restarted at go-live (and repaired by `evaluateWarmupDays`) | `startWarmupAtGoLive` (P2), `evaluateWarmupDays` | unchanged |
| `restore` (`RestoreState`) | + optional `resumedAt: string \| null`, `resumedById: number \| null` (who resumed after any restore) | `resumeSending` (P3) | `lastRestoreView` (P3), the go-live restore recommendation (P2) |
| `healthBaseline` | no change; readers also respect `sending.goLiveAt` (G12) | unchanged | health check, `loadHealthView`, `evaluateWarmupDays` via `healthCountingSince` (P2) |
| `task.backup.daily` | no change | unchanged | unchanged |

### 7.3 Notification, activity and notice types

| Kind | Name | Copy | Package |
|---|---|---|---|
| Notification | `sending.wentLive` | §2.5 (to every active user; filter "Sending and system"; no pop-up group) | P2 |
| Activity | `sending.goLive` | `Arslan went live on send.example.com` (data `{at, domain, modeFrom, modeTo, capOverrideCleared}`) | P2 |
| Activity | `mailgun.domainChanged` (existing) | unchanged summary; data gains `goLiveEnded: true` when the change ended go-live | P2 |
| Activity | `settings.updated` with `data.key` `teamRule.days`, `reservations.pausedExpiryDays`, `sharedDomains.extra`, `remoteAccess.accessOff` | `Arslan set the 30-day rule to 21 days` · `Arslan set paused campaigns to keep their companies for 10 days` · `Arslan changed the shared email domains` · `Arslan turned off the Cloudflare Access check` / `… turned on …` | P5 |
| Notice key (type `system.mailgun`) | `catchup-old-domain` | title `Couldn't check an old sending domain`; body `The app hasn't been able to check Mailgun's logs for the old domain mail.example.com since 25 Sep. Replies and bounces to its last emails may be missed. Check that the domain still exists in Mailgun and that the key works.`; link `/settings/sending` | P4 |

P10 adds them to the doc lists in `server/activity.ts` and `server/notifications.ts`.

### 7.4 Environment variables

No new app variable. `run-prod.mjs` now also sets `APP_PUBLIC_URL=http://127.0.0.1:<port>` for a test run (§3.9).
Playwright only (read by `playwright.config.ts` and the specs, never by the app): `PP_E2E_BASE_URL` (required),
`PP_E2E_STATE` (`empty` | `busy` | `ready` | `live`), `PP_E2E_OWNER_EMAIL`, `PP_E2E_OWNER_PASSWORD`,
`PP_E2E_MEMBER_EMAIL`, `PP_E2E_MEMBER_PASSWORD` (defaults = P9's seed users, §9.4). The config refuses a base URL that
isn't `http://127.0.0.1:<port>` (no real host, ever). Each manual-check instance is started with
`APP_PUBLIC_URL=http://127.0.0.1:<its port>`, `OUTREACH_MAILGUN_BASE_URL` = its own fake Mailgun,
`OUTREACH_ANTHROPIC_BASE_URL=http://127.0.0.1:4020` (the fake Claude) and `OUTREACH_WEB_FIXTURES=tests/fixtures/sites`
(§9.4).

### 7.5 npm packages (step C; `.npmrc` has `save-exact=true`)

```powershell
# 1. stop.bat (or stop the services) and close every next dev / worker window (open handles or a Defender scan cause
#    EPERM/EBUSY; on EPERM wait a minute and run the same command again).
npm install --save-exact htmlparser2@10.1.0 encoding-sniffer@0.2.1
#    package.json "dependencies" gains "encoding-sniffer": "0.2.1" and "htmlparser2": "10.1.0"; package-lock.json's
#    root entry (packages[""].dependencies) gains the same two lines. No module moves: both are already the only,
#    top-level copies (package-lock.json node_modules/htmlparser2 at line 9942, node_modules/encoding-sniffer at 8262),
#    which cheerio 1.2.0 (^10.1.0, ^0.2.1) keeps using.
# 2. Prove the lockfile alone rebuilds the tree, as update.bat does (npm ci before the build):
Remove-Item -Recurse -Force node_modules; npm ci
npm ls htmlparser2 encoding-sniffer cheerio
node -e "console.log(require('htmlparser2/package.json').version, require('encoding-sniffer/package.json').version)"   # 10.1.0 0.2.1
node scripts/build-worker.mjs   # its --self-test prints "packages ok"
```

| Package | Version | Why | Notes |
|---|---|---|---|
| `htmlparser2` | 10.1.0 | imported directly by `src/server/web/extract.ts:18` since the M5 review (WEB-02) | pure JS, no install scripts, worker-external like the rest |
| `encoding-sniffer` | 0.2.1 | imported directly by `src/server/web/extract.ts:17` | pure JS; its nested `iconv-lite` 0.6.3 stays nested |
| `cheerio` | 1.2.0 (stays) | the reference parser in `tests/unit/web-reader/extract.test.ts` and the worker's `--self-test` | moving it to devDependencies would change the self-test and `update.bat`'s install; not worth it |
| `@playwright/test`, `@axe-core/playwright` | 1.63.0, 4.13.0 (dev, already installed) | P9's suite | Chromium 1243 already installed; never `npx playwright install` |

No `allowScripts` change. `tests/unit/worker/packages.test.ts:60-62` comment: "direct dependencies since M6" (P10).

### 7.6 Prisma schema diff (`prisma/schema.prisma`, comments only)

```diff
 model Campaign {
   …
   launchedAt       DateTime?
-  /// Setting "sending.goLive" at launch: the test-list exception is judged at launch (M5-DESIGN §2.8). Null = launched before M5.
+  /// Setting "sending.goLive" at launch (M5-DESIGN §2.8, M6-DESIGN §2.2–§2.3): whether this campaign's LIVE sends count
+  /// as "emailed" or stay test-list only (eligibility at send, the loop, the Mailgun guard), and the test-list
+  /// exception. Set for every launched campaign (the M6 migration filled older launches with false); null only for drafts.
   launchedGoLive   Boolean?
   …
 }
```

```diff
 model AiDraft {
   …
-  /// Times this draft went to FETCHING; 2 stuck reads in a row → FAILED (a page that crashes the worker, M5-DESIGN §3.4.9).
+  /// Interrupted reads of this draft: a finished read or a requeue from FETCHING gives the claim back, so only reads
+  /// that never ended count; resetStuckDrafts fails the draft at 2 (M5-DESIGN §3.4.9, §12.3 DATA-05).
   readAttempts   Int           @default(0)
   …
 }
```

No new model, column, index, enum value or relation. `BackupKind` stays `AUTO | MANUAL | PRE_UPDATE | PRE_RESTORE`
(script backups never get rows, §3.2).

### 7.7 Migration `prisma/migrations/20260927120000_m6_go_live/migration.sql`

```sql
-- Milestone 6 (go live, M6-DESIGN §2.2): data only, no schema change.
-- Campaigns launched before Milestone 5 have no launch flag. Going live was impossible then, so their live sends could
-- only reach the test list: record that, so "emailed" is judged by the flag alone from now on.
UPDATE "Campaign" SET "launchedGoLive" = false WHERE "launchedGoLive" IS NULL AND "launchedAt" IS NOT NULL;
```

The lead checks with `prisma migrate diff` (the M5 procedure) that the schema edits produce no SQL (comments aren't
SQL), then `npx prisma generate`. The supervisor applies the
migration with `migrate deploy` on the next start (M2–M5 path). The practice copy (`data/demo.db`) gets it the same way.

### 7.8 New contract files and contract code (the lead writes them in step C)

**`src/core/rules/mode.ts`** (edit; behaviour unchanged for today's callers):

```ts
/**
 * "Emailed" (PLAN A5.1, M3-DESIGN §1.7, M6-DESIGN §2.2): every counted send except LIVE sends of a campaign launched
 * before go-live (they could only reach the test list). Judged per campaign by its launch flag, never by today's switch.
 */
export function countsAsEmailed(
  mode: SendModeValue | null | undefined,
  ctx: {
    practiceCopy: boolean;
    /** The campaign's `launchedGoLive` (true only when launched after go-live). */
    launchedGoLive?: boolean | null;
    /** @deprecated M6 step C bridge: today's setting. P1 removes it once every caller passes `launchedGoLive`. */
    goLive?: boolean;
  },
): boolean {
  const live = "launchedGoLive" in ctx ? ctx.launchedGoLive === true : ctx.goLive === true;
  return countsAsReal(mode, ctx.practiceCopy) && !(mode === "LIVE" && !live);
}

/** @deprecated M6: use emailedSendWhere (P1, src/server/services/emailed.ts); P1 deletes this. */
export function emailedModes(ctx: { practiceCopy: boolean; goLive: boolean }): SendModeValue[] {
  return realModes(ctx.practiceCopy).filter((m) => countsAsEmailed(m, ctx));
}

/**
 * Test-list-only sending (M6-DESIGN §2.3): Mailgun's test mode always, live before go-live. `goLive` is today's setting
 * in the draft and at launch, and the campaign's launch flag at send time.
 */
export function testListOnly(mode: SendModeValue | null | undefined, goLive: boolean): boolean {
  return mode === "TEST" || (mode === "LIVE" && !goLive);
}
```

**`src/core/sending/mode-gates.ts`** (edit): `liveLaunchBlockers`' ctx gains `goLive?: boolean` (documented, not used
until P2 implements §2.3), and `goLiveBlockers`' ctx gains `connected?: boolean; checkFresh?: boolean; setup?:
UnsubscribeSetup; liveTest?: "none" | "sent" | "delivered"; workerRunning?: boolean` (same; §2.4).

**`src/server/services/campaigns/launch.ts`** (edit, type only): the launch input type gains
`confirmMadeBeforeGoLive?: boolean` with the doc comment `M6-DESIGN §2.3 G11: required for a LIVE launch of a campaign
created before sending.goLiveAt (P1 enforces it).` Unused until P1.

**`src/server/mailgun/types.ts`** (edit, type only): `SendMessageInput` gains `testListOnly?: boolean` with the doc
comment `M6-DESIGN §2.3: the campaign's testListOnly(mode, launchedGoLive); after go-live a campaign email reaches a
non-test-list address only when this is false.` Unused until P1.

**`src/server/settings.ts`** (edit): the three keys of §7.1 (`"sending.goLiveAt": null as string | null` and
`"sending.goLiveDomain": null as string | null` in the Sending group; `"remoteAccess.accessOff": false` in a new "Remote
access" group); `SettingValue` maps `"sending.goLiveAt"` and `"sending.goLiveDomain"` to `string | null` (added to the
`backups.secondFolder | mailgun.domain | mailgun.domainRegisteredOn` branch); and:

```ts
/** One setting inside an open transaction (M6-DESIGN §2.5, §5.3: go-live and the rule settings write several settings and their activity together). */
export async function setSettingIn<K extends SettingKey>(tx: Tx, key: K, value: SettingValue<K>, userId: number | null): Promise<void> {
  await tx.setting.upsert({
    where: { key },
    create: { key, value: value as never, updatedById: userId },
    update: { value: value as never, updatedById: userId },
  });
}
```

**`src/core/system-state.ts`** (edit):

```ts
export type InstanceState = {
  dbPath: string;
  id: string;
  firstSeenAt: string;
  /** M6 (L8): os.hostname() at the last start; missing in rows written before M6. */
  host?: string;
};
/** M6 (L10): an older sending domain the catch-up couldn't check, since when. */
export type OldDomainProblemState = { domain: string; since: string; lastAt: string; text: string };
export type CatchUpState = {
  /* …existing fields… */
  /** M6 (L10): older domains that couldn't be checked; absent or empty when none. */
  oldDomains?: OldDomainProblemState[];
};
export type RestoreState = {
  /* …existing fields… */
  /** M6 (§3.7): when and by whom sending was resumed after this restore (any outcome); absent before M6. */
  resumedAt?: string | null;
  resumedById?: number | null;
};
```

**`src/core/system-state-parse.ts`** (edit): `parseInstanceState` keeps `host` when it is a non-empty string (and leaves
the field out otherwise, so existing `toEqual`s hold); `parseCatchUpState` keeps `oldDomains` as the valid entries
(domain, since, lastAt ISO, text ≤ 300 characters), at most 10, and leaves the field out when there are none;
`parseRestoreState` keeps `resumedAt` (ISO) and `resumedById` (positive integer) when valid and leaves them out
otherwise.

**`src/core/backups/age.ts`** (new):

```ts
/** M6 contract (M6-DESIGN §3.6): how old the newest backup is. Pure. */
export const BACKUP_STALE_MS = 36 * 60 * 60 * 1000;
export type BackupAgeState = "ok" | "stale" | "never";
export function backupAge(newestAt: Date | null, now: Date): { state: BackupAgeState; ageMs: number | null } {
  if (!newestAt) return { state: "never", ageMs: null };
  const ageMs = now.getTime() - newestAt.getTime();
  return { state: ageMs > BACKUP_STALE_MS ? "stale" : "ok", ageMs };
}
```

`src/server/services/backups.ts` then re-exports `BACKUP_STALE_MS` from it (`export { BACKUP_STALE_MS } from
"@/core/backups/age";` replacing its own constant; P3 owns the rest of the file).

**`src/core/sending/warmup-line.ts`** (new; §2.6):

```ts
/** M6 contract (M6-DESIGN §2.6): the warm-up line on every screen. "Step" is the ramp's step, not a day count. Pure. */
export type WarmupToday = { sendingDay: boolean; used: number; cap: number; minUsePercent: number; healthy: boolean };
export function warmupLine(step: number, table: readonly number[], today: WarmupToday | null): string {
  const n = (v: number) => v.toLocaleString("en-US");
  if (table.length === 0) return "Warm-up finished.";
  const last = table.length - 1;
  const i = Math.min(Math.max(0, Math.floor(step)), last);
  if (i >= last) return `Warm-up finished: ${n(table[last]!)} a day.`;
  const head = `Warm-up step ${i + 1} of ${table.length}: ${n(table[i]!)} a day.`;
  const qualifying =
    today !== null && today.sendingDay && today.healthy && today.used * 100 >= today.cap * today.minUsePercent;
  return qualifying
    ? `${head} Tomorrow ${n(table[i + 1]!)}, if today's numbers stay healthy.`
    : `${head} It goes up to ${n(table[i + 1]!)} after a weekday with at least half the limit used and healthy numbers.`;
}
```

### 7.9 Contract moves and edits (behaviour unchanged)

| Move / edit | From | To | Used by |
|---|---|---|---|
| `restoreLines` → `restoreReportLines(restore, zone, now)` with its `when` helper | `src/app/(app)/settings/sending/load.ts:170-208` | new `src/core/sending/restore-report.ts`; `load.ts` imports it | P2 (pause card), P3 (Last restore) |
| The catch-up line and failing rule of `checkWithMailgunView` → `catchUpFailing(state: CatchUpState): boolean` and `catchUpStatusLine(state, zone, now): {line: string; failing: boolean; detail: string \| null}` | `load.ts:300-322` | new `src/core/mailgun/catch-up-status.ts`; `load.ts` imports them (the outage part stays) | P2, P7 |
| New in the same file: `oldDomainLines(state: CatchUpState, zone: string, now: Date): string[]` → `Mailgun's logs for the old domain <domain> haven't been checked since <formatShortDate(since)>. Replies and bounces to its last emails may be missed.` per entry | — | `src/core/mailgun/catch-up-status.ts` | P2, P7 |
| `tests/setup/env.ts:9` default `DATABASE_URL` | `file:./data/test-unit.db` | `file:./data/test/__use-createTestDb__/none.db` (the folder never exists, so a test that forgot `createTestDb()` fails at once with a path that says why); delete `data\test-unit.db`, `-shm`, `-wal` (L16) | every test |
| Unit tests for the three new pure functions and the moved ones, and the new parser fields | — | `tests/unit/contracts-m6/*.test.ts` (lead) | — |

---

## 8. Work packages

Every package: follow `CONVENTIONS.md` and §0.2; run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`,
`npx eslint <owned paths>`, `npx vitest run <own test paths>` (P1 and P10: the whole suite); never run `next
build/dev/start`, `npm install`, `prisma migrate *` or `npx playwright test`; never touch `data/app.db`; never call a
real service. Report any needed contract change instead of making it. Update the existing tests listed for your files
(§9.2) in the same package. Ownership is by file; two packages of the same wave never own the same file.

### P1 — The "emailed" rule and the test-list guard (wave 1)

**Owned paths:** `src/core/rules/mode.ts` (beyond step C: remove the `goLive` bridge and `emailedModes` at the end),
`src/core/rules/eligibility.ts`, `src/core/replies/kind.ts`, `src/core/sequences/wording.ts` (comments),
`src/server/services/emailed.ts` (new), `src/server/services/eligibility.ts`,
`src/server/services/campaigns/{launch,control,queries}.ts`, `src/server/services/sending/{loop,mark-sent}.ts`,
`src/server/services/companies/detail.ts`, `src/server/services/replies/{input,process,actions}.ts`,
`src/server/mailgun/send-guard.ts`, `src/server/mailgun/types.ts` (beyond step C: nothing else),
`src/server/services/sending/mailgun-transport.ts`, the file that defines `OutgoingMessage` (the loop's message type;
only its new `testListOnly` field), `src/components/company-panel/{emailed-text.ts,company-panel.tsx}`,
`src/components/campaigns/format.ts`, `src/components/contacts/format.ts` and the Contacts table cell file that renders
"Last emailed" (`src/components/contacts/companies-table.tsx` or the cell it uses); tests `tests/unit/rules/**`,
`tests/unit/replies-core/kind.test.ts`, `tests/unit/sequences-core/wording.test.ts`,
`tests/unit/mailgun-client/send-guard.test.ts`, `tests/unit/mailgun-client/transport*.test.ts` (the flag),
`tests/unit/company-panel/emailed-text*.test.ts`, `tests/unit/contacts/{format,companies-table}.test.ts`,
`tests/unit/campaigns/format*.test.ts` (alias cases), `tests/integration/go-live-rule/**` (new), and the updates of
§9.2 marked P1.

**Builds:** §2.2 in full (every call site of its table, `emailedSendWhere`, `recheckRecipient`'s launch-flag settings,
the L21 alias removal, the L18 tooltip), §2.3's P1 rows (eligibility's test-list rule and text for TEST, "counts as
checked" in the draft, at launch and at send, the send-time re-check, the loop's final check by launch flag, the
Mailgun client guard with `testMode` and `testListOnly` (fail closed), `buildSendInput` setting the flag), `launch.ts`
passing `goLive: settings.goLive` to `liveLaunchBlockers`, and G11's refusal in `launch()`: LIVE, `sending.goLive` true
and `campaign.createdAt < sending.goLiveAt` without `confirmMadeBeforeGoLive` → `CampaignError("Tick the box to confirm
that this draft now sends real email.")`.

**Provides:** `emailedSendWhere(practiceCopy)`; `countsAsEmailed(mode, {practiceCopy, launchedGoLive})` (final
signature); `replyScope({mode, link, simulated, practiceCopy, goLive, launchedGoLive})`.

**Consumes:** the step-C contracts (`testListOnly`, the bridge), existing code.

**Tests:**
- unit: `countsAsEmailed` table (mode × practiceCopy × launch flag true/false/null/undefined); `testListOnly` table;
  `replyScope` (LIVE link with flag false → `changesStatus false` even when today's `goLive` is true; flag true →
  true; company link uses today's `goLive`); `checkSendGuard` (after go-live: a campaign email with `testListOnly:
  false` to anyone passes; `testListOnly: true` or missing → "Stopped by the test-list guard: … isn't on your test
  list."; `testMode: true` to a non-test-list address throws the same; a reply-test email to a non-test-list address
  throws; self-test unchanged); `buildSendInput` sets `testListOnly` from mode and launch flag; eligibility (TEST after
  go-live: `not-on-test-list` with the TEST text; test-list address counts as checked for TEST; LIVE after go-live: no
  test-list rule; send phase uses the launch flag).
- integration `tests/integration/go-live-rule/flip.test.ts` (fake Mailgun, real-data settings): a LIVE campaign
  launched before go-live with 2 steps to a test mailbox → first email sent → `sending.goLive = true` (set directly:
  this test is about the rule, not the switch) → the second step sends: no reservation taken, company still
  NOT_CONTACTED, `lastEmailedAt` null, the sequence still ends in " (test list)", a new draft with that company is not
  blocked by the 30-day rule; a reply to the old email processed after the flip has `changesStatus false`. Then a LIVE
  campaign launched after the flip to a checked prospect: reservation taken, CONTACTED, `lastEmailed*` set, and a
  second draft is blocked by the 30-day rule. **Test-list only across the flip**: a pre-go-live LIVE campaign with 3
  steps to Tess; after go-live Tess is removed from the test list → the next step is skipped with `not-on-test-list`
  by `recheckRecipient`; with the loop's final check and the re-check stubbed to pass, the Mailgun client guard still
  throws (the claimed row carries `testListOnly: true`). A draft created before go-live: `launch()` in LIVE without
  `confirmMadeBeforeGoLive` → refused with the G11 sentence, nothing launched; with it → launched.
- `tests/integration/sending/query-plans.test.ts` passes with the join (every history query still uses its index).
- The whole suite (`npx vitest run`): the 44 files that mention `goLive` pass (a test that set `goLive` after launching
  and expected "emailed" is corrected to launch after setting it, with a comment naming §2.2).

**Done when:** tests pass; `grep "goLive:"` in `src/` shows no `countsAsEmailed` caller passing today's switch;
`emailedModes` and the bridge are gone.

### P2 — Go live, the checklist, warm-up start and Settings › Sending & Mailgun (wave 1)

**Owned paths:** `src/core/sending/{mode-gates,label}.ts` (label: comments only),
`src/core/sending/{go-live-copy,app-folder,health-since}.ts` (new), `src/core/dns/checklist.ts`,
`src/core/mailgun/routes.ts` (the two public-address sentences only), `src/server/services/go-live.ts` (new),
`src/server/services/reply-test.ts`, `src/server/services/sending/{warmup-days,health-check}.ts`,
`src/server/services/mail-events/deliverability.ts` (health counting and `sinceNote` only),
`src/server/services/mailgun/connect.ts` (G8 only), `src/server/services/checks/domain-check.ts`,
`src/server/services/campaigns/draft.ts` (`LaunchSummary` fields only), `src/app/(app)/settings/sending/**`,
`src/components/settings/sending/**`, `src/components/settings/types.ts` (`ModeOptionView`, `PauseView` and anything
else there; P5 reports a needed change instead of making it), `src/components/campaign-wizard/{wizard-frame.tsx,
format.ts,schedule-step.tsx}`, `src/app/(app)/campaigns/[id]/setup/**` (the badge, the Schedule line and checkbox, the
launch action's new flag), `src/components/checks/verify-model.ts`, `src/components/shell/sending-pill.tsx`; tests
`tests/unit/sending-core/{mode-gates,label}.test.ts`, `tests/unit/go-live/**` (new),
`tests/unit/checks/checklist.test.ts` (remote-access cases), `tests/unit/campaign-wizard/**` (mode text cases, the
Schedule checkbox), `tests/unit/checks/verify-model*.test.ts`, `tests/unit/shell/sending-pill*.test.ts`,
`tests/integration/go-live/**` (new), `tests/integration/sending-m3/{settings-actions,connect*,health-warmup}.test.ts`
(updates only; G5 leaves the pre-go-live warm-up expectations unchanged).

**Builds:** §2.1 G1, G3 (words), G4–G12; §2.4 (blockers and recommendations, `loadGateInputs` additions incl. the live
test, freshness and `riskyAppFolder`, `goLiveBlockersFor`, `goLiveRecommendationsFor`); §2.5 (service with the
in-transaction re-read and the hand-set limit removal, action, card incl. the after-domain-change state, dialog incl.
drafts, notification, activity); §2.6 (`startWarmupAtGoLive`, the self-healing rule, `healthCountingSince` in its three
readers, `warmupLine` + `loadWarmupToday` on every screen that showed `warmupProgressText`); §2.7 (every P2 row;
`liveConfirmText(testList, goLive)`, `MODE_WORDS`/`MODE_OPTION_TEXTS` become functions of `goLive` or get an
`afterGoLive` variant; `modeWarnings`; `liveLaunchBlockers`' `goLive`; `modeLine({mode, practiceCopy, goLive})`;
`LaunchSummary.goLive/madeBeforeGoLive` and the Schedule checkbox; Verify's `testListOnly`; the pill's fallback);
§2.8's checklist part (`ChecklistFacts.accessOff`, the remote-access row) and G8 in `connect.ts`; the old-domain lines
on the "Check with Mailgun" card (`oldDomainLines`); the page's R1 precedence, "Milestone" removal and the §5.2
public-address sentence in its files.

**Provides:**
```ts
// src/server/services/go-live.ts
export class GoLiveError extends Error {}
export type GoLiveView = { practiceCopy: boolean; live: boolean; at: Date | null; byName: string | null; domain: string | null; endedOnDomain: string | null; blockers: string[]; recommendations: string[]; drafts: { items: { id: number; name: string; people: number }[]; more: number }; capOverrideToday: number | null; warmupLine: string | null };
export async function loadGoLiveView(now?: Date): Promise<GoLiveView>;
export async function goLive(actor: { id: number; name: string }, opts?: { now?: Date }): Promise<{ alreadyLive: boolean; at: Date; modeBefore: "DRY_RUN" | "TEST" | "LIVE" }>;
// src/server/services/sending/warmup-days.ts
export async function startWarmupAtGoLive(now: Date): Promise<WarmupState>;
export async function loadWarmupToday(now: Date): Promise<WarmupToday | null>;   // WarmupToday: contract, §7.8
// src/core/sending/health-since.ts
export function healthCountingSince(baselineSince: string | null, goLiveAt: string | null, practiceCopy: boolean): Date | null;
// src/core/sending/app-folder.ts
export function riskyAppFolder(appFolder: string, env: { USERPROFILE?: string; OneDrive?: string }): string | null;  // "Pictures", "OneDrive", …
// src/core/sending/mode-gates.ts
export function goLiveRecommendations(ctx: { rows: readonly ChecklistRow[]; checksTried: boolean; secondFolder: string | null; newestBackupAt: Date | null; accessOff: boolean; riskyFolder: string | null; restoreDone: boolean; now: Date }): string[];
// src/core/sending/go-live-copy.ts
export const GO_LIVE_COPY: { title; descriptionBefore; liveLine(at: string, by: string | null): string; cantSwitchOff; dialogTitle; dialogItems: string[]; confirmLabel; confirmButton; cancelButton; savingLabel; toast; alreadyLive; notificationTitle; notificationBody(name: string): string; activity(name: string): string; guideLine; practiceCopy };
// src/app/(app)/settings/sending/actions.ts
export async function goLiveAction(input: { confirm: true }): Promise<ActionResult<{ at: string; alreadyLive: boolean }>>;
```

**Consumes:** contracts; `getWorkerStatus`, `notifyUsers`, `logActivity`, `updateTyped`, `@/core/sending/capday`,
`warmupTable`, `isHealthyForWarmup`, `loadHealthCounts`, `restoreReportLines`, `catchUpStatusLine`, `oldDomainLines`.

**Tests:**
- unit: `goLiveBlockers` with every new input (order, sentences, the "needs attention" form for warn rows, `connected
  false` alone, Setup B, `liveTest` none/sent; absent inputs add nothing); `goLiveRecommendations` (each line and its
  condition; the restore line hidden once a restore was resumed); `riskyAppFolder` (Pictures, `OneDrive - Firma`,
  Dropbox, `C:\Outreach` → null); `healthCountingSince`; `loadWarmupToday` (a weekend day, low use, unhealthy); `liveLaunchBlockers` (empty list blocks only before go-live); `modeWarnings` (TEST warns after go-live,
  LIVE doesn't); `sendingLabel` with `goLive: true` × mode × `{live, test}` counts (G6; TEST with no live campaign
  stays "Test list only"); every §2.7 text before/after, `modeLine` with `goLive`, Verify's TEST text after go-live,
  the pill's `Status unavailable` fallback; the remote-access row with `accessOff` (ok with the note; degraded/version
  warnings still win after it; `accessOff` false unchanged).
- integration `tests/integration/go-live/switch.test.ts`: blockers refuse without any write; `goLiveAction` as a Member
  → "Only the Owner can do this." and nothing written; happy path writes `sending.goLive`, `sending.goLiveAt`,
  `sending.goLiveDomain`, `sending.mode = "LIVE"` (all with `updatedById` = the Owner) and removes today's
  `sending.capOverride` (activity data `capOverrideCleared`), one `sending.goLive` activity, one `sending.wentLive` per
  active user and none for a switched-off user, and the warm-up state of §2.6 (with a pre-go-live history and step 2
  before); a pause (or a test-list change) injected between `loadGateInputs` and the transaction → `Something changed
  while going live. Check the list again.` and nothing written; a second call → "You're already live.", nothing new;
  two calls at once → one activity; a failing `startWarmupAtGoLive` (injected) still leaves go-live on and logs, and the
  next `evaluateWarmupDays` restarts the ramp at the go-live day; `loadGoLiveView` in each state of the card table
  (practice copy, blockers, ready with drafts and an override, live with `byName` and the warm-up line, after a domain
  change with `endedOnDomain`).
- integration `tests/integration/go-live/gate-inputs.test.ts`: the live test (`delivered` only for a SENT LIVE row on
  the current domain to a current test-list address with a `delivered` event; `sent` without the event or with a
  permanent failure; `none` for DRY_RUN/TEST rows, another domain's campaign or an address no longer on the list);
  `checkFresh` (61 minutes old, `check.error`, checked before the Access choice changed); `workerRunning` (lease
  heartbeat fresh/stale); `accessOff`; `newestBackupAt`; `checksTried`; `restoreDone`; `capOverrideToday`.
- integration `tests/integration/go-live/domain-change.test.ts`: live on `send.example.com` → `connectMailgun` with
  `send2.example.com` (no active campaigns) → `sending.goLive` false in the same transaction, `goLiveDomain` kept, the
  activity data `goLiveEnded: true`, the message's go-live sentence; a new LIVE launch reaches only the test list;
  `goLive()` again after the new domain's checklist → live on send2.
- integration `tests/integration/go-live/health-since.test.ts`: a permanent bounce to a test mailbox before go-live is
  absent from `loadHealthView` and the health check after go-live; `sinceNote` = `Counting since you went live on …`.

**Done when:** tests pass; the Sending page has no "Milestone" text; the Go live card renders in all five states; no
screen calls `warmupProgressText` any more.

### P3 — Backups, restore and copy safety (wave 1)

**Owned paths:** `src/server/services/backups.ts` (beyond the step-C re-export), `src/core/backups/names.ts` (new),
`src/server/services/sending/{restore,pause}.ts` (pause: the `resumedAt` write only), `src/server/services/checks/tunnel.ts`
(the test-run guard only), `worker/{schedule,periodic,main,index}.ts`, `worker/jobs/{backup,cleanup}.ts`,
`scripts/vacuum-into.mjs` (new), `scripts/lib/{backups,restore-marker,service-acl,sqlite}.mjs` (sqlite: only if the
child script needs a helper), `scripts/{restore,service-acl,run-prod,start-demo}.mjs`, `scripts/install-services.ps1`
(the grant step, lines 170–213, only), `scripts/status.ps1`, `src/app/(app)/settings/backups/**`; tests
`tests/unit/worker/{schedule,backup-files}.test.ts`, `tests/unit/ops/{backups,restore-script,restore-marker,service-acl,run-prod}.test.ts`,
`tests/unit/backups-core/**` (new), `tests/integration/worker/{backups,periodic-cleanup,wake-gap}.test.ts`,
`tests/integration/sending-m3/restore-safety.test.ts`, the `resumeSending` test file (updates only),
`tests/integration/checks/tunnel*.test.ts` (the guard case), `tests/integration/backups/**` (new).

**Builds:** §3 in full: the vocabulary and listing (§3.2), per-kind retention, script-backup pruning and leftovers
(§3.3), the second-folder rules, marker, drive checks, save-then-grant, first copy on save, safe copies and the
service-acl split (§3.4), quiet time, the daily guarantee, the 30-hour overdue and the off-loop checked vacuum (§3.5),
`backupStatus` with disk space and the never/stale banner (§3.6), restore.bat labels, "›" and the five safety steps,
`resumedAt`, the Settings › Backups cards and texts, `lastRestoreView`, L8 (§3.7), the round trip and the other tests
(§3.8), L7, L15, L20, the `--backup` removal, the status.bat lines and the test-run public-address guard (§3.9).

**Provides:**
```ts
// src/server/services/backups.ts
export type BackupListKind = BackupKindValue | "PRE_MIGRATE";
export const BACKUP_KIND_LABELS: Record<BackupListKind, string>;
export type BackupListItem = { fileName: string; sizeBytes: number; createdAt: Date; kind: BackupListKind | null; copiedTo: string | null; source: "app" | "script" };
export async function listBackups(): Promise<BackupListItem[]>;
export type BackupStatus = { newest: { at: Date; kind: BackupListKind | null; fileName: string } | null; age: "ok" | "stale" | "never"; secondFolder: string | null; lastCopyFailed: boolean; workerRunning: boolean; freeBytes: number | null; dbBytes: number; diskLow: boolean };
export async function backupStatus(now?: Date): Promise<BackupStatus>;
export async function backupQuietNow(now: Date): Promise<boolean | null>;
export type FolderCheck = { ok: true; folder: string; warning: string | null } | { ok: false; error: string };
export const MANUAL_BACKUP_KEEP = 5;
export function driveTypeOf(letter: string): Promise<"remote" | "removable" | "fixed" | "unknown">;
// RunBackupOptions gains `vacuum?: (db: string, tmp: string) => Promise<{ ok: true; size: number } | { ok: false; error: string; check: string | null }>` (tests)
// src/core/backups/names.ts
export const SCRIPT_BACKUP_PATTERN: RegExp; export const SCRIPT_BACKUP_KEEP = 3; export const SCRIPT_BACKUP_MIN_AGE_DAYS = 14;
export function scriptBackupKind(name: string): "PRE_UPDATE" | "PRE_RESTORE" | "PRE_MIGRATE" | null;
export function scriptBackupDate(name: string): Date | null;
export function scriptBackupsToDelete(files: ReadonlyArray<{ name: string; mtimeMs: number }>, now: Date): string[];
// src/server/services/sending/restore.ts
export type LastRestoreView = { restoredLine: string; report: { text: string | null; risk: boolean; running: boolean; details: string[] }; resumeLine: string };
export async function lastRestoreView(zone: string, now: Date): Promise<LastRestoreView | null>;
// worker/schedule.ts
export function isBackupDue(now: Date, lastSuccess: Date | null, timeZone: string, quiet?: boolean | null): boolean;
```

**Consumes:** contracts (`backupAge`, `BACKUP_STALE_MS`, `restoreReportLines`, `InstanceState.host`), `loadDueStats`,
`isWindowOpen`, `parseWindow`, `getWorkerStatus`, `getSettings`, fake Mailgun helpers, the M3/M5 end-to-end test's
folder pattern.

**Tests:** §3.8's list (round trip, actions, run-backup, script backups, schedule, service-acl, wake-gap L7,
restore-safety L8, `resumedAt`, restore-script safety and labels from rows), plus: `backupQuietNow` with due rows in an
open and a closed zone, and a throwing loader → `null`; cleanup keeps `*.instance`, a manual-check-looking name and the
live database, deletes createTestDb and build-worker names older than a day; `checkSecondFolder` table (§3.4) on temp
folders with injected fs and `driveTypeOf`; `backupStatus` (never, stale, ok, copy-failed only after the setting's
`updatedAt`, practice copy never copy-failed, `diskLow` from an injected statfs); `run-prod` sets a loopback
`APP_PUBLIC_URL` for a test run; `checkPublicAddress` never fetches a non-loopback address in a test run.

**Done when:** tests pass (the existing `tests/unit/ops/restore-script.test.ts` cases included: cancel, swap + marker,
damaged backup, failed migration, not SQLite, not found); `node scripts/build-worker.mjs` still bundles (P10 re-runs its
self-test); `runBackup` never runs `VACUUM INTO` in the worker's process.

### P4 — The dashboard's building blocks and the old-domain state (wave 1)

**Owned paths:** `src/core/dashboard/{replies,pipeline}.ts` (new), `src/server/services/dashboard/{replies,pipeline,dry-run,unconfirmed,activity,mailgun}.ts`
(new), `src/server/services/mailgun/catch-up.ts`, `worker/jobs/mailgun-catch-up.ts` (summary wording only if needed),
`src/server/notifications.ts` (only `waitingReplyCount` and the new shared `waitingReplyWhere`),
`src/server/services/users.ts` (only its waiting-replies `where`, which switches to `waitingReplyWhere`),
`src/server/services/replies/waiting.ts` (its `waitingWhere` built on `waitingReplyWhere`, and the `take` option of
`listWaitingReplies`); tests `tests/unit/dashboard-core/**`, `tests/integration/dashboard-data/**`,
`tests/integration/catch-up/old-domains.test.ts` (new), `tests/integration/catch-up/catch-up.test.ts` and the waiting
list's tests (updates only).

**Builds:** §4.3's data definitions (pipeline counts, reply rate, dry-run numbers, the waiting-replies rule and line,
the viewer's list with `take` (§4.2a), unconfirmed emails, team activity without per-email rows, `mailgunConfigured`)
and L10 (§7.2, §7.3): after each catch-up run, each non-gone old-domain problem is kept with the
`since` of an existing entry for that domain (else now) and `lastAt = now`; domains checked fine this run, gone
domains and domains no longer synced are dropped; once `now − since ≥ 24 h`, `shouldSendNotice("catchup-old-domain")`
then the Owner notice of §7.3.

**Provides:**
```ts
// src/server/notifications.ts
export function waitingReplyWhere(extra?: Prisma.InboundMessageWhereInput): Prisma.InboundMessageWhereInput;  // the M4 rule
// src/core/dashboard/replies.ts
export type WaitingByUser = { userId: number; name: string; count: number };
export function waitingRepliesLine(rows: readonly WaitingByUser[], viewerId: number): string | null;
// src/core/dashboard/pipeline.ts
export type ReplyRate = { replied: number; emailed: number; last30: { replied: number; emailed: number } };
export function percentText(part: number, whole: number): string | null;   // "20%", "4.5%", "0%"; null when whole is 0
export function replyRateText(r: ReplyRate): string;
export function replyRate30Text(r: ReplyRate): string | null;
// src/server/services/dashboard/replies.ts
export async function waitingReplyCountsByUser(): Promise<WaitingByUser[]>;
// src/server/services/dashboard/pipeline.ts
export type PipelineView = { counts: StatusCounts; replyRate: ReplyRate };
export async function loadPipeline(now: Date): Promise<PipelineView>;
// src/server/services/dashboard/dry-run.ts
export type DryRunSummary = { today: { dryRun: number; testMode: number }; running: { dryRun: number; testMode: number }; waitingReplies: number };
export async function loadDryRunSummary(now: Date): Promise<DryRunSummary | null>;
export function dryRunLines(s: DryRunSummary): string[];   // §4.3 lines, zero parts left out
// src/server/services/dashboard/unconfirmed.ts
export async function unconfirmedEmails(): Promise<{ count: number; firstCampaignId: number | null }>;
// src/server/services/dashboard/activity.ts
export type TeamActivityRow = { id: number; at: string; summary: string; actorName: string | null; mode: "DRY_RUN" | "TEST" | "LIVE" | null };
export async function recentTeamActivity(now: Date, take?: number): Promise<TeamActivityRow[]>;   // §4.3: take ≤ 10, no count, no "email.*"
// src/server/services/dashboard/mailgun.ts
export async function mailgunConfigured(): Promise<boolean>;   // real data, domain set, Secret "mailgun.apiKey" row exists; no decryption, no write
// src/server/services/replies/waiting.ts
// listWaitingReplies(viewer, { scope, page?, now?, take? })  — take ≤ 50, default WAITING_PAGE_SIZE
```

**Consumes:** contracts (`OldDomainProblemState`, parsers), `countCompaniesByStatus`, `@/core/sending/capday`,
`WAITING_KINDS`, `shouldSendNotice`, `createNotification`/the Owner notice helper the catch-up already uses.

**Tests:** line formats (`You 3 · Ali 1`, viewer with 0 left out, 5 users → `· 1 more person`/`· 2 more people`,
total 0 → null); `percentText` (1/5 → 20%, 9/200 → 4.5%, 0/5 → 0%, x/0 → null); integration: waiting counts exclude
unprocessed, answered, dry-run scope and switched-off assignees, and `waitingReplyCount(userId)` equals the dashboard
count for that user; reply rate excludes deleted companies and imported-only contacts, last 30 days by
`firstContactedAt`; dry-run numbers by the Karachi cap day across UTC midnight, practice copy → null, all zero → null;
unconfirmed count and first campaign; team activity (8 newest non-`email.*` rows within 30 days, with 500 newer
`email.sent` rows in the way); `mailgunConfigured` (no key row → false; `getSecret` spied and never called); the
viewer's list with `take: 5`; old domains (kept with `since`, updated `lastAt`, cleared on success, one notice after
24 h, none twice within 24 h).

**Done when:** tests pass; the Team page's waiting counts (users.ts) and the bell use `waitingReplyWhere`.

### P5 — Settings polish, the rule settings and the Access switch (wave 1)

**Owned paths:** `src/app/(app)/settings/{profile,notifications,domain,limits,deliverability,footer,ai,team,system}/**`,
`src/components/settings/**` except `src/components/settings/sending/**` and `src/components/settings/types.ts` (P2),
`src/server/services/settings/rules.ts` (new);
tests `tests/unit/settings-polish/**` (new), `tests/unit/settings/**` (updates, e.g. `deliverability-primary.test.ts`
for R1), `tests/unit/setup-core/ui.test.ts` (only if it must change; the order doesn't),
`tests/unit/team/worker-status-text.test.ts`, `tests/unit/checks/remote-access.test.ts`,
`tests/integration/settings-rules/**` (new), `tests/integration/security/owner-actions.test.ts` (new).

**Builds:** §5.1 R1–R10 on its pages, §5.2's rows for its pages and the public-address sentence in its files, §5.3
(card with `Now N days.`, service with the impact confirmation and one transaction, action, confirm dialog), §2.8's P5
part (the Access switch, `saveAccessChoiceAction` in `settings/system/actions.ts`, the card's sentence), §2.6's Limits
wording with `warmupLine(step, table, null)` (contract), `HealthCard`'s `compact` prop (numbers and strings only),
`workerDownText(status, now, timeZone)` in `components/settings/worker-status-text.ts` (§4.2 item 2 wording; the
existing `workerStatusText` stays for Settings › System), §5.4's sweep over every `"use server"` file.

**Provides:**
```ts
// src/components/settings/worker-status-text.ts
export function workerDownText(status: { running: boolean; lastSeen: Date | null }, now: Date, timeZone: string): string | null;  // null when running
// src/components/settings/deliverability/health-card.tsx
export function HealthCard(props: { bounce: …; complaint: …; sinceNote: string | null; compact?: boolean }): JSX.Element;
// src/server/services/settings/rules.ts
export type RulesView = { teamRuleDays: number; pausedExpiryDays: number; sharedDomains: string[]; builtIn: string[] };
export async function loadRulesView(): Promise<RulesView>;
export async function saveRules(
  actor: { id: number; name: string },
  input: { teamRuleDays: number; pausedExpiryDays: number; sharedDomains: string },
  opts?: { confirmed?: boolean; now?: Date },
): Promise<{ message: string; needsConfirm?: { lines: string[] }; fieldErrors?: Record<string, string[]> }>;
// actions
export async function saveRulesAction(input: { teamRuleDays: number; pausedExpiryDays: number; sharedDomains: string; confirmed?: boolean }): Promise<ActionResult<{ needsConfirm?: { lines: string[] } }>>;   // settings/limits/actions.ts
export async function saveAccessChoiceAction(input: { accessOff: boolean }): Promise<ActionResult>;  // settings/system/actions.ts
```

**Consumes:** contracts (`remoteAccess.accessOff`), `@/core/shared-domains` (the built-in list), `tldts`, `enqueueJob`,
existing settings services.

**Tests:** rules validation table (§5.3 errors, line numbers, duplicates of built-ins dropped, 200 lines), activity per
changed key only, no activity when nothing changed; each confirmation line (lowered below 30; raised with a company a
teammate emailed 40 days ago in a running campaign; a shared domain used by 2 companies; a shorter expiry releasing a
paused campaign) returned without any write, then written together with `confirmed`; a failure inside the transaction
leaves every key unchanged; `saveAccessChoiceAction` (Owner only, activity, queued domain check with its dedupe key);
`workerDownText` (today → time only, another day → date and time, never seen, running → null); the sweep of §5.4
(including `check-actions.ts` and `resumeAiAction`, and the allowlist check).

**Done when:** tests pass; every settings page of the package matches §5.1 (the lead verifies visually in step S).

### P6 — Docs, script texts and in-app help references (wave 2)

**Owned paths:** `README.md`, `docs/setup/**` (incl. new `4-going-live.md`), `docs/dev/README.md` (new),
`restore.bat`, `reset-password.bat`, `setup.bat`, `start.bat`, `start-demo.bat`, `update.bat`, `stop.bat`,
`scripts/update.mjs` (line 127 only), `scripts/setup.mjs` (line 218 only), `scripts/install-services.ps1` (lines 28,
34 only), `scripts/lib/node-check.mjs` (messages only), `scripts/reset-password.ts` (the one sentence);
tests `tests/unit/docs/**` (new), `tests/unit/ops/node-check.test.ts` and `tests/unit/ops/script-files.test.ts`
(updates only).

**Builds:** §6 in full, from this design's copy and the wave-1 code.

**Tests:** `tests/unit/docs/guide-refs.test.ts` (§6.7); `tests/unit/docs/readme-topics.test.ts`: the README has these
exact headings for the SPEC topics: "Install and first run", "Mailgun, DNS and reply routes", "Tracking off,
unsubscribe on", "Cloudflare Tunnel and optional Access", "Your team", "When the PC is off, and keeping it awake",
"Backups and restore"; and none of "Milestone", `\bQ(8|9|1[0-4])\b`, "I'll", "until I", "tell me" in README.md and
`docs/setup/*.md` (a bare " I " is allowed: guide 4 quotes the dialog's "I understand that…"); the README names
`uninstall-services.bat`, "Private networks", "2026.8.0", "Node 26" and "quarantin"; node-check messages name
`latest-v24.x`; `.bat` files keep CRLF.

**Done when:** tests pass; every quoted label is copied from §2–§5 or from `src/`.

### P7 — The dashboard, "Get started" and the landing page (wave 2)

**Owned paths:** `src/app/(app)/dashboard/**` (incl. `load.ts`), `src/app/(app)/page.tsx`, `src/components/dashboard/**`
(new), `src/core/dashboard/attention.ts` (new), `src/components/contacts/get-started.tsx` (delete), `src/components/contacts/notice-toast.tsx` (move to
`src/components/shell/notice-toast.tsx`), `src/app/(app)/contacts/page.tsx`, `src/app/(auth)/{actions.ts,login/page.tsx,reset/actions.ts,invite/actions.ts}`,
`src/lib/auth/dal.ts`, `src/components/error-copy.ts`, `src/components/shell/sidebar.tsx`,
`src/components/page-header.tsx`; tests `tests/unit/dashboard/**` (new), `tests/unit/core/app-screens.test.ts`,
`tests/unit/contacts/get-started.test.ts` (moved to `tests/unit/dashboard/get-started.test.ts`),
`tests/integration/dashboard/**` (new), `tests/unit/dashboard/landing.test.ts` (new: the redirects).

**Builds:** §4 in full (layout, attention items, the replies list, tiles, Get started, landing switch, loading,
refresh, types).

**Provides:** `attentionItems(facts, viewer, now)`, `loadDashboard(viewer, now)` (`src/app/(app)/dashboard/load.ts`),
`DashboardView`, the page, and a pure view component `DashboardScreen({view, viewer, now})`
(`src/components/dashboard/dashboard-screen.tsx`) that the page and the render tests use.

**Consumes:** P2 (`GO_LIVE_COPY`, `loadWarmupToday`, `healthCountingSince` through `loadHealthView`), P3
(`backupStatus`, `BACKUP_KIND_LABELS`), P4 (all of its exports, incl. `listWaitingReplies` with `take`,
`recentTeamActivity`, `mailgunConfigured`), P5 (`workerDownText`, `HealthCard compact`), contracts (`catchUpFailing`,
`catchUpStatusLine`, `oldDomainLines`, `warmupLine`, `restoreHoldActive` existing), existing loaders of m6-code-map §4
(`getTodayCap`, `loadHealthView`, `listCampaigns`, `countCampaignsByTab`, `toCampaignListView`, `pausedText`,
`aiQueueCounts`, `outageHoldSummary`, `getPauseState`, `getChecksPause`, `getAiPause`, `getWorkerStatus`,
`remoteAccessView`, `readTyped` + parsers, `warmupTable`, `LiveRefresh`, `ProgressBar`, `mailgunStep`, the reply card
and its actions). Never `getMailgunContext`, `loadGateInputs` or `loadGoLiveView`.

**Tests:** `attentionItems` for every key (condition, exact text, tone, Owner link vs Member text, order, the 15 cap,
a failed source dropping only its item); `DashboardScreen` rendered with `renderToStaticMarkup` for the states empty
(Owner and Member), busy (every item and the replies list with its actions), before go-live, live, after a domain
change, practice copy: headings, empty texts, at most one `[data-slot="button"][data-variant="default"]` (the Get
started link), no "Milestone"; `loadDashboard` on a seeded integration database (counts of §4.3, a throwing loader →
that tile `null`; `getMailgunContext` and `dbWrite` mocked to throw and `loadDashboard` still succeeds; props passed to
client tiles are plain; under 1 s at the §4.6 volumes); redirects (`/` → `/dashboard`, login, setup, invite, reset,
`requireOwner` → `/dashboard?notice=owner-only`).

**Done when:** tests pass; `ComingLater` and "Dashboard arrives in Milestone 6" are gone; nothing links to
`/contacts?welcome=1`.

### P8 — The M6 end-to-end tests (wave 2)

**Owned paths:** `tests/integration/milestone6/**` (new).

**Builds:** §9.3 Parts A and B.

**Consumes:** wave-1 exports only (§0.2 rule 2): P1's final rule and launch flag, P2 (`goLiveAction`, `loadGoLiveView`,
`startWarmupAtGoLive`'s state, `loadWarmupToday`), P3 (`runBackup`, `backupStatus`), P4 (`loadPipeline`,
`waitingReplyCountsByUser`, `waitingRepliesLine`, `replyRateText`, `replyRate30Text`, `loadDryRunSummary`,
`recentTeamActivity`, `listWaitingReplies`), contracts (`warmupLine`), existing loaders (`getTodayCap`,
`loadHealthView`, `listCampaigns`, `aiQueueCounts`), the M3/M4/M5 helpers (`createTestDb`, `connectFakeMailgun`,
`connectFakeClaude`, `checklistRows`, `signedEventRequest`, `replyTo`, `makeCompany`, `setSettingValue`), the worker
(`BackgroundWorker`, lanes), the `@/lib/auth/dal` mock pattern for actions. **Every server-action call runs with `Date`
faked to the test clock** (`vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(clock.now())`, then
`vi.useRealTimers()`), because actions read `new Date()` while the worker lease, the checklist's `checkedAt` and the
expected `goLiveAt` follow the fixed clock. If faking `Date` disturbs Prisma, the happy paths call the services with
`{now}` (`goLive(actor, {now})`, `resumeSending({…, now})`) and the actions are used only for the refusals, which don't
depend on the time. The assertions on P7's `loadDashboard` view and `attentionItems` (marked **P10** in §9.3) are
appended to the same two files by P10, because P7 is a wave-2 peer.

**Done when:** both parts pass in `npx vitest run tests/integration/milestone6` on a fixed clock with nothing reaching
the network.

### P9 — Screen checks: Playwright + axe suite and the M6 seed script (wave 2)

**Owned paths:** `playwright.config.ts` (new), `tests/playwright/**` (new), `scripts/seed-m6-manual.ts` (new).

**Builds:** §9.4 (config, helpers, specs incl. `auth.spec.ts`, the four seeded states). The package writes and
type-checks the suite (`npx tsc --noEmit` covers `playwright.config.ts` and `tests/playwright/**`; vitest already
excludes that folder) and runs the seed script to prove it creates the four databases; it doesn't run the suite (the
lead does in step S).

**Done when:** the seed script creates `data/manual-check/m6-{empty,busy,ready,live}.db` from scratch
(`node --import tsx scripts/seed-m6-manual.ts --state all`), refuses any path outside `data\manual-check\`, asserts
every seeded email address is on `example.com` or a `*.example` domain (so no instance can email a real person even if
a fake is missing), and the suite type-checks and lints.

### P10 — Integration (after wave 2, one agent)

**Owned paths:** `src/server/activity.ts` and `src/server/notifications.ts` (doc comments only), `src/core/notification-types.ts`
(only if `sending.wentLive` needs a pop-up group: it doesn't), `src/components/activity/activity-filters.ts` (only if
`sending.goLive` doesn't already fall under the sending filter), `scripts/seed-m5-manual.ts` (go-live written as the
rows `goLive()` would write: `sending.goLive`, `sending.goLiveAt`, `sending.goLiveDomain`, `sending.mode`, the activity;
§0.2 rule 6), `tests/integration/milestone{2,3,4,5}/**` and any other test that still fails after wave 2 (updates
only), `tests/integration/milestone6/**` (appending the lines marked **P10** in §9.3), `tests/unit/worker/packages.test.ts` (comment), `tests/unit/core/no-milestone-text.test.ts` (new),
`src/core/sending/warmup.ts` and its test (only removing `warmupProgressText`),
`docs/dev/CONVENTIONS.md`, `PLAN.md` (header note, A1 cost line and B7 row only), `docs/dev/M3-DESIGN.md`, `docs/dev/M4-DESIGN.md`
(header line; M3 §4.3.7), and label fixes in README/guides where the final screens differ.

**Builds:**
- The **P10** assertions of §9.3 (P7's `loadDashboard` and `attentionItems` in both end-to-end files).
- Doc lists: activity `sending.goLive` and the new `settings.updated` keys; notification `sending.wentLive`; notice key
  `catchup-old-domain`.
- `tests/unit/core/no-milestone-text.test.ts`: no `/Milestone \d/` in what a user can see. For `src/**/*.{ts,tsx}` and
  `scripts/**/*.{ts,mjs}` it collects string literals, template literal parts and JSX text with the TypeScript
  scanner/parser (`typescript` is already a dev dependency) and ignores comments (about 68 comment mentions in 45
  files stay as history); for `scripts/**/*.ps1` it reads non-comment lines; `*.bat`, `README.md` and
  `docs/setup/**` are scanned in full.
- CONVENTIONS "M6: go-live, dashboard and backups rules": §0.2 rules 6–9, 12 and 13; "emailed" and "test-list only"
  per campaign, `emailedSendWhere` and the guard's `testListOnly`; the two go-live doors; the dashboard reads only;
  backup writers/deleters and the child-process vacuum; the
  settings rules R1–R10; the manual-check seeds and how the lead runs the Playwright suite; the package list
  (+ htmlparser2 10.1.0, encoding-sniffer 0.2.1, and the M5 packages: @anthropic-ai/sdk 0.128.0, cheerio 1.2.0,
  undici 7.30.0, robots-parser 3.0.1, ipaddr.js 2.5.0, L23); `ComingLater` removed from the helper list.
- PLAN.md: a first line under the title `Build plan, kept for reference. The README is the manual; where they differ,
  the README and the M3–M6 design files win.`; B7 `GET /api/campaigns/:id/progress` marked "not built (pages refresh
  with router.refresh)"; A1's "5,000 address checks included" marked "wrong: Foundation includes none; see the
  README's costs".
- Remove `warmupProgressText` if nothing but its own test uses it after wave 2 (§2.6).
- M3-DESIGN and M4-DESIGN: a line under the title `The code and its tests win over this file; review fixes are named in
  the test headers (CRASH-*, SEQ-*, EVENTS-*).`; M3 §4.3.7 gains the `.instance` note and the host check (L22).
- Re-check every bold label in README and guides against `src/` (docs audit §8 step 5) and fix mismatches.
- `npm run check`; `node scripts/build-worker.mjs` (self-test "packages ok").

**Done when:** `npm run check` passes; the worker bundles; the lead's step S can start.

### Step S — Screen checks and the restore rehearsal (lead, after P10)

§9.4 (running the suite) and §9.5 (manual checks).

---

## 9. Tests

### 9.1 SPEC and PLAN coverage map

| Required | Where |
|---|---|
| SPEC: template rendering, import matching and duplicates, 30-day rule, follow-ups and stop rules, window/cap/warm-up/health, webhook signatures, reply matching and auto-replies | existing M1–M5 suites (unchanged; P10 keeps them green); the 30-day rule gains P1's go-live cases |
| SPEC: type-check, lint, tests pass | P10 `npm run check` |
| SPEC: builds in production mode on Windows | lead, step S (`next build`, `node scripts/build-worker.mjs`) |
| SPEC E2E steps 1–5 in dry-run mode (incl. dashboard numbers) | P8 Part A (§9.3) |
| B12 E2E step 6 "the notifications each user received, and the dashboard tiles (pipeline counts, reply rate, sent today, bounce and complaint rates)" | P8 Part A step 7 |
| B12 "Owner-only actions refused for Members" (one test) | P5 `owner-actions.test.ts` |
| B12 auth coverage | existing `tests/unit/security/auth-coverage.test.ts` (new action exports are covered automatically) |
| B12 "the restore scenario (no second send)" | existing M3 tests + P3 round trip step 10 |
| B12 screen checks (Playwright + axe) | P9 suite, run by the lead (§9.4) |
| A8 M6 "a backup and a restore" | P3 round trip; lead rehearsal (§9.5); guide 4 step 5 |
| A8 M6 go-live | P2 switch, gate-input, domain-change and health tests; P8 Part B |
| B12 "a dry-run campaign is never sent after switching to live" | P8 Part B steps 2, 7 and 11 (a DRY_RUN and a TEST campaign running across the flip) |
| B6.5 "dashboard: dry run shown separately" | P4 dry-run tests; P7 render test; Playwright live state |
| B6.14 "dashboard warns when the last backup is more than 36 h old" | P3 `backupStatus`; P7 attention test; Playwright busy state |
| SPEC §13 "daily" backups | P3 schedule test (a weekday without a quiet hour still gets one backup) |

### 9.2 Existing tests that change

| Test | Change | Owner |
|---|---|---|
| `tests/unit/rules/mode.test.ts` | `launchedGoLive` instead of `goLive`; `testListOnly`; `emailedModes` cases removed | P1 |
| `tests/unit/replies-core/kind.test.ts` | the `launchedGoLive` input | P1 |
| `tests/unit/mailgun-client/send-guard.test.ts` | Test mode after go-live refused for non-test-list | P1 |
| `tests/unit/rules/eligibility.test.ts` | TEST after go-live cases | P1 |
| `tests/integration/sequences/team-rule.test.ts:74-76`, `company-panel/who-emailed-m4.test.ts`, `replies/scopes.test.ts`, `sending-m3/modes.test.ts`, `sending-m3/launch-control.test.ts`, `campaigns/launch-guard.test.ts`, `rules/eligibility*.test.ts`, `sending/query-plans.test.ts` | launch after setting go-live where a test expects "emailed"; query-plan expectations with the join | P1 |
| `tests/unit/mailgun-client/transport*.test.ts` | `testListOnly` on campaign sends | P1 |
| `tests/unit/sending-core/label.test.ts:90-102` | kept (G6 makes it true); cases added | P2 |
| `tests/unit/sending-core/mode-gates.test.ts` | new inputs and rules (warn-row sentence, Setup A, connect, freshness, live test) | P2 |
| `tests/integration/sending-m3/settings-actions.test.ts` | mode words after go-live; `goLiveAction` | P2 |
| `tests/integration/sending-m3/connect*.test.ts` | a domain change after go-live ends it | P2 |
| `tests/integration/sending-m3/health-warmup.test.ts` | pre-go-live expectations unchanged; `evaluateWarmupDays` now passes `healthCountingSince` (same result before go-live) | P2 |
| `tests/unit/campaign-wizard/**`, `tests/unit/checks/verify-model*.test.ts` | `modeLine` with `goLive`; Verify's `testListOnly` | P2 |
| `tests/unit/worker/schedule.test.ts` | the `quiet` argument; 12 h minimum; the 20:00 guarantee; 30 h | P3 |
| `tests/unit/worker/backup-files.test.ts`, `tests/integration/worker/backups.test.ts` | labels; script backups listed; practice copy doesn't copy; per-kind retention; the child-process vacuum (injected in unit tests) | P3 |
| `tests/unit/ops/backups.test.ts`, `restore-script.test.ts`, `service-acl` tests | labels from rows; "›"; restore safety; the second folder granted separately | P3 |
| `tests/integration/worker/periodic-cleanup.test.ts` | the narrower test-file rule (L15) | P3 |
| `tests/integration/worker/wake-gap.test.ts`, `sending-m3/restore-safety.test.ts` | L7, L8 cases | P3 |
| `tests/integration/catch-up/catch-up.test.ts` | `oldDomains` kept in the state | P4 |
| `tests/unit/team/worker-status-text.test.ts`, `tests/unit/checks/remote-access.test.ts` | `workerDownText`; the Access-off sentence | P5 |
| `tests/unit/core/app-screens.test.ts:56-60` | `ComingLater` test removed; `MOBILE_NAV` kept | P7 |
| `tests/unit/contacts/get-started.test.ts` | moved to `tests/unit/dashboard/get-started.test.ts` | P7 |
| `tests/unit/ops/node-check.test.ts`, `script-files.test.ts` | the 24.x route in messages | P6 |
| `tests/integration/milestone{2,3,4,5}/end-to-end.test.ts` | M5 Part B sets go-live before launching (keep); any test that reads the landing page or "(test list)" after flipping go-live follows §2.2 | P10 |
| `tests/unit/worker/packages.test.ts:60-62` | comment: direct dependencies | P10 |

### 9.3 The M6 end-to-end tests (P8; the lines marked P10 are appended in integration)

Both files run on their own database in a folder of their own (the M5 pattern, so `RESTORED` is theirs), on a fixed
clock starting **Wednesday 23 Sep 2026 10:00 Berlin**, with nothing reaching the network. Both hold the worker lease at
the test clock (`worker/lease.ts`) before reading the dashboard or calling go-live, so `worker-down` doesn't appear and
the worker blocker is met, and seed `tunnel.status` as connected with a passing public check (M3 helpers), so
`tunnel-down` doesn't appear. Every server-action call fakes `Date` to the test clock (§8 P8). Attention-key
assertions leave out `disk-low` (it depends on the test machine's free space).

**Part A — SPEC definition of done in dry-run mode** (`tests/integration/milestone6/spec-dry-run.test.ts`). Users
Arslan (Owner) and Ali (Member). Steps 1–2 on real-data settings (`practice.copy = false`, the fake Claude and the
fixture reader injected with `WorkerOptions.ai`, exactly as M5 Part A); from step 3 the M4 Part A configuration
(`practice.copy = true`, the M3 helper's webhook signing key).

1. **Import a CSV**: `tests/fixtures/import/m5-companies.csv` through the pipeline (upload, suggested mapping, analyse,
   commit job) → 5 companies (Figuren Werkstatt anna@, Butikk AS ola@, Grid Shop info@, Parked Co pat@, Insta Creator
   ivy@), each Not contacted. `loadPipeline(now)`: `NOT_CONTACTED 5`, total 5; `replyRateText` = `No companies
   emailed yet.`; the missing-email count is 0. **P10:** `loadDashboard(Arslan)` has no `missing-emails` item.
2. **Draft and approve personal lines (mocked AI)**: Ali's `startDraftRun` for all five → READY ×3, NO_LINE ×1 (Parked),
   Insta skipped; `aiQueueCounts().waiting` = 3 (**P10:** the `ai-lines` item `3 AI lines to review` for both users).
   Approve Figuren's, edit then approve Butikk's, reject Grid's + undo + approve → three `personalLine` source `ai`;
   waiting 0 (**P10:** item gone).
3. **Create a campaign with 2 follow-ups, review it**: `practice.copy = true`; Ali's dry-run campaign to all five people
   with 2 follow-ups (days as minutes, ignore sending hours), through the draft services; the **Review step's
   services** (as the M2 end-to-end test uses them): every recipient has 3 steps; the "missing details" filter is empty
   (`No emails are missing details. You can go on to Schedule.`); edit Butikk AS's first email for that person only →
   the "edited" filter shows 1; launch.
4. **Send it**: tick → 5 first emails in the outbox; Butikk's is the edited text; the three approved lines follow the
   greeting; no empty line where Parked's and Insta's line would be. Numbers: `listCampaigns("running")` has the
   campaign with progress `First email 5 of 5 sent` (`toCampaignListView`); `getTodayCap(now, {practiceCopy: true}).used`
   = 5 + `testSends`; pipeline `CONTACTED 5`; `Reply rate: 0% (0 of 5 companies you emailed replied)`.
5. **Simulate a bounce, an unsubscribe and a reply with signed test webhooks** (M3/M4 helpers): a signed bounce for
   Parked's first email (pat@), a signed unsubscribe for Grid's (info@), a signed inbound reply from anna@ to Figuren's
   first email; process them (event lane + `processPendingInbound`).
6. Advance the clock and tick through both follow-ups; run the finish check → follow-ups only to Butikk AS and Insta
   Creator (2 + 2), the campaign finishes.
7. **Confirm statuses, stop rules, notifications and dashboard numbers**:
   - companies: Figuren **Replied**; Butikk, Grid, Parked, Insta **Contacted**; people: pat `bouncedAt`, info
     `unsubscribedAt`, anna `repliedAt`; suppressions as in M4 Part A;
   - recipients: Parked stopped (bounced), Grid stopped (unsubscribed), Figuren stopped (replied); Butikk and Insta
     finished after step 2; outbox 9 emails (5 + 2 + 2); no follow-up to pat, info or anna;
   - notifications, the exact multiset per user: **Ali** `ai.draftsReady`, `reply.received`, `campaign.finished`;
     **Arslan** none. If the running code differs, compare with M4-DESIGN §5.1 and M5-DESIGN §3.10 and report it; never
     adjust the expectation silently;
   - dashboard numbers (the tiles' sources): pipeline `{NOT_CONTACTED 0, CONTACTED 4, REPLIED 1, CLIENT 0,
     NOT_INTERESTED 0, DO_NOT_CONTACT 0}`, total 5; `Reply rate: 20% (1 of 5 companies you emailed replied)` and `Last
     30 days: 20% (1 of 5)`; sent today `used` = 9 + `testSends`, `cap` = 50, `warmupLine(0, table,
     loadWarmupToday(now))` = `Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday with at least half the
     limit used and healthy numbers.` (the practice copy's ramp; 9 of 50 is below half); `loadHealthView`: bounces 1 of
     a sample of 9, complaints 0 of 9; no running or scheduled campaign; `recentTeamActivity(now, 8)` includes
     `campaign.finished` and no `email.*` row; `loadDryRunSummary` null (practice copy);
     `waitingRepliesLine(waitingReplyCountsByUser(), Arslan)` = `Replies waiting for an answer: Ali 1`, and for Ali
     `… You 1`; `listWaitingReplies(Ali, {scope: "mine", take: 5})` has anna's reply. Ali clicks **Answered** on anna's
     reply → the line is `null` and Ali's list is empty.
   - **P10:** the same numbers through `loadDashboard` for Arslan and Ali (`today`, `pipeline`, `health`, `campaigns`
     empty with `No campaigns are sending right now.`, `dryRun` null, `replies.total` 1 for Ali and 0 for Arslan), and
     the attention keys exactly `["replies-waiting", "backup-never"]` before **Answered** and `["backup-never"]` after.

**Part B — go live against the fake Mailgun** (`tests/integration/milestone6/go-live.test.ts`). Real-data settings
(`practice.copy = false`), `connectFakeMailgun` for domain `send.example.com`, the checklist rows "ok"
(`checklistRows`, `checkedAt` = the clock, so the freshness blocker is met until 11:00), the reply test passed on the
domain with **Setup A**, Arslan's sending address with route "ok", test list `["tess@test-mailbox.example"]` (company
"Test mailboxes", person Tess), prospects Firma GmbH `anna@firma.example` and Studio Nord `ola@nord.example` (both
Germany, VALID by `mailgun-fake` 10 days ago: fresh, D10), users Arslan, Ali and Bo (switched off), a backup made first
(`runBackup`), so the only possible attention items are the ones asserted. Before any go-live, in Dry run mode: a
DRY_RUN campaign "Rehearsal" to Firma and Studio Nord with 2 follow-ups (1 and 2 days) launched and ticked once (2
outbox emails), and a draft "Made early" with Studio Nord (created now, not launched).

1. **Before go-live**: `loadGoLiveView()` blockers = exactly `["Send one live campaign to your test list first, and check
   that it arrived (Going-live guide, step 3)."]`; `goLiveAction({confirm: true})` as Arslan → refused with that
   sentence; `sending.goLive` still false, no activity.
2. `setSendingModeAction({mode: "TEST"})`; campaign "Mailgun test" to Tess (first email only) launched in TEST;
   `setSendingModeAction({mode: "LIVE"})`; campaign "Test run" to Tess with 2 follow-ups (after 1 and 2 days); launch
   (`launchedGoLive` false); tick inside Berlin's window → the fake has 2 messages to tess (one with `o:testmode=yes`),
   none from "Rehearsal". Company "Test mailboxes": `NOT_CONTACTED`, `lastEmailedAt` null, no reservation. Blockers now
   exactly `["The live test email hasn't been confirmed as delivered yet. Wait a few minutes, then open this page
   again."]`; a signed `delivered` event for Tess's LIVE email (M3 helper) → blockers `[]`; `loadGoLiveView().drafts`
   lists "Made early" (1 person).
3. A LIVE draft "Too early" with Firma: Anna is left out with `Not on the test list (until you go live, only test-list
   addresses get real email)`; `checkSendGuard({to: "anna@firma.example", purpose: "campaign", guard: {goLive: false,
   testList}})` throws `Stopped by the test-list guard: anna@firma.example isn't on your test list.`
4. **Go live** (10:30): `goLiveAction` as Ali → `Only the Owner can do this.`, nothing written. As Arslan → message
   `You're live. New campaigns now email everyone eligible, and warm-up has started.`; settings `sending.goLive` true,
   `sending.goLiveAt` = the clock, `sending.goLiveDomain` `send.example.com`, `sending.mode` LIVE; one `sending.goLive`
   activity `Arslan went live on send.example.com`; `sending.wentLive` for Arslan and Ali, none for Bo; warm-up
   `{step: 0, startedCapDay: "2026-09-23", lastEvaluatedCapDay: "2026-09-22", history: []}`;
   `getSendingLabel().label.text` = `Sending live`; a second `goLiveAction` → `You're already live.` and still one
   activity.
5. **A live campaign to a non-test address is allowed and sent**: re-open "Too early": Anna is eligible; launch
   (`launchedGoLive` true; created before go-live, so the launch passes `confirmMadeBeforeGoLive: true`); tick past the
   pacing gap → the fake has 3 messages, the newest to anna, carrying no `o:testmode`. Firma: `CONTACTED`,
   `lastEmailedAt` set, first contacted by Arslan; an active reservation; a new draft with Firma leaves it out (the
   30-day rule's reason text).
6. Numbers, same day: `getTodayCap(now).used` = 2 + `testSends` (Tess's LIVE and anna's; TEST isn't counted), cap 50,
   `warmupLine(0, table, loadWarmupToday(now))` = `Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday
   with at least half the limit used and healthy numbers.`; pipeline `NOT_CONTACTED 2` (Test mailboxes, Studio Nord),
   `CONTACTED 1`; `Reply rate: 0% (0 of 1 company you emailed replied)`; `backupStatus().age` = `ok`;
   `loadHealthView` sample 1 (Tess's pre-go-live send isn't counted, G12). **P10:** `loadDashboard(Arslan)`: the same
   numbers, `getStarted` null (live), attention keys exactly `["second-folder-missing"]` (no second folder in this
   test); `loadDashboard(Ali)`: attention empty (`Nothing needs your attention right now.`).
7. Advance 1 day into the window and tick → "Test run"'s first follow-up goes to Tess; "Rehearsal"'s first follow-ups
   go to the outbox only (the fake gets none of them); "Test mailboxes" still `NOT_CONTACTED` with `lastEmailedAt` null;
   `companySequences` ends with ` (test list)`; a new LIVE draft with Test mailboxes: Tess isn't left out by the 30-day
   rule (her note is the "address not checked yet" pending note: campaigns launched after go-live don't treat the test
   list as checked).
8. **Test mode stays test-list-only**: `setSendingModeAction({mode: "TEST"})` → the label is `Test list only`; a TEST
   draft with Studio Nord leaves Ola out with `Not on the test list (Test mode only emails your test list)`;
   `checkSendGuard({to: "ola@nord.example", purpose: "campaign", testMode: true, guard: {goLive: true, testList}})`
   throws. `setSendingModeAction({mode: "LIVE"})` again.
9. **A draft made before go-live** (G11): launching "Made early" without `confirmMadeBeforeGoLive` → refused with `Tick
   the box to confirm that this draft now sends real email.`, nothing launched; `loadLaunchSummary` says
   `madeBeforeGoLive: true`.
10. **Test-list only by launch flag**: remove Tess from the test list (`saveTestList`) and advance 1 day → "Test run"'s
    second follow-up is skipped with `not-on-test-list` (the fake gets nothing new for tess).
11. **Across the flip**: after two more days of ticks, the fake Mailgun has never received a message of "Rehearsal"
    (its emails are all in the outbox, `mode DRY_RUN`), and every message it has for "Mailgun test" carries
    `o:testmode=yes`.

### 9.4 The Playwright + axe suite (P9 writes it; the lead runs it in step S)

**Seed script** `scripts/seed-m6-manual.ts --state <empty|busy|ready|live|all>` (run with `node --import tsx`): writes
`data/manual-check/m6-<state>.db` from the migrations (refuses any other folder, and refuses `app.db` by name), users
**Arslan** (Owner, `arslan@example.com` / `practice-owner-1`) and **Ali** (Member, `ali@example.com` /
`practice-member-1`), time zone Asia/Karachi, clock = the real now (so "36 hours" and "today" hold when the lead runs
it); from `busy` on also the fake-mode Mailgun settings (`mailgun.domain = send.example.com`, the fake's key
`key-fake-api`). Every seeded address is on `example.com` or a `*.example` domain (the script asserts it).

| State | Content |
|---|---|
| empty | the two users only (no Mailgun settings: the dashboard's Today tile shows `Connect Mailgun`, Settings › Backups shows `No backup has been made yet.`) |
| busy | not live: 60 companies (8 without email; statuses spread), waiting replies Arslan 3 · Ali 1 plus 1 dry-run reply, 12 READY AI drafts, 2 paused campaigns (one "Paused by Arslan", one with a reason), 1 running dry-run campaign with outbox rows today, 1 running LIVE test-list campaign, 2 UNCONFIRMED emails, the newest app backup (row + file) 40 hours old, a second folder that doesn't exist and a newest row with `copiedTo` null (the setting's `updatedAt` older than that backup), `mailgun.catchUp` failing for 3 hours, one old-domain problem, the checks and AI pauses on, the sending pause `health-bounce` |
| ready | everything green for go-live in fake mode: checklist rows ok with `checkedAt` = now (the lead reseeds `ready` right before `go-live.spec.ts`, inside the hour), Setup A, reply test passed, routes ok, a SENT LIVE test-list email on the domain with a `delivered` event, a fresh backup, second folder `data\manual-check\second-copy\` (with its marker), a draft made "yesterday" |
| live | ready + go-live 3 days ago (settings `sending.goLive`, `sending.goLiveAt` 3 days back, `sending.goLiveDomain`, `sending.mode` and the activity, written as `goLive()` would), warm-up step 2 with 2 "up" days, 2 running LIVE campaigns with progress, 180 LIVE sends with 2 bounces, a dry-run campaign today |

**Busy keys** (the exact attention items the busy state produces; `dashboard.spec.ts` checks each text): `sending-paused`,
`worker-down`, `replies-waiting`, `ai-lines`, `paused-campaigns` (two items), `unconfirmed`, `missing-emails`,
`backup-old`, `backup-copy-failed`, `mailgun-check`, `old-domain`, `checks-paused`, `ai-paused` (14 items, under the cap
of 15). The other keys (`restore-check`, `disk-low`, `outage-hold`, `backup-never`, `second-folder-missing`,
`go-live-again`, `tunnel-down`, `checklist`) are covered by P7's render test only.

**Instances** (the lead, after `next build`). Fakes: `node scripts/fake-mailgun.mjs --port 4010 --app
http://127.0.0.1:3102`, `… --port 4011 --app http://127.0.0.1:3103`, `… --port 4012 --app http://127.0.0.1:3104` (one
per instance, so a restore scan on `live` only sees `live`'s sends), and `node scripts/fake-claude.mjs --port 4020`.
Every instance's window first sets `$env:APP_PUBLIC_URL = "http://127.0.0.1:<its port>"`,
`$env:OUTREACH_MAILGUN_BASE_URL = "http://127.0.0.1:<its fake>"` (empty: 4010 too; it has no Mailgun settings),
`$env:OUTREACH_ANTHROPIC_BASE_URL = "http://127.0.0.1:4020"` and `$env:OUTREACH_WEB_FIXTURES =
"tests/fixtures/sites"`, then `node scripts/run-prod.mjs --db data/manual-check/m6-<state>.db --port <port> --host
127.0.0.1 --no-build --pid-file run/m6-<state>.pid --stop-file run/m6-<state>.stop --log-prefix m6-<state>-` for
**empty 3101, ready 3103, live 3104**. **busy 3102 runs the web only** (no background sender, so its stale backup,
pauses and the worker-down item stay): the same four variables plus `$env:DATABASE_URL =
"file:./data/manual-check/m6-busy.db"; $env:OUTREACH_TEST_RUN = "1"; node node_modules\next\dist\bin\next start -H
127.0.0.1 -p 3102`.

**Config** `playwright.config.ts`: `testDir: "tests/playwright"`, Chromium only, projects **laptop** (1366 × 800) and
**phone** (390 × 844, `isMobile`, `hasTouch`); `use.baseURL = process.env.PP_E2E_BASE_URL` (refused unless
`http://127.0.0.1:<port>`); `workers: 1`, `retries: 0`, `timeout: 30_000`; `outputDir: "test-results"`; reporter
`list` + `html` to `playwright-report` (`open: "never"`) (both folders are already in ESLint's ignores); no
`webServer`.

**Helpers** `tests/playwright/helpers.ts`: `signIn(page, "owner" | "member")`; `expectAccessible(page, name)` =
`new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()` → no violations (the
message lists rule id, impact and the first targets); `shot(page, name)` → `test-results/shots/<project>-<state>-<name>.png`;
`expectNoHorizontalScroll(page)` (`scrollWidth <= clientWidth`); `expectAtMostOnePrimary(page)`: visible
`[data-slot="button"][data-variant="default"]` ≤ 1 (a Switch's, checkbox's, tab's or progress bar's `bg-primary` fill
is a "selected" state, not a button; primary link-buttons use `<Button asChild>` so they carry the attributes);
`STATE` from `PP_E2E_STATE`.

**Specs** (each block skips unless its state matches):

| Spec | States | Checks |
|---|---|---|
| `auth.spec.ts` | any (signed out) | the sign-in page (wrong password error text, then success lands on `/dashboard`), the invite and reset pages with an unknown token (their error states), the first-run setup page (redirects to sign-in once users exist), the not-found page (`Go to the dashboard`); axe; phone no horizontal scroll |
| `dashboard.spec.ts` | all | empty: Get started with 5 steps (Owner) / 2 steps (Member: Import companies and the muted Connect Mailgun), `Nothing needs your attention right now.`, `No replies are waiting for you.`, every tile's empty text; busy: each busy key's exact text for Owner, Member texts instead of Owner links, `Replies waiting for an answer: You 3 · Ali 1` (Owner) and `… You 1 · Arslan 3` (Ali), the replies list with 3 cards and **Answered** on each (Owner), the dry-run tile; live: pill `Sending live`, `Warm-up step 3 of 20: 69 a day.` (start of the line), health numbers, campaign progress bars; every link navigates; Tab reaches every link in order with a visible focus ring; axe; shots; phone: one column, no horizontal scroll |
| `go-live.spec.ts` | ready (mutates: the lead reseeds after) | "Before going live:" absent, "Recommended first:" shows the practice-restore line; the switch opens the dialog, which lists the draft made yesterday; **Go live** disabled until the box is ticked; Escape and **Not yet** close without change; confirm → toast `You're live. …`, pill `Sending live`, card `Live on send.example.com since …`, switch checked and disabled; axe on the open dialog; phone: dialog full screen |
| `settings.spec.ts` | empty, busy, live | every settings page as Owner, the three everyone pages as Member: heading = nav label, at most one primary button, axe, phone no horizontal scroll; empty: each R8 list empty state; Member opening `/settings/sending` lands on `/dashboard` with `Only the Owner can open that page.`; Limits "The 30-day rule": 0 days → `Use a whole number of days from 1 to 365.`, 21 days → the confirm dialog (Cancel); System Access switch opens its dialog (Cancel) |
| `backups.spec.ts` | empty, busy, live | empty: `No backup has been made yet.`; busy: banner `The last backup is more than 36 hours old.`; kinds `Daily backup`, `Back up now`, `Before an update`; Member: the second-folder form read-only with `Only the Owner can change this.`; **Back up now** as Member shows the "background sender isn't running" sentence (no worker on 3102); live: `Last restore` absent; axe |
| `screens.spec.ts` | empty, live | live: axe and a shot of every other main screen at both widths: Contacts, the Missing email view, a company panel, Campaigns, a campaign page, the dry-run outbox, the six wizard steps of a draft, Templates and the template editor, AI lines, Import steps 1–4 with `tests/fixtures/import/m5-companies.csv` and step 5's page before its Import button (nothing committed), Activity, Notifications; empty: the list empty states of Contacts, Campaigns, Templates, AI lines, Activity and Notifications |

Run: `$env:PP_E2E_STATE = "busy"; $env:PP_E2E_BASE_URL = "http://127.0.0.1:3102"; npm run test:e2e` (and so on per
state; reseed `ready` right before `go-live.spec.ts`, which runs last, then reseed it again).

### 9.5 Step S — the lead's manual checks

After `npm run check` (P10) and the suite (§9.4), by hand on the four instances, laptop width and 390 px:
- the dashboard in every state, including `worker-down` on the busy instance (no worker) and its disappearance on the
  live one; stop the live instance's worker (end its node process) and see `worker-down` within about a minute after a
  refresh;
- the go-live flow end to end on `ready` (card states before/after; the dialog's draft line; the wizard badge `Live`,
  the Schedule line and the "made before you went live" checkbox on the old draft; Sending mode options and the Live
  confirmation after go-live; the Test list card's text; the Verify step's text in Test mode);
- the dashboard's replies list on busy: **Answered** on one card removes it and lowers the line's count;
- Settings: every page against §5.1–§5.3 (one orange button, toasts, errors, empty states), the 30-day rule card and
  its confirm dialog, the Access switch and the Domain checklist's remote-access row after "Check again" (fake mode);
- Settings › Backups on busy (banner, kinds, copy-failed column) and live; on live, save a second folder under
  `data\manual-check\` → the save message, the marker file, the first copy listed as copied;
- **the restore rehearsal on a test copy**: on the `live` instance click **Back up now**, change something (rename a
  list), stop the instance, run `node scripts/restore.mjs <that backup's path> --db data/manual-check/m6-live.db
  --backups-dir backups/m6-live`, start the instance again: the pause card with "Checking Mailgun…", then the report
  (the fake has the sends); **Resume sending**; Settings › Backups shows **Last restore** with "Sending was resumed by
  Arslan …"; the renamed list is back to its old name; then undo with the "Before a restore" backup the same way (no
  administrator prompt: it isn't the app's database). Run `restore.bat`'s list (`node scripts/restore.mjs --db
  data/manual-check/m6-live.db --backups-dir backups/m6-live`, answer Enter to cancel) and check the kind labels; try
  `node scripts/restore.mjs backups\demo\<a practice-copy backup> --db data/manual-check/m6-live.db` → refused with the
  practice-copy sentence, nothing stopped or changed;
- `status.bat` shows the newest-backup line with its kind, and (in this folder under Pictures) the move-the-folder
  warning;
- `grep "Milestone"` over `.next/server/app/**/*.html` and the built JS: no hits.

---

## 10. Risks, decisions, owner-visible changes and the definition of done

### 10.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The "emailed" rule change ripples through ~44 test files and 12 source files | wave 1 overruns; a missed caller keeps judging by today's switch | the step-C bridge keeps behaviour until P1 switches every caller; P1 owns all callers and runs the whole suite; §8 P1's grep "done when"; P10 runs everything again |
| The join on `Campaign.launchedGoLive` slows the 30-day history queries | slower audience and launch on 10,000+ companies | the join is on the primary key; `query-plans.test.ts` must keep each history query on its index |
| Going live by mistake (one-way) | real prospects emailed before the owner is ready | blockers (Mailgun connected, a checklist checked within the hour, Setup A, a delivered live test on the current domain, a running worker), inputs re-read inside the transaction, a dialog with a required checkbox that lists old drafts, Owner only, guide 4; Pause all sending stops everything at once |
| An old draft launches Live to every prospect after go-live | unintended real email | the dialog lists such drafts; the wizard and `launch()` require a tick (G11) |
| A pre-go-live campaign reaches non-test-list people after go-live | real email from a "test" campaign | test-list only judged by the launch flag at re-check, loop and Mailgun client guard (fail closed) (G2) |
| Live campaigns start on a new sending domain that was never checked | bad deliverability, lost replies | a domain change ends go-live; going live again needs the whole checklist (G8) |
| Rehearsal bounces count against real sending | an early auto-pause or a held warm-up | health counted from go-live (G12) |
| A large database freezes the background sender during a backup | missed heartbeats, a timed-out Mailgun request, an Unconfirmed email | `VACUUM INTO` in a child process (§3.5) |
| Back up now clicks push out the daily backups; a damaged backup is kept as good | no good backup to restore | per-kind retention; `quick_check` before a backup counts (§3.3, §3.5) |
| restore.bat leaves the app stopped or half-copied, or restores a newer-version or practice-copy backup | the app down or on wrong data | free space, version, practice-copy and other-database checks before stopping; the prerestore failure path; the checked temporary file and rename (§3.7) |
| The second folder is shared with another install, a different stick, a mapped drive or a FAT stick | the wrong backups deleted, copies failing silently, install-services.bat failing | the marker file, drive checks, per-folder grant with a warning, the first copy on save, the dashboard item (§3.4) |
| OneDrive or ransomware protection takes over `C:\Users\polyg\Pictures\outreach` | database corruption or blocked writes | go-live recommendation, status.bat warning, guide 4 step 4 moves the app to `C:\Outreach` |
| A test run reaches the real public address | calls to the owner's Cloudflare hostname from test instances | loopback `APP_PUBLIC_URL` in every test run; `checkPublicAddress` refuses non-loopback in a test run (§3.9) |
| The owner goes live without Cloudflare Access | the sign-in page is public | Access stays required by default; turning the check off needs a confirmation and shows a recommendation line on the go-live card; the app's own sign-in and throttling still protect it |
| After a restore, test-list sends found in Mailgun's logs become `ExternalSend` rows | the test mailboxes are blocked by the 30-day rule for up to 30 days after a restore | accepted (conservative: a restore can't tell test-list sends from real sends made after the backup); README troubleshooting line |
| Script-backup pruning deletes a backup the owner wanted | an undo path lost | only the strict name pattern, only the main folder, newest 3 per kind kept, never younger than 14 days; README says so |
| The second folder on a local NTFS drive isn't writable by the service accounts | copies fail silently for the owner | save-then-grant: saving works even when the web service can't write there yet; the hint and the save message say to run install-services.bat; the first copy on save shows the result; `backup.copyFailed` notification; the dashboard's `backup-copy-failed` item |
| Refusing network folders and mapped drives surprises an owner with a NAS | no second copy | clear sentence with the alternatives (USB, second disk, OneDrive); documented in the README |
| The dashboard is slow or one source fails | a blank or slow home page | bounded queries, `Promise.allSettled`, a failing source drops only its tile or item and logs; P7's timing test |
| Members see Owner-only problems | confusion, or a leak | texts carry no secrets (pause texts are already scrubbed); Owner links hidden, "Ask the Owner to fix this." instead |
| The Playwright suite depends on running instances | flaky or skipped | run only by the lead in step S; four deterministic seeds; not part of `npm run check` |
| Docs drift from the final screens | wrong instructions for a non-developer | P6 writes from this design's copy; P10's label re-check; the guide-reference and no-"Milestone" tests |
| nodejs.org's "LTS" becomes Node 26 around go-live | a fresh install or an update breaks | every script text and guide 1 point at `latest-v24.x`; the app already refuses 26 with a clear sentence |
| Warm-up restart at go-live discards a pre-go-live rise | a slightly slower first week | test-list sends can't reach 25 a day; documented (G5) |
| The rule settings change running campaigns quietly | people skipped, reply linking lost, companies released | the impact confirmation and one transaction (§5.3) |
| The go-live checklist's freshness rule annoys (a check every hour) | one extra click | the blocker says exactly what to click; the check takes seconds |
| L7 makes every lease regain wait for a new check with Mailgun | a short delay after a stall | intended (a reply may have arrived meanwhile); the check takes seconds; the 15-minute network fallback stays |
| L8 pauses after the PC is renamed | one extra Resume | README troubleshooting line |
| htmlparser2/encoding-sniffer install | an npm tree change | both are already the only top-level copies; `npm ci` proves it; M5's EPERM procedure |

### 10.2 Technical decisions the lead confirms

1. **D1 — Go-live is one-way per sending domain** (G1, G8); no "switch off"; `goLive()` is the only writer of `true`,
   and a domain change in `connectMailgun` the only writer of `false`.
2. **D2 — "Emailed" and "test-list only" per campaign by `Campaign.launchedGoLive`** (G2), `emailedSendWhere` for
   database filters, the send-time re-check and the Mailgun client guard (`SendMessageInput.testListOnly`, fail closed)
   by the launch flag, a data-only migration filling `false` for older launches; `ExternalSend` always counts.
3. **D3 — Test mode stays test-list-only after go-live** (G3) at every layer (eligibility, send-time check, client
   guard); the top-bar label rules are unchanged (G6); the label's fallback shows `Status unavailable`.
4. **D4 — Go-live sets `sending.mode = "LIVE"`** (G4) in the same transaction as the switch, `goLiveDomain`, the removal
   of today's hand-set limit and the activity, after re-reading its inputs inside that transaction.
5. **D5 — Warm-up restarts at go-live at step 0** (G5) with history cleared, repaired by `evaluateWarmupDays` if the
   restart didn't happen; pre-go-live evaluation unchanged; the warm-up line says "step N of 20" and "Tomorrow X" only
   when today qualifies so far.
6. **D6 — Cloudflare Access opt-out setting** `remoteAccess.accessOff` (G7), default off (Access required).
7. **D7 — Go-live blockers** add Mailgun connected, a fresh checklist (1 hour), Setup A, a delivered live test on the
   current domain and a running worker; "warn" rows say "needs attention"; ten non-blocking recommendations (G10).
8. **D8 — Reply rate** = companies with `repliedAt` among companies with `firstContactedAt`, all time and first contacted
   in the last 30 days.
9. **D9 — One "waiting reply" definition** (`waitingReplyWhere`, M4 §4.1) for the bell, the dashboard and the Team page.
10. **D10 — The dashboard is everyone's home**; `/` and every sign-in path go to `/dashboard`; Members redirected from
    Owner pages land there; Owner-only links hidden for Members; the viewer's "Replies waiting for an answer" list is on
    it (PLAN Q7); it reads go-live from settings and never decrypts keys; `loadDashboard` lives in `src/app`.
11. **D11 — "Get started" moves to the dashboard**, shown to the Owner while not live (5 steps; again after a domain
    change) and to others while there are no companies; no "Hide this".
12. **D12 — Refresh every 60 s with `router.refresh`** (`LiveRefresh`); `GET /api/campaigns/:id/progress` stays unbuilt.
13. **D13 — Retention per kind**: 14 daily and 5 Back up now app backups (main and second folder); script backups are
    listed and pruned (newest 3 per kind, never younger than 14 days) and never copied to the second folder.
14. **D14 — One backup vocabulary**: Daily backup / Back up now / Backup / Before an update / Before a restore / Before
    a database upgrade; restore.bat reads kinds from the `Backup` rows read-only.
15. **D15 — Second-folder rules**: network paths, mapped network drives, drive roots and another install's folder
    refused; save-then-grant when the web service can't write yet; a marker file; a first copy on save; copies through
    `.tmp` with a free-space and size check; the practice copy never copies; same-drive, removable and OneDrive
    warnings; install-services.bat grants it separately and only warns on failure.
16. **D16 — Daily-backup timing**: quiet time from the sending windows (`loadDueStats` + `isWindowOpen`), the fixed
    window as fallback, a 12-hour minimum, the 20:00 daily guarantee, overdue at 30 h (was 36).
17. **D17 — `worker --backup=KIND` removed** (unused; the scripts keep making their own backups); app backups run
    `VACUUM INTO` + `quick_check` in the child process `scripts/vacuum-into.mjs`.
18. **D18 — "Last restore" card** on Settings › Backups from `STATE_KEYS.restore`, kept after Resume; `RestoreState`
    gains `resumedAt/resumedById`.
19. **D19 — L7 and L8 fixed** (`startedAt` on every lease; `InstanceState.host`).
20. **D20 — L9 deferred** (§1.5).
21. **D21 — A committed Playwright + axe suite**, four seeded states, run by the lead only; the busy instance runs without
    a background sender.
22. **D22 — No in-app Help page**; guide references are checked by a test (§6.7).
23. **D23 — Updates arrive as a zip**, documented; `update.bat <zip>` deferred.
24. **D24 — "The 30-day rule" card on Limits & warm-up** holds `teamRule.days`, `reservations.pausedExpiryDays` and
    `sharedDomains.extra`, with an impact confirmation and one transaction; `backups.keep` and `verification.provider`
    stay without an editor.
25. **D25 — The Member-refusal sweep finds every `"use server"` file** and every export that calls
    `requireOwnerAction()`, with an explicit allowlist for everyone-actions and ten snapshotted tables.
26. **D26 — `sending.goLiveAt`, `sending.goLiveDomain` and the `goLiveAt` row's `updatedById`** record when, where and
    who.
27. **D27 — `sending.wentLive` goes to every active user**; no pop-up group.
28. **D28 — htmlparser2 10.1.0 and encoding-sniffer 0.2.1 become direct dependencies**; cheerio stays.
29. **D29 — The test environment's default database path fails fast** (`data/test/__use-createTestDb__/none.db`).
30. **D30 — Old-domain catch-up problems persist in `CatchUpState.oldDomains`** with a 24-hour Owner notice.
31. **D31 — Drafts made before go-live need a tick** before a LIVE launch (G11); the go-live dialog lists them.
32. **D32 — Health counts from go-live** on real data (`healthCountingSince`, no write; G12).
33. **D33 — restore.mjs safety**: admin rights only for the app's database; version, practice-copy, other-database and
    free-space checks before stopping; the prerestore failure path; the checked temporary file and rename.
34. **D34 — Test runs never reach a real host**: loopback `APP_PUBLIC_URL` from `run-prod.mjs`; `checkPublicAddress`
    refuses non-loopback in a test run; one fake Mailgun per manual-check instance plus the fake Claude and fixtures.
35. **D35 — Dashboard additions**: `disk-low`, `second-folder-missing` (Owner, after go-live), `go-live-again`, the
    outage item while the hold is found or in force, `mailgun-check` after a 2-hour grace, a 15-item cap; team activity
    without per-email rows.
36. **D36 — The "no Milestone" test reads strings and JSX only** in code (comments keep their history).
37. **D37 — The app folder out of Pictures/OneDrive** is a go-live recommendation and a status.bat warning, not a
    blocker; guide 4 step 4 moves it.

### 10.3 For the owner: changes you should know about (plain words)

None blocks the build. To test M6 you need nothing new; to go live for real you need the sending domain, Mailgun,
Cloudflare and your test mailboxes set up (the guides say how). Please confirm or say no:

1. **You now land on the Dashboard** after signing in. It shows what needs you first (replies waiting per person, AI
   lines to review, paused campaigns, companies missing emails, and problems like an old backup, a nearly full disk or
   the background sender being off), then **your own "Replies waiting for an answer" list** with Answered / No answer
   needed (as planned: it stays on Notifications too), then your numbers. "Get started" moved there from Contacts.
2. **Reply rate** means: of the companies the app emailed, how many replied (all time, and for companies first emailed
   in the last 30 days). Dry runs never count; they are shown in their own box.
3. **Going live is a one-way switch** per sending domain. Settings › Sending & Mailgun › Go live, with a confirmation.
   To stop sending later, use Pause all sending. It also switches new campaigns to Live mode.
4. **More checks before going live**: Mailgun connected; the Domain checklist checked within the last hour; Setup A;
   one live campaign to your test list sent **and delivered**; the background sender running. A checklist row that
   only needs attention (for example DNS still spreading) is named with what to do. The card also recommends: waiting
   until the domain is 30 days old, Mailgun's monthly limit, trying address checks, a second backup folder, a fresh
   backup, moving the app out of Pictures, a practice restore, reading your templates and testing the AI model.
5. **Warm-up starts again on the day you go live**: 50 emails that day, one step up after each weekday with at least
   half the limit used and healthy numbers, to 1,000 in about four weeks at the earliest. The line now says "Warm-up
   step 3 of 20: 69 a day" (it was "Day 3 of 20"; a step can last several days) and "Tomorrow 80" only when today
   already qualifies. A limit you set by hand for that day is removed when you go live.
6. **Your test mailboxes become normal companies after going live.** What you sent them before stays "test emails"
   (not counted as emailed), but emailing them in a live campaign afterwards counts, including the 30-day rule.
7. **Test mode only ever emails your test list**, also after going live.
8. **Cloudflare Access stays recommended.** If you decide not to use it, Settings › System has a switch that tells the
   app so (it asks you to confirm), and going live no longer waits for it.
9. **Backups made by update.bat and restore.bat now show in Settings › Backups** and are tidied up: the newest 3 of each
   kind are kept, and none younger than 14 days is deleted. They aren't copied to your second folder (the daily ones are).
   **The newest 14 daily backups and the newest 5 "Back up now" backups are kept**, so clicking Back up now never
   pushes out a daily one. Every backup is checked by SQLite before it counts.
10. **The second backup folder can't be a network folder, a mapped network drive or a whole drive** (the background
    services can't write there). Use a folder on a USB stick, a second disk or OneDrive: save it, then run
    install-services.bat; the app makes a first copy straight away so you can see it works. A small file
    `outreach-backups.json` in that folder marks it as this app's.
11. **The dashboard warns when the last backup is more than 36 hours old**, or when there has never been one, when a
    copy to the second folder failed, and when the PC's disk is almost full.
12. **After a restore, Settings › Backups keeps a "Last restore" report**, also after you've clicked Resume, with who
    resumed.
13. **restore.bat now names each backup's kind** the same way as the app ("Daily backup", "Back up now", "Before an
    update"…), refuses a backup from a newer version of the app or from the practice copy, asks twice for a backup of
    another database (normal when moving PCs), checks free disk space first, and never leaves the app stopped with
    half-copied data.
14. **The daily backup picks a moment when no emails are due**, instead of a fixed night-time window; if none comes, it
    runs at 20:00 (Pakistan time) so there is one every day, and it always runs within 30 hours.
15. **The 30-day rule's length is now a setting** (Settings › Limits & warm-up, "The 30-day rule"), together with how long
    a paused campaign keeps its companies (14 days) and your own list of shared email domains. Saving asks you to
    confirm when it would change running campaigns, and the rule keeps its name "30-day rule" whatever the length.
16. **If the app's database file alone is copied to another PC**, sending pauses once until you click Resume (like a
    copied folder already does). Renaming the PC also asks for one Resume.
17. **Members opening an Owner-only page now land on the Dashboard** with "Only the Owner can open that page."
18. **The README is now your manual**, with a new "Going-live guide" (docs\setup\4-going-live.md), a "Your team"
    section, a short glossary, and "Backups and restore" including moving to a new PC. Updates arrive as a zip you
    unblock and extract; you delete the app's code folders (`src`, `worker`, `scripts`, `prisma`, `tests`, `docs`,
    `public`, never `data`, `backups`, `logs`, `run`, `tools` or `.env`), copy the new files in, then run update.bat.
19. **Node.js must stay on version 24.** From late October the nodejs.org front page may offer version 26, which the app
    refuses; every message and guide now points to the 24 downloads.
20. **Changing the sending domain after going live ends going live.** Live campaigns then reach only your test list
    until you go live again on the new domain, after its checklist, reply test and a delivered live test.
21. **Drafts made before you went live ask for a tick** ("This draft was made before you went live. It now sends real
    email to 412 people.") before they launch, and the Go live dialog lists them.
22. **Campaigns launched before going live keep emailing only your test list**, even after you go live.
23. **Bounce and complaint numbers count from the day you go live**, so rehearsal bounces don't count.
24. **The app folder should move out of Pictures** to `C:\Outreach` before going live (OneDrive and Windows' ransomware
    protection can take over Pictures); status.bat and the Go live card remind you, and guide 4 step 4 says how (one
    Resume afterwards).
25. **The first time you open the Dashboard on your real data** it will say "No backup has been made yet" and "The
    background sender isn't running", because your real database hasn't had the background sender since the sending
    update: run install-services.bat first (guide 1), then click Back up now.
26. **The practice restore in guide 4 uses your real data**, right after Back up now and when nobody is working
    (anything changed in between is lost, and sending pauses for about 35 minutes).
27. **The top-bar label says "Status unavailable"** if it can't load, instead of guessing.
28. **Test mode's Verify step text** now says Test mode only emails your test list, also after going live.
29. **Still to confirm**: the default answers used for the build's open questions (Q1–Q14) and the owner-visible change
    lists of the sending, follow-ups and address-check updates (M3-DESIGN §9.4, M4-DESIGN §12.3, M5-DESIGN §10.3) were
    never confirmed; guide 4 step 1 asks you to go through them with the person who set up the app before going live.

### 10.4 Definition of done (SPEC "Testing and definition of done") and its evidence

| SPEC requirement | Evidence |
|---|---|
| Automated tests: template rendering (variables, fallbacks, stable variations, missing details) | `tests/unit/templates/**` (M2), green in P10's `npm run check` |
| Import column matching and duplicate handling | `tests/unit/import/**`, `tests/integration/import/**` (M1, M5) |
| The 30-day rule | `tests/unit/rules/**`, `tests/integration/sequences/team-rule.test.ts` + P1's go-live cases |
| Follow-up scheduling and stop rules | `tests/unit/sequences-core/**`, `tests/integration/sequences/**`, `stops-holds/**` (M4) |
| Sending window and cap calculations, the warm-up ramp, health auto-pause | `tests/unit/sending-core/{window,caps,warmup,health}.test.ts`, `tests/integration/sending-m3/health-warmup.test.ts` + P2's go-live warm-up case |
| Webhook signature verification | `tests/unit/mailgun-core/signature.test.ts`, `tests/integration/webhooks/**` (M3) |
| Reply matching and auto-reply detection | `tests/unit/replies-core/**` (vectors), `tests/integration/replies/**` (M4) |
| Type-check, lint and tests all pass | P10: `npm run check` (typecheck + eslint + vitest) |
| The app builds in production mode on Windows | lead, step S: `next build` and `node scripts/build-worker.mjs` (self-test "packages ok") on this PC |
| E2E dry run: 1 import a CSV | P8 Part A step 1 |
| E2E: 2 draft and approve personal lines (mocked AI) | P8 Part A step 2 (fake Claude, fixture sites) |
| E2E: 3 a campaign with 2 follow-ups, review it and send it | P8 Part A steps 3–4 and 6 |
| E2E: 4 bounce, unsubscribe and reply with signed test webhooks | P8 Part A step 5 |
| E2E: 5 statuses, stop rules, notifications and dashboard numbers correct | P8 Part A step 7 |
| README: installing and the first run | README "Install and first run" + guide 1 (P6); `readme-topics.test.ts` |
| README: Mailgun domain and DNS (SPF, DKIM, DMARC, MX) and the inbound routes | README "Mailgun, DNS and reply routes" + guide 2 §4–§8, §15 |
| README: tracking off, unsubscribe handling on | README "Tracking off, unsubscribe on" + guide 2 §11 |
| README: Cloudflare Tunnel with optional Access | README "Cloudflare Tunnel and optional Access" + guide 3 and its "Skipping Cloudflare Access" box |
| README: adding team members | README "Your team" (P6) |
| README: keeping the PC awake (European hours = afternoon/evening in Pakistan) | README "When the PC is off, and keeping it awake" + guide 1 §6–7 |
| README: backups and restoring from one | README "Backups and restore" (P6) + Settings › Backups' restore card (P3) |
| A8 M6 "You'll test": dashboard numbers; a backup and a restore; a PC restart; the first real campaign | P8 + Playwright (numbers); P3 round trip + lead rehearsal; guide 4 steps 4, 5, 10 for the owner |

---

## 11. Critique decisions

Every finding of the two reviews (spec critic S1–S36, risk critic R1–R22) was checked against PLAN, SPEC and the code.
"Accepted" = applied as proposed; "Changed" = the problem is real and fixed another way (the reason says why);
"Rejected" = not applied.

| # | Finding (short) | Decision | Where | Reason |
|---|---|---|---|---|
| S1 | Replies list not on the dashboard | Accepted | §4.1, §4.2a, §4.7, P4, P7, §10.3 | PLAN Q7/B-list and M4 §4.3 promise it for M6 |
| S2 | Second folder can't be saved under services | Changed | §3.4 | save on `EPERM`/`EACCES` in any setup (no service detection needed), with one sentence covering both cases, plus a first copy on save (R13c) |
| S3 | Same-drive warning for OneDrive; mapped drives | Accepted | §3.4 | OneDrive gets its own warning (from R13d) instead of none; mapped drives refused via `driveTypeOf` |
| S4 | Actions on real time vs fixed clock | Accepted | §2.5, §3.8, §8 P8, §9.3 | fake `Date` around actions, with a service-with-`now` fallback |
| S5 | "Resumed by" can't be produced | Accepted | §3.7, §7.2, §7.8 | `resumeSending` only records acknowledgement for failed checks (pause.ts:166-185) |
| S6 | restore.mjs elevation before `isAppDatabase` | Accepted | §3.7 | confirmed at restore.mjs:59-62 |
| S7 | no-milestone test can't pass | Accepted | §8 P10, §2.7 | 68 comment hits in 45 files; the test reads strings and JSX only |
| S8 | Unowned files (modeLine, verify-model, pill, types, setup.bat texts) | Accepted | §2.7, §5.2, §8 P2/P5 | all confirmed in code |
| S9 | Sweep misses Owner-only actions | Accepted | §5.4 | 11 `"use server"` files call `requireOwnerAction`, incl. check-actions and ai-lines |
| S10 | Go-live doesn't require Setup A | Accepted | §2.4 | `liveLaunchBlockers` refuses non-A (mode-gates.ts:159) |
| S11 | Checklist misses readiness items | Accepted | §2.4, §6.4 | recommendations only (never blocking), worded to be true |
| S12 | Daily backups not daily under D16 | Changed | §3.5 | a 12-hour minimum plus a 20:00 daily guarantee instead of the proposed 24-hour rule, which could still skip a day at midnight |
| S13 | Outage item misses L9 | Changed | §4.2 | the gate holds retried/later people only while HELD rows exist, so the counted item already shows then; the real gap is the found-not-applied window, now covered |
| S14 | README headings vs topic test | Accepted | §6.2, P6 tests | |
| S15 | README misses B11 promises | Accepted | §6.2, P6 tests | PLAN.md:1286-1291 |
| S16 | Zip updates leave stale files | Accepted | §6.1 | the delete-folders step; a file list is deferred (§1.5) |
| S17 | Busy state can't show every item | Accepted | §9.4 | exact busy keys; cap raised to 15 so all 14 show |
| S18 | Manual-check instances reach a real host | Accepted | §0.2 rule 13, §3.9, §7.4, §9.4 | tunnel.ts:176-197; fixed in the app too (R18) |
| S19 | One fake Mailgun shared | Accepted | §9.4 | one fake per instance |
| S20 | Empty seed has Mailgun settings | Accepted | §9.4 | |
| S21 | Primary-button selector wrong; Switch colour | Accepted | §2.5, §4.1, §9.4 | switch.tsx:19, button.tsx:58-59; a checked Switch is A6's "selected" fill |
| S22 | Playwright gaps | Accepted | §9.4 | `auth.spec.ts`; empty-state runs; more screens (Import step 5 not committed) |
| S23 | P10 seed contradicts rule 6 | Accepted | §0.2 rule 6, §8 P10 | |
| S24 | Dry-run tile text false | Accepted | §4.3 | new text, true for every tile it names |
| S25 | Warm-up line false | Changed | §2.6, §7.8 | "step N" and a two-form line (qualifying so far / how it goes up), always true; not "stays 50", which is false early in the day |
| S26 | Warn rows say "not done yet" | Accepted | §2.4 | |
| S27 | `lastCopyFailed` stuck in the practice copy | Accepted | §3.4, §3.6 | |
| S28 | Failed warm-up restart never repaired | Accepted | §2.6 | same as R7a |
| S29 | §10.3 omissions | Accepted | §10.3 items 1, 5, 25, 29 | |
| S30 | Wording fixes | Accepted | §4.2, §4.3, §2.5, §7.9 | all six |
| S31 | Doc-test phrases and reference forms | Accepted | §6, §6.7, P6 tests | status.ps1:44, install-services.ps1:228, ops-common.ps1:221 forms |
| S32 | "30-day rule" name after a change | Accepted | §2.7, §5.3, §6.2 | |
| S33 | Layering and page guard | Accepted | §0.2 rule 12, §4, §4.6, §4.7, P7 | CONVENTIONS "Layout" |
| S34 | No nudge for a second folder after go-live | Accepted | §4.2 `second-folder-missing` | |
| S35 | Domain change invisible on the dashboard | Changed | §4.2 `go-live-again` | the item follows G8's new rule (go-live ends at a domain change) |
| S36 | Playwright output not ignored; mailgun-check blip | Accepted | §9.4, §4.2 | uses the already-ignored folders; 2-hour grace |
| R1 | Pre-go-live campaigns lose two checks | Accepted | §2.2, §2.3, P1 | recheckRecipient uses today's goLive (eligibility.ts:609-621); guard fails closed |
| R2 | Old drafts launch live | Accepted | G11, §2.3, §2.5, §2.7, P1, P2 | launch.ts fixes the mode from today's setting (line 353) |
| R3 | Stale or last-moment gate inputs | Changed | §2.4, §2.5 | freshness, `connected` and the in-transaction re-read accepted; the `mailgun.domain` `updatedAt` part dropped: rows of another domain are already discarded (reply-test.ts:99) |
| R4 | Any LIVE send satisfies the live test | Accepted | §0.3, §2.4 | |
| R5 | Domain change skips the go-live checklist | Changed | G8, §2.8, §0.2 rule 6 | a domain change writes `sending.goLive = false` (connect.ts, whose change is already refused while TEST/LIVE campaigns run) instead of an "effective go-live" computed at ~10 readers; same safety, one writer, no ripple through the 44 go-live test files |
| R6 | Rehearsal bounces count | Changed | G12, §2.6 | read-side `healthCountingSince` instead of writing the baseline, so nothing can be half-written |
| R7 | Warm-up restart not crash-safe; override survives | Accepted | §2.5, §2.6 | the override is cleared (not refused) |
| R8 | Dashboard decrypts keys and may write | Accepted | §0.2 rule 8, §4.6, P4, P7 | context.ts:83-93 |
| R9 | Activity tile shows only sends; full count | Accepted | §4.3, §4.6, P4 | mark-sent.ts:337 logs every email |
| R10 | Backup freezes the worker | Accepted | §3.5, P3 | a child process (worker threads would complicate the esbuild bundle); `backup-db.mjs` isn't reused because it writes script-backup names |
| R11 | Retention can remove every good backup | Accepted | §3.3, §3.4, §3.5 | all four parts |
| R12 | Second folder of another install / drive root | Accepted | §3.4 | instance ids survive moves (restore.ts:813-820), so a moved install keeps its folder |
| R13 | Mapped drives, FAT sticks, unplugged drives | Changed | §3.4 | PowerShell `DriveInfo` instead of `fsutil` (no admin question); the rest as proposed |
| R14 | App folder under Pictures with OneDrive on | Changed | §2.4, §3.9, §6.4 | confirmed (`OneDrive=C:\Users\polyg\OneDrive`); recommendation, status.bat and guide 4; the supervisor warning is deferred (§1.5) |
| R15 | restore.mjs can leave the app stopped/half-copied | Accepted | §3.7 | restore.mjs:113 and restore-marker.mjs:83 are unguarded |
| R16 | Restoring newer-version/practice/test backups | Accepted | §3.7 | |
| R17 | Elevation for a test database | Accepted | §3.7, §3.8 | child-process seed is now the default |
| R18 | Test runs reach the real address | Accepted | §3.9 | |
| R19 | Rule settings change running campaigns quietly | Changed | §5.3 | company-level counts instead of exact per-person counts (those need a full eligibility run); confirmation and one transaction as proposed |
| R20 | Disk space, status.bat backup line, EFBIG | Accepted | §3.4, §3.6, §3.9, §4.2 | |
| R21 | Go-live moment untested for running campaigns | Accepted | §9.3 Part B steps 2, 7, 9–11; P1 flip test | PLAN B12 |
| R22 | Smaller items | Changed | §2.4, §6.4, §2.7 | (a) accepted, using the new `resumedAt`; (b) the practice restore uses the real data right after Back up now, with the warning; (c) accepted as `Status unavailable` |

No finding was rejected outright.

---

## 12. Review fixes (2026-09-27)

Every finding of the M6 review (27 September) was fixed. Where the code now differs from this design, the fix wins;
the last column names the section it changes (or, where the code had drifted from it, the section it now follows).
Rejected: BACKUPS-6 (the web app not reading data\RESTORED), BACKUPS-9 (script date style), SECURITY-04 (Playwright
on the real port). No schema, package or migration change; three optional SystemState fields (see the summary below).

| Finding | What changed | Section |
|---|---|---|
| SCREENS-01 | README "Moving to a new PC": on the old PC, Back up now, stop.bat, **uninstall-services.bat**, `cloudflared service uninstall` (as administrator), then copy; the old PC may be switched on safely afterwards and never runs start.bat again. stop.bat's row and message: "until you start it again or Windows restarts". | §6.2 row 7 |
| SCREENS-02 / BACKUPS-3 | The backup to copy is named exactly (the Back up now file, `app-<today>-…`, from the File column or Date modified, never `app-pre…`); on the new PC restore.bat's **From:** is checked. | §6.2 |
| SCREENS-03 | Docs: Save folder → install-services.bat → **Back up now** → the NEW backup says Copied. App: BackupNowButton follows a job queued after a refresh (`startsFollowing`); a failed copy is added to the job's summary and shown as a warning toast; the EPERM/EACCES notification and the dashboard's `backup-copy-failed` item also say "For a folder on this PC, run install-services.bat on the office PC, then click Back up now." | §3.4, §4.2 item 12 |
| SCREENS-04/05/06/08, PHONE (AI lines, wizard Review) | Lists with truncated values use `grid-cols-1` and `min-w-0` (Templates, Contacts cards, Campaigns, Test list, AI lines tabs and cards, the Review step); screens.spec's `scan()` checks every screen for sideways scrolling. | §5.1 R10, §9.4 |
| SCREENS-07 | The Remote access card shows the Access line only when the public address answered (as the checklist row). | §2.8 |
| SCREENS-09 | Going-live guide step 8 quotes the "still running" lines first, then the report after about 35 minutes. | §6 |
| SCREENS-10 | `warmupLine(step, table, today, rule)` and `goLiveWarmupItem` word the rise from the settings (`warmupRiseCondition`: "at least 80% of the limit used", "sending day"); the dashboard, Limits & warm-up and the Go live dialog pass the rule. The defaults read as before. | §2.6 |
| SCREENS-11 | My profile, the second-folder form and Team's actions catch a thrown action ("Couldn't reach the app…") and keep what was typed. | §5.1 R9 |
| SCREENS-12 | Team: the phone email line wraps; the table is a named scroll region. | §5.1 R10 |
| BACKUPS-1 | A backup file without a row counts toward neither quota; it is deleted only once its name's date is more than `backups.keep` days old. | §3.3 ("a file without a row counts as daily") |
| BACKUPS-2 | The copy check, the free-space check and the job result use the real size; only `Backup.sizeBytes` is capped at 2,147,483,647. | §3.2, §3.4 |
| BACKUPS-4 | `restoreMarkerSeen()` (now async) ignores a handled marker; `deleteHandledRestoreMarker()` retries at start-up, in both restore-check passes and after every backup. | §3.7, L8 |
| BACKUPS-5 | Handling a new marker (and start-up, before orphaned jobs are reset) cancels `backup.run` and `mailgun.restoreScan` jobs created before the marker. | §3.7 |
| BACKUPS-7 | restore.mjs writes the replaced database's sending domains into the marker (`domainsBefore`; null = unreadable); the worker copies them to `RestoreState.domainsBefore` and walks them too; unreadable → `mailgunChecked: false`, the Owner confirms. An old marker behaves as before. | §3.7, M3 §4.3.7 |
| BACKUPS-8 | The daily backup runs at a quiet moment once the date has changed; the 20:00 guarantee fires only when no quiet slot is left that day, so with the default hours the latest time is **22:00** (README says so). | §3.5, glossary "Quiet time", §6 row 7, §10.3 item 14 |
| BACKUPS-10 | `restore.mjs --db <other>` defaults to `backups\<name>\` (`appBackupFolder`). | §3.7 |
| DASHBOARD-1 | `CatchUpState.failingSince` (set on the first failure, cleared on success); the grace is measured from `lastSuccessAt ?? failingSince ?? lastStartedAt`. | §4.2 row 16 |
| DASHBOARD-2 | Today, Domain health, the dry-run tile and the warm-up count by `sentAt` without `status` in the SQL (the sentAt index), SENT checked in code; query-plans.test.ts fails on `status_dueAt_idx` for a sentAt range. No new index. | §4.6 |
| DASHBOARD-3/4 | Recent team activity names and links the company ("(deleted)" as text), reads up to 200 rows in windows of 50, drops per-row import entries whose import.done was read, and collapses runs ("· 12 companies", "· 3 times", "· at least 200 companies"); still at most 8 rows. | §4.3 |
| DASHBOARD-5 | The replies footer links to `/notifications?scope=mine#replies`. | §4.2a |
| DASHBOARD-6 | Domain health with sample 0 and a baseline: "Nothing sent since you resumed on 27 Sept, so there's nothing to measure yet." | §4.3 |
| DASHBOARD-7 | Active campaigns' "+ N more" links to the tab the rest is on (`?tab=running`, `?tab=scheduled`, or `/campaigns`). | §4.3 |
| DASHBOARD-8 | The warm-up activity says "(warm-up step 2 of 20)"; old rows keep "day". | §2.6 |
| DASHBOARD-9 | Today: "Includes N test emails." | §4.3 |
| GOLIVE-01 | A company-only reply changes status once the app has ever been live (`hasBeenLive`: `sending.goLive` or `sending.goLiveAt`; `ReplyContext.everLive`). | §2.2 (M4 §3.6 row) |
| GOLIVE-02 | `WarmupState.startedForGoLiveAt`: the ramp restarts only for a go-live it hasn't restarted for; an older state adopts the record once. A cap-day zone change never restarts it. | §2.6 (the `startedCapDay` repair) |
| GOLIVE-03 | `activeRealCampaigns.liveAfterGoLive`: "Sending live" only for Live mode or a live campaign launched after go-live; the tooltip names test-list-only ones. | G6, §2.3 |
| SECURITY-01 | install-services.bat (`secondFolderRefusal`) and Settings › Backups (`isSystemOrProfileFolder`) refuse the same second folders: inside, equal to or above the app folder; Windows and program folders (environment and C:\ defaults); C:\Users, a profile, its Documents/Desktop/Pictures/Downloads/OneDrive folder itself (also those inside OneDrive) and the %OneDrive% roots. The grant revokes earlier grants no longer needed and keeps every recorded entry. One parity test runs both. | §3.4 |
| SECURITY-02 | restore.bat forwards every argument when it elevates; restore.mjs prints "Into:" and, for another database, a full `node scripts\restore.mjs … --db … --backups-dir …` undo line. | §3.7 |
| SECURITY-03 | The vacuum helper is looked for only in the app root (a folder with package.json), never a parent; missing → a plain failure; the child gets only PATH, SystemRoot, TEMP and a few others (no keys). | §3.2 |
| SECURITY-05 | Script "Before a database upgrade" copies of a database other than .env's go to `backups\<name>\` (`premigrateBackupsDir`). | §3.2 |
| SECURITY-06 | `noticeText` uses `Object.hasOwn`. | §4.1 |

Manual checks (§9.4): the seed adds long values (`scripts/lib/seed-m6-values.ts`, unit-tested): a prospect with a
61-character name, a 50-character website host and a 49-character address in "Germany Q4" (ready, live; Contacts' first
page), a live dry run and a second draft named at about 80 characters, that prospect's approved AI line (live), a
43-character test-list address and a switched-off teammate with a 34-character address (busy). screens.spec also scans
Campaigns › Drafts and AI lines › Approved.

## Summary of schema changes

- **No new model, column, index, enum value or relation.**
- Comment-only edits: `Campaign.launchedGoLive` (it now decides "emailed" and "test-list only"; null only for drafts)
  and `AiDraft.readAttempts` (counts interrupted reads only, L19).
- Migration `20260927120000_m6_go_live` (data only): `UPDATE "Campaign" SET "launchedGoLive" = false WHERE
  "launchedGoLive" IS NULL AND "launchedAt" IS NOT NULL;`
- Settings (JSON, no migration): new `sending.goLiveAt` (ISO string or null), `sending.goLiveDomain` (string or null)
  and `remoteAccess.accessOff` (false); existing `teamRule.days`, `reservations.pausedExpiryDays` and
  `sharedDomains.extra` get an editor; `sending.goLive` can now also be set back to false by a domain change;
  `sending.capOverride` is cleared at go-live.
- SystemState (JSON, no migration): `InstanceState` + optional `host`; `CatchUpState` + optional `oldDomains`
  (`{domain, since, lastAt, text}[]`, at most 10); `RestoreState` + optional `resumedAt`, `resumedById`. `WarmupState`
  and `HealthBaseline` unchanged (restarted at go-live; health counted from `sending.goLiveAt` by readers). The review
  fixes (§12) add three optional fields, parsed as missing in older states: `CatchUpState.failingSince`,
  `WarmupState.startedForGoLiveAt` and `RestoreState.domainsBefore` (plus the RESTORED marker's `domainsBefore`).
- Type-only contract fields: `SendMessageInput.testListOnly?`, the launch input's `confirmMadeBeforeGoLive?`.
- A file outside the database: `outreach-backups.json` in the second backup folder (`{instanceId, host, savedAt}`).
- New notification type `sending.wentLive`, activity type `sending.goLive`, `mailgun.domainChanged` data
  `goLiveEnded`, notice key `catchup-old-domain`.

## Summary of package changes

- `htmlparser2` **10.1.0** and `encoding-sniffer` **0.2.1** added to `dependencies` with `--save-exact` (already the only,
  top-level copies in `package-lock.json`; no module moves; `npm ci` proves the lockfile).
- `cheerio` 1.2.0 stays in `dependencies`. `@playwright/test` 1.63.0 and `@axe-core/playwright` 4.13.0 (dev) are already
  installed and now used by the committed suite; Chromium 1243 is already present. `typescript` (dev, existing) is used
  by the no-milestone and Member-refusal tests' parsing. No other package change; the new `scripts/vacuum-into.mjs`
  uses better-sqlite3 through the existing `scripts/lib/sqlite.mjs`.
