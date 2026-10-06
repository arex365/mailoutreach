# Milestone 4 code map: what already exists

Written 2026-09-23 from reading the code, not the plan. Paths are relative to the repo root. "M4" means
Milestone 4 "Sequences and replies" (PLAN.md A8 item 4, SPEC.md milestone 4). This file only describes existing code:
where M4 plugs in, what it must not break, and gaps found along the way. For WHAT to build, see PLAN.md A5, A6, B6.1,
B6.4, B6.10, B6.11, B6.14 and `docs/dev/M3-DESIGN.md` §1.3, §1.4, §4.3.4, §9.3. Format follows `m3-code-map.md`.

---

## 0. The integration points that matter most

1. **One constant turns follow-ups on.** `MAX_SENDABLE_STEP = 0` lives in `src/server/services/sending/gates.ts:60`
   (re-exported by `loop.ts:48`). It filters the ungated batch, the gated candidates, the due-stats raw SQL and the
   campaign page's waiting line (§1.1). Setting it to 3 sends every QUEUED follow-up row that is due, **including the
   overdue dry-run follow-up rows created in M2/M3** (harmless, M3-DESIGN §9.3).
2. **Remove the M3 launch switch-off.** `launch.ts:662-672` disables every enabled step `> MAX_SENDABLE_STEP` for TEST/LIVE
   launches. With the constant at 3 it becomes a no-op, but the texts that announce it (`FOLLOW_UPS_OFF_TEXT`,
   `LaunchSummary.followUpsOff`) must go too (§1.3). Campaigns already launched in M3 keep their steps switched off.
3. **HELD is not enforced by the sender.** Nothing writes `RecipientState.HELD` or `RECHECK`. `pickCandidates`
   (gates.ts) never looks at the recipient's state, and `prepareClaimed` (loop.ts:539) only skips FINISHED, STOPPED and
   EXCLUDED recipients. A QUEUED follow-up of a HELD recipient **would be sent**. The outage hold must either filter
   candidates by recipient state (re-check `tests/integration/sending/query-plans.test.ts`) or move held rows out of QUEUED.
4. **Replies are stored, never processed.** `InboundMessage` rows arrive with `processedAt null, kind null` and null
   person, company and campaign ids, from the webhook (`webhook.ts:288-294`) and the catch-up (`catch-up.ts:439`). The
   processing slot is `EventLaneOptions.processInbound` (`worker/event-lane.ts:20-21, 63-69`). `worker/main.ts:182-188`
   builds the lane **without** it.
5. **Stops have no reply or company scope.** `stopRecipients()` (`mail-events/stops.ts:57`) knows only
   `bounced|complained|unsubscribed|suppressed` and scopes `real` (by address) or `campaign` (one recipient). "Anyone at
   the company replies → stop the company in all campaigns" needs a new scope and reasons. `stopRank()` returns -1 for
   unknown codes, so a `replied` stop would never be replaced by, or replace, another stop.
6. **The send-time recheck cannot enforce reply stops.** `company-replied` is the only overridable eligibility code
   (`core/rules/eligibility.ts:44, 206-207`). A recipient "put back" by hand keeps its override in
   `CampaignRecipient.warnings`, so `recheckRecipient` still lets its follow-ups go after the company becomes Replied
   again. Reply processing must stop recipients explicitly, not rely on the recheck.
7. **Reply-matching building blocks exist.** `matchEvent()` (`mail-events/apply.ts:98-123`) matches Message-ID →
   `OutboundEmail.messageId` (unique), then `providerId` (indexed), then `TestSend`. `extractMessageIds`,
   `parseAddressHeader`, `headerValues` (`core/mailgun/inbound.ts`) and `normalizeMessageId` (`core/mailgun/events.ts:55`)
   are also available. `OutboundEmail @@index([toNorm, sentAt])` serves the 90-day from-address fallback. **There is no
   auto-reply detection anywhere** (no `Auto-Submitted`, `X-Autoreply` or subject lists).
8. **The outage state is written but never used.** SystemState `catchup.outage` (`OutageState`, `core/system-state.ts:169-178`)
   is filled by the catch-up (`catch-up.ts:264-274, 390-394`). `handledAt` is "set by M4". The only reader is the
   Settings › Sending line (`settings/sending/load.ts:200-203`). The natural hook is the catch-up job's `onSuccess`
   (`worker/jobs/index.ts:64-67`).
9. **Read models are already wired to reply columns.** The campaign page "Replied" count reads
   `InboundMessage {campaignId, kind: "REPLY", personId not null}` (`campaigns/queries.ts:329-333`). The company and
   recipient timelines show `reply.*` activity with `data.snippet` as the detail (`timeline-view.ts:20-25, 63-70`;
   icons in `timeline.tsx:63-64`). The bell pops up desktop notifications for types starting with `reply.`
   (`notification-bell.tsx:41`). So M4 must fill `campaignId`, `personId` and `kind` on InboundMessage, log
   `reply.received` / `reply.auto` with `companyId`, `personId`, `campaignId` and `data.snippet`, and notify with a
   `reply.*` type.
10. **Text that announces M4:** 7 user-facing hits (§1.5) plus code comments.

---

## 1. Sequences

### 1.1 `MAX_SENDABLE_STEP` and everything that depends on it
| Where | What it does |
|---|---|
| `src/server/services/sending/gates.ts:59-60` | `export const MAX_SENDABLE_STEP = 0;` "0 = first emails only (follow-ups: Milestone 4)" |
| `gates.ts:213` (`pickCandidates`) | `base = {status: "QUEUED", step: {lte: MAX_SENDABLE_STEP}, dueAt: {lte: now}}`, used by both the ungated (`:215-220`) and the gated (`:237-247`) query |
| `gates.ts:264-272` (`dueStatsWithZones`, raw SQL) | ``o.`step` <= ${MAX_SENDABLE_STEP}``. Feeds `DueStats` (pacing inputs, "outside hours", `loadDueStats` for the campaign page) |
| `gates.ts:796-801` (`explainCampaignWaiting`) | the campaign page's "why it waits" line, `step: {lte: MAX_SENDABLE_STEP}` |
| `src/server/services/sending/loop.ts:48` | `export { MAX_SENDABLE_STEP, SEND_BATCH } from "./gates"`. Comment at `:53-54` says follow-ups "are sent from Milestone 4" |
| `src/server/services/campaigns/launch.ts:11, 662-672` | the TEST/LIVE step switch-off (§1.3) |
| `src/server/services/campaigns/draft.ts:30, 1288` | `LaunchSummary.followUpsOff = mode !== "DRY_RUN" && steps.some(s => s.enabled && s.step > MAX_SENDABLE_STEP)` |

