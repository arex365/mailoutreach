# Milestone 6 code map: what already exists

Written 2026-09-27 from reading the code, not the plan. Paths are relative to the repo root. "M6" means Milestone 6
"Finish and go live" (PLAN.md A8 item 6, SPEC.md milestone 6: dashboard, settings polish, backups, README and setup
guides, final testing, the go-live checklist and switch). This file only describes existing code: where M6 plugs in,
what it must not break, and gaps found along the way. For WHAT to build, see SPEC §11–§13 and "Testing and definition
of done", PLAN A1, A6, A8 item 6, A9 item 5, B6.5–B6.7, B6.14, B7, B8, B11, B12. Format follows `m5-code-map.md`.

---

## 0. The integration points that matter most

1. **Go-live is a setting nobody writes.** `"sending.goLive": false` (`src/server/settings.ts:19`) is read in about 20
   places (§3.1) but only tests and `scripts/seed-m5-manual.ts:250` set it. There is no action, no `goLiveAt`, no
   activity type and no confirmation. Settings › Sending shows a disabled `<Switch>` and the `goLiveBlockers` list
   (`src/app/(app)/settings/sending/page.tsx:95-124`). Settings are JSON rows, so a new key such as `sending.goLiveAt`
   needs no migration.
2. **"Emailed" follows TODAY's go-live, not the send's.** `countsAsEmailed(mode, {practiceCopy, goLive})`
   (`src/core/rules/mode.ts:38-48`) is always called with the current setting. When go-live flips, every earlier
   LIVE row (test-list sends) suddenly counts:
   - the 30-day rule starts blocking the test mailboxes (`emailedModes` in `loadHistory`, `services/eligibility.ts:354`);
   - the " (test list)" suffixes disappear (`sequenceSuffix`);
   - a pre-go-live LIVE campaign that is still running takes reservations at its next send (`loop.ts:744`) and on
     resume/retry (`control.ts:224, 486`);
   - `markSent` then writes `lastEmailed*`, `firstContacted*` and CONTACTED on the test companies (`mark-sent.ts:329-330`);
   - a reply to an old test email sets the company to Replied (`replyScope`, `core/replies/kind.ts:78-79`).

   M3-DESIGN §9.3 asks M6 to record the go-live time and decide. `Campaign.launchedGoLive` (M5) already records
   go-live per campaign and could carry the rule (§3.3).
3. **Three rules still say "test list" after go-live:**
   - `liveLaunchBlockers` always blocks an empty test list (`core/sending/mode-gates.ts:161`), so after go-live a live
     launch still needs one;
   - the top-bar label for TEST mode after go-live still reads "Test list only … emails to your test list"
     (`core/sending/label.ts:79-90`, pinned by `tests/unit/sending-core/label.test.ts:90-102`);
   - the mode title and toast words are "Live (test list only)" / "live (test list only)"
     (`components/settings/sending/texts.ts:5-24`). The wizard badge gets `goLive` only on the Verify page (§3.6).
4. **Warm-up doesn't start at go-live.** The ramp belongs to the sending domain. `evaluateWarmupDays` creates it
   (`step 0`, `startedCapDay = today`) at the first hourly `warmup.evaluate` after `mailgun.domain` is set
   (`services/sending/warmup-days.ts:140-146`). Pre-go-live test-list sends count toward it (`realModes`), and each
   day they use < 50 % of 50 is "hold-low-use". In practice the ramp only moves after go-live, but nothing resets or
   marks it at go-live (§3.8).
5. **The dashboard is a placeholder, and everyone lands on Contacts.** `app/(app)/dashboard/page.tsx` renders
   `<ComingLater milestone={6}>`. Seven places send people to `/contacts` (§1.5). Almost every tile already has a
   loader (§4). Missing: a reply rate, per-user waiting counts, dry-run counts shown separately, a "sent today" split
   and a worker-down sentence in A6's wording.
6. **Backups are mostly built (M1), including "Back up now" and the second folder.**
   - Settings › Backups is visible to everyone, and "Back up now" is a job everyone may queue. The second folder can
     be set only by the Owner. The page warns when the last backup is older than 36 h (`BACKUP_STALE_MS`).
   - Missing for M6: the dashboard's old-backup warning (the constant's comment already promises it), a warning when
     there has never been a backup, a quiet window based on the sending windows (M3 §9.3), and any test of the backup
     actions.
7. **Two backup naming schemes don't know about each other.**
   - The background sender writes `app-YYYY-MM-DD-HHmmss-xxxx.db` plus `Backup` rows, and prunes to 14.
   - The scripts write `app-preupdate-…`, `app-prerestore-…` and `app-premigrate-….db`: no rows, no copy to the
     second folder, **never pruned**.
   - Settings › Backups lists only the first kind (`BACKUP_FILE_PATTERN`), yet its own restore instructions tell the
     Owner to pick the "Before a restore" backup, which only `restore.bat` lists.
   - `BackupKind.PRE_UPDATE` / `PRE_RESTORE` and `worker --backup=KIND` exist but no script uses them (§2.7).
8. **The restore report disappears once the Owner resumes.** It is only rendered inside the pause card while a
   `restore` pause is on (`settings/sending/load.ts:175-208`). Nothing shows the second pass's result after Resume,
   and there is no end-to-end test of backup → `restore.mjs` → worker start → scan → report → resume (§2.7, §6).
9. **Go-live blockers are strict.** `goLiveBlockers` needs these to pass:
   - all 16 `GO_LIVE_ROW_KEYS` "ok" ("warn" blocks too, e.g. DNS "still spreading", a weak tunnel or an old
     cloudflared version, `core/dns/checklist.ts:1012-1014`);
   - the reply test passed on the current domain, not paused, and every active sender's reply route "ok";
   - "remote-access" needs Cloudflare Access (`appProtectedCheck`). M3 §9.3 says M6 relaxes this if the Owner declines
     Access (Q11 unanswered).

   Nothing turns go-live off when the domain changes: `connectMailgun` resets the reply test, but `sending.goLive`
   stays true.
10. **SPEC §12's "the 30-day team rule length" has no editor.** Also missing from Settings (B6.14): the shared-domain
    list, the paused-reservation expiry and the verification provider. The keys exist in `SETTING_DEFAULTS` (§5.3).
11. **SPEC's end-to-end check has no dashboard numbers.** `tests/integration/milestone5/end-to-end.test.ts` Part A is
    SPEC DoD steps 1–4 (practice copy, signed webhooks, fake Claude). It skips the Review step and asserts only Ali's
    notification types. The go-live switch and the dashboard don't exist yet. Playwright has a script
    (`npm run test:e2e`) but no config and no `tests/playwright/` (§6).
12. **Docs are at "Milestone 5 of 6".**
    - The README has no sections on adding team members, the dashboard, go-live, "Back up now" or the second folder.
    - The guides still say "(Milestone 6)" and quote Q-numbers.
    - Its backups line ("the last 14 are kept") is only true for the sender's own backups (§7).

---

## 1. Every M6 placeholder and promise

### 1.1 User-facing text (src)

