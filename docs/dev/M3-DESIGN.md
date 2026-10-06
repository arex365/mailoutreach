# Milestone 3 build design: Mailgun

The code and its tests win over this file; review fixes are named in the test headers (CRASH-*, SEQ-*, EVENTS-*).

Written 2026-09-23 by the architect, for the lead and the build agents. It turns PLAN.md A8 item 3 and the M3 parts of
B6.5–B6.11, B6.14, B7–B12 into modules, contracts, screens and work packages that 4–6 engineers can build in parallel
without talking to each other.

Sources, all read in full: `SPEC.md`, `PLAN.md`, `docs/dev/CONVENTIONS.md`, `docs/dev/m3-code-map.md`,
`docs/dev/research/{mailgun-api-reference,mailgun-sending,mailgun-events,mailgun-inbound-validation-domain,cloudflare,cloudflare-steps,deliverability-dns,windows-ops}.md`.
Wire formats (paths, fields, error bodies, paging) are NOT repeated here: `mailgun-api-reference.md` is the wire
contract, and its §15 is the fake-server contract. Where this file and PLAN.md disagree, this file wins for M3 and the
difference is listed in §9.2 (technical, the lead confirms) or §9.4 (visible to the owner, the owner confirms).

Revision 2 (2026-09-23, same day): every finding of the spec review and the risk review was checked against PLAN, SPEC
and the code and applied here; the few that were changed or not taken are listed with a reason in §10.

**Nothing in M3 may ever send real email during the build or tests.** Every Mailgun call in tests goes to the local fake
server (§6). The app itself only talks to real Mailgun on the owner's PC, with the owner's key, after the owner connects it.
Nobody on the build side ever uses the owner's key or database, not even read-only (PLAN B9, §9.5).

---

## 0. How to use this document

### 0.1 Order of work

| Step | Who | What | Blocks |
|---|---|---|---|
| **C** (contracts) | Lead, before wave 1 | Apply §3 exactly: Prisma schema + migration, `npx prisma generate`, the four new contract files (`src/core/system-state.ts`, `src/core/setting-types.ts`, `src/core/sending/capday.ts`, `src/core/sending/caps.ts`) and the two edits (`src/server/settings.ts`, `src/server/jobs.ts`, including the redaction fix and its case in `tests/unit/worker/job-errors.test.ts`). Run `npx tsc --noEmit` (both configs) and `npx vitest run` to prove nothing broke. | everything |
| **Wave 1** | P1, P2 in parallel | P1 pure rules + owner guides. P2 Mailgun client, fake Mailgun, shared server foundations. | wave 2 |
| **Wave 2** | P3, P4, P5 in parallel | P3 sending engine. P4 mail events, sync and checks. P5 Mailgun setup and sender identity. | P6 |
| **Final** | P6 (one agent) | Integration: worker wiring, M2 end-to-end test update, README/install guide, scripts, M3 end-to-end test, full `npm run check`. | step S |
| **S** (screens) | Lead, after P6 | Stop the services, `next build` and the worker bundle, start the app on a seeded test database with the fake Mailgun (§6.3), then the screen checks of §8 "Step S" (screenshots, main actions, empty states, errors, axe contrast and keyboard). | milestone review |

Packages are specified in §8 with owned paths, provided/consumed interfaces, tests and done checks.

### 0.2 Rules for every builder (in addition to `docs/dev/CONVENTIONS.md`)

1. Only edit your **owned paths** (§8). The contract files from step C are read-only for everyone: if one is wrong or
   missing something, STOP and report it in your final answer (the lead fixes it and tells the others).
2. Code against the interfaces in this document even when the provider package is being written at the same time. In
   wave 2 you may only import from wave-1 packages, the contract files and existing code, never from a wave-2 peer.
   Cross-package calls inside wave 2 are wired by P6 through the injection points named here.
3. Never write a real Mailgun host name anywhere except `src/server/mailgun/base-url.ts`. Tests use the fake (§6).
4. Every user-visible sentence in this document is the copy to use. Change wording only to fix grammar; keep meaning.
5. No new npm packages. Use `fetch`, `FormData`, `URLSearchParams`, `AbortSignal.timeout/any`, `node:crypto`,
   `node:dns`, `node:http`, `temporal-polyfill`, `zod`.
6. Never use the owner's Mailgun key, the owner's database or a copy of either, for tests or for "just looking". Every
   check runs against the fake (§6) on a test database.

### 0.3 Words used in this document

| Word | Meaning |
|---|---|
| **Mailgun modes** | TEST and LIVE (emails handed to Mailgun). |
| **Counted** | A send that counts toward the daily limit, warm-up and health: mode LIVE, or DRY_RUN in the practice copy (`countsAsReal`). Test sends ("Send me a test", reply tests) also count toward the domain limit. |
| **Emailed** | A counted send that also counts for the 30-day rule, reservations, company status and the `lastEmailed*`/`firstContacted*` fields (`countsAsEmailed`, §1.7): every counted send except LIVE sends before go-live, which can only reach the test list. |
| **Gated** | A campaign email the sending loop sends only inside sending hours, one at a time with pacing gaps: every LIVE and TEST row, and every DRY_RUN row whose campaign has "Ignore sending hours" off. Dry runs with the switch on are ungated, exactly as in M2 (§1.6). |
| **Cap day** | Midnight to midnight in Setting `sending.capDayTimeZone` (default Asia/Karachi). |
| **Real scope / campaign scope** | Whether a mail event may change the person, the suppression list and health (real scope) or only that campaign's own rows (campaign scope). §4.4.2. |
| **Proof of sending** | Any Mailgun event (accepted, delivered, failed, complained, unsubscribed) matched to one of our emails: Mailgun had accepted it (§4.4.2). |
| **Fake mode** | `OUTREACH_MAILGUN_BASE_URL` is `http://127.0.0.1:<port>`, so every Mailgun call goes to the fake server. |
| **Test run** | `OUTREACH_TEST_RUN=1`: Vitest, the screen checks and any `run-prod.mjs --db <other file>` run. A test run refuses every Mailgun host except the fake (§2.5). |

---

## 1. Scope

### 1.1 PLAN A8 item 3, bullet by bullet

| A8 M3 bullet | Built by | Main modules |
|---|---|---|
| Guides: Mailgun and DNS; Cloudflare Tunnel and Access | P1 (guides), P6 (README, install guide) | `docs/setup/2-mailgun-and-dns.md`, `docs/setup/3-cloudflare.md` |
| Connecting Mailgun, "Apply recommended settings" and the domain checklist | P5 (connect, apply, webhooks, routes, pages), P4 (all read-only checks and checklist rows), P2 (client) | `src/server/services/mailgun/{connect,apply-settings,routes,webhooks-setup}.ts`, `src/server/services/checks/*`, `src/core/dns/*`, `/settings/sending`, `/settings/domain` |
| Sending hours, pacing, the daily limit and warm-up, with view and override | P1 (math), P2 (`getTodayCap`), P3 (engine, Limits page) | `src/core/sending/*`, `src/server/services/sending/{gates,warmup-days}.ts`, `/settings/limits` |
| "Send me a test" and the test-list guard | P5 (test sends, test-list editor), P3 (guard at launch and in the final check before every send), P2 (the same guard inside `MailgunClient.sendMessage`, so no path can skip it) | `src/server/services/test-send.ts`, eligibility (existing rule), loop, `src/server/mailgun/send-guard.ts` |
| Bounce, unsubscribe and complaint handling; catch-up after the PC was off; crash-safe sending | P4 (webhooks, events, catch-up, suppressions), P3 (state machine, reconciler, restore) | `src/server/services/mail-events/*`, `src/server/services/mailgun/{catch-up,suppressions}.ts`, `src/server/services/sending/{mailgun-transport,reconcile,restore}.ts` |
| Automatic pause on health problems, and "Pause all sending" | P1 (rules), P2 (pause service), P3 (health check), P5 (pause/resume UI) | `src/core/sending/health.ts`, `src/server/services/sending/{pause,health-check}.ts` |
| Reply routes (one per sender plus a catch-all), created by "Apply recommended settings" | P5 | `src/core/mailgun/routes.ts`, `src/server/services/mailgun/routes.ts` |
| The real-reply test that decides the unsubscribe setup (A4 point 5) | P5 (UI, sends, decision), P4 (stores the replies and events it reads) | `src/core/reply-test.ts`, `src/server/services/reply-test.ts`, Domain checklist "Reply test" section |
| Test-list addresses count as checked before go-live | Already in M2 (`core/rules/eligibility.ts`); P3 verifies with a test. New: test-list sends before go-live don't count as "emailed" (§1.7) | `src/core/rules/mode.ts`, eligibility, reservations, `markSent` |
| You'll test: phone through Cloudflare; green ticks; live campaign to the test list and replies; simulated bounce and unsubscribe | P1 guides (order: checklist green → reply test → live campaign to the test list), P4 (System card, simulate tools), P5 (checklist, reply test), P3 (live sending) | — |

### 1.2 PLAN Part B sections, M3 parts

| Section | M3 part | Package |
|---|---|---|
| B1 guard | "Apply recommended settings" refuses webhooks/routes unless `APP_PUBLIC_URL` is https and `GET <pub>/api/health` returns the app's JSON (fake mode: `http://127.0.0.1:<port>` allowed). B1 start-up order "catch up, then evaluate closed days, then send" is kept by the catch-up gate (§4.3.2) and by evaluating warm-up after each successful catch-up (§4.3.8) | P5, P3, P6 |
| B4 | Schema additions (§3), SystemState keys (§2.3), SyncCursor keys (§2.4) | Lead (C) |
| B5 | Webhook routes return 500 on retryable DB errors; claims stay autocommit; catch-up transactions ≤ 20 events; `casState` survives a create race; the two-process test covers the new writers | P4, P3, P2 |
| B6.1 | `markSent()` stays the single "sent" writer; reconciler, restore and every proof of sending use it. Test-list sends before go-live: no reservations, ignored by the team rule, no company or person "emailed" fields (§1.7) | P3 |
| B6.2 | `no-reply-route` rule fed (`senderHasReplyRoute`) at launch. At send time a broken route is a wait, never a stop (§4.3.2). Test-list rule unchanged | P3 |
| B6.4 | Instant stop in the webhook transaction (events); batched "before every send" guard for unprocessed events and replies (§4.3.4). Follow-ups, their stop rules and outage hold: **M4** | P4 (instant stop), P3 (guard) |
| B6.5 | TEST and LIVE modes; test-list guard (launch, final check before the POST, and inside the client); practice copy refuses Mailgun modes; the "Ignore sending hours" helper for every dry run; mode matrix §1.6 | P3, P5, P2 |
| B6.6 | Sending hours, pacing, caps, per-sender cap, warm-up table and evaluation, health auto-pause with fixed denominators and baseline, other automatic pauses (incl. a rejection circuit breaker), Pause all | P1, P2, P3 |
| B6.7 | Claim → POST → typed outcome; provider id saved before `markSent`; reconciler with a positive control before any requeue; Unconfirmed "Retry or Skip?"; restore flow with a two-pass scan and a send gate | P3 |
| B6.8 | Message fields; tracking off; HTTPS unsubscribe links (x509); Setup A tested first, B only as a check, C contingent (needs owner OK); **live campaigns locked until the reply test passes**; spam_action tag; retention; DMARC route | P2 (fields), P5, P3 (launch lock, live-not-ready hold) |
| B6.9 | Verification: **M5**. Client leaves room for `validateAddress` | — |
| B6.10 | Routes per SenderAddress + catch-all + dmarc@, anchored escaped regex, `/routes/match` check by route id, deactivated users' routes forward to the Owner. Reply matching and auto-replies: **M4** | P5 |
| B6.11 | Both webhook endpoints, checks in order, response table, one `applyMailEvent`, catch-up (queues, tracking, suppressions, logs with cursor rules, stored inbound), resume after catch-up | P4, P3 (catch-up gate reads `lastSuccessAt`) |
| B6.14 | Notification types, settings keys (§2.1). The backup's "quiet moment outside every open sending window" stays M1's fixed 22:00–08:00 for now (§9.3) | all |
| B7 | Two public POST routes; new Server Actions (§5); `/api/jobs/:id` already refuses `mailgun.*` to Members | P3, P4, P5 |
| B8 | Event lane 1 s, reconciler 10 min, monitor loop 5 min (tunnel), periodic catch-up hourly, domain check 6 h, warm-up hourly check; new job types | P3, P4, P5 build; P6 wires |
| B9 | All Mailgun endpoints (with the corrections in §9.2), node:dns, cloudflared `/ready`. "My own checks … never your database or keys": no probes on the owner's account (§9.5) | P2, P4 |
| B10 | Webhook security (capped bodies, counted rejections, redaction); sender-address validation, uniqueness, reserved names, blocked while TEST/LIVE campaigns are active, change notifies the Owner; reply inboxes never on a sending domain; "Send me a test" own inbox only, 20/day, counts toward the cap, refused when suppressed | P4, P5, P2 |
| B11 | cloudflared install/update facts in the guide; tunnel check; status.bat shows the Cloudflared service | P1, P4, P6 |
| B12 | Tests listed per package (§8), including the two-processes test for webhooks and the screen checks (step S) | all, lead |

### 1.3 Deferred, and the hooks M3 leaves

| Deferred item | Milestone | Hook M3 leaves |
|---|---|---|
| Sending follow-ups (steps 1–3), "Re:" threading in practice | M4 | `MAX_SENDABLE_STEP` stays **0** in `loop.ts`. The candidate query already orders by `step desc` (follow-ups first), and `MailgunTransport` already sends `h:In-Reply-To`/`h:References` when the row has them. M4 changes one constant plus the stop rules. Dry-run follow-up rows keep being created by `markSent()` as in M2 and simply wait. **TEST and LIVE campaigns launched in M3 send first emails only:** launch switches off their steps above `MAX_SENDABLE_STEP` (§4.3.9), so they finish, release everything, and M4 never finds overdue M3 follow-ups. |
| Reply processing: matching, auto-replies, "Replied" status, company stop, reply notifications, "waiting for an answer" | M4 | Inbound notifications are verified and stored as `InboundMessage` rows with `processedAt = null` and `kind = null` (§1.4). The event lane has a `processInbound` slot that is a no-op in M3. The send-time guard (§4.3.4) holds an address, and its company, while a reply received during that campaign is unprocessed. No stop is applied in M3, because M3 can't yet tell a reply from an out-of-office message. |
| Outage hold ("On hold: replies may have been missed") | M4 | Catch-up writes SystemState `catchup.outage` (log gap and message-retention gap). |
| "Who has been emailed" everywhere, Notifications page features | M4 | — |
| Verification adapter and policy | M5 | `MailgunClient` is the place for `validateAddress()`; eligibility untouched. |
| Go-live switch, dashboard, settings polish, full E2E | M6 | M3 builds the guard `goLiveBlockers()` (P5) and shows it disabled with the blocker list. Dashboard tiles can read `health`/`warmup`/`tunnel` state (§2.3). |
| Deactivating a user: "what about their active campaigns?" (B6.10) | M4 (§9.3) | M3 only repoints the user's route forward to the Owner (B6.10). A8's M4 list doesn't name it, so §9.3 records it. |
| Setup C (reply subdomain) | Only if Setup A fails and the owner agrees | `OutgoingMessage.replyTo` exists; Setting `mailgun.unsubscribeTest.setup` accepts `"C"`; nothing else is built. |

### 1.4 Decision: inbound (reply) notifications in M3

