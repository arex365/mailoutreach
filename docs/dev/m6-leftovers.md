# Milestone 6 leftovers from Milestones 1–5

Written 2026-09-27, before the M6 design. Every item was checked against the code on that date; file:line references
are to the code as it is now. Sources: M3-DESIGN §1.3, §1.7, §9.3, §10; M4-DESIGN §1.4, §12, §13; M5-DESIGN §1.5, §10,
§11, §12; the "Bugs and gaps" sections of m3/m4/m5-code-map.md; CONVENTIONS.md; SPEC "Testing and definition of done";
PLAN A8 item 6, B6.5, B6.14, B12; and a grep of `src/`, `worker/`, `scripts/` and `tests/`.

**Grep result:** there is no `TODO`, `FIXME`, `XXX` or `HACK` in `src/`, `worker/` or `scripts/`, and no skipped or
`.only` test. The "later" / "for now" / "not yet" hits are runtime wording ("Try again later") or design notes, not
unfinished code. The "Milestone 6" hits are placeholders (L12).

**Legend.** Action: **Fix** (build it in M6), **Document** (write it down, no code), **Decide** (the M6 design chooses),
**Defer** (not in M6, with a reason). Size: **S** ≤ half a day with tests, **M** about 1–2 days, **L** more.
Priority: **P1** before the go-live switch ships, **P2** in M6, **P3** tidy-up (do it when touching the file).

## Summary

| # | Item | Action | Size | Prio |
|---|---|---|---|---|
| L1 | "Emailed" follows today's go-live setting, not the campaign | Fix | M | P1 |
| L2 | Top-bar label and mode texts don't know about go-live (Test mode after go-live) | Fix + Decide | S | P1 |
| L3 | Go-live wiring left by M3–M5 (switch, time, mode, Access exception, test mailboxes) | Fix | M | P1 |
| L4 | Warm-up doesn't "start" at go-live | Fix | S | P1 |
| L5 | Backups made by the scripts are invisible in the app, never pruned, never copied | Fix | M | P1 |
| L6 | README misses team members, moving PCs, go-live, undoing a misfiled reply | Document | M | P1 |
| L7 | Worker regains the lease without the wall-clock check (M4 SEQ-2 edge) | Fix | S | P2 |
| L8 | Database file alone copied to a new PC at the same path (M3 CRASH-6 remainder) | Fix | S | P2 |
| L9 | Outage hold on retried or later-launched recipients is invisible (M4 SEQ-3) | Fix | M | P2 |
| L10 | Old-domain catch-up problems only logged (M3 EVENTS-01) | Fix | S | P2 |
| L11 | Settings with no screen, incl. SPEC's "30-day team rule length" | Fix | M | P2 |
| L12 | "Milestone 6" placeholders, the landing page and the test that pins them | Fix | S | P2 |
| L13 | htmlparser2 / encoding-sniffer used directly but only installed through cheerio | Fix | S | P2 |
| L14 | Playwright + axe screen checks never committed; `npm run test:e2e` has nothing to run | Decide | M | P2 |
| L15 | Daily clean-up deletes any file in `data\test` older than a day | Fix | S | P3 |
| L16 | `tests/setup/env.ts` default database leaves `data\test-unit.db` next to `app.db` | Fix | S | P3 |
| L17 | Daily backup's quiet window is a fixed 22:00–08:00 PKT | Fix if cheap, else Document | S | P3 |
| L18 | Contacts "Last emailed: Never" for a test mailbox that got a live test email | Document + small Fix | S | P3 |
| L19 | Prisma comment on `AiDraft.readAttempts` is outdated | Fix | S | P3 |
| L20 | `OUTREACH_BACKUP_DIR` set but read nowhere | Fix | S | P3 |
| L21 | `countsAsReal` kept as an alias of `countsAsEmailed` on company sequences | Fix (with L1) | S | P3 |
| L22 | M3/M4 design docs don't record their review fixes (M3 §4.3.7 is wrong now) | Document | S | P3 |
| L23 | CONVENTIONS package list and PLAN B7 route list are out of date | Document | S | P3 |