Not affected: `markSent`, the sweeper, `finishCheck` and `recipientStepViews`. They already handle steps 1-3.

### 1.2 Candidate order (B6.6 "follow-ups first")
- Gated query (`gates.ts:244`): `orderBy [step desc, recipient.company.priorityRank asc, dueAt asc, id asc]`, limit 500.
  `planTick` (`gates.ts:608-732`) walks the candidates in this order, so follow-ups go first.
- `explainCampaignWaiting` (`gates.ts:798`): the same order, 50 rows.
- **Ungated batch** (dry runs with "Ignore sending hours", `gates.ts:217`): `priorityRank asc, dueAt asc, id asc`, with
  **no `step desc`**. Follow-ups are not first there (dry runs only).
- No test pins "follow-ups first". Add one.

### 1.3 Where M3 switches off follow-ups for TEST/LIVE (to be removed)
- `launch.ts:662-672` in `finalizeLaunch()`: `followUpsOff = mode === "DRY_RUN" ? 0 : campaignStep.updateMany({where:
  {campaignId, step: {gt: MAX_SENDABLE_STEP}, enabled: true}, data: {enabled: false}}).count`. The count goes into
  the `campaign.launched` activity `data.followUpsOff` (`:703`). Header comments at `:37-39` and `:614-617` describe it.
- `draft.ts:1163-1164, 1288` has the `LaunchSummary.followUpsOff` flag.
- `components/campaign-wizard/format.ts:172-178`: `LaunchSummaryLike.followUpsOff`, `FOLLOW_UPS_OFF_TEXT`. At `:248-252`,
  `launchSentences().followUps` uses it or the M4 sentence.
- `components/campaign-wizard/schedule-step.tsx:292-297` shows the note in "Sending hours and limits". `:358` shows
  `sentences.followUps` when not switched off.

### 1.4 Follow-up row creation, `markSent` and the sweeper (`src/server/services/sending/mark-sent.ts`)
| Export | Signature / meaning |
|---|---|
| `MarkSentOptions` | `{providerId?, practiceCopy?, goLive?}` |
| `MarkSentResult` | `{emailId, campaignId, alreadySent, counted, next: {emailId, step, dueAt} \| null, finished}` |
| `followUpDelayMs(delayDays, {daysAsMinutes, mode})` (`:89-92`) | `days × (daysAsMinutes && mode === "DRY_RUN" ? 60_000 : DAY_MS)`. **Plain 24 h arithmetic** (not calendar days across DST). The sending window moves the row into working hours at send time. |
| `nextEnabledStep(tx, campaignId, step)` (`:95-100`) | first enabled `CampaignStep` with `step > step`. Disabled steps are skipped. |
| `createNextStepRow(tx, prev, next, {sentAt, daysAsMinutes})` (`:106-144`) | idempotent on (campaign, step, toNorm). Sets `dueAt = sentAt + followUpDelayMs`, `messageId = newMessageId(messageIdDomainOf(prev.messageId))`, `sendId = newSendId()`, **`inReplyTo = prev.messageId`**, `references = nextReferences(prev.references, prev.messageId)` (`addresses.ts:104`), copies `mode`, `senderId`, `fromAddress` (full From line), `toEmail`, `toNorm`, company snapshot. Subject, text and html stay `""` until render. |
| `recordRealContact` (internal, `:149-205`) | only when `countsAsEmailed(mode, {practiceCopy, goLive})`: Company `lastEmailed*` + `lastContactAt` (forward only), `firstContacted*` (CAS), NOT_CONTACTED→CONTACTED (CAS + activity `company.status`), Person `lastEmailed*`. |
| `advanceRecipient` (internal, `:211-239`) | leaves FINISHED/STOPPED/EXCLUDED recipients and CANCELLED campaigns alone. Next step ⇒ `state WAITING, currentStep = next.step, nextDueAt = row.dueAt, stopReason null`. Otherwise FINISHED + `releaseCompanyIfDone`. |
| `markSent(emailId, acceptedAt, opts)` (`:241-287`) | one dbTx. Any non-SENT status → SENT. Then recordRealContact, advanceRecipient, activity `email.sent` (actor = senderId, `data {emailId, step, messageId}`). |
| `SweepResult`, `findStuckRecipients(campaignId)` (`:308-339`), `sweepFollowUps(now, limit = 200)` (`:383-402`) | every 5 min through `runSendingMaintenance` (`loop.ts:949-958`). Repairs SCHEDULED/WAITING recipients of SCHEDULED/RUNNING/PAUSED campaigns whose last row is SENT and who have no later row: creates the next row (WAITING) or finishes them. `IN_FLIGHT = QUEUED|SENDING|UNKNOWN|UNCONFIRMED` rows block a repair. |

Threading gap: when Mailgun rewrote our Message-ID (`providerId !== messageId`, notice `message-id-rewritten` in
`loop.ts:630-637`), the next row still threads to **our** id (`prev.messageId`), not to what the recipient got.
Reply matching must also look up `providerId` (`matchEvent` does).

Restore gap: `restore.ts:399-402` builds a missing follow-up row's thread from `step - 1`, which assumes contiguous
steps. `nextEnabledStep` skips disabled steps, so with step 1 off and step 2 on, the restore finds no previous row.

