# Milestone 3 code map: what already exists

Written 2026-09-23 from reading the code, not the plan. Paths are relative to the repo root. "M3" means
Milestone 3 "Mailgun" (PLAN.md A8 item 3). This file only describes existing code: where M3 plugs in,
what it must not break, and gaps found along the way. For WHAT to build, see PLAN.md B6.5–B6.11 and B7–B12,
plus `docs/dev/research/mailgun-*.md` and `cloudflare.md`.

---

## 0. The integration points that matter most

1. **Transport seam.** `transportFor(mode)` in `src/server/services/sending/transport.ts` throws for TEST and LIVE.
   `SENDABLE_MODES = ["DRY_RUN"]` gates both `pickDueEmails` and `sendOneEmail`. Adding modes there turns sending
   on immediately, with **no** window, cap, pacing, pause or health gate. Those gates must ship at the same time.
2. **Failure mapping.** `EmailTransport.send()` has one failure channel ("throws"), and `loop.ts` turns every
   throw into `failAttempt()`: retry after 1/5/15/60 min, then FAILED. B6.7 needs typed outcomes:
   400 → FAILED, 429 → requeue without counting, 401/403 → global pause, timeout/5xx → UNKNOWN.
3. **Launch gate.** `launch.ts:174-180` refuses anything but DRY_RUN with `CampaignError("… arrive in Milestone 3 …",
   "mode-not-ready")`. `draft.ts:1225` (`modeReady`) and three UI files say the same thing (§4.5).
4. **Sender snapshot fallback (safety).** `senderSnapshot()` silently uses the placeholder
   `<local>@your-sending-domain` and `@dry-run.invalid` Message-IDs whenever the sender has no `SenderAddress`,
   **in every mode**. M3 must refuse TEST and LIVE launches without a real sender address.
5. **markSent() is the single "sent" writer.** The reconciler should use it too. It flips ANY non-SENT row
   to SENT and is idempotent.
6. **Stuck rows.** Only DRY_RUN rows are reset (`resetStuckDryRunSends`). LIVE and TEST rows left in SENDING stay
   there, and `finishCheck` treats SENDING and UNKNOWN as still open. The reconciler (start-up + every 10 min) is
   missing.
7. **Worker loops.** `BackgroundWorker.holdLease()` runs `Promise.all([heartbeat, runner, sending, periodic])`.
   The event lane (1 s) and the reconciler loop go here and in `runOnce()`. Start-up work
   (restore marker, reconcile, catch-up) goes in `startup()`.
8. **Jobs.** The `JobType` union in `src/server/jobs.ts` already lists `mailgun.catchUp | mailgun.syncSuppressions |
   mailgun.applySettings | mailgun.syncRoutes | send.testEmail | campaign.finishCheck`. None of them is in
   `JOB_REGISTRY` (`worker/jobs/index.ts`), so enqueueing one today fails with "Unknown task type" and notifies the Owner.
9. **Periodic tasks.** Add entries to `PERIODIC_TASKS` (`worker/periodic.ts`). The handler calls
   `recordTaskSuccess(name)`. The checker runs every 10 min, which is too coarse for B8's 5-minute tunnel check.
10. **Global pause.** SystemState `"sending.pause"` with the shape `{ paused?: boolean; reason?: string }` is already
    **read** by `getSendingState()` (the top-bar pill) but nothing writes it, and the sending loop ignores it.
11. **Reply-route rule.** `no-reply-route` exists in `core/rules/eligibility.ts`, but neither `launch.ts` nor
    `recheckRecipient()` passes `senderHasReplyRoute`, so the rule never fires.
12. **Webhooks.** `src/proxy.ts` excludes `/api/**`. The auth-coverage test already has the two webhook routes
    commented out in `PUBLIC_ROUTES`. Route files must be exactly `src/app/api/webhooks/mailgun/{events,inbound}/route.ts`.
13. **Delivery counts.** The campaign page stats row is already wired to `OutboundEmail.deliveredAt/bouncedAt/
    complainedAt/unsubscribedAt` and to InboundMessage `REPLY`. The counts show 0 only because nothing writes these
    fields yet.
14. **Every schema table M3 needs already exists** (init migration). Only optional columns are missing (§5).

---

## 1. Sending engine

### 1.1 `src/server/services/sending/transport.ts`
| Export | Signature / value | Meaning |
|---|---|---|
| `OutgoingMessage` | `{emailId, campaignId, step, from (full From line), to, subject, text, html, messageId (no <>), inReplyTo, references (space-sep, no <>), sendId}` | What a transport gets. No tags, Reply-To, domain or test flag. |
| `TransportResult` | `{providerId: string; acceptedAt?: Date}` | Success result |
| `EmailTransport` | `interface { readonly mode: SendMode; send(m): Promise<TransportResult> }` | "Throws when it wasn't accepted" is the only failure contract. B6.8 also wants lookup and list-suppressions. |
| `DryRunTransport` | `new DryRunTransport(clock?)`; providerId = `dry-run:<messageId>` | Accepts at once |
| `SENDABLE_MODES` | `readonly SendMode[] = ["DRY_RUN"]` | Used by `pickDueEmails` and the `sendOneEmail` guard |
| `LIVE_NOT_READY` | `"Test mode and live sending arrive in Milestone 3."` | Used by launch.ts |
| `transportFor` | `(mode: SendMode) => EmailTransport` (sync) | Throws `LIVE_NOT_READY` for TEST and LIVE |

### 1.2 `src/server/services/sending/claim.ts`
| Export | Meaning |
|---|---|
| `claimEmail(emailId, now?) → Promise<boolean>` | Autocommit CAS through `dbWrite`: QUEUED→SENDING, `claimedAt`, `attempts+1`. **Never call it inside dbTx.** |
| `CAMPAIGN_CANCELLED_MESSAGE`, `CAMPAIGN_FINISHED_MESSAGE`, `endedCampaignMessage(status)` | lastError texts for ended campaigns |
| `ReleaseOptions {error?, dueAt?, countAttempt?}`, `ReleaseResult "queued"\|"cancelled"\|"lost"` | |
| `releaseClaim(emailId, opts)` | dbTx: SENDING→QUEUED, or CANCELLED when the campaign has ended. `countAttempt:false` decrements attempts, which suits the 429 path. |
| `STUCK_DRY_RUN_MS = 120_000`, `STUCK_DRY_RUN_MESSAGE` | |
| `resetStuckDryRunSends(now?, olderThanMs?) → number` | **DRY_RUN only.** Rows claimed more than 2 min ago go back to QUEUED (or CANCELLED when the campaign has ended). |
| `cancelEmailsOfCancelledCampaigns() → number` | Tidies QUEUED rows of CANCELLED campaigns, 500 per batch |

### 1.3 `src/server/services/sending/loop.ts`
- Constants: `SEND_BATCH = 25`, **`MAX_SENDABLE_STEP = 0`** (first emails only; follow-ups come in M4),
  `MAX_SEND_ATTEMPTS = 5`, `SEND_RETRY_DELAYS_MS = [1, 5, 15, 60 min]`, `sendRetryDelayMs(attemptsMade)`.
- Types: `RenderFn`, `SendingLogger`, **`SendingDeps {now?, transportFor?, render?, ownsLease?, signal?, settings?, logger?}`**
  (the test and injection seam), `SendOutcome = sent|skipped|retry|failed|lost|not-running|no-lease`, `TickResult`,
  `MaintenanceResult`.
- `promoteScheduledCampaigns(now)`: SCHEDULED→RUNNING when `startAt` is null or ≤ now.
- **`pickDueEmails(now, limit)`**: `status QUEUED, step ≤ MAX_SENDABLE_STEP, dueAt ≤ now, mode ∈ SENDABLE_MODES,
  campaign.status RUNNING`. Order: `recipient.company.priorityRank asc, dueAt asc, id asc`. There is no sending-hours,
  cap, pacing, pause, health or "unprocessed events" filter. B6.6 also wants "follow-ups first" once steps > 0.
  (`tests/integration/sending/query-plans.test.ts` asserts that this query uses an index.)