Consciously deferred items are in §D, owner-side items in §E.

---

## A. Before the go-live switch ships (P1)

### L1. "Emailed" follows today's go-live setting, not the campaign (Fix · M)

- **Where:** `src/core/rules/mode.ts:38-48` (`countsAsEmailed` / `emailedModes` take `ctx.goLive`). Every caller reads
  Setting `sending.goLive` at call time: `eligibility.ts:100` (30-day history), `sending/mark-sent.ts:301-303, 329`
  (company status, `lastEmailed*`), `campaigns/launch.ts:437` and `sending/loop.ts:744` (reservations),
  `campaigns/control.ts:71-74, 224, 486` (resume, retry), `companies/detail.ts:342`, `campaigns/queries.ts:1002-1004`,
  `replies/input.ts:141-148` → `core/replies/kind.ts:79` (a reply "changes status"), `replies/actions.ts:369-371`.
  M5 already stores `Campaign.launchedGoLive` (`launch.ts:532`) but only the test-list exception uses it
  (`eligibility.ts:620`).
- **What's wrong:** M3 §1.7 made LIVE sends before go-live "counted but not emailed". Because the rule reads today's
  switch, flipping go-live on makes every earlier test-list send count as "emailed" retroactively; flipping it off would
  make every real send since go-live stop counting. M3 §9.3 and M4 §1.4 left this decision to M6.
- **Impact:** at go-live, the Owner's test mailboxes become blocked by the 30-day rule, the " (test list)" suffix
  disappears from old sequences, a pre-go-live live campaign still running starts taking reservations and writing
  `lastEmailed*`/status on the "Test mailboxes" companies, and a late-processed test reply can mark a test company
  Replied. If go-live can ever be switched off, real prospects lose 30-day protection (a second campaign could email
  them within days): the serious case.
- **M6 action:** make "emailed" a property of the send, not of today: a LIVE send counts when its campaign has
  `launchedGoLive === true` (null means launched before M6, when go-live was impossible, so false), or equivalently when
  `sentAt >= goLiveAt` (M3 §9.3's "simplest" option). Change `countsAsEmailed` to take the campaign's flag, give the
  eligibility history query a campaign condition (re-run `tests/integration/sending/query-plans.test.ts`), keep
  `countsAsReal` for caps, warm-up and health. With this, the go-live switch can safely be reversible; if M6 keeps it
  one-way, still fix it for the test-mailbox effects. Clean up L21 at the same time.

### L2. Top-bar label and mode texts don't know about go-live (Fix + Decide · S)

- **Where:** `src/core/sending/label.ts:61-90`; `src/components/settings/sending/texts.ts:5-24` (`MODE_WORDS.LIVE`
  "live (test list only)", the Live option text) and `:43` (`liveConfirmText` "… until you go live (Milestone 6)");
  `src/server/mailgun/send-guard.ts:49` (the guard lets every address through once `goLive` is on, for TEST too).
- **What's wrong:** after go-live, Test mode reaches anyone eligible (in Mailgun's test mode, billed, never delivered),
  but the label says "Test list only" with "emails to your test list are accepted but never delivered". The Live
  option and confirmation still say "test list only". M3 §9.3 listed "the top-bar label for TEST after go-live".