### 1.5 Every "Milestone 4" hit in `src/` (plus related hits outside it)
| file:line | What it says or promises |
|---|---|
| `components/campaign-wizard/schedule-step.tsx:341-342` | dry-run helper hint: "…watch a whole sequence quickly. Sending follow-ups arrives in Milestone 4." |
| `components/campaign-wizard/format.ts:178` | `FOLLOW_UPS_OFF_TEXT`: "Follow-ups are sent from Milestone 4, so this campaign sends its first emails only; its follow-ups are switched off when you launch." |
| `components/campaign-wizard/format.ts:251` | `launchSentences`: "Its N follow-ups are prepared as each first email goes out. Sending follow-ups arrives in Milestone 4." |
| `app/(app)/campaigns/[id]/page.tsx:221-228` | notice, shown while `overview.hasFollowUps` and the campaign isn't finished or cancelled: "Follow-ups are prepared when the email before them goes out, and wait here for now: sending them arrives in Milestone 4. You can already read and edit them per person." |
| `app/(app)/settings/notifications/page.tsx:23-24` | "Replies are detected from Milestone 4 on." |
| `server/notifications.ts:9` | doc list: `reply.received … (Milestone 4)` |
| `server/services/sending/gates.ts:59` | comment on `MAX_SENDABLE_STEP` |
| `server/services/sending/loop.ts:53-54` | comment: follow-ups "are sent from Milestone 4" |
| `server/services/campaigns/launch.ts:662` (+ `:38`, `:616` "first emails only in Milestone 3") | switch-off comment |
| `server/services/campaigns/draft.ts:1163`, `components/campaign-wizard/format.ts:172` | `followUpsOff` doc comments ("first emails only in Milestone 3") |
| `server/services/mail-events/inbound-store.ts:8-11` | ids "stay null for Milestone 4's matching" |
| `server/services/mailgun/catch-up.ts:246, 265` | gap "recorded for M4's outage hold" |
| `core/system-state.ts:176` | `OutageState.handledAt` "Set by M4 once the hold is handled." |
| Outside src | `worker/event-lane.ts:6, 20, 51` (processInbound "from Milestone 4"). Tests: see §8. |