| file:line | What it says / does |
|---|---|
| `src/app/(app)/dashboard/page.tsx:7-15` | `requireUser()` then `<ComingLater title="Dashboard" milestone={6} what="It will show what needs your attention first: replies waiting for an answer, AI lines to review, paused campaigns and companies missing emails. Until then, start on Contacts." />`, so the heading is "Dashboard arrives in Milestone 6", with a "Go to Contacts" button. |
| `src/app/(app)/settings/sending/page.tsx:95-124` | Card "Go live": description "Arrives in Milestone 6. Until then, real email only reaches your test list."; `<Switch id="go-live" checked={false} disabled aria-describedby="go-live-blockers" />`; "Before going live:" + `data.goLiveBlockers` list, or "Everything going live needs is in place. The switch arrives in Milestone 6." (:120). |
| `src/app/(app)/settings/sending/page.tsx:88` | Test list card: "The mailboxes that can receive real email before you go live." |
| `src/components/settings/sending/texts.ts:43` | `liveConfirmText()`: "… Everyone else is left out until you go live (Milestone 6). Switch to live?" (Sending mode dialog, `sending-mode-form.tsx:129`). |
| `src/components/settings/sending/texts.ts:8, 21-22, 61` | `MODE_WORDS.LIVE = "live (test list only)"` (activity log and toasts, `settings/sending/actions.ts:121,125`); `MODE_OPTION_TEXTS.LIVE` title "Live (test list only)" and "…only to the addresses on your test list until you go live…"; `TEST_LIST_TEXTS.hint` "Until you go live…". |
| `src/components/campaign-wizard/format.ts:227-229` | `modeLine()` (Schedule step): "It sends real email, but only to the addresses on your test list until you go live. Emails to test mailboxes don't count as emailed…". It has no goLive input. |
| `src/components/campaign-wizard/wizard-frame.tsx:9-10` | `wizardModeText(mode, goLive=false)`: "Live (test list only)" unless goLive. Only the Verify page passes `goLive` (`setup/verify/page.tsx:35`); Audience, Sender, Message, Review and Schedule don't (§3.6). |
| `src/components/checks/verify-model.ts:193-219` | Verify step card "before-go-live": "Until you go live, only your test-list addresses get email, and they count as checked." |
| `src/core/rules/eligibility.ts:337`, `src/server/services/sending/loop.ts:500-504` | Reason "Not on the test list (until you go live, only test-list addresses get real email)". |
| `src/core/sequences/wording.ts:64-73`, `src/components/campaigns/format.ts:831` | Suffix " (test list)" / " · sent to your test list before going live". |
| `src/components/company-panel/emailed-text.ts:12, 240-290` | "Test email sent 24 Sept (test list, …)" instead of "Never emailed". |
| `src/components/page-header.tsx:57-85` | `ComingLater({title, milestone, what, next?})`. Its only user is now the Dashboard. |

### 1.2 Code comments that name M6 or promise a later dashboard

- `src/app/(app)/page.tsx:4` "Until the dashboard arrives (Milestone 6) everyone lands on Contacts."
- `src/components/contacts/get-started.tsx:64-66` "Until the dashboard arrives (Milestone 6), this is home."
- `src/app/(app)/settings/sending/page.tsx:25` "…go-live (Milestone 6)…"
- `src/core/sending/mode-gates.ts:53, 194` "(M6)" / "M6's switch".
- `src/server/services/reply-test.ts:177` "`Before going live:` (M6's switch; shown in M3 with the switch disabled)."
- `src/server/services/replies/waiting.ts:13` "(and M6's dashboard)".
- `src/server/services/ai/queue.ts:96` "(and M6's dashboard tile)".
- `src/server/services/backups.ts:50` `BACKUP_STALE_MS`: "The dashboard and Settings › Backups warn…" Only Settings › Backups does.
- `src/components/campaign-wizard/wizard-frame.tsx:31` "(false in Milestone 3)".
- `worker/index.ts:8`, `worker/main.ts:654` say `--backup=KIND` is "used by update.bat / restore.bat". It isn't (§2.7).
- `scripts/`: no M6 text. `scripts/seed-m5-manual.ts:15, 250` sets `sending.goLive = true` for the M5 manual checks.
- `prisma/schema.prisma:528-529` `Campaign.launchedGoLive` ("the test-list exception is judged at launch").

### 1.3 Tests that pin placeholder behaviour

| Test | Pins | M6 effect |
|---|---|---|
| `tests/unit/core/app-screens.test.ts:56-60` | `ComingLater` renders "Dashboard arrives in Milestone 6" + Go to Contacts | reword or drop if `ComingLater` goes |
| `tests/unit/core/app-screens.test.ts:47-54` | `MOBILE_NAV` = Dashboard, Contacts, Campaigns, Notifications | keep |
| `tests/unit/sending-core/label.test.ts:90-102` | TEST mode after go-live still "Test list only" with the test-list title | changes if M6 rewords TEST after go-live |
| `tests/unit/sending-core/mode-gates.test.ts` (16 goLive hits) | `goLiveBlockers`, `liveLaunchBlockers`, `modeWarnings` | extend for the goLive-aware launch gate |
| `tests/unit/contacts/get-started.test.ts` | `mailgunStep()` wording | keep / move with the checklist |
| `tests/unit/setup-core/ui.test.ts:50` | `OWNER_SETTINGS` order and labels | update if Settings pages are added or renamed |
| `tests/unit/shell/quick-links.test.ts`, `command-menu.test.ts` | "Go to" list built from `MAIN_NAV` (Dashboard first) | keep |
| 44 test files reference `goLive` (`tests/unit/rules/mode.test.ts`, `replies-core/kind.test.ts`, `integration/sequences/team-rule.test.ts:74-76`, `company-panel/who-emailed-m4.test.ts`, `replies/scopes.test.ts`, `sending-m3/modes.test.ts`, `milestone5/end-to-end.test.ts`…) | today's `countsAsEmailed(mode, {goLive})` semantics | any change to the go-live rule (§3.3) ripples here |

### 1.4 Docs

| Where | Text |
|---|---|
| `README.md:5` | "**Status: Milestone 5 of 6** … Until you go live (Milestone 6), real email only reaches the addresses on your test list." |
| `README.md:7` | "**Installing the Milestone 5 update:** …" |
| `README.md:61-62` | Label table: "Test list only … or live before you go live"; "**Sending live** Real emails to everyone eligible (after go-live, Milestone 6)." |
| `docs/setup/2-mailgun-and-dns.md:207` | "Until you go live (Milestone 6), real email only ever reaches the addresses on your test list…" |
| `docs/setup/2-mailgun-and-dns.md:212, 262` | Mode "**Live (test list only)**" |
| `docs/setup/2-mailgun-and-dns.md:261, 318, 359` | "don't count as 'emailed' before go-live"; "Stopped by the test-list guard…"; "Before you go live (Milestone 6), replies from your test mailboxes don't change the test companies' status" |
| `PLAN.md:100, 119, 252, 460, 502, 519, 541` | Q-text, A6 Dashboard row ("Until Milestone 6, you land on Contacts…"), A8 item 6, A9 item 5 |
| `docs/dev/M3-DESIGN.md:117, 205, 211, 258, 271, 2584, 3357-3364, 3441, 3444` | Go-live switch uses `goLiveBlockers()`; the dashboard reads `health`/`warmup`/`tunnel.status`/`catchup.outage`; §9.3's four M6 notes (go-live time + pre-go-live LIVE rows + TEST label; backup quiet window; Access optional) |
| `docs/dev/M4-DESIGN.md:131, 133, 526, 1027, 1051, 2002, 2332` | Dashboard tiles (waiting per user, held follow-ups), the "(test list)" suffix after go-live, M6's tile counts only `replyScope ≠ "campaign"` |
| `docs/dev/M5-DESIGN.md:174, 182-183, 555, 1314` | `ComingLater` stays for the Dashboard; tiles "AI lines to review" and "companies missing emails"; the Go live switch; `launchedGoLive` |

### 1.5 The current `/dashboard`, the landing page and the "Get started" checklist

- `/dashboard` exists only as a placeholder (above). It is in `MAIN_NAV` first (`components/shell/nav-items.ts:28`),
  in the phone bar and in the Ctrl+K "Go to" list.
- **Everything lands on Contacts:**
  - `app/(app)/page.tsx:5-8` redirects `/` to `/contacts`;
  - `app/(auth)/actions.ts:17-20` `safeNext()` defaults to `/contacts`, and `setupAction` redirects to
    `/contacts?welcome=1` (`:107`);
  - `(auth)/login/page.tsx:18`, `(auth)/reset/actions.ts:10` and `(auth)/invite/actions.ts:10` go to `/contacts`;
  - `lib/auth/dal.ts:38` `requireOwner` sends Members to `/contacts?notice=owner-only`;
  - `components/error-copy.ts:30` (not-found "Go to Contacts") and `api/export/_lib/download-response.ts:15,36`.
  - `proxy.ts:30` only drops `next` for `/`.
- **"Get started"** (`components/contacts/get-started.tsx`):
  - `mailgunStep(state, isOwner)` (:10-48): pure, it words step 3 (practice copy / connected / Owner / Member).
  - `loadMailgunStepState()` (:54-61): `practice.copy`, `mailgun.domain` and whether `mailgun.apiKey` is saved.
  - `GetStarted({isOwner, dismissHref?, mailgun?})` (:68-125) is an async server component with three steps: Import
    companies → Invite your team (Owner only) → Connect Mailgun.
  - Shown on Contacts when `?welcome=1` or there are no companies (`app/(app)/contacts/page.tsx:56, 70-71, 106`).
  - It has no go-live, test-list, backup-folder or `.env` steps, which A8 "Go-live checklist" and A9 item 5 ask for.