- **Impact:** the label says less than what goes out (A6's rule is the opposite); a Test campaign to 500 prospects after
  go-live costs 500 Mailgun sends and delivers nothing.
- **M6 action:** decide whether Test mode stays test-list-only after go-live (recommended: yes, keep the guard for
  TEST; test mode exists to check the connection), then make the label, `MODE_WORDS`, option texts and confirmation
  go-live-aware. Unit tests in `tests/unit` for `sendingLabel` with `goLive: true`.

### L3. Go-live wiring left by M3–M5 (Fix · M; M6 scope, listed so nothing is missed)

- **What exists:** the disabled switch and blocker list on Settings › Sending (`src/app/(app)/settings/sending/page.tsx:95-124`),
  `goLiveBlockersFor` (`src/server/services/reply-test.ts:178`) → `goLiveBlockers` (`src/core/sending/mode-gates.ts:53-71,
  198-217`: every `GO_LIVE_ROW_KEYS` row "ok", reply test passed, not paused, every sender has a reply route, refused in
  the practice copy), `Campaign.launchedGoLive`, the send guard (`send-guard.ts:49`).
- **Still to do (PLAN A8 item 6, B6.5):** the Owner-only action with a confirmation, activity entry and notification;
  record the go-live time (a Setting such as `sending.goLiveAt`; L1 and the dashboard need it); set `sending.mode` to
  LIVE ("switch new campaigns to live"); decide reversible vs one-way (see L1).
- **Access exception (M3 §9.3, §10 "Risk 27"):** if the owner declines Cloudflare Access (Q11), the "app protected" part
  of the `remote-access` row (`src/server/services/checks/tunnel.ts:249-276`, `appProtectedCheck`) must become a
  warning, not a go-live blocker.
- **Test mailboxes after go-live:** the guide has the Owner create one company per test mailbox in a list "Test
  mailboxes". After go-live they are ordinary companies, the test-list exception ("counts as checked") ends for new
  campaigns, and they count in the dashboard's pipeline. Say so in the go-live dialog/guide (keep that list out of
  audiences), or leave them out of dashboard counts.
- **Dashboard in modes (PLAN.md:914, B6.5 table):** dry-run numbers are shown separately.

### L4. Warm-up doesn't "start" at go-live (Fix · S)

- **Where:** `src/server/services/sending/warmup-days.ts:105-140` evaluates every closed cap day since the domain was
  connected; the history shows on Settings › Limits (`src/app/(app)/settings/limits/page.tsx:191-200`).