- `closedRecipientMessage(state, stopReason)`.
- **`sendOneEmail(emailId, deps)`** pipeline:
  ownsLease → `claimEmail` → load row → campaign ended ⇒ CANCELLED → recipient FINISHED, STOPPED or EXCLUDED ⇒ SKIPPED →
  campaign not RUNNING or mode not sendable ⇒ `releaseClaim({countAttempt:false})` → `recheckRecipient` on fresh data
  (fails ⇒ SKIPPED; the recipient is STOPPED with `stopReasonFor(reason)`) → if `countsAsReal` ⇒ `ensureReservation`
  (lost ⇒ SKIPPED "reserved") → render (`purpose:"send"`; throw ⇒ `failAttempt`) → store subject, text and html on the row
  (CAS on SENDING) → `transport.send()` (throw ⇒ `failAttempt`; the comment says "Dry run can't be ambiguous") →
  `markSent(id, acceptedAt, {providerId, practiceCopy})`. If markSent throws, the result is "lost" and the row stays SENDING.
- `failAttempt` (internal): if attempts < 5, `releaseClaim` with the error and a backoff `dueAt`. Otherwise the row
  becomes FAILED, the recipient becomes STOPPED (`FAILED_STOP_REASON="failed"`), `releaseCompanyIfDone`, and
  `email.failed` is logged.
- `sendingTick(deps)`: promote → pick → `loadEligibilitySettings()` once → `sendOneEmail` each → `finishCheck` for
  each touched campaign.
- `runSendingMaintenance(now)`: resetStuckDryRunSends, cancelEmailsOfCancelledCampaigns, `sweepFollowUps`,
  `expirePausedReservations`, and `finishCheck` for up to 200 RUNNING campaigns.

### 1.4 `src/server/services/sending/mark-sent.ts`
- **`markSent(emailId, acceptedAt, {providerId?, practiceCopy?}) → MarkSentResult {emailId, campaignId, alreadySent,
  counted, next, finished}`**. One dbTx. It uses `updateMany where status != SENT`, so it turns **any** status
  (SENDING, UNKNOWN, UNCONFIRMED, even CANCELLED, SKIPPED or FAILED) into SENT, sets `sentAt` and `providerId`, and
  clears `lastError`. A second call for a row that is already SENT changes nothing. When `countsAsReal`, it writes
  the company's `lastEmailed*` and `lastContactAt`, `firstContacted*` (CAS), NOT_CONTACTED→CONTACTED (CAS + activity
  `company.status`), and the person's `lastEmailed*`. It then advances the recipient (next enabled step ⇒ WAITING
  plus a new row, else FINISHED plus `releaseCompanyIfDone`; terminal recipients and CANCELLED campaigns are left
  alone) and logs `email.sent` (actor = senderId, `mode`).
- `followUpDelayMs(delayDays, {daysAsMinutes, mode})`: days count as minutes only for DRY_RUN.
- `nextEnabledStep(tx, campaignId, step)`, `createNextStepRow(tx, prev, next, {sentAt, daysAsMinutes})`: the new
  row keeps the thread. It gets a new messageId on the **previous id's domain**, a new sendId, `inReplyTo` =
  prev.messageId, and `references` = `nextReferences()`. It is idempotent on (campaign, step, toNorm).
- Sweeper: `SweepResult`, `findStuckRecipients(campaignId)`, `sweepFollowUps(now, limit=200)`.
  `IN_FLIGHT = QUEUED|SENDING|UNKNOWN|UNCONFIRMED` (the sweeper leaves such recipients alone).

### 1.5 `src/server/services/sending/addresses.ts`: the placeholder From rule
- `DRY_RUN_SENDING_DOMAIN = "your-sending-domain"`, `DRY_RUN_MESSAGE_ID_DOMAIN = "dry-run.invalid"`.
- `formatFromHeader(name, address)` quotes the name when needed and strips CR/LF. `senderLocalPart(loginEmail)`.
- `SenderSnapshot {fromName, fromAddress (bare), fromHeader (full line), sendingDomainId, messageIdDomain}`.
- **`senderSnapshot(user{name,email,senderDisplayName}, mode, senderAddress?{address,domainId,domainName})`**:
  `fromName = senderDisplayName || name`.
  - With an address: that address. `messageIdDomain` = `dry-run.invalid` for DRY_RUN, otherwise the domain name.
  - Without one: `<senderLocalPart(login)>@your-sending-domain` and `dry-run.invalid`, **whatever the mode**.
- `newMessageId(domain)` → `pp.<24 hex>@domain` (lowercase, no brackets). `newSendId()` → 32 hex.
  Also `messageIdDomainOf(id)` and `nextReferences(prevRefs, prevId)`.
- The caller picks the address. `launch.ts` and `draft.listSenderChoices()` both take the newest SenderAddress with
  `retiredAt null` on an `active` domain (`orderBy id desc, take 1`).

### 1.6 `worker/sending.ts`
- `SENDING_TICK_MS = 5000`, `SENDING_MAINTENANCE_MS = 300_000`.
- `SendingLoopOptions {ownsLease, logger?, transportFor?, render?, now?}`.
- `class SendingLoop { tick(signal): Promise<TickResult|null> /* never throws; maintenance first when due */;
  run(signal) /* re-ticks at once after a full, productive batch */; waitForIdle(ms) }`.
- `resetInterruptedDryRunSends(logger, now)` runs at start-up.
- `BackgroundWorker` builds `new SendingLoop({ ownsLease, logger })` with no transport, so production uses
  `transportFor` from transport.ts. `WorkerOptions` has no way to inject a transport.

### 1.7 `worker/main.ts` (life cycle), `worker/lease.ts`, `worker/lease-decision.ts`, `worker/index.ts`
- Lease constants: `LEASE_TTL_MS 60s`, `HEARTBEAT_MS 15s`, `LEASE_RETRY_MS 15s`, `LEASE_SAFETY_MS 45s`.
  `ownsLease(me)` is checked before every claim. Also `acquireLease`, `renewLease`, `releaseLease` (heartbeat set to 1970).
- Exports: `makeWorkerId()`, `sleep(ms, signal?)`, `WorkerOptions {workerId?, registry?, logger?}`,
  `class BackgroundWorker {id; isStopping; whenStopped(); run(); runOnce(); shutdown(reason)}`, `stopDecision()`,
  `runWorker({once})`, `selfTest()`, `backupOnce(kind)`.
- `startup()`: checkMigrations → `resetOrphanedJobs` → `resetInterruptedDryRunSends` → `runOneOffRepairs` →
  `runPeriodicCheck`. **M3 hooks:** restore marker, reconciler, catch-up enqueue, health check.
- `holdLease()`: `Promise.all([heartbeatLoop 15s, runnerLoop 2s, sending.run 5s, periodicLoop 10min])`.
  **M3 adds:** event lane (1 s) and reconciler (10 min).
- `loseLease()`: stopClaiming, abortCurrent, session.abort.
- `shutdown()`: waits ≤ 3 s (`SHUTDOWN_JOB_WAIT_MS`) for the runner and the sending loop, then releases the lease and
  disconnects, all within NSSM's 4 s. A Mailgun POST (30 s timeout, B6.7) can outlive this, and its row then stays
  SENDING. Such rows must be **reconciled, never reset**.
- `worker/index.ts` sets `OUTREACH_PROCESS=worker` **before** importing db (10 s busy timeout). It loads
  `dotenv/config` and accepts `--self-test`, `--once` and `--backup=KIND`. It waits while `run\update-in-progress`
  exists and runs the Node ABI guard.

### 1.8 Job runner and job registration pattern
- `worker/runner.ts`: `RUNNER_INTERVAL_MS 2000`, `PROGRESS_MIN_INTERVAL_MS 1000`, `JobOutcome`, `StopRequestedError`,
  `claimNextJob(workerId, now)` (order: priority desc, runAt asc, id asc; CAS), `requeueWithoutCounting`,
  `resetOrphanedJobs`, `runClaimedJob(job, {workerId, registry, signal, logger})`,
  `class JobRunner` (**one job at a time**).
  Outcomes: success ⇒ DONE (result JSON, `summary`). Throw ⇒ QUEUED again after 1/5/15 min
  (`worker/backoff.ts`) until `maxAttempts` (default 3), then FAILED and an Owner notification
  (`def.failureNotice` or the generic "task.failed"). Abort ⇒ requeued without counting the try.
- `worker/jobs/types.ts`: `FailureNotice {title, body, link?, type?}`,
  `JobDefinition {handler: JobHandler, label, whatToDo, link?, failureNotice?}`, `JobRegistry`.