---

## 2. Backups and restore

### 2.1 Data and settings

- `prisma/schema.prisma:891-898` `Backup { id, fileName @unique, createdAt, sizeBytes, kind BackupKind, copiedTo? }`;
  `:154-159` `enum BackupKind { AUTO, MANUAL, PRE_UPDATE, PRE_RESTORE }`.
- Settings: `"backups.keep": 14` and `"backups.secondFolder": null` (`server/settings.ts:67-69`). `backups.keep` has
  no editor. Periodic state: SystemState `task.backup.daily` (`{lastSuccessAt, lastEnqueuedAt}`).

### 2.2 `src/server/services/backups.ts` (the sender's backups; M1)

| Export | Meaning |
|---|---|
| `BACKUP_KINDS`, `BackupKindValue`, `BACKUP_KIND_LABELS` (:31-39), `isBackupKind` | "Automatic" / "Manual" / "Before an update" / "Before a restore" |
| `AUTO_BACKUP_DEDUPE_KEY "backup:auto"`, `MANUAL_BACKUP_DEDUPE_KEY "backup:manual"` (:46-47) | one queued/running `backup.run` per key |
| `DEFAULT_KEEP = 14`, `BACKUP_STALE_MS = 36 h` (:49-51) | retention; "last backup is old" threshold |
| `BACKUP_FILE_PATTERN` (:54) | `^app-YYYY-MM-DD-HHmmss-xxxx\.db$`, the only names the app lists and prunes |
| `backupTimestamp`, `randomSuffix`, `backupFileName(d, suffix)`, `isBackupFileName`, `backupDateFromName` | names in the PC's local time |
| `normalizeKeep(v)` | 1–1000, default 14 |
| `selectBackupsToDelete(files, keep, protect?)` (:111-130) | newest N kept, the one just made never deleted |
| `backupNewerThanClock(names, now)` (:139) | the PC's clock went back (2 h slack) |
| `backupFolderFor(dbFile, cwd)` / `backupFolder()` (:163-174) | `<cwd>\backups` for `data\app.db`, else `backups\<db name>\` (practice copy, tests) |
| `formatBytes(n)` | "12.3 MB" |
| `RunBackupOptions`, `BackupResult`, `BackupBusyError`, `copyFailureReason(err)` | |
| `runBackup({kind, userId?, now?})` (:250-267) | one in-process lock; `VACUUM INTO` on its own better-sqlite3 connection into `<name>.db.tmp`, then rename. Checks free disk space first. Copies to the second folder with `COPYFILE_EXCL` and prunes it too. Writes a `Backup` row. Prunes the main folder and deletes rows of pruned files. Notifies the Owner `backup.copyFailed` / `backup.clockWrong` (once while unread). Logs `backup.done` / `backup.failed`. |
| `BackupListItem`, `listBackups()` (:478-509) | files on disk (pattern only) joined with rows, newest first |
| `getPendingManualBackupJob()`, `enqueueManualBackup(userId)` (:512-530) | "Back up now" queues `backup.run {kind:"MANUAL"}` at priority 5 |
| `FolderCheck`, `checkSecondFolder(input)` (:538-580) | full path (drive letter or UNC), exists, is a folder, writable (probe file), not inside the app's own backup folder |

### 2.3 Worker side

- `worker/jobs/backup.ts`:
  - `backupKindFromPayload(payload)` (:7-12);
  - `runBackupJob` (:14-27) records `task.backup.daily` success only for AUTO;
  - `backupJob` (:31-51): failure notice "The daily backup failed: … Check free disk space…", link `/settings/backups`.
- `worker/periodic.ts:93-102` task `backup.daily`: `intervalMs` 1 day, `retryAfterMs` 1 h,
  `due = isBackupDue(now, lastSuccess, ctx.timeZone)`, enqueues `backup.run {kind:"AUTO"}` with dedupe `backup:auto`.
  `checkPeriodicTasks` (:199-225) runs at start-up and every 10 min, with `timeZone = sending.capDayTimeZone`.
- `worker/schedule.ts`:
  - `QUIET_START_HOUR = 22`, `QUIET_END_HOUR = 8`, `BACKUP_OVERDUE_MS = 36 h` (:14-17);
  - `hourInTimeZone(now, tz)`;
  - `isQuietHour(now, tz, start?, end?)` (:36-44): **fixed 22:00–08:00 in the cap-day zone (Pakistan)**, which overlaps
    US-East sending (M3 §9.3);
  - `isBackupDue(now, last, tz)` (:55-62): never / clock went back → now; < 24 h → no; ≥ 36 h → now; else quiet hours only.

  B6.14 wants "outside every open sending window". The building blocks exist: `openIntervals` and `isWindowOpen` in
  `core/sending/window.ts:141-190`, and `loadDueStats(now, {defaultZone, practiceCopy})` for due zones in
  `services/sending/gates.ts:329`.
- `worker/main.ts:655-672` `backupOnce(kindArg)` behind `node dist/worker.mjs --backup=KIND` (`worker/index.ts:108-111`):
  a backup without the lease. **No script calls it.**

### 2.4 Settings › Backups (everyone; M1)

- `app/(app)/settings/backups/page.tsx`: `requireUser()`. `loadBackupsView` (:28-49): `listBackups`, the settings,
  `getWorkerStatus`, `getPendingManualBackupJob`; `stale = last && now − last > 36 h`. Sections:
  1. warning "The last backup is more than 36 hours old." (worker-aware; **not shown when there's no backup at all**);
  2. Last backup + Back up now;
  3. Saved backups table (Made on, Size, Kind or "Not recorded", Second copy, File) and a copy field for the folder;
  4. "Second copy" (`SecondFolderForm`, read-only for Members);
  5. "How to restore a backup" (restore.bat steps, "pick the backup marked 'Before a restore'", keep a copy of `.env`).
- `app/(app)/settings/backups/actions.ts`:
  - `backUpNowAction()` (:15-23): `requireUserAction`, returns `{jobId, workerRunning}`;
  - `saveSecondFolderAction({folder})` (:34-53): Owner; `checkSecondFolder`, logs `settings.updated`;
  - `clearSecondFolderAction()` (:56-72): Owner.
- `backup-now-button.tsx`: `BackupNowButton({initialJobId, initialStatus, workerRunning})`, the only orange button;
  polls `/api/jobs/:id` every 2 s and `/api/health` for worker-down wording.
- `second-folder-form.tsx`: `SecondFolderForm({value, canEdit})`. Its hint tells service users to re-run
  `install-services.bat` (so `scripts/lib/service-acl.mjs:55` grants the folder).
- Nav: `components/settings/settings-nav.tsx:23-27` (EVERYONE group). Also linked from Settings › System's "Backups" row.

### 2.5 Scripts (their own backups; M1/M3)

- `scripts/lib/backups.mjs`:
  - `timestampForFile`, `backupFileName(kind, date)` → `app-<kind>-YYYY-MM-DD_HH-MM-SS.db`;
  - `parseBackupTime(fileName)` also reads the sender's names; `backupKindLabel(fileName)`;
  - `restoredFromTime({fileName, mtime})` takes the earlier of the two;
  - `listBackups(dir)` lists **every `*.db`** in the folder, newest first;
  - `makeBackup(kind, dbFile, dir, {allowRawCopy})` uses VACUUM INTO, with a raw copy as the fallback.
- `scripts/backup-db.mjs`: CLI `--kind --db --out-dir --allow-raw-copy --json`, run as a child process by update.mjs
  (the better-sqlite3 `.node` lock).
- `scripts/update.mjs:43-62, 103-111`: step 2 makes `app-preupdate-….db`. Also `scripts/setup.mjs:268` and
  `scripts/lib/supervisor.mjs:103` make `app-premigrate-….db`.
- `restore.bat`: elevates when the services are installed, then `node scripts\restore.mjs %*`.
- `scripts/restore.mjs` (`[file] [--yes] [--db] [--backups-dir]`):
  1. `chooseBackup` lists the 30 newest `*.db` in `backups\` (never the second folder, so a copy there needs
     `restore.bat <full path>`);
  2. confirm with "yes", then `stopApp`;
  3. `makeBackup("prerestore", …, {allowRawCopy:true})`;
  4. `swapInBackup` writes the marker **before** the copy; on a damaged backup it puts the saved data and the old
     marker back (`quickCheck`);
  5. `ensureMigrated`, then `startApp` unless `startBlocker` (update unfinished) says no;
  6. box "Sending stays paused until you've read the restore report in Settings > Sending & Mailgun and clicked
     Resume".
- `scripts/lib/restore-marker.mjs`:
  - `RESTORE_MARKER_VERSION = 3`;
  - `restoreMarkerFile(dbFile)` = `<db folder>\RESTORED`;
  - `restoreMarkerText(dbFile, {restoredFrom, backupName, at})` → `{version, restoredFrom, at, file, db}`;
  - `writeFileAtomic`, `readMarkerBytes`, `putBackMarker`;
  - `swapInBackup({dbFile, backupFile, savedFile, restoredFrom, putInPlace, check, now})` → `{ok}` or
    `{ok:false, stage:"marker"|"check"}`.

### 2.6 What the worker does after a restore (M3 §4.3.7) — `src/server/services/sending/restore.ts`

- `RESTORE_MARKER_VERSION = 3`, `RESTORE_SECOND_PASS_MS = 35 min` and the dedupe keys `mailgun:restore-scan(-2)`.
- `RESTORE_PAUSE {kind:"restore", reason:"restored from a backup", fixText}`, plus `COPIED_DATABASE_PAUSE`,
  `otherComputerPause`, `REPLACED_DATABASE_PAUSE`.
- `restoreMarkerPath()`, `restoreMarkerSeen()`; `restoreHoldActive(state)` (pending/scanning, or failed / unchecked
  and not acknowledged) holds every TEST/LIVE send; `restoreNeedsAcknowledgement(state)`.
- `handleRestoreMarker({now, markerPath, logger})` (:220-228) runs at worker start (`worker/main.ts:370-371`, after
  `checkDatabaseInstance`): pause, queue scan pass 1, record `pending`, delete the marker, then
  `settleRestoreCheck`.
- `runRestoreScan` (:579): walks Mailgun's accepted events since `scanFrom` (min(backup time, newest activity) − 1 h)
  and matches them by Message-ID, send_id or (campaign, step, recipient). It creates missing rows, records
  `ExternalSend`, and marks rows Unconfirmed when they're older than retention. The report goes to SystemState
  `restore.report`. `markRestoreScanFailed`, `checkDatabaseInstance`.
- Resume: `resumeSending({confirmRestoreRisk})` (`services/sending/pause.ts:153`) via `resumeSendingAction`
  (`settings/sending/actions.ts:171`). The report is worded only by `restoreLines()` inside `pauseView()`
  (`settings/sending/load.ts:175-275`), i.e. only while a `restore` pause is on.

### 2.7 Gaps: what "a tested restore" (A8 item 6 "You'll test: a backup and a restore") needs

1. **The Owner's walk-through works today:** Back up now → `restore.bat` → pause card → Resume. What's missing:
   - the restore report after Resume (second pass included): e.g. a "Last restore" line on Settings › Backups or the
     dashboard, read from `STATE_KEYS.restore`;
   - Settings › Backups doesn't list the "Before a restore" / "Before an update" files that its own text points to.
2. **Script backups:** they aren't pruned (`cleanup.ts` doesn't touch backups), aren't copied to the second folder and
   get no `Backup` row. The scripts' `app-<kind>-…` names vs the sender's `app-…-xxxx` names. Either the scripts use
   `worker --backup=PRE_UPDATE|PRE_RESTORE` (built for this, unused), or the app learns their names.
3. **No automated round trip.**
   - `tests/unit/ops/restore-script.test.ts` runs restore.mjs on temp files (cancel, swap + marker, damaged backup,
     failed migration, not SQLite, not found).
   - `tests/integration/sending-m3/restore.test.ts`, `restore-safety.test.ts` and `sequences/restore.test.ts` cover the
     worker side from a hand-written marker.
   - `tests/integration/worker/backups.test.ts` covers `runBackup`.
   - Nothing chains a `runBackup` file → `restore.mjs --db … --backups-dir … --yes` → worker start → scan against the
     fake Mailgun → report → `resumeSendingAction`.
4. **The backup actions have no tests:** `backUpNowAction`, `saveSecondFolderAction` and `clearSecondFolderAction`,
   including the Member refusal.
5. The practice copy's backups go to `backups\demo\`, but `restore.bat` only lists `backups\`. That's fine, but
   undocumented.

---

## 3. Go-live

### 3.1 `sending.goLive`: where it is read

| Reader | What it decides |
|---|---|
| `server/sending-state.ts:30-50` `getSendingLabel()` | top-bar label (§3.6) |
| `server/mailgun/context.ts:142-155` `loadSendGuard({userId?})` → `SendGuard {goLive, testList, ownInbox?}` | client guard + final check |
| `server/mailgun/send-guard.ts:37-53` `checkSendGuard(msg)` | inside `MailgunClient.sendMessage`: before go-live campaign/reply-test mail only to the test list; `self-test` only to the user's own inbox (always) |
| `server/services/eligibility.ts:77-108` `loadEligibilitySettings()` → `EligibilitySettings.goLive` | 30-day history modes, `not-on-test-list`, test list counts as checked |
| `core/rules/eligibility.ts:176-189, 328-343` `personReasons` | TEST/LIVE: not on the test list → blocking `not-on-test-list` before go-live; `countsAsChecked = onTestList && (testListCountsAsChecked ?? !goLive)` |
| `server/services/campaigns/launch.ts:437, 532, 798-816` | `takesReservations = countsAsEmailed(mode, {…goLive})`; writes `Campaign.launchedGoLive` |
| `server/services/sending/loop.ts:554, 744, 832, 851` | final check test-list skip; `ensureReservation`; `markSent(…goLive)` |
| `server/services/sending/mark-sent.ts:41-42, 300-330` | `recordRealContact` only when `countsAsEmailed` |
| `server/services/campaigns/control.ts:71-75, 224, 486` | `emailedContext()`: reservations on resume and on retry |
| `server/services/companies/detail.ts:313, 342-351` | panel sequences' `countsAsEmailed` (suffix) |
| `server/services/campaigns/queries.ts:969-1023` `companySequences(ids, {practiceCopy?, goLive?})` | Contacts "Sequence" column suffix |
| `server/services/replies/input.ts:128-148`, `process.ts:248, 567, 677`, `actions.ts:369-373` | `replyScope(... goLive)` → `changesStatus` (stored on the row) |
| `server/services/reply-test.ts:74-168` `loadGateInputs()` | `GateInputs.goLive`; `modeWarnings` |
| `server/services/verification/select.ts:254-439` | check views (they use `LIVE_CHECK_CONTEXT` goLive=true for Contacts/list checks) |
| `server/services/sending/gates.ts:152, 717, 757` | `GateContext.goLive`, loaded but **not used** by `planTick` |
| `components/checks/verify-model.ts:193` | Verify card "before-go-live" |
| `components/campaign-wizard/wizard-frame.tsx:9` | badge "Live (test list only)" |

### 3.2 The go-live gate (M3 P5)

- `core/sending/mode-gates.ts`:
  - `MODE_GATE_TEXTS` (:15-37);
  - `GO_LIVE_ROW_KEYS` (:54-71): mailgun-domain, spf, dkim, mx, tracking-cname, https-links, dmarc, tracking-off,
    unsubscribe, spam-filter, retention, signing-key, webhooks, reply-routes, sending-allowed, remote-access
    (not monthly-limit, reply-test, postmaster or domain-age);
  - `CHECKLIST_ROW_TITLES`;
  - `goLiveBlockers(rows, {replyTestPassed, paused, practiceCopy, sendersWithoutRoute})` (:198-217): each row not
    "ok" gives "<title>: not done yet (Domain checklist).", plus "The reply test hasn't passed yet." / "Sending is
    paused." / "Ali has no working reply route." In the practice copy there is only one line.
  - Also `testModeBlockers`, `liveModeBlockers`, `liveLaunchBlockers` (:147-163) and `replyTestBlockers`.
  - `modeWarnings(mode, {testListSize, goLive?})` (:223-229) says nothing after go-live.
- `server/services/reply-test.ts`:
  - `GateInputs` (:31-57);
  - `loadGateInputs(now?)` (:74-168): settings, `getMailgunContext`, `domain.check` rows (current domain only), the
    reply-test setting, pause, tunnel `publicCheck`, the Owner's sending address, and `sendersWithoutRoute` (active
    users with a current address whose `routeStatus ≠ "ok"`);
  - `modeBlockersFor(mode, gate)` (:171);
  - `goLiveBlockersFor(gate)` (:178-185);
  - `replyTestBlockersFor`, `saveTestList(actor, addresses)` (:451-476) and `normaliseTestList`.
- **Where it is shown:** only Settings › Sending (`load.ts:163, 400` → `page.tsx:107-121`). The Domain checklist,
  Get started and the wizard don't show it.
- **Owner actions nearby** (`app/(app)/settings/sending/actions.ts`): `setSendingModeAction({mode})` (:105-130)
  checks `modeBlockersFor` and logs `sending.modeChanged` with the `MODE_WORDS`. `saveTestListAction`,
  `pauseAllAction`, `resumeSendingAction`, `saveRetentionAction`, `connectMailgunAction`, `continueFollowUpsAction`
  and `checkWithMailgunAction` all follow the same pattern: `requireOwnerAction` + `runAction` +
  `revalidatePath("/", "layout")` for anything the top bar shows. A go-live action fits here.
- **The confirmation pattern to copy:** `components/settings/sending/sending-mode-form.tsx:123-143` (Dialog, "Switch
  to live").

### 3.3 `countsAsEmailed` and every place pre-go-live LIVE rows are treated differently (M3 §1.7)

`core/rules/mode.ts`:
- `countsAsReal(mode, practiceCopy)`: caps, warm-up, health, reply linking;
- `realModes(p)`;
- `countsAsEmailed(mode, {practiceCopy, goLive}) = countsAsReal && !(LIVE && !goLive)`;
- `emailedModes(ctx)`;
- `modeLabel`.

| Place | Before go-live | What happens to those rows when go-live flips (today's code) |
|---|---|---|
| `eligibility.ts:347-357` `loadHistory(… emailedModes …)` | LIVE rows not history | become history: test mailboxes blocked for the rest of the 30 days |
| `launch.ts:437` reservations at launch | none for LIVE | judged at launch (correct) |
| `loop.ts:744-750` `ensureReservation` at send | none | a still-running pre-go-live campaign starts taking reservations |
| `control.ts:224` (resume), `:486` (retry) | none | same |
| `mark-sent.ts:329-330` `recordRealContact` | skipped | later steps of a pre-go-live campaign mark the test companies CONTACTED, `lastEmailed*` |
| `core/replies/kind.ts:66-82` `replyScope` (via `process.ts:248`, `actions.ts:373`) | `changesStatus: false` for LIVE | a reply to an old test email sets the company to Replied (the scope is stored per message, so earlier rows keep theirs) |
| `companies/detail.ts:264-289` test-send lookup | "Test email sent … (test list, …)" when `lastEmailedAt` is null | still shown (it keys on `lastEmailedAt`, not go-live) |
| `companies/detail.ts:342-351`, `queries.ts:1000-1023`, `components/campaigns/format.ts:809-861`, `core/sequences/wording.ts:64-73`, `company-panel/emailed-text.ts:39-49,175-176,236` | suffix " (test list)" | suffix dropped: old test sequences look like real ones |
| `eligibility.ts:620` `testListCountsAsChecked: !(launchedGoLive ?? goLive)` | test list counts as checked | judged at launch (M5 D31); campaigns launched before M5 (`null`) use today's value |
| `loop.ts:554`, `send-guard.ts:49` (current `goLive`) | test list only | anyone. Harmless for old campaigns (their recipients were test-list at launch) |
| `apply.ts:127`, `usage.ts:78,158`, `warmup-days.ts:53`, `replies/link.ts:145,165` | `countsAsReal`/`realModes` | unchanged: LIVE always counted for caps, health, warm-up and reply linking |

Candidate carrier: `Campaign.launchedGoLive` (M5 column, `schema.prisma:528-529`, written at `launch.ts:532`). A LIVE
campaign with `launchedGoLive === false` stays a test-list campaign for good. Rows from before M5 (`null`) would need a
backfill or a `goLiveAt` cut-off (M3 §9.3: "ignore LIVE rows with `sentAt` before go-live"). DB filters that use
`emailedModes` (only `loadHistory`) would need a join on the campaign or a `sentAt` bound.

### 3.4 The test-list guard (three layers)

1. **Launch and audience:** `personReasons` gives `not-on-test-list` (blocking, not overridable) for TEST/LIVE while
   `!goLive` (`core/rules/eligibility.ts:335-338`). `launchModeProblems` (`launch.ts:107-151`) → `liveLaunchBlockers`
   also refuses an **empty test list** (`mode-gates.ts:161`), whatever go-live is: an M6 gap.
2. **Final check before hand-over:** `finalCheckLocked` (`loop.ts:531-555`): `!guard.goLive &&
   !guard.testList.has(toNorm)` → skipped with `NOT_ON_TEST_LIST` (`loop.ts:500-504`). The test list is read fresh.
3. **Mailgun client:** `checkSendGuard` (`send-guard.ts:37-53`), fed by `loadSendGuard`. It throws
   `MailgunError {kind:"guard"}` before any request.

Other test-list uses: `test-send.ts:375` (reply test), `mail-events/internal-senders.ts:43-78` (test-list addresses are
"internal" senders), `mailgun/suppressions.ts:318` and `settings/deliverability` Remove (only test-list addresses and
reply inboxes).

### 3.5 `launchedGoLive` (M5)

Written once at launch (`launch.ts:532`, from `settings.goLive`). Read only by `recheckRecipient`
(`services/eligibility.ts:591, 620`) for the "test list counts as checked" exception. The separate `not-on-test-list`
rule and the loop guard use today's go-live (M5-DESIGN §2.8).

### 3.6 Labels and mode words after go-live

- `core/sending/label.ts:40-108` `sendingLabel({pause, mode, goLive, activeRealCampaigns})`, first match wins:
  1. paused;
  2. `goLive && (mode === "LIVE" || live > 0)` → "Sending live" (green);
  3. LIVE → "Test list only";
  4. **TEST → "Test list only" even after go-live** ("New campaigns use Mailgun's test mode: emails to your test list are
     accepted but never delivered."), although after go-live TEST campaigns reach anyone eligible (`not-on-test-list`
     is off, and the guard passes);
  5. dry run with live/test campaigns → "Test list only";
  6. "Dry run".
- `components/shell/sending-pill.tsx:19-33`: the fallback `labelFromState()` hard-codes `goLive: false` (only used when
  the full load fails). It links to `/settings/sending` for the Owner.
- `wizardModeText` (`wizard-frame.tsx:9-10`) gets `goLive` only on the Verify page.
- `modeLine` (Schedule), `MODE_OPTION_TEXTS.LIVE`, `MODE_WORDS.LIVE`, `liveConfirmText` and `TEST_LIST_TEXTS.hint` are
  all static pre-go-live words (§1.1).
- A6 labels: `Dry run` / `Test list only` / `Sending live` / `Paused: …`. The README table (`README.md:58-63`) mirrors
  them.

### 3.7 The reply test lock

- `liveLaunchBlockers` (`mode-gates.ts:147-163`) refuses LIVE launches until Setup A **and** the reply test has
  "passed" on the current domain (`replyTestPassedOnDomain`).
- The sending loop holds LIVE rows with `live-not-ready` when Setup ≠ A or tracking/unsubscribe drifted
  (`isLiveReady`, `gates.ts:671`).
- `goLiveBlockers` needs `replyTestPassed` too.
- `connectMailgun` resets the reply test when `mailgun.domain` changes (M3 §1.5), so after go-live a domain change
  locks live launches again while `sending.goLive` stays true.
- The reply test (`settings/domain/actions.ts:74-150`, `reply-test.ts:394-443`) always uses the test list. It can be
  repeated after go-live, but after go-live LIVE campaigns to those mailboxes count as emailed (30-day rule).

### 3.8 Warm-up: when it starts

- The state lives in SystemState `warmup`: `WarmupState {domain, step, lastEvaluatedCapDay, startedCapDay, history[≤60]}`
  (`core/system-state.ts:98-107`).
- Initialised or restarted by `evaluateWarmupDays` (`warmup-days.ts:140-146`) when `state.domain ≠ mailgun.domain`:
  `step 0`, `lastEvaluatedCapDay = yesterday`, `startedCapDay = today`.
- It runs from the hourly `warmup.evaluate` job (`periodic.ts:132-140`, **also in the practice copy and before
  Mailgun is connected**) and after every successful catch-up.
- **So the ramp "starts" when a sending domain is first saved, not at go-live or at the first live send.**
- It advances one step per closed sending day with used ≥ `warmup.minUsePercent` (50 %) of that day's scheduled cap
  and healthy counts (`evaluateWarmupDay`, `core/sending/warmup.ts:75-95`). Test-list sends count (`realModes`) but
  rarely reach 25, so each day before go-live is `hold-low-use`.
- `getTodayCap` (`usage.ts:52-115`) uses step 0 when `warmup.domain ≠ mailgun.domain`.
- Nothing references go-live. If M6 wants "warm-up starts at go-live", `updateTyped(STATE_KEYS.warmup,
  parseWarmupState, …)` can set `startedCapDay` / `lastEvaluatedCapDay` at the switch (and keep or reset `step`).
- `warmupProgressText(step, table)` (`core/sending/warmup.ts:101-107`: "Day 9 of 20 · tomorrow's limit 207") exists and
  is **unused**. The Limits page uses `todayLimitLine` (`limits-format.ts:124-128`).

### 3.9 Decisions and gaps for M6's go-live

- The switch itself:
  - an Owner action that re-runs `goLiveBlockersFor(await loadGateInputs())` server-side;
  - a confirmation dialog;
  - writes `sending.goLive = true` (+ a go-live time), logs activity and revalidates `/`;
  - maybe sets `sending.mode = "LIVE"` ("switch new campaigns to live", A8);
  - maybe a "switch off" path (PLAN is silent).
- Pre-go-live LIVE rows after the switch (§3.3), including a pre-go-live campaign still running.
- `liveLaunchBlockers` and the empty test list after go-live.
- The TEST label after go-live, and the mode words (§3.6).
- What happens to go-live when the sending domain changes or the reply test is reset.
- Access optional (Q11): the `remote-access` row as a warning (M3 §9.3).
- Test mailboxes after go-live: they become ordinary emailed addresses (30-day rule, statuses). Repeating the A8 M3/M4
  tests after go-live would then be blocked for 30 days.

---

## 4. Dashboard data sources

SPEC §11 / A6: attention first, then pipeline, today vs cap + warm-up, domain health, active campaigns, recent
activity; B6.5: dry run "shown separately"; B6.14: the backup warning at 36 h. The dashboard is for everyone (Members
too), while several loaders below live in Owner pages (they need no Owner check themselves).

| Tile | Existing source (signature) | Notes / gaps |
|---|---|---|
| Company status counts | `countCompaniesByStatus(filters)` → `StatusCounts {all, byStatus}` (`services/companies/query.ts:153-166`); `COMPANY_STATUSES` | pass `{}`; the Contacts `StatusTabs` shows the same numbers |
| Reply rate | **none** | needs a definition. Options: replied companies / contacted (`firstContactedAt`, `lastEmailedAt`), or persons with a REPLY `InboundMessage` / emailed persons. `CampaignResults.replied` (`queries.ts:376-380, 498-505`) = distinct persons with `kind REPLY` per campaign. Dry run is separate |
| Sent today vs cap | `getTodayCap(now, {practiceCopy?})` → `TodayCap {cap, used, left, testSends, source, override, aboveSchedule, warmupCap, warmupStep, warmupSteps, maxCap, capDay, capZone, bySender}` (`services/sending/usage.ts:19-115`) | `used` counts LIVE (+ DRY_RUN in the practice copy) and test sends; **dry-run sends today have no counter** (B6.5 "separately") |
| Warm-up progress | SystemState `warmup` via `readTyped(STATE_KEYS.warmup, parseWarmupState)`; `warmupTable(startCap, maxCap, steps)` (`core/sending/caps.ts:17`); `warmupProgressText` (unused); `warmupHistoryLine`, `warmupRows` (`limits-format.ts`) | A6: "day 9 of 20, tomorrow's limit 207" |
| Health rates + thresholds | `loadHealthView(tz, now)` → `HealthView {thresholds, counts, bounceLine, complaintLine, bounceLimit, complaintLimit, bounceNote, complaintNote, sinceNote, practiceCopy}` (`services/mail-events/deliverability.ts:31-110`); underneath `loadHealthCounts({since, before?, bounceWindow, complaintWindow, practiceCopy})` (`usage.ts:144-202`); `MAILGUN_LIMITS` (`core/sending/health.ts:11`); `HealthCard({bounce, complaint, sinceNote})` (`components/settings/deliverability/health-card.tsx:29`) | B6.6: show next to Mailgun's own limits; the since-resume baseline comes from `STATE_KEYS.healthBaseline` |
| Active campaigns + progress | `listCampaigns(tab, {page?, pageSize?})` → `CampaignListItem {…, progress, firstEmail, sent, audience, mode, pauseReason}` (`services/campaigns/queries.ts:171-231`); `countCampaignsByTab()` (:59); `toCampaignListView(c, tz, now)` (`components/campaigns/format.ts:1110`); `ProgressBar`, `CampaignList`, `CampaignProgressCard`; per campaign `getCampaignOverview(id)` (:320-511, results + steps) | "running" and "scheduled" tabs; mode for the dry-run split |
| Recent team activity | `queryActivity(filters, tz, pageSize)` → `ActivityPage` (`app/(app)/activity/activity-query.ts:63-105`, an app file, not `server/`); `ActivityFilters` in `components/activity/activity-filters.ts`; `ActivityRow.mode` | take page 1 with a small `pageSize` |
| Replies waiting per user | `waitingReplyCount(userId)` (`server/notifications.ts:296-306`: processed, unanswered, WAITING_KINDS, **excludes** `replyScope "campaign"`); `listWaitingReplies(viewer, {scope, page, now})` → `{mine, everyone, rows…}` (`services/replies/waiting.ts:218-238`, **includes** dry-run); `listTeam()` groups by `assigneeId` with `waitingRepliesWhere` (`services/users.ts:102-104, 133`, no `processedAt` filter) | **Three definitions**, no per-user groupBy with the bell's rule. A6: "You 3 · Ali 1"; M4-DESIGN:1027 says the tile counts `replyScope ≠ "campaign"` |
| Held follow-ups (outage) | `outageHoldSummary()` (`services/sequences/holds.ts:794`), `myOutageHold(userId)` (:830), `buildOutageView(summary, state, {zone, now, logRetentionDays})` (`settings/sending/load.ts:75-150`, `server-only`) | M4 §1.4 lists it as a dashboard tile |
| AI lines waiting | `aiQueueCounts()` → `{waiting}`, `tabCounts()` (`services/ai/queue.ts:84-99`); AI pause `getAiPause(now)` (`services/ai/pause.ts:53`) | the layout already loads `aiQueueCounts` |
| Paused campaigns and why | `listCampaigns("paused")` (`pausedAt`, `pauseReason`); `pausedText(pausedAt, reason, tz)` (`components/campaigns/format.ts:221`); the global pause `getPauseState()` (`services/sending/pause.ts:38`) + `pausedWithReason` (`core/sending/label.ts:30`); the checks pause `getChecksPause(now)` (`services/verification/pause.ts:39`) | a switched-off sender pauses with `switchedOffPauseReason` (`users.ts:454`) |
| Companies missing emails | `getContactsSidebar().missingEmailCount` (`companies/query.ts:177-197`, also counts every list), or `db.company.count({where: buildCompanyWhere({view:"missing-email"})})` | link `/contacts?view=missing-email` |
| Background sender problem | `getWorkerStatus(now)` → `{running, lastSeen}` (`server/worker-status.ts:4-10`, lease heartbeat < 60 s); `workerStatusText(status, now, tz)` (`components/settings/worker-status-text.ts:17-33`) | its wording "Not running since 14:02 — double-click start.bat" isn't A6's "The background sender hasn't checked in since 14:02, so no emails are going out. Restart the PC or double-click start.bat." The campaign page has its own sentence (`campaigns/[id]/page.tsx:215-218`) |
| Remote access (tunnel) | `readTyped(STATE_KEYS.tunnel, parseTunnelState)` + `remoteAccessView(t, publicUrl(), now, tz, isFakeMode())` (`components/settings/remote-access-card.tsx:30`); `RemoteAccessCard` (:111) | written by `worker/monitor.ts` (tunnel every 5 min, public address every 30 min) |
| Mailgun / catch-up problems | `STATE_KEYS.catchUp` via `parseCatchUpState`; the "failing" rule is inline in `checkWithMailgunView` (`settings/sending/load.ts:300-329`, not exported); the domain check rows via `loadGateInputs().rows` | reuse by exporting a helper |
| Backups | `listBackups()[0]` + `BACKUP_STALE_MS` (`services/backups.ts`) | the dashboard warning is missing; also no backup at all; `listBackups` reads the disk (fine in the web process) |
| Restore in progress | `STATE_KEYS.restore` via `parseRestoreState`, `restoreHoldActive` | only shown inside the pause card today |
| Top-bar status | `getSendingLabel()` → `{state, label, activeRealCampaigns}` (`server/sending-state.ts:30`) | already in the layout |
| Live refresh | `LiveRefresh({active, intervalMs})` (`components/campaigns/live-refresh.tsx:31`, `router.refresh` polling, pauses while hidden) | B6.14: no SSE |
| Dry run shown separately | **none**: every counter above is `realModes`-based (DRY_RUN counts only in the practice copy) | needs DRY_RUN counts (sent today, results) kept apart |

Also useful: `getSendingLabel().activeRealCampaigns`, `countCampaignsByTab()` and `campaignHolds(id)` for possible-reply
holds (`queries.ts:292`). There is no `GET /api/campaigns/:id/progress` (B7 lists it; the campaign page polls with
`LiveRefresh` instead).

---

## 5. Settings

### 5.1 Every page today (`components/settings/settings-nav.tsx`; `OWNER_SETTINGS` order pinned by `tests/unit/setup-core/ui.test.ts:50`)

| Page | Guard | Sections | Orange button |
|---|---|---|---|
| `/settings` | `requireUser` | redirect to `/settings/profile` | — |
| My profile `profile/page.tsx` | `requireUser` | Profile (`ProfileForm`: name, email, sender display name, sending address + reply-route status, reply inbox, signature, time zone); Change password | Save (profile-form:207) |
| Notifications `notifications/page.tsx` | `requireUser` | Pop-ups on this computer; What pops up (metadata title "Notification settings") | none |
| Backups `backups/page.tsx` | `requireUser` (the second folder is Owner-only in the form and the action) | §2.4 | Back up now |
| Sending & Mailgun `sending/page.tsx` | `requireOwner` | fake banner; pause card; Mailgun connection (region, domain, API key, sending key, Advanced retention, Remove saved keys); Check with Mailgun (+ outage rows, Continue follow-ups); Sending mode; Test list; Go live (disabled); Pause all sending; For Mailgun (webhook URLs, outbox) | Resume sending (paused) or Save and connect (not connected); otherwise none |
| Domain checklist `domain/page.tsx` | `requireOwner` | practice / not-connected empty states; Apply recommended settings + Check again (title row); setup steps; checklist rows (+ senders' routes, domain age); Reply test | Apply (always) |
| Limits & warm-up `limits/page.tsx` | `requireOwner` | Today (limit, used, waiting line, override + Change today's limit); Warm-up schedule + Recent days; Sending hours and limits (`LimitsForm`: window, default zone, max cap, min gap, cap-day zone, warm-up start / steps / min use); Per-sender limits | Save limits |
| Deliverability `deliverability/page.tsx` | `requireOwner` | HealthCard; Bounces / Complaints counted now; Thresholds (+ warm-up health %); Address checks (paused card, policy / price / limit / included / max age / concurrency, check key, test checks); Do-not-email list | Thresholds save, or Resume checks while paused |
| Email footer `footer/page.tsx` | `requireOwner` | one Card without a header: company name, address, unsubscribe line, portfolio URL, preview | Save footer |
| AI `ai/page.tsx` | `requireOwner` | fake banner; pause card; Anthropic key; Model (built-in `MODEL_PROFILES` + custom model); Monthly limit; Prices; How websites are read | Save key, or Resume drafting while paused |
| Team `team/page.tsx` | `requireOwner` | `TeamManager` renders its own `SettingsTitle` (client component): invite, links, switch off/on, make Owner | Invite |
| System `system/page.tsx` | `requireOwner` | Background sender; Remote access (Check now); Addresses; This installation (version, Node, database file, Backups, outbox) | none |

### 5.2 Inconsistencies found

- **Titles and layout:**
  - the Notifications page's metadata title is "Notification settings", while the nav and heading say
    "Notifications";
  - Team's title comes from a client component;
  - Footer has no card header;
  - Domain puts its actions in the title row;
  - the nav comment says "the five sending pages".
- **Save patterns (two styles), often in the same file:**
  - a fixed message, `runAction(fn, "Saved.")` (Backups, Footer, Notifications, System, Deliverability thresholds and
    list; parts of Sending, Limits, Domain, Profile);
  - a computed message, `let message; …; return res.ok ? {...res, message} : res` (AI, Deliverability checks, Team
    switch-off, `saveLimitsAction`, the rest of Sending, Domain and Profile).
- **`revalidatePath` targets vary:** `("/", "layout")` for mode, pause and resume; `("/settings", "layout")` for
  connect; page paths elsewhere.
- **The client forms use `startTransition` + `toast` + `router.refresh()`.** No Settings form uses `useActionState` /
  `useKeepValuesSubmit`, which CONVENTIONS describes.
- **Orange buttons:**
  - one per page, but it's decided by a `primary` prop (`ThresholdsForm`, `AnthropicKeyForm`,
    `ConnectionForm.view.primary`) or by the pause cards;
  - Domain's Apply stays orange even when everything is green;
  - Backups gives Members an orange "Back up now".
- **Owner-only guard:**
  - pages use `requireOwner()`, which redirects Members to `/contacts?notice=owner-only` (`lib/auth/dal.ts:38`), not
    to the dashboard;
  - actions use `requireOwnerAction`;
  - Backups is the only mixed page;
  - Member-refusal tests exist per area (`ai-screens/settings-ai.test.ts:297`, `mailgun-setup/actions.test.ts:89`,
    `sending-m3/settings-actions.test.ts:102`, `mail-events/actions.test.ts:69`, `team/team.test.ts:271`), but none
    for the backup actions and no single sweep (B7).
- **Wording that goes stale at go-live:** the Sending page's go-live card, `MODE_*` texts and `TEST_LIST_TEXTS` (§1.1).
- **"Settings › Sending & Mailgun":** the pill and several texts link or refer to it consistently. A Member sees the
  pill as plain text.

### 5.3 B6.14's settings list and SPEC §12

| Setting | Key (default) | Editable where | Status |
|---|---|---|---|
| Test list | `sending.testList` ([]) | Sending › Test list (`TestListEditor`, `saveTestListAction`) | exists |
| Shared-domain list | `sharedDomains.extra` ([]) | — | **missing** (read by eligibility, imports, company create/mutations, AI select, drafter) |
| Cap-day zone | `sending.capDayTimeZone` (Asia/Karachi) | Limits › Sending hours and limits | exists |
| Default zone | `defaultTimeZone` (Europe/Berlin) | Limits › Sending hours and limits | exists |
| Mailgun retention | `mailgun.logRetentionDays` (5), `mailgun.messageRetentionDays` (1) | Sending › connection › Advanced (`saveRetentionAction`) | exists |
| Paused-reservation expiry | `reservations.pausedExpiryDays` (14) | — | **missing** (read by `reservations.ts:288, 320`) |
| Verification provider | `verification.provider` ("mailgun") | — | **missing, and the key is read nowhere** (M5 deferred ZeroBounce/NeverBounce; `other-maps.ts` exists) |
| Verification key | secret `verification.apiKey` | Deliverability › Address check key | exists |
| AI profiles and prices | `ai.model`, `ai.customModel`, `ai.prices`, `ai.monthlyLimitUsd` | Settings › AI | exists |
| 30-day team rule length (SPEC §12) | `teamRule.days` (30) | — | **missing** (read by `services/eligibility.ts:79-91`, `core/rules/team-rule.ts:67`) |
| Backups kept | `backups.keep` (14) | — | not required (SPEC: keep 14) |
| Second backup folder | `backups.secondFolder` | Backups › Second copy | exists |
| Sending domain, region, keys; DNS checklist; cap, warm-up, window; verification policy and price; health thresholds; footer, portfolio, AI model; users; profile, notifications | … | Sending, Domain, Limits, Deliverability, Footer, AI, Team, Profile, Notifications | exist |

---

## 6. Tests

### 6.1 Existing end-to-end tests (fixed clock, fake Mailgun / fake Claude, fixture sites; nothing reaches the network)

| File | Covers |
|---|---|
| `tests/integration/milestone2/end-to-end.test.ts` | real-data dry run: Contacts selection → draft from the master template → audience → Review exactly as sent → per-person edit → launch → worker → outbox, campaign page, Sequence column, panel → 30-day rule; M4 follow-ups in thread + simulated reply; practice-copy first-email campaign counts as contact |
| `tests/integration/milestone3/end-to-end.test.ts` | connect → Apply → sending address → test list → Live; live launch refused until the reply test passes; reply test; live campaign to 3 test mailboxes (paced); signed delivered/bounce/complaint; catch-up idempotent + warm-up evaluate; Setup B; reconciler after a lost answer; Pause all / Resume |
| `tests/integration/milestone4/end-to-end.test.ts` | Part A practice copy (days as minutes): signed bounce/unsubscribe, follow-ups in thread, signed reply → Replied + stops company, simulated OOO / unclear, answered, finished, **who got which notification** (test 11). Part B real data **go-live off**. Part C outage hold |
| `tests/integration/milestone5/end-to-end.test.ts` | Part A (SPEC DoD with AI): import 5 companies → draft lines via the worker's ai lane → approve / edit / reject + undo → practice-copy dry run with 2 follow-ups → signed bounce, unsubscribe, reply → recipients stopped, follow-ups only to 2, campaign finished, statuses, Ali's notification types. Part B: **go-live set by `setSetting`**, the Verify step, check run, launch, 24 h re-check. Part C: missing-emails round trip |

### 6.2 What SPEC "Testing and definition of done" / B12 still lacks

- **Dashboard numbers:** pipeline counts, reply rate, sent today, bounce and complaint rates (B12 step 6). There is no
  dashboard to assert.
- **In one run:** the Review step (M5 Part A calls `saveDraftSteps` / `launchDraft` directly; only M2 exercises
  Review), "the notifications each user received" for the Owner as well as Ali, and the person flags
  (`bouncedAt` / `unsubscribedAt`).
- **The go-live flow through the real action:** blockers → confirmation → label "Sending live" → a live campaign to a
  non-test-list address → reservations and statuses → warm-up start. Today it's only `setSetting("sending.goLive", true)`.
- **Backup and restore round trip** (§2.7), the backup actions, and a dashboard old-backup warning.
- **Screen checks (B12 "Playwright + axe"):** `package.json` has `test:e2e: playwright test`, but there is no
  `playwright.config.*` and no `tests/playwright/`.
- **B7's single "every Owner-only action refuses a Member" sweep:** coverage is per area only.
- Build and type checks: `npm run check` = typecheck + eslint + vitest. `next build` is run by the lead (CONVENTIONS
  forbids agents from running it).

### 6.3 Existing tests near M6 code

- Backups: `tests/unit/worker/backup-files.test.ts`, `tests/unit/worker/schedule.test.ts` (`isQuietHour`,
  `isBackupDue`), `tests/integration/worker/backups.test.ts`, `tests/integration/worker/periodic-cleanup.test.ts`.
- Scripts: `tests/unit/ops/backups.test.ts`, `restore-marker.test.ts`, `restore-script.test.ts`,
  `update-guard.test.ts`, `script-files.test.ts`.
- Restore: `tests/integration/sending-m3/restore.test.ts`, `restore-safety.test.ts`,
  `tests/integration/sequences/restore.test.ts`.
- Go-live and modes: `tests/unit/rules/mode.test.ts`, `sending-core/label.test.ts`, `sending-core/mode-gates.test.ts`,
  `unit/mailgun-client/send-guard.test.ts`, `integration/sending-m3/modes.test.ts`, `launch-control.test.ts`,
  `settings-actions.test.ts`, `sequences/team-rule.test.ts`, `sequences/settings-sending.test.ts`,
  `replies/scopes.test.ts`, `company-panel/who-emailed-m4.test.ts`, `campaigns/launch-guard.test.ts`.
- Warm-up and health: `unit/sending-core/warmup.test.ts`, `health.test.ts`, `caps.test.ts`,
  `integration/sending-m3/health-warmup.test.ts`, `warmup-readiness.test.ts`.
- Dashboard-adjacent: `notifications-summary/*`, `notifications-page/page.test.ts`, `campaign-pages/queries.test.ts`,
  `team/activity.test.ts`, `unit/team/worker-status-text.test.ts`, `unit/checks/remote-access.test.ts`.
- Helpers to reuse: `tests/integration/helpers/{test-db,mailgun,claude,replies}.ts`, `tests/fake-mailgun`
  (`signedEventRequest`, `/__fake/inbound` presets), `tests/fake-claude`, the fixture sites.

---

## 7. Docs

### 7.1 SPEC's README requirements vs what exists

| SPEC item | Where it's covered today | Gap |
|---|---|---|
| Installing and the first run | `README.md:9-25` (short) + `docs/setup/1-install.md` §1–§8 | fine; README says "Milestone 5" |
| Mailgun domain and DNS (SPF, DKIM, DMARC, MX) and the inbound routes | `2-mailgun-and-dns.md` §2–§8, §11, §15 | fine |
| Turning off open/click tracking, turning on unsubscribe handling | `2-mailgun-and-dns.md` §11 (Apply + manual fallback) | fine |
| Cloudflare Tunnel with optional Access | `3-cloudflare.md` §1–§16 | Access is written as required (and it's a go-live blocker); "optional" isn't explained (Q11 open) |
| Adding team members | **nowhere**: README has no Team section; guides only cover each person's sending address (`2-…` §12); PLAN A9 item 4 | **missing**: invite link, profile, sending address, reply inbox, Member vs Owner, switch off, reset-password.bat |
| Keeping the PC awake during sending hours (European hours = afternoon/evening PKT) | `1-install.md` §6.5 (setup-pc power) and §7 (active hours, "11:00 to 23:00 in Pakistan") | not in the README; no "what if the PC sleeps" line |
| Backups and restoring | `README.md:109-111` (restore), `1-install.md` §9 (restore steps) and §11 (`.env` copy) | **missing:** Back up now, the second folder (A9 item 5), how many are kept, the dashboard warning, restoring from the second folder or a named file, the restore report |
| (M6 additions) dashboard, go-live checklist and switch, Settings overview | — | **missing** |

### 7.2 Outdated or soon-outdated statements

- `README.md:5` status line "Milestone 5 of 6" and its milestone history; `README.md:7` "Installing the Milestone 5
  update"; `README.md:62` "(after go-live, Milestone 6)".
- `README.md:48` and `1-install.md:145`: "(the last 14 are kept)". Only true for the sender's daily and manual
  backups; `app-preupdate` / `app-prerestore` / `app-premigrate` accumulate (§2.7).
- `2-mailgun-and-dns.md:3, 35, 344, 373, 386`: milestone-labelled steps ("(Milestone 4)", "(Milestone 5)", "the
  Milestone 5 test"). `:207, :359`: "(Milestone 6)". `:212, :262`: mode "Live (test list only)". `:253` "Verify:
  test-list addresses count as checked" (only before go-live). `:261` repeatable tests (only before go-live).
- Q-numbers in owner-facing guides: `2-…:17, 21, 22` (Q8, Q10, Q1) and `3-cloudflare.md:19, 25` (Q11).
  `1-install.md:33` "You need it from Milestone 3 on". `1-install.md:23` "until I say so" (the builder's voice).
- `README.md:115-117` developer notes point to M3–M5 design docs and `seed-m5-manual.ts`; an M6 note will be needed.
- The Backups page's restore text (`settings/backups/page.tsx:186-189`) points at "Before a restore", which the page's
  own list never shows.