- **What's wrong:** PLAN A8 item 6 says warm-up starts at go-live. Today every pre-go-live day is judged (and held,
  since test-list sends rarely use half of 50), and the Limits page history fills with those days (M3 §9.1 "warm-up stays
  at 50 during test-list-only use").
- **Impact:** confusing history ("held" days before any real sending); if test sends ever used 25+ of the cap on a
  weekday, the ramp would already have moved before real sending began.
- **M6 action:** at go-live, write the warm-up state (through `updateTyped`) so evaluation starts at the go-live cap day
  with a history line "Warm-up started: you went live"; decide whether an earlier rise is kept. Before go-live, the
  Limits page says the ramp starts when you go live.

### L5. Backups made by the scripts are invisible in the app, never pruned, never copied (Fix · M)

- **Where:** `scripts/lib/backups.mjs:17-20` names them `app-<kind>-YYYY-MM-DD_HH-mm-ss.db` (kinds `preupdate` from
  `update.mjs:46` via `backup-db.mjs`, `prerestore` from `restore.mjs:113`, `premigrate` from `setup.mjs:268` and
  `lib/supervisor.mjs:103`). The app only knows `app-YYYY-MM-DD-HHmmss-xxxx.db` (`src/server/services/backups.ts:54`
  `BACKUP_FILE_PATTERN`), used by `listBackups` (`:416-423`, `:478-509`) and `pruneFolder` (`:429-464`).
- **What's wrong:** Settings › Backups doesn't list them (on this PC it would say "No backups yet" although
  `backups\app-premigrate-2026-09-26_15-44-23.db` exists), nothing ever deletes them, the second folder never gets
  them, and the `Backup.kind` values `PRE_UPDATE`/`PRE_RESTORE` are never written. README (`README.md:48`) and the
  install guide say "the last 14 are kept", which isn't true for these.
- **Impact:** the backups folder grows by one or two full copies per update, restore and upgrade, for ever; the Owner
  can't see the "Before an update" backup the restore instructions point to.
- **Also:** the practice copy's second-folder copies are named `app-….db` too; if the same second folder is set in the
  practice copy, its backups mix with the real ones there and `pruneFolder(second, keep)` keeps the newest N across both.
- **M6 action:** list script backups on Settings › Backups with their kind (reuse the scripts' `parseBackupTime`
  rules), keep the newest few of each script kind (e.g. 5; prune in the scripts or in the app's backup job), decide
  whether they go to the second folder, fix the README/guide sentence, and refuse (or prefix) the second folder in the
  practice copy. This is part of M6's "tested restore".

### L6. README misses team members, moving PCs, go-live, undoing a misfiled reply (Document · M)

- **Where:** `README.md`; SPEC "Testing and definition of done" lists what it must cover.
- **What's missing:**
  - **Adding team members** (SPEC requires it): Settings › Team invite, each person's profile, sending address and reply
    inbox, and adding their email to the Cloudflare Access policy. It isn't in the README or any guide.
  - **Moving the app to another PC** (restore.bat, or copy the whole folder and click Resume once; see L8).
  - **Backups:** the second folder, `.env` copy, script backups (L5); the dashboard's old-backup warning.
  - **Dashboard and going live:** what the switch changes, what "Test mailboxes" companies become (L3).
  - **A reply filed as real that was automatic:** there is no undo (M4 §12.3 item 14); say "set the company's status
    back by hand, then put the person back in a new campaign".
  - Status line, "Installing the Milestone 5 update" note and the "(after go-live, Milestone 6)" row
    (`README.md:5, 7, 62`) go (L12).
- **M6 action:** write these as part of "the final README and guides"; keep the owner-facing wording plain.

---

## B. M6, should fix (P2)

### L7. Worker regains the lease without the wall-clock check (M4 SEQ-2 edge) (Fix · S)

- **Where:** `worker/main.ts:199` (`startedAt` set once, in the constructor), `:407-413` (`holdLease` sets
  `lastHeartbeatOk = Date.now()` and runs `startup()`), `:464-477` (`checkWallClock` moves `startedAt`), `:483` (only the
  heartbeat loop calls it).
- **What's wrong:** after the heartbeat can't be saved for 45 s (a busy or locked database, a disk stall) the worker
  drops the lease and takes it again 15 s later. `startup()` queues a new check with Mailgun, but `startedAt` keeps the
  process's start time, so the catch-up gates (`isCatchUpReady` / `isFollowUpCatchUpReady`,
  `src/server/services/sending/gates.ts:607-638`: `lastSuccessAt` after `startedAt`) are already satisfied by the check
  before the gap. The same happens when the PC sleeps while the worker waits for the lease. The comment at
  `gates.ts:626-627` says the start time moves when "the lease [is] lost"; the code doesn't do that.
- **Impact:** low probability; a follow-up can go before a reply that arrived during the gap is stored (stored but
  unprocessed replies are still caught by the send guard).
- **M6 action:** in `holdLease`, move `startedAt` to now before `startup()` on every lease taken after the first (or
  always), which makes the `gates.ts` comment true. Add a case to `tests/integration/worker/wake-gap.test.ts`.

### L8. Database file alone copied to a new PC at the same path (M3 CRASH-6 remainder) (Fix · S)

- **Where:** `src/server/services/sending/restore.ts:714-722` (the note `data\app.db.instance`), `:762-769`
  (`copyCause` returns null when the note is missing), `:782-833`; `InstanceState` has no host
  (`src/core/system-state.ts:227`).
- **What's wrong:** the M3 review fix detects a whole-folder copy (the note names another computer), a moved file and a
  swapped file. A copy of `data\app.db` alone into a fresh install at the same folder path on another PC has no note,
  counts as "first start since the note exists", and is recorded without a pause.
- **Impact:** if the old PC still runs, both PCs send the same due emails (duplicate sends to prospects). Unlikely, but
  it's the one copy path left open, and "moving to a new PC" will be in the README (L6).
- **M6 action:** add an optional `host` to `InstanceState` (JSON, no migration; the parser accepts it missing), write it
  at start, and in `copyCause` compare it when the note is missing ("other-computer"). A renamed PC costs one Resume.
  Extend `tests/integration/sending-m3/restore-safety.test.ts` "copies at the same place".

### L9. Outage hold on retried or later-launched recipients is invisible (M4 SEQ-3) (Fix · M)

- **Where:** `src/server/services/sending/gates.ts:977-981` and `outageHeldIds` (`:530-593`);
  `src/server/services/campaigns/control.ts:514-523` (the Retry message); the campaign page counts only state HELD
  (`src/components/campaigns/format.ts:469`).
- **What's wrong:** the SEQ-3 fix makes the send gate hold people the outage hold didn't reach (reopened by Retry, or in
  a campaign launched after the hold without reservations: Test mode, live before go-live), but their recipient row
  stays scheduled. Only the Retry toast and the loop's global wait reason ("outage-hold", Settings › Limits) say why.
- **Impact:** the campaign page, Contacts' Sequence column and the company panel show them as due or scheduled while
  nothing goes; the campaign looks stuck.
- **M6 action:** compute the same set read-side for the page's open recipients and show "On hold: replies may have been
  missed" (the existing `holdStateText`), and count them in the dashboard's held-follow-ups tile (`outageHoldSummary`,
  L3/§C). Alternatively hold them for real through `holds.ts` at Retry/launch; the read-side option needs no new writer.