- `worker/jobs/index.ts`: `JOB_REGISTRY = {"import.commit": {...}, "backup.run": backupJob, "system.cleanup": cleanupJob}`.
  **Pattern:** create `worker/jobs/<x>.ts`, export `<x>Job: JobDefinition`, and add its key here.
  `worker/jobs/backup.ts` shows a custom `failureNotice` and `recordTaskSuccess("backup.daily")`.
- `worker/jobs/cleanup.ts`: `CLEANUP_RULES.webhookTokensHours = 48` already deletes `WebhookToken` rows (by `receivedAt`).
- `worker/notify.ts`: `notifyOwner({type,title,body,link})` is a worker-local duplicate of the one in
  `@/server/notifications`, without link sanitising or truncation. Prefer `@/server/notifications`.
- `worker/repairs.ts`: `ONE_OFF_REPAIRS` pattern (SystemState `repair.<name>`, runs once per database).
- `worker/log.ts`: `log`, `Logger`, `createThrottledLogger(logger).error(key,msg,err)/.clear(key)`.

### 1.9 `worker/periodic.ts` and `worker/schedule.ts`
- `PeriodicTask {name, intervalMs, retryAfterMs, due?(now, lastSuccess, ctx), enqueue(now)}`.
  `DueContext {timeZone}` comes from Setting `sending.capDayTimeZone` (fallback Asia/Karachi).
- `PERIODIC_TASKS = [backup.daily (isBackupDue, quiet 22–08), cleanup.daily (isDailyDue)]`, `CLEANUP_DEDUPE_KEY`.
- `taskStateKey(name)` → `"task.<name>"`. `readTaskState`, `recordTaskSuccess(name, at?)`,
  `checkPeriodicTasks(now, tasks, logger)`. The state `{lastSuccessAt, lastEnqueuedAt}` is stored as ISO strings via CAS.
- `schedule.ts` (pure): `MINUTE_MS/HOUR_MS/DAY_MS`, `PERIODIC_CHECK_MS = 10 min`, `QUIET_START_HOUR 22`,
  `QUIET_END_HOUR 8`, `BACKUP_OVERDUE_MS 36h`, `hourInTimeZone(now, tz)` (Intl), `isQuietHour`, `isBackupDue`,
  `isDailyDue`, `mayEnqueueAgain`, `parseDate`. These fit catch-up (hourly), the DNS check (6 h) and warm-up
  (daily). They do **not** fit the 5-minute tunnel check.

---

## 2. Campaigns

### 2.1 `src/server/services/campaigns/launch.ts`
- `LAUNCH_CHUNK 500`, `LaunchOptions {startAt?, now?}`, `ExclusionSummary`, `LaunchResult {campaignId, status, mode,
  startAt, queued, newlyExcluded, excludedReasons, excludedTotal, lost[], message}`, `LAUNCHING_TEXT`, `isLaunching(id)`.
- **`launchCampaign(campaignId, actorId, opts)`** steps:
  1. Check the draft.
  2. **Mode:** `const mode = (await getSetting("sending.mode")) as SendMode; if (mode !== "DRY_RUN") throw new
     CampaignError(`${LIVE_NOT_READY} Until then, sending must be set to dry run (Settings › Sending) to launch a
     campaign.`, "mode-not-ready")` (**lines 174-180**).
  3. Start time (past ⇒ now; future ⇒ SCHEDULED).
  4. `evaluateCompanies(..., {mode, campaignId, now, settings, recipients, personIds, senderName})`. `senderHasReplyRoute`
     is **not passed**.
  5. `senderSnapshot(sender, mode, newest SenderAddress | null)`.
  6. `takesReservations = countsAsReal(mode, practiceCopy)`.
  7. `writeChunk` per ≤ 500 people: reservations, exclusions, and step-0 rows with `fromAddress = fromHeader`
     (full line), `messageId = newMessageId(snapshot.messageIdDomain)`, `sendId`, `dueAt = startAt`, `mode`.
  8. `finalizeLaunch` does a CAS on DRAFT and senderId, writes `Campaign.mode/fromName/fromAddress (bare)/
     sendingDomainId/startAt/launchedAt`, logs `campaign.launched`, and sends notification `campaign.sender`.
     For every non-dry-run mode its body says "Replies to its emails will come to your inbox.", including TEST.
- `draft.ts`: `launchDraft(actor, id)` (checks the message, `syncExclusionReasons`, then `launchCampaign`),
  `loadLaunchSummary(id) → LaunchSummary` (`modeReady: mode === "DRY_RUN"`, line 1225),
  `listSenderChoices() → SenderChoice {id,name,email,fromName,fromLine,placeholderAddress,signature}` (lines 323-373).
- `audience.ts:180` `draftSendingMode()` returns Setting `sending.mode`, normalised to DRY_RUN|TEST|LIVE.
- `app/(app)/campaigns/[id]/setup/load.ts` `loadWizardDraft()` adds `mode` for the wizard frame.
- `app/(app)/campaigns/[id]/setup/actions.ts` `launchAction({campaignId})` calls `launchDraft`.

### 2.2 `src/server/services/campaigns/control.ts` (pause, resume, cancel, retry, skip)
| Export | Behaviour |
|---|---|
| `OPEN_RECIPIENT_STATES` = PENDING, SCHEDULED, WAITING, HELD, RECHECK; `FAILED_STOP_REASON="failed"` | |
| `finishCheck(campaignId, {now})` | RUNNING only. "Open emails" = QUEUED/SENDING/UNKNOWN (**UNCONFIRMED counts as done, as "didn't send"**). "Open recipients" = SCHEDULED/WAITING/HELD/RECHECK. When nothing is open: FINISHED, reservations released, `campaign.finished` logged, sender and creator notified (wording per mode). |
| `pauseCampaign(id, actorId, {reason?, now?})` | RUNNING or SCHEDULED → PAUSED, `pausedAt`, `pauseReason` (default "Paused by X"), sets reservation expiry. Campaign-level only. |
| `resumeCampaign(id, actorId, {now?})` | → RUNNING, or SCHEDULED when the start is in the future. Clears expiry and retakes reservations when real, then runs finishCheck. |
| `cancelCampaign(id, actorId, {now?})` | → CANCELLED. QUEUED rows become CANCELLED, open recipients STOPPED `campaign_cancelled`, reservations released. A row already SENDING finishes. |
| `skipRecipient(recipientId, actorId)` | QUEUED rows → SKIPPED "Skipped by X", recipient STOPPED, `sendingNow` flag. **UNKNOWN and UNCONFIRMED rows are left untouched.** |
| `retryEmail(emailId, actorId)` | Only FAILED or **UNCONFIRMED**. → QUEUED, `dueAt` now, `attempts 0`, `claimedAt null`, **same Message-ID**. A STOPPED("failed") or FINISHED recipient goes back to SCHEDULED/WAITING, a FINISHED campaign back to RUNNING, and the reservation is retaken. **No double-send warning** for UNCONFIRMED. |
| `EDIT_LIMITS`, `editUnsentEmail`, `discardUnsentEdit` | CAS on QUEUED. Otherwise `SENDING_NOW`. |
- `errors.ts`: `CampaignError(message, code)`, `CAMPAIGN_GONE`, `RECIPIENT_GONE`, `EMAIL_GONE`, `SENDING_NOW`.
  Actions map it with `if (err instanceof CampaignError) throw new UserError(err.message)`.

### 2.3 Eligibility: `src/server/services/eligibility.ts` and `src/core/rules/**`
- `EligibilitySettings {days, practiceCopy, maxCheckAgeDays, policy, testList: Set (normalised), goLive, extraShared}`.
  `loadEligibilitySettings()` reads `teamRule.days, practice.copy, verification.maxAgeDays, verification.policy,
  sending.testList, sending.goLive, sharedDomains.extra`.
- `EvaluateOptions {mode, campaignId?, now?, settings?, recipients?, personIds?, senderHasReplyRoute?, senderName?}`.
  `evaluateCompanies(companyIds, opts) → Map<companyId, CompanyEligibility>`. History = real sends (`realModes`)
  plus **maybe-sent** rows (SENDING/UNKNOWN/UNCONFIRMED by `claimedAt`, take 5000), `ExternalSend`, `Suppression`
  and active reservations.
- `recheckRecipient(recipientId, {now, toNorm, settings}) → RecheckResult`. It uses `campaign.mode ?? "DRY_RUN"`
  and **does not pass `senderHasReplyRoute`**.