`POST /api/webhooks/mailgun/inbound` does exactly this, in this order: content type and capped body read → read the
form → signature fields → HMAC → freshness (24 h) → in ONE transaction: store the token, store an `InboundMessage`
(`source NOTIFY`, `fromEmail` normalised with `normalizeEmail`, `processedAt null`, `kind null`, `senderAddressId` when
the recipient is one of our sender addresses) → **200** (§4.4.1). Catch-up also stores replies it finds through Logs
`stored` events (`source CATCHUP`). Nothing else happens in M3: no status change, no stop, no notification, no timeline
entry, and `personId`/`companyId`/`campaignId` stay null (M4's matching owns them). M4 processes every unprocessed row,
oldest first (M4 must decide what to do with rows older than a few days; a note in §9.3).

What M3 does use these rows for:
- the send-time guard (§4.3.4): hold emails to an address, or to its company, while a reply that arrived during that
  campaign is unprocessed (replies to reply-test emails excluded);
- the reply test (§1.5, §5.3): "Reply reached the app ✓".

### 1.5 Decision: the real-reply test that decides the unsubscribe setup

**Why:** SPEC asks for Mailgun's own unsubscribe handling AND for replies to be forwarded to each sender's inbox. Mailgun
warns that domain-level tracking can alter forwarded messages and break DKIM (A4.5, research). So before real sending
leaves the test list, a real test proves that replies still arrive cleanly.

**Setups** (Setting `mailgun.unsubscribeTest.setup`):
- **A (default, tried first):** domain unsubscribe tracking ON, Mailgun's own footers blank; our footer carries
  `%unsubscribe_url%`; Mailgun adds `List-Unsubscribe` + `List-Unsubscribe-Post`.
- **B (check only):** unsubscribe tracking OFF. Expected to fail (the link stays literal). The Owner may run it to confirm;
  it is never used for campaigns.
- **C (contingent):** a reply subdomain with its own Mailgun domain. Not built in M3; needs the owner's OK (§9.4).

**The in-app step** lives on Settings › Domain checklist, section "Reply test" (P5). It is a guided checklist:

0. **Before it can start** (`replyTestBlockers`, §4.5.7): the button stays disabled and lists what's missing until
   every one of these holds, because results from a half-set-up domain mean nothing: sending mode is Test mode or Live
   (test sends need Mailgun); every `liveModeBlockers()` item is clear (DNS confirmed, open/click tracking off,
   unsubscribe handling on with blank footers, webhooks registered, signing key saved, Mailgun accepting emails); the
   Owner's reply route is `ok` ("Your reply route isn't working yet. Click Apply recommended settings."); the public
   address works ("Remote access doesn't work yet. Finish the Cloudflare guide."); the test list has at least one
   mailbox; Setup is A or B.
1. **Send the test emails.** Button "Send test emails to my test list" (enqueues job `send.testEmail`, purpose
   `REPLY_TEST`, dedupe `send:reply-test`, `maxAttempts 1`). One email per test-list address, From the Owner's sending
   address, rendered with the real footer. Each email's Message-ID is fixed by the job and the address, so a re-run of
   the same job never sends a mailbox twice (§4.5.5). Subject: `Reply test from Polygon Paradise Outreach`. Body:
   ```
   Hi,

   This is a test from the Polygon Paradise outreach app. Please reply to this email with a short message such as "Got it".

   If it landed in spam, move it to your inbox first, then reply.

   <sender signature>
   <standard footer with %unsubscribe_url%>
   ```
2. **Reply from each mailbox.** The app shows, per mailbox, three facts it can see itself: "Test email delivered"
   (a `delivered` MailEvent with `testSendId` = that mailbox's latest reply-test TestSend on the current domain),
   "Reply reached the app" (an `InboundMessage` from that address to the Owner's sender address, received after the
   test was sent), and the provider (Gmail / Outlook.com / Yahoo / Other, from the address's domain).
3. **Answer two questions per mailbox** (the app can't see the Owner's inbox):
   - "Did the reply arrive in your reply inbox, not in spam?" Yes / No
   - "Open the reply in your inbox and show its original (Gmail: ⋮ › Show original. Outlook.com: ⋯ › View › View message
     source). Does it say `dkim=pass` or `arc=pass`?" Yes / No / Not sure
   - "Not sure" opens a box "Paste the email's original headers here, and the app reads them for you." The pure
     `parseAuthResults(text)` (§4.5.6) reads `Authentication-Results` and `ARC-Authentication-Results` and fills the
     answer: `dkim=pass` or `arc=pass` → Yes ("The headers say dkim=pass."); a `dkim=fail`/`arc=fail` with no pass → No;
     neither → stays Not sure ("The headers don't show a DKIM or ARC result. Paste the whole original, starting at the
     first line."). The pasted text is never stored.
4. **Check the unsubscribe link and headers once:** "In one test mailbox, open the test email's original. Do you see
   `List-Unsubscribe: <https://…>` and `List-Unsubscribe-Post`?" Yes / No. Then "Click the unsubscribe link at the bottom
   of that test email." The app shows "Unsubscribe reached the app ✓" when an `unsubscribed` event arrives for a
   test-list address after the test was sent, with a link to Settings › Deliverability to put that test address back
   ("Remove from the do-not-email list", allowed only for test-list addresses and active users' reply inboxes, §4.4.6).
5. **Result** (pure `evaluateReplyTest`, §4.5.6): **Passed** when at least one Outlook.com/Hotmail/Live mailbox AND at
   least one Gmail or Yahoo mailbox each have: delivered, reply reached the app, inbox = Yes, DKIM/ARC = Yes; plus
   headers = Yes and the unsubscribe reached the app. **Failed** as soon as any mailbox has inbox = No or DKIM/ARC = No.
   Otherwise **Not finished**. The Owner clicks "Save the result" (the section's action, outline); the result, setup
   letter, the sending domain it was tested on, answers, who and when are stored in Setting `mailgun.unsubscribeTest`.
   A pass belongs to one domain: when Setting `mailgun.domain` changes, `connectMailgun` resets the setting to
   `untested` with `domain: null` (§4.5.1).
6. **If failed:** the section explains Setup B (optional check) and C: "Setup A didn't pass. The usual fix is a separate
   reply address such as ali@reply.<domain>. This needs a small change to the app and your OK." Live campaigns stay
   locked.

**What it locks** (PLAN B6.8 "Live campaigns stay locked until one setup passes", A4.5): launching a LIVE campaign is
refused until `mailgun.unsubscribeTest.status = "passed"` and its `domain` equals the current sending domain:
"Live campaigns start once the reply test has passed (Settings › Domain checklist › Reply test)." (`liveLaunchBlockers`,
§4.5.7; shown in the wizard's `modeBlockers`). Setting the mode to Live is allowed before the pass, because the reply
test's own emails need Mailgun (they are test sends, not a campaign). Go-live (M6) also requires the pass (row
`reply-test` in `goLiveBlockers`). The owner's A8 test therefore runs in this order: checklist green → reply test passed
→ small live campaign to the test-list mailboxes (§7.1 steps 13–14).

### 1.6 Mode matrix (what the sending loop does per campaign mode)

| | Dry run, real data | Dry run, practice copy | TEST (Mailgun test mode) | LIVE before go-live | LIVE after go-live (M6) |
|---|---|---|---|---|---|
| Transport | DryRunTransport | DryRunTransport | MailgunTransport, `o:testmode=yes` | MailgunTransport | MailgunTransport |
| Who can receive | anyone eligible | anyone eligible | test list only | test list only | anyone eligible |
| "Ignore sending hours" switch (Schedule step) | shown, **default on** | shown, default off | not shown (off) | not shown (off) | not shown (off) |
| Sending hours | only when the switch is off | only when the switch is off | yes | yes | yes |
| Pacing (gaps, shared pacer) | only when the switch is off; else 25 per tick (as M2) | only when the switch is off | yes | yes | yes |
| Domain cap / sender cap | no | yes | no | yes | yes |
| Health counts | no | yes | never | yes | yes |
| Counts as "emailed" (30-day rule, reservations, company status, `lastEmailed*`) | no | yes | no | **no** (§1.7) | yes |
| Global pause stops it | yes | yes | yes | yes | yes |
| Needs Mailgun connected | no | no | yes (rows wait) | yes (rows wait) | yes |
| Waits for the catch-up after start and for the restore check | no | no | yes (§4.3.2) | yes | yes |
| Held while the live settings drifted (`live-not-ready`) | no | no | no | yes | yes |
| Launch allowed | yes | yes | not in practice copy; `testModeBlockers` empty | not in practice copy; `liveLaunchBlockers` empty (incl. the reply test passed) | same |
| Follow-ups in M3 | rows created, wait for M4 (as M2) | same | switched off at launch (§4.3.9) | switched off at launch | — |
| Events change person / suppressions | only that campaign | yes (real scope) | only that campaign | yes | yes |

"Send me a test" and reply-test emails are always delivered for real (never `o:testmode`), are only possible while the
Setting `sending.mode` is TEST or LIVE, count toward the domain cap, and are refused while paused (§4.5.5).

### 1.7 Decision: test-list sends before go-live

Before go-live, a LIVE campaign can only reach test-list mailboxes (the owner's own). Counting those sends as "emailed"
would block the same mailboxes for 30 days, so the owner couldn't repeat the A8 M3 test after a fix, nor run the A8 M4
test ("a small live campaign to your test-list mailboxes"). So, while Setting `sending.goLive` is false:

- LIVE sends still count toward the daily limit, warm-up and health (they are real sends that shape the domain's
  reputation), and they still show on the campaign page, the timeline and the activity log;
- a LIVE campaign takes **no reservations** (at launch, at send time, on resume and on retry);
- LIVE history rows are **ignored by the 30-day rule** (and so by the "already received this step" part of it);
- `markSent` does **not** change company status, `firstContacted*`, or the company's and person's `lastEmailed*`.

One pure helper carries the rule, next to `countsAsReal` in `src/core/rules/mode.ts` (P3):

```ts
/** "Emailed" (PLAN A5.1): counts for the 30-day rule, reservations, company status and lastEmailed*. */
export function countsAsEmailed(mode: SendModeValue | null, ctx: { practiceCopy: boolean; goLive: boolean }): boolean;
//  = countsAsReal(mode, practiceCopy) && !(mode === "LIVE" && !goLive)
export function emailedModes(ctx: { practiceCopy: boolean; goLive: boolean }): SendModeValue[]; // realModes minus LIVE before go-live
```

Callers switch from `countsAsReal` to `countsAsEmailed` where "emailed" is meant: `launch.ts` (`takesReservations`),
`loop.ts` (`ensureReservation`), `control.ts` (resume, retry), `eligibility.ts` (`loadHistory` modes),
`mark-sent.ts` (`recordRealContact`), `companies/detail.ts` (the "Emailed" banner). Caps, pacing and health keep
`countsAsReal`/`realModes`. The guide (§7.1 step 13) tells the owner to add one company per test mailbox in a list
called "Test mailboxes", so the test campaigns never touch real companies. This narrows A5.1's meaning of "emailed", so
the owner confirms it (§9.4). M6 must decide what pre-go-live LIVE rows mean once go-live is on (§9.3).

---

## 2. Settings, secrets and state

### 2.1 Settings (`Setting`, Owner-edited, `@/server/settings`)

Existing keys M3 starts to use or edit (defaults already in `SETTING_DEFAULTS`):

| Key | Default | Edited on | Validation (zod, plain messages) |
|---|---|---|---|
| `sending.mode` | `"DRY_RUN"` | Sending & Mailgun | `DRY_RUN`/`TEST`/`LIVE`; TEST needs `testModeBlockers()` empty; LIVE needs `liveModeBlockers()` empty (§4.5.7); never TEST/LIVE in the practice copy. Switching away from LIVE/TEST while such campaigns are Scheduled or Running shows (does not block) "1 live campaign is still sending: <names>. New campaigns use the new mode; pause that campaign, or use Pause all sending, to stop it." |
| `sending.goLive` | `false` | not editable in M3 | stays false; M6 builds the switch |
| `sending.testList` | `[]` | Sending & Mailgun | ≤ 10 addresses, each `parseEmail` ok, lowercased, de-duplicated; not on any sending domain ("{a} is on your sending domain. Use a normal mailbox, such as Gmail or Outlook.com."); warn (not block) when equal to a teammate's reply inbox ("Gmail hides emails sent to and from the same address, so use a different mailbox.") |
| `sending.window` | `{days:[1..5], start:"09:00", end:"17:00"}` | Limits & warm-up | days ⊆ 1..7 (ISO, Mon=1), at least one; `HH:MM` 24 h on 15-minute steps; start < end ("The end time must be after the start time.") |
| `sending.maxDailyCap` | 1000 | Limits & warm-up | integer 50–10,000 |
| `sending.capDayTimeZone` | `"Asia/Karachi"` | Limits & warm-up | valid IANA zone (`isValidTimeZone`) |
| `sending.minGapSeconds` | 20 | Limits & warm-up | integer 20–3,600 (B6.6: "a minimum of 20 s") |
| `warmup.startCap` / `warmup.steps` / `warmup.minUsePercent` | 50 / 20 / 50 | Limits & warm-up (advanced) | 10–500 and ≤ maxDailyCap / 5–60 / 10–100 |
| `warmup.healthyBouncePercent` / `warmup.healthyComplaintPercent` | 2 / 0.05 | Deliverability | 0.1–10 / 0.01–1 |
| `health.bounceWindow` / `health.bouncePercent` | 200 / 3 | Deliverability | 50–5,000 / 0.5–10 |
| `health.complaintWindow` / `health.complaintPercent` | 1000 / 0.1 | Deliverability | 200–20,000 / 0.01–1 |
| `footer.companyName` / `footer.address` / `footer.unsubscribeText` | as M2 | Email footer | 1–100 / 1–200 no line breaks / 1–150, must not contain `%` |
| `portfolioUrl` | `https://www.polygonparadise.com` | Email footer | `https://` URL |
| `defaultTimeZone` | `"Europe/Berlin"` | Limits & warm-up | valid IANA zone |
| `mailgun.region` | `"EU"` | Sending & Mailgun | `EU`/`US` |
| `mailgun.domain` | `null` | Sending & Mailgun | lowercase host name, 2+ labels, each `[a-z0-9-]`, no leading/trailing `-`, ≤ 253 chars; not `polygonparadise.com` or `www.polygonparadise.com` ("Use a separate sending domain, not polygonparadise.com itself."); not a shared/free-mail domain (`isSharedDomain`) |
| `mailgun.logRetentionDays` / `mailgun.messageRetentionDays` | 5 / 1 | Sending & Mailgun (advanced: "Your Mailgun plan keeps…") | 1–30 / 1–7 |

New keys (added in step C, §3.4):

| Key | Default | Shape | Edited on | Validation |
|---|---|---|---|---|
| `sending.capOverride` | `null` | `CapOverride \| null` = `{capDay:"YYYY-MM-DD", cap:number, byUserId:number, at:ISO}` | Limits & warm-up ("Change today's limit", with confirmation) | integer 0–maxDailyCap; `capDay` is always today's cap day; ignored on any other day |
| `mailgun.unsubscribeTest` | `DEFAULT_UNSUBSCRIBE_TEST` | `UnsubscribeTestSetting` (§3.4) | Domain checklist › Reply test | answers only for current test-list mailboxes; `status` and `domain` only written by `decideReplyTest`; reset to the default by `connectMailgun` when the domain changes and by `switchUnsubscribeSetup`. Only the Owner's actions write it (the worker never does), so no save can overwrite another |
| `mailgun.domainRegisteredOn` | `null` | `"YYYY-MM-DD" \| null` | Domain checklist, optional row "Domain age" | a date not in the future |

### 2.2 Secrets (`Secret`, `@/server/secrets`, never sent to the browser)

| Key (existing union) | Required | Set by | Used for |
|---|---|---|---|
| `mailgun.apiKey` | yes | Sending & Mailgun "Save and connect" (only after a successful test) | every Mailgun call |
| `mailgun.webhookSigningKey` | yes for webhooks | fetched automatically at connect and by Apply (`GET /v5/accounts/http_signing_key`); never typed by the owner; never regenerated by the app | HMAC of both webhook endpoints |
| `mailgun.sendingKey` | no | Sending & Mailgun, advanced ("Domain sending key, optional") | `POST /v3/{d}/messages` only, when set |

(The task brief calls the signing key `mailgun.signingKey`; the existing union name `mailgun.webhookSigningKey` is kept.)
Keys are trimmed and stripped of zero-width characters (`\u200b-\u200d\ufeff`) before saving. Every job and log error
goes through `describeJobError(err, await mailgunSecrets())` (\u00a74.2.4), which hides each saved key AND its Basic-auth
form `base64("api:" + key)`. Fake-mode rule (\u00a72.5): with the fake server, only keys starting `key-fake-` are used; outside
fake mode, a key starting `key-fake-` is refused ("This is a test key. Paste the key from Mailgun \u203a API Security.").

### 2.3 SystemState (worker-owned, CAS; types in the contract file §3.3, parsers by P2)

All values are JSON objects. Dates are ISO strings. Missing rows mean the default shown.

| Key | Written by | Read by | Shape (type in §3.3) | Default |
|---|---|---|---|---|
| `sending.pause` | P2 pause service (callers P3, P4, P5) | pill, all sending, pages | `PauseState` — keeps the M2 fields `paused`, `reason` | `NOT_PAUSED` |
| `health.baseline` | P2 `resumeSending` (when the main or any `also` kind is health), P3 warnings | P3 health check, P4 Deliverability page | `HealthBaseline` | `{since:null,…}` |
| `warmup` | P3 `evaluateWarmupDays` | P2 `getTodayCap`, P3 Limits page | `WarmupState` | `{domain:null, step:0, lastEvaluatedCapDay:null, startedCapDay:null, history:[]}` |
| `sending.pacer` | P3 loop | P3 Limits page, campaign page | `PacerState` (next send, back-off, streaks, why it's waiting) | all null / 0 |
| `sending.day` | P3 loop | P3 | `SendingDayState` (cap-reached notice once a day) | `{capDay:null, capReachedNotifiedAt:null}` |
| `mailgun.catchUp` | P4 catch-up job | P3 catch-up gate and warm-up, P4/P5 pages | `CatchUpState` | all null |
| `catchup.outage` | P4 catch-up | M4 outage hold; Sending & Mailgun "Check with Mailgun" line | `OutageState` | all null/false |
| `restore` | P3 restore | P2 resume, P3 send gate, P5 pause card | `RestoreState` | `{status:"none",…}` |
| `instance` | P3 `checkDatabaseInstance` (start-up) | P3 | `InstanceState` (which database file this is) | none |
| `tunnel.status` | P4 monitor loop | P4 System card, P4 checks, P4 webhook handler (self-check nonce) | `TunnelState` | `{state:"unknown",…}` |
| `mailgun.setup` | P5 apply job | P5 pages, P4 checks (certificate) | `MailgunSetupState` | `{runAt:null, steps:[], certificate:null,…}` |
| `domain.check` | P4 check job | P5 Domain checklist and mode gates, P3 launch and `live-not-ready` hold | `DomainCheckState` (all checklist rows) | `{rows:[],…}` |
| `mailgun.logsForm` | P2 client, P3 reconciler (proven filters) | P2 client, P3 reconciler | `LogsFormState` (`duration` fallback, which `message_id` form and filters are proven) | `{useDuration:false,…}` |
| `webhooks.stats` | P4 webhook handlers (web process; `updateTyped` CAS, at most once a minute unless a counted rejection) | P4 checks | `WebhookStats` | all null / `[]` |
| `notices` | anyone sending throttled Owner notices | same | `NoticesState` = `{[noticeKey]: ISO}` | `{}` |
| `task.<name>`, `repair.<name>` | existing | existing | existing | — |

Notice keys (at most one notification per key per 24 h): `mailgun-auth`, `mailgun-not-allowed`, `mailgun-queue`,
`tracking-drift`, `webhook-rejected`, `catchup-failing`, `tunnel-down`, `cert-expired`, `options-too-large`,
`mailgun-unreachable`, `reply-route-down`, `sent-not-recorded`, `message-id-rewritten`, `email-duplicate`,
`event-failed`, `reply-inbox-suppressed`.

Today's counters are **not stored**: they are counted from `OutboundEmail`/`TestSend` rows every time (§4.2.5).

### 2.4 SyncCursor keys (existing table; value = ISO instant)

| Key | Meaning |
|---|---|
| `<domain>:logs` | Every Logs event up to this instant has been applied. After a complete walk it becomes `min(queryEnd, walkStartedAt) − 30 min`, and it never moves backwards. |
| `<domain>:stored` | Every `stored` (inbound) Logs event up to this instant has been fetched or recorded (same rule). |
| `<domain>:suppressions` | Last complete pull of all three suppression lists (informational). |

### 2.5 Environment variables

| Variable | Where read | Rule |
|---|---|---|
| `APP_PUBLIC_URL` | `publicUrl()` (existing) | Webhook URL = `${pub}/api/webhooks/mailgun/events`, inbound = `${pub}/api/webhooks/mailgun/inbound`. Must be `https://` for Apply, except in fake mode where `http://127.0.0.1:<port>` is accepted. |
| `OUTREACH_MAILGUN_BASE_URL` (new) | `src/server/mailgun/base-url.ts` only | Honoured only when it matches `^http://127\.0\.0\.1:\d{2,5}$` (never `localhost`, which the Windows hosts file can redirect); anything else is ignored with a logged warning. Refused (fake mode off, loud log) when `path.basename(databaseFilePath())` is `app.db`, so the owner's database never talks to a fake. Never written to `.env` by any script. Logged loudly by the worker at start and shown as a banner on Settings › Sending & Mailgun. |
| `OUTREACH_TEST_RUN` (new) | base-url | `"1"` marks a test run. Set by `tests/setup/env.ts`, by the step-S screen-check config, and by `scripts/run-prod.mjs` whenever `--db` points to a different file than `.env`'s `DATABASE_URL` (P6). In a test run, a missing or non-loopback override makes `mailgunApiBase` throw "Test runs must use the fake Mailgun server (set OUTREACH_MAILGUN_BASE_URL).", and every client refuses a non-loopback base URL. This works even though run-prod, the services and the screen-check server force `NODE_ENV=production`. |
| `VITEST` / `NODE_ENV=test` | base-url | Treated as a test run too (belt and braces). `tests/setup/env.ts` sets `OUTREACH_TEST_RUN = "1"` and `OUTREACH_MAILGUN_BASE_URL ??= "http://127.0.0.1:9"`, so a forgotten fake fails fast with ECONNREFUSED. |

---

## 3. Contracts applied by the lead before wave 1 (step C)

### 3.1 Prisma schema diff (`prisma/schema.prisma`)

```diff
 model SendingDomain {
   id             Int       @id @default(autoincrement())
   name           String    @unique
   region         String // "EU" | "US"
   active         Boolean   @default(true)
   lastLiveSendAt DateTime?
+  /// Mailgun ids of the app's own catch-all and dmarc@ routes for this domain (descriptions "outreach-app:…").
+  catchAllRouteId String?
+  dmarcRouteId    String?
   createdAt      DateTime  @default(now())

   senderAddresses SenderAddress[]
 }

 model SenderAddress {
   id             Int       @id @default(autoincrement())
   userId         Int
   domainId       Int
   localPart      String
   address        String    @unique
   mailgunRouteId String?
-  routeStatus    String?
+  routeStatus    String? // "pending" | "ok" | "mismatch" | "error"
+  /// The inbox the route forwards to, as last synced (the user's reply inbox, or the Owner's for a switched-off user).
+  forwardTo      String?
+  routeCheckedAt DateTime?
+  routeError     String?
   retiredAt      DateTime?
   createdAt      DateTime  @default(now())
```

```diff
 model TestSend {
   id          Int      @id @default(autoincrement())
   userId      Int
   to          String
   subject     String
   mode        SendMode
   recipientId Int?
   providerId  String?
   sentAt      DateTime @default(now())
+  /// "SELF" = "Send me a test" to the user's own reply inbox; "REPLY_TEST" = the reply test to a test-list mailbox.
+  purpose     String     @default("SELF")
+  /// Our Message-ID (lowercase, no angle brackets), so Mailgun events and replies can be matched to the test.
+  messageId   String?    @unique
+  status      SendStatus @default(SENT)
+  error       String?

   @@index([userId, sentAt])
 }
```

```diff
 model OutboundEmail {
   …
   @@index([campaignId, step, status])
+  /// Events may carry Mailgun's own id when it rewrote ours (§4.4.2 matching order).
+  @@index([providerId])
 }
```

```diff
 model MailEvent {
   …
   outboundEmailId Int?
+  /// The TestSend ("Send me a test" or reply test) this event belongs to, when it matched one.
+  testSendId      Int?
   isTestMode      Boolean     @default(false)
   …
   @@index([processedAt])
   @@index([messageId])
   @@index([recipient])
+  @@index([outboundEmailId])
+  @@index([testSendId])
 }
```

Data change (no schema): `Campaign.ignoreWindow` becomes true for every campaign already launched in dry run, so M2
dry runs keep sending exactly as before now that the switch means "gated when off" (§1.6).

Nothing else changes. `Campaign.sendingDomainId` keeps no foreign key (M2 note), and `Campaign.fromAddress` (bare) vs
`OutboundEmail.fromAddress` (full From line) keep their meanings.

### 3.2 Migration `prisma/migrations/20260923180000_m3_mailgun/migration.sql`

```sql
-- Milestone 3 (Mailgun): new nullable/defaulted columns and four indexes. Safe on existing data.

-- AlterTable
ALTER TABLE "SendingDomain" ADD COLUMN "catchAllRouteId" TEXT;
ALTER TABLE "SendingDomain" ADD COLUMN "dmarcRouteId" TEXT;

-- AlterTable
ALTER TABLE "SenderAddress" ADD COLUMN "forwardTo" TEXT;
ALTER TABLE "SenderAddress" ADD COLUMN "routeCheckedAt" DATETIME;
ALTER TABLE "SenderAddress" ADD COLUMN "routeError" TEXT;

-- AlterTable
ALTER TABLE "TestSend" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'SELF';
ALTER TABLE "TestSend" ADD COLUMN "messageId" TEXT;
ALTER TABLE "TestSend" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SENT';
ALTER TABLE "TestSend" ADD COLUMN "error" TEXT;

-- AlterTable
ALTER TABLE "MailEvent" ADD COLUMN "testSendId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "TestSend_messageId_key" ON "TestSend"("messageId");

-- CreateIndex: lets the health check count bounces for a window of emails without scanning every event.
CREATE INDEX "MailEvent_outboundEmailId_idx" ON "MailEvent"("outboundEmailId");

-- CreateIndex: reply-test facts and "Send me a test" events.
CREATE INDEX "MailEvent_testSendId_idx" ON "MailEvent"("testSendId");

-- CreateIndex: events that carry Mailgun's id instead of ours.
CREATE INDEX "OutboundEmail_providerId_idx" ON "OutboundEmail"("providerId");

-- Data: dry runs launched before M3 keep ignoring sending hours (M2 behaviour; the switch now means "gated when off").
UPDATE "Campaign" SET "ignoreWindow" = true WHERE "mode" = 'DRY_RUN';
```

The lead checks the DDL against Prisma's own output (`prisma migrate diff` from the migrations to the schema; the final
`UPDATE` is hand-added and has no diff counterpart) before applying, then runs `npx prisma generate`. The lead also
confirms `Campaign.ignoreWindow` is `Boolean @default(false)` in the init migration (SQLite stores `true` as 1).

### 3.3 `src/core/system-state.ts` (new contract file; types only)

```ts
/**
 * Milestone 3 contract (docs/dev/M3-DESIGN.md §2.3): SystemState keys and JSON shapes.
 * SystemState is worker-owned (PLAN B4): read with getState(), written with casState()/setState()
 * from @/server/state, always through the parse functions in @/core/system-state-parse.
 * Dates are ISO strings; cap days are "YYYY-MM-DD" (see @/core/sending/capday).
 */
export const STATE_KEYS = {
  pause: "sending.pause",
  healthBaseline: "health.baseline",
  warmup: "warmup",
  pacer: "sending.pacer",
  sendingDay: "sending.day",
  catchUp: "mailgun.catchUp",
  outage: "catchup.outage",
  restore: "restore",
  tunnel: "tunnel.status",
  mailgunSetup: "mailgun.setup",
  domainCheck: "domain.check",
  logsForm: "mailgun.logsForm",
  webhooks: "webhooks.stats",
  notices: "notices",
  instance: "instance",
} as const;
export type StateKey = (typeof STATE_KEYS)[keyof typeof STATE_KEYS];

// ── global pause ──
export type PauseKind =
  | "manual"
  | "health-bounce"
  | "health-complaint"
  | "mailgun-auth"
  | "mailgun-verification"
  | "mailgun-not-allowed"
  | "mailgun-domain"
  | "mailgun-queue"
  | "mailgun-settings"
  | "restore"
  | "copied-database";
export type PauseDetail = {
  /** Health: problems counted, emails in the sample, window size, the limit ("more than N"). */
  count?: number;
  sample?: number;
  window?: number;
  limit?: number;
  /** Mailgun's own error text, shown behind "Details". */
  mailgunMessage?: string;
  /** Mailgun queue disabled until (ISO). */
  until?: string;
};
export type PauseState = {
  paused: boolean;
  /** Short, for the top-bar label "Paused: <reason>", e.g. "7 of the last 200 emails bounced". */
  reason: string;
  kind: PauseKind | null;
  /** What to do, full sentences, e.g. "Open the bounced list, …, then click Resume." */
  fixText: string;
  since: string | null;
  /** Who paused it (null = the app did). */
  byUserId: number | null;
  detail: PauseDetail | null;
  /** Other automatic causes that arrived while already paused (never replaces the first cause). */
  also: Array<{ kind: PauseKind; reason: string; at: string; detail: PauseDetail | null }>;
};

// ── health ──
export type HealthBaseline = {
  /** Only emails sent after this instant count (set when a health pause is resumed). */
  since: string | null;
  resumedById: number | null;
  acknowledged: { kind: "health-bounce" | "health-complaint"; count: number; sample: number } | null;
  /**
   * Half-limit warning sent. Cleared by the health check when the count falls below half the limit again, or when the
   * warning is more than 7 days old, so a new rise warns again.
   */
  warnedBounceAt: string | null;
  warnedComplaintAt: string | null;
};

// ── warm-up ──
export type WarmupDayResult = "up" | "hold-low-use" | "hold-unhealthy" | "hold-not-sending-day" | "hold-at-max";
export type WarmupDay = {
  day: string;
  cap: number;
  used: number;
  result: WarmupDayResult;
  bounces: number;
  bounceSample: number;
  complaints: number;
  complaintSample: number;
  /** 0-based step after this day. */
  stepAfter: number;
};
export type WarmupState = {
  /** The sending domain this ramp belongs to; a different domain restarts the ramp. "" in the practice copy. */
  domain: string | null;
  /** 0-based index into the warm-up table. */
  step: number;
  lastEvaluatedCapDay: string | null;
  startedCapDay: string | null;
  /** Newest last, at most 60. */
  history: WarmupDay[];
};

// ── pacing ──
export type WaitReason =
  | "paused"
  | "restore-check"          // a restore is being checked with Mailgun (§4.3.7)
  | "mailgun-not-connected"
  | "catch-up"               // "Waiting for the check with Mailgun"
  | "rate-limited"           // Mailgun 429
  | "mailgun-unreachable"    // back-off after timeouts/5xx/404 on a send
  | "live-not-ready"         // LIVE rows held: Setup isn't A, or tracking/unsubscribe settings drifted
  | "reply-route"            // LIVE rows held: the sender's reply route isn't working
  | "pending-events"         // every due candidate has an unprocessed event or reply (§4.3.4)
  | "outside-hours"
  | "cap-reached"
  | "sender-cap"
  | "pacing"
  | "nothing-due";
/** One gated send: when it went, and the random factor (0.5–1.5) drawn for the gap after it. */
export type PacedSend = { at: string; jitter: number };
export type PacerState = {
  /** The time planned at the last send (for display only; the gates never hold on it). */
  nextSendAt: string | null;
  /** The last gated send of any class (no two gated sends closer than the smallest gap). */
  lastSentAt: string | null;
  lastGapSeconds: number | null;
  /** The last gated send per class; each tick recomputes the gap after it from the class's CURRENT due rows (§4.3.2). */
  lastByClass: { counted: PacedSend | null; uncounted: PacedSend | null };
  /** No Mailgun send before this (429 reset, or the back-off after uncertain outcomes or a 404). */
  backoffUntil: string | null;
  backoffReason: "rate-limited" | "mailgun-unreachable" | null;
  /** Uncertain outcomes (timeout, network, 5xx, 3xx) in a row; a 200 resets it. Back-off 5, 15, then 60 min. */
  ambiguousStreak: number;
  /** The last refused sends (rejected outcomes), newest last, at most 3: the circuit breaker (§4.3.5). */
  recentRejects: Array<{ at: string; toNorm: string; message: string }>;
  /** Since when LIVE rows wait for a working reply route (Owner notice after 1 hour). */
  routeWaitSince: string | null;
  /** Why gated emails are waiting right now (written only when it changes, or once a minute). */
  waiting: { reason: WaitReason; until: string | null; at: string } | null;
};
export type SendingDayState = { capDay: string | null; capReachedNotifiedAt: string | null };

// ── catch-up ──
export type CatchUpSummary = {
  domains: string[];
  eventsApplied: number;
  suppressionsAdded: number;
  suppressionsPushed: number;
  inboundStored: number;
  /** Message-IDs Mailgun accepted twice (a duplicate that slipped through; §4.4.5). */
  duplicatesFound: number;
};
export type CatchUpState = {
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  /** Every domain's steps completed. The catch-up gate and warm-up evaluation read only this. */
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Network/server failures allow the 15-minute fallback of the catch-up gate; auth never does. */
  lastErrorKind: "auth" | "network" | "server" | "other" | null;
  lastReason: "startup" | "hourly" | "manual" | null;
  lastSummary: CatchUpSummary | null;
};
export type OutageState = {
  detectedAt: string | null;
  /** The part of the time the app couldn't check, oldest first. */
  from: string | null;
  to: string | null;
  beyondLogRetention: boolean;
  beyondMessageRetention: boolean;
  /** Set by M4 once the hold is handled. */
  handledAt: string | null;
};

// ── restore ──
export type RestoreReport = {
  finishedAt: string;
  mailgunChecked: boolean;
  /** 1 after the first walk, 2 after the second (35 min after the restore, when Mailgun's logs have caught up). */
  passes: number;
  windowFrom: string | null;
  windowTo: string | null;
  /** The backup is older than Mailgun's log retention, so some sends can't be checked. */
  olderThanRetention: boolean;
  acceptedEvents: number;
  matchedByMessageId: number;
  matchedBySendId: number;
  matchedByRecipient: number;
  rowsCreated: number;
  externalSends: number;
  madeUnconfirmed: number;
  error: string | null;
};
export type RestoreState = {
  /** pending/scanning (and failed or unchecked until acknowledged) hold every TEST/LIVE send (§4.3.7). */
  status: "none" | "pending" | "scanning" | "done" | "failed";
  restoredFrom: string | null;
  /** min(restoredFrom, newest ActivityLog.at in the restored database) − 1 h. */
  scanFrom: string | null;
  markerAt: string | null;
  file: string | null;
  handledAt: string | null;
  report: RestoreReport | null;
  acknowledgedAt: string | null;
  acknowledgedById: number | null;
};

// ── which database file this is (a copy must not send the same emails again) ──
export type InstanceState = { dbPath: string; id: string; firstSeenAt: string };

// ── remote access (cloudflared) ──
export type TunnelState = {
  checkedAt: string | null;
  state: "connected" | "degraded" | "down" | "not-running" | "unknown";
  readyConnections: number;
  port: number | null;
  connectorId: string | null;
  version: string | null;
  /** Plain sentence when the version is known-bad or over a year old. */
  versionWarning: string | null;
  downSince: string | null;
  notifiedAt: string | null;
  /** GET <APP_PUBLIC_URL>/api/health from this PC, through Cloudflare. */
  publicCheck: { at: string; ok: boolean; status: number | null; error: string | null } | null;
  /** POST <APP_PUBLIC_URL>/api/webhooks/mailgun/events answered by the app itself (not an Access login page). */
  webhookPathCheck: { at: string; ok: boolean; status: number | null; error: string | null } | null;
  /** GET <APP_PUBLIC_URL>/contacts without cookies must redirect to *.cloudflareaccess.com (Access protects the app). */
  appProtectedCheck: { at: string; ok: boolean; status: number | null; location: string | null; error: string | null } | null;
  /** Random value the monitor sends as x-outreach-self-check; the webhook handler leaves such requests out of its stats. */
  selfCheckNonce: string | null;
};

// ── Mailgun setup ("Apply recommended settings") ──
export type SetupStepKey =
  | "public-address"
  | "tracking-open"
  | "tracking-click"
  | "unsubscribe"
  | "spam-filter"
  | "retention"
  | "pii"
  | "certificate"
  | "https"
  | "signing-key"
  | "webhooks"
  | "routes";
export type SetupStep = { key: SetupStepKey; ok: boolean | null; text: string; detail: string | null; at: string };
export type CertificateState = {
  host: string;
  status: "none" | "processing" | "active" | "expired" | "error" | "not-in-plan" | "cname-missing";
  startedAt: string | null;
  lastPolledAt: string | null;
  error: string | null;
};
export type MailgunSetupState = {
  runAt: string | null;
  byUserId: number | null;
  jobId: number | null;
  steps: SetupStep[];
  certificate: CertificateState | null;
};

// ── domain checklist ──
export type CheckStatus = "ok" | "warn" | "bad" | "unknown" | "info" | "off";
export type ChecklistRowKey =
  | "mailgun-domain"
  | "spf"
  | "dkim"
  | "mx"
  | "tracking-cname"
  | "https-links"
  | "dmarc"
  | "tracking-off"
  | "unsubscribe"
  | "spam-filter"
  | "retention"
  | "signing-key"
  | "webhooks"
  | "reply-routes"
  | "sending-allowed"
  | "monthly-limit"
  | "remote-access"
  | "reply-test"
  | "postmaster"
  | "domain-age";
export type ChecklistGroup = "mailgun" | "dns" | "settings" | "connection" | "optional";
export type ChecklistRecord = {
  type: string;
  /** Host name as the owner types it in a DNS panel ("@", "email", "pdk1._domainkey"). */
  name: string;
  /** Full host name, for the tooltip. */
  fqdn: string;
  value: string;
  priority: string | null;
  /** What resolvers see now (joined), for "Details". */
  found: string[];
};
export type ChecklistRow = {
  key: ChecklistRowKey;
  group: ChecklistGroup;
  status: CheckStatus;
  title: string;
  text: string;
  fix: string | null;
  records: ChecklistRecord[];
  detail: string | null;
};
export type DomainCheckState = {
  domain: string | null;
  region: "EU" | "US" | null;
  checkedAt: string | null;
  lastVerifyAt: string | null;
  rows: ChecklistRow[];
  error: string | null;
};

// ── small ones ──
export type LogsFormState = {
  useDuration: boolean;
  learnedAt: string | null;
  /** How `message_id` must be written in a Logs filter, proven on a real accepted send (§4.3.6); null = not yet. */
  messageIdForm: "plain" | "bracketed" | null;
  /** The `user_variables contains <send_id>` filter found a known send. */
  sendIdFilterOk: boolean | null;
  provenAt: string | null;
};
export type WebhookStats = {
  /** Last valid (signed, fresh) event / inbound POST. */
  lastEventAt: string | null;
  lastInboundAt: string | null;
  lastRejectedAt: string | null;
  lastRejectReason: "signature" | "stale" | "unreadable" | "no-key" | "too-large" | null;
  /**
   * Counted rejections only (body parsed, its domain is ours, timestamp fresh, signature wrong), newest last, at most 10.
   * Internet noise and the monitor's self-check never land here.
   */
  rejects: string[];
};
export type NoticesState = Record<string, string>;
```

### 3.4 `src/core/setting-types.ts` (new contract file)

```ts
/** Milestone 3 contract (docs/dev/M3-DESIGN.md §2.1): shapes of the new Owner-edited settings. */

/** Setting "sending.capOverride": the Owner's confirmed limit for ONE cap day. */
export type CapOverride = { capDay: string; cap: number; byUserId: number; at: string };

export type ReplyTestProvider = "gmail" | "microsoft" | "yahoo" | "other";
/**
 * The Owner's answers for one test mailbox. What the app sees itself (which test email, when, delivered, reply stored)
 * is derived from TestSend/MailEvent/InboundMessage rows by loadReplyTest, never stored here, so the worker never
 * writes this Owner-edited setting.
 */
export type ReplyTestMailbox = {
  address: string;
  provider: ReplyTestProvider;
  /** "Did the reply arrive in your reply inbox, not in spam?" */
  inboxOk: boolean | null;
  /** "Does its original say dkim=pass or arc=pass?" */
  authOk: "pass" | "fail" | "unsure" | null;
  /** authOk was read from pasted headers (parseAuthResults), not answered by hand. */
  authFromHeaders: boolean;
};
export type UnsubscribeSetup = "A" | "B" | "C";
/** Setting "mailgun.unsubscribeTest" (PLAN A4.5, B6.8). */
export type UnsubscribeTestSetting = {
  setup: UnsubscribeSetup;
  status: "untested" | "passed" | "failed";
  /** The sending domain the decision belongs to; a pass on another domain doesn't count. */
  domain: string | null;
  mailboxes: ReplyTestMailbox[];
  /** "Do you see List-Unsubscribe: <https://…> and List-Unsubscribe-Post?" */
  headersOk: boolean | null;
  decidedAt: string | null;
  decidedById: number | null;
  note: string | null;
};
export const DEFAULT_UNSUBSCRIBE_TEST: UnsubscribeTestSetting = {
  setup: "A",
  status: "untested",
  domain: null,
  mailboxes: [],
  headersOk: null,
  decidedAt: null,
  decidedById: null,
  note: null,
};
```

### 3.5 `src/server/settings.ts` edit

```diff
+import { DEFAULT_UNSUBSCRIBE_TEST, type CapOverride, type UnsubscribeTestSetting } from "@/core/setting-types";
 import { db, dbWrite } from "./db";
 …
   "sending.minGapSeconds": 20,
+  /** The Owner's confirmed change of TODAY's limit (M3-DESIGN §2.1); ignored on any other cap day. */
+  "sending.capOverride": null as CapOverride | null,
 …
   "mailgun.messageRetentionDays": 1,
+  /** The real-reply test that decides the unsubscribe setup (PLAN A4.5, B6.8). */
+  "mailgun.unsubscribeTest": DEFAULT_UNSUBSCRIBE_TEST as UnsubscribeTestSetting,
+  /** Optional: the day the Owner bought the sending domain ("YYYY-MM-DD"), for the checklist's age row. */
+  "mailgun.domainRegisteredOn": null as string | null,
 …
 export type SettingValue<K extends SettingKey> = K extends "sending.mode"
   ? "DRY_RUN" | "TEST" | "LIVE"
   : K extends "mailgun.region"
     ? "EU" | "US"
-    : K extends "backups.secondFolder" | "mailgun.domain"
+    : K extends "backups.secondFolder" | "mailgun.domain" | "mailgun.domainRegisteredOn"
       ? string | null
-      : Widen<(typeof SETTING_DEFAULTS)[K]>;
+      : K extends "sending.capOverride"
+        ? CapOverride | null
+        : K extends "mailgun.unsubscribeTest"
+          ? UnsubscribeTestSetting
+          : Widen<(typeof SETTING_DEFAULTS)[K]>;
```

### 3.6 `src/server/jobs.ts` edit

```diff
   | "send.testEmail"
-  | "campaign.finishCheck";
+  | "campaign.finishCheck"
+  | "mailgun.checkDomain"
+  | "mailgun.restoreScan"
+  | "warmup.evaluate";
 …
 export function redactText(text: string, secrets: string[] = []): string {
   let msg = text;
   for (const s of secrets) if (s && s.length >= 6) msg = msg.split(s).join("[hidden]");
-  msg = msg.replace(/(authorization|api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "$1: [hidden]");
+  // "Authorization: Basic <base64>" must lose the credential, not just the word "Basic".
+  msg = msg.replace(/(authorization)\s*[:=]\s*(?:basic|bearer)?\s*\S+/gi, "$1: [hidden]");
+  msg = msg.replace(/(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "$1: [hidden]");
   return msg.slice(0, 1000);
 }
```

Plus one case in `tests/unit/worker/job-errors.test.ts`: `"authorization: Basic YXBpOmtleS0x"` → no `YXBp` left.

### 3.7 `src/core/sending/capday.ts` and `src/core/sending/caps.ts` (new contract files with code)

They are contracts because P2 (wave 1) needs them for `getTodayCap` while P1 writes the rest of `src/core/sending`.
P1 owns their tests and may fix bugs without changing signatures.

```ts
// src/core/sending/capday.ts
import { Temporal } from "temporal-polyfill";

/**
 * The cap day (PLAN A5.12, B6.6): midnight to midnight in Setting "sending.capDayTimeZone". A cap day is written
 * "YYYY-MM-DD". Pure; DST-safe (start of day via Temporal, "compatible" disambiguation).
 */
export type CapDay = string;
export const FALLBACK_CAP_ZONE = "Asia/Karachi";

/** The zone if it is a valid IANA zone, otherwise `fallback`. */
export function safeZone(zone: string | null | undefined, fallback: string = FALLBACK_CAP_ZONE): string {
  if (!zone) return fallback;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

export function isCapDay(v: unknown): v is CapDay {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function capDayOf(at: Date, capZone: string): CapDay {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(safeZone(capZone)).toPlainDate().toString();
}

/** [start, end) of a cap day as instants. */
export function capDayBounds(day: CapDay, capZone: string): { start: Date; end: Date } {
  const zone = safeZone(capZone);
  const date = Temporal.PlainDate.from(day);
  return {
    start: new Date(date.toZonedDateTime(zone).epochMilliseconds),
    end: new Date(date.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds),
  };
}

export function addCapDays(day: CapDay, days: number): CapDay {
  return Temporal.PlainDate.from(day).add({ days }).toString();
}

export function compareCapDays(a: CapDay, b: CapDay): number {
  return Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b));
}

/** ISO day of the week: 1 = Monday … 7 = Sunday. */
export function capDayOfWeek(day: CapDay): number {
  return Temporal.PlainDate.from(day).dayOfWeek;
}

/** Cap days after `lastEvaluated` (exclusive) that ended before `now`'s cap day, oldest first, at most `max`. */
export function closedCapDaysAfter(lastEvaluated: CapDay, now: Date, capZone: string, max = 60): CapDay[] {
  const today = capDayOf(now, capZone);
  const out: CapDay[] = [];
  for (let d = addCapDays(lastEvaluated, 1); compareCapDays(d, today) < 0 && out.length < max; d = addCapDays(d, 1)) {
    out.push(d);
  }
  return out;
}
```

```ts
// src/core/sending/caps.ts
import type { CapOverride } from "@/core/setting-types";
import type { CapDay } from "./capday";

/**
 * Daily limits (PLAN B6.6). The warm-up table for the default settings is PLAN's own list; other settings use the
 * same geometric curve, rounded, never decreasing, ending exactly at the maximum.
 */
export const DEFAULT_WARMUP_TABLE: readonly number[] = [
  50, 59, 69, 80, 94, 110, 129, 151, 177, 207, 242, 283, 332, 389, 455, 533, 624, 730, 855, 1000,
];

function clampInt(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export function warmupTable(startCap: number, maxCap: number, steps: number): number[] {
  const start = clampInt(startCap, 1, 100_000);
  const max = Math.max(start, clampInt(maxCap, 1, 100_000));
  const n = clampInt(steps, 2, 200);
  if (start === 50 && max === 1000 && n === 20) return [...DEFAULT_WARMUP_TABLE];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? max : Math.round(start * Math.pow(max / start, i / (n - 1)));
    out.push(Math.max(v, out[i - 1] ?? v));
  }
  return out;
}

export function warmupCapFor(step: number, table: readonly number[]): number {
  const i = Math.min(Math.max(0, Math.floor(step)), table.length - 1);
  return table[i]!;
}

export type DomainCap = {
  cap: number;
  source: "warmup" | "override";
  warmupCap: number;
  maxCap: number;
  /** An override above the warm-up schedule ("Above the warm-up schedule"). */
  aboveSchedule: boolean;
};

/** min(override, max) when the Owner confirmed an override for this cap day, else min(warm-up cap, max). */
export function domainCapFor(input: { capDay: CapDay; warmupCap: number; maxCap: number; override: CapOverride | null }): DomainCap {
  const maxCap = Math.max(0, Math.floor(input.maxCap));
  const warmupCap = Math.min(Math.max(0, Math.floor(input.warmupCap)), maxCap);
  const o = input.override;
  if (o && o.capDay === input.capDay && Number.isFinite(o.cap) && o.cap >= 0) {
    const cap = Math.min(Math.floor(o.cap), maxCap);
    return { cap, source: "override", warmupCap, maxCap, aboveSchedule: cap > warmupCap };
  }
  return { cap: warmupCap, source: "warmup", warmupCap, maxCap, aboveSchedule: false };
}

export function capacityLeft(cap: number, used: number): number {
  return Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(used)));
}

/** Infinity when the sender has no limit of their own (User.dailyCap null). */
export function senderCapacityLeft(senderCap: number | null | undefined, used: number): number {
  if (senderCap === null || senderCap === undefined || !Number.isFinite(senderCap)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(senderCap) - Math.max(0, Math.floor(used)));
}
```

---

## 4. Modules

Signatures are TypeScript. "→" names the return type. Every async server function that writes goes through
`dbWrite`/`dbTx`, never does network I/O inside a transaction, and keeps transactions ≲ 50 ms / ≤ 500 rows.

### 4.1 Pure core (P1)

#### 4.1.1 `src/core/sending/window.ts`

```ts
export type SendingWindow = { days: number[]; start: string; end: string }; // ISO days (1 = Mon), "HH:MM"
export const DEFAULT_WINDOW: SendingWindow; // Mon–Fri 09:00–17:00
export function parseWindow(v: unknown): SendingWindow;                 // anything invalid → DEFAULT_WINDOW
export function validateWindow(v: unknown): { ok: true; value: SendingWindow } | { ok: false; error: string };
export function resolveZone(companyZone: string | null | undefined, defaultZone: string): string; // invalid → default → "Europe/Berlin"
export function isWindowOpen(at: Date, zone: string, w: SendingWindow): boolean;
export function nextWindowOpen(at: Date, zone: string, w: SendingWindow): Date;       // `at` itself when open; searches ≤ 8 days
export function windowCloseAfter(at: Date, zone: string, w: SendingWindow): Date | null; // end of the window containing `at`
export function openIntervals(from: Date, to: Date, zone: string, w: SendingWindow): Array<{ start: Date; end: Date }>;
export function openSecondsBetween(from: Date, to: Date, zones: readonly string[], w: SendingWindow): number; // union over zones
export function windowSentence(w: SendingWindow): string; // "Monday to Friday, 9:00–17:00" / "Mon, Wed and Fri, 9:30–16:00"
```
Rules: local wall time via Temporal `ZonedDateTime`; `start`/`end` turned into instants with `PlainDate.toZonedDateTime({timeZone, plainTime})`
("compatible" disambiguation, so a DST gap moves the edge forward, an overlap takes the earlier instant); a window is
`[start, end)`; open iff the local day of week is in `days` and local time is in `[start, end)`.

#### 4.1.2 `src/core/sending/pacing.ts`

```ts
export const PACING_JITTER = 0.5;
/** B6.6: gap = openSecondsLeft / min(capacityLeft, dueCount), ±50 % random, at least minGapSeconds. null = nothing to pace. */
export function targetGapMs(input: {
  openSecondsLeft: number; capacityLeft: number; dueCount: number; minGapSeconds: number; random: () => number;
}): number | null;
```
`capacityLeft` may be `Infinity` (TEST rows, no counted cap): then divide by `dueCount`. Result = `max(minGap, base × (0.5 + random()))`,
in ms. Returns null when `dueCount ≤ 0`, `capacityLeft ≤ 0` or `openSecondsLeft ≤ 0`.

#### 4.1.3 `src/core/sending/warmup.ts`

```ts
export type WarmupDayInput = {
  day: CapDay; isSendingDay: boolean; step: number; table: readonly number[]; used: number; minUsePercent: number;
  bounces: number; bounceSample: number; bounceWindow: number; healthyBouncePercent: number;
  complaints: number; complaintSample: number; complaintWindow: number; healthyComplaintPercent: number;
};
export function evaluateWarmupDay(input: WarmupDayInput): WarmupDay;  // WarmupDay from the contract
export function isHealthyForWarmup(input: { bounces; bounceWindow; healthyBouncePercent; complaints; complaintWindow; healthyComplaintPercent }): boolean;
export function warmupProgressText(step: number, table: readonly number[]): string; // "Day 9 of 20 · tomorrow's limit 207" / "Warm-up finished: 1,000 a day"
```
Rules (B6.6, A5.13): not a sending day (`window.days`) → `hold-not-sending-day`; already at the last step → `hold-at-max`;
`used × 100 < cap × minUsePercent` → `hold-low-use`; not healthy → `hold-unhealthy`; else `up` (step + 1). Healthy means
fixed denominators: `bounces × 100 < bounceWindow × healthyBouncePercent` (200 × 2 % → at most 3) and
`complaints × 100 < complaintWindow × healthyComplaintPercent` (1,000 × 0.05 % → none). `cap` = `warmupCapFor(step, table)`
(the scheduled cap, never the override). Use integer-safe arithmetic (`Math.round(x * 1000)`) for percentages.

#### 4.1.4 `src/core/sending/health.ts`

```ts
export const MAILGUN_LIMITS = { bouncePercent: 5, complaintPercent: 0.08 } as const;
export type HealthCounts = { bounces: number; bounceSample: number; complaints: number; complaintSample: number };
export type HealthSettings = { bounceWindow: number; bouncePercent: number; complaintWindow: number; complaintPercent: number };
export type HealthVerdict = {
  bounceLimit: number;            // floor(window × % / 100), e.g. 6
  complaintLimit: number;         // e.g. 1
  pause: null | { kind: "health-bounce" | "health-complaint"; reason: string; fixText: string; detail: PauseDetail };
  warn: Array<{ rule: "bounce" | "complaint"; title: string; body: string }>;
};
export function evaluateHealth(counts: HealthCounts, s: HealthSettings, alreadyWarned: { bounce: boolean; complaint: boolean }): HealthVerdict;
export function healthLine(rule: "bounce" | "complaint", counts: HealthCounts, s: HealthSettings): string; // for pages
```
Rules: pause when `count × 100 > window × percent` (fixed denominator, so 7 of the first 50 sends pauses, 6 doesn't).
Bounce is checked first; if both trip, the bounce pause is returned. Warn when `count ≥ max(1, ceil(limit / 2))`, not
pausing and not `alreadyWarned` (the caller passes `alreadyWarned` = a warning was sent, the count never dropped below
the warning level since, and that warning is less than 7 days old; §4.3.8). Copy:

| | reason (pill) | fixText / body |
|---|---|---|
| bounce pause | `7 of the last 200 emails bounced` (sample = actual number of emails in the window, ≤ window) | `Your limit is 6. Open the bounced list in Settings › Deliverability (it shows each bounce's campaign and lists), remove or re-check the list they came from, then click Resume.` |
| complaint pause | `2 of the last 1,000 emails were marked as spam` | `Your limit is 1. Settings › Deliverability shows which campaign they came from; check it before you resume. Mailgun's own limit is 0.08%.` |
| bounce warning | title `Bounces are rising: 3 of the last 200 emails bounced` | `Sending pauses automatically at 7. Check the bounced addresses in Settings › Deliverability.` |
| complaint warning | title `An email was marked as spam` | `1 of the last 1,000 emails drew a complaint. Sending pauses automatically at 2.` |

#### 4.1.5 `src/core/sending/label.ts` (top-bar label)

```ts
export type SendingLabel = { kind: "dry-run" | "test-list" | "live" | "paused"; text: string; title: string; tone: "neutral" | "success" | "danger" };
export function sendingLabel(input: {
  pause: PauseState; mode: "DRY_RUN" | "TEST" | "LIVE"; goLive: boolean;
  /** Campaigns still able to send through Mailgun (status RUNNING or SCHEDULED), by launch mode. */
  activeRealCampaigns: { live: number; test: number };
}): SendingLabel;
```

The label never says less than what is really going out: each campaign keeps its launch mode (B6.5), so the label
takes the "strongest" of the setting and the active campaigns. Only A6's four labels are used (`Dry run`,
`Test list only`, `Sending live`, `Paused: …`); Mailgun's test mode shows as "Test list only", as B6.5 says.

| Condition (first match) | text | tone | title (tooltip) |
|---|---|---|---|
| `pause.paused` | `Paused: <reason>` | danger | `Sending is paused. <fixText>` |
| goLive and (mode LIVE or `live > 0`) | `Sending live` | success | mode LIVE: `Campaigns send real email.` · otherwise: `New campaigns use <dry run/test mode>; <n> live campaign(s) still send real email. Pause them, or use Pause all sending.` |
| mode LIVE (before go-live) | `Test list only` | neutral | `Real emails go only to the addresses on your test list, and to your own reply inbox when you click Send me a test.` |
| mode TEST | `Test list only` | neutral | `New campaigns use Mailgun's test mode: emails to your test list are accepted but never delivered.` |
| mode DRY_RUN and `live + test > 0` | `Test list only` (before go-live) | neutral | `New campaigns use dry run; <n> campaign(s) still send through Mailgun. Pause them, or use Pause all sending.` |
| mode DRY_RUN | `Dry run` | neutral | `Nothing is sent: campaigns only fill the dry-run outbox.` |

`getSendingState()` (`src/server/sending-state.ts`, P3) counts `activeRealCampaigns` with one `groupBy` on
`Campaign {status in [RUNNING, SCHEDULED], mode in [TEST, LIVE]}`.

#### 4.1.6 `src/core/mailgun/signature.ts` (server only: uses `node:crypto`)

```ts
export const EVENT_MAX_AGE_MS = 12 * 3_600_000;
export const INBOUND_MAX_AGE_MS = 24 * 3_600_000;
export const MAX_FUTURE_MS = 3_600_000;   // allows a PC clock up to 1 h slow (see §9.2)
export function verifyMailgunSignature(signingKey: string, timestamp: string, token: string, signature: string): boolean; // research §13.3, timingSafeEqual
export function signMailgun(signingKey: string, timestamp: string, token: string): string;  // for tests and the fake
export function checkTimestamp(timestamp: string, now: Date, maxAgeMs: number, maxFutureMs?: number): "fresh" | "stale" | "future" | "invalid";
```
Must pass the research test vector (key `key-0123456789abcdef0123456789abcdef`, timestamp `1770920772`, the 50-char token →
`6ae8ba140d2536fd21c45a0db161e962a424ed6ca953c96a63182621e118ee13`). A numeric timestamp is normalised with `String()` by the caller.

#### 4.1.7 `src/core/mailgun/events.ts`

```ts
export type MailEventType = "accepted" | "delivered" | "failed" | "complained" | "unsubscribed" | "other";
export type NormalizedEvent = {
  dedupeKey: string;                  // `${providerEventId}:${YYYY-MM-DD UTC of occurredAt}`; simulated: `sim:${emailId}:${type}`
  providerEventId: string;
  type: MailEventType;
  severity: "permanent" | "temporary" | null;
  reason: string | null;              // "bounce", "suppress-bounce", "old", …
  occurredAt: Date;
  messageId: string | null;           // lowercase, no <>
  recipient: string | null;           // lowercase
  userVariables: Record<string, string>;
  tags: string[];
  isTestMode: boolean;
  domain: string | null;
  deliveryStatus: { code: number | null; message: string | null; description: string | null; bounceType: string | null } | null;
  raw: unknown;
};
export function normalizeMessageId(v: string | null | undefined): string | null;
export function parseUserVariables(v: unknown): Record<string, string>;       // object | [] | JSON string
export function normalizeWebhookEventData(eventData: unknown): NormalizedEvent | null; // null = unreadable (missing id/event/timestamp)
export function normalizeLogItem(item: unknown): NormalizedEvent | null;       // Logs item shape (@timestamp, user-variables string, storage.url array)
export function makeSimulatedEvent(input: { kind: "delivered" | "bounce" | "complaint" | "unsubscribe"; emailId: number; messageId: string; recipient: string; now: Date }): NormalizedEvent;
export type EventEffect = {
  dateField: "deliveredAt" | "tempFailedAt" | "bouncedAt" | "complainedAt" | "unsubscribedAt" | null;
  stop: "bounced" | "complained" | "unsubscribed" | null;
  /** true: every open recipient with that address, in every campaign (real scope only); false: only the matched row's recipient. */
  stopEveryCampaign: boolean;
  suppression: "BOUNCED" | "COMPLAINED" | "UNSUBSCRIBED" | null;
  personField: "bouncedAt" | "complainedAt" | "unsubscribedAt" | null;
  /** Mailgun already lists the address (hard bounce, complaint, unsubscribe, suppress-*), so nothing needs pushing. */
  inMailgunList: boolean;
  health: "bounce" | null;                     // permanent non-suppress-* failures; never test mode (complaints: §4.2.5)
  /** Mailgun accepted our email (every type except "other"): see "proof of sending", §4.4.2. */
  provesAccepted: boolean;
};
export function eventEffect(ev: NormalizedEvent): EventEffect;
export function isHardBounce(ev: NormalizedEvent): boolean; // reason bounce | hardfail | suppress-bounce, or delivery-status bounce-type "hard"
export const STOP_PRECEDENCE: readonly string[]; // ["bounced", "unsubscribed", "complained"] (later wins)
export const SUPPRESSION_PRECEDENCE: readonly string[]; // ["MANUAL", "INVALID", "BOUNCED", "UNSUBSCRIBED", "COMPLAINED"]
export function displayResult(d: { sentAt?: Date | null; deliveredAt?: Date | null; bouncedAt?: Date | null; unsubscribedAt?: Date | null; complainedAt?: Date | null }): "complained" | "unsubscribed" | "bounced" | "delivered" | "sent" | null;
```
`eventEffect` table:

| Event | dateField | stop (every campaign?) | suppression / personField | inMailgunList | health |
|---|---|---|---|---|---|
| `delivered` | deliveredAt | — | — | — | — |
| `failed` temporary | tempFailedAt | — | — | — | — |
| `failed` permanent, hard (`isHardBounce`, not `suppress-*`) | bouncedAt | bounced (yes) | BOUNCED / bouncedAt | yes | bounce |
| `failed` permanent, other reasons (`espblock`, `generic`, `old`, `blacklisted`, `unknown`, …) | bouncedAt | bounced (no: only this row's recipient) | — | — | bounce |
| `failed` `suppress-bounce` | bouncedAt | bounced (yes) | BOUNCED / bouncedAt | yes | — |
| `failed` `suppress-unsubscribe` | bouncedAt | unsubscribed (yes) | UNSUBSCRIBED / unsubscribedAt | yes | — |
| `failed` `suppress-complaint` | bouncedAt | complained (yes) | COMPLAINED / complainedAt | yes | — |
| `complained` | complainedAt | complained (yes) | COMPLAINED / complainedAt | yes | (counted from events, §4.2.5) |
| `unsubscribed` | unsubscribedAt | unsubscribed (yes) | UNSUBSCRIBED / unsubscribedAt | yes | — |
| `accepted` | — | — | — | — | — |
| `other` | — | — | — | — | — (`provesAccepted` false) |

`isTestMode` → health null. A `suppress-*` drop shows on the campaign as "Bounced" (Mailgun refused to deliver it)
and never as "Complained". Webhook quirks to handle: `storage: []`, `user-variables: []`,
`delivery-status.description null`, `tags: ["*"]`, `timestamp` float seconds.

#### 4.1.8 `src/core/mailgun/inbound.ts`

```ts
export type HeaderPair = [name: string, value: string];
export type ParsedInbound = {
  recipient: string;                 // lowercase
  fromEmail: string; fromName: string | null;
  subject: string;
  snippet: string;                   // stripped-text → body-plain, whitespace collapsed, ≤ 300 chars
  messageIdHeader: string | null;    // no <>, lowercase
  inReplyTo: string | null;          // first id, no <>
  references: string[];              // ids, no <>
  headers: HeaderPair[];             // capped at 200 pairs / 32 KB
  storageKey: string | null;         // last path segment of message-url / storage.url
  messageUrl: string | null;
  receivedAt: Date;
};
export function lowerKeys(fields: Record<string, string>): Record<string, string>;
export function parseMessageHeaders(v: string | unknown[] | null | undefined): HeaderPair[]; // JSON string (notify) or array (stored)
export function headerValues(headers: HeaderPair[], name: string): string[];                 // case-insensitive
export function extractMessageIds(value: string | null | undefined): string[];
export function parseAddressHeader(v: string): { email: string; name: string | null } | null;
export function parseInboundForm(fields: Record<string, string>, now: Date): ParsedInbound | null;   // null = unreadable
export function parseStoredMessage(json: unknown, fallback: { recipient?: string | null; storageKey?: string | null; at: Date }): ParsedInbound | null;
export function parseStoredLogOnly(item: NormalizedEvent | unknown): ParsedInbound | null;          // body expired: headers from the log item, snippet ""
```

#### 4.1.9 `src/core/dns/{types,spf,dmarc,dkim}.ts`

```ts
// types.ts
export type DnsAnswer<T> = { ok: true; value: T } | { ok: false; code: "missing" | "timeout" | "error"; detail: string };
export interface DnsLookup {
  txt(name: string): Promise<DnsAnswer<string[]>>;          // one string per record, chunks joined with ""
  mx(name: string): Promise<DnsAnswer<Array<{ priority: number; exchange: string }>>>;
  cname(name: string): Promise<DnsAnswer<string[]>>;
  a(name: string): Promise<DnsAnswer<string[]>>;
}
export type Agreement = "both" | "one" | "none" | "unknown";
export function agree<T>(a: DnsAnswer<T>, b: DnsAnswer<T>, isGood: (v: T) => boolean): Agreement;
// spf.ts
export function spfRecords(txt: string[]): string[];                         // /^v=spf1(\s|$)/i
export function spfIncludes(record: string): string[];
export function spfLookupTerms(record: string): number;                      // include/a/mx/ptr/exists/redirect in THIS record
export function spfHasAll(record: string, qualifier: "+" | "~" | "-" | "?"): boolean;
// dmarc.ts
export type DmarcPolicy = { p: string | null; sp: string | null; rua: string[]; adkim: string | null; aspf: string | null; raw: string };
export function dmarcRecords(txt: string[]): string[];                       // starts with v=DMARC1
export function parseDmarc(record: string): DmarcPolicy;
export function dmarcParents(domain: string): string[];                      // tree walk candidates, ≤ 8, stops before the public suffix (tldts)
export function ruaAuthorizationName(policyDomain: string, ruaDomain: string): string; // `${policyDomain}._report._dmarc.${ruaDomain}`
// dkim.ts (server only: node:crypto)
export function dkimPublicKey(record: string): string | null;                // p= value, whitespace removed
export function dkimKeyBits(p: string): number | null;                       // 1024 | 2048 | …
export function sameCnameTarget(found: string, expected: string): boolean;   // lowercase, no trailing dot
```

### 4.2 Mailgun client, fake-mode guard and shared foundations (P2)

#### 4.2.1 `src/server/mailgun/base-url.ts`

```ts
export const MAILGUN_HOSTS = { EU: "https://api.eu.mailgun.net", US: "https://api.mailgun.net" } as const; // the ONLY place these appear
export const FAKE_KEY_PREFIX = "key-fake-";
export function isTestRun(): boolean;                                    // OUTREACH_TEST_RUN === "1" || VITEST || NODE_ENV === "test"
export function mailgunBaseOverride(): string | null;                    // ^http://127\.0\.0\.1:\d{2,5}$ and the database isn't app.db, else null (+ one warning log)
export function isFakeMode(): boolean;                                   // mailgunBaseOverride() !== null
export function mailgunApiBase(region: "EU" | "US"): string;             // override, else host; test run without override → throw
export function assertAllowedBaseUrl(url: string): void;                 // real hosts (https) or http://127.0.0.1:<port>; test run: loopback only
export function assertKeyMatchesTarget(apiKey: string): void;            // fake mode: must start key-fake-; real: must not (plain MailgunError "auth")
export function isAllowedStorageUrl(url: string, baseUrl: string): boolean; // https *.mailgun.net, or same origin as a loopback base
export function describeMailgunTarget(region: "EU" | "US"): string;      // "Mailgun EU (https://api.eu.mailgun.net)" / "Test server http://127.0.0.1:4010: nothing reaches the real Mailgun"
```

#### 4.2.2 `src/server/mailgun/types.ts` and `errors.ts`

```ts
export type MailgunRegion = "EU" | "US";
export type SendPurpose = "campaign" | "self-test" | "reply-test";
/** The test-list guard, re-checked inside sendMessage before any request (§4.2.3, B6.5). */
export type SendGuard = {
  goLive: boolean;
  /** Normalised test-list addresses (Setting "sending.testList"). */
  testList: ReadonlySet<string>;
  /** "self-test" only: the acting user's own reply inbox, normalised. */
  ownInbox?: string | null;
};
export type SendMessageInput = {
  from: string;
  /** Exactly one bare address, already normalised; never a list (no , ; < > " or spaces). */
  to: string;
  subject: string; text: string; html: string;
  messageId: string;                 // stored form; the client sends `<id>`
  inReplyTo?: string | null; references?: string | null; // stored forms (space-separated ids)
  replyTo?: string | null;           // Setup C only
  tags: string[];                    // ≤ 3
  variables: Record<string, string>; // opaque ids only
  testMode?: boolean;
  purpose: SendPurpose;
  guard: SendGuard;
};
export type SendMessageResult = { id: string; message: string };        // id lowercase, no <>
export type LogsFilter = { attribute: string; comparator: "=" | "!=" | "contains" | "not contains"; value: string };
export type LogsQuery = { start: Date; end: Date; events: string[]; filters: LogsFilter[]; sort?: "asc" | "desc"; limit?: number };
export type LogsWalk = { complete: boolean; pages: number; items: number; stoppedBecause: "empty" | "no-next" | "same-token" | "page-guard" | "aborted" };
export type SuppressionList = "bounces" | "complaints" | "unsubscribes";
export type SuppressionItem = { address: string; createdAt: Date | null; code: string | null; error: string | null; tags: string[] };
export type DnsRecordInfo = { recordType: string; name: string | null; value: string; priority: string | null; valid: "valid" | "invalid" | "unknown"; isActive: boolean; cached: string[] };
export type DomainInfo = {
  name: string; state: string | null; isDisabled: boolean;
  disabled: { code: string | null; note: string | null; permanently: boolean; reason: string | null; until: string | null } | null;
  spamAction: string | null; webPrefix: string; webScheme: "http" | "https" | null; messageTtl: number | null;
  webhooksRedactPii: boolean | null; useAutomaticSenderSecurity: boolean | null;
  sending: DnsRecordInfo[]; receiving: DnsRecordInfo[];
};
export type TrackingSettings = { openActive: boolean; clickActive: boolean; unsubscribeActive: boolean; htmlFooter: string; textFooter: string; webScheme: "http" | "https" | null };
export type SendingQueues = { regularDisabled: boolean; reason: string | null; until: Date | null; scheduledDisabled: boolean };
export type CertificateStatus = { status: "none" | "processing" | "active" | "expired" | "error"; error: string | null };
export type WebhookType = "delivered" | "permanent_fail" | "temporary_fail" | "complained" | "unsubscribed" | "accepted" | "opened" | "clicked";
export type WebhookMap = Partial<Record<WebhookType, string[]>>;         // v3 `urls` and legacy `url` merged
export type MailgunRoute = { id: string; priority: number; description: string; expression: string; actions: string[]; createdAt: string | null };
export type RouteInput = { priority: number; description: string; expression: string; actions: string[] };

export type MailgunErrorKind =
  | "rejected" | "auth" | "payment" | "not-found" | "conflict" | "rate-limited" | "server"
  | "timeout" | "network" | "business-verification" | "not-allowed" | "unexpected"
  | "guard";          // refused by the client's own test-list guard: no request was made
export class MailgunError extends Error {
  readonly kind: MailgunErrorKind; readonly status: number | null; readonly mailgunMessage: string;
  readonly retryAfterMs: number | null; readonly bodySnippet: string; /* ≤ 2 KB, redacted */ readonly endpoint: string;
  /** false when the error was raised before fetch() was called (guard, bad input): nothing left this PC. */
  readonly requestStarted: boolean;
  /**
   * A send may have been accepted: timeout, network error, abort, 5xx, a 3xx (redirects are errors), or a 2xx without a
   * readable id. Never true for a 4xx response (Mailgun answered "no") or when requestStarted is false.
   */
  get ambiguous(): boolean;
}
// MailgunError never stores request headers or the request body; its message and bodySnippet pass through redactText
// with mailgunSecrets(). A unit test serialises an error (JSON and stack) and finds neither the key nor base64("api:"+key).
export function errorText(body: string): string;       // research §0.4: message ?? Reason ?? Description ?? Field ?? text
/**
 * 429 → rate-limited (checked first: its text also says "is not allowed to send"). Then, on ANY other status, 400
 * included: /business verification/i → business-verification; /is not allowed to send|disabled|suspended/i →
 * not-allowed. Then 401/403 auth; 402 payment; 404 not-found; 409 conflict; other 4xx rejected; 5xx server.
 */
export function classifyStatus(status: number, text: string): MailgunErrorKind;
export function retryAfterMs(headers: Headers, message: string, now: Date): number; // research §0.6, clamped 1 s–15 min
export function plainMailgunError(err: MailgunError, ctx: { domain?: string; region?: MailgunRegion }): string; // owner wording (§5.9)
```

#### 4.2.3 `src/server/mailgun/client.ts`

```ts
export type MailgunClientOptions = {
  apiKey: string; region: MailgunRegion;
  baseUrl?: string;                         // default mailgunApiBase(region); always passed through assertAllowedBaseUrl
  timeoutMs?: number;                       // default 30_000
  retryDelayMs?: (attempt: number) => number; // tests: () => 0
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logsForm?: { get(): Promise<boolean>; set(useDuration: boolean): Promise<void> }; // default: SystemState "mailgun.logsForm"
};
export class MailgunClient {
  constructor(opts: MailgunClientOptions);
  readonly baseUrl: string; readonly region: MailgunRegion;
  // sending — never retried by the client, never aborted from outside (only its own 30 s timeout)
  sendMessage(domain: string, msg: SendMessageInput, opts?: { apiKey?: string }): Promise<SendMessageResult>;
  // logs
  queryLogs(q: LogsQuery, token?: string | null): Promise<{ items: unknown[]; next: string | null }>;
  walkLogs(q: LogsQuery, onPage: (items: unknown[]) => Promise<void>, opts?: { maxPages?: number; signal?: AbortSignal }): Promise<LogsWalk>;
  // suppressions
  walkSuppressions(domain: string, list: SuppressionList, onPage: (items: SuppressionItem[]) => Promise<void>, opts?: { signal?: AbortSignal }): Promise<{ complete: boolean; pages: number; items: number }>;
  addUnsubscribes(domain: string, entries: Array<{ address: string; createdAt?: Date }>): Promise<{ added: number }>; // batches of ≤ 999
  getSuppression(domain: string, list: SuppressionList, address: string): Promise<SuppressionItem | null>; // GET /v3/{d}/{list}/{address}; 404 → null
  deleteSuppression(domain: string, list: SuppressionList, address: string): Promise<"deleted" | "not-found">;
  // domain, tracking, queues, certificate
  getDomain(domain: string): Promise<DomainInfo>;
  verifyDomain(domain: string): Promise<DomainInfo>;
  updateDomain(domain: string, field: { web_scheme?: "http" | "https"; spam_action?: "disabled" | "tag" | "block"; message_ttl?: number; webhooks_redact_pii?: boolean }): Promise<DomainInfo>; // one field per call
  getTracking(domain: string): Promise<TrackingSettings>;
  setOpenTracking(domain: string, active: boolean): Promise<void>;
  setClickTracking(domain: string, active: boolean): Promise<void>;
  setUnsubscribeTracking(domain: string, active: boolean, footers: { html: string; text: string }): Promise<void>;
  getSendingQueues(domain: string): Promise<SendingQueues>;
  startCertificate(host: string): Promise<"started" | "already">;   // 202 / 409
  getCertificateStatus(host: string): Promise<CertificateStatus>;    // 404 → status "none"
  regenerateCertificate(host: string): Promise<"started" | "in-progress" | "still-valid">; // 202 / 429 / 409
  // webhooks (v3 GET, v4 POST/PUT/DELETE)
  getWebhooks(domain: string): Promise<WebhookMap>;
  createWebhook(domain: string, url: string, types: WebhookType[]): Promise<WebhookMap>;
  updateWebhook(domain: string, url: string, types: WebhookType[]): Promise<WebhookMap>;
  deleteWebhook(domain: string, url: string): Promise<WebhookMap>;
  // account
  getSigningKey(): Promise<string>;                                   // never POST (regenerates!)
  getMonthlyLimit(): Promise<{ limit: number; current: number; period: string } | null>; // 404 → null
  // routes (account-wide)
  listRoutes(): Promise<MailgunRoute[]>;                              // pages skip/limit=100 until empty or total
  createRoute(r: RouteInput): Promise<MailgunRoute>;
  updateRoute(id: string, r: RouteInput): Promise<MailgunRoute>;    // body.route ?? body
  deleteRoute(id: string): Promise<"deleted" | "not-found">;
  matchRoute(address: string): Promise<MailgunRoute | null>;         // 404 → null
  // stored messages
  getStoredMessage(url: string): Promise<unknown>;                   // refuses URLs failing isAllowedStorageUrl
}
```
Behaviour: Basic auth `api:<key>` (`assertKeyMatchesTarget` first); request bodies per research §0.3; RFC 2822 dates as
`d.toUTCString().slice(0, 25) + " -0000"`; **every request uses `redirect: "error"`** (a redirect could carry the key to
another host); non-send calls use `AbortSignal.any([AbortSignal.timeout(timeoutMs), external])`, retry 429/5xx/timeout
up to 3 times (respecting `retryAfterMs`, ≤ 60 s each) and retry one 404 on domain endpoints after 5 s; Logs walking
and suppression paging exactly per research §2.3/§3.1 (origin guard on `paging.next`, 1,000-page guard, stop on empty
page); the `duration` fallback per research §2.4 (learned once, stored via `logsForm`). Errors are always
`MailgunError`. Response bodies are parsed leniently (everything optional).

`sendMessage` specifically:
1. **Guard, before anything else** (`checkSendGuard(msg)` in `src/server/mailgun/send-guard.ts`, pure and unit-tested):
   `to` must be one bare address equal to `normalizeEmail(to)` with none of `, ; < > "` or whitespace; then, while
   `guard.goLive` is false, a `campaign` or `reply-test` send must go to an address in `guard.testList`, and a
   `self-test` send must go to `guard.ownInbox`. A failure throws `MailgunError {kind: "guard", requestStarted: false}`
   ("Stopped by the test-list guard: <address> isn't on your test list.") and makes no request.
2. Signal: only `AbortSignal.timeout(timeoutMs)` (30 s). The worker's session signal is never passed: aborting a POST
   that Mailgun may already have accepted would turn a sent email into an unknown one.
3. Outcome: 200 with a readable `id` → result. 3xx (redirect error), a 2xx without a readable `id`, a timeout, a network
   error or a 5xx → `ambiguous`. A 4xx → classified by `classifyStatus` (never ambiguous).

#### 4.2.4 `src/server/mailgun/context.ts`

```ts
export type MailgunContext = {
  connected: true; domain: string; region: MailgunRegion; domainId: number;
  client: MailgunClient;        // Developer key
  sendClient: MailgunClient;    // domain sending key when saved, else `client`
  fakeMode: boolean;
};
export type MailgunContextResult =
  | MailgunContext
  | { connected: false; reason: "practice-copy" | "no-domain" | "no-key"; text: string };
export async function getMailgunContext(opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<MailgunContextResult>;
export async function domainsToSync(now: Date): Promise<Array<{ id: number; name: string; region: MailgunRegion }>>; // active + inactive with lastLiveSendAt ≥ now − 60 days
export function clientFor(ctx: MailgunContext, region: MailgunRegion): MailgunClient;
/** Every saved Mailgun secret plus its Basic-auth form base64("api:" + key), for describeJobError/redactText. */
export async function mailgunSecrets(): Promise<string[]>;
/** Loads Settings "sending.goLive"/"sending.testList" (and the user's reply inbox when userId is given) as a SendGuard. */
export async function loadSendGuard(opts?: { userId?: number }): Promise<SendGuard>;
// src/server/mailgun/suppression-lookup.ts
/** Which lists hold each address: the local Suppression table ("local") and Mailgun's three lists on ctx.domain
 *  (getSuppression per list). Used for reply inboxes by the domain check (P4) and the route sync (P5). */
export async function suppressionListsFor(addresses: string[], ctx: MailgunContext): Promise<Map<string, Array<"local" | SuppressionList>>>;
```
`text` values: practice copy → "The practice copy never talks to Mailgun."; no domain → "Mailgun isn't connected yet.
Open Settings › Sending & Mailgun."; no key → "The Mailgun API key isn't saved yet. Open Settings › Sending & Mailgun.";
fake/real key mismatch (reason `no-key`) → "The saved Mailgun key doesn't fit this server (test key on real Mailgun, or
the other way round). Save the right key in Settings › Sending & Mailgun."

#### 4.2.5 `src/server/services/sending/usage.ts` (today's limit and usage)

```ts
export type TodayCap = {
  capDay: CapDay; capZone: string; dayStart: Date; dayEnd: Date;
  cap: number; source: "warmup" | "override"; aboveSchedule: boolean; override: CapOverride | null;
  warmupCap: number; warmupStep: number; warmupSteps: number; maxCap: number;
  used: number;         // counted campaign sends + test sends this cap day
  testSends: number;
  left: number;
  bySender: ReadonlyMap<number, number>; // counted campaign sends per senderId (test sends not included)
};
export async function getTodayCap(now: Date, opts?: { practiceCopy?: boolean }): Promise<TodayCap>;
export async function countUserTestSends(userId: number, now: Date, tx?: Tx): Promise<number>; // this cap day, any status except FAILED
export type HealthCountsWithIds = HealthCounts & { bounceEmailIds: number[]; complaintEmailIds: number[] };
export async function loadHealthCounts(opts: { since: Date | null; before?: Date | null; bounceWindow: number; complaintWindow: number; practiceCopy: boolean }): Promise<HealthCountsWithIds>;
```
Counting rules:
- **Campaign sends counted today**: `OutboundEmail` with `mode ∈ realModes(practiceCopy)` and either
  (`status = SENT` and `sentAt ∈ [dayStart, dayEnd)`) or (`status ∈ {SENDING, UNKNOWN, UNCONFIRMED}` and
  `claimedAt ∈ [dayStart, dayEnd)`). TEST rows never count. Grouped by `senderId`.
- **Test sends**: `TestSend` with `status ≠ FAILED` and `sentAt ∈ day`.
- **Warm-up step**: SystemState `warmup` (step 0 when the stored domain differs from Setting `mailgun.domain ?? ""`).
- **Health counts** (`loadHealthCounts`): take the most recent `bounceWindow` rows with `mode ∈ realModes`,
  `status = SENT`, `sentAt > since` (and `< before` when given), order `sentAt desc`; `bounces` = distinct
  `outboundEmailId` among them having a `MailEvent` with `type = "failed"`, `severity = "permanent"`, `isTestMode = false`
  and (`reason IS NULL` OR reason not starting with `suppress-`); `bounceSample` = rows taken. Complaints: the most
  recent `complaintWindow` rows the same way; `complaints` = distinct `outboundEmailId` among them having a `MailEvent`
  with `type = "complained"` and `isTestMode = false` (so a `suppress-complaint` drop, which Mailgun never delivered,
  never counts). The counted ids are returned for the Deliverability tables (§5.5). Chunk `in` lists by 400.

#### 4.2.6 `src/server/services/sending/pause.ts` (global pause)

```ts
export type PauseInput = { kind: PauseKind; reason: string; fixText: string; detail?: PauseDetail | null; byUserId?: number | null; now?: Date };
export async function getPauseState(): Promise<PauseState>;
export async function pauseSending(input: PauseInput): Promise<{ newlyPaused: boolean; state: PauseState }>;
export async function resumeSending(input: { actorId: number; actorName: string; now?: Date; confirmRestoreRisk?: boolean }): Promise<{ resumed: boolean; summary: string; state: PauseState }>;
```
- `pauseSending`: CAS loop on `sending.pause` (5 tries). Not paused → write the new state, then (outside the CAS) log
  activity `sending.paused` ("Sending paused: <reason>", actor = byUserId) and notify the Owner (type `sending.paused`,
  title `Sending paused: <reason>`, body `<fixText>`, link `/settings/sending`) — unless `byUserId` is the Owner
  (manual pause: no notification). Already paused → append `{kind, reason, at}` to `also` when that kind isn't the main
  kind or already in `also` (a health kind already in `also` gets its `detail` refreshed); no new notification.
  Idempotent: the same kind twice changes nothing else. Returns `newlyPaused`.
- `resumeSending`, in this order (a crash between steps can only leave it still paused, never resumed with the old
  baseline):
  1. **Restore guard.** The main or an `also` kind is `restore` and `restore.status` is `failed`, or `done` with
     `report.mailgunChecked = false`: refuse unless `confirmRestoreRisk` ("Tick the box to confirm that emails sent
     after <backup time> may go out a second time."); with it, CAS `restore.acknowledgedAt/By`. While the status is
     `pending`/`scanning`, resuming is allowed, but TEST/LIVE sends stay held by the restore gate (§4.3.7) until the
     check finishes.
  2. **Health baseline first.** The main kind or any `also` kind is `health-bounce`/`health-complaint` → CAS
     `health.baseline` to `{since: now, resumedById, acknowledged: {kind, count, sample} (from the main health kind's
     `detail`, else the first health `also` entry's), warnedBounceAt: null, warnedComplaintAt: null}`.
  3. **Then** CAS `sending.pause` to `NOT_PAUSED`.
  4. Activity `sending.resumed` with summary `Resumed by Arslan with 7 of 200 acknowledged` (health; numbers from
     `detail.count`/`detail.sample`) or `Resumed by Arslan` (other kinds). Returns that summary.
  Does not test Mailgun: if the cause is still there, the next send pauses again with the same message (§9.2).

#### 4.2.7 `src/core/system-state-parse.ts` and `src/server/state-typed.ts`

```ts
// core: one lenient parser per contract type, never throws, missing/invalid → default
export const NOT_PAUSED: PauseState;
export function parsePauseState(v: unknown): PauseState;
export function parseHealthBaseline(v: unknown): HealthBaseline;
export function parseWarmupState(v: unknown): WarmupState;
export function parsePacerState(v: unknown): PacerState;
export function parseSendingDayState(v: unknown): SendingDayState;
export function parseCatchUpState(v: unknown): CatchUpState;
export function parseOutageState(v: unknown): OutageState;
export function parseRestoreState(v: unknown): RestoreState;
export function parseTunnelState(v: unknown): TunnelState;
export function parseMailgunSetupState(v: unknown): MailgunSetupState;
export function parseDomainCheckState(v: unknown): DomainCheckState;
export function parseLogsFormState(v: unknown): LogsFormState;
export function parseWebhookStats(v: unknown): WebhookStats;
export function parseNotices(v: unknown): NoticesState;
export function parseInstanceState(v: unknown): InstanceState | null;
export function parseCapOverride(v: unknown): CapOverride | null;
export function parseUnsubscribeTest(v: unknown): UnsubscribeTestSetting;   // old stored shapes (with testSendId/sentAt, no domain) parse fine
// server: typed helpers over getState/casState/setState
export type Parsed<T> = { value: T; version: number | null };
export async function readTyped<T>(key: StateKey, parse: (v: unknown) => T): Promise<Parsed<T>>;
export async function updateTyped<T>(key: StateKey, parse: (v: unknown) => T, change: (current: T) => T | null, tries?: number): Promise<{ written: boolean; value: T }>; // null = no write
export async function shouldSendNotice(noticeKey: string, now: Date, everyMs?: number): Promise<boolean>; // CAS on "notices", default 24 h
```

`src/server/state.ts` fix (P2): `casState(key, null, value)` catches Prisma `P2002` on the create (the web process and
the worker created the same row at once, e.g. "Pause all" during an automatic pause) and returns `false`, so every CAS
loop simply re-reads and tries again. Test: two concurrent creates → exactly one `true`, no throw.

### 4.3 Sending engine (P3)

#### 4.3.1 Transport (`transport.ts` edit, `mailgun-transport.ts` new)

```ts
// transport.ts
export type OutgoingMessage = { /* M2 fields unchanged */ } & { toNorm: string; replyTo?: string | null };
export type TransportFailure =
  | { kind: "rejected"; message: string; detail: string | null }                       // a 4xx "no" about this one email (400 …); nothing was accepted
  | { kind: "rate-limited"; retryAt: Date; message: string }                           // 429
  | { kind: "pause"; pause: PauseKind; reason: string; fixText: string; mailgunMessage: string } // 401/403, business verification, not allowed/disabled/suspended, settings problems
  | { kind: "not-found"; message: string }                                             // 404 on the send (may be temporary)
  | { kind: "ambiguous"; message: string }                                             // may have been accepted: timeout, network, 5xx, 3xx, 2xx without id
  | { kind: "blocked"; message: string; pause?: { kind: PauseKind; reason: string; fixText: string } }; // nothing left this PC
export class TransportError extends Error { constructor(readonly failure: TransportFailure); }
export const SENDABLE_MODES: readonly SendMode[] = ["DRY_RUN", "TEST", "LIVE"];
export function makeTransportFactory(ctx: MailgunContextResult, opts?: { practiceCopy?: boolean; guard: SendGuard }): (mode: SendMode) => EmailTransport;
/** Kept for M2 callers/tests: DRY_RUN only; TEST/LIVE return a transport that throws TransportError "blocked". */
export function transportFor(mode: SendMode): EmailTransport;
// mailgun-transport.ts
export class MailgunTransport implements EmailTransport {
  readonly mode: "TEST" | "LIVE";
  constructor(opts: { mode: "TEST" | "LIVE"; context: MailgunContext; guard: SendGuard });
  send(message: OutgoingMessage): Promise<TransportResult>; // throws TransportError only
}
export function buildSendInput(message: OutgoingMessage, mode: "TEST" | "LIVE", guard: SendGuard): SendMessageInput;
```
`buildSendInput`: `to = message.toNorm` after asserting `normalizeEmail(message.to) === message.toNorm` and that the
address has none of `, ; < > "` or whitespace (else `rejected` "This email's address isn't a single valid address.");
`purpose "campaign"`, `guard`; `tags = ["outreach", "step-" + step]`, `variables = {send_id, campaign_id, step}`,
`testMode = mode === "TEST"`, `o:tracking-opens=no`/`o:tracking-clicks=no` are added by the client for every send. Never
`o:tracking`, `o:deliverytime`, `o:suppress-headers`, `h:List-Unsubscribe`. (`OutgoingMessage` gains `toNorm`.)

Before the request (nothing leaves the PC, `blocked` + pause `mailgun-settings`): the From address's domain must be a
`SendingDomain` row ("The sender's address isn't on a connected sending domain. Check Settings › Sending & Mailgun,
then click Resume."); the `o:`/`h:`/`v:` fields must total ≤ 16 KB ("An email's extra fields are too large for Mailgun.
This is a bug in the app: tell us, then click Resume."; notice `options-too-large`).

Error mapping from `MailgunError`:

| `kind` | TransportFailure |
|---|---|
| `guard` | `blocked` (the loop skips the row `not-on-test-list`, §4.3.3) |
| `rejected` (a 400 about this email, or another plain 4xx) | `rejected` |
| `rate-limited` | `rate-limited` (`retryAt = now + retryAfterMs`) |
| `auth` | pause `mailgun-auth` |
| `business-verification` | pause `mailgun-verification` |
| `not-allowed` (any status but 429, 400 included) | pause `mailgun-not-allowed` |
| `payment`, `conflict` | pause `mailgun-settings` (account-level answers, never about one email) |
| `not-found` | `not-found` (released with a 5-minute back-off; the domain check decides whether to pause, §4.3.5) |
| `timeout`, `network`, `server`, `unexpected` with `ambiguous` | `ambiguous` |
| anything else with `requestStarted = false` | `blocked` |

#### 4.3.2 Gates and pacing (`gates.ts` new)

```ts
export type Candidate = {
  id: number; campaignId: number; recipientId: number; companyId: number | null; senderId: number | null;
  step: number; mode: SendMode; toNorm: string; dueAt: Date; priorityRank: number; zone: string; ignoreWindow: boolean;
  /** Campaign.fromAddress (bare), for the reply-route hold. */
  fromAddress: string;
  /** Campaign.launchedAt, for the pending-reply guard (§4.3.4). */
  campaignLaunchedAt: Date | null;
};
/** Due gated rows per zone (all of them, not just the candidates), for the pacing formula and "outside hours". */
export type DueStats = Array<{ zone: string; counted: boolean; senderId: number | null; count: number }>;
export type GateContext = {
  now: Date; pause: PauseState; today: TodayCap; window: SendingWindow; defaultZone: string; minGapSeconds: number;
  pacer: PacerState; mailgun: MailgunContextResult; catchUpReady: boolean; practiceCopy: boolean; goLive: boolean;
  senderCaps: ReadonlyMap<number, number | null>;   // User.dailyCap
  /** §4.3.7: a restore is being checked (or failed/unchecked and not acknowledged). Holds TEST/LIVE only. */
  restoreHold: boolean;
  /** Setup A and neither the "tracking-off" nor the "unsubscribe" checklist row is "bad" (spec: footer + unsubscribe). */
  liveReady: boolean;
  /** SenderAddress.address → routeStatus === "ok". */
  routeOk: ReadonlyMap<string, boolean>;
  /** pendingProblemIds(gated candidates), §4.3.4. */
  blockedIds: ReadonlySet<number>;
  due: DueStats;
};
export async function loadGateContext(now: Date, deps: { startedAt?: Date | null; mailgun?: () => Promise<MailgunContextResult>; due: DueStats; blockedIds: ReadonlySet<number> }): Promise<GateContext>;
export async function pickCandidates(now: Date, opts: { window: SendingWindow; defaultZone: string; limit?: number }): Promise<{ ungated: Candidate[]; gated: Candidate[]; due: DueStats }>;
export function gateClass(c: Pick<Candidate, "mode" | "ignoreWindow">, ctx: { practiceCopy: boolean }): "ungated" | "gated-counted" | "gated-uncounted";
export type TickPlan = {
  ungated: Candidate[];            // ≤ 25, as M2
  next: Candidate | null;          // at most ONE gated email this tick
  nextCounted: boolean;
  waiting: { reason: WaitReason; until: Date | null } | null;
  capReached: boolean;
  /** Inputs of the gap after `next` is sent (risk-reviewed: only rows that can really go today). */
  pace: { counted: { dueCount: number; openSecondsLeft: number }; uncounted: { dueCount: number; openSecondsLeft: number } };
};
export function planTick(ungated: Candidate[], gated: Candidate[], ctx: GateContext): TickPlan;   // pure given ctx
export async function pendingProblemIds(cands: readonly Candidate[]): Promise<Set<number>>;      // §4.3.4, batched
export async function savePacer(now: Date, update: Partial<PacerState>): Promise<void>;
```

`gateClass`: DRY_RUN with `ignoreWindow` → ungated (M2 path); DRY_RUN without it → gated-counted in the practice copy,
gated-uncounted on real data (hours and pacing, never caps or health); TEST → gated-uncounted; LIVE → gated-counted.

**Catch-up gate** (B1, SPEC "first catches up … then resumes sending"): `catchUpReady` = Mailgun not connected, OR
`mailgun.catchUp.lastSuccessAt ≥ startedAt`, OR (`now − startedAt ≥ 15 min` AND a catch-up has finished since
`startedAt` AND its `lastErrorKind` is `network` or `server`), OR `startedAt` not given (tests). An `auth` failure never
opens the gate (it pauses anyway), and a catch-up that hasn't run yet (the job runner is busy) keeps it closed. Waiting
text: "Waiting for the check with Mailgun". The 15-minute fallback is an owner-visible exception to SPEC (§9.4).

**`pickCandidates`** (never lets closed zones starve open ones):
1. Ungated: `status QUEUED`, `step ≤ MAX_SENDABLE_STEP`, `dueAt ≤ now`, `mode DRY_RUN`, `campaign.ignoreWindow true`,
   `campaign.status RUNNING`, ordered and limited exactly like M2's `pickDueEmails` (25).
2. Due stats: one `$queryRaw` over the same filters for gated rows (`mode <> 'DRY_RUN' OR ignoreWindow = false`),
   `GROUP BY company.timeZone, mode, ignoreWindow, senderId` with `COUNT(*)`; each raw zone goes through
   `resolveZone(raw, defaultZone)`.
3. Open zones now: the raw zone values whose resolved zone `isWindowOpen(now, zone, window)`.
4. Gated candidates: the same filters plus `recipient.company.timeZone IN (open raw values)` (or `timeZone null` when
   the default zone is open), ordered `step desc, recipient.company.priorityRank asc, dueAt asc, id asc`, limit 500.
   Selects `recipient.company.timeZone`, `campaign.{ignoreWindow, fromAddress, launchedAt}`, `senderId`, `mode`, `toNorm`.
`pickDueEmails` is deleted (§4.3.3). Check `tests/integration/sending/query-plans.test.ts` still shows index use for
both queries.

**`planTick`**, for the gated candidates in order (each check holds only the rows it names; the first row left is
`next`; `waiting` is the reason of the first check that held the first row, or `nothing-due`):
1. `pause.paused` → nothing at all (the loop already stopped at step 2 of §4.3.3) → `paused`.
2. `restoreHold` → TEST/LIVE held → `restore-check`.
3. TEST/LIVE while `mailgun` isn't connected (or practice copy) → held → `mailgun-not-connected`.
4. TEST/LIVE while not `catchUpReady` → held → `catch-up`.
5. TEST/LIVE while `pacer.backoffUntil > now` → held → `rate-limited` or `mailgun-unreachable` (from `backoffReason`),
   `until = backoffUntil`.
6. LIVE while not `liveReady` → held → `live-not-ready`.
7. LIVE whose `routeOk.get(fromAddress) !== true` → held → `reply-route` (a wait, never a stop: route status is
   `pending` during every sync and `error` on a Mailgun 5xx; §4.5.4).
8. `blockedIds.has(id)` → skipped → `pending-events` (the next candidate is tried, so one waiting reply never blocks
   the queue).
9. No gated candidate at all but due rows exist in closed zones → `outside-hours`, `until` = the earliest
   `nextWindowOpen` over the due zones.
10. Counted rows while `today.left = 0` → held, `capReached = true` → `cap-reached` (uncounted rows may still go).
11. Counted rows whose sender has no capacity left (`senderCapacityLeft(User.dailyCap, today.bySender)`) → held →
    `sender-cap`.
12. The pacer, recomputed every tick per class (counted / uncounted): the row is held while `now < lastByClass[class].at
    + gap`, where `gap = paceGapMs({openSecondsLeft: open time from that send to today.dayEnd, capacityLeft: counted ?
    today.left : Infinity, dueCount: the class's CURRENT due count, minGapSeconds, jitter: the factor stored at that
    send})`, i.e. N rows over N + 1 intervals, never below the smallest gap. Last chance: when the row's own window
    closes before that time, it may go one smallest gap before the close. No two gated sends closer than the smallest
    gap (`lastSentAt`, any class). A paced row never stops a row of the other class (the loop continues). →
    `pacing`, `until` = the earliest time any held row may go.

**Pacing inputs** (from `due`, not from the 500 candidates): for counted sends, `dueCount` = due counted rows whose
zone has open time left before `today.dayEnd` (`openSecondsBetween(now, dayEnd, [zone]) > 0`), summed per sender and
capped at what that sender may still send (`senderCapacityLeft`; no limit = all rows). Uncounted sends use their own
rows and zones, with unlimited capacity. After a gated send: store `lastByClass[class] = {at: now, jitter:
jitterFactor(random)}` and `lastSentAt = now`; `nextSendAt = now + gap` is kept for display only. A new campaign, a
resumed one or a schedule that starts shortens the wait at once, because the gap follows the rows due now.

`liveReady` and `routeOk` come from `domain.check` rows, Setting `mailgun.unsubscribeTest.setup` and `SenderAddress`
rows; a row status `unknown` ("couldn't check") never holds anything.

#### 4.3.3 The sending loop (`loop.ts` edit)

`MAX_SENDABLE_STEP = 0` stays. `pickDueEmails` is deleted (no caller may reach Mailgun without the gates).
`SendingDeps` gains `startedAt?: Date | null`, `random?: () => number`, `mailgun?: () => Promise<MailgunContextResult>`,
`gateContext?: GateContext` (tests), `gatedEmailId?: number`, `inFlight?: Set<number>`. `SendingLoop` exposes
`readonly inFlight: ReadonlySet<number>` (ids between claim and outcome) for the reconciler (P6 wires them).
`sendingTick`:
1. aborted / no lease → stop (as M2).
2. `pause.paused` → return `{…, paused: true}` (nothing claimed, dry runs included; `pacer.waiting = paused`).
3. `promoteScheduledCampaigns`.
4. `pickCandidates` → `pendingProblemIds(gated)` → `loadGateContext` → `planTick`.
5. Ungated rows: `sendOneEmail` each (M2 path, 25 per tick).
6. Gated `next`: `sendOneEmail(next.id, {..., gatedEmailId: next.id, transportFor: makeTransportFactory(ctx.mailgun,
   {guard: await loadSendGuard()})})`. On `sent` → pacer `{lastByClass[class]: {at, jitter}, lastSentAt, nextSendAt
   (display only), lastGapSeconds, ambiguousStreak: 0, backoffUntil: null}`; LIVE → `SendingDomain.lastLiveSendAt = now` for the From domain. Other
   outcomes update the pacer per §4.3.5.
7. `capReached` and not yet notified this cap day (`sending.day`) → Owner notification `sending.capReached`
   ("Today's limit of 50 emails is reached" / "The rest go out from the start of tomorrow's sending hours in each
   recipient's time zone. To send more today, change today's limit in Settings › Limits & warm-up.", link `/settings/limits`).
8. `waiting.reason = reply-route` since more than 1 hour (`pacer.routeWaitSince`) → notice `reply-route-down`:
   "Live emails are waiting: a reply route isn't working" / "Replies to <name> couldn't reach them, so their live emails
   wait. Click Apply recommended settings in Settings › Domain checklist."
9. `finishCheck` for touched campaigns (as M2).

`sendOneEmail(emailId, deps)` keeps its M2 pipeline with these changes:
- **TEST/LIVE rows need the gate:** after the claim, a TEST or LIVE row whose id isn't `deps.gatedEmailId` is released
  at once (`releaseClaim({countAttempt: false})`, outcome `not-running`). A test proves that calling
  `sendOneEmail(liveId)` without it sends nothing.
- `deps.inFlight` holds the id from the claim to the end (in a `finally`).
- The recheck on fresh data (`recheckRecipient`) no longer uses the reply-route rule (§4.3.9); `ensureReservation` runs
  only when `countsAsEmailed` (§1.7).
- **Final check, just before `transport.send` (TEST/LIVE):** one read, then one CAS:
  1. `sending.pause` not paused → else `releaseClaim({countAttempt: false})`, outcome `not-running`;
  2. no `Suppression` row for `toNorm` and no `unsubscribedAt`/`bouncedAt`/`complainedAt` on the person with that
     `emailNorm` → else SKIPPED with the stop reason (recipient STOPPED, as the recheck does);
  3. the recipient isn't FINISHED, STOPPED or EXCLUDED → else SKIPPED;
  4. `!goLive && !testList.has(toNorm)` → SKIPPED `not-on-test-list`;
  5. CAS "touch" `updateMany {id, status: SENDING, claimedAt: <our claim>} → {lastError: null}` must count 1, else
     outcome `lost` (the reconciler took it; nothing was posted).
- The transport call maps a `TransportError` per §4.3.5. Any other error thrown by a Mailgun transport counts as
  `ambiguous`; from the dry-run transport it keeps the M2 `failAttempt` path.
- **After a 200:** first one autocommit CAS `updateMany {id, status: SENDING} → {providerId}` (the proof is saved even
  if what follows fails), then `markSent(acceptedAt, {providerId})`. If `markSent` throws, CAS SENDING → UNKNOWN with
  lastError "Sent, but not recorded yet. The app will record it within 10 minutes." and notice `sent-not-recorded`
  (once); the reconciler finishes it (§4.3.6).

#### 4.3.4 Before every send (B6.4 guard)

`pendingProblemIds(cands)` runs two batched queries (chunks of 400) for all gated candidates at once and returns the
ids to skip this tick:
- **Events:** a `MailEvent` with `processedAt = null` and `recipient IN (toNorms)` blocks that address. The event lane
  empties this within a second or two; an event that keeps failing is given up after 5 tries (§4.4.3), so it can't
  block an address for ever.
- **Replies:** `InboundMessage` rows with `processedAt = null` and `receivedAt ≥ min(campaignLaunchedAt)`, excluding
  rows whose `inReplyTo` or `references` contain a `TestSend.messageId` (replies to reply tests and "Send me a test").
  Their `fromEmail`s are mapped to companies through `Person.emailNorm` (deleted people included). A candidate is
  blocked when such a reply has `receivedAt ≥ c.campaignLaunchedAt` and either `fromEmail = c.toNorm` or the sender's
  company is `c.companyId`.

Replies from before the campaign's launch are already handled by the 30-day rule and by M4's processing. In M3 a reply
received during a campaign holds only that campaign's further emails to that address or company (first emails only in
M3, so in practice nothing else waits). After claiming, the M2 re-check of eligibility on fresh data still runs.

#### 4.3.5 Claim → POST → outcome (B6.7)

| From | Event | To | claimedAt | attempts | lastError (shown on the campaign page) | Also |
|---|---|---|---|---|---|---|
| QUEUED | claim (autocommit CAS, never in a transaction) | SENDING | now | +1 | — | lease checked first; id added to `inFlight` |
| SENDING | final check fails (§4.3.3) | QUEUED (pause) / SKIPPED (suppressed, closed, not on test list) / unchanged (CAS lost) | | | as the recheck | nothing posted |
| SENDING | 200 accepted | `providerId` saved (autocommit CAS), then SENT via `markSent(acceptedAt = now, providerId)` | kept | kept | null | next-step row, recipient, company (M2); pacer streaks reset |
| SENDING | 200, but `markSent` throws | UNKNOWN (providerId set) | kept | kept | `Sent, but not recorded yet. The app will record it within 10 minutes.` | notice `sent-not-recorded`; reconciler retries `markSent` |
| SENDING | `rejected` (a 4xx about this email) | FAILED | kept | kept | `Mailgun refused this email.` (Mailgun's text in the activity data, shown under "Details" in the recipient panel) | recipient STOPPED `failed`, `releaseCompanyIfDone`, activity `email.failed`; circuit breaker below |
| SENDING | `rate-limited` (429) | QUEUED | null | −1 | `Mailgun asked us to slow down; trying again at 14:05` (in cap-day zone) | `dueAt = retryAt`, `pacer.backoffUntil = retryAt`, `backoffReason rate-limited` |
| SENDING | `pause` (401/403, business verification, not allowed/disabled/suspended, 402/409) | QUEUED | null | −1 | unchanged | `pauseSending(kind, …)` (§5.9 copy) |
| SENDING | `not-found` (404) | QUEUED | null | −1 | `Mailgun couldn't find the sending domain for a moment; trying again at 14:05` | `pacer.backoffUntil = now + 5 min` (`mailgun-unreachable`); enqueue `mailgun.checkDomain`: when `getDomain` also answers 404 there, the check pauses `mailgun-domain` ("Mailgun can't find <d> in the EU region. If you created the domain in the US region, change Region to US.") |
| SENDING | `ambiguous` (timeout, network, 5xx, 3xx, 2xx without id, any other error after the request started) | UNKNOWN | kept | kept | `Mailgun didn't answer in time; checking whether it was sent` | reconciler; `ambiguousStreak + 1`, `backoffUntil = now + 5 / 15 / 60 min` (1st / 2nd / 3rd+ in a row), `backoffReason mailgun-unreachable`; notice `mailgun-unreachable` at 3 in a row ("Mailgun isn't answering" / "The app will keep trying and checks every email it wasn't sure about.") |
| SENDING | `blocked` | QUEUED | null | −1 | unchanged | its `pause`, if any, via `pauseSending` |
| SENDING | render error | QUEUED (1/5/15/60 min) or FAILED after 5 | — | — | M2 `failAttempt` | unchanged |
| SENDING | worker stopped mid-send | stays SENDING | — | — | — | DRY_RUN: M2 reset after 2 min. TEST/LIVE: reconciler. Never reset. |
| SENDING (claimed > 2 min, TEST/LIVE, not in `inFlight`) | reconciler | UNKNOWN | kept | kept | `Checking with Mailgun whether it was sent` | CAS on SENDING + claimedAt |
| any status but SENT (TEST/LIVE; QUEUED, UNKNOWN, UNCONFIRMED, FAILED, SKIPPED …) | any proof of sending (§4.4.2) or the reconciler finds an event | SENT via `markSent(acceptedAt = earliest event time)` | | | null | automatic: Mailgun has it, so it must never be sent again |
| UNKNOWN (providerId set) | reconciler | SENT via `markSent` (retried every pass) | | | null | never requeued, never made Unconfirmed |
| UNKNOWN (providerId null) | not found by all three queries, each complete, the positive control found (§4.3.6), `claimedAt` ≥ 45 min ago, `claimedAt − 10 min` ≥ now − logRetention | QUEUED, **same Message-ID**; CANCELLED when the campaign has ended | null | kept | `Mailgun never received it; it will be sent again` / the ended-campaign text | `dueAt = now` |
| UNKNOWN (providerId null) | anything else, younger than 2 h | UNKNOWN | | | | next pass |
| UNKNOWN (providerId null) | `claimedAt` older than 2 h (or older than `logRetentionDays − 1 h`, if that is shorter) and still undecided | UNCONFIRMED | kept | kept | `We couldn't confirm with Mailgun whether it was sent` | notify campaign sender + Owner (`email.unconfirmed`) |
| UNCONFIRMED | person clicks Retry (LIVE: after confirming the duplicate risk; refused when `providerId` is set) | QUEUED, same Message-ID | null | 0 | null | M2 `retryEmail` + guard |
| UNCONFIRMED | person clicks Skip | SKIPPED | | | `Skipped by Sara (we couldn't confirm it was sent)` | recipient STOPPED `Skipped by Sara` |

**Rejection circuit breaker:** after each `rejected` outcome, append `{at, toNorm, message}` to `pacer.recentRejects`
(keep 3); a `sent` outcome clears it. Three rejects for three different addresses within 30 minutes → `pauseSending
({kind: "mailgun-settings", reason: "Mailgun refused 3 emails in a row", fixText: "Mailgun refused the last 3 emails
(<Mailgun's last message>). Check the banner in Mailgun, then click Resume.", detail: {mailgunMessage}})`. So an
account-level refusal whose text we don't know can fail at most 3 emails, never a whole campaign.

Every web edit/skip/pause keeps `updateMany where status = QUEUED` (M2).

#### 4.3.6 Reconciler (`reconcile.ts` new; loop class `worker/reconciler.ts`)

```ts
export const RECONCILE_INTERVAL_MS = 10 * 60_000;
export const STUCK_SENDING_MS = 2 * 60_000;
export const NOT_SENT_MIN_AGE_MS = 45 * 60_000;
export const UNCONFIRMED_AFTER_MS = 2 * 3_600_000;
export const LOOKBACK_BEFORE_CLAIM_MS = 10 * 60_000;
export const CONTROL_LOOKBACK_MS = 6 * 3_600_000;
export type ReconcileResult = { checked: number; sent: number; requeued: number; cancelled: number; unconfirmed: number; stillUnknown: number; error: string | null };
export async function reconcileSends(opts?: { now?: Date; limit?: number; mailgun?: () => Promise<MailgunContextResult>; signal?: AbortSignal; inFlight?: ReadonlySet<number> }): Promise<ReconcileResult>;
// worker/reconciler.ts
export class ReconcilerLoop { constructor(opts: { ownsLease: () => Promise<boolean>; logger?: Logger; now?: () => Date; mailgun?: () => Promise<MailgunContextResult>; inFlight?: ReadonlySet<number> }); run(signal: AbortSignal): Promise<void>; tick(): Promise<ReconcileResult | null>; }
```
Per pass (first pass right after start-up, then every 10 minutes), TEST/LIVE rows, oldest first, `limit` 50:
1. `SENDING` with `claimedAt < now − 2 min` and not in `inFlight` → CAS (`status SENDING`, same `claimedAt`) to UNKNOWN.
2. UNKNOWN rows with `providerId` set → `markSent(claimedAt, {providerId})` again (the send is proven; §4.3.3).
3. Other UNKNOWN rows → look for the email in Mailgun's Logs, events `[accepted, delivered, failed]`, window
   `[claimedAt − 10 min, now]`, filter `domain = <From domain>` plus, in turn:
   a. `message_id = <messageId>` in the proven form (`logsForm.messageIdForm`; while unproven, try plain, then
      `<bracketed>`);
   b. `user_variables contains <sendId>`;
   c. `recipient = <toNorm>` (accepted and failed events only), matched by `user-variables.send_id` or Message-ID.
   Any hit → CAS `providerId`, then `markSent(earliest event time, {providerId: the event's message id})`. (The events
   themselves are applied by the next catch-up, which reads the same Logs; the reconciler never imports P4 code.)
4. **"Not sent" needs a positive control.** Before the first requeue in a pass, take the newest SENT TEST/LIVE row (or
   TestSend with a `providerId`) on the same domain with `sentAt ∈ [claimedAt − 6 h, claimedAt]` and run the identical
   query shapes (a and b) for it over a window of the same age. Only when both find the control may rows be requeued in
   this pass; the proven forms are cached in `mailgun.logsForm` (`messageIdForm`, `sendIdFilterOk`, `provenAt`). No
   control row, or a control that isn't found → never requeue: the row stays UNKNOWN and becomes UNCONFIRMED at 2 h.
   This catches every way an empty answer could be wrong (bracket form, a rewritten Message-ID, a different
   `contains` behaviour, `mailgun.logRetentionDays` set higher than the plan keeps).
5. Requeue (all of 3a–c complete and empty, control found, `claimedAt ≥ 45 min` ago, `claimedAt − 10 min ≥ now −
   logRetention`, `providerId IS NULL`): CAS UNKNOWN → QUEUED with the same Message-ID, `dueAt = now`; when the
   campaign is CANCELLED or FINISHED the row becomes CANCELLED instead (same text as `releaseClaim`), never "it will be
   sent again".
6. UNCONFIRMED: `providerId IS NULL` and `claimedAt` older than `UNCONFIRMED_AFTER_MS` (2 h), or older than
   `logRetentionDays − 1 h` when that is shorter, whatever the reason (Mailgun disconnected, queries failing, no
   control) → CAS UNKNOWN → UNCONFIRMED + `email.unconfirmed` notifications. The person then decides (Retry or Skip);
   a later proof of sending still turns it SENT automatically.

Mailgun not connected → steps 1, 2 and 6 only.

#### 4.3.7 Restore (`restore.ts` new; job `mailgun.restoreScan`)

```ts
export function restoreMarkerPath(): string; // path.join(path.dirname(databaseFilePath()), "RESTORED")
export const RESTORE_MARKER_VERSION = 3;
export const RESTORE_SECOND_PASS_MS = 35 * 60_000;
export async function handleRestoreMarker(opts?: { now?: Date; markerPath?: string; logger?: Logger }): Promise<{ handled: boolean }>;
export async function runRestoreScan(opts?: { now?: Date; pass?: 1 | 2; mailgun?: () => Promise<MailgunContextResult>; signal?: AbortSignal; progress?: (done: number, total: number) => Promise<void> }): Promise<RestoreReport>;
export const restoreScanJob: JobDefinition; // worker/jobs/mailgun-restore-scan.ts, payload {pass: 1 | 2}
export function restoreHoldActive(state: RestoreState): boolean; // pure: pending/scanning, or failed/unchecked and not acknowledged
export async function checkDatabaseInstance(opts?: { now?: Date; markerSeen: boolean }): Promise<{ copied: boolean }>;
```

**`handleRestoreMarker`** (marker JSON `{version: 3, restoredFrom, at, file}`, written by `scripts/restore.mjs`). Every
step is idempotent, and the order means a crash anywhere just repeats the steps at the next start:
1. `pauseSending({kind: "restore", reason: "restored from a backup", fixText: "Check the restore report in Settings ›
   Sending & Mailgun, then click Resume."})` (a second call adds nothing).
2. Enqueue `mailgun.restoreScan {pass: 1}` (dedupe `mailgun:restore-scan`, priority 40).
3. CAS `restore = {status: "pending", restoredFrom, markerAt: at, file, scanFrom, report: null, acknowledged*: null}`
   where `scanFrom = min(restoredFrom, newest ActivityLog.at in the restored database) − 1 h` (a backup copied or touched
   later can't start the scan too late).
4. Delete the marker; a delete error (antivirus lock, EPERM/EBUSY) is logged and ignored.
Shortcut: a marker whose `at` equals `restore.markerAt` is deleted without redoing the steps only when `restore.status`
is `done` or `failed`, or a pause of kind `restore` exists; otherwise all four steps run again.

**Send gate** (`restoreHoldActive`, read into `GateContext.restoreHold`): while `restore.status` is `pending` or
`scanning`, or it is `failed` / `done` with `report.mailgunChecked = false` and `acknowledgedAt` is null, every TEST/LIVE
row waits (`restore-check`), whatever the pause says. Dry runs are not held.

**`runRestoreScan`** (B6.7), two passes, because Mailgun's logs can be up to 30 minutes behind:
- Pass 1 (right after start-up): status `scanning`; no Mailgun → report `mailgunChecked: false`, status `done`
  (the gate then needs the Owner's acknowledgement); else walk and match (below), write the report with `passes: 1`,
  keep status `scanning`, and enqueue `mailgun.restoreScan {pass: 2}` with `runAt = markerAt + 35 min` (dedupe
  `mailgun:restore-scan-2`).
- Pass 2: the same walk again (`markSent` and `ExternalSend` are idempotent), report `passes: 2`, then status `done`
  and the Owner notification (type `restore.checked`, title "Restore check finished", body "Open Settings › Sending &
  Mailgun to read the report, then click Resume.").
- The job's `failureNotice` sets status `failed` (the gate then needs the Owner's acknowledgement).

The walk: window `[max(scanFrom, now − logRetention + 1 h), now]`, `olderThanRetention` when clipped; `accepted` events
with filters `domain = d` and `tag = outreach`, 20 per transaction; match each:
1. by Message-ID (ours, then `providerId`) → `markSent`;
2. by `send_id` → `markSent`;
3. by `(campaign_id, step, recipient)` **only when the campaign existed in the backup** (`campaign.launchedAt <
   restoredFrom`) and the event is not older than `launchedAt`; SQLite hands out ids again after a restore, so a
   campaign created after the restore may carry an old campaign's id. Then find the campaign's recipient by
   `emailNorm`, update the QUEUED/UNKNOWN/UNCONFIRMED row's `messageId`/`sendId` to the event's (CAS) or create the
   missing row (subject/text/html empty, same thread fields as `createNextStepRow`), re-link earlier events of that
   Message-ID (`MailEvent {messageId, outboundEmailId: null}` → the row, re-applying their date fields so health counts
   see them), then `markSent`;
4. otherwise → `ExternalSend {toNorm, companyDomain (from the person's company when the address is known, else the
   email's usable domain), companyId, sentAt, providerMessageId, source: "RESTORE"}` (skip if `providerMessageId`
   exists).
Then, when `olderThanRetention`: TEST/LIVE rows `QUEUED` with `dueAt < markerAt` → UNCONFIRMED ("Restored from an older
backup: we can't check whether this email went out before the restore").

**`checkDatabaseInstance`** (start-up, before `handleRestoreMarker`): SystemState `instance` holds
`{dbPath: databaseFilePath() resolved and lowercased, id, firstSeenAt}`. Missing → write it (first M3 start). Present
with a different `dbPath` and no RESTORED marker seen → `pauseSending({kind: "copied-database", reason: "this database
was copied or moved", fixText: "The app's database now opens from a different place. If this is a copy of the real
database, don't resume: it would send the same emails again. If you moved the app on purpose, click Resume."})`, then
store the new `dbPath`. A restore (marker seen) just stores the path.

> **As built (review fixes and M6 L8; the code in `src/server/services/sending/restore.ts` wins).** The path alone
> can't tell a copy of the whole app folder, or a database file swapped by hand, from a normal restart. So the check
> also uses a note next to the database, `<database file>.instance` (`instanceNotePath()`: `{version, id, host, dbPath,
> at}`, written through a temporary file and a rename; it travels with a copied app folder but never with the database
> file alone, and backups never contain it), and the computer's name (`os.hostname()`). The pure `copyCause(current,
> note, dbPath, host)` says why a database looks like a copy: `"moved"` (another path), `"other-computer"` (the note
> names another computer; or, since M6, there is no note and SystemState `instance.host` names another computer: the
> database file alone copied to the same place on a new PC, and a renamed PC costs one Resume too) or `"replaced"` (the
> note names another database id). Without a RESTORED marker each cause pauses sending with its own sentence; then the
> path, the computer (`InstanceState.host`, M6) and the note are recorded, so the next start is normal. A record without
> `host` (written before M6) and no note is never treated as a copy.

#### 4.3.8 Health check and warm-up (`health-check.ts`, `warmup-days.ts` new)

```ts
export async function runHealthCheck(opts?: { now?: Date }): Promise<{ verdict: HealthVerdict; paused: boolean; warned: Array<"bounce" | "complaint"> }>;
export async function evaluateWarmupDays(opts?: { now?: Date }): Promise<{ evaluated: WarmupDay[]; state: WarmupState }>;
export const warmupEvaluateJob: JobDefinition; // worker/jobs/warmup-evaluate.ts → evaluateWarmupDays + recordTaskSuccess("warmup.hourly")
```
`runHealthCheck`: settings `health.*`; `loadHealthCounts({since: baseline.since})`; `evaluateHealth`; pause via
`pauseSending` or send each new warning (Owner, type `sending.warning`, link `/settings/deliverability`) and record
`warnedBounceAt`/`warnedComplaintAt`. Before evaluating, it clears a `warned…At` (CAS on `health.baseline`) when that
count is now below `max(1, ceil(limit / 2))` or the warning is more than 7 days old, so a later rise warns again.
Called by the event lane after problems (injected by P6), at start-up, after each successful catch-up, and never
re-trips after a resume without new events (the baseline excludes older emails, whichever pause kind was main).

`evaluateWarmupDays`: `domain = Setting mailgun.domain ?? ""`. Different from `state.domain` → reset `{domain, step: 0,
lastEvaluatedCapDay: yesterday, startedCapDay: today, history: []}`. `lastEvaluatedCapDay` null → set to yesterday
(nothing evaluated). For each `closedCapDaysAfter(...)`, oldest first, stopping at the first day that isn't ready:
- **ready** = Mailgun not connected (the practice copy, or before connecting), or `mailgun.catchUp.lastSuccessAt ≥
  dayEnd + 1 h`, so the bounces and complaints that arrived while the PC was off are in before a day is judged (B1:
  catch up, then evaluate closed days);
- `used` = counted sends + test sends of that day (same rules as `getTodayCap`, P3 may query directly), health =
  `loadHealthCounts({since: null, before: dayEnd})`, `isSendingDay` = `window.days` includes `capDayOfWeek`,
  `evaluateWarmupDay`, append to history (keep 60).
One CAS at the end. Only after the CAS succeeds, a rise logs activity `sending.warmup`: "The daily limit rises to 59
(warm-up day 2 of 20)". It runs at the end of every successful catch-up (P6 wires it through `createCatchUpJob`'s
`onSuccess`, §4.4.5) and from the hourly `warmup.evaluate` job; never at start-up before the catch-up.

#### 4.3.9 Launch, eligibility and campaign control changes

| File | Change |
|---|---|
| `launch.ts` | Replace the `mode-not-ready` refusal. In this order: practice copy + TEST/LIVE → `CampaignError("The practice copy never sends real email, so only dry run is available here. Set sending to dry run in Settings › Sending & Mailgun.", "practice-copy")`. TEST/LIVE with Mailgun not connected → `("Test mode and live sending need Mailgun. Connect it in Settings › Sending & Mailgun, or set sending to dry run.", "mailgun-not-connected")`. **Readiness recomputed at launch, not only when the mode was saved:** TEST → the first of `testModeBlockers(…)`; LIVE → the first of `liveLaunchBlockers(domain.check rows, …)` (§4.5.7: DNS, tracking off, unsubscribe on, Setup A, webhooks, signing key, Mailgun accepting, reply test passed on this domain), code `mode-not-ready`. TEST/LIVE sender without a SenderAddress on an active domain → `("<Name> has no sending address yet. <Name> can add one in Settings › My profile.", "no-sender-address")`. LIVE and the sender's route not `ok` → `("Replies to <Name> can't reach <Name> yet: the reply route isn't working. Click Apply recommended settings in Settings › Domain checklist.", "no-reply-route")`; `senderHasReplyRoute` is passed to `evaluateCompanies` (launch only). `takesReservations = countsAsEmailed(mode, …)` (§1.7). **TEST/LIVE campaigns: steps above `MAX_SENDABLE_STEP` get `CampaignStep.enabled = false` inside the launch transaction** (first emails only in M3, §1.3). DRY_RUN: `Campaign.ignoreWindow` = the value the Schedule step sent (`launchAction({campaignId, ignoreWindow?})`; default true on real data, false in the practice copy); TEST/LIVE: always false. The `campaign.sender` notification body for TEST reads "Its emails go to Mailgun's test mode, so nothing is delivered." |
| `addresses.ts` | `senderSnapshot` throws for TEST/LIVE without an address (defence in depth; launch already refuses). |
| `eligibility.ts` (server) | `recheckRecipient` does **not** pass `senderHasReplyRoute` any more (a broken route is a wait at send time, §4.3.2, never a permanent stop). `loadHistory` uses `emailedModes({practiceCopy, goLive})` (§1.7). |
| `reservations.ts`, `control.ts`, `loop.ts`, `mark-sent.ts`, `companies/detail.ts` | `countsAsEmailed` where "emailed" is meant (§1.7); `mark-sent.ts` gains the option `goLive?: boolean` (read from Settings when absent) and calls `recordRealContact` only when `countsAsEmailed`. Behaviour for DRY_RUN rows is unchanged. |
| `sender-caps.ts` (new) | `saveSenderCaps(actor, caps: Array<{userId, dailyCap: number \| null}>)`: validates 1–10,000 or empty, writes `User.dailyCap` in one `dbTx`, activity `settings.updated` ("Arslan set Ali's daily limit to 100"). Used by the Limits page (users.ts stays P5's). |
| `draft.ts` | `LaunchSummary` gains `modeBlockers: string[]` (same texts and order as launch, incl. "Live campaigns start once the reply test has passed (Settings › Domain checklist › Reply test)."), `modeReady = modeBlockers.length === 0`, `today: {cap, used, left, capDay}` (from `getTodayCap`; only for LIVE/practice), `windowText` (`windowSentence`), `fits: {today, later}`, `followUpsOff: boolean` (TEST/LIVE with enabled steps above `MAX_SENDABLE_STEP`), `ignoreWindowDefault: boolean` (dry run: true on real data, false in the practice copy). `SenderChoice` gains `address: string \| null`, `routeOk: boolean \| null`, `dailyCap: number \| null`; `placeholderAddress` is true only while there is no address. |
| `control.ts` | `finishCheck`: open emails = QUEUED, SENDING, UNKNOWN, **UNCONFIRMED** (the campaign stays Running until someone decides). `skipRecipient`: also skips UNCONFIRMED rows (`Skipped by <name> (we couldn't confirm it was sent)`); refuses while an UNKNOWN row exists ("We're still checking with Mailgun whether the email to <who> went out. You can choose Retry or Skip once it's marked 'Not sure it was sent', at most 2 hours after it was sent."). `retryEmail(emailId, actorId, { confirmDuplicateRisk?: boolean })`: refuses a row with `providerId` set ("Mailgun already has this email, so it won't be sent again."); UNCONFIRMED in a LIVE campaign without the flag → `CampaignError("…", "confirm-duplicate")`. `resumeCampaign`/`retryEmail` retake reservations only when `countsAsEmailed`. |
| `queries.ts`, `components/campaigns/format.ts` | `resultsNote`: dry run → "Dry run: delivery results appear only when you simulate them in the dry-run outbox."; TEST → "Test mode: Mailgun reports every email as delivered without delivering it."; LIVE → null. UNKNOWN label "Checking whether it was sent" (§9.4); UNCONFIRMED stays "Not sure it was sent". `canRetry` is false when `providerId` is set. |
| `src/server/sending-state.ts` | `getSendingState()` also returns `activeRealCampaigns` for `sendingLabel` (§4.1.5). |

### 4.4 Mail events, sync and checks (P4)

#### 4.4.1 Webhook endpoints (`src/app/api/webhooks/mailgun/{events,inbound}/route.ts`)

Both: `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` and a one-line `POST` that calls
`handleEventWebhook(request)` / `handleInboundWebhook(request)` from `src/server/services/mail-events/webhook.ts`
(no `server-only`, testable by importing the route like `tests/integration/worker/health.test.ts`). Never `isSameOrigin`.

```ts
export async function handleEventWebhook(request: Request, deps?: { now?: Date }): Promise<Response>;
export async function handleInboundWebhook(request: Request, deps?: { now?: Date }): Promise<Response>;
```

| Step | events | inbound |
|---|---|---|
| 1. Type | not `application/json` → 406, nothing read | not `application/x-www-form-urlencoded` or `multipart/form-data` → 406 |
| 2. Read (capped) | `readBodyCapped(request, 256 KB)` (a copy of the streaming byte cap in `src/app/api/imports/route.ts`, as `src/server/http/read-body.ts`; the imports route is left alone); over the cap → 406 (`too-large`); `JSON.parse`; bad JSON → 406 | `readBodyCapped(request, 10 MB)` (the notify POST carries attachment metadata only, research §13.2) → `new Response(buf, {headers: {"content-type": …}}).formData()` → `lowerKeys`; over the cap or unreadable → 406 |
| 3. Fields | `signature.{timestamp (String()), token, signature}`; any missing → 406 (`unreadable`) | flat `timestamp`, `token`, `signature`; missing → 406 |
| 4. Self-check | (checked before step 1) header `x-outreach-self-check` equal to `tunnel.status.selfCheckNonce` → answered exactly as usual, but no step records anything in `webhooks.stats` | same |
| 5. Key | no `mailgun.webhookSigningKey` → 401 (`webhooks.stats` reason `no-key`) | same |
| 6. HMAC | `verifyMailgunSignature` false → 401 and a throttled log. It is a **counted rejection** only when the body parsed, its domain (`event-data.domain.name` / form `domain`) is a SendingDomain of ours and the timestamp is fresh; counted times go into `webhooks.stats.rejects` (last 10). Owner notice `webhook-rejected` when 3 counted rejections fall within an hour AND no valid webhook arrived since the first of them: "Mailgun's messages to the app are being rejected" / "The webhook signing key saved in the app doesn't match Mailgun's. Click Apply recommended settings in Settings › Domain checklist to fetch it again." Internet scanners never trip it. | same |
| 7. Freshness | `checkTimestamp(…, EVENT_MAX_AGE_MS)` not fresh → 406 | `INBOUND_MAX_AGE_MS` |
| 8. Parse | `normalizeWebhookEventData` null → 406 | `parseInboundForm` null → 406 |
| 9. Store (ONE `dbTx`) | insert `WebhookToken` (exists → duplicate); `applyMailEvent(tx, ev, "WEBHOOK")` | insert token; `storeInbound(tx, parsed, "NOTIFY")` |
| 10. After the transaction | `ensureSentFromEvent(result)` (proof of sending, §4.4.2), for created **and** duplicate results; its failure is logged, never turns the 200 into an error (the event lane repeats it) | — |
| 11. Reply | 200 `{ok:true}` (also for duplicates and ignored types) | 200 |
| DB error | `isRetryableDbError` → 500 `{error:"busy"}`; anything else → 500 and log | same |

Bodies are tiny JSON (`{error:"signature"}` etc.), never details. `webhooks.stats` is written with `updateTyped` (CAS),
at most once a minute except for counted rejections. Over-cap bodies get 406, not 413: Mailgun retries everything but
200 and 406 for 8 hours, and an oversized body won't shrink (B6.11 "unreadable → 406").

#### 4.4.2 Applying events (`apply.ts`, `stops.ts`)

```ts
export type EventScope = "real" | "campaign" | "none";
export type ApplyResult = { status: "created" | "duplicate"; eventId: number; outboundEmailId: number | null; testSendId: number | null; scope: EventScope; stopped: number };
export async function applyMailEvent(tx: Tx, ev: NormalizedEvent, source: EventSource, opts: { now: Date; practiceCopy: boolean; processed?: boolean }): Promise<ApplyResult>;
export async function applyMailEventNow(ev: NormalizedEvent, source: EventSource, opts?: { now?: Date }): Promise<ApplyResult>; // dbTx wrapper + ensureSentFromEvent, reads practice.copy
export async function stopRecipients(tx: Tx, input: { emailNorm: string; reason: "bounced" | "complained" | "unsubscribed"; scope: "real" | "campaign"; recipientId?: number | null; now: Date }): Promise<number>;
/** Proof of sending: when the matched TEST/LIVE row isn't SENT, save its providerId (CAS) and call markSent. Idempotent. */
export async function ensureSentFromEvent(r: Pick<ApplyResult, "outboundEmailId">, ev: Pick<NormalizedEvent, "type" | "occurredAt" | "messageId">): Promise<"sent" | "already" | "not-proof" | "no-row">;
```
1. `MailEvent` with `dedupeKey` exists → `duplicate`: nothing is written, but the result still carries the matched ids
   (steps 2–3 run read-only) so the caller's `ensureSentFromEvent` can repair a crash between an earlier commit and its
   `markSent`, and the Logs twin of a webhook event also proves the send.
2. **Match**, in this order: `OutboundEmail.messageId = ev.messageId`; `OutboundEmail.providerId = ev.messageId`
   (Mailgun rewrote our `h:Message-Id`); `TestSend.messageId` or `TestSend.providerId = ev.messageId`;
   `OutboundEmail.sendId = userVariables.send_id`. When a send's returned id differs from our Message-ID, the loop and
   test sends raise notice `message-id-rewritten` once ("Mailgun changes the app's message IDs" / "Replies and
   follow-ups may not thread as planned. Tell us so we can check it.").
3. **Scope:** OutboundEmail → `real` when `countsAsReal(row.mode, practiceCopy) && !ev.isTestMode`, else `campaign`;
   TestSend with `purpose SELF` → `none` (a test to your own reply inbox must never put that inbox on the do-not-email
   list: Mailgun wouldn't forward replies to it); TestSend `REPLY_TEST` or no match → `real` unless `ev.isTestMode`
   (then `none`).
4. Insert `MailEvent {dedupeKey, type, severity, reason, occurredAt, messageId, recipient, outboundEmailId, testSendId,
   isTestMode, source, raw, stopAppliedAt: now when steps 5–7 changed anything, processedAt}`. `processedAt` is null for
   every type except `other` (so the event lane runs the proof-of-sending step for `accepted` events too, crash-safe),
   and `now` when the caller passes `processed: true` (suppression-list events, §4.4.5).
5. OutboundEmail date (`eventEffect.dateField`): earliest wins (`updateMany where id and (field null or field > occurredAt)`).
6. Stop (`eventEffect.stop`). **The address used is the matched row's `toNorm`** (the event's `recipient` may read
   `[REDACTED]`); an unmatched event whose `recipient` isn't a valid address changes nothing. `campaign` scope, or
   `stopEveryCampaign = false` → only that row's recipient; `real` scope → every recipient with that `emailNorm` in
   SCHEDULED/WAITING/HELD/RECHECK → STOPPED with the code; if already STOPPED with a lower code in `STOP_PRECEDENCE`, the
   code is raised. Their QUEUED rows → SKIPPED (`Stopped: this address bounced` / `… unsubscribed` / `… marked an email
   as spam`). `releaseCompanyIfDone` per (campaign, company).
7. `real` scope and `eventEffect.suppression` set: `Person` (by `emailNorm`, deleted rows included) `personField` earliest
   wins; `Suppression` create `{reason, source: source === "WEBHOOK" ? "webhook" : "mailgun-sync", detail:
   deliveryStatus.message?.slice(0, 300), pushedToMailgunAt: inMailgunList ? now : null}`, or raise its reason by
   `SUPPRESSION_PRECEDENCE` (then `pushedToMailgunAt = inMailgunList ? now : null`). SIMULATED events set `source:
   "simulated"` and `pushedToMailgunAt = null` only in the practice copy (nothing is pushed there). Other permanent
   failures (espblock, generic, old, …) stop and count for health but create no suppression and no person flag.

**Proof of sending** (`ensureSentFromEvent`, P4, called after the transaction by the webhook route, `applyMailEventNow`,
catch-up and the event lane): when `eventEffect(ev).provesAccepted` and the matched row is TEST/LIVE with any status but
SENT, first CAS `providerId` (when null) from the event's Message-ID, then `markSent(emailId, earliest proving event time,
{providerId})` (P4 imports the existing `markSent` from `@/server/services/sending/mark-sent`; it has its own
transaction). DRY_RUN rows are never touched (simulated events only exist for SENT dry-run rows). TestSend rows in
SENDING/UNKNOWN become SENT the same way (`providerId`, `status`).

Applying the same set of events in any order gives the same rows (earliest dates, highest stop/suppression precedence).

#### 4.4.3 Event lane (`process.ts`; loop class `worker/event-lane.ts`)

```ts
export type ProcessResult = { processed: number; problems: { bounces: number; complaints: number } };
export async function processPendingMailEvents(opts?: { now?: Date; limit?: number }): Promise<ProcessResult>; // limit 50, oldest first
export class EventLane {
  constructor(opts: {
    ownsLease: () => Promise<boolean>; logger?: Logger; now?: () => Date;
    onProblems?: (p: ProcessResult["problems"]) => Promise<void>;          // P6 wires runHealthCheck
    processInbound?: (opts: { now: Date; limit: number }) => Promise<number>; // M4; M3 passes nothing
  });
  run(signal: AbortSignal): Promise<void>;  // 1 s sleep when idle, never blocked by jobs
  tick(): Promise<ProcessResult | null>;
}
```
Per event, oldest first:
1. **Proof of sending first:** `ensureSentFromEvent` (outside any transaction; `markSent` has its own).
2. Then one `dbTx`: CAS `processedAt null → now`, then the activity with the row's `mode` and ids: `email.delivered`
   "Delivered to anna@studio.de", `email.bounced` "Bounced: anna@studio.de (<short reason>)", `email.complained`
   "anna@studio.de marked the email as spam", `email.unsubscribed` "anna@studio.de unsubscribed"; temporary failures and
   `accepted` → no activity. Twins (the same event from a webhook and from the Logs): skip the activity when a processed
   event with the same `(type, messageId ?? recipient)` already exists. Real-scope complaint → Owner notification
   `email.complained` ("anna@studio.de marked an email as spam" / "<Campaign> · <step>. They won't be emailed again.",
   link to the company). Unmatched real events log on the person/company found by `emailNorm`, if any.
3. Count real-scope `health` bounce effects and complaints of events matched to an `OutboundEmail` into `problems`;
   after the batch, call `onProblems` when non-zero.
A failure is retried on the next tick; the lane keeps an in-memory count per event id and, at the 5th failure, sets
`processedAt = now` without the activity, logs the error and sends notice `event-failed` ("A Mailgun report couldn't
be processed" / "The app skipped one report from Mailgun after 5 tries. Nothing was sent because of it; details are in
the worker log."), so one bad event can't hold an address for ever (§4.3.4).

#### 4.4.4 Inbound store (`inbound-store.ts`)

```ts
export async function storeInbound(tx: Tx, parsed: ParsedInbound, source: InboundSource): Promise<{ status: "created" | "duplicate"; id: number }>;
```
Duplicate when `storageKey` matches, or (no key) when `messageIdHeader` + `toAddress` match. Creates `InboundMessage
{storageKey, messageIdHeader, receivedAt, toAddress: recipient, senderAddressId (SenderAddress.address = recipient),
fromEmail: normalizeEmail(from) (the raw value when it doesn't parse), fromName, subject (≤ 500), snippet, inReplyTo,
references (space-joined), headers, kind: null, source, processedAt: null}`. Nothing else in M3: no stop (an
out-of-office must not stop anyone, and M3 can't tell them apart yet), and `personId`/`companyId`/`campaignId` stay
null for M4's matching; the send-time guard finds the company through `Person.emailNorm` (§4.3.4).

#### 4.4.5 Catch-up (`src/server/services/mailgun/catch-up.ts`; job `mailgun.catchUp`)

```ts
export async function runCatchUp(opts: { reason: "startup" | "hourly" | "manual"; now?: Date; signal?: AbortSignal; progress?: (d: number, t: number) => Promise<void>; mailgun?: () => Promise<MailgunContextResult> }): Promise<CatchUpSummary>;
/** P6 registers createCatchUpJob({onSuccess: () => evaluateWarmupDays().then(() => runHealthCheck())}) (no wave-2 import). */
export function createCatchUpJob(deps?: { onSuccess?: (summary: CatchUpSummary) => Promise<void> }): JobDefinition;
// label "The Mailgun check", whatToDo "Open Settings › Sending & Mailgun and click Check with Mailgun now.", link "/settings/sending"
```
Writes `mailgun.catchUp` (started / finished / success / error + `lastErrorKind` from the `MailgunError` kind:
`auth`, `network`/`timeout` → network, `server`, else other). For each of `domainsToSync(now)`, yielding
(`setImmediate`) between transactions, which hold at most 20 events or 50 addresses each (B5: ≲ 50 ms):
1. `getSendingQueues`: `regularDisabled` → `pauseSending({kind: "mailgun-queue", reason: "Mailgun stopped accepting emails", fixText: "Mailgun has stopped accepting emails from <d>: <reason>.<until?> Check Mailgun's dashboard, then click Resume.", detail: {until, mailgunMessage}})`.
2. `getTracking` (active domain only): open or click active → pause `mailgun-settings` ("tracking is on in Mailgun" /
   "Open or click tracking was switched on for <d> in Mailgun. Click Apply recommended settings in Settings › Domain
   checklist, then click Resume."); Setup A and unsubscribe inactive → pause `mailgun-settings` ("unsubscribe links are
   off" / "Mailgun's unsubscribe handling is off for <d>, so unsubscribe links wouldn't work. Click Apply recommended
   settings in Settings › Domain checklist, then click Resume."). Notice `tracking-drift` with the same text.
3. Suppressions pull: `walkSuppressions` for bounces, complaints, unsubscribes; each address → a synthetic
   `NormalizedEvent` (`dedupeKey = "sup:<list>:<address>:<createdAt ISO>"`, so an address removed from Mailgun's list and
   added again later is applied again; type failed-permanent (`reason "suppress-bounce"`)/complained/unsubscribed,
   occurredAt = `createdAt ?? now`) through `applyMailEvent(…, "LOGS", {processed: true})`, 50 per transaction. An
   address that already has a local `Suppression` only gets `pushedToMailgunAt = now`: its reason and the person's flags
   stay as they are, because the list entry may be our own push (§4.4.6), and a real unsubscribe or complaint also
   arrives as its own event. These events get no per-address activity or notification (a webhook usually told us already; a newly connected domain may
   list hundreds): one summary activity `mailgun.listsPulled` per pull that changed anything ("Mailgun's lists added 3
addresses to the do-not-email list"), and,
   when the pull created new local COMPLAINED suppressions, one Owner notification `email.complained` ("Mailgun's
   complaint list has 2 new addresses" / "They won't be emailed again. Settings › Deliverability lists them.").
4. Suppressions push: `pushLocalSuppressions()` (§4.4.6), active domain only.
5. Logs: window per §2.4 (`start = max(cursor − 1 h, now − logRetentionDays + 1 h)`, first run `now − logRetentionDays + 1 h`),
   events `[accepted, delivered, failed, complained, unsubscribed]`, filter `domain = d`, ascending; every item →
   `normalizeLogItem` → `applyMailEvent(…, "LOGS")` (20 per tx) → `ensureSentFromEvent` for matched rows. Remember
   `walkStartedAt` and `queryEnd`; complete walk → cursor `max(old cursor, min(queryEnd, walkStartedAt) − 30 min)`; gap
   before the window → `catchup.outage {detectedAt, from: cursor, to: window start, beyondLogRetention: true}`.
   **Duplicate watch:** any `message_id` with 2 or more `accepted` events in the walk → activity `email.duplicate` on
   that email ("Mailgun accepted this email twice") and notice `email-duplicate` ("An email may have gone out twice" /
   "Mailgun accepted the email to anna@studio.de twice. Please tell us: this shouldn't happen."), counted in
   `duplicatesFound`.
6. Stored inbound: `stored` events from `<d>:stored` (overlap 2 h, never older than log retention; same cursor rule).
   For each item whose `storage.key` isn't stored: `getStoredMessage(storage.url[0])` → `parseStoredMessage` →
   `storeInbound(…, "CATCHUP")`; 404 → try `url[1]`, then the API-host form, then `parseStoredLogOnly` (snippet ""),
   and mark `catchup.outage.beyondMessageRetention` when older than message retention.
7. All domains complete → `lastSuccessAt = now`, `recordTaskSuccess("mailgun.catchUp.hourly")`, summary, then
   `deps.onSuccess(summary)` (warm-up evaluation and a health check; its failure is logged, never fails the catch-up).
Failures of one domain don't stop the others (but then there is no `lastSuccessAt`); a Mailgun `auth` error →
`pauseSending(mailgun-auth)`.

**"Hasn't been able to check" notice:** the monitor loop (P4) sends notice `catchup-failing` when Mailgun is connected
and `lastSuccessAt` is older than 3 hours (or null and the last start is older than 3 hours): "The app can't check with
Mailgun" / "The app hasn't been able to check Mailgun since 14:02. Bounces and unsubscribes may be late. Open Settings ›
Sending & Mailgun and click Check with Mailgun now." (link `/settings/sending`).

#### 4.4.6 Suppressions (`src/server/services/mailgun/suppressions.ts`; job `mailgun.syncSuppressions`)

```ts
export async function pushLocalSuppressions(opts?: { now?: Date; mailgun?: () => Promise<MailgunContextResult> }): Promise<{ pushed: number }>;
export async function addManualSuppression(actor: { id: number; name: string }, input: { email: string; reason: "UNSUBSCRIBED" | "MANUAL" }): Promise<{ created: boolean; stopped: number }>;
/** Test-list addresses and active users' reply inboxes only. */
export async function removeOwnSuppression(actor: { id: number; name: string }, email: string): Promise<{ removed: boolean }>;
export const syncSuppressionsJob: JobDefinition;
```
Push (never in the practice copy): every `Suppression` with `pushedToMailgunAt = null`, whatever its source or reason
→ `addUnsubscribes` on the **active** domain with `tags ["*"]` in batches of ≤ 999 → set `pushedToMailgunAt`, so
Mailgun itself refuses anything the app wants never sent (bounced, invalid and "do not email" addresses included).
When the active domain changes, `connectMailgun` sets `pushedToMailgunAt = null` on every row, so the new domain gets
the whole list (§4.5.1); old domains never send again (a domain change is refused while TEST/LIVE campaigns are
active). `addManualSuppression`: Suppression + person flag (unsubscribedAt for UNSUBSCRIBED) + `stopRecipients(real)`
in one tx, activity `suppression.added`, then enqueue `mailgun.syncSuppressions` (dedupe `mailgun:push`).
`removeOwnSuppression`: refuses unless the address is on `sending.testList` or is an active user's reply inbox
("Only your test mailboxes and your team's reply inboxes can be taken off the list."); deletes the local row, clears
that person's flags, calls `deleteSuppression` for all three lists (network after the tx), activity
`suppression.removed`, then enqueues `mailgun.syncRoutes` so the reply-route row turns green again.

`people.ts` `markPersonUnsubscribed` (P4 takes over this one function): in the same transaction also
`stopRecipients({emailNorm, reason: "unsubscribed", scope: "real"})` (QUEUED rows → SKIPPED), and after it enqueue
`mailgun.syncSuppressions` (dedupe `mailgun:push`) except in the practice copy.

#### 4.4.7 Checks: DNS, Mailgun read-back, remote access (`src/server/services/checks/*`, `src/core/dns/checklist.ts`)

```ts
// checks/dns-lookup.ts
export function createDnsLookup(server: "1.1.1.1" | "8.8.8.8", opts?: { timeoutMs?: number; tries?: number }): DnsLookup; // node:dns Resolver, timeout 4000, tries 2
// checks/domain-check.ts
export async function runDomainCheck(opts?: { now?: Date; verify?: boolean; lookups?: [DnsLookup, DnsLookup]; mailgun?: () => Promise<MailgunContextResult>; fetchImpl?: typeof fetch }): Promise<DomainCheckState>;
export const checkDomainJob: JobDefinition; // "mailgun.checkDomain", payload {verify?: boolean}; records "mailgun.domainCheck.6h"
// checks/spf-count.ts, checks/dmarc-walk.ts
export async function countSpfLookups(record: string, lookup: DnsLookup, depth?: number): Promise<{ count: number; complete: boolean }>;
export async function findDmarc(domain: string, lookup: DnsLookup): Promise<{ at: string | null; policy: DmarcPolicy | null; duplicates: boolean; inherited: boolean }>;
// checks/tunnel.ts (and loop class worker/monitor.ts)
export async function checkTunnel(opts?: { now?: Date; fetchImpl?: typeof fetch; ports?: number[] }): Promise<TunnelState>;
export async function checkPublicAddress(opts?: { now?: Date; fetchImpl?: typeof fetch }): Promise<Pick<TunnelState, "publicCheck" | "webhookPathCheck" | "appProtectedCheck" | "selfCheckNonce">>;
export class MonitorLoop { constructor(opts: { ownsLease: () => Promise<boolean>; logger?: Logger; now?: () => Date; fetchImpl?: typeof fetch }); run(signal: AbortSignal): Promise<void>; } // tunnel 5 min, public 30 min, catch-up age 10 min
// core/dns/checklist.ts (pure): one builder per row key, each → ChecklistRow with the §5.3 copy
export function buildChecklistRows(facts: ChecklistFacts): ChecklistRow[];
```
`runDomainCheck` reads (never changes) everything: `getDomain` (and `verifyDomain` when asked and `lastVerifyAt` ≥ 60 s
ago), both resolvers for SPF/DKIM/MX/tracking CNAME/DMARC/postmaster (`google-site-verification=`), `getCertificateStatus`
+ `web_scheme`, `getTracking`, `spam_action`, `message_ttl`, `webhooks_redact_pii`, `getWebhooks` vs the expected URL and
the five types, signing key saved and equal to `getSigningKey()`, SenderAddress route statuses and SendingDomain route ids,
every route's `forwardTo` against the local Suppression table and Mailgun's three lists (`suppressionListsFor`; Mailgun
doesn't forward replies to an address on its lists), `getSendingQueues` + pause kinds, `getMonthlyLimit`, `tunnel.status`
(including `appProtectedCheck`), Setting `mailgun.unsubscribeTest` and `mailgun.domainRegisteredOn`. Writes
`domain.check`. When `getDomain` answers 404 (after the client's one retry 5 s later), it pauses `mailgun-domain`
("Mailgun can't find <d> in the EU region. If you created the domain in the US region, change Region to US."); a send's
404 enqueues this check (§4.3.5). DNS agreement per research: both good → ok; one → warn "Still
spreading. Check again in 30 minutes."; both missing → bad; timeouts → unknown "Couldn't check right now." (never red).
Expected values always come from Mailgun's record lists. Also detects: proxied CNAME (ENODATA but A answers), doubled
names (`email.d.d`), extra MX hosts, US hosts on an EU domain, 2+ SPF or DMARC records, rua on another domain without
authorisation.

Tunnel check: `GET http://127.0.0.1:{20241..20245}/ready` with a 1 s timeout; a port counts only if the JSON has
`connectorId`; 200 with `readyConnections ≥ 4` → connected, 1–3 → degraded, 503 → down, no port → not-running; hourly
`GET /metrics` for `build_info` version: 2026.8.0 / 2026.8.1 → "cloudflared <v> has a known problem. Update it: open
PowerShell as Administrator and run cloudflared update, then net start cloudflared."; older than a year (by the
version's year.month vs 2026.9) → "cloudflared <v> is more than a year old and no longer supported. Update it: …".
Down or not-running for ≥ 15 min while `APP_PUBLIC_URL` is set → Owner notice `tunnel-down` (type `system.tunnel`):
"Remote access is down" / "Remote staff and Mailgun can't reach the app since 14:02. Check that this PC is on and
connected, and that the Cloudflared service is running (status.bat shows it)." Public check (only when `APP_PUBLIC_URL`
set, 10 s timeout, `redirect: "manual"`, no cookies):
- `GET <pub>/api/health` must be JSON with `ok`/`database`;
- `POST <pub>/api/webhooks/mailgun/events` with body `{}` and header `x-outreach-self-check: <nonce>` (a new random
  nonce stored in `tunnel.status.selfCheckNonce` before the request) must be answered by the app (JSON, status 406),
  not a redirect to `*.cloudflareaccess.com` or an HTML page;
- **`appProtectedCheck`**: `GET <pub>/contacts` must answer a redirect whose `Location` host ends with
  `.cloudflareaccess.com` (Cloudflare Access is in front of the app). Anything else (200, a redirect to `/login`) → not
  ok: the "Remote access works" row turns red with "Anyone on the internet can reach your app's sign-in page. In
  Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5)." and it is a go-live blocker. Skipped in fake
  mode (loopback public address).

#### 4.4.8 Simulate (test tools) (`simulate.ts`; outbox UI)

```ts
export async function simulateEmailEvent(actor: { id: number; name: string }, emailId: number, kind: "delivered" | "bounce" | "complaint" | "unsubscribe"): Promise<{ message: string }>;
```
Allowed only for `mode = DRY_RUN` rows with `status = SENT` (any signed-in user). Builds `makeSimulatedEvent`,
`applyMailEventNow(…, "SIMULATED")`. Messages: real data → "Simulated a bounce for anna@studio.de. In a dry run this only
changes this campaign."; practice copy → "Simulated a bounce: anna@studio.de is now marked Bounced and won't be emailed
again." Repeating the same kind for the same email is a no-op ("Already simulated.").

### 4.5 Mailgun setup and sender identity (P5)

#### 4.5.1 Connect (`src/server/services/mailgun/connect.ts`)

```ts
export type ConnectInput = { region: MailgunRegion; domain: string; apiKey?: string | null; sendingKey?: string | null };
export type ConnectResult = { ok: true; message: string; domainState: string | null } | { ok: false; field: "domain" | "apiKey" | "region" | null; error: string; detail: string | null };
export async function testMailgunConnection(input: { region: MailgunRegion; domain: string; apiKey: string }, deps?: { fetchImpl?: typeof fetch }): Promise<ConnectResult>;
export async function connectMailgun(actor: { id: number; name: string }, input: ConnectInput): Promise<ConnectResult>;
export async function forgetMailgunKeys(actor: { id: number; name: string }): Promise<void>;
```
Test: `getDomain` on the chosen region; 401/404 → read-only `getDomain` on the other region; that succeeds → A6's
sentence "Mailgun can't find <d> in the EU region. If you created the domain in the US region, change Region to US."
(regions swapped as needed; field `region`); both 401 → "Mailgun didn't accept this API key. In Mailgun, open API
Security, create a key with the Developer role and paste it here." (field `apiKey`); 404 both → "Mailgun has no domain
called <d> in either region. Check the spelling, or add it in Mailgun first (Send › Domains › Add new domain)." (field
`domain`); network → "Couldn't reach Mailgun. Check this PC's internet connection and try again."; a `key-fake-` key
outside fake mode → "This is a test key. Paste the key from Mailgun › API Security." (field `apiKey`).

Connect (only after a passing test):
- **Domain change refused while it matters:** when `mailgun.domain` is set and differs from the new one, and a TEST/LIVE
  campaign is SCHEDULED, RUNNING or PAUSED → `{ok: false, field: "domain", error: "Finish or cancel <names> first: they
  send from <old domain>."}`.
- Save secrets, settings, upsert `SendingDomain {name, region, active: true}`, mark other domains inactive, move every
  non-retired SenderAddress on an old domain to the same local part on the new domain (old one retired, new one
  `routeStatus "pending"`), fetch and save the signing key (failure is not fatal: row turns red).
- On a domain change also: reset Setting `mailgun.unsubscribeTest` to `DEFAULT_UNSUBSCRIBE_TEST` (the reply test belongs
  to one domain), set `pushedToMailgunAt = null` on every `Suppression` row (the new domain's lists start empty; §4.4.6),
  activity `mailgun.domainChanged` ("Arslan changed the sending domain from a.com to b.com"); warm-up restarts by itself
  (§4.3.8).
- Activity `mailgun.connected`, enqueue `mailgun.checkDomain`, `mailgun.syncSuppressions` and (addresses moved)
  `mailgun.syncRoutes`. An empty `apiKey` keeps the saved key (re-test with it).

`forgetMailgunKeys`: deletes the three secrets, activity `mailgun.keysRemoved` ("Arslan removed the saved Mailgun keys").

#### 4.5.2 Apply recommended settings (`apply-settings.ts`; job `mailgun.applySettings`)

```ts
export async function runApplySettings(opts: { byUserId: number | null; jobId?: number | null; now?: Date; step?: "all" | "certificate-poll"; attempt?: number; mailgun?: () => Promise<MailgunContextResult>; fetchImpl?: typeof fetch }): Promise<MailgunSetupState>;
export const applySettingsJob: JobDefinition; // label "Apply recommended settings", link "/settings/domain"
export function publicAddressProblem(pub: string | null, fakeMode: boolean): string | null;
```
Steps, each recorded as a `SetupStep` (a failing step never stops the next unless it depends on it):

| Key | Call | ok text | failure text |
|---|---|---|---|
| public-address | `publicAddressProblem`, then `GET <pub>/api/health` | "The public address answers: <pub>." | "The public address must start with https://. Run setup.bat again to change it." / "The app's public address doesn't answer yet (<pub>/api/health). Finish the Cloudflare guide, check it on your phone, then try again." (webhooks and routes are skipped) |
| tracking-open / tracking-click | `setOpenTracking(false)`, `setClickTracking(false)` | "Open and click tracking are off." | Mailgun's error via `plainMailgunError` |
| unsubscribe | Setup A: `setUnsubscribeTracking(true, {html:"", text:""})`; B: `(false, …)` | "Mailgun's unsubscribe handling is on, with its own footers blank." | "Mailgun kept its own unsubscribe footer. In Mailgun: Domain settings › Tracking › Unsubscribes, clear both footers, then apply again." (read-back not blank; the guide's step 11 has the click path) |
| spam-filter | `updateDomain({spam_action: "tag"})` | "Suspicious replies are marked, never deleted." | … |
| retention | `updateDomain({message_ttl: messageRetentionDays × 86400})` | "Mailgun keeps stored replies for 1 day." | 400 → "Your Mailgun plan keeps stored replies for less time. Set 'stored replies' in Settings › Sending & Mailgun to what your plan allows." |
| pii | `updateDomain({webhooks_redact_pii: false})` only when true | — | — |
| certificate | tracking CNAME valid? → `startCertificate(host)`; 202/409 → state processing, enqueue job `mailgun.applySettings {step:"certificate-poll", attempt:1}` (dedupe `mailgun:cert-poll`, runAt +60 s) | "Mailgun is preparing the certificate for secure unsubscribe links." / active: "Unsubscribe links use https." | 400 → "Mailgun can't check email.<d> yet. Fix the 'Unsubscribe links work' row first." 402 → "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do." |
| https | when certificate active and `web_scheme ≠ https`: `updateDomain({web_scheme: "https"})` | "Unsubscribe links use https." | … |
| signing-key | `getSigningKey()` → save when different | "Webhook signing key saved." | 400 → "Mailgun hasn't made a webhook signing key for your account yet. In Mailgun, open API Security and create the HTTP webhook signing key, then click Apply recommended settings again." |
| webhooks | `registerWebhooks()` §4.5.3 | "Mailgun tells the app about deliveries, bounces, complaints and unsubscribes." | "Mailgun can't find <host> yet. Finish the Cloudflare guide so the public address works, then try again." (host not found) |
| routes | `syncRoutes()` §4.5.4 | "Reply routes are set up for <n> senders, plus a catch-all." | per route |

Certificate poll step: `getCertificateStatus` every 60 s (new job each time, `attempt + 1`, up to 30); active → PUT
`web_scheme=https`, read back tracking, notify the Owner (type `system.mailgun`, "Secure unsubscribe links are ready");
expired → `regenerateCertificate`; still processing at 30 → state "Mailgun is still preparing the certificate. Check again
later." Finally enqueue `mailgun.checkDomain`.

The public-address step's `GET <pub>/api/health` uses `opts.fetchImpl` (default global `fetch`, `redirect: "manual"`),
so the end-to-end test can answer it from the health route handler in-process (§8 P6).

#### 4.5.3 Webhook registration (`webhooks-setup.ts`)

```ts
export const WEBHOOK_TYPES: readonly WebhookType[] = ["delivered", "permanent_fail", "temporary_fail", "complained", "unsubscribed"];
export async function registerWebhooks(ctx: MailgunContext, url: string): Promise<{ ok: boolean; text: string }>;
```
Research §4.5: `getWebhooks` (v3) → types that list our URL; none → `createWebhook`; a different set → `updateWebhook`;
POST 400 "already exists" → PUT; PUT 404 → POST; then `getWebhooks` again and compare. Old URLs of ours (same path, other
host) are removed with `deleteWebhook`.

#### 4.5.4 Reply routes (`src/core/mailgun/routes.ts`, `src/server/services/mailgun/routes.ts`; job `mailgun.syncRoutes`)

```ts
// core
export const ROUTE_DESC_PREFIX = "outreach-app:";
export type RouteSpec = { priority: number; description: string; expression: string; actions: string[] };
export function escapeRouteRegex(s: string): string;                        // escapes \ ^ $ . | ? * + ( ) [ ] { }
export function senderRouteSpec(i: { senderAddressId: number; address: string; forwardTo: string; notifyUrl: string }): RouteSpec;
export function catchAllRouteSpec(i: { domain: string; forwardTo: string; notifyUrl: string }): RouteSpec;
export function dmarcRouteSpec(i: { domain: string; forwardTo: string }): RouteSpec;
export function parseRouteDescription(d: string): { kind: "sender"; senderAddressId: number } | { kind: "catchall" | "dmarc"; domain: string } | null;
export function sameRoute(route: RouteSpec, spec: RouteSpec): boolean;     // priority, expression, actions exact
/** parseEmail ok, no quotes, brackets, commas or spaces, and not on (or under) any of `sendingDomains`: a reply inbox on a
 *  sending domain would make forward() hand the reply back to Mailgun, which forwards it again (a mail loop). */
export function isSafeForwardAddress(email: string, sendingDomains: readonly string[]): boolean;
export function routeCheckAddress(domain: string, random: string): string; // "pp-route-check-<hex>@<domain>"
// server
export async function syncRoutes(opts?: { now?: Date; mailgun?: () => Promise<MailgunContextResult> }): Promise<{ ok: boolean; created: number; updated: number; deleted: number; problems: string[] }>;
export const syncRoutesJob: JobDefinition;
```
Specs: sender — priority 10, `outreach-app:sender:<senderAddressId>`, `match_recipient("^ali@send\.example\.com$")`,
actions `forward("<inbox>")`, `store(notify="<pub>/api/webhooks/mailgun/inbound")`, `stop()`. Inbox = the user's
`replyInbox ?? email` when active, the Owner's when switched off (B6.10). Retired addresses keep their routes. Catch-all —
priority 100, `outreach-app:catchall:<domain>`, `match_recipient("^.*@send\.example\.com$")`, same actions to the Owner's
inbox. DMARC — priority 50, `outreach-app:dmarc:<domain>`, `match_recipient("^dmarc@send\.example\.com$")`,
`forward("<owner inbox>")`, `stop()` (no store). Sync: list all routes; ours by description; create missing, PUT changed
(all fields), delete ours with no matching address; write `mailgunRouteId`, `forwardTo`, `routeCheckedAt`, `routeError`
and the domain's route ids. Verify with `matchRoute`: each sender address → its route id; a random `pp-route-check-…`
address → the catch-all id; `dmarc@` → the DMARC id.

`routeStatus` rules (LIVE sending waits on anything but `ok`, §4.3.2, so a sync must not make a working route look
broken): an address whose route already was `ok` **stays `ok` while the sync runs**; `mismatch` is written only after a
verified `/match` answer names another route ("Another Mailgun route catches <address> first. In Mailgun, open
Receiving › Routes and delete routes you don't recognise for this domain."); `error` only after a definite failure
(a 4xx, or 5xx on 3 syncs in a row) with Mailgun's text; a new address starts `pending` and becomes `ok` after its
verified match. A `forwardTo` that isn't `isSafeForwardAddress` → `error` "Replies to <address> would loop: its reply
inbox is on the sending domain. Change the reply inbox in Settings › My profile." and no route is created. A
`forwardTo` found by `suppressionListsFor` (P2, §4.2.4; local list or any of Mailgun's three) → `error` "Mailgun won't
forward replies to <inbox>: it's on Mailgun's <list> list." plus notice `reply-inbox-suppressed`; the "Replies reach
each sender" row shows it with the Owner button "Remove it" (a link to Settings › Deliverability, where
`removeOwnSuppression` runs). Requires a public address (same guard as Apply).

#### 4.5.5 Test sends (`src/server/services/test-send.ts`; job `send.testEmail` for reply tests)

```ts
export const TEST_SENDS_PER_DAY = 20;
export async function sendMeATest(actor: { id: number; name: string }, input: { campaignId: number; recipientId: number; step: number }): Promise<{ status: "sent" | "preview"; message: string; preview?: RenderedEmail }>;
export async function sendReplyTestEmails(ownerId: number, opts: { jobId: number; now?: Date }): Promise<{ sent: number; failed: number; skipped: string[] }>;
export function replyTestMessageId(jobId: number, address: string, domain: string): string; // `pp.t.${jobId}.${sha1(address).slice(0, 12)}@${domain}`
export const sendTestEmailJob: JobDefinition; // payload {purpose: "REPLY_TEST", userId}; enqueued with dedupe "send:reply-test", maxAttempts 1
```
`sendMeATest` (runs in the web process; one Mailgun call, ≤ 30 s): renders the chosen recipient's email with the draft's
sender. Setting `sending.mode = DRY_RUN` → `status "preview"`: "In dry run nothing leaves this PC, so here is the email
as it would arrive. To get it in your inbox, set sending to Test mode or Live in Settings › Sending & Mailgun." Otherwise
refusals, in order: practice copy; not connected; paused ("Sending is paused (<reason>). Tests go out again once it's
resumed."); the campaign's sender has no address; the user's reply inbox missing or suppressed ("Your reply inbox
(<email>) is on the do-not-email list (<reason>), so tests can't be sent to it."); a test of this user still SENDING
from the last 2 minutes ("Your last test is still on its way. Wait a moment before sending another."); then **inside
one `dbWrite`** that also inserts the row: 20 tests today ("You've sent 20 tests today, the daily maximum. You can send
more tomorrow."); today's limit reached ("Today's limit of 50 emails is reached, and tests count toward it. Try again
tomorrow, or change today's limit in Settings › Limits & warm-up."). The row: `TestSend {purpose: "SELF", status:
SENDING, messageId: newMessageId(domain) with prefix "pp.t.", mode}`, so a double click can't pass the limit or send
twice. Then the POST (`purpose "self-test"`, `guard` with `ownInbox` = the user's reply inbox, `tags ["outreach-test"]`,
`variables {test_send_id}`, never test mode, to = the user's reply inbox), then SENT (message "Test sent to
anna@gmail.com. It should arrive within a minute."), FAILED (plain error; auth → `pauseSending`), or UNKNOWN ("Mailgun
didn't answer in time, so the test may or may not arrive.") on ambiguous. TestSend rows left SENDING for more than 2
minutes are marked UNKNOWN by the reply-test page load (cheap update); a later proof of sending (§4.4.2) turns them SENT.
Events of these tests have scope `none` (§4.4.2).

`sendReplyTestEmails` (job `send.testEmail`): refuses with the list from `replyTestBlockers` (§1.5 step 0); From the
Owner's address to each test-list address (≤ 10), purpose `REPLY_TEST` (`guard` = the test list), subject/body per
§1.5. Each mailbox's Message-ID is `replyTestMessageId(jobId, address, domain)`: before sending, an existing TestSend
with that `messageId` and status ≠ FAILED means "already sent in this run" and the mailbox is skipped, so a rerun of
the job after a crash never sends a mailbox twice. The action enqueues with dedupe `send:reply-test` (a double click
queues one job) and `maxAttempts 1`. Nothing is written to Setting `mailgun.unsubscribeTest` (the facts come from rows).

#### 4.5.6 Reply test (`src/core/reply-test.ts`, `src/server/services/reply-test.ts`)

```ts
// core
export function providerOf(address: string): ReplyTestProvider;   // gmail.com/googlemail.com; outlook.*, hotmail.*, live.*, msn.com; yahoo.*, ymail.com
export type MailboxFacts = { testSendId: number | null; sentAt: Date | null; delivered: boolean; replyStored: boolean };
export type ReplyTestVerdict = { status: "passed" | "failed" | "incomplete"; missing: string[] }; // missing = plain sentences
export function evaluateReplyTest(setting: UnsubscribeTestSetting, facts: ReadonlyMap<string, MailboxFacts>, unsubscribeSeen: boolean): ReplyTestVerdict;
/** Reads Authentication-Results / ARC-Authentication-Results from pasted headers: any dkim=pass or arc=pass → "pass";
 *  a dkim=fail/arc=fail with no pass → "fail"; neither → null. Unfolds continuation lines; case-insensitive. */
export function parseAuthResults(headersText: string): "pass" | "fail" | null;
// server
export async function loadReplyTest(now?: Date): Promise<{ setting: UnsubscribeTestSetting; currentDomain: string | null; facts: Map<string, MailboxFacts>; unsubscribeSeen: boolean; verdict: ReplyTestVerdict; blockers: string[]; ownerAddress: string | null; testList: string[] }>;
export async function saveReplyTestAnswers(actor, input: { mailboxes: Array<{ address: string; inboxOk: boolean | null; authOk: "pass" | "fail" | "unsure" | null; pastedHeaders?: string | null }>; headersOk: boolean | null }): Promise<{ authFromHeaders: Record<string, "pass" | "fail" | null> }>;
export async function decideReplyTest(actor): Promise<ReplyTestVerdict>;  // writes status passed/failed and domain = current domain (never from "incomplete")
export async function switchUnsubscribeSetup(actor, setup: "A" | "B"): Promise<void>; // resets answers and status, enqueues applySettings
```
Facts (current domain only: TestSend rows whose `messageId` ends with `@<mailgun.domain>`): per mailbox, the latest
`REPLY_TEST` TestSend (`testSendId`, `sentAt`); delivered = a `MailEvent` `type delivered` with that `testSendId`;
replyStored = an `InboundMessage` with `fromEmail = address`, `toAddress` = the Owner's sender address, `receivedAt ≥
sentAt`; unsubscribeSeen = an `unsubscribed` MailEvent for any test-list address after the earliest `sentAt`. A stored
`status` counts only while `setting.domain` equals the current domain (else the page shows "Not tested yet").
`saveReplyTestAnswers` runs `parseAuthResults` on each non-empty `pastedHeaders`, sets `authOk` (and
`authFromHeaders: true`) from a non-null result, and never stores the pasted text.

#### 4.5.7 Sender addresses and mode gates (`src/core/sender-address.ts`, `src/server/services/sender-addresses.ts`, `src/core/sending/mode-gates.ts`)

`src/core/sending/mode-gates.ts` (the four `…Blockers` functions and their texts) is built by **P1 in wave 1**, because
P3 (launch, wizard) and P5 (pages, reply test) both call it and may not import each other.

```ts
// core
export const RESERVED_LOCAL_PARTS: ReadonlySet<string>; // postmaster abuse admin administrator hostmaster webmaster root mailer-daemon noreply no-reply dmarc bounce bounces unsubscribe u mail email info support sales hello contact pp-route-check
export function validateLocalPart(input: string): { ok: true; localPart: string } | { ok: false; error: string };
export function suggestedLocalPart(name: string, loginEmail: string): string;
export function liveModeBlockers(rows: ChecklistRow[], ctx: { connected: boolean; practiceCopy: boolean; testListSize: number }): string[];
/** liveModeBlockers + Setup A + the reply test passed on the current domain: what a LIVE launch needs (P3 calls it). */
export function liveLaunchBlockers(rows: ChecklistRow[], ctx: { connected: boolean; practiceCopy: boolean; testListSize: number; setup: UnsubscribeSetup; replyTestPassedOnDomain: boolean }): string[];
export function testModeBlockers(ctx: { connected: boolean; practiceCopy: boolean }): string[];
/** §1.5 step 0: what the reply test needs before its emails may go out. */
export function replyTestBlockers(rows: ChecklistRow[], ctx: { mode: "DRY_RUN" | "TEST" | "LIVE"; connected: boolean; practiceCopy: boolean; testListSize: number; ownerRouteOk: boolean; publicAddressOk: boolean; setup: UnsubscribeSetup }): string[];
export function goLiveBlockers(rows: ChecklistRow[], ctx: { replyTestPassed: boolean; paused: boolean; practiceCopy: boolean; sendersWithoutRoute: string[] }): string[];
// server
export type SenderAddressInfo = { address: string | null; localPart: string | null; domain: string | null; routeStatus: string | null; routeCheckedAt: Date | null; routeError: string | null; blockedBy: string[] };
export async function getSenderAddressInfo(userId: number): Promise<SenderAddressInfo>;
export async function setSenderLocalPart(actor: { id: number; name: string; role: "OWNER" | "MEMBER" }, userId: number, input: string): Promise<{ changed: boolean; address: string }>;
```
`validateLocalPart`: trimmed, lowercased, `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`, no `..`; reserved →
"<x> is kept for mail servers and can't be a sender address. Pick another name, for example your first name."; empty →
"Choose the name before the @, for example ali."; invalid → "Use letters, numbers, dots, dashes or underscores, starting
and ending with a letter or number." `setSenderLocalPart`: no active domain → "Your sending address is set up once the
Owner connects the sending domain in Settings › Sending & Mailgun."; TEST/LIVE campaigns with this sender in
SCHEDULED/RUNNING/PAUSED → "You can't change your sending address while your campaigns are running or paused (<names>).
Wait until they finish, or ask the Owner to cancel them."; taken by another user (active or retired) → "Someone else
already uses <addr>. Pick another name."; own retired address → reactivated. One tx: retire the current, create/reactivate,
activity `user.senderAddress`, Owner notification when a Member changed it ("<Name> changed their sending address" /
"From now on <Name>'s campaigns come from <addr>."). Then enqueue `mailgun.syncRoutes` (dedupe `mailgun:routes`). Also:
`users.updateProfile` refuses a reply inbox on (or under) any SendingDomain ("Your reply inbox can't be on the sending
domain <d>: replies would go round in circles. Use your normal mailbox, such as Gmail or Outlook.com.") and enqueues
`mailgun.syncRoutes` when `replyInbox` changed; `users.deactivateUser` and `reactivateUser` enqueue it too (repoint).

Mode gate texts: TEST — "Connect Mailgun first."; LIVE — "Connect Mailgun first.", "Mailgun hasn't confirmed your DNS
records yet (Domain checklist).", "Open and click tracking must be off (Domain checklist › Apply recommended settings).",
"Mailgun's unsubscribe handling must be on (Domain checklist › Apply recommended settings).", "Mailgun must be told
where to send bounces and unsubscribes (Domain checklist › Apply recommended settings).", "The webhook signing key isn't
saved yet (Domain checklist › Apply recommended settings).", "Mailgun isn't accepting emails from your domain right now
(Domain checklist).", "The practice copy never sends real email."; plus the non-blocking warning "Your test list is empty,
so nothing can be sent yet." A row counts as missing only when its status is `bad` or it has never been checked; `warn`
and `unknown` never block. LIVE launch (`liveLaunchBlockers`) adds: setup not A → "Live campaigns need Setup A
(Mailgun's unsubscribe handling). Settings › Domain checklist › Reply test."; the pass missing → "Live campaigns start
once the reply test has passed (Settings › Domain checklist › Reply test)."; an empty test list → "Your test list is
empty, so a live campaign can't reach anyone yet." (blocking here). The reply test (`replyTestBlockers`) needs: mode TEST
or LIVE ("Set sending to Test mode or Live first: the test emails go through Mailgun."), every `liveModeBlockers` item,
"Your reply route isn't working yet. Click Apply recommended settings.", "Remote access doesn't work yet. Finish the
Cloudflare guide.", "Add your test mailboxes first in Settings › Sending & Mailgun.". Go-live adds every ok-required row
(`mailgun-domain spf dkim mx tracking-cname https-links dmarc tracking-off unsubscribe spam-filter retention
signing-key webhooks reply-routes sending-allowed remote-access`, the last including Access in front of the app),
"The reply test hasn't passed yet.", "Sending is paused.", and "<names> have no working reply route."

### 4.6 Worker wiring (P6)

`worker/main.ts`:
- `WorkerOptions` gains `transportFor?`, `mailgun?`, `now?` (tests), and the constructor builds `SendingLoop({ownsLease,
  logger, startedAt, transportFor?})`, `EventLane({ownsLease, logger, onProblems: () => runHealthCheck().then(() => undefined)})`,
  `ReconcilerLoop({ownsLease, logger, inFlight: sendingLoop.inFlight})`, `MonitorLoop({ownsLease, logger})`.
- `startup()` order: `checkMigrations` → `resetOrphanedJobs` → `resetInterruptedDryRunSends` → `runOneOffRepairs`
  (adds `m3.oldRestoreMarker`: a `RESTORED` marker **without a `version` field** that exists at the first M3 start is
  renamed `RESTORED.pre-m3` and logged, because M1/M2 restores never paused anything; a versioned marker is never
  touched, so restoring a pre-M3 backup, whose database says the repair hasn't run, still pauses) →
  `checkDatabaseInstance({markerSeen})` → `handleRestoreMarker()` → log `describeMailgunTarget()` → when Mailgun is
  connected, enqueue `mailgun.catchUp {reason: "startup"}` (dedupe `mailgun:catchup`, priority 50) →
  `runHealthCheck()` → `runPeriodicCheck()`. Warm-up days are evaluated after the catch-up succeeds (§4.3.8), not here;
  gated sending waits for it through the catch-up gate (§4.3.2).
- `holdLease()` `Promise.all` adds `eventLane.run`, `reconciler.run`, `monitor.run`. `runOnce()` adds one tick of each.
- `shutdown()` also waits for the event lane (≤ 3 s total, unchanged budget). A Mailgun POST in flight is never aborted
  (§4.2.3); if the process exits first, its row stays SENDING for the reconciler.

`worker/jobs/index.ts` registers: `mailgun.catchUp` as `createCatchUpJob({onSuccess: async () => { await
evaluateWarmupDays(); await runHealthCheck(); }})`, `mailgun.syncSuppressions`, `mailgun.checkDomain` (P4),
`mailgun.applySettings`, `mailgun.syncRoutes`, `send.testEmail` (P5), `mailgun.restoreScan`, `warmup.evaluate` (P3).
`campaign.finishCheck` stays unregistered (unused).

`worker/periodic.ts` adds:

| Task name | Interval | Retry after | Enqueues |
|---|---|---|---|
| `mailgun.catchUp.hourly` | 1 h | 20 min | `mailgun.catchUp {reason: "hourly"}`, dedupe `mailgun:catchup`, priority 50 (skipped while not connected) |
| `mailgun.domainCheck.6h` | 6 h | 1 h | `mailgun.checkDomain {}`, dedupe `mailgun:domain-check`, priority 20 |
| `warmup.hourly` | 1 h | 20 min | `warmup.evaluate`, dedupe `warmup`, priority 20 |

Job priorities (runner picks higher first): `send.testEmail` 60, `mailgun.catchUp` 50, `mailgun.restoreScan` 40,
`mailgun.applySettings`/`syncRoutes` 30, `checkDomain`/`warmup.evaluate` 20, `syncSuppressions` 10, others 0.
Long jobs (catch-up, restore scan) call `ctx.progress` and check `ctx.signal` between pages.

### 4.7 Notifications and activity types (added to the doc lists in `activity.ts` / `notifications.ts` by P6)

| Notification type | To | Title / body (first sentence) | Link | Throttle |
|---|---|---|---|---|
| `sending.paused` | Owner | `Sending paused: <reason>` / fixText | /settings/sending | once per pause |
| `sending.warning` | Owner | §4.1.4 | /settings/deliverability | once per baseline per rule |
| `sending.capReached` | Owner | `Today's limit of 50 emails is reached` | /settings/limits | once per cap day |
| `email.complained` | Owner | `anna@studio.de marked an email as spam`; after a list pull: `Mailgun's complaint list has 2 new addresses` | company / /settings/deliverability | every complaint; one per pull |
| `email.unconfirmed` | sender + Owner | `1 email needs your decision` / "We can't tell whether the first email to anna@studio.de went out. Open the campaign and choose Retry or Skip." | campaign | per row |
| `restore.checked` | Owner | `Restore check finished` | /settings/sending | once (after the second pass) |
| `system.mailgun` | Owner | auth, not allowed, queue, tracking drift, webhook rejected, catch-up failing, certificate ready/expired, options too large, Mailgun unreachable, sent-not-recorded, message-id rewritten, email duplicate, event failed | /settings/domain or /settings/sending | `notices` 24 h per key |
| `system.replyRoute` | Owner | `Live emails are waiting: a reply route isn't working`; `Mailgun won't forward replies to <inbox>` | /settings/domain | `notices` 24 h per key (`reply-route-down`, `reply-inbox-suppressed`) |
| `system.tunnel` | Owner | `Remote access is down` | /settings/system | `notices` 24 h |
| `user.senderAddress` | Owner | `<Name> changed their sending address` | /settings/team | each change by a Member |

Activity types: `sending.paused`, `sending.resumed`, `sending.warmup`, `sending.capOverride`, `sending.modeChanged`,
`sending.testList`, `mailgun.connected`, `mailgun.domainChanged`, `mailgun.keysRemoved`, `mailgun.settingsApplied`,
`mailgun.routesSynced`, `mailgun.listsPulled`, `suppression.added`, `suppression.removed`, `test.sent`,
`replyTest.decided`, `restore.checked`, `email.duplicate`, plus the existing `email.delivered/bounced/complained/
unsubscribed/failed`, `user.senderAddress`, `settings.updated`.

---

## 5. Screens

Every page calls `requireUser()`/`requireOwner()` first; every action `requireUserAction()`/`requireOwnerAction()` inside
`runAction()`. One orange (primary) button per screen; everything else outline/ghost/destructive. Dates in `user.timeZone`.

### 5.1 Settings navigation (P5)

Owner group, in this order: **Sending & Mailgun** (`/settings/sending`), **Domain checklist** (`/settings/domain`),
**Limits & warm-up** (`/settings/limits`), **Deliverability** (`/settings/deliverability`), **Email footer**
(`/settings/footer`), Team, System. Icons from lucide (`Send`, `ListChecks`, `Gauge`, `ShieldCheck`, `PanelBottom`).

### 5.2 Settings › Sending & Mailgun (`/settings/sending`, Owner; P5)

| Section | Content and copy |
|---|---|
| Fake-mode banner (fake mode only) | "Test server: Mailgun calls go to http://127.0.0.1:4010 (OUTREACH_MAILGUN_BASE_URL). Nothing reaches the real Mailgun." |
| Pause card (when paused) | Red notice: "Sending is paused: <reason>." + fixText + "Paused <time ago> by <name or the app>." + "Details" (Mailgun's message, `also` list with their numbers). Health kinds link to Settings › Deliverability's "Bounces counted now" / "Complaints counted now". Restore kind: the restore report ("Checked Mailgun for sends after the backup (20 Sep 14:00 → now): 3 confirmed as sent, 1 found that the backup didn't know about, 0 marked 'Not sure it was sent'."; while running: "Checking Mailgun for emails sent after the backup. This finishes about 35 minutes after the restore."). **Primary: "Resume sending"** → dialog: health (main or `also`): "7 of the last 200 emails bounced. Resuming starts a fresh count: only new bounces count toward the limit." [Resume sending]; restore check still running: "The restore check is still running. Resume now and dry runs continue; emails through Mailgun wait until the check has finished. If the check fails, sending pauses again and asks you to confirm." [Resume sending]; restore check failed or Mailgun wasn't checked: "The app couldn't check Mailgun for emails sent after the backup." + required checkbox "I understand that emails sent after 20 Sep 14:00 may go out a second time." [Resume sending]; copied database: "Resume only if you moved the app on purpose. A copy of the real database would send the same emails again." [Resume sending]; other: "Resume sending? If the problem is still there, sending pauses again." |
| Mailgun connection | Status: "Connected to send.example.com (EU) · key ending …1a2b · checked 2 minutes ago" or "Not connected yet." Fields: Region (EU / US radios, hint "The region you chose when you added the domain in Mailgun. It can't be changed there later."), Sending domain, API key (password field; hint "A key with the Developer role, from Mailgun › API Security. Stored encrypted and never shown again. Leave empty to keep the saved key."), Advanced (collapsed): Domain sending key (optional), "Your Mailgun plan keeps event logs for [5] days and stored replies for [1] day." Button "Save and connect" (primary when not connected and not paused), "Remove saved keys" (ghost, confirm). A domain change while TEST/LIVE campaigns are active shows the refusal from §4.5.1. |
| Check with Mailgun (when connected) | "Last checked with Mailgun at 14:02: 3 updates, 1 new unsubscribe." (from `mailgun.catchUp.lastSummary`) or "Not checked with Mailgun yet since the app started." / failing: "The app hasn't been able to check Mailgun since 14:02. Bounces and unsubscribes may be late." + Details (`lastError`). Button "Check with Mailgun now" (outline, `checkWithMailgunAction` → enqueue `mailgun.catchUp {reason: "manual"}`, dedupe `mailgun:catchup`). When `catchup.outage.detectedAt` is set and not handled: amber "The PC was off for more than 5 days, so the app can't be sure it saw every reply." (A4.3). |
| Sending mode | Radios Dry run / Test mode / Live (test list only) with the texts: Dry run "Nothing leaves this PC. Campaigns fill the dry-run outbox so you can read every email."; Test mode "Emails go to Mailgun's test mode: accepted, never delivered, and billed like normal emails. Use it only to check the connection."; Live "Real emails from your sending domain, inside sending hours and under the daily limit, but only to the addresses on your test list until you go live. Live campaigns start once the reply test has passed." Unavailable options show their blockers (§4.5.7). "Save mode" (outline). Live confirmation: "Real emails will go to your test-list addresses only: a@…, b@…, and to your own reply inbox when you click Send me a test. Everyone else is left out until you go live (Milestone 6). Switch to live?" [Switch to live]. Switching away while TEST/LIVE campaigns are active shows the warning of §2.1 in the dialog. Note under the card: "New campaigns use this mode. Each campaign keeps the mode it was launched with." |
| Test list | Empty: "No test addresses yet. Add two or three mailboxes that aren't your reply inbox, ideally one Gmail and one Outlook.com." [Add address]. List with Remove (ghost); count "3 of 10". Hint: "Until you go live, real email only reaches these addresses, and your own reply inbox when you click Send me a test. They count as checked, so test campaigns can run before address checks arrive. Emails to them don't count as 'emailed', so you can test again at any time." |
| Go live | Disabled switch "Go live" + "Arrives in Milestone 6. Until then, real email only reaches your test list." + "Before going live:" blocker list (`goLiveBlockers`). |
| Pause all sending (when not paused) | "Stops every campaign at once, including dry runs, until you resume." Button "Pause all sending" (destructive outline) → dialog "Pause all sending? Nothing is sent, not even to the dry-run outbox, until you click Resume. Campaigns stay as they are." field "Why (optional)" [Pause all sending]. |
| For Mailgun | Read-only copy fields: webhook URL, inbound URL (or "Set the public address first: run setup.bat again after the Cloudflare guide."). Link "Open the dry-run outbox". |

Actions (`src/app/(app)/settings/sending/actions.ts`, all `requireOwnerAction`): `connectMailgunAction`,
`forgetMailgunKeysAction`, `setSendingModeAction`, `saveTestListAction`, `pauseAllAction`,
`resumeSendingAction({confirmRestoreRisk?})`, `saveRetentionAction`, `checkWithMailgunAction`; the M2
`switchToDryRunAction` stays exported.

### 5.3 Settings › Domain checklist (`/settings/domain`, Owner; P5 renders, P4 computes rows)

Header: "Domain checklist for send.example.com (EU) · checked 5 minutes ago". **Primary: "Apply recommended settings"**
(explains in a hint: "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank
footers, marks spam instead of deleting it, keeps stored replies for your plan's time, sets up secure unsubscribe links,
the webhooks and the reply routes."). "Check again" (outline; disabled for 60 s after use: "Checked just now. Check again
in a minute."). A running Apply job shows its steps live (poll `/api/jobs/:id` every 2 s).

Not connected: "Connect Mailgun first. Open Sending & Mailgun, choose the region and paste your API key." [Open Sending & Mailgun].

Row statuses: ok green check "Done", warn amber, bad red, unknown grey "Couldn't check right now.", info grey. Each row:
title, text, fix (when not ok), record boxes (Type · Name · Value · Priority, each with Copy), "Details" (what resolvers
saw, Mailgun's error). Groups and row copy (fix texts from `deliverability-dns.md` "Checklist rows"):

| Group | Row (title) | ok text |
|---|---|---|
| Mailgun | Mailgun knows your domain | "Mailgun has your domain (EU) and has confirmed your records." |
| DNS records | Mailgun may send for d (SPF) | "Mailgun is allowed to send email for d." |
| | Your emails are signed (DKIM) | "Your emails carry d's digital signature (2048-bit)." |
| | Replies reach the app (MX) | "Replies to d go to Mailgun, which passes them to the app and your inbox." |
| | Unsubscribe links work (tracking CNAME) | "Unsubscribe links on email.d work." |
| | Unsubscribe links are secure (HTTPS) | "Unsubscribe links use https, as Gmail and Yahoo require." |
| | Mail servers know your policy (DMARC) | "Policy found: monitor only. Right for now." |
| Mailgun settings | Open and click tracking are off | "Mailgun doesn't add tracking pixels or change your links." |
| | Unsubscribe handling is on | "Mailgun fills in each email's unsubscribe link and adds the one-click unsubscribe header." (Setup B: info "Unsubscribe handling is off on purpose while you check Setup B.") |
| | Spam filter marks, never deletes | "Suspicious replies are marked, never thrown away." |
| | Stored replies are kept | "Mailgun keeps each reply for 1 day, so the app can fetch it after the PC was off." |
| | Webhook signing key saved | "The app can check that messages really come from Mailgun." |
| | Mailgun tells the app what happened | "Deliveries, bounces, temporary failures, complaints and unsubscribes go to <url>." |
| | Replies reach each sender | "3 reply routes (Arslan, Ali, Sara), plus a catch-all for unknown addresses." Each sender's line expands to the route's exact values with a Copy button each (for the guide's manual fallback): Expression `match_recipient("^ali@send\.example\.com$")`, Actions `forward("ali.khan@gmail.com")`, `store(notify="https://outreach.example.com/api/webhooks/mailgun/inbound")`, `stop()`, Priority 10, Description `outreach-app:sender:12`. bad variants: "Mailgun won't forward replies to <inbox>: it's on Mailgun's <list> list." + Owner button "Remove it" (outline); the loop text of §4.5.4; the mismatch text. |
| | Mailgun lets you send | "Mailgun accepts emails from d." |
| | Monthly safety limit | "Mailgun stops everything after 30,000 emails this month (1,234 used)." warn: "No monthly safety limit set in Mailgun. In Mailgun, set a custom monthly message limit of about 30,000 (see the Mailgun guide, step 9)." |
| Connection | Remote access works | "Cloudflare reaches this PC, only your team gets past the login, and Mailgun's messages get through without a login page." bad variants: "The webhook address shows Cloudflare's login page. In Cloudflare, check that the 'Outreach public endpoints' app covers api/webhooks/* (Cloudflare guide, step 6)."; "Anyone on the internet can reach your app's sign-in page. In Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5)." |
| | Reply test | passed (on this domain): "Setup A passed on 24 Sep: replies arrive in your inbox, and unsubscribe links work." untested (warn): "Not tested yet. Live campaigns start once this passes." |
| Optional | Gmail dashboard | per research row 8 |
| | Domain age | "d is N days old." amber: "d is N days old. Wait until it's 30 days old before real campaigns, then start slowly." + date field "When did you buy d?" |

**Reply test section** (below the rows): intro "Before live campaigns can start, check that replies still arrive
cleanly and unsubscribe links work (about 15 minutes)."; "Before you start" list with the `replyTestBlockers` items
(each with its fix) while any is open; step list §1.5; table per mailbox (Mailbox · Provider · Test email · Reply
reached the app · In your inbox? · dkim/arc pass?), where "Not sure" opens the "Paste the email's original headers"
box (§1.5 step 3); headers question; unsubscribe fact; buttons "Send test emails to my test list" (outline, disabled
while blockers are open), **"Save the result"** is the section's action but not orange (the page's primary stays
Apply); failed state text §1.5 step 6; "Try Setup B (check only)" / "Back to Setup A" (ghost, confirm). Empty test list:
"Add your test mailboxes first in Settings › Sending & Mailgun."

Actions (`src/app/(app)/settings/domain/actions.ts`, Owner): `applyRecommendedSettingsAction` (enqueue, returns jobId),
`checkDomainAgainAction`, `sendReplyTestAction`, `saveReplyTestAnswersAction`, `decideReplyTestAction`,
`switchUnsubscribeSetupAction`, `saveDomainAgeAction`. The row's "Remove it" button is a link to
`/settings/deliverability?q=<inbox>`, where P4's Remove action lives (no wave-2 cross import).

### 5.4 Settings › Limits & warm-up (`/settings/limits`, Owner; P3)

| Section | Content |
|---|---|
| Today | "Today's limit: 129 (warm-up day 7 of 20)" · "Used 37 · 92 left" · "Next email in about 4 minutes" (pacer) or the waiting reason ("Waiting for sending hours: the next window opens at 9:00 in Berlin (12:00 your time).", "Today's limit is reached. Sending continues tomorrow.", "Paused: …"). "The day runs midnight to midnight Pakistan time (Asia/Karachi)." Override line when set: "Changed by Arslan at 14:02 to 300 (above the warm-up schedule)." [Go back to the schedule] (ghost). |
| Change today's limit | number field + "Change today's limit" (outline) → dialog: above schedule "Today's limit becomes 300, above the warm-up schedule (129). Sending more than the schedule can hurt how inbox providers see your new domain. Change today's limit to 300?"; below: "Today's limit becomes 20 for today only. Change it?" [Change today's limit]. Logged `sending.capOverride`. |
| Warm-up schedule | Table Day · Daily limit · (Done / Today / Next); text "The limit rises about 17% after each sending day on which at least half of it was used, while bounces and complaints stay low." History (last 14): "Tue 22 Sep: 48 of 50 used, healthy → the limit rose to 59" / "Sat 26 Sep: not a sending day, the limit stays" / "Wed 23 Sep: only 12 of 50 used, the limit stays" / "…: 4 bounces in the last 200 emails, the limit stays". Empty: "No days evaluated yet. The limit is checked after each day on which emails went out." |
| Sending hours | Days (checkboxes Mon…Sun), From/To (15-minute selects), sentence "Emails go out Monday to Friday, 9:00–17:00 in each recipient's time zone, spaced out with random gaps." Default zone for companies without one. |
| Per-sender limits | Table Name · Sending address · Daily limit (empty = "No limit of their own"); saved by `saveSenderCapsAction` through `sender-caps.ts` (§4.3.9). |
| Advanced | Maximum daily limit (warm-up target), smallest gap between emails (seconds), cap-day time zone, warm-up start and number of steps. |

**Primary: "Save limits"** (one form). Actions (`src/app/(app)/settings/limits/actions.ts`, Owner): `saveLimitsAction`,
`setTodayCapAction({cap, confirmed})`, `clearTodayCapAction`, `saveSenderCapsAction`.

### 5.5 Settings › Deliverability (`/settings/deliverability`, Owner; P4)

| Section | Content |
|---|---|
| Health | "3 of the last 200 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%." "0 of the last 1,000 emails were marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.08%." Small samples: "Only 45 live emails since <date>; the limit is counted per 200." Since-resume note: "Counting since you resumed on 24 Sep." Neutral bars. |
| Bounces counted now / Complaints counted now | Two tables built from `loadHealthCounts(…).bounceEmailIds` / `complaintEmailIds` (SPEC §8 "show why"): Address · Company (link to the panel) · Campaign (link) · Lists (the company's list names) · Date · "Details" (Mailgun's reason and code). Empty: "No bounces count toward the limit right now." / "No spam complaints count toward the limit right now." The pause card and the bounce warning link here (`#bounces`, `#complaints`). |
| Thresholds | Bounce window, bounce %, complaint window, complaint %, warm-up healthy bounce %, healthy complaint %. Above Mailgun's: amber "Above Mailgun's own limit of 5%: Mailgun may suspend your account before the app pauses." **Primary: "Save thresholds"**. |
| Do-not-email list | Search box (pre-filled from `?q=`), chips All / Bounced / Unsubscribed / Complained / Do not email / Invalid, table Address · Why · Company · campaign (the person's company and, for events, the campaign of the email it came from) · Where from (Mailgun / You / Address check / Practice) · Added · In Mailgun (yes / waiting), 50 per page. Empty: "Nobody is on the do-not-email list yet. Bounces, unsubscribes and spam complaints appear here automatically." [Add an address]. "Add an address" dialog (email + "Unsubscribed" / "Do not email") → "Adds anna@studio.de to the do-not-email list for every sender, and stops any emails waiting for it." "Remove" appears only for test-list addresses and active users' reply inboxes: "Remove a@gmail.com from the do-not-email list? It's on your test list, so test emails can reach it again." / "Remove ali.khan@gmail.com from the do-not-email list? It's Ali's reply inbox, so Mailgun can forward replies to it again." |

Actions (Owner): `saveHealthThresholdsAction`, `addSuppressionAction`, `removeOwnSuppressionAction`.

### 5.6 Settings › Email footer (`/settings/footer`, Owner; P3)

Fields: Company name, Address, Unsubscribe line ("If you'd rather not hear from us, unsubscribe here:"), Portfolio link.
Live preview of the text and HTML footer (`[unsubscribe link]` in place of `%unsubscribe_url%`). Hint: "Mailgun turns
the unsubscribe link into a personal link for each person, which works even while this PC is off." **Primary: "Save footer"**.

### 5.7 My profile (`/settings/profile`, everyone; P5)

New field "Sending address" inside the existing form: input group `[ ali ] @send.example.com`, hint "People see this
address in their inbox. Replies to it are forwarded to your reply inbox.", status line "Reply route: working (checked 5
minutes ago)" / "Being set up…" / "Not working: <routeError>. The Owner can fix it with Apply recommended settings." /
no domain: "Your sending address is set up once the Owner connects the sending domain in Settings › Sending & Mailgun."
Blocked state shows the campaign names. `updateProfileAction` handles `senderLocalPart` (only when changed).

### 5.8 Campaign wizard and campaign page (P3, except Review's test button: P5)

| Screen | Change |
|---|---|
| Sender step | Each choice shows its sending address ("ali@send.example.com" or "No sending address yet"), "Daily limit: 100" or "No limit of their own", reply route "Replies reach Ali" / "Reply route not working". |
| Review step (P5) | "Send me a test" enabled: dialog "Sends this person's email to your reply inbox (anna@gmail.com). Tests count toward today's limit. 17 of 20 tests left today." [Send test]; dry run: preview + text §4.5.5. The dialog loads its facts with its own `testSendInfoAction` when opened, so the Review page (P3) needs no new props. |
| Schedule step | Sending-window sentence; "Today's limit is 50; 12 are already used. About 38 of these 120 emails can go out today; the rest follow on the next sending days."; for every **dry-run** campaign the "Ignore sending hours" switch (default on for real data, off in the practice copy; `summary.ignoreWindowDefault`) with the texts on: "Sends as fast as possible, day or night, ignoring sending hours and gaps." / off: "Waits for each recipient's sending hours and takes turns with real emails, so you see when each email would really go out." Its value goes with the launch (`launchAction({campaignId, ignoreWindow})`). TEST/LIVE with follow-ups switched on (`summary.followUpsOff`): note "Follow-ups are sent from Milestone 4, so this campaign sends its first emails only; its follow-ups are switched off when you launch." `modeBlockers` shown instead of the M2 refusal. |
| Wizard frame | M2 warning removed; mode badge "Live (test list only)" / "Test mode". |
| Campaign page | Results note §4.3.9. Global pause banner: "Sending is paused for everyone: <reason>. <fixText>" (Owner: link to Settings › Sending & Mailgun). Waiting line from the pacer (every `WaitReason` has a sentence, e.g. `pending-events` "Waiting: a reply or a Mailgun report for one address hasn't been processed yet.", `reply-route` "Waiting: replies to Ali can't reach Ali yet.", `restore-check` "Waiting for the restore check with Mailgun.", `catch-up` "Waiting for the check with Mailgun."). UNKNOWN rows: "Checking with Mailgun whether it was sent…" (no buttons). UNCONFIRMED rows: "Retry or Skip?" dialog: "We couldn't confirm with Mailgun whether this email reached anna@studio.de. Retry sends it again. If the first one did arrive, Anna gets it twice. Skip sends nothing more to Anna in this campaign." LIVE: primary [Skip], outline [Retry anyway]; TEST: primary [Retry], outline [Skip]. A FAILED row's step note shows "Mailgun refused this email." with "Details" (Mailgun's text from the `email.failed` activity). |

### 5.9 Other screens

| Screen | Owner | Change |
|---|---|---|
| Top bar (P3) | everyone | `sendingLabel` §4.1.5; Owner links to /settings/sending. |
| Dry-run outbox email (P4) | everyone | "Simulate" row: [Delivered] [Bounce] [Complaint] [Unsubscribe] (outline), results line ("Delivered · Bounced (simulated)"), explanation "Test what happens when Mailgun reports back. In a dry run this only changes this campaign." (practice: "In the practice copy this changes the person too, like a real event.") |
| Settings › System (P4) | Owner | Card "Remote access": "Remote access works · checked 2 minutes ago" (connections and the cloudflared version under "Details") / degraded: "Remote access works, but the connection to Cloudflare is weak · checked 2 minutes ago" / "Not connected since 14:02. Remote staff and Mailgun can't reach the app. Check that this PC is on and the Cloudflared service is running." / "cloudflared isn't running on this PC. If you haven't set up remote access yet, follow docs\setup\3-cloudflare.md." / version warning; "Public address check: https://outreach.example.com/api/health answered · 10 minutes ago" + the Access line ("Only your team gets past Cloudflare's login." or the red text of §4.4.7) + [Check now] (outline, `checkRemoteAccessAction`). "Public address: Not set yet. Follow docs\setup\3-cloudflare.md, then run setup.bat again." |
| Settings › Team (P5) | Owner | Access links: `access-link-display.tsx` replaces "arrives with the secure public address in Milestone 3" with "Set the public address (docs\setup\3-cloudflare.md, then setup.bat) to get a link that works from anywhere." when `APP_PUBLIC_URL` is empty. |
| Contacts "Get started" (P6) | everyone | "Connect Mailgun" step links to /settings/sending for the Owner; done when connected. |
| Company panel | everyone | Nothing to build: the Unsubscribed / Bounced / Complained flags (M1) and the timeline icons for `email.delivered/bounced/complained/unsubscribed` already exist; M3 only starts writing the data. |

Mailgun error wording (from `plainMailgunError`, used everywhere):

| Situation | Text |
|---|---|
| auth | "Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here." (pause reason "Mailgun didn't accept the API key") |
| wrong region | "Mailgun can't find mail.example.com in the EU region. If you created the domain in the US region, change Region to US." |
| business verification | "Mailgun is holding your account until business verification is finished. Complete the form in the banner at the top of Mailgun, then click Resume." (reason "Mailgun business verification") |
| not allowed to send | "Mailgun won't send from <d> right now. Check the banner in Mailgun, then click Resume." (Mailgun's text behind "Details") |
| queue disabled | §4.4.5 |
| rate limit | "Mailgun asked us to slow down; trying again at 14:05." |
| timeout | "Mailgun didn't answer in time." |
| guard | "Stopped by the test-list guard: <address> isn't on your test list." |
| other | "Mailgun refused this." (Mailgun's own text and the status code only behind "Details") |

---

## 6. The fake Mailgun server (P2)

### 6.1 Files

| Path | Content |
|---|---|
| `tests/fake-mailgun/server.ts` | `startFakeMailgun(opts): Promise<FakeMailgun>`; `node:http` on `127.0.0.1:0` (or a given port). |
| `tests/fake-mailgun/state.ts` | In-memory domain, records, tracking, webhooks, routes, suppressions, messages, log events, stored inbound, certificates, queue, monthly limit, request log, fault queues, clock. |
| `tests/fake-mailgun/handlers/*.ts` | One file per endpoint group, emulating research §15 exactly (messages, logs, suppressions, domain + verify, tracking, queues, x509, webhooks v3/v4, signing key, routes + match, storage, account limit). |
| `tests/fake-mailgun/events.ts` | Event builders (delivered, failed temp/perm incl. `suppress-*`, complained, unsubscribed with `storage: []` and `tags: ["*"]`, test-mode delivered code 650), Logs-item builders (`@timestamp`, `user-variables` as a JSON string, `storage.url` array). |
| `tests/fake-mailgun/webhooks.ts` | Its own HMAC (independent of `src/core/mailgun/signature.ts`), `signedEventRequest(url, eventData, opts)` and `signedInboundRequest(url, fields, opts)` returning `Request` objects for in-process route tests; `postToApp()` for CLI mode. |
| `tests/fake-mailgun/cli.ts` | Argument parsing, admin API, prints the origin and the settings to use. |
| `scripts/fake-mailgun.mjs` | `import { register } from "tsx/esm/api"; register(); await import("../tests/fake-mailgun/cli.ts");` (fallback documented: `npx tsx tests/fake-mailgun/cli.ts …`). |
| `tests/integration/helpers/mailgun.ts` | `connectFakeMailgun(opts)` for integration tests (§6.4). |

### 6.2 Options and API

```ts
export type FakeMailgunOptions = {
  domain?: string;               // default "send.example.com"
  region?: "EU" | "US";          // requests for the domain "in the other region" behave as unknown (404)
  apiKey?: string;               // default "key-fake-api"
  signingKey?: string | null;    // default "key-fake-signing"; null → GET http_signing_key 400
  plan?: "foundation" | "basic"; // basic → x509 402
  retentionDays?: number;        // Logs retention, default 5
  maxMessageTtl?: number;        // default 86_400 (Foundation 1 day)
  indexLagMs?: number;           // accepted events visible in Logs after this, default 0
  now?: () => Date;
  port?: number;                 // default 0
  appUrl?: string | null;        // CLI: where signed webhooks are POSTed; must be loopback
  switches?: Partial<{
    strictDuration: boolean; nextOnLastPage: boolean; crossOriginNext: boolean; legacyUrlField: boolean; putBareRoute: boolean;
    ignoreEmptyFooters: boolean; verifyRateLimited: boolean; certFails: boolean; certPolls: number;
    /** Logs `message_id =` matches only the <bracketed> form (tests the proven-form learning, §4.3.6). */
    bracketedMessageIdFilter: boolean;
    /** Sends answer with, and events carry, Mailgun's own id instead of our h:Message-Id (§4.4.2 matching order). */
    rewriteMessageId: boolean;
    /** `user_variables contains` never matches (tests "no positive control → never requeue"). */
    brokenContainsFilter: boolean;
  }>;
};
export type Fault =
  | { kind: "status"; status: number; body: string | object; headers?: Record<string, string> }
  | { kind: "hang" }                      // never answers → client timeout
  | { kind: "acceptThenDrop" }            // records the message + accepted event, then destroys the socket
  | { kind: "acceptThenRedirect" }        // records the message + accepted event, then answers 302 (→ ambiguous)
  | { kind: "acceptWithoutId" }           // records the message + accepted event, then answers 200 with {} (→ ambiguous)
  | { kind: "businessVerification" };     // 403 {"message":"Domain … is not allowed to send: business verification is required"}
export interface FakeMailgun {
  readonly origin: string;
  readonly requests: Array<{ method: string; path: string; query: Record<string, string[]>; body: unknown; headers: Record<string, string> }>;
  readonly messages: Array<{ id: string; fields: Record<string, string[]>; receivedAt: Date }>;
  failNext(route: string /* e.g. "POST /v3/:d/messages" */, fault: Fault, times?: number): void;
  setNow(now: () => Date): void;
  setDns(valid: "all" | Array<"spf" | "dkim" | "mx" | "tracking">): void;
  disableQueue(reason: string, until?: Date): void;
  deliver(messageId: string, opts?: { at?: Date }): object;             // returns event-data; adds the Logs event
  tempFail(messageId: string, opts?: { at?: Date }): object;
  bounce(messageId: string, opts?: { reason?: string; code?: number; at?: Date }): object; // + bounces list
  complain(messageId: string, opts?: { at?: Date }): object;            // + complaints list
  unsubscribe(messageId: string, opts?: { at?: Date }): object;         // + unsubscribes list (tags ["*"])
  receive(input: { from: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[]; headers?: Array<[string, string]> }): { storageKey: string; messageUrl: string; fields: Record<string, string> }; // stores + "stored" Logs event
  signedEventRequest(appUrl: string, eventData: object, opts?: { timestamp?: string | number; token?: string; tamper?: boolean; key?: string }): Request;
  signedInboundRequest(appUrl: string, fields: Record<string, string>, opts?: { multipart?: boolean; timestamp?: string; token?: string; tamper?: boolean }): Request;
  state(): FakeState;   // routes, webhooks, tracking, domain, suppressions, logEvents, certificates
  reset(): void;
  close(): Promise<void>;
}
```
Behaviour: every rule of research §15 (auth per endpoint, error shapes, rate-limit headers, paging, filters, retention,
16 KB options check, multipart parsing via `new Request(url, {method, headers, body: Readable.toWeb(req), duplex: "half"}).formData()`,
routes `/match` by translating the anchored regex, x509 state machine, storage expiry by `message_ttl`). It never makes
an outbound request except `postToApp` to a loopback `appUrl` (asserted), and has no proxy code.

### 6.3 CLI and admin API (for the lead's manual browser checks)

`node scripts/fake-mailgun.mjs --port 4010 --domain send.example.com --api-key key-fake-api --signing-key key-fake-signing --app http://127.0.0.1:3100`
prints the origin and "Set OUTREACH_MAILGUN_BASE_URL=http://127.0.0.1:4010 for the app. Use API key key-fake-api."
Admin endpoints (no auth, loopback only, JSON bodies): `GET /__fake/messages`, `GET /__fake/state`,
`POST /__fake/deliver|tempfail|bounce|complain|unsubscribe {messageId, webhook?: true}` (webhook → signed POST to
`<app>/api/webhooks/mailgun/events`), `POST /__fake/inbound {from, to, subject, text, inReplyTo?, notify?: true}`
(→ signed POST to `<app>/api/webhooks/mailgun/inbound`), `POST /__fake/fail-next {route, fault}`,
`POST /__fake/dns {valid}`, `POST /__fake/queue {disabled, reason, until}`, `POST /__fake/clock {now}`, `POST /__fake/reset`.

Manual check recipe (lead only, never on `data/app.db`, never with the owner's key): build once (services stopped);
`$env:DATABASE_URL="file:./data/manual-m3.db"; npx prisma migrate deploy`; start the fake; then in a new PowerShell
`$env:OUTREACH_MAILGUN_BASE_URL="http://127.0.0.1:4010"; $env:APP_PUBLIC_URL="http://127.0.0.1:3100"; node scripts/run-prod.mjs --port 3100 --db data/manual-m3.db --log-prefix m3- --pid-file run/m3.pid --stop-file run/m3.stop --no-build`.
`run-prod.mjs` sets `OUTREACH_TEST_RUN=1` itself because `--db` differs from `.env` (§2.5), so a forgotten
`OUTREACH_MAILGUN_BASE_URL` makes every Mailgun call fail instead of reaching the real Mailgun. Connect with key
`key-fake-api`, Apply (fake mode accepts the loopback public address), add a test list, set Live, run the reply test with
`/__fake/inbound` replies, launch, watch `/__fake/messages`, then bounce/unsubscribe with `webhook: true`.

### 6.4 How tests point the app at the fake (and why real Mailgun is never called)

1. `tests/setup/env.ts` sets `OUTREACH_TEST_RUN = "1"` and `OUTREACH_MAILGUN_BASE_URL ??= "http://127.0.0.1:9"` (dead
   port).
2. `connectFakeMailgun({domain?, region?, fake?})` (after `createTestDb` and dynamic imports): starts the fake, sets
   `process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin` (read at call time by `base-url.ts`), writes Settings
   `mailgun.domain/region`, secrets `mailgun.apiKey`/`mailgun.webhookSigningKey` (both `key-fake-…`), a `SendingDomain`
   row; returns `{fake, domain, domainId, apiKey, signingKey, stop()}` (stop restores the env).
3. Guards: in a test run `mailgunApiBase` throws without a `127.0.0.1` override and `assertAllowedBaseUrl` refuses
   anything but loopback; outside fake mode a `key-fake-` key is refused and in fake mode only `key-fake-` keys are used;
   fake mode is refused on `app.db`; `isAllowedStorageUrl` only allows the fake origin in fake mode; every client request
   uses `redirect: "error"`; a unit test greps `src/**` and `worker/**` for `mailgun.net` and allows it only in
   `src/server/mailgun/base-url.ts`.
4. The practice copy refuses Mailgun modes; `getMailgunContext` returns `practice-copy` there.
5. The screen checks (step S) run the app with `OUTREACH_TEST_RUN=1`, the fake and a seeded test database.

---

## 7. Owner guides and README (P1 writes the guides; P6 updates README and the install guide and re-checks labels)

Style as `docs/setup/1-install.md`: numbered steps, exact button names in bold, "What you should see" after each step,
troubleshooting at the end, plain words, UNVERIFIED dashboard labels written as "(the button may be called … )".

### 7.1 `docs/setup/2-mailgun-and-dns.md`

1. **Before you start**: you need the sending domain (Q8), a Mailgun account on Foundation, 30 minutes; DNS can take up
   to 24–48 h; business verification can take days: start it first. Mailgun's rules on cold email (Q1) in one line.
2. **Buy the sending domain** (if new): Cloudflare Registrar sells at cost (.com about $10.44 a year; checkout shows the
   real price), supports .com .net .org .co .io .studio .design .agency .me .xyz .uk, not .de .eu .art .pk. Click
   ICANN's verification email or the domain gets parked. Don't switch on Cloudflare Email Routing for it. Optional:
   redirect the bare domain to polygonparadise.com.
3. **Mailgun account**: Foundation plan; finish the business verification form in the banner.
4. **Add the domain in Mailgun**: Send › Domains › Add new domain → name, **EU** (can't be changed later), Automatic
   Sender Security on (or DKIM 2048) → Add domain.
5. **Create the API key**: profile menu › API Security › create a key, role **Developer**, name "Outreach app"; copy it once.
6. **Connect in the app**: Settings › Sending & Mailgun → Region EU, domain, paste the key → **Save and connect** → green.
7. **Add the DNS records** from Settings › Domain checklist (copy buttons): SPF TXT `@`, DKIM (TXT or two CNAMEs
   `pdk1/pdk2._domainkey`), MX `mxa.eu.mailgun.org` and `mxb.eu.mailgun.org` priority 10, CNAME `email` →
   `eu.mailgun.org`, DMARC TXT `_dmarc` = `v=DMARC1; p=none`. At Cloudflare: CNAMEs **DNS only** (grey cloud); type only
   `email` in the Name box; only ever one SPF record. Always copy values from the app, never from this guide.
8. **Wait and check**: **Check again** in the app; spreading takes minutes at Cloudflare, but a check made too early can
   show "missing" for up to 30 minutes; Mailgun itself says up to 48 h.
9. **Monthly safety limit** in Mailgun (the app's key can't set it): about 30,000 (minimum 1,000). Path UNVERIFIED.
10. **Now do the Cloudflare guide** (3-cloudflare.md), then come back.
11. **Apply recommended settings** (what it changes, as §5.3 hint); secure unsubscribe links may take a while.
    **If Apply can't do it** (a red step): Mailgun's click path, each label marked "(may be called …)" where
    UNVERIFIED: Send › Domain settings › Tracking: switch **Open tracking** and **Click tracking** off; switch
    **Unsubscribes** on and clear both footer boxes (HTML and text) so they are empty; save; then click **Apply
    recommended settings** again so the app checks it.
12. **Everyone's sending address**: Settings › My profile › Sending address. Your reply inbox must be a normal mailbox
    (Gmail, Outlook.com), never an address on the sending domain.
13. **Test list and the reply test**: add 2–3 mailboxes (one Outlook.com, one Gmail or Yahoo; not your reply inbox) in
    Settings › Sending & Mailgun; set sending to **Live (test list only)**; then run the reply test (§1.5): Domain
    checklist › Reply test › **Send test emails to my test list**, reply from each mailbox, answer the questions (how to
    "Show original" in Gmail and Outlook.com; "Not sure" lets you paste the headers), click the unsubscribe link in one
    test email, put that mailbox back via Settings › Deliverability › **Remove**, then **Save the result**. Live
    campaigns start only after it passes.
14. **Your first live campaign to the test mailboxes** (A8): in Contacts, add one company per test mailbox (for example
    "Test – Gmail" with that address as its person) and put them in a list called **Test mailboxes**, so real companies
    are never touched; email that list (Contacts › tick the list's companies › **Email these companies**), sender you,
    and launch. Emails go out inside sending hours, a few minutes apart. Reply from each mailbox: each reply must arrive
    normally in your reply inbox. Emails to test mailboxes don't count as "emailed", so you can repeat this any time.
    Then try the test tools: in the dry-run outbox, **Simulate** a bounce and an unsubscribe. Optional, a real bounce:
    add a made-up address at your test mailbox's provider (for example a random name at gmail.com) to the test list and
    to the "Test mailboxes" list, email it, and watch it show as Bounced; remove it from both lists afterwards.
15. **Check the reply routes in Mailgun**: Receiving › Routes shows "outreach-app:…" routes; don't edit them. Manual
    fallback if Apply can't create them: for each sender, **Create route** with Expression type **Custom**, expression
    `match_recipient("^ali@<domain>$")` (copy it from the "Replies reach each sender" row), actions **Forward** to the
    sender's reply inbox, **Store and notify** `https://outreach.<domain>/api/webhooks/mailgun/inbound`, **Stop**,
    priority **10**, description `outreach-app:sender:<number shown in the app>`; one catch-all route with
    `match_recipient("^.*@<domain>$")`, the same actions to your own inbox, priority **100**, description
    `outreach-app:catchall:<domain>`; and `match_recipient("^dmarc@<domain>$")` → Forward to you, Stop (no store),
    priority **50**, description `outreach-app:dmarc:<domain>`. Then **Check again** in the app.
16. **Optional**: Google Postmaster Tools. New domains: wait until 30 days old before real campaigns; warm-up does the rest.
17. **What happens when the PC is off** (A4.3).
18. **Troubleshooting**: the §5.9 error texts with what to do; orange cloud; doubled names; two SPF records; Email
    Routing; 402 on https links; "Paused" in the top bar; "Mailgun won't forward replies to …" (Remove it in
    Deliverability).

### 7.2 `docs/setup/3-cloudflare.md`

Order from `cloudflare-steps.md` "Plan implications": (1) domain on Cloudflare (Q11 a/b/c; DNSSEC off first; Active email;
certificate 15 min–24 h; b: keep website records grey-cloud); (2) Zero Trust onboarding (team name, Free plan, card not
charged); (3) add One-time PIN; (4) policies "Outreach staff" (Allow, Include › Emails) and "Public webhook bypass"
(Bypass, Include › Everyone) — never "Login Methods: One-time PIN" alone, never a Bypass on the main app, never "Require
Access protection"; (5) app "Outreach" (subdomain, empty path, One-time PIN only, session daily/weekly/monthly per Q11);
(6) app "Outreach public endpoints" with paths `api/webhooks/*` and `api/health`; (7) Admin PowerShell
`winget install --id Cloudflare.cloudflared -e`, then in a NEW Admin PowerShell
`& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install <TOKEN>` (Networking › Tunnels › Create Tunnel ›
`outreach-pc` › Windows 64-bit; copy only the token); (8) `Clear-History; Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue`;
(9) tunnel Healthy; (10) Routes › Add route › Published application › `outreach` + domain (lowercase, no path) › Service
URL `http://127.0.0.1:3000`; leave Additional application settings alone (no Host header, no Connect timeout);
(11) zone: Email Address Obfuscation Off, Bot fight mode stays Off, custom rule Skip for
`(http.host eq "outreach.<domain>" and starts_with(http.request.uri.path, "/api/webhooks/"))` skipping All managed
rules, All rate limiting rules, Browser Integrity Check, Security Level; (12) Tunnel Health Alert; (13) run `setup.bat`
again and enter `https://outreach.<domain>`; if `setup.bat` says the app runs as a service, double-click `update.bat`
afterwards so the app is rebuilt with the new address; (14) tests: phone on mobile data `/api/health` JSON with no
login page; `curl.exe -i -X POST https://outreach.<domain>/api/webhooks/mailgun/events` answered by the app; the main
page shows the Access code page, then the app's login; Settings › System shows "Remote access works" and "Only your team
gets past Cloudflare's login."; (15) updating cloudflared
(`cloudflared update` then `net start cloudflared` as Administrator; never 2026.8.0/8.1; winget pins); (16) troubleshooting:
1033/1016 = tunnel down, 502 = app down, 302 to cloudflareaccess.com on the webhook = bypass app wrong, "PIN already
used" = link scanner, QUIC/IPv6 flags via the service's ImagePath keeping `--token-file`.

### 7.3 README and install guide (P6)

README: status line "Milestone 3 of 6 (Mailgun)"; guides table (1 install, 2 Mailgun and DNS, 3 Cloudflare); "What
happens when the PC is off" (A4.3); restore paragraph now says sending stays paused after a restore until the Owner reads
the report and clicks Resume; "The top-bar label" (Dry run / Test list only / Sending live / Paused: …, and that it shows
"Test list only" while an earlier live campaign still sends even if the setting is back to dry run).
Install guide: step 2 says the public address is needed from Milestone 3 (link to guide 3); section 9 restore note;
troubleshooting "Paused: …" in the top bar → Settings › Sending & Mailgun.
Scripts' "not set up yet (Milestone 3)" strings become "not set up yet (see docs\setup\3-cloudflare.md)"; `restore.mjs`
writes the marker with `"version": 3` and its box text becomes: "Sending stays paused until you've read the restore
report in Settings › Sending & Mailgun and clicked Resume." `scripts/status.ps1` also shows the Cloudflared Windows
service ("Remote access (Cloudflared): running / stopped / not installed"), as the tunnel-down notice promises.
`scripts/run-prod.mjs` sets `OUTREACH_TEST_RUN=1` for the children when `--db` resolves to another file than `.env`'s
`DATABASE_URL` (§2.5).

---

## 8. Work packages

Every package: follow `CONVENTIONS.md`; run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`,
`npx eslint <owned paths>`, `npx vitest run <own test paths>`; never run `next build/dev/start`, `npm install`,
`prisma migrate *`, never touch `data/app.db`, never call real Mailgun. Report any needed contract change instead of making it.

### P1 — Core rules and owner guides (wave 1)

**Owned paths:** `src/core/sending/{window,pacing,warmup,health,label,mode-gates,index}.ts`, `src/core/mailgun/{signature,events,inbound}.ts`,
`src/core/dns/{types,spf,dmarc,dkim}.ts`, `tests/unit/sending-core/**`, `tests/unit/mailgun-core/**`,
`tests/unit/dns-core/**`, `docs/setup/2-mailgun-and-dns.md`, `docs/setup/3-cloudflare.md`. Tests (only) for the contract
files `capday.ts`/`caps.ts` in `tests/unit/sending-core/`.

**Builds:** §4.1 in full; `mode-gates.ts` (§4.5.7 signatures and texts: `liveModeBlockers`, `liveLaunchBlockers`,
`testModeBlockers`, `replyTestBlockers`, `goLiveBlockers`); §7.1 and §7.2.

**Provides:** every signature in §4.1 and `mode-gates.ts` (exact names). **Consumes:** contract files only.

**Tests (SPEC "sending-window and cap calculations, the warm-up ramp, health auto-pause, webhook signature verification"; B12):**
- window: open/closed at edges (09:00 open, 17:00 closed), Mon–Fri, Europe/Berlin and America/New_York across both DST
  switches (2026-03-29, 2026-10-25, 2026-03-08, 2026-11-01), `nextWindowOpen` over a weekend, `openSecondsBetween` union
  of Berlin + New York + Sydney, invalid zone fallback, `windowSentence`.
- capday: boundaries in Asia/Karachi (no DST) and Europe/Berlin (DST days are 23 h/25 h), `closedCapDaysAfter`, the cap-day boundary (23:59:59 vs 00:00 PKT).
- caps: `warmupTable(50,1000,20)` equals PLAN's list; other settings non-decreasing and end at max; `domainCapFor`
  (override today/other day/above schedule/above max); `senderCapacityLeft` Infinity.
- pacing: formula, jitter bounds with a seeded random, min gap, null cases.
- warm-up: up / hold for each reason; fixed denominators (3 bounces ok, 4 not; 1 complaint holds); 20-step ramp reaches
  1000 in 19 qualifying days.
- health: 6 of 200 no pause, 7 pauses; 7 of 50 pauses (fixed denominator); 1 complaint of 1000 no pause, 2 pause;
  warnings at 3 and at 1 complaint, not repeated when already warned; bounce wins over complaint.
- label: every row of the §4.1.5 table, including DRY_RUN or TEST with active live campaigns ("Test list only" /
  "Sending live" with the "still send real email" title) and TEST → "Test list only".
- mode gates: each blocker text from rows (`bad` and never-checked block, `warn`/`unknown` don't); `liveLaunchBlockers`
  adds Setup and the reply-test pass; `replyTestBlockers` (mode DRY_RUN, route, public address, empty list); practice
  copy refuses.
- signature: the research test vector; tampered signature/timestamp/token; non-hex; wrong length; `checkTimestamp`
  12 h/24 h edges, +1 h future.
- events: webhook and Logs normalisation from the research examples (incl. `storage: []`, `user-variables: []` and JSON
  string, numeric timestamps), dedupe key, every row of the `eventEffect` table (hard vs other permanent failures,
  each `suppress-*`, `provesAccepted`), `suppress-*` never health, test mode never health, `displayResult` precedence.
- inbound: `message-headers` string vs array, duplicate/case-variant headers, `References` chains, address parsing,
  snippet cap, storage key from `message-url`.
- dns: SPF chunk joining, 2 records, lookup terms; DMARC parse, duplicates, tree-walk candidates for `mail.polygonparadise.com`;
  DKIM key bits 1024/2048 from real-looking keys.

**Done when:** all above pass; every exported function has a doc comment; guides cover every §7.1/§7.2 step with the
exact app labels from §5; no I/O in `src/core` except `node:crypto` in `signature.ts`/`dkim.ts` (commented "server only").

### P2 — Mailgun client, fake Mailgun and shared foundations (wave 1)

**Owned paths:** `src/server/mailgun/**` (incl. `send-guard.ts`, `suppression-lookup.ts`), `src/server/env.ts`
(additions only), `src/server/state.ts` (the P2002 fix only), `src/server/services/sending/{pause,usage}.ts`,
`src/core/system-state-parse.ts`, `src/server/state-typed.ts`, `tests/fake-mailgun/**`, `scripts/fake-mailgun.mjs`,
`tests/setup/env.ts`, `tests/integration/helpers/mailgun.ts`, `tests/unit/mailgun-client/**`,
`tests/integration/mailgun-client/**`, `tests/integration/foundations/**`.

**Builds:** §4.2 in full (incl. the `casState` fix in §4.2.7); §6 in full.

**Provides:** `MailgunClient`, `MailgunError`, types, `checkSendGuard`, `getMailgunContext`, `domainsToSync`,
`mailgunSecrets`, `loadSendGuard`, `suppressionListsFor`, `mailgunApiBase`/`isFakeMode`/`isTestRun`/
`describeMailgunTarget`, `getTodayCap`, `countUserTestSends`, `loadHealthCounts`, `pauseSending`/`resumeSending`/
`getPauseState`, all parsers, `readTyped`/`updateTyped`/`shouldSendNotice`, the fake server and `connectFakeMailgun`.
**Consumes:** contract files; existing `state.ts`, `settings.ts`, `secrets.ts`, `notifications.ts`, `activity.ts`, `db.ts`,
`jobs.ts` (`redactText`).

**Tests:**
- client against the fake: every method's success shape; each error shape of research §0.4 → correct `kind`; 429 with
  each `X-RateLimit-Reset` form and the "try again after N seconds" text; a 400 "is not allowed to send" → `not-allowed`;
  timeout via `hang`; `acceptThenDrop`, `acceptThenRedirect`, `acceptWithoutId` → `ambiguous`; a 4xx never ambiguous;
  send never retried and never aborted by an outside signal; every request `redirect: "error"`; GET 429/5xx retried;
  404 retried once; Logs paging stops on empty/no-next/same-token/page guard; `strictDuration` fallback learned once and
  persisted; suppression paging with `nextOnLastPage` semantics and the `crossOriginNext` origin guard; unsubscribe
  batches of 999 (1,500 entries → 2 calls); `getSuppression` 404 → null; `putBareRoute`; route `/match`; webhooks
  legacy `url`; storage URL allowlist; a serialised `MailgunError` (JSON and stack) contains neither the key nor
  `base64("api:" + key)`.
- send guard (unit): campaign/reply-test `to` not on the test list before go-live → `guard`, no request in
  `fake.requests`; self-test only to `ownInbox`; lists and `a@x.com, b@y.com` or `Name <a@x.com>` refused; after go-live
  anyone.
- base-url: override honoured only for `http://127.0.0.1:<port>` (`localhost` ignored); refused on `app.db`; a test run
  (`OUTREACH_TEST_RUN=1` with `NODE_ENV=production`) throws without an override; `assertAllowedBaseUrl`; key-prefix
  rules both ways; the grep test for `mailgun.net`.
- foundations (temp DB): `getTodayCap` counting rules (SENT by sentAt, SENDING/UNKNOWN/UNCONFIRMED by claimedAt, TEST
  excluded, practice copy includes DRY_RUN, test sends included, cap-day boundary), override applied only today;
  `loadHealthCounts` (window, since/before, suppress-* and test mode excluded, distinct emails, complaints only from
  `complained` events: 2 `suppress-complaint` failures count 0; the returned ids); `pauseSending` first cause wins +
  `also` (with detail) + one notification; `resumeSending` resets the health baseline when the main or an `also` kind is
  health, writes the baseline before the pause (a failure injected between them leaves it paused), refuses a
  failed/unchecked restore without `confirmRestoreRisk`, and writes the summary "Resumed by Arslan with 7 of 200
  acknowledged"; `casState` create race → one `true`, no throw.
- fake: auth rules, domain-not-found in the other region, request log, reset, each new switch and fault.

**Done when:** tests pass; `node scripts/fake-mailgun.mjs --port 4010` starts and answers `GET /__fake/state`; no real
host string outside `base-url.ts`.

### P3 — Sending engine (wave 2)

**Owned paths:** `src/server/services/sending/{transport,mailgun-transport,loop,claim,gates,reconcile,restore,health-check,warmup-days,mark-sent,addresses,sender-caps}.ts`,
`src/server/services/campaigns/{launch,draft,control,queries,audience}.ts`, `src/server/services/eligibility.ts`,
`src/server/services/reservations.ts`, `src/server/services/companies/detail.ts` (`countsAsEmailed` only),
`src/core/rules/mode.ts` (adds `countsAsEmailed`/`emailedModes`), `src/server/sending-state.ts`, `worker/sending.ts`,
`worker/reconciler.ts`, `worker/jobs/{mailgun-restore-scan,warmup-evaluate}.ts`,
`src/app/(app)/campaigns/[id]/**` except `setup/test-send-actions.ts`, `src/components/campaign-wizard/**` except
`review-step.tsx`, `src/components/campaigns/**` except `outbox-*.tsx` and `simulate-*.tsx`, `src/components/shell/sending-pill.tsx`,
`src/app/(app)/settings/{limits,footer}/**`, `src/components/settings/{limits,footer}/**`,
tests: `tests/integration/sending/**`, `tests/integration/campaigns/**`, `tests/integration/campaign-wizard/**`,
`tests/integration/campaign-pages/**`, `tests/integration/rules/**`, `tests/unit/rules/**`, `tests/unit/campaigns/**`,
`tests/unit/sending/**`, `tests/unit/campaign-wizard/**`, `tests/integration/sending-m3/**`.

**Builds:** §1.7, §4.3 in full, §5.4, §5.6, §5.8 (except Review's button), the top-bar label, the M2 test updates listed in
code map §9 for its files (`addresses.test.ts`, both launch tests, `ui.test.ts`, `format.test.ts`, `query-plans.test.ts`,
the `pickDueEmails` users in `loop.test.ts`). P4 and P5 import `markSent`, `releaseCompanyIfDone` and
`renderCampaignEmail` as they are today: P3 may add optional parameters to `mark-sent.ts` (`goLive`) but must not change
existing exported signatures, nor any behaviour for DRY_RUN rows.

**Provides (for P6 wiring):** `SendingLoop` options `{startedAt, transportFor?, mailgun?}` and its `inFlight`,
`ReconcilerLoop` (`inFlight` option), `handleRestoreMarker`, `checkDatabaseInstance`, `restoreScanJob`, `runHealthCheck`,
`evaluateWarmupDays`, `warmupEvaluateJob`.
**Consumes:** P1 (window, pacing, warmup, health, label, events for Logs items, mode gates), P2 (client, context, send
guard, usage, pause, parsers), contract files, existing `markSent`.

**Tests (B12):**
- mode matrix §1.6 row by row: DRY_RUN with "Ignore sending hours" on sends immediately with no window (M2 tests keep
  passing, incl. dry runs launched before the migration); dry run with it off waits for hours and takes a pacer turn;
  practice copy gated and counted; TEST/LIVE gated; TEST uncounted; LIVE follow-up steps switched off at launch and the
  campaign finishes after its first emails.
- §1.7: two LIVE campaigns to the same test-list mailboxes before go-live both send (no 30-day block, no reservation, no
  company status change, no `lastEmailed*`); the daily count and health still include them.
- the crash-safe state machine against the fake: 200 → providerId saved, then SENT; `markSent` made to throw after a 200
  → UNKNOWN with providerId, reconciler finishes it, never requeued; 400 → FAILED + recipient stopped; 3 rejects for 3
  addresses → pause `mailgun-settings`; a 400 "is not allowed to send" → pause, row QUEUED; 429 → QUEUED, attempts
  unchanged, dueAt = reset, backoff; 401 → QUEUED + pause "Mailgun didn't accept the API key"; business verification →
  pause; 404 → QUEUED + 5-minute back-off + domain check enqueued; timeout (`hang`, short `timeoutMs`),
  `acceptThenRedirect`, `acceptWithoutId` → UNKNOWN + back-off 5/15/60 min; `acceptThenDrop` → UNKNOWN → reconciler
  finds it → SENT (exactly one message in `fake.messages`); lease loss during the POST doesn't abort it; a transaction
  rollback running beside a claim (claim stays).
- final check: a suppression, a person flag, "Pause all" or a removal from the test list arriving between the recheck
  and the POST → nothing reaches the fake (SKIPPED `not-on-test-list` / released); a CAS lost to the reconciler → no POST.
- `sendOneEmail(liveId)` without `gatedEmailId` sends nothing; `pickDueEmails` no longer exists.
- reconciliation: not found after 45 min with the control found → QUEUED with the same Message-ID (ended campaign →
  CANCELLED); `brokenContainsFilter` or no control row → never requeued, UNCONFIRMED at 2 h; `bracketedMessageIdFilter`
  → the form is learned and stored; `rewriteMessageId` → found by recipient/providerId; younger → stays UNKNOWN; query
  failure → UNKNOWN then UNCONFIRMED at 2 h + notifications; SENDING < 2 min or in `inFlight` untouched.
- restore scenario: backup restored, fake has the accepted events → rows SENT without a second send; row created for a
  (campaign, step, recipient) match with the event's Message-ID and earlier events re-linked; a campaign created after
  the restore that reuses an old id is never matched (ExternalSend instead); unmatched → ExternalSend; old backup → due
  QUEUED rows UNCONFIRMED; pause kind restore set; TEST/LIVE held until the second pass; failed scan → resume refused
  without the confirmation; a crash after each step of `handleRestoreMarker` still ends paused; a marker delete error is
  ignored; `scanFrom` uses the newest activity when earlier than `restoredFrom`.
- copied database: a different `databaseFilePath()` without a marker → pause `copied-database`; with a marker → no pause.
- gates: 600 due rows in closed zones and 1 in an open zone → the open one is sent; window closed everywhere → nothing
  claimed + `outside-hours` with the right `until`; cap reached → one notification per cap day; sender cap; pacing
  inputs ignore capped senders and zones closed for the rest of the day; pacer gap respected with a fixed clock and
  random; catch-up gate (not ready → wait; network failure + 15 min → go; auth failure → never); `restore-check`,
  `live-not-ready` (Setup B, tracking row bad) and `reply-route` holds (route `pending` during a sync never stops a
  recipient); a pending MailEvent or a reply during the campaign blocks only that address/company and the next
  candidate is sent; a reply to a reply-test email blocks nothing.
- health: 7th bounce event pauses; resume then no re-trip without new events (also when health was an `also` kind);
  warning at half; warn at 3, drop to 1, rise to 3 → a second warning.
- warm-up days: rises after a qualifying weekday; holds on weekend, low use, 4 bounces, a complaint; domain change resets;
  catching up several closed days in one run; a closed day isn't evaluated before a catch-up succeeded after its end;
  the `sending.warmup` activity only after the CAS.
- a dry-run campaign is never sent to Mailgun after switching the setting to LIVE (fake receives nothing).
- launch refusals (practice copy, not connected, each `testModeBlockers`/`liveLaunchBlockers` item incl. Setup B and no
  reply-test pass, no address, no reply route); readiness drift after the mode was saved still refuses.
- Unconfirmed: Retry needs the flag for LIVE and is refused with a providerId; Skip; Skip while UNKNOWN gives the 2-hour
  text; `finishCheck` waits for the decision.
- label: `getSendingState` counts active LIVE/TEST campaigns.
- Owner-only: Limits and Footer actions (incl. `saveSenderCapsAction`) refuse Members.

**Done when:** all tests pass; M2 sending tests pass unchanged except the listed M2-pinned assertions; the Limits page,
Footer page, campaign page and wizard compile and render with a seeded test DB (render tests where they exist).

### P4 — Mail events, sync and checks (wave 2)

**Owned paths:** `src/server/services/mail-events/**`, `src/server/services/mailgun/{catch-up,suppressions}.ts`,
`src/server/services/checks/**`, `src/server/http/read-body.ts`, `src/server/services/people.ts`
(`markPersonUnsubscribed` only), `src/core/dns/checklist.ts`, `src/app/api/webhooks/mailgun/**`,
`worker/{event-lane,monitor}.ts`, `worker/jobs/{mailgun-catch-up,mailgun-sync-suppressions,mailgun-check-domain}.ts`,
`src/app/(app)/campaigns/outbox/**`, `src/components/campaigns/outbox-*.tsx`, `src/components/campaigns/simulate-*.tsx`,
`src/app/(app)/settings/deliverability/**`, `src/components/settings/deliverability/**`, `src/app/(app)/settings/system/**`,
`src/components/settings/remote-access-card.tsx`, the two `PUBLIC_ROUTES` lines in `tests/unit/security/auth-coverage.test.ts`,
tests: `tests/integration/mail-events/**`, `tests/integration/webhooks/**`, `tests/integration/catch-up/**`,
`tests/integration/checks/**`, `tests/unit/checks/**`, and the `markPersonUnsubscribed` cases in
`tests/integration/company-panel/**`.

**Builds:** §4.4 in full; §5.5; §5.9 outbox and System rows.

**Provides (for P6):** `EventLane`, `MonitorLoop`, `createCatchUpJob`, `syncSuppressionsJob`, `checkDomainJob`,
`runCatchUp`, `applyMailEventNow`, `ensureSentFromEvent`, `storeInbound`. Writes `domain.check` rows consumed by P3 and
P5 through the contract type.
**Consumes:** P1 (signature, events, inbound, dns parsers, health for display), P2 (client, context, pause, usage/health
counts, suppression lookup, parsers, fake), existing `markSent`, `releaseCompanyIfDone`.

**Tests (SPEC "webhook signature verification"; B12):**
- events route: valid → 200 and rows; tampered → 401; stale → 406; future +2 h → 406; unreadable JSON → 406; missing
  `signature` fields → 406; wrong content type → 406; a body over 256 KB (with and without `content-length`) → 406
  without reading it all; replayed token → 200 no-op (no second MailEvent); duplicate event with a new token → 200
  no-op; no signing key → 401; SQLITE_BUSY (mocked) → 500; numeric timestamp normalised; the self-check header leaves
  `webhooks.stats` untouched; junk from "the internet" (foreign domain, stale) never counts toward `webhook-rejected`;
  3 counted rejections with no valid webhook in between → one notice.
- inbound route: urlencoded and multipart; over 10 MB → 406; stored unprocessed with `senderAddressId` and a normalised
  `fromEmail`, no stop; duplicate storage key; 24 h freshness.
- apply: every `eventEffect` row; real vs campaign vs none scope (LIVE, TEST, DRY_RUN real, DRY_RUN practice, TestSend
  SELF → none, TestSend REPLY_TEST, unmatched); matching by providerId and TestSend providerId; an event with
  `recipient "[REDACTED]"` stops the matched row's address; an `espblock` failure stops only that recipient, counts for
  health, creates no suppression; `pushedToMailgunAt` only when Mailgun lists it; instant stop in the same transaction
  as the event (recipient STOPPED, QUEUED → SKIPPED); **events applied in reverse order give the same rows**; webhook +
  Logs twins → one activity.
- proof of sending: a `delivered` or `failed` webhook for an UNKNOWN, UNCONFIRMED or QUEUED LIVE row → SENT; a duplicate
  event (already stored) still repairs a row whose `markSent` never ran; an `accepted` event stays unprocessed until the
  lane has run `ensureSentFromEvent`.
- event lane: activities, complaint notification to the Owner, `onProblems` called with counts, processedAt CAS; an
  event that fails 5 times is set processed with notice `event-failed`.
- catch-up against the fake: queue disabled → pause; tracking drift → pause; suppression pull sets flags and stops with
  one summary activity (no per-address activity), key includes `createdAt` (removed and re-added → applied again), an
  address already on the local list keeps its reason; push of every null-`pushedToMailgunAt` row in ≤ 999 batches, never
  in the practice copy; Logs window with cursor − 1 h, cursor = `min(queryEnd, walkStartedAt) − 30 min` and never
  backwards; ≤ 20 events per transaction; gap beyond retention recorded; two `accepted` events for one message →
  `email.duplicate`; stored inbound fetched; expired message → log-only row; idempotent second run; `onSuccess` called
  only after a complete run; `lastErrorKind` set per failure; `catchup-failing` after 3 h.
- checks with a fake `DnsLookup` table (NXDOMAIN, NODATA, timeout, split chunks, doubled name, proxied CNAME, two SPF,
  two DMARC, parent DMARC inheritance, rua on another domain) → rows and statuses; Mailgun read-back rows from fake state;
  a reply inbox on Mailgun's bounce list → red route row; tunnel check with a fake fetch (connected/degraded/down/
  not-running, bad version); webhook path showing an Access redirect → bad; `/contacts` answering 200 or a redirect to
  `/login` → app not protected (red), a redirect to `x.cloudflareaccess.com` → ok; `getDomain` 404 → pause
  `mailgun-domain`.
- suppressions: `removeOwnSuppression` allowed for a test-list address and an active user's reply inbox, refused for
  anyone else; `markPersonUnsubscribed` stops QUEUED rows at once and enqueues the push.
- **two processes writing** (B5.8, B12): about 200 signed webhooks through the route handler while a worker child
  process runs the event lane, claims and a catch-up against the same temp database → only 200 or 500 answers, no lost
  or duplicated `MailEvent`, no claim lost to a rollback.
- simulate: dry-run real data changes only that campaign; practice copy changes the person; LIVE rows refused.
- Owner-only Deliverability/System actions refuse Members; simulate allowed for Members.

**Done when:** tests pass; `tests/unit/security/auth-coverage.test.ts` passes with the two routes allowlisted.

### P5 — Mailgun setup and sender identity (wave 2)

**Owned paths:** `src/server/services/mailgun/{connect,apply-settings,routes,webhooks-setup}.ts`,
`src/server/services/{sender-addresses,test-send,reply-test}.ts`, `src/server/services/users.ts`,
`src/core/{sender-address,reply-test}.ts`, `src/core/mailgun/routes.ts`,
`worker/jobs/{mailgun-apply-settings,mailgun-sync-routes,send-test-email}.ts`, `src/app/(app)/settings/{sending,domain,profile}/**`,
`src/components/settings/{sending,domain}/**`,
`src/components/settings/{profile-form,types,settings-nav,access-link-display}.tsx` (and `types.ts`),
`src/components/campaign-wizard/review-step.tsx`, `src/app/(app)/campaigns/[id]/setup/test-send-actions.ts`,
tests: `tests/integration/mailgun-setup/**`, `tests/integration/sender-addresses/**`, `tests/integration/test-send/**`,
`tests/unit/setup-core/**`, and updates to `tests/integration/team/**` caused by `users.ts`.

**Builds:** §1.5, §4.5 in full (except `mode-gates.ts`, which P1 builds); §5.1, §5.2, §5.3 (rendering `domain.check`
rows + the reply-test section), §5.7, Review's "Send me a test", the Team page access-link wording (§5.9).

**Provides (for P6):** `applySettingsJob`, `syncRoutesJob`, `sendTestEmailJob`. **Consumes:** P1 (mode gates, dns types
for `ChecklistRow` display via the contract), P2 (client, context, send guard, suppression lookup, pause, usage,
parsers, fake), contract files.

**Tests:**
- connect: success; wrong key; domain in the other region (A6 wording); unknown domain; network; a `key-fake-` key
  outside fake mode refused; keys saved only after a pass; domain change moves sender addresses, resets the reply test
  and `pushedToMailgunAt`, logs `mailgun.domainChanged`; domain change refused while a TEST/LIVE campaign is active;
  `forgetMailgunKeys` logs `mailgun.keysRemoved`. (Warm-up restarting on a domain change is P3's test.)
- apply against the fake: every step ok; empty footers kept vs `ignoreEmptyFooters` → red step; x509: 400 (CNAME
  missing), 402 (basic plan), 202 → poll job → active → `web_scheme https`; webhooks POST/PUT/409-exists/404 paths and
  legacy URL removal; signing key saved; guard refuses http public address outside fake mode; host-not-found wording;
  the public-address step through an injected `fetchImpl`.
- routes: expressions escaped and anchored (`ali.b@send.example.com` → `^ali\.b@send\.example\.com$`); create, update on
  inbox change, delete orphans, keep retired addresses' routes; switched-off user forwards to the Owner; `/match` verify
  by route id; mismatch status only after a verified match; an `ok` route stays `ok` during a sync and on one 5xx; a
  reply inbox on the sending domain → `error`, no route; a reply inbox on Mailgun's bounce list → `error` + notice.
- sender addresses and profile: validation and reserved names; uniqueness incl. retired; blocked while a TEST/LIVE
  campaign is active; reactivation of own retired address; Owner notified when a Member changes; route sync enqueued;
  `updateProfile` refuses a reply inbox on a sending domain.
- test sends: preview in dry run; each refusal; 20/day checked in the same write as the insert (two parallel calls at 19
  → one sent); a second click within 2 minutes refused; counts toward the cap; ambiguous → UNKNOWN; auth → pause; events
  of a SELF test never suppress the inbox; reply test: one email per test-list address with `replyTestMessageId`, a
  rerun of the same job sends nothing twice, refused with the `replyTestBlockers` list, a double click queues one job.
- reply test: `evaluateReplyTest` truth table (needs Microsoft + Gmail/Yahoo, headers, unsubscribe; fail on any No);
  `parseAuthResults` on real-looking Gmail and Outlook.com originals (pass, fail, none, folded lines); a pass on another
  domain doesn't count; `saveReplyTestAnswers` never stores pasted text.
- Owner-only: every §5.2/§5.3 action refuses Members; profile and "Send me a test" allowed for Members.

**Done when:** tests pass; `settings-nav` lists the five Owner pages; the Sending, Domain and Profile pages and the
access-link display compile.

### P6 — Integration (after wave 2, one agent)

**Owned paths:** `worker/{main,index,periodic,repairs,notify}.ts`, `worker/jobs/index.ts`, `src/components/contacts/get-started.tsx`,
`src/server/{activity,notifications}.ts` (doc lists only), `tests/unit/ops/restore-script.test.ts`,
`tests/integration/worker/**`, `tests/integration/milestone2/**`, `tests/integration/milestone3/**`,
`scripts/{restore.mjs,setup.mjs,status.ps1,service-control.mjs,run-prod.mjs}`, `scripts/lib/supervisor.mjs` (strings),
`README.md`, `docs/setup/1-install.md`, `docs/dev/CONVENTIONS.md` (an "M3: Mailgun rules" section), and read-only review
of the P1 guides (fix labels there if they drifted).

**Builds:** §4.6, §4.7 lists, §7.3 (incl. `restore.mjs` marker `version: 3`, `status.ps1` Cloudflared line, `run-prod.mjs`
`OUTREACH_TEST_RUN`), the repair `m3.oldRestoreMarker` (unversioned markers only), the wiring of `inFlight` and
`createCatchUpJob({onSuccess})`, the M2 end-to-end test update, and the M3 end-to-end test.

**M3 end-to-end test** (`tests/integration/milestone3/end-to-end.test.ts`, real-data configuration, fake Mailgun, a
fixed clock on a Wednesday 10:00 Europe/Berlin):
1. connect → `runApplySettings({fetchImpl})` where `fetchImpl` answers `<pub>/api/health` from the health route handler
   in-process, so webhooks and routes are really registered → sender address → test list of 3 (one `outlook.com`, one
   `gmail.com`, one other) → mode LIVE;
2. a LIVE launch is refused ("Live campaigns start once the reply test has passed …");
3. **reply test:** `sendReplyTestEmails` → 3 messages in the fake with deterministic Message-IDs; a rerun of the job
   sends nothing more; `fake.deliver` each with signed webhooks; `fake.receive` a reply from each mailbox posted as a
   signed inbound notification; an `unsubscribed` webhook for one mailbox, then `removeOwnSuppression` for it; answers
   saved (one authOk via `parseAuthResults` on pasted headers); `decideReplyTest` → passed;
4. **live campaign to the same mailboxes:** launch a campaign to the 3 test-list people + 1 non-test person (excluded
   "Not on the test list"); the stored replies from step 3 hold nothing (they came before the launch and answer
   reply-test emails) → run worker ticks (`runOnce`-style) with the clock advancing past pacing gaps → 3 messages, 0
   duplicates, tags/variables/tracking fields right, `%unsubscribe_url%` present, no follow-up rows, the campaign
   finishes; no company became Contacted and no reservation was taken (§1.7);
5. fake delivers one, bounces one (hard), and one is marked as spam, with signed webhooks posted to the route handler →
   event lane → assert campaign counts (sent 3, delivered 1, bounced 1, complained 1), person flags, suppressions,
   recipients stopped, activity entries, the Owner's `email.complained` notification, no health pause;
6. catch-up run applies nothing new (idempotent) and its `onSuccess` evaluates warm-up;
7. Setup B: `switchUnsubscribeSetup("B")` → a LIVE launch is refused and already-queued LIVE rows wait
   (`live-not-ready`), the fake receives nothing; back to Setup A;
8. restart with an `acceptThenDrop` send and assert the reconciler marks it SENT once;
9. pause all → nothing sent → resume.

**Done when:** `npm run check` passes (tsc both configs, eslint, all vitest); the worker bundles (`node scripts/build-worker.mjs`
may be run by the lead); the lead's manual check (§6.3) works end to end; README/install guide updated. P6 never runs
`next build` (CONVENTIONS); the lead does it in step S.

### Step S — Screen checks (lead, after P6; PLAN A6 "contrast check on every screen at every milestone", B12)

Stop the services; `next build` and `node scripts/build-worker.mjs`; seed a test database (a copy of the practice
data is fine, never `data/app.db`) and start the fake (§6.3) and the app with `run-prod.mjs --db <test db>` (which sets
`OUTREACH_TEST_RUN=1`). Then, with Playwright + `@axe-core/playwright` (installed; a lead-written
`tests/playwright/m3-screens.spec.ts` and config setting `OUTREACH_TEST_RUN=1`) or, if Chromium isn't available, the
browser by hand plus axe: screenshots, the main actions, empty states, error messages, contrast and keyboard for:
- Sending & Mailgun: not connected, connected, paused by health (with `also`), paused after a restore (running, failed),
  copied database, empty test list, fake-mode banner, "Check with Mailgun" line (ok, failing, outage);
- Domain checklist with mixed rows (ok, warn, bad, unknown), the route values with Copy buttons, a suppressed reply
  inbox, and the reply-test section (blocked, in progress, pasted headers, passed, failed);
- Limits (override above the schedule, sender limits), Deliverability (empty, filled, "Bounces counted now"), Footer;
- the profile sending address in all four states;
- wizard Sender, Schedule (dry run switch on/off, TEST/LIVE follow-ups note, each `modeBlockers` text) and the Review
  test dialog;
- the campaign page: waiting lines, UNKNOWN row, Retry/Skip dialog (LIVE and TEST), FAILED row with Details;
- outbox Simulate; the System remote-access card (works, weak, down, not running, not protected);
- every top-bar label (Dry run, Test list only for TEST, LIVE before go-live and dry run with a live campaign still
  running, Paused).

---

## 9. Risks, decisions and questions

### 9.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Mailgun's AUP (consent, scraped lists) | account limited or closed | owner accepted (Q1); low bounce/complaint pauses; guide says it plainly |
| UNVERIFIED Mailgun behaviour: empty footers, business-verification error shape, wrong-region send status, `duration`, route `/match` choice, x509 time, bracketed `message_id` in Logs, rewritten Message-IDs | wrong row colour, a pause with a vague message, or (worst) a wrong "not sent" | fake switches test both variants; the app learns the Logs forms from a proven send before any requeue (§4.3.6); unknown account-level refusals hit the circuit breaker after 3 emails; the owner's own M3 steps settle the rest (§9.5); classification is text-based and lenient |
| A duplicate send (crash, restore, copy, lost answer) | a prospect gets the same email twice | providerId saved before `markSent`; every event is proof of sending; positive control before requeue; restore gate + two-pass scan; copy detection; sends never aborted; `email.duplicate` alarm if one slips through |
| Setup A fails the reply test | live campaigns stay locked; Setup C is extra work | tested early in M3; C needs a separate, small design and the owner's OK |
| Single job runner: a long import delays catch-up or reply tests | stale data for minutes; gated sending waits for the start-up catch-up | priorities (§4.6); event lane and reconciler are loops, not jobs; "Send me a test" runs in the web process |
| PC clock wrong | webhooks 406'd (Mailgun stops retrying) | +1 h future allowance; catch-up recovers events from Logs within 5 days and replies within 1 day |
| Access path wildcard `api/webhooks/*` (inferred) | webhooks blocked by the login page | "Remote access works" row POSTs the webhook path through Cloudflare and flags a redirect; it also checks the app itself is behind Access |
| SQLite contention from the 1 s event lane and webhooks | SQLITE_BUSY | short transactions (≤ 20 events), `dbTx` retries, webhook 500 → Mailgun retries, the two-process test |
| Practice copy caps and pacing make demos slow | owner confusion | "Ignore sending hours" skips window and pacing for any dry run |
| Warm-up stays at 50 during test-list-only use | expected | documented on the Limits page ("rises after days with at least half the limit used") |
| Large M3 scope (grew with the reviews) | wave-2 overrun | vertical packages with no wave-2 cross-imports (mode gates and the suppression lookup moved to wave 1); P6 wires; the lead may split P3 into P3a (gates, loop, transport, launch) and P3b (reconciler, restore, health, warm-up, pages) with the same owned paths divided by file |

### 9.2 Technical decisions the lead confirms

1. **Contracts first:** the lead applies §3 (schema, migration incl. the `ignoreWindow` data update, four new contract
   files, two edits incl. the redaction fix) before wave 1; nobody else edits them.
2. **Inbound in M3:** verify + store unprocessed + 200, no stop; processing in M4 (§1.4). The send-time guard holds only
   replies received during the campaign, excluding replies to test emails (§4.3.4).
3. **Global pause stops every mode**, including dry runs ("Pause all sending" means everything).
4. **TEST mode**: hours + pacing yes, caps/health no; test sends always deliver for real and only while the mode is TEST or LIVE.
5. **Resume never pre-tests Mailgun**: if the cause remains, the next send pauses again with the same message.
6. **Health counted from MailEvent** (new index): bounces = permanent non-`suppress-*` failures; complaints = real
   `complained` events only, so `suppress-*` drops show as "Bounced" on the campaign but never count toward health.
7. **Hard bounces only suppress:** `bounce`/`hardfail`/`suppress-bounce` or bounce-type hard create the BOUNCED
   suppression and the person flag; other permanent failures (`espblock`, `generic`, `old`, …) stop that recipient and
   count for health, with no lifetime suppression (§4.1.7).
8. **UNCONFIRMED keeps the campaign Running** until someone chooses Retry or Skip (`finishCheck` counts it as open);
   LIVE Retry needs an explicit duplicate-risk confirmation; rows with a `providerId` can never be retried.
9. **Unknown → Unconfirmed after 2 hours** when still undecided (B6.7 "otherwise the row becomes Unconfirmed"), instead of
   waiting for the log retention; requeue only with a positive control (§4.3.6).
10. **Webhook freshness** 12 h / 24 h past, 1 h future (research suggested 5 min future); oversized bodies → 406.
11. **Warm-up table**: PLAN's list for the default settings; a rounded geometric curve otherwise (PLAN's numbers are not
    exactly `round(50 × 20^(i/19))`: 388/389, 532/533, 623/624, 854/855).
12. **Catch-all route uses an anchored domain regex** (`^.*@domain$`), not `catch_all()`, so `/routes/match` checks work
    and other domains in the account are unaffected.
13. **"Send me a test" runs in the web process**; `send.testEmail` jobs are used only for the batch of reply-test emails.
14. **Sender-address changes are blocked only by active TEST/LIVE campaigns** (dry runs don't matter); so are domain changes.
15. **Suppressions may be removed by the Owner only for test-list addresses and active users' reply inboxes.**
16. **Domain age is owner-entered**, no RDAP call (keeps B9's external hosts unchanged).
17. **Secret key name stays `mailgun.webhookSigningKey`.**
18. **PLAN B9 corrections:** no `GET /v4/domains/{d}/webhooks` (read via v3), add `GET`/`DELETE /v3/{d}/{list}/{address}`,
    `GET /v5/accounts/limit/custom/monthly`, storage-host GETs; the DNS row widens to SPF, DKIM, MX, tracking CNAME, DMARC.
19. **`isSameOrigin`** is the name used (PLAN B10 says `assertSameOrigin`); never on webhooks.
20. **Old restore marker** from M1/M2 (no `version`) is renamed, not acted on (repair `m3.oldRestoreMarker`); M3 markers
    carry `version: 3`.
21. **Fake mode** is `http://127.0.0.1:<port>` only, refused on `app.db`, uses only `key-fake-` keys, and accepts an
    `http://127.0.0.1` public address for Apply (the lead's manual check and the screen checks only).
22. **`campaign.finishCheck` job type** stays unused.
23. **`minGapSeconds`** minimum is 20 (B6.6), not 10.
24. **B3 file names:** `docs/setup/2-mailgun-dns.md` and `4-reply-routes.md` are merged into `2-mailgun-and-dns.md`
    (routes are step 15); B3's `scripts/simulate-webhook.ts` is replaced by the fake's CLI (`/__fake/*`) and
    `tests/fake-mailgun/webhooks.ts`.
25. **Every event proves the send** (not only `accepted`), and `accepted` events stay unprocessed until the lane has
    run the proof step (§4.4.2).
26. **Copied database detection** pauses (`copied-database`) when the database opens from a new path without a restore
    marker; moving the app folder on purpose needs one Resume.
27. **Reply inboxes may not be on a sending domain** (mail loop), and the test list may not either.
28. **Suppression push covers every local row** (bounced, invalid, "do not email" included) as `tags ["*"]` unsubscribes on
    the active domain; list entries that match an existing local row never change its reason.
29. **Mode gates move to P1** (wave 1) and the suppression lookup to P2, so no wave-2 package imports another.
30. **`to` is the bare normalised address** (no display name), so the test-list guard checks exactly what Mailgun gets;
    research §1 suggested `Name <addr>`, which is cosmetic.

### 9.3 Notes for later milestones

- M4 must decide how to treat `InboundMessage` rows stored in M3 (they may be days old): process them without
  notifications when older than, say, 3 days, but still apply "Replied" and stops.
- M4 flips `MAX_SENDABLE_STEP` to 3. TEST/LIVE campaigns launched in M3 had their follow-up steps switched off at launch,
  so nothing overdue goes out; dry-run follow-up rows from M2/M3 are due and go to the outbox at once (harmless). M4 also
  removes the launch-time switch-off.
- M4: deactivating a user must ask the Owner what to do with their active campaigns (B6.10; A8's M4 list doesn't name it).
- M4: the reply guard (§4.3.4) becomes the full B6.4 rule once replies are processed.
- M6: go-live switch uses `goLiveBlockers()`; dashboard reads `health`, `warmup`, `tunnel.status`, `catchup.outage`.
- M6: record the go-live time and decide whether LIVE rows sent before it (test-list sends, §1.7) count as "emailed"
  afterwards (simplest: ignore LIVE rows with `sentAt` before go-live). Also the top-bar label for TEST after go-live.
- M6: B6.14's daily backup "outside every open sending window": M1's fixed 22:00–08:00 PKT window overlaps US East
  sending (18:00–03:00 PKT). Base `isQuietHour` on "no due gated email's window is open" (reuse `openIntervals`) when
  the dashboard and backups are polished; it is not a sending-safety issue.
- M6: if the owner declines Cloudflare Access (Q11), the "app protected" part of the remote-access row must become a
  warning instead of a go-live blocker.

### 9.4 For the owner: questions and changes you should know about

None blocks the build (defaults assumed: separate sending domain, Foundation, EU, Cloudflare Tunnel + Access). Needed
before you **test** M3: the sending domain bought (Q8); the Mailgun account with business verification submitted (Q9);
your reply inbox and 2–3 test mailboxes, one Outlook.com and one Gmail or Yahoo (Q10); the app's domain on Cloudflare,
the staff emails for Access and the session length (Q11). Only if Setup A fails: your OK for Setup C
(`ali@reply.<domain>`).

Changes to what PLAN Part A says, in plain words (please confirm or say no):
1. **Emails to your test mailboxes don't count as "emailed" before go-live.** They still count toward the daily limit
   and the bounce/complaint checks, but they don't block those mailboxes for 30 days, don't reserve anything and don't
   mark the "Test mailboxes" companies as Contacted. So you can repeat live tests (A5.1 narrowed; §1.7).
2. **Live campaigns wait for the reply test.** You can switch sending to Live first (the reply test needs it), but a
   live campaign can only be launched after the reply test has passed (A4.5, B6.8; §1.5).
3. **Test and live campaigns in Milestone 3 send first emails only.** Their follow-ups are switched off when you launch,
   because follow-ups arrive in Milestone 4 (§1.3).
4. **Dry runs get the "Ignore sending hours" switch.** It is on by default on your real data (dry runs fill the outbox
   straight away, as in Milestone 2) and off in the practice copy. Switch it off to see when each email would really go
   out (§1.6).
5. **After the PC starts, emails through Mailgun wait for the check with Mailgun** (SPEC "first catches up, then
   resumes"). If Mailgun can't be reached for 15 minutes because of a network problem, sending carries on anyway, so a
   Mailgun hiccup can't stop a whole day; the app keeps checking and tells you if it can't for 3 hours (§4.3.2).
6. **After a restore, emails through Mailgun wait about 35 minutes** for the restore check, even after you click Resume;
   if the check fails, Resume asks you to confirm that emails sent after the backup may go out twice (§4.3.7).
7. **The label "Not sure it was sent" has a short first stage:** for up to 2 hours the email shows "Checking whether it
   was sent" while the app asks Mailgun; only then is it "Not sure it was sent" with Retry or Skip (A6 wording table).
8. **The top-bar label never says less than what is going out:** it shows "Test list only" in Mailgun's test mode (as
   B6.5 says), and also when you have switched back to Dry run while a live campaign is still sending.
9. **"Send me a test" and your reply inbox:** the test list hint and the Live confirmation now say that real email also
   reaches your own reply inbox when you click "Send me a test". Your reply inbox can't be an address on the sending
   domain.
10. **If the app's database is ever copied or moved,** sending pauses once with an explanation, so a copy can never send
    the same emails again.

### 9.5 How the UNVERIFIED Mailgun points get settled (no probes on your account)

PLAN B9 says the builder's checks never use the owner's database or keys, and several `mailgun-api-reference.md` §16
probes would even change settings or send. So nobody runs them. Instead:

| §16 probe | Settled by |
|---|---|
| 1. GET domain on both regions | `testMailgunConnection` does exactly this, read-only, when the owner clicks "Save and connect"; its answer is shown under "Details". |
| 2. Wrong-key send | Not needed: any 401/403 on a send pauses `mailgun-auth`, whatever the body. |
| 3. Logs `message_id` form, `contains`, `duration`, last-page `next` | The reconciler's positive control proves the forms on the owner's first real sends and stores them in `mailgun.logsForm` (§4.3.6); `duration` is learned from a 400 (research §2.4); paging stops on an empty page either way. |
| 4. Empty unsubscribes paging | Stop on empty page (fake `nextOnLastPage` tests both). |
| 5. Empty footers read-back | Apply reads back after its own change; a red step with the manual click path if they don't stick (§7.1 step 11). |
| 6. `/routes/match` with/without catch-all | `syncRoutes` verifies every route by id after each sync. |
| 7. `PUT /v3/routes/{id}` shape | Parsed as `body.route ?? body`. |
| 8. Monthly limit with the Developer key | The domain check's GET; a 403/404 shows the amber row with the manual step. |
| 9. x509 on Foundation | Apply's certificate step and its poll show the real answer (402 wording ready). |

What the app learned shows under "Details" on the matching checklist rows; the lead reads it with the owner during the
M3 test if something looks odd.

---

## 10. Critique decisions

Both reviews (spec and risk) were checked against PLAN, SPEC and the code. Everything was applied except these, which
were changed or not taken:

| Finding | Decision | Reason |
|---|---|---|
| Risk 16: instant stop in the inbound webhook | Not taken; spec 1's guard (replies during the campaign, reply-test replies excluded) instead | M3 can't tell a reply from an out-of-office, and A8's M4 test says an auto-reply must not cancel anything. `companyId` isn't filled in either (M4's matching owns it); the guard joins `Person.emailNorm`. |
| Risk 38: tests only to the sign-in email or a test-list address | Not taken | PLAN Q10 and B10 define the reply inbox as the test destination; every Member change of it already notifies the Owner; tests are 20 a day, counted and logged. The client guard still enforces "own reply inbox only". |
| Risk 25: 413 for oversized webhook bodies | 406 instead | Mailgun retries every answer except 200 and 406 for 8 hours; an oversized body never shrinks (B6.11 "unreadable → 406"). |
| Risk 6: everything after `fetch()` starts is ambiguous | Narrowed: a 4xx answer stays a definite refusal | A 4xx proves Mailgun didn't accept the email; only answers that may hide an acceptance (timeout, abort, network, 5xx, 3xx, 2xx without id) are ambiguous. 402/409 pause instead of failing the row. |
| Risk 9: copied database paused as kind `restore` | New kind `copied-database` | The restore kind drives the restore gate and report; a copy has neither. |
| Spec 15: Unconfirmed after 2 h or 6 failed passes | 2 h only | No per-row failure counter (no schema column); 2 h covers ~12 passes anyway. |
| Spec 11: add "Test mode" to A6's labels | Not added; TEST shows "Test list only" | B6.5 already says test mode reads "Test list only"; fewer labels for the owner. |
| Spec 12: dry run with the switch off gated by "hours and pacing" | Taken with the shared pacer | A dry run that respects hours takes turns with real emails, which is what the owner wants to see; it never counts toward caps or health. |
| Spec 18(c): milestone2/rules tests to P6 | `milestone2/**` to P6; `tests/integration/rules/**` and `tests/unit/rules/**` to P3 | P3 changes `eligibility.ts` and `mode.ts`, whose tests live there. |
| Spec 19: `next build` in P6 "Done when" | Lead, step S | CONVENTIONS forbid agents from running `next build`; the lead stops the services first (B11). |
| Spec 20: M4 resets overdue follow-up `dueAt` | Launch switches off TEST/LIVE follow-up steps in M3 | Simpler and leaves nothing overdue for M4; the Schedule step says so. |
| Spec 21(b): push to every domain of `domainsToSync` | Active domain only, after resetting `pushedToMailgunAt` on a domain change | Old domains never send again (domain change refused while TEST/LIVE campaigns are active); pushing there wastes calls. |
| Spec 26: backup quiet time from open windows | Recorded for M6 (§9.3), the finding's second option | Not a sending-safety issue; M6 owns backups polish. |
| Spec 7: Owner-clicked GET-only "Check Mailgun's answers" | Not built; the app learns from normal use (§9.5) | Every §16 point is settled by a step the owner does anyway, without extra UI. |
| Spec 25: guide a real bounce | Optional step | A8 asks for simulated bounces; a deliberate real bounce on a new domain is harmless once, but not required. |
| Risk 27: `appProtectedCheck` as a go-live blocker | Taken; M6 relaxes it if the owner declines Access | Q11's default is Access; §9.3 records the exception. |