### L10. Old-domain catch-up problems only logged (M3 EVENTS-01) (Fix · S)

- **Where:** `src/server/services/mailgun/catch-up.ts:537-555, 641-656` (`oldDomainProblem`),
  `worker/jobs/mailgun-catch-up.ts:52` (job summary only).
- **What's wrong:** when an older sending domain can't be checked (key, network, logs not read to the end), it goes to
  the console and the job's summary; `CatchUpState` doesn't keep it and no screen shows it (jobs are deleted after 30
  days).
- **Impact:** after a domain change, bounces, unsubscribes and replies to the old domain's last emails can go unseen for
  days without anyone knowing.
- **M6 action:** keep the problems (and since when) in the catch-up SystemState (JSON, no migration), show a line on
  Settings › Sending's "Check with Mailgun" card and the dashboard's system tile, and notify the Owner once through
  `shouldSendNotice` after 24 hours of failures. A "gone" domain keeps its current one-time message.

### L11. Settings with no screen, incl. SPEC's "30-day team rule length" (Fix · M)

- **Where:** `src/server/settings.ts:38-39, 66`: `teamRule.days` (read by `eligibility.ts:79-91`),
  `reservations.pausedExpiryDays` (`reservations.ts:288, 320`), `sharedDomains.extra` (eligibility, imports, AI
  selection, company create). No page or action writes them.
- **What's wrong:** SPEC §12 lists "the 30-day team rule length" as an Owner setting; the other two are PLAN settings
  from M1/M2 left as keys.
- **Impact:** the Owner can't change them without editing the database.
- **M6 action:** part of "settings polish": add them (validated, logged with who changed them) to an existing Owner page,
  for example a "Rules" card on Settings › Limits or Deliverability; state what changes take effect when (the 30-day
  rule is judged at launch and at every send).

### L12. "Milestone 6" placeholders, the landing page and the test that pins them (Fix · S)

- **Placeholders:** `src/app/(app)/dashboard/page.tsx` (`ComingLater`), `src/components/page-header.tsx:57-85`
  (`ComingLater`, unused once the dashboard exists: delete), `src/app/(app)/settings/sending/page.tsx:98, 120`,
  `src/components/settings/sending/texts.ts:43`, comments in `src/components/contacts/get-started.tsx:65` and
  `src/components/campaign-wizard/wizard-frame.tsx:31`; docs `README.md:5, 7, 62`,
  `docs/setup/2-mailgun-and-dns.md:207, 359`, `docs/setup/1-install.md:33`.
- **Landing page:** everyone lands on Contacts: `src/app/(app)/page.tsx:4-7`, `src/app/(auth)/login/page.tsx:18`,
  `src/app/(auth)/actions.ts:19`, `invite/actions.ts:10`, `reset/actions.ts:10`, the sidebar logo
  (`src/components/shell/sidebar.tsx:106, 122`). PLAN A6 puts the Dashboard first (sidebar and phone bar already do,
  `src/components/shell/nav-items.ts:28`); M6 decides whether home becomes `/dashboard`.
- **Test:** `tests/unit/core/app-screens.test.ts:57-58` expects "Dashboard arrives in Milestone 6".

### L13. htmlparser2 / encoding-sniffer used directly but only installed through cheerio (Fix · S)