- `core/rules/mode.ts`: `SendModeValue`, `SEND_MODES`. `countsAsReal(mode, practiceCopy)` is true for LIVE, and for
  DRY_RUN only in the practice copy; TEST never counts. Also `realModes(practiceCopy)` and
  `modeLabel` ("Dry run" | "Test" | "Live").
- `core/rules/eligibility.ts`: `ELIGIBILITY_CODES` (the display order): no-email, invalid-email, email-changed,
  not-on-test-list, not-checked, test-checker, check-too-old, check-undeliverable, check-do-not-send, policy-blocked,
  check-unknown, unsubscribed, bounced, complained, suppressed, company-status, company-replied, team-rule, reserved,
  duplicate, excluded-by-hand, company-deleted, person-removed, no-reply-route.
  - **Test-list rule** (TEST and LIVE only): `!goLive` and the address is not on the list ⇒ `not-on-test-list`.
    On the list ⇒ the note "On test list". Before go-live a test-list address **counts as checked**.
  - **Verification rules** (TEST and LIVE, unless it counts as checked): missing ⇒ `not-checked`; provider `"fake"` ⇒
    `test-checker`; older than `maxCheckAgeDays` ⇒ `check-too-old`. A stored check result (`checkDecision`) is
    respected in **every** mode.
  - Suppression mapping: UNSUBSCRIBED/BOUNCED/COMPLAINED (or the person's dates) and MANUAL/INVALID ⇒ `suppressed`.
  - `ctx.mode === "LIVE" && senderHasReplyRoute === false` ⇒ `no-reply-route`.
  - Also `evaluateEligibility`, `companyReasons`, `personReasons`, `recipientReasons`,
    `stopReasonFor(r)` (codes `unsubscribed|bounced|complained|suppressed|invalid|status:X|company_deleted|person_removed`),
    `readRecipientOverrides` and `withRecipientOverride`.
- `core/rules/team-rule.ts`: `DAY_MS`, `teamRule(input)`, `usableCompanyDomain`, `withinDays`, `reservedText`,
  `TeamRuleExternalSend` (ExternalSend rows block the company).

### 2.4 `src/server/services/reservations.ts`
`RESERVING_CAMPAIGN_STATUSES`, `LAUNCH_HOLD_MS 15min`, `ReservationHolder`, `isActiveReservation`,
`findActiveReservations(reader, ids, now, excludeCampaignId)`, `takeReservations(tx, campaignId, ids, now)`,
`ensureReservation(campaignId, companyId, now)` (at send time), `releaseCompanyIfDone(tx, …)`,
`releaseCampaignReservations(tx, …)`, `releaseDraftReservations`, `setReservationExpiry`, `clearReservationExpiry`,
`pausedExpiryFrom(now)` (Setting `reservations.pausedExpiryDays`), `campaignLauncherId`,
`expirePausedReservations(now)`. Only campaigns where `countsAsReal` holds take reservations, so TEST never does.

### 2.5 Rendering: `src/server/services/render.ts` and `src/core/templates/*`
- `RenderError`, `RenderSettings`, `loadRenderSettings(client)` (reads `footer.companyName`, `footer.address`,
  `footer.unsubscribeText`, `portfolioUrl`), `templateValuesFor`, `renderDraftPreview`, `renderTemplatePreview`,
  **`renderCampaignEmail({recipientId, step, purpose, tx?})`**, `renderCampaignEmails({campaignId, recipientIds?, steps?,
  purpose, tx?})`. Follow-ups use `Re: <stored step-0 subject>`.
- `core/templates/types.ts`: `RenderPurpose = "preview" | "send"`.
- `core/templates/html.ts`: `UNSUBSCRIBE_PLACEHOLDER = "%unsubscribe_url%"`, `UNSUBSCRIBE_PREVIEW_TEXT`,
  `FOOTER_SEPARATOR "--"`. `footerText/footerHtml(footer, purpose)`: with `send`, the text reads
  `"<unsubscribeText> %unsubscribe_url%"` and the HTML `<a href="%unsubscribe_url%">%unsubscribe_url%</a>`.
  **The stored OutboundEmail.text/html therefore contain the literal placeholder.** Mailgun replaces it only while
  unsubscribe tracking is on (Setup A). Under Setup B or C it would go out as literal text unless the renderer changes.
- `core/templates/email.ts`: `renderEmail(input)`, `followUpSubject`, `footerStart`.

### 2.6 `src/server/services/campaigns/queries.ts` (campaign page read model)
- `getCampaignOverview(id) → CampaignOverview`. `results = {sent: count(SENT), delivered/bounced/complained/unsubscribed:
  _count of non-null OutboundEmail.deliveredAt/bouncedAt/complainedAt/unsubscribedAt, replied: distinct personId of
  InboundMessage(campaignId, kind REPLY)}`. **Wired, and 0 only because nothing writes these fields yet.**
  Step lines: `unsure = UNKNOWN + UNCONFIRMED`. `countsAsReal` is included.
- `listCampaigns` (list page `sent` only), `recipientWhere`, `listCampaignRecipients`,
  `getRecipientDetail` (emails with `mode, messageId, attempts, lastError`), `listOutbox`, `getOutboxEmail` and
  `listOutboxCampaigns` (all filter **`mode DRY_RUN, status SENT`**), `companySequences`.
- Pure wording lives in `src/components/campaigns/format.ts`: `PROBLEM_EMAIL_STATUSES = FAILED|UNCONFIRMED|UNKNOWN`,
  `RESOLVED_EMAIL_STATUSES`, `RESULT_LABELS`, `resultsNote(mode)`, `EMAIL_STATUS_LABELS` (UNKNOWN and UNCONFIRMED both
  read "Not sure it was sent"), `recipientStepViews` (canRetry: FAILED|UNCONFIRMED, never UNKNOWN),
  `recipientStateText`, `shortStopReason` (already maps `bounced`, `unsubscribed`, `complained`, `invalid`, `failed`, …).

---

## 3. Platform

### 3.1 `src/server/db.ts`
`db` (one PrismaClient per process; busy timeout 2 s web / 10 s worker via `OUTREACH_PROCESS`; PRAGMA WAL,
foreign_keys, synchronous=NORMAL), `Tx`, `DbOrTx`, `withWriteLock(fn)` (re-entrant),
`isRetryableDbError(err)` (P1008/P2028/P2034, SQLITE_BUSY), `withDbRetry(fn, 5)`, **`dbWrite(c => …)`**, **`dbTx(tx => …)`**
(transaction maxWait 5 s, timeout 10 s). Webhooks should answer 500 when `isRetryableDbError` (B5.7).

### 3.2 `src/server/settings.ts`: `SETTING_DEFAULTS` (every key, with its default)
| Key | Default | Key | Default |
|---|---|---|---|
| `sending.mode` | `"DRY_RUN"` | `teamRule.days` | 30 |
| `sending.goLive` | false | `reservations.pausedExpiryDays` | 14 |
| `sending.testList` | `[]` | `verification.provider` | `"mailgun"` |
| `sending.window` | `{days:[1..5], start:"09:00", end:"17:00"}` | `verification.pricePerCheck` | 0.012 |
| `sending.maxDailyCap` | 1000 | `verification.maxAgeDays` | 90 |
| `sending.capDayTimeZone` | `"Asia/Karachi"` | `verification.policy` | `{deliverableHighRisk:"block", catchAllLow:"send", catchAllMedium:"block", catchAllHigh:"block", unknown:"recheck"}` |
| `sending.minGapSeconds` | 20 | `footer.companyName` | `"Polygon Paradise"` |
| `warmup.startCap` | 50 | `footer.address` | `"55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan"` |
| `warmup.steps` | 20 | `footer.unsubscribeText` | `"If you'd rather not hear from us, unsubscribe here:"` |
| `warmup.minUsePercent` | 50 | `portfolioUrl` | `"https://www.polygonparadise.com"` |
| `warmup.healthyBouncePercent` | 2 | `defaultTimeZone` | `"Europe/Berlin"` |
| `warmup.healthyComplaintPercent` | 0.05 | `sharedDomains.extra` | `[]` |
| `health.bounceWindow` | 200 | `backups.keep` / `backups.secondFolder` | 14 / null |
| `health.bouncePercent` | 3 | **`mailgun.region`** | `"EU"` |
| `health.complaintWindow` | 1000 | **`mailgun.domain`** | null |
| `health.complaintPercent` | 0.1 | **`mailgun.logRetentionDays`** | 5 |
| `ai.model` / `ai.monthlyLimitUsd` | `claude-haiku-4-5-20251001` / 20 | **`mailgun.messageRetentionDays`** | 1 |
| `practice.copy` | false (true only in data/demo.db) | | |

API: `SettingKey`, `SettingValue<K>` (narrowed for `sending.mode`, `mailgun.region`, `mailgun.domain`,
`backups.secondFolder`), `getSetting(key)`, `getSettings(keys)`, `setSetting(key, value, userId)`. `setSetting`
neither validates nor logs; callers do both. No key exists yet for the unsubscribe setup (A/B/C), the per-sender
default cap, the cap override, the catch-all inbox, the DMARC rua or the monthly message limit.

### 3.3 `src/server/state.ts` (SystemState, worker-owned, CAS)
`StateRow<T> {value, version, updatedAt}`, `getState<T>(key)`,
`casState<T>(key, expectedVersion | null /* row must not exist */, value) → boolean`, `setState<T>(key, value)` (last writer wins).
Keys in use: `task.<name>` (periodic), `repair.<name>`. **Read but never written:** `sending.pause` →
`{paused?: boolean, reason?: string}` (`sending-state.ts`). Keep that shape or update `getSendingState`.

### 3.4 `src/server/secrets.ts`
`SecretKey = "mailgun.apiKey" | "mailgun.sendingKey" | "mailgun.webhookSigningKey" | "verification.apiKey" |
"anthropic.apiKey"`.
- `encryptSecret(name, plaintext, key?)` produces `v1:iv:tag:ct` (AES-256-GCM, AAD = name). `decryptSecret(name, stored, key?)`.
- `setSecret(name, value, userId)` trims the value and stores `last4`. `deleteSecret(name)`.
- `getSecret(name) → string|null` (server only; throws on a bad format or the wrong key).
- `secretInfo(name) → {set:false} | {set:true,last4,updatedAt,updatedById}` (safe for the UI).
- The key is `APP_ENCRYPTION_KEY` via `env.encryptionKey()`. There is no activity logging inside.

### 3.5 `src/server/jobs.ts`
- `JobType` (includes the M3 types, §0.8). `EnqueueInput {type, payload?, runAt?, priority?, maxAttempts?=3,
  dedupeKey?, createdById?}`. `enqueueJob(input, tx?)`: while a job with the same dedupe key is queued or running,
  it returns that job.
- `PublicJob`, `toPublicJob`, `getJob`, `cancelJob`. `JobContext {jobId, createdById, signal, progress}`.
  `JobHandler = (payload, ctx) => Promise<Json & {summary?}>`. `setJobProgress`.
- Redaction: `redactText(text, secrets[])`, `redactError`, `PlainJobError(message, detail?)`, `UNEXPECTED_JOB_ERROR`,
  `isUserFacingError`, **`describeJobError(err, secrets[])` → `{error, detail}`**. Pass the Mailgun key in
  `secrets` so it is redacted.
- `GET /api/jobs/:id` already refuses `mailgun.*` job types to Members.

### 3.6 `src/server/activity.ts` and `src/server/notifications.ts`
- `logActivity({actorId, type, summary, companyId?, personId?, campaignId?, data?, mode?}, tx?)` and `logActivities`.
  The documented type list already includes `email.delivered|bounced|complained|unsubscribed`, `reply.received|auto`
  and `user.senderAddress`.
- `createNotification({userId, type, title, body?, link?}, tx?)` (title ≤ 200, body ≤ 1000, link only through
  `safeNotificationLink`). `notifyOwner(input, tx?)` returns null when there is no Owner. Also `markRead`,
  `unreadSummary` and `listNotifications`. Planned types are listed in the header: `sending.paused`,
  `sending.capReached`, `sending.warning`, `email.complained`, `outage.hold`, `system.worker|tunnel|mailgun`,
  `user.replyInbox`. Desktop pop-ups appear only for `reply.*`.

### 3.7 Other server helpers
- `env.ts`: `databaseFilePath()`, `encryptionKey()`, **`publicUrl()`** (`APP_PUBLIC_URL` trimmed, no trailing
  slash, `null` when unset), `setupCodeHash()`, `isProduction`.
- `sending-state.ts`: `SendingState = dry-run | test-list | live | paused{reason}`. `getSendingState()` checks
  SystemState `sending.pause` first, then `sending.mode === DRY_RUN` ⇒ dry-run, then `!sending.goLive` ⇒ test-list,
  otherwise live.
- `worker-status.ts`: `getWorkerStatus(now) → {running (heartbeat < 60 s), lastSeen}`.

### 3.8 Auth, actions and requests (`src/lib/**`, web only)
- `lib/auth/dal.ts`: `AuthError(message, 401|403)`, `getUserOrNull()` (cached per request),
  `requireUser()` (redirects to /login), **`requireOwner()`** (redirects to `/contacts?notice=owner-only`),
  `requireUserAction()`, **`requireOwnerAction()`** ("Only the Owner can do this.").
  `SessionUser {id,email,name,role,timeZone,sessionId}`.
- `lib/action.ts`: `ActionResult<T>`, `UserError(message, fieldErrors?)`, `ok()`, `runAction(fn, successMessage?)`
  (lets NEXT_REDIRECT through; maps AuthError, UserError and ZodError), `parseInput(schema, input)`.
- `lib/request.ts`: `isHttpsRequest()`, `requestSourceKey()`, `cameThroughTunnel()`, `requestUserAgent()`,
  **`isSameOrigin(request) → boolean`**. The name is not `assertSameOrigin` as PLAN B10 says. Use it for
  state-changing session routes, **never for webhooks**.
- `src/proxy.ts`: an optimistic redirect only. The matcher excludes `api|_next/static|_next/image|favicon.ico|robots.txt`.

### 3.9 Route handler patterns (`src/app/api/**`)
- Session route: `const user = await getUserOrNull(); if (!user) return Response.json({error:"Sign in again."},{status:401});`,
  then for POST `if (!isSameOrigin(request)) … 403`. Example: `api/imports/route.ts` (`export const runtime = "nodejs"`,
  capped body read `readBodyCapped`).
- `api/jobs/[id]/route.ts` uses `ctx: RouteContext<"/api/jobs/[id]">` and `await ctx.params`.
- **Health route** `api/health/route.ts`: public, `dynamic = "force-dynamic"`. It returns
  `{ok, database, workerLastSeen, time}` with `Cache-Control: no-store`, and 503 when the database fails.
  `tests/integration/worker/health.test.ts` imports `GET` directly. Use the same pattern for webhook tests.

### 3.10 Tests: helpers and the auth-coverage allowlist
- `tests/setup/env.ts` sets a dummy `APP_ENCRYPTION_KEY`, `APP_PUBLIC_URL=""`, `SETUP_CODE_HASH=""`, and a default
  `DATABASE_URL=file:./data/test-unit.db`. Its comment names `helpers/db.ts`, but the real file is `helpers/test-db.ts`.
- `tests/integration/helpers/test-db.ts`: `createTestDb(name) → {file, url, cleanup}` (a new file in `data/test/`,
  `prisma migrate deploy`, sets `DATABASE_URL`). **Import server modules after calling it.**
- `tests/integration/campaigns/seed.ts`: `daysAgo`, `makeUser(name,{role,email,senderDisplayName})`, `makeCompany({...people})`,
  `DEFAULT_STEPS`, `makeDraft({...recipients})`, `makeSentEmail({mode default LIVE, status, …})`,
  `setSettingValue(key, value)`. `tests/integration/contacts/seed.ts` has a different `makeUser`/`makeCompany`.
- Server Action tests mock `@/lib/auth/dal`, `server-only` and `next/cache` (see
  `tests/integration/campaign-pages/actions.test.ts`, which already checks that `switchToDryRunAction` refuses Members).
- The sending loop test mocks `@/server/services/render` and drives `SendingLoop` and `sendingTick` with deps
  (`tests/integration/sending/loop.test.ts`). The runner test builds a `JobRegistry` inline (`tests/integration/worker/runner.test.ts`).
- **There is no fake Mailgun server yet.**
- `tests/unit/security/auth-coverage.test.ts` checks every `"use server"` export and every
  `src/app/**/route.ts` GET/POST/PUT/PATCH/DELETE body against
  `/\b(requireUserAction|requireOwnerAction|requireUser|requireOwner|getUserOrNull)\s*\(/`.
  - `PUBLIC_ACTIONS`: loginAction, logoutAction, setupAction, acceptInviteAction, resetPasswordAction.
  - `PUBLIC_ROUTES`: `src/app/api/health/route.ts#GET`, plus the commented-out
    `src/app/api/webhooks/mailgun/events/route.ts#POST` and `…/inbound/route.ts#POST`. Uncomment these.

---

## 4. UI

### 4.1 App shell and the top-bar status label
- `src/app/(app)/layout.tsx` calls `requireUser()`, then `getSendingState()`, and renders
  `<SendingPill state isOwner>`, `<NotificationBell/>` and `<UserMenu/>` in a sticky header.
- `src/components/shell/sending-pill.tsx`: the texts are "Dry run", "Test list only", "Sending live" and
  `Paused: ${reason}` (the default reason is "by the Owner"). Grey for dry run and test list, green for live, red
  for paused. It links to `/settings/sending` for the Owner and is plain text for Members.
  Because it is computed from settings (§3.7), **TEST with goLive on shows "Sending live"**, and there is no
  "Test mode" state.

### 4.2 Settings pages (`src/app/(app)/settings/**`)
The layout (`settings/layout.tsx`) calls `requireUser()` and renders `SettingsNav isOwner`. `settings-nav.tsx` hides
the "Owner" group (Sending & Mailgun, Team, System) from Members. **The Owner-only guard lives on each page:**
`requireOwner()` on pages and `requireOwnerAction()` on actions.
| Route | Guard | State |
|---|---|---|
| `/settings` | requireUser | Redirects to `/settings/profile` |
| `/settings/profile` | requireUser | Real: profile and password (see §4.3) |
| `/settings/notifications` | requireUser | Real: desktop pop-ups for replies |
| `/settings/backups` | page requireUser; 1 action requireUserAction, 2 actions requireOwnerAction | Real |
| `/settings/sending` ("Sending & Mailgun") | requireOwner | **M2 placeholder** (§4.4) |
| `/settings/team` | requireOwner; actions requireOwnerAction | Real. `TeamMember` has no sender address, cap or route status. |
| `/settings/system` | requireOwner | Real. Public address shows "Not set yet — added in Milestone 3". The "For Mailgun" row shows `<pub>/api/webhooks/mailgun/events` and `/inbound` when `APP_PUBLIC_URL` is set. |
There is no separate Mailgun or domain page.

### 4.3 My profile
- `settings/profile/page.tsx` selects `name, email, senderDisplayName, replyInbox, signature, timeZone` and falls back to
  `replyInbox ?? email`. `components/settings/profile-form.tsx` shows the fields Name, Sign-in email (read-only),
  **Sender display name**, a **"Sending address" static text "Set up with Mailgun in Milestone 3." (lines 120-123:
  there is no field)**, Reply inbox, Signature (with a preview) and Time zone. `ProfileValues` lives in
  `components/settings/types.ts`.
- `settings/profile/actions.ts` has `updateProfileAction` and `changePasswordAction`. `users.updateProfile(userId, input)`
  validates (display name without `< > " CR LF`, `replyInbox` through `parseEmail`) and notifies the Owner
  (`user.replyInbox`) when a Member changes the reply inbox. **It does not resync Mailgun routes.**
  `User.dailyCap` has no UI.
- `users.deactivateUser` revokes sessions and links only. There is no route repoint and no campaign handling (B6.10).

### 4.4 Settings › Sending (`settings/sending/page.tsx`, `actions.ts`, `dry-run-button.tsx`)
The page reads `sending.mode`, `practice.copy` and `getSendingState()`. It has three cards:
- "Sending mode": a dry-run explanation, or a warning when the mode is TEST or LIVE plus `DryRunButton`, and the
  paused notice.
- "The three modes": badges "Arrives in Milestone 3" for TEST and LIVE.
- "Arrives in Milestone 3": a COMING list with Connect Mailgun, Domain checklist, Sending hours and limits,
  Warm-up, and Tests and safety.

Its only action is `switchToDryRunAction()` (requireOwnerAction, `setSetting("sending.mode","DRY_RUN")`, activity
`settings.updated`, `revalidatePath("/", "layout")`). There is no action for go-live, the test list, pause,
Mailgun keys or the domain yet.

### 4.5 Every "Milestone 3" hit in `src/` (plus the related hits outside it)
| file:line | What it says or promises |
|---|---|
| `server/settings.ts:52` | comment: Mailgun settings are for M3 |
| `server/services/eligibility.ts:145` | `senderHasReplyRoute` option "Milestone 3" (never passed) |
| `server/sending-state.ts:12` | pause state "filled in by Milestone 3" |
| `server/services/sending/transport.ts:6,54,56` | TEST and LIVE arrive in M3. `LIVE_NOT_READY`. `transportFor` throws |
| `server/services/sending/mark-sent.ts:14` | the reconciler also calls markSent from M3 |
| `server/services/sending/loop.ts:22` | sending hours, pacing and daily limits arrive in M3 |
| `server/services/sending/claim.ts:89` | live and test rows are reconciled with Mailgun in M3 |
| `server/services/campaigns/launch.ts:20` | only dry run until M3 (refusal at 174-180) |
| `server/services/sending/addresses.ts:9,77` | real sender address from M3; `v:send_id` from M3 |
| `server/services/campaigns/draft.ts:331,1135` | `placeholderAddress` until M3; `modeReady` = dry run only |
| `server/services/campaigns/audience.ts:179` | draft mode: only dry run until M3 |
| `app/(app)/settings/system/page.tsx:85,114` | public address added in M3; "Apply recommended settings" in M3 |
| `app/(app)/settings/sending/actions.ts:13`, `dry-run-button.tsx:9` | the switch back to dry run exists only until M3 |
| `app/(app)/settings/sending/page.tsx:26,32,62,87,121,145` | TEST and LIVE "Arrives in Milestone 3"; warning text; the "Arrives in Milestone 3" card |
| `components/contacts/get-started.tsx:36` | "Connect Mailgun: Arrives in Milestone 3" (a muted step with no link) |
| `components/campaigns/format.ts:363` | `resultsNote`: "Delivery results arrive with Milestone 3…" (DRY_RUN or null mode only) |
| `core/rules/eligibility.ts:156,240` | reply route (M3); test-list addresses count as checked before go-live |
| `components/campaign-wizard/coming-later-button.tsx:8,19` | doc comment for `ComingLaterButton` |
| `components/campaign-wizard/review-step.tsx:552` | **"Send me a test"** is a disabled `ComingLaterButton` "Arrives in Milestone 3" |
| `components/settings/access-link-display.tsx:21-22` | "A link that works from anywhere arrives with the secure public address in Milestone 3" |
| `components/campaign-wizard/wizard-frame.tsx:39` | warning: test and live arrive in M3; set dry run to launch |
| `components/campaign-wizard/sender-step.tsx:129` | sending address, daily limit and reply route arrive in M3 (B6.4 wants them shown here) |
| `components/campaign-wizard/schedule-step.tsx:291,294` | disabled "Ignore sending hours (arrives with Milestone 3)" switch (`Campaign.ignoreWindow` exists but nothing sets it) |
| `components/campaign-wizard/schedule-step.tsx:353` | refusal text when `!summary.modeReady` |
| `components/settings/profile-form.tsx:122` | "Sending address: Set up with Mailgun in Milestone 3." |
| Related, outside src | `worker/main.ts:205`; `scripts/restore.mjs:8,190` (pause after restore "from Milestone 3"); `scripts/service-control.mjs:44`, `scripts/status.ps1:84`, `scripts/lib/supervisor.mjs:340`, `scripts/setup.mjs:152,250` ("not set up yet (Milestone 3)"); `app/(app)/campaigns/[id]/setup/verify/page.tsx:26-28` (the TEST and LIVE wording needs M3 test-list text) |

### 4.6 Campaign page stats row and the recipient panel
- `app/(app)/campaigns/[id]/page.tsx`:
  - `CampaignResultsGrid results={overview.results} note={resultsNote(mode)}` (line 196). `RESULT_LABELS` =
    Sent, Delivered, Bounced, Replied, Unsubscribed, Complained (`components/campaigns/campaign-progress.tsx`).
  - The dry-run notice (171-184) and the "Dry-run outbox" button (139-146) show only when `isDryRun`.
  - A "Follow-ups … arrives in Milestone 4" notice (185-192).
  - The sender line reads `Sent by X as fromName <fromAddress>`.
  - `LiveRefresh` calls `router.refresh()` every 10 s while RUNNING or SCHEDULED. There is no
    `/api/campaigns/:id/progress` route.
- `components/campaigns/recipient-panel.tsx`:
  - `canSkip` (105-108): included, an open state, and a RUNNING, SCHEDULED or PAUSED campaign.
  - `RetryEmailButton` (261) appears when `view.canRetry`: FAILED or **UNCONFIRMED**, never UNKNOWN, not a cancelled
    campaign, and not a recipient stopped for any reason other than "failed" (`format.ts:750-760`).
  - The step note reads "Not sure it was sent: <lastError>".
- `components/campaigns/recipient-actions.tsx`: `SkipRecipientButton` has a confirm dialog. **`RetryEmailButton`
  runs `retryEmailAction` straight away with no confirmation.** B6.7 wants "Retry or Skip?" for UNCONFIRMED, with a
  duplicate warning for LIVE. `EditEmailButton` is also here.
- `app/(app)/campaigns/[id]/actions.ts`: pause, resume, cancel, skipRecipient, retryEmail, editUnsentEmail and
  discardUnsentEdit, all `requireUserAction` (Members allowed). Each checks that the row belongs to the campaign.
- `components/campaigns/badges.tsx`: `ModeBadge` and `EmailStatusBadge`. `format.ts:670` already words the
  TEST sequence note "Mailgun test mode: nothing was delivered".

---

## 5. Schema (`prisma/schema.prisma`). All of these tables exist in `20260922195310_init`.
| Model | Exists | Obviously missing for M3 (decide: new migration or JSON in SystemState/Setting) |
|---|---|---|
| `SendingDomain` | id, name @unique, region String, active, lastLiveSendAt, createdAt | Mailgun domain state: DNS/verify status, tracking and unsubscribe settings read back, webhooks registered, catch-all and DMARC route ids, unsubscribe setup A/B/C result, lastCheckedAt. B4 puts the domain's cursors in `SyncCursor`. |
| `SenderAddress` | userId, domainId, localPart, address @unique, mailgunRouteId?, routeStatus String?, retiredAt?; @@unique(domainId, localPart), @@index(userId) | routeCheckedAt/routeError (optional). The catch-all route has no row. |
| `Setting` / `SystemState` / `Secret` | as in §3 | Only keys (§3.2, §3.3) |
| `Suppression` | emailNorm @unique, reason enum, source String ("webhook"\|"mailgun-sync"\|"manual"\|"verification"), detail, createdAt, **pushedToMailgunAt** | nothing (`people.markPersonUnsubscribed` already resets `pushedToMailgunAt`) |
| `OutboundEmail` | all B4 fields incl. messageId @unique, sendId @unique, claimedAt, attempts, lastError, sentAt, providerId, **deliveredAt, tempFailedAt, bouncedAt, complainedAt, unsubscribedAt**; indexes (status,dueAt), (campaignId,step,status), (recipientId,step), (toNorm,sentAt), … | No per-row sendingDomainId (derive it from `Campaign.sendingDomainId` or the messageId domain). Optional: `unconfirmedAt`/`reconciledAt`. **Note:** `fromAddress` here is the full From line, while `Campaign.fromAddress` is the bare address. |
| `TestSend` | userId, to, subject, mode, recipientId?, providerId?, sentAt; @@index(userId, sentAt) | messageId (to match events and replies), status/error, domain |
| `ExternalSend` | toNorm, companyDomain?, companyId?, sentAt, providerMessageId?, source String; 3 indexes | nothing |
| `MailEvent` | dedupeKey @unique, type, severity?, reason?, occurredAt, messageId?, recipient?, outboundEmailId?, isTestMode, source (WEBHOOK\|LOGS\|SIMULATED), raw Json, stopAppliedAt?, processedAt?; idx processedAt/messageId/recipient | testSendId (optional) |
| `WebhookToken` | token @id, receivedAt; @@index(receivedAt) | nothing (cleanup exists) |
| `InboundMessage` | storageKey @unique?, messageIdHeader, receivedAt, toAddress, senderAddressId?, fromEmail, fromName?, subject, snippet, inReplyTo, references, headers Json?, kind InboundKind?, autoReason, outbound/person/company/campaign ids, answered*/confirmed*, source (NOTIFY\|CATCHUP\|SIMULATED), processedAt | nothing for M3 storage |
| `SyncCursor` | key @id, value String, updatedAt | nothing (use keys like `<domain>:logs`) |
| `Campaign` | mode SendMode?, senderId, fromName, fromAddress (bare), **sendingDomainId Int? (no @relation / FK)**, ignoreWindow, daysAsMinutes, startAt, launchedAt, finishedAt, **pausedAt, pauseReason** | pausedById or an automatic-pause flag (optional) |
| `User` | senderDisplayName?, **replyInbox?** (setup and invite set it to the login email), **dailyCap Int?** (no UI), timeZone | nothing |
| Enums | `SendStatus` has UNKNOWN and UNCONFIRMED. `EventSource`, `InboundSource`, `InboundKind`. `RecipientState` has HELD and RECHECK. | |

---

## 6. Scripts and environment
- `.env` keys (see `scripts/lib/env-file.mjs newEnvFileText`): `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `APP_PUBLIC_URL`,
  `SETUP_CODE_HASH`. Next.js loads `.env` itself; the worker uses `import "dotenv/config"` (`worker/index.ts:8`).
  **Neither overrides variables already set in `process.env`**, so a parent process's env wins.
- `APP_PUBLIC_URL` is read by `src/server/env.ts publicUrl()` (the System page and team actions for access links),
  `next.config.ts` (Server Actions `allowedOrigins`) and `scripts/reset-password.ts`. It is set by `scripts/setup.mjs`
  (validated by `validatePublicUrl`), and changing it needs a restart of both processes.
  The worker also sees it, which matters for route `store(notify=…)` URLs built in jobs.
- `OUTREACH_*` variables:
  - `OUTREACH_PROCESS=worker` (db busy timeout).
  - `OUTREACH_PRACTICE=1` (cookie name only; `src/lib/auth/cookie.ts`).
  - `OUTREACH_HOST`, `OUTREACH_DATABASE_URL`, `OUTREACH_LOG_PREFIX`, `OUTREACH_PID_FILE`, `OUTREACH_STOP_FILE`
    (run-prod options).
  - `OUTREACH_BACKUP_DIR`: set by start-demo.mjs but **read nowhere** (dead).
- `scripts/run-prod.mjs` flags: `--port/PORT`, `--host/OUTREACH_HOST`, `--db/OUTREACH_DATABASE_URL`,
  `--log-prefix`, `--pid-file`, `--stop-file`, `--no-build`, `--open`.
  `scripts/lib/supervisor.mjs runSupervisor(options)` takes `{label, port, host, databaseUrl, logPrefix, pidFile,
  stopFile, allowBuild, backupBeforeMigrate, openBrowser, extraEnv, missingBuildMessage, printBanner}`.
  The children get `{...process.env, ...extraEnv, DATABASE_URL, NODE_ENV:"production", PORT, …}`, and the worker
  also gets `OUTREACH_PROCESS=worker`. `start-demo.mjs` passes `extraEnv {APP_PUBLIC_URL:"", OUTREACH_PRACTICE:"1",
  OUTREACH_BACKUP_DIR}` with port 3001 and `data/demo.db`. NSSM services set `NODE_ENV=production` and read `.env`
  from the AppDirectory.
- `scripts/lib/paths.mjs`: `ROOT`, `inRoot()`, `displayPath()`, and `PATHS` = env, dataDir, appDb, demoDb, abiFile,
  **restoredMarker (`data\RESTORED`)**, backupsDir, logsDir, runDir, supervisorPid, stopRequest, demoPid,
  demoStopRequest, updateMarker, nodeModules, lockFile, hiddenLockFile, buildId, buildMarker, workerBundle,
  workerSource, buildWorkerScript, migrationsDir, prismaCli, nextCli, nssm, nssmSha, startBat.
- **Restore marker:** `scripts/restore.mjs:140-145` writes `<db folder>\RESTORED` as JSON `{restoredFrom, at, file}`.
  **No app code reads it yet.** In M3 the worker must set the pause "Restored from a backup" and run the B6.7 restore flow.
- **Worker bundle:** `scripts/build-worker.mjs` (esbuild, `packages: "external"`). `tsconfig.worker.json` includes
  `worker/**`, `src/core/**`, `src/server/**` and `src/generated/**`, and excludes `src/app/**` and
  `src/components/**`. Worker code must not import `@/components/*` or `@/lib/*`. Note that the sending-window
  helper `localDateTimeToUtc` lives in `src/components/campaign-wizard/schedule-time.ts`; move shared time logic to
  `src/core`. No Mailgun SDK is installed and no packages may be added: use global `fetch`/`FormData`,
  `node:crypto` (HMAC, `timingSafeEqual`), `node:dns` and `temporal-polyfill` (installed).
- **Where a dev-only fake-Mailgun base URL could be injected safely.** Nothing exists yet; there are three options:
  1. **Code injection (preferred for tests).** The Mailgun client takes `baseUrl` in its constructor.
     `SendingDeps.transportFor` and `SendingLoopOptions.transportFor` already exist. Add a transport factory to
     `WorkerOptions` so `BackgroundWorker` can pass it through.
  2. **Env override for running the real app against the fake server** (B9 "my own checks"). Add one reader in
     `src/server/env.ts`, e.g. `mailgunApiBase(region)`, that honours something like `OUTREACH_MAILGUN_API_BASE`
     **only when it is an http(s) loopback URL** (127.0.0.1, localhost or [::1]) and otherwise falls back to
     `api.eu.mailgun.net` or `api.mailgun.net`. Pass it through `run-prod.mjs` or the supervisor's `extraEnv`
     (a parent env beats `.env`). Never write it into `.env` from setup, log it loudly at worker start, and show it
     in Settings › Sending. Restricting it to non-production would not work, because run-prod and the supervisor
     force `NODE_ENV=production`.
  3. Default it in `tests/setup/env.ts` to a dead loopback port, so an un-mocked call fails fast. Also refuse
     TEST/LIVE sends when `practice.copy` is true.

---

## 7. CONVENTIONS.md rules that matter most for M3
- Never edit `package.json`, the lockfile, `.env`, `next.config.ts`, `tsconfig*`, `vitest.config.ts`,
  `prisma/schema.prisma`, `prisma/migrations/**`, `src/components/ui/**` or `src/app/layout.tsx` unless the work
  package owns them. **A schema change means you STOP and report it.** No new packages.
- Allowed commands: `npx next typegen`, `npx tsc --noEmit [-p tsconfig.worker.json]`, `npx eslint <paths>`,
  `npx vitest run <own paths>`, `npx prisma generate`. **Never** run `next build`, `next dev`, `next start`,
  `npm install` or `prisma migrate *`, or touch `data/app.db`.
- Layout: `src/core` is pure (no I/O). `src/server` has no `server-only` and no `next/*` (the worker shares it).
  `src/lib` is web only.
- All writes go through `dbWrite`/`dbTx`. **No network I/O inside a transaction.** Keep transactions ≲ 50 ms and
  ≤ 500 rows. Automatic status changes use CAS `updateMany`. Claims are committed before the POST and never happen
  inside `dbTx`.
- Every page, action and route checks auth first (`requireOwner` or `requireOwnerAction` for Owner-only settings:
  API keys, domain, limits). State-changing session routes use `isSameOrigin`. Public entry points go on the
  auth-coverage allowlist.
- Settings (Owner-edited) are separate from SystemState (worker-owned, CAS) and from Secrets (encrypted, never sent
  to the browser, logs or job payloads). Use `secretInfo` for display and `describeJobError(err, [key])` for redaction.
- Log every change with `logActivity` and keep the type lists in `activity.ts` and `notifications.ts` up to date.
- UI: dark theme only. Orange only for the single primary action. Sentence case, plain language, an empty state
  with one next step, and errors that say how to fix them (technical text only behind "Details"). Show dates via
  `@/core/time/format` in `user.timeZone`. Use `useKeepValuesSubmit`, not `<form action>`. Handle clipboard and
  `crypto.randomUUID` fallbacks on http LAN.
- Tests: create a temp DB with `createTestDb()` and import server modules after it. **Never call real Mailgun.**
  Run only your own tests.
- Next 16: `params` and `headers()` are async. `RouteContext`, `PageProps` and `LayoutProps` are global types.
  Middleware is `src/proxy.ts`. Read `node_modules/next/dist/docs/` before using an unfamiliar API.

---

## 8. Bugs and gaps noticed (existing code)
1. **The placeholder sender applies in LIVE and TEST mode.** `senderSnapshot()` falls back to
   `@your-sending-domain` and `@dry-run.invalid` whatever the mode. Launch must require a SenderAddress for TEST and LIVE.
2. **The transport contract is too coarse** for B6.7 (§0.2). The comment "Dry run can't be ambiguous" marks exactly
   the spot to change in `loop.ts`.
3. **No reconciler.** LIVE and TEST rows stuck in SENDING are never touched, and `finishCheck` keeps such campaigns
   RUNNING for good.
4. **`senderHasReplyRoute` is never supplied** (launch.ts, recheckRecipient), so the `no-reply-route` rule is dead code.
5. **The global pause is read-only.** Nothing writes `sending.pause`, and `pickDueEmails` and `sendOneEmail` ignore it.
6. **The top-bar pill** shows "Sending live" for TEST mode when goLive is on, and has no test-mode state.
7. **B6.4 "before every send" guard is missing.** The loop never checks for unprocessed MailEvent or InboundMessage
   rows for the same address or company. There is also no "instant stop" helper (stop the recipients of an address
   or company in one transaction). `markPersonUnsubscribed` and company status changes rely only on the send-time
   recheck.
8. **UNCONFIRMED handling.**
   - `retryEmail` re-queues with the same Message-ID and there is no confirmation in the UI, which risks a duplicate
     for LIVE.
   - `skipRecipient` leaves UNCONFIRMED and UNKNOWN rows as they are.
   - The recipient stays SCHEDULED, so `finishCheck` never finishes the campaign while one exists. This state
     transition needs a decision in M3.
9. The M3 JobTypes are not registered (§0.8). The JobRunner runs one job at a time, so a long `mailgun.catchUp`
   blocks imports and backups unless it yields in sub-steps (B8).
10. `PERIODIC_CHECK_MS = 10 min` cannot schedule the 5-minute tunnel check in B8.
11. `updateProfile` (reply inbox change) and `deactivateUser` never resync or repoint Mailgun routes. The profile
    has no sender address field, and `User.dailyCap` has no UI.
12. `Campaign.sendingDomainId` has no FK or relation. `Campaign.fromAddress` (bare) and `OutboundEmail.fromAddress`
    (full line) share a name but not a meaning.
13. `%unsubscribe_url%` is always rendered for `purpose:"send"`. That is correct only while Mailgun unsubscribe
    tracking is on (Setup A).
14. Minor issues:
    - `OUTREACH_BACKUP_DIR` is dead.
    - `worker/notify.ts` duplicates `notifyOwner` without sanitising the link.
    - The comment in `tests/setup/env.ts` names the wrong helper file.
    - PLAN B10 says `assertSameOrigin`, but the code has `isSameOrigin`.
    - The B7 route `/api/campaigns/:id/progress` doesn't exist (the page polls with `router.refresh`).
    - The launch notification says "Replies … come to your inbox" even for TEST.

## 9. Tests that pin M2 behaviour and must change in M3
- `tests/unit/sending/addresses.test.ts:91-96`: `SENDABLE_MODES == ["DRY_RUN"]`, `transportFor` throws `LIVE_NOT_READY`.
- `tests/integration/campaigns/launch.test.ts:79-82` and `tests/integration/campaign-wizard/launch.test.ts:133-146`: `mode-not-ready` refusal.
- `tests/unit/campaigns/ui.test.ts:134-139` and `tests/unit/campaigns/format.test.ts:223`: "Delivery results arrive with Milestone 3".
- `tests/unit/ops/restore-script.test.ts:73`: the restore box text "From Milestone 3 on,".
- `tests/unit/security/auth-coverage.test.ts:26-27`: uncomment the webhook allowlist entries.
- `tests/integration/sending/query-plans.test.ts`: re-check index use if the `pickDueEmails` or reconciler queries change.
- `tests/integration/campaign-pages/actions.test.ts:223`: `switchToDryRunAction` Owner-only (keep it, or replace it with the new mode action).