Related texts with no milestone number: `settings/sending/load.ts:200-203` ("The PC was off for more than N days, so
the app can't be sure it saw every reply."). `components/campaigns/format.ts:581-584` and
`company-panel/emailed-text.ts:169-173` already word HELD ("On hold: replies may have been missed while the PC was off")
and RECHECK.

### 1.6 How screens describe follow-up state today
- Campaign page (`app/(app)/campaigns/[id]/page.tsx`):
  - step lines `stepProgressText` (`components/campaigns/format.ts:309-325`: "Follow-up 1: 40 waiting, next on 14 Oct" / "…due 3 Oct");
  - timing `delayText` (`:333-338`: "3 days after the first email if there's no reply", or minutes with `daysAsMinutes`);
  - `hasFollowUps` (`queries.ts:457`);
  - the M4 notice (`:221-228`).
- Recipient text (`format.ts:569-609`, `recipientStateText`): "Waiting for follow-up 1 on 14 Oct", "Follow-up 1 waiting
  to send since 3 Oct" (overdue: shows today for M3 rows), "On hold: replies may have been missed…" (HELD), "Stopped:
  replied" via `SHORT_STOP_REASONS` (`:499-527`, already maps `replied`, `company_replied`/`company-replied`, `status:X`).
- Recipient panel (`components/campaigns/recipient-panel.tsx`): `recipientStepViews` (`format.ts:802-863`) plans future
  steps ("Goes 3 days after the first email if there's no reply"). `canSkip` (`:107-110`) includes HELD and RECHECK.
  The timeline reads activity by `(campaignId, personId)` (`queries.ts:694-698`).
- Contacts "Sequence" column: `companySequenceLabel` (`format.ts:724-753`) → `recipientStateText`, suffix " (dry run)" or " (test)".
- Company panel: `sequenceStateText` (`company-panel/emailed-text.ts:148-190`): "waiting for follow-up 2 on 12 Oct",
  "stopped because they replied" (`STOP_REASONS :94-122` has `replied`, `company_replied`).
- Wizard Schedule step: §1.3.

### 1.7 Render: follow-up subject "Re:"
- `server/services/render.ts:258-271` (`renderRecipientStep`): the first-subject template comes from the person's step-0
  edit, else campaign step 0. For step > 0 it passes `firstSubject: r.sentFirstSubject`.
- `render.ts:312-320` (`renderCampaignEmail`) and `:359-367` (`renderCampaignEmails`): `sentFirstSubject` = the subject of
  the recipient's step-0 `OutboundEmail` with `subject != ""` (any status). The loop writes the subject on the row just
  before handing it over (`loop.ts:572-578`).
- `core/templates/email.ts:29-34` `followUpSubject(s)`: collapses whitespace, never "Re: Re:", `"Re:"` when empty.
  `:50-55`: uses `firstSubject` when given, else "Re: " + step 0 rendered for this person.
- Transport: `OutgoingMessage.inReplyTo/references` (`transport.ts:34-36`). `mailgun-transport.ts:65-66` passes them to
  the client, which sends `h:In-Reply-To` and `h:References` (`:89-90`, bracketed). Dry runs keep them on the row
  (the outbox shows them, `getOutboxEmail`).

### 1.8 `RecipientState` values and who writes them
| State | Written by |
|---|---|
| PENDING | default. `launch.ts:501` (`restoreDraftTicks` after a failed launch) |
| SCHEDULED | `launch.ts:567` (`writeChunk`, `currentStep 0, nextDueAt = startAt`). `control.ts:445` (retry of a step-0 email) |
| WAITING | `mark-sent.ts:229` (`advanceRecipient`), `:366` (sweeper). `control.ts:445` (retry of a follow-up) |
| HELD | **nobody**. Read by `finishCheck` (`control.ts:104`, open ⇒ campaign stays RUNNING), `stops.ts:16` (stoppable), `OPEN_RECIPIENT_STATES` (`control.ts:37`, `format.ts:229`), `detail.ts:102`, `queries.ts:892`, and the UI texts |
| RECHECK | **nobody** (M5) |
| FINISHED | `mark-sent.ts:235, 370` |
| STOPPED | `loop.ts:288` (`skipClaimed`, `stopReasonFor(reason)`), `loop.ts:315` (`failForGood`, `"failed"`), `stops.ts:79` (`bounced\|complained\|unsubscribed\|suppressed`), `control.ts:256` (`"campaign_cancelled"`), `control.ts:335` (`"Skipped by <name>"`) |
| EXCLUDED | `launch.ts:555, 676, 683` |

`stopReason` values in use: `unsubscribed`, `bounced`, `complained`, `suppressed`, `invalid`, `status:<STATUS>`,
`company_deleted`, `person_removed`, `failed`, `campaign_cancelled`, `Skipped by X`, or an eligibility sentence
(`stopReasonFor`, `core/rules/eligibility.ts:336-356`). Nothing writes `replied` or `company_replied` yet.

### 1.9 Campaign controls M4 interacts with (`server/services/campaigns/control.ts`)
- `finishCheck(campaignId, {now})` (`:91-138`): open emails are QUEUED/SENDING/UNKNOWN/UNCONFIRMED. Open recipients are
  SCHEDULED/WAITING/HELD/RECHECK. It notifies `campaign.finished` to the sender and the creator.
- `pauseCampaign` / `resumeCampaign` / `cancelCampaign` are campaign-level. Resume doesn't reschedule overdue follow-ups:
  they go at the next open window.
- `retryEmail` (`:382-469`) re-opens STOPPED("failed") or FINISHED recipients as SCHEDULED or WAITING.
- Manual status changes (`companies/mutations.ts:118` `setCompanyStatus`, `companies/bulk.ts:62` `bulkSetStatus`)
  **don't stop recipients**. Only the send-time recheck does, with `status:X`, and never for "put back" recipients (§0.6).
  B6.4 "company status becomes Replied/Client/… stops follow-ups" is therefore only lazily true. The Sequence column keeps
  "Waiting for follow-up 1…" until the due time.

---

## 2. Replies

### 2.1 Inbound webhook and store
- `src/app/api/webhooks/mailgun/inbound/route.ts:12-14`: `POST → handleInboundWebhook(request)`, `runtime nodejs`,
  `force-dynamic`, public (allowlisted in `tests/unit/security/auth-coverage.test.ts`).
- `server/services/mail-events/webhook.ts:251-300` `handleInboundWebhook(request, {now?})`:
  1. content type check;
  2. `readBodyCapped(INBOUND_BODY_MAX = 10 MB)`;
  3. form parse;
  4. timestamp/token/signature;
  5. signing key;
  6. freshness (`INBOUND_MAX_AGE_MS`, 24 h);
  7. HMAC;
  8. `parseInboundForm`;
  9. one dbTx: token dedupe (`WebhookToken`), then `storeInbound(tx, parsed, "NOTIFY")`.

  It answers 200/401/406/500 only. No stop and no matching. B6.4 "instant stop in the webhook tx" is not done for replies.
- `server/services/mail-events/inbound-store.ts:23-70` `storeInbound(tx, parsed, source) → {status: "created"|"duplicate", id}`:
  - Dedupe by `storageKey`, else by `messageIdHeader` + `toAddress`. When a keyless row is found, it gets the storage key.
  - Writes `toAddress` (lowercase, ≤ 320), `senderAddressId` (when `toAddress` is a `SenderAddress.address`),
    `fromEmail = normalizeEmail(from) ?? raw`, `fromName`, `subject` (≤ 500), `snippet` (≤ 300),
    `inReplyTo` (**first id only**), `references` (space-joined), `headers` (JSON `[name, value][]`, ≤ 200 pairs / 32 KB),
    `kind: null`, `source`, `processedAt: null`.
  - Never writes `autoReason`, `outboundEmailId`, `personId`, `companyId`, `campaignId`, `answered*` or `confirmed*`.
- Parsers (`src/core/mailgun/inbound.ts`, pure):
  - `ParsedInbound` (`:14-35`), `parseInboundForm(fields, now)` (`:329`), `parseStoredMessage(json, fallback)` (`:353`);
  - `parseStoredLogOnly(item)` (`:390`, empty snippet: the "recovered reply with no text" case);
  - `parseMessageHeaders`, `headerValues(headers, name)` (`:112`), `extractMessageIds` (`:121`),
    `parseAddressHeader` (`:215`), `lowerKeys`.

  All the headers auto-reply detection needs are kept in `headers`.

### 2.2 Catch-up's stored replies (`server/services/mailgun/catch-up.ts`)
- `walkStoredReplies(r)` (`:403-453`, step 6 of `runCatchUp` `:555`) walks the Logs `stored` events since cursor
  `<domain>:stored` minus `STORED_OVERLAP_MS` (2 h). Keys already stored are skipped (`:424`). Each is fetched with
  `fetchStoredReply` (`:364-396`: storage URLs, then the API form). A body that has expired or was refused (4xx) falls
  back to `parseStoredLogOnly` (**snippet ""**). Rows are stored with `storeInbound(tx, parsed, "CATCHUP")` (`:439`) and
  counted in `CatchUpSummary.inboundStored`.
- **No flag marks a body-less recovered reply.** The only signal is `snippet === ""` (with `source CATCHUP`), which an
  empty real reply also has. `outage.beyondMessageRetention` is set only when the reply is older than message retention (`:390-394`).

### 2.3 Event lane slot
- `worker/event-lane.ts`: `EVENT_LANE_IDLE_MS = 1000`, `EventLaneOptions {ownsLease, logger?, now?, onProblems?,
  processInbound?: (opts: {now: Date; limit: number}) => Promise<number>}`. `tick()` calls `processPendingMailEvents`
  first, then `processInbound({now, limit: EVENT_BATCH = 50})` (errors are throttle-logged under key "inbound"), then
  `onProblems`. `run()` re-ticks immediately **only when mail events filled a batch**. The inbound count is ignored.
- `worker/main.ts:182-188` builds `new EventLane({ownsLease, logger, now, onProblems})`: **no `processInbound`**.
  `oneRound()` (`:273-283`, used by `runOnce`/`tickOnce` in tests) runs events → reconciler → sending → monitor.
- Pattern to copy: `processPendingMailEvents` (`mail-events/process.ts:273-335`): oldest first, CAS `processedAt`,
  activity in the same tx, 5 failures ⇒ set aside + notice `event-failed`.

### 2.4 M3 send-time guards (M3-DESIGN §4.3.4)
- `pendingProblemIds(cands)` (`gates.ts:305-362`) runs two batched queries (chunks of 400):
  1. `MailEvent {processedAt null, recipient IN toNorms}` blocks that address;
  2. `InboundMessage {processedAt null, receivedAt ≥ min(campaignLaunchedAt)}`, minus replies whose
     `inReplyTo/references` contain a `TestSend.messageId`, blocks a candidate when `fromEmail === toNorm`, or when the
     sender's `Person.emailNorm` company (deleted people included) is the candidate's company, and
     `receivedAt ≥ c.campaignLaunchedAt`.
- `planTick` (`gates.ts:690-693`) holds these with reason `pending-events`: skipped, and the next candidate is tried.
  The campaign page wording is `waitingText` "Waiting: a reply or a Mailgun report for one address hasn't been
  processed yet." (`format.ts:415-416`).
- Only **gated** candidates (TEST/LIVE, gated dry runs) are checked. Ungated dry runs never are.
- The reply query has **no limit**: every unprocessed row since the oldest launch, every tick (5 s). That is fine only
  once M4 keeps the backlog near zero.
- M3-DESIGN §9.3: "the reply guard becomes the full B6.4 rule once replies are processed". Today it ignores replies
  received before the campaign's launch.

### 2.5 `server/services/mail-events/stops.ts`
| Export | Meaning |
|---|---|
| `StopReason = "bounced" \| "complained" \| "unsubscribed" \| "suppressed"` | the only codes |
| `STOPPABLE_STATES = SCHEDULED, WAITING, HELD, RECHECK` | |
| `STOP_SKIP_TEXT: Record<StopReason, string>` | lastError on skipped QUEUED rows ("Stopped: this address bounced" …) |
| `stopRank(code)` | suppressed 0 < bounced 1 < unsubscribed 2 < complained 3 (`STOP_PRECEDENCE`, `core/mailgun/events.ts:361`). Anything else −1 (never replaced) |
| `StopInput {emailNorm, reason, scope: "real" \| "campaign", recipientId?, now}` | `real` = every included open/stopped recipient with that `emailNorm` (plus `recipientId`). `campaign` = that recipient only |
| `stopRecipients(tx, input) → number` | open recipients become STOPPED; QUEUED rows become SKIPPED; weaker stop codes are upgraded; `releaseCompanyIfDone` per campaign and company |

There is no company scope (by `companyId` across campaigns) and no `replied` / `company_replied` code. Callers:
`apply.ts:287, 295`, `people.ts:328` (`markPersonUnsubscribed`), `mailgun/suppressions.ts:247`.

### 2.6 The reply test's use of InboundMessage (`server/services/reply-test.ts:273-288`)
`loadReplyTest` reads `InboundMessage {fromEmail IN testList, toAddress: ownerAddress}` (no `processedAt`/`kind`
filter) for "Reply reached the app". So M4 must not delete these rows or change their `fromEmail`/`toAddress`. Replies to
`TestSend` threads (purpose `REPLY_TEST` or `SELF`) must not mark anyone Replied. M4 has to classify them (no
`InboundKind` fits exactly: REPLY/AUTO_REPLY/BOUNCE_NOTICE/POSSIBLE_REPLY/UNLINKED).

### 2.7 Outage state for the hold (B6.4 "After a long outage")
- Key `STATE_KEYS.outage = "catchup.outage"` (`core/system-state.ts:14`).
- `OutageState {detectedAt, from, to, beyondLogRetention, beyondMessageRetention, handledAt}` (`:169-178`).
- Parser `parseOutageState` (`core/system-state-parse.ts:353`). Read and write with `readTyped` / `updateTyped`
  (`server/state-typed.ts:14, 34`).
- Writers:
  - `walkEventLogs` (`catch-up.ts:264-274`): when `logsWindow(cursor, now, logRetentionMs)` (`:249-257`) finds
    `cursor < now − retention + 1 h`, it sets `from = cursor`, `to = floor`, `beyondLogRetention = true`,
    `handledAt = null`. A first run (no cursor) never records a gap. A later domain's gap overwrites an earlier one.
  - `fetchStoredReply` (`:390-394`): `beyondMessageRetention = true`.
- Reader: `settings/sending/load.ts:172-205`, shown by `components/settings/sending/check-with-mailgun.tsx:55-58` while
  `detectedAt && !handledAt`.
- Settings used: `mailgun.logRetentionDays` 5, `mailgun.messageRetentionDays` 1 (`server/settings.ts:58-59`).
- Timing risk: the catch-up gate (`isCatchUpReady`, `gates.ts:373-387`) opens after 15 min when catch-ups keep failing
  with network or server errors. Follow-ups could then go before any outage has been detected.

---

## 3. Notifications

### 3.1 `src/server/notifications.ts`
| Export | Meaning |
|---|---|
| doc list `:8-37` | types in use. `reply.received` is marked M4. `outage.hold` is listed but not created. Throttled notice keys. "Desktop pop-ups … only for types starting with `reply.`" |
| `NotificationInput {userId, type, title, body?, link?}` | |
| `NotificationItem {id, type, title, body, link, createdAt, readAt}` (ISO), `UnreadSummary {unread, latest}` | |
| `safeNotificationLink(link)` | `safeAppPath(link, 500)` |
| `toNotificationItem(n)` | |
| `createNotification(input, tx?)` | type ≤ 100, title ≤ 200, body ≤ 1000 |
| `notifyOwner(input, tx?)` | first active OWNER, null when none |
| `markRead(userId, ids \| "all", now?)` | |
| `unreadSummary(userId, limit = 5)` | |
| `NOTIFICATIONS_PAGE_SIZE = 50`, `NotificationPage`, `listNotifications(userId, page, pageSize)` | |

Once-a-day Owner notices: `shouldSendNotice(key, now)` (`server/state-typed.ts:61`). `worker/notify.ts` is a duplicate
`notifyOwner` without link sanitising; don't use it. The daily clean-up deletes **read** notifications after 90 days
(`worker/jobs/cleanup.ts:24`). So "Replies waiting for an answer" must be built from `InboundMessage`, not from `Notification`.

### 3.2 The bell
- `components/shell/notification-bell.tsx`:
  - `POLL_MS = 20_000` (`:31`); skips polling while `document.hidden`; reloads on focus, on visibility and on
    `NOTIFICATIONS_CHANGED_EVENT` (`:34`);
  - `showDesktopPopups(data, previousMaxId, onOpen)` (`:37-56`): only when `desktopReplies`, `isSecureContext` and
    permission granted; new unread `reply.*` items **among the latest 5**, at most 3 per poll; the first load is only a
    baseline;
  - clicks go through `useGuardedNavigate`.
- `app/api/notifications/summary/route.ts`: `GET` → `{unread, latest (5), desktopReplies}` with `no-store`. 401 when signed out.
- Mounted in `app/(app)/layout.tsx`. The mobile bottom bar includes Notifications (`components/shell/nav-items.ts:34-40`).

### 3.3 Notifications page (`app/(app)/notifications/**`)
- `page.tsx`: `requireUser`, `listNotifications(user.id, page)`, header "N unread notifications", `MarkAllReadButton`,
  empty state "You're all caught up." with a Contacts button, `Pager`.
- `notification-list.tsx`: `NotificationList {items: NotificationRow[]}` (click → mark read → navigate) and
  `MarkAllReadButton`.
- `actions.ts`: `markNotificationsReadAction({ids})` (≤ 500) and `markAllNotificationsReadAction()` (requireUserAction).
- **Missing:** the "Replies waiting for an answer" section (A8 M4: "on the Notifications page until the dashboard"),
  Answered / No answer needed, "Real reply?" / "It was an auto-reply", and "Link to a company" for unlinked replies.
  None of these texts exist in `src/`.

### 3.4 Settings › Notifications and preferences
- `app/(app)/settings/notifications/page.tsx`: one card "Pop-ups" with `DesktopPopupsSetting` (and the M4 sentence, §1.5).
- `app/(app)/settings/notifications/actions.ts`: `setDesktopRepliesAction({enabled})` → `setNotifyPrefs(user.id, {desktopReplies})`.
- `components/settings/desktop-popups-setting.tsx`: switch "Desktop pop-ups for new replies", permission request,
  secure-context note, "Show a test pop-up".
- `server/services/users.ts:671-694`: `NotifyPrefs = {desktopReplies: boolean}`, `readNotifyPrefs(value)`,
  `getNotifyPrefs(userId)`, `setNotifyPrefs(userId, patch)`. The patch is merged into `User.notifyPrefs` JSON and
  unknown keys are kept. No other preference exists (SPEC §12 "notification preferences").

---

## 4. "Who has been emailed"

### 4.1 Data
- Company (`prisma/schema.prisma:321-330`): `firstContactedById/At`, `lastEmailedAt/ById/CampaignId/Step`,
  `importedLastContactAt`, `lastContactAt` (= max of the two; `companies/filters.ts:170`), `repliedAt`.
- Person (`:374-378`): `repliedAt`, `lastEmailedAt/ById/CampaignId/Step`.
- Only writer: `markSent → recordRealContact` (§1.4), gated by `countsAsEmailed`. LIVE before go-live is **not** emailed
  (M3-DESIGN §1.7). The import writes `importedLastContactAt` / `lastContactAt` (`imports/commit.ts:228-230, 318-321`).
- **`Company.repliedAt` and `Person.repliedAt` are never written by the app** (only `scripts/make-demo-data.ts:235, 261`).

### 4.2 Contacts
- `server/services/companies/query.ts:28-61, 106-140`: `lastEmailedAt/ById/ByName/ByViewer` and
  `sequences = companySequences(ids)`.
- `companySequences(companyIds, {practiceCopy?})` (`campaigns/queries.ts:900-957`): per company, every open recipient
  plus the latest finished or stopped one, from non-draft campaigns. `countsAsReal` (not `countsAsEmailed`, unlike
  `detail.ts:200`).
- `components/contacts/format.ts`:
  - `lastContactSource` (`:30`);
  - `lastEmailedLabel` (`:49-54`: "You · 12 days ago" / "Old tool · …" / "Never");
  - `lastEmailedTitle` (`:57-66`);
  - `toContactRow` (`:94-116`), which builds `sequenceLabel` and `sequenceTitle` from `companySequenceLabel`.
- `components/contacts/companies-table.tsx:145-162` has the "Last emailed" (sortable, `lastContactAt`) and "Sequence"
  columns. The phone card is at `:466`.
- Filters (`companies/filters.ts:131-133`): `emailed yes|no` on `lastContactAt`, and `by` = `firstContactedById`.
- There is no "replied" filter (the status tab covers Replied).

### 4.3 Company panel
- `server/services/companies/detail.ts`:
  - `getCompanyDetail(companyId)` (`:130-287`) returns `sequences: SequenceRow[]`, where `countsAsReal` means
    `countsAsEmailed` (`:195-210`, `SHOWN_STATES :102`). People carry `repliedAt` and `lastEmailed*`.
  - `getCompanyTimeline(companyId, {filter, cursor, limit})` (`:366-404`) uses `timelineWhere` (`:328-342`, filter
    `replies` = `type startsWith "reply."`).
- `components/company-panel/company-panel.tsx`:
  - the "Emailed" banner (`:45-57, 70-78`) is `emailedSummary({lastEmailed*, importedLastContactAt,
    sequence: pickSequence(...)})`;
  - people rows (`personView :167-209`) use `emailedSummary` per person, plus flags Unsubscribed / Bounced / Complained /
    **Replied** (`p.repliedAt`, `:188`) / Blocked.
  - The banner never shows company `repliedAt`.
- `components/company-panel/emailed-text.ts`: `SequenceInfo`, `pickSequence` (`:67-92`), `stopReasonText` (`:132-145`),
  `sequenceStateText` (`:148-190`), `emailedSummary` (`:214-237`), `stepLabel`.

### 4.4 Import and the 30-day rule texts
- `server/services/imports/check.ts`:
  - `emailedText` (`:166-169`);
  - flags (`:487-518`): "Already emailed by Ali 12 days ago" (company or person `lastEmailed*`), "Contacted in the old
    tool …", and unsubscribed / spam / bounced / do-not-email;
  - "Restore C-1042 (emailed by …)?" (`:453-454`);
  - `summary.alreadyEmailed` (`:594`), shown by `components/import/check-step.tsx:125`.
- **Not flagged:** replied people, matches by domain or by another company's address, and `ExternalSend` rows.
- `core/rules/team-rule.ts`: `emailedText` (`:110-117`: "Emailed by Ali 12 days ago (Germany Q4, follow-up 1)", "x was
  emailed…", "Someone at domain…"), external-send and old-tool texts, and `reservedText` (`:105`).
  `core/rules/eligibility.ts:206-207` has "Company status is Replied (you can include it by hand)".

### 4.5 Gaps vs PLAN A6 / B6.1 / SPEC §3
- SPEC §3 "stopped because they replied" and A6 people "flags (… Replied)" need M4 to write `Person.repliedAt`,
  `Company.repliedAt`, status REPLIED (CAS from NOT_CONTACTED/CONTACTED only, A5.5), and the `replied`/`company_replied`
  stop codes. The words already exist in both UI word lists.
- The company banner and the Contacts row have no "Replied" marker other than the status chip.
- LIVE sends before go-live: the Sequence column and panel show "finished" while "Last emailed" says "Never" (§1.7),
  and there is no "(test list)" suffix. M6 will revisit this.
- `companySequences` / `getCampaignOverview` use `countsAsReal` while `detail.ts` uses `countsAsEmailed`. The two
  "counts as real" flags mean different things.
- B6.1 "who has been emailed" is otherwise complete for M3 data.

---

## 5. Test tools

### 5.1 Outbox "Simulate"
- `server/services/mail-events/simulate.ts`:
  - `SimulateKind = "delivered" | "bounce" | "complaint" | "unsubscribe"`, `SIMULATE_KINDS`, `ALREADY_SIMULATED`;
  - `simulateEmailEvent(actor, emailId, kind, {now?})` (`:50-77`): **DRY_RUN + SENT emails only**, dedupe
    `sim:<emailId>:<type>`, `makeSimulatedEvent` → `applyMailEventNow(ev, "SIMULATED")`;
  - `SimulationView`, `loadSimulation(emailId)` (`:89-111`).
- `app/(app)/campaigns/outbox/actions.ts`: `simulateEmailAction({emailId, kind})` (requireUserAction; zod enum of 4 kinds).
- `components/campaigns/simulate-buttons.tsx`: `BUTTONS` (`:11-16`) Delivered/Bounce/Complaint/Unsubscribe, "Results: …".
- Rendered in `app/(app)/campaigns/outbox/page.tsx:131-157` inside `OutboxEmailView`.
- **No reply and no auto-reply simulation.** `InboundSource.SIMULATED` is **never used**. B6.5's table wants a
  simulated reply (campaign scope on real data, real scope in the practice copy), and A8 M4 wants "a practice-copy
  campaign with fast follow-ups", so replies must be simulatable there.
  The scope rule to mirror is `scopeFor()` (`apply.ts:126-130`).

### 5.2 The fake Mailgun's inbound support (`tests/fake-mailgun/**`)
- `server.ts:61-64, 81-90, 476-561`: `receive({from, to, subject, text, inReplyTo?, references?, headers?, at?})` stores
  the message (JSON plus MIME; `stripped-text` = text) and a Logs `stored` event. It returns `{storageKey, messageUrl,
  fields}` (the notify form without signature). `headers` lets a test add `Auto-Submitted: auto-replied` and similar.
  Replies thread with `In-Reply-To` and `References` (defaults to `[inReplyTo]`).
- `webhooks.ts:60-73`: `signedInboundRequest(appUrl, fields, {key?, now?, timestamp?, token?, tamper?, multipart?})`
  builds a `Request` for `POST(request)` in route tests. The instance method is `fake.signedInboundRequest` (`server.ts:567`).
- `handlers/storage.ts`: `GET /v3/domains/{d}/messages/{key}` (expires after the message retention, `message/rfc2822`
  variant).
- `admin.ts:11, 86-102`: `POST /__fake/inbound {from, to, subject, text, inReplyTo?, references?, notify?}` (CLI,
  `--app` loopback). **It passes neither `headers` nor `at`**, so the manual check can't send an out-of-office through
  the admin API. Extend it for the A8 M4 test.
- Helper: `tests/integration/helpers/mailgun.ts` `connectFakeMailgun({domain?, region?, fake?})`. Example sender and
  reply flow: `tests/integration/milestone3/end-to-end.test.ts` (`postReply`, `postEvent`).

---

## 6. Users

- `server/services/users.ts:392-423` `deactivateUser(actorId, targetId, now?)`: Owner check, not self, not the Owner,
  keeps one active Owner; `active = false`, sessions deleted, open links revoked, activity `user.deactivated`; then
  `queueRouteSync(userId, actorId, false)` (`:149-157`, job `mailgun.syncRoutes`, dedupe `mailgun:routes`).
  **No campaign handling** (B6.10 "asks the Owner what to do with their active campaigns: pause, or let the follow-ups
  finish"; M3-DESIGN §9.3).
- Route repoint: `server/services/mailgun/routes.ts:196`: `inbox = row.user.active ? (replyInbox || email) : ownerInbox`.
  The store is kept, so replies to a switched-off sender still reach the app. M4 should notify the Owner for them.
- `reactivateUser` (`:426-455`) and `transferOwnership` (`:464-516`) also queue a route sync.
- UI: `app/(app)/settings/team/actions.ts:80-89` `switchOffAction({userId})`. `components/settings/team-manager.tsx:410-417`
  confirm dialog: "X will be signed out everywhere and can't sign in. Their history stays." (nothing about campaigns).
  `TeamMember` (`users.ts:62-72`) has no campaign count.
- The sending engine never checks `sender.active` (gates, `prepareClaimed`, `render.loadSender`), so a switched-off
  sender's RUNNING campaigns keep sending. Only launch refuses an inactive sender (`launch.ts:245-250`).

---

## 7. Schema (`prisma/schema.prisma`; migrations: init, last_contact_at, outbound_recipient_index, m3_mailgun)

| Model | Exists | Obviously missing for M4 (schema change = STOP and report, CONVENTIONS) |
|---|---|---|
| `InboundMessage` (`:725-757`) | `storageKey @unique?`, `messageIdHeader`, `receivedAt`, `toAddress`, `senderAddressId?`, `fromEmail`, `fromName?`, `subject`, `snippet`, `inReplyTo?` (first id), `references?`, `headers Json?`, `kind InboundKind?`, `autoReason?`, `outboundEmailId?`, `personId?`, `companyId?`, `campaignId?`, `answeredAt/ById?`, `confirmedAt/ById?`, `source`, `processedAt?`; indexes `processedAt`, `companyId`, `fromEmail`, `messageIdHeader`. No relations/FKs. | "Answered" vs "No answer needed" can't both fit in `answeredAt`. No assignee (which user must answer: the matched email's sender, `senderAddressId → userId`, or the Owner). No "body missing / log only" flag (POSSIBLE_REPLY). No `linkedById/At` for "Link to a company" (could reuse `confirmed*`). No index for the waiting list (`kind, answeredAt`) or the campaign count (`campaignId, kind`). |
| `InboundKind` (`:116-122`) | REPLY, AUTO_REPLY, BOUNCE_NOTICE, POSSIBLE_REPLY, UNLINKED | nothing for replies to test emails (`TestSend` threads) |
| `InboundSource` (`:110-114`) | NOTIFY, CATCHUP, SIMULATED (unused) | |
| `CampaignRecipient` (`:544-571`) | `state RecipientState` (HELD, RECHECK unused), `stopReason String?`, `currentStep`, `nextDueAt`, `warnings Json?` (overrides); indexes `(companyId, state)`, `(state, nextDueAt)` | when and why held (`heldAt` / outage id) for "I've checked my inbox". Nothing obviously needed for stops. |
| `OutboundEmail` (`:603-653`) | `inReplyTo`, `references`, `providerId` (indexed), `sentAt`, `@@index([toNorm, sentAt])`, `(recipientId, step)` | no held status (a HELD recipient's QUEUED row is still sendable, §0.3) |
| `Notification` (`:781-795`) | `userId, type, title, body?, link?, createdAt, readAt?`; indexes `(userId, readAt)`, `(userId, createdAt)` | no link to InboundMessage, no data or dedupe key (pop-up bodies must be in `title`/`body`) |
| `User.notifyPrefs Json?` (`:173`) | `{desktopReplies}` only | more preferences, if M4 adds them (JSON, no migration) |
| `Person.repliedAt`, `Company.repliedAt`, `CompanyStatus.REPLIED` | exist | writers (§4.1) |
| `ActivityLog` | `reply.received`, `reply.auto` documented (`server/activity.ts:18`) | |
| SystemState | `catchup.outage` (§2.7) | |

---

## 8. M3 tests that pin M3-only behaviour
| Test | What it pins | M4 change |
|---|---|---|
| `tests/integration/sending-m3/modes.test.ts:115-128` | "live: follow-ups are switched off at launch and the campaign finishes after its first emails" (`[1,false],[2,false]`, 1 row, FINISHED) | rewrite: follow-ups stay on and go out |
| `tests/integration/milestone3/end-to-end.test.ts:331, 337-338, 386-388` | "first emails only": 0 enabled steps > 0, 0 rows with step > 0, campaign FINISHED | update or keep (the campaign has follow-ups in its draft) |
| `tests/integration/milestone3/end-to-end.test.ts:340-342` | 3 unprocessed InboundMessage rows before the worker starts | still true before the lane runs. After `runOnce`, M4 processes them (they are reply-test replies: must not mark Replied) |
| `tests/integration/sending/loop.test.ts:130-144` | "sends only first emails in Milestone 2: follow-ups are created and wait" (ungated dry run, `delayDays 0`, `picked 0`, recipient WAITING) | rewrite: the follow-up goes out |
| `tests/unit/campaign-wizard/format-m3.test.ts:69-73` | `FOLLOW_UPS_OFF_TEXT` and the "Sending follow-ups arrives in Milestone 4." sentence | new texts |
| `tests/unit/campaign-wizard/wizard.test.ts:108-114` | the same M4 sentence in `launchSentences` | new text |
| `tests/integration/webhooks/inbound-route.test.ts:59-84` | after the route: `processedAt null, kind null`, ids null, recipient still WAITING ("M3 never stops anyone because of a reply") | valid if processing stays in the lane. Change if the route applies stops |
| `tests/integration/catch-up/catch-up.test.ts:261-269` | catch-up-stored row has `processedAt: null` | the same caveat |
| `tests/integration/sending-m3/gates.test.ts:301-347` | the reply guard's M3 semantics (received during the campaign; test-email replies excluded) | revisit if the guard becomes the full B6.4 rule |
| `tests/integration/team/team.test.ts:347-353` | `getNotifyPrefs` `toEqual({desktopReplies: false})` | update if prefs gain fields |
| `tests/integration/team/team.test.ts:222-274`, `sender-addresses.test.ts:180-189` | `deactivateUser(actorId, targetId)` signature | update if it gains a campaign choice |
| `tests/integration/sending/query-plans.test.ts:113-146` | no full scans for the sweeper, the loop and the campaign page | re-run after adding recipient-state or InboundMessage filters |
| `tests/integration/sending-m3/helpers.ts:217` | `resetSendingState` marks every InboundMessage processed | helper. Keep it in mind when M4 tests share a world |
| `tests/integration/sending/mark-sent.test.ts:149` | comment only ("Milestone 4 does it for real") | — |

---

## 9. Bugs and gaps noticed (existing code)
1. **HELD recipients' emails can still be sent** (§0.3). `pickCandidates` and `prepareClaimed` ignore HELD/RECHECK.
2. **Put-back recipients survive a reply** (§0.6). The `company-replied` override lets their follow-ups pass the
   send-time recheck. Manual status changes never stop recipients (§1.9).
3. **No auto-reply detection, matching or company stop** (§0.5, §0.7). `stopRecipients` has no reply codes or company
   scope. `stopRank` would treat a `replied` code as unrankable.
4. **Threading after a Message-ID rewrite** uses our id, not Mailgun's (§1.4). `restore.ts:399-402` assumes the previous
   step is `step - 1`.
5. `followUpDelayMs` uses 24-hour `Date` arithmetic, not calendar days (CONVENTIONS "never compute days with Date
   arithmetic"). It is up to an hour off across DST; the window gate mostly hides this.
6. The ungated dry-run batch doesn't put follow-ups first (`gates.ts:217`).
7. `pendingProblemIds` loads every unprocessed reply since the oldest launch with no limit, every 5 s.
8. The event lane's `run()` ignores the inbound count when deciding to re-tick (`event-lane.ts:96`).
9. Body-less recovered replies are indistinguishable from empty replies (§2.2).
10. The outage gap is detected only by the Logs walk. A catch-up that keeps failing can let follow-ups out after the
    15-minute fallback before any hold exists (§2.7). One `OutageState` record is shared by every domain.
11. Desktop pop-ups only see new replies among the bell's latest 5 items. Read notifications are deleted after 90 days.
12. Switched-off senders' campaigns keep sending. The deactivation dialog says nothing about campaigns (§6).
13. `InboundSource.SIMULATED` is unused, and Simulate can't do replies or auto-replies (§5.1). The fake's admin
    `/__fake/inbound` drops `headers` and `at` (§5.2).
14. `Company.repliedAt` and `Person.repliedAt` are never written (§4.1). `companySequences` and `detail.ts` disagree
    about which "counts as real" rule applies (§4.5).