- **Where:** `src/server/web/extract.ts:17-18` imports `encoding-sniffer` and `htmlparser2`; `package.json:30-59` doesn't
  list them. `package-lock.json` pins one top-level copy each: htmlparser2 **10.1.0** (`:9942`), encoding-sniffer
  **0.2.1** (`:8262`), no nested copies. `tests/unit/worker/packages.test.ts:60-62` and the worker `--self-test`
  (`worker/index.ts:68-76`) check them.
- **What's wrong:** since the M5 review fix (WEB-02), production code no longer uses cheerio at all: cheerio 1.2.0 is
  only the reference parser in `tests/unit/web-reader/extract.test.ts:3, 350-358`, plus the self-test.
- **Impact:** a cheerio update or removal could move, nest or drop the reader's parser without any `package.json`
  change; the pinned-version test would catch it, the build wouldn't.
- **M6 action (lead, step C, `stop.bat` first, M5-DESIGN §5.5 procedure):**
  `npm install --save-exact htmlparser2@10.1.0 encoding-sniffer@0.2.1`, then prove `npm ci` rebuilds the tree. Keep
  cheerio in `dependencies` (moving it to devDependencies also means taking it out of the self-test and checking that
  `npm ci` in update.bat installs dev dependencies). Update the comment in `packages.test.ts` and CONVENTIONS (L23).

### L14. Playwright + axe screen checks never committed; `npm run test:e2e` has nothing to run (Decide · M)

- **Where:** `package.json:22` (`"test:e2e": "playwright test"`); there is no `playwright.config.*` and no
  `tests/playwright/**`. PLAN B12 (`PLAN.md:1323`) wants Playwright + axe screen checks; M3/M4/M5 "Step S" allowed "or
  the browser by hand plus axe", and every milestone did it by hand.
- **Impact:** no repeatable contrast/keyboard/empty-state check; the script fails if anyone runs it.
- **M6 action:** either write a small Playwright + axe suite for the M6 screens (dashboard, settings, the go-live
  dialog) against a seeded test database and the fakes (`run-prod.mjs --db …`, `OUTREACH_TEST_RUN=1`), or remove the
  script and record in CONVENTIONS that screen checks are manual. Recommended: the small suite, since M6 is the last
  milestone and the owner has no one to repeat manual checks.

---

## C. Hooks M6 can use as they are (no problem, listed for the design)

- Dashboard (M3 §9.3, M4 §1.4, M5 §1.5): `waitingReplyCount(userId)` (`src/server/notifications.ts:296`; excludes
  `replyScope "campaign"`, M4 §4.1), `listWaitingReplies` (`src/server/services/replies/waiting.ts:218`),
  `outageHoldSummary` (`src/server/services/sequences/holds.ts:794`), `aiQueueCounts` (`src/server/services/ai/queue.ts:97`),
  `getContactsSidebar().missingEmailCount` (`src/server/services/companies/query.ts:177`), SystemState `health`,
  `warmup`, `tunnel.status`, `catchup.outage`, `BACKUP_STALE_MS` (`src/server/services/backups.ts:51`, 36 h).
- Go-live: see L3.

---

## Tidy-ups (P3)

### L15. Daily clean-up deletes any file in `data\test` older than a day (Fix · S)

- **Where:** `worker/jobs/cleanup.ts:37` (`testFilesDays: 1`), `:170`, `:257-264` (keeps only the live database and its
  `-wal`/`-shm`/`-journal`).
- **Impact:** developer-only: manual-check databases put there vanish (the M4 browser-check databases
  `data\test\m4-*.db` are gone), and a manual check's `.instance` note is deleted daily (re-written at the next start).
  CONVENTIONS "M5" already says to use `data\manual-check\`.
- **M6 action:** delete only files named like `createTestDb`'s (`<name>-<pid>-<ms>-<rand>.db` and suffixes) and
  build-worker's throw-away database, and add `.instance` to the keep list; or leave the code and keep the rule
  documented.

### L16. `tests/setup/env.ts` default database leaves `data\test-unit.db` next to `app.db` (Fix · S)

- **Where:** `tests/setup/env.ts:9` (`DATABASE_URL ??= "file:./data/test-unit.db"`). A test that imports `@/server/db`
  without `createTestDb()` opens it; `data\test-unit.db`, `-shm` and `-wal` are there now (last touched 2026-09-26),
  outside the clean-up's folder.
- **M6 action:** point the default at `data/test/` (for example `file:./data/test/unit-default.db`) or at a path that
  makes such a test fail fast, and delete the three `data\test-unit.db*` files.

### L17. Daily backup's quiet window is a fixed 22:00–08:00 PKT (Fix if cheap, else Document · S)

- **Where:** `worker/schedule.ts:13-17, 36-62`, `worker/periodic.ts:95-101`.
- **What's wrong:** B6.14 wants the backup "outside every open sending window"; US East 09:00–17:00 is 18:00–02:00 PKT,
  so 22:00–02:00 overlaps (M3 §9.3, M3 §10 "Spec 26").
- **Impact:** none on sending safety (`VACUUM INTO` is a plain read in WAL mode, `backups.ts:15-20`); only B6.14's
  wording.
- **M6 action:** prefer an hour in which no due gated email's window is open (reuse `openIntervals`), keeping the 36-hour
  fallback; or document that the fixed window is kept.

### L18. Contacts "Last emailed: Never" for a test mailbox that got a live test email (Document + small Fix · S)

- **Where:** `src/components/contacts/format.ts:51-56`; `mark-sent.ts:329` writes `lastEmailed*` only for "emailed"
  sends; m4-code-map §4.5.
- **What's wrong:** by design (M3 §1.7) the column says "Never" while the Sequence column says "Finished (test list)".
- **M6 action:** keep the rule (after L1 these rows stay "not emailed"), add a tooltip line such as "Test emails before
  going live don't count" when the company has only such sends, and one README sentence. Or document only.

### L19. Prisma comment on `AiDraft.readAttempts` is outdated (Fix · S)

- **Where:** `prisma/schema.prisma:909` says "Times this draft went to FETCHING"; since M5 review DATA-05 (M5-DESIGN
  §12.3) it counts interrupted reads only (a finished read or a requeue from FETCHING gives the claim back),
  `resetStuckDrafts` fails the draft at 2.
- **M6 action:** fix the `///` comment, run `npx prisma generate` (no migration: comments aren't in the SQL). Lead-owned
  file (CONVENTIONS).

### L20. `OUTREACH_BACKUP_DIR` set but read nowhere (Fix · S)

- **Where:** `scripts/start-demo.mjs:72`. The practice copy's backup folder comes from `backupFolderFor`
  (`src/server/services/backups.ts:162-169`, `backups\demo\`). m3-code-map §8 item 14.
- **M6 action:** remove the line.

### L21. `countsAsReal` kept as an alias of `countsAsEmailed` on company sequences (Fix with L1 · S)

- **Where:** `src/server/services/companies/detail.ts:27, 350`, `src/components/company-panel/emailed-text.ts:39-49,
  174-176`, `src/components/campaigns/format.ts:809-814, 861`.
- **M6 action:** when L1 changes the inputs, drop the alias so one name means one thing (m4-code-map §4.5).

### L22. M3/M4 design docs don't record their review fixes (Document · S)

- **What's wrong:** M5-DESIGN §12 lists its review fixes and "wins" over the sections above; M3 (48 confirmed findings)
  and M4 (26) have no such section; the IDs survive only in test headers (`CRASH-*`, `SEQ-*`). Example: M3-DESIGN
  §4.3.7 (`:1962-1967`) describes `checkDatabaseInstance` by path only; the code also uses the `.instance` note and the
  computer name (`restore.ts:708-833`).
- **M6 action:** add a line at the top of M3-DESIGN and M4-DESIGN: "The code and its tests win; review fixes are named in
  test headers", and fix §4.3.7. A full back-port isn't worth it.

### L23. CONVENTIONS package list and PLAN B7 route list are out of date (Document · S)

- `docs/dev/CONVENTIONS.md:14-18` ("Installed and allowed") lacks the M5 packages (@anthropic-ai/sdk 0.128.0, cheerio
  1.2.0, undici 7.30.0, robots-parser 3.0.1, ipaddr.js 2.5.0) and, after L13, htmlparser2 and encoding-sniffer.
- `PLAN.md:1158` lists `GET /api/campaigns/:id/progress`, never built (the campaign page refreshes with
  `router.refresh`, m3-code-map §8 item 14). Mark it "not built" unless the dashboard needs live progress.

---

## D. Consciously deferred (keep out of M6)

| Item | From | Why it can wait | Hook already there |
|---|---|---|---|
| Undo a real reply (restart follow-ups stopped by a reply that was really automatic) | M4 §1.4, §12.2 D27 | Rare; workaround is to set the status back by hand (document, L6). Build after M6 if the owner asks | `CampaignRecipient.stoppedByInboundId`, written by `stops.ts:147, 159` |
| "Quoted text matches your email to …" link hint | M4 §1.4 | Exact-address and same-domain hints cover most cases | — |
| Weekend follow-ups at the same local time instead of window start | M4 D14 | PLAN B6.4 "next open slot" | `followUpDueAt` |
| Service worker, web push, phone pop-ups; public holidays; Thread-Index; muting notification types | M4 §1.4 | Not planned by PLAN/research | — |
| Holding a cross-company replier's own rows | M4 §1.4, §13 | Very rare; "Real reply" stops them | `holdCompany` takes one company |
| Bulk validation; ZeroBounce/NeverBounce; Mailgun usage metrics | M5 §1.5, D11 | Only for 10k+ runs / other providers; own count is shown | adapter interface; `other-maps.ts` |
| Message Batches, prompt caching (Sonnet only), Haiku screening call | M5 §1.5, D18 | Haiku is the default and below its cache minimum | pure `buildLineRequest`, `costUsd` prices cache |
| Website extraction in a worker thread; headless browser | M5 §1.5, D41 | Extraction is linear and capped; watchdog logs slow pages | `readAttempts`, the watchdog |
| Owner-editable parked/social host lists and user agent; bulk approve and per-list queue filters | M5 §1.5 | Nice to have | constants in `@/core/ai/site-rules`; `listDrafts` filter object |
| Re-checking an address that changed mid-sequence | M5 §1.5 | Never (follow-ups use the launch judgement) | — |
| Setup C (reply subdomain) | M3 §1.3, §1.5 | Only if the reply test fails and the owner agrees | `mailgun.unsubscribeTest.setup` accepts "C" |
| `Campaign.sendingDomainId` without FK; `Campaign.fromAddress` vs `OutboundEmail.fromAddress` naming | m3-code-map §8 item 12 | No user impact; a schema change for naming only | — |

## E. Owner-side items and notes for the M6 test (not code)

- **Unanswered:** Q8–Q14 (sending domain, Mailgun plan and account, test mailboxes, Cloudflare/Access, Anthropic key),
  and the owner-visible change lists M3-DESIGN §9.4 (10 items), M4-DESIGN §12.3 (24), M5-DESIGN §10.3 (23) were never
  confirmed. Go-live needs a real Mailgun domain, the reply test passed and Cloudflare; the build and tests can only
  exercise the go-live switch against the fakes. The go-live checklist should ask for these confirmations.
- **Plan choice (Q9):** Mailgun Foundation includes no free address checks (M5 research); remind the owner before real
  checks.
- **Claude Haiku 4.5 retirement:** M5 docs say "earliest late November 2026", the M5 research said "not sooner than
  2026-10-15" (m5-code-map §9 item 14). The go-live checklist should include "Settings › AI › test the model" (a free
  `models.retrieve`); the "model not found" pause text already says to pick Sonnet 5.
- **This PC today:** `data\app.db` has no daily backup (only `backups\app-premigrate-2026-09-26_15-44-23.db`), no
  `data\app.db.instance` note and no service logs in `logs\` (only the practice copy's, 2026-09-23). So the background
  sender hasn't run on the real database since Milestone 3. M6's "a PC restart" test needs `install-services.bat` first.
- **Stray file:** an empty `New Text Document.txt` in the app folder (2026-09-26); the owner's, leave it or ask.
