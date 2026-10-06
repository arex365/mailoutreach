# Milestone 4 build design: Sequences and replies

The code and its tests win over this file; review fixes are named in the test headers (CRASH-*, SEQ-*, EVENTS-*).

Written 2026-09-23 by the architect, for the lead and the build agents; revised 2026-09-24 after two critic reviews
(every accepted finding is folded into the sections below; rejected or partly accepted ones are listed with a reason in
§13 "Critique decisions"). It turns PLAN.md A8 item 4 and the M4 parts of
A5, A6, B4, B5, B6.1, B6.4, B6.10, B6.11, B6.14, B7, B8 and B12 (plus SPEC §3, §7 "follow-ups stop", §9, §10 and the
notes M3 left in `docs/dev/M3-DESIGN.md` §1.3 and §9.3) into modules, contracts, screens and work packages that 3–5
engineers can build in parallel without talking to each other.

Sources, all read in full: `SPEC.md`, `PLAN.md`, `docs/dev/CONVENTIONS.md` (incl. "M3: Mailgun rules"),
`docs/dev/M3-DESIGN.md`, `docs/dev/m4-code-map.md`, `docs/dev/research/replies-and-auto-replies.md`,
`docs/dev/research/notifications-and-threading.md`, and the code the code map points at (gates, loop, mark-sent, stops,
apply, inbound store and parser, catch-up, event lane, worker main, notifications, bell, users, emailed texts, schema).
Where this file and PLAN.md disagree, this file wins for M4 and the difference is listed in §12.2 (technical, the lead
confirms) or §12.3 (visible to the owner, the owner confirms). Research files are the reference for regexes and test
vectors and are not repeated here: `replies-and-auto-replies.md` Appendix A (classifier and quoting sketch) and
Appendix B (40 classification + 15 quoting vectors) are the contract for P1's classifier.

**Nothing in M4 may ever send real email during the build or tests.** All Mailgun traffic in tests and the lead's
manual checks goes to the fake Mailgun (`tests/fake-mailgun/**`), which also receives replies and POSTs signed inbound
notifications to the app. Nobody on the build side uses the owner's key or database, not even read-only.

---

## 0. How to use this document

### 0.1 Order of work

| Step | Who | What | Blocks |
|---|---|---|---|
| **C** (contracts) | Lead, before wave 1 | Apply §8.3–§8.6 exactly: Prisma schema + migration `20260923220000_m4_sequences_replies`, `npx prisma generate`, the three new contract files (`src/core/replies/types.ts`, `src/core/notification-types.ts`, `src/core/sequences/hold-reasons.ts`), the contract edits (`src/core/system-state.ts`, `src/core/system-state-parse.ts` `parseOutageState` + `WAIT_REASONS`, the `ParsedInbound` type in `src/core/mailgun/inbound.ts`, the `outage-hold` and `possible-reply` cases in `src/components/campaigns/format.ts`). Run `npx tsc --noEmit` (both configs) and `npx vitest run` to prove nothing broke. | everything |
| **Wave 1** | P1, P2 in parallel | P1 pure core: reply classifier, quoting, link ids, reply copy, follow-up timing and threading, sequence wording, subject rules, pop-up decisions, inbound parser fields. P2 server foundations: company stops, holds and the outage hold (incl. the catch-up's gap record), the inbound store's new fields, notification queries, `markSent`'s `onlyFrom` option, the fake Mailgun's inbound extensions and test helpers. | wave 2 |
| **Wave 2** | P3, P4, P5 in parallel | P3 sequences engine and campaign screens. P4 reply processing, the waiting list, the Notifications page and the reply test tools. P5 bell, pop-ups, notification settings, "who has been emailed" texts, team switch-off, template subject rules. | P6 |
| **Final** | P6 (one agent) | Integration: worker wiring (event lane `processInbound`, outage hold after catch-up and at start-up), the daily clean-up of reply texts, M2/M3 end-to-end test updates, M4 end-to-end test, the two-process test, README, owner guide section, CONVENTIONS "M4" section, full `npm run check`. | step S |
| **S** (screens) | Lead, after P6 | Stop the services, `next build` and the worker bundle, start the app on a seeded test database with the fake Mailgun (M3-DESIGN §6.3 recipe, §7.3 here), then the screen checks of §11.4. | milestone review |

### 0.2 Rules for every builder (in addition to `docs/dev/CONVENTIONS.md`)

1. Only edit your **owned paths** (§10). Contract files from step C are read-only for everyone: if one is wrong or
   missing something, STOP and report it in your final answer (the lead fixes it and tells the others).
2. Code against the interfaces in this document even when the provider is being written at the same time. In wave 2
   you may only import from wave-1 packages, the contract files and existing code, never from a wave-2 peer.
   Cross-package calls inside wave 2 are wired by P6 through the injection points named here.
3. Every user-visible sentence in this document is the copy to use. Change wording only to fix grammar; keep meaning.
4. No new npm packages. Temporal comes from `temporal-polyfill` through `@/core/sending/window` and
   `@/core/sending/capday`; never compute days with `Date` arithmetic (CONVENTIONS "Times").
5. Never follow, fetch or render a link found in a received message (challenge-response links, tracking links). Reply
   text is shown as plain text only (React escapes it); never `dangerouslySetInnerHTML`.
6. Replies are processed in exactly one function, `processInboundMessage` (§3.8). Routes never classify or stop.
7. Recipients are stopped only through `stopRecipients` / `stopCompany` / `stopCompaniesForStatus` and held only
   through the hold functions in `@/server/services/sequences/holds` (§2.8). Nobody writes `state: "HELD"` or a stop
   code by hand, and every write that moves a recipient out of HELD also clears `holdReason`/`heldAt` (§2.8.1).
8. Never use the owner's Mailgun key or database, for tests or "just looking" (M3 rule). The fake is the only Mailgun.

### 0.3 Words used in this document

| Word | Meaning |
|---|---|
| **Follow-up** | An `OutboundEmail` with `step ≥ 1`. It exists only after the previous step was SENT (`markSent`). |
| **Thread ids** | The Message-IDs a reply points at: `In-Reply-To` first, then `References` newest→oldest. |
| **Nature** | What a received message is, from the classifier: `REPLY`, `AUTO`, `BOUNCE` or `POSSIBLE`. |
| **Kind** | What is stored in `InboundMessage.kind`, from the nature plus the link (§3.5). |
| **Reply scope** | Which recipients a reply may change: `real` (every campaign), `campaign` (only the linked campaign) or `none` (§3.6). |
| **Changes status** | Whether a reply may set the company Replied and `repliedAt`: `countsAsEmailed(mode)` of the linked email (M3 §1.7). |
| **Held** | `CampaignRecipient.state = HELD` with a `holdReason` (`outage`, `possible-reply`). Nothing is sent to a held recipient, and a hold can be released (a stop can't). `holdReason`/`heldAt` mean something only while `state = HELD` (§2.8.1). |
| **Undecided** | A processed message that still holds a company until someone decides: kind `POSSIBLE_REPLY` (not a twin), or kind `UNLINKED` with `heldCompanyId` set and not answered (§2.8.2). |
| **Quiet** | A reply received more than 3 days before it is processed (M3 backlog, long outages): processed fully, no notification of its own; its assignee gets one grouped `reply.summary` instead (§5.1). |
| **Assignee** | Who should answer a reply (`InboundMessage.assigneeId`, §4.2). |
| **Replier** | The known Person whose `emailNorm = fromEmail`; when the sender isn't a known Person, the person the linked email went to (covers private addresses and unknown colleagues, §2.6). |
| **Twin** | A second copy of a message already processed: same non-empty `messageIdHeader` and same `fromEmail`, another row, e.g. a reply sent to two of our addresses (§3.7). |
| **Real modes** | `realModes(practiceCopy)` (existing, `@/core/rules/mode`): LIVE, plus DRY_RUN in the practice copy. From-address, known-contact, bounce-address and named-address links only use emails of these modes. |
| **Gated** | As M3 (§0.3 there): TEST/LIVE rows and dry runs with "Ignore sending hours" off go through the gates. |

---

## 1. Scope

### 1.1 PLAN A8 item 4, bullet by bullet

| A8 M4 bullet | Built by | Main modules |
|---|---|---|
| Follow-ups in the same thread, with the stop rules | P1 (timing, threading, wording), P2 (company stop, holds), P3 (engine, launch, status stops, screens) | `src/core/sending/follow-up.ts`, `src/server/services/mail-events/stops.ts`, `src/server/services/sequences/holds.ts`, `src/server/services/sending/{gates,loop,mark-sent}.ts` |
| Reply detection, matching replies to emails, and auto-reply handling | P1 (classifier, quoting, link ids, copy), P2 (store fields), P4 (processing, effects, actions) | `src/core/replies/**`, `src/server/services/replies/**`, `src/server/services/mail-events/inbound-store.ts` |
| Holding follow-ups after a long time off | P2 (`applyOutageHold`, release), P3 (gate, strict catch-up for follow-ups, Sending page lines), P4 (on-hold card), P6 (wiring) | `holds.ts`, `gates.ts`, `/settings/sending`, `/notifications` |
| "Who has been emailed" shown everywhere | P5 (panel, Contacts title, import flag), P3 (Sequence column, campaign page), P4 (writes `repliedAt`, reply timeline entries) | `emailed-text.ts`, `companies/{detail,query}.ts`, `campaigns/{queries,format}.ts`, `imports/check.ts` |
| Notifications (bell, page, optional desktop pop-ups) and "Replies waiting for an answer" on the Notifications page | P2 (queries), P4 (page, waiting list), P5 (bell, summary route, pop-ups, settings) | `src/server/notifications.ts`, `src/app/(app)/notifications/**`, `notification-bell.tsx`, `/api/notifications/summary`, `/settings/notifications` |
| You'll test: practice-copy campaign with fast follow-ups | P4 (Simulate reply / out-of-office / unclear reply), P3 (minutes timing, sends) | outbox Simulate row |
| You'll test: live campaign to the test list with a 1-day follow-up; a reply cancels it; an out-of-office doesn't | everything above; P6 guide section and end-to-end test | `docs/setup/2-mailgun-and-dns.md` §19, `tests/integration/milestone4/end-to-end.test.ts` |
| SPEC M4 "the 30-day team rule" with follow-ups (built in M2; re-verified now that follow-ups go out in modes that count as emailed) | P3 tests: B6.1 "all steps and people in the same campaign are exempt" and `ensureReservation` for step ≥ 1 (§11) | `src/server/services/sending/loop.ts`, `src/server/services/reservations.ts` (unchanged) |

### 1.2 PLAN Part B sections, M4 parts

| Section | M4 part | Package |
|---|---|---|
| A5.4, A5.11 | Calendar-day delays, then the next weekday working hours; no quoted original in follow-ups | P1, P3 |
| A5.5, A5.6 | Automatic Replied (compare-and-set, never over Client / Not interested / Do not contact); a reply from such a company is logged and notified; Replied companies stay excluded by default and a hand "put back" covers only replies from before the launch (§2.7) | P4, P3 |
| A6 | Wording table ("Reply we couldn't link to a company"), empty state "You're all caught up.", recipient labels (§2.12), company panel "Emailed" banner, people flag Replied, Notifications screen | P3, P4, P5 |
| B4 | `InboundMessage` answer fields, assignee, classifier inputs, stored scope, domain hold; `CampaignRecipient` hold fields and `stoppedByInboundId`; `InboundKind.TEST_REPLY` (§8.3) | Lead (C) |
| B5 | Reply processing ≤ one short transaction per message; company stop and outage hold chunked (≤ 500 rows per transaction, `updateMany` per group); bulk status stops ≤ 50 companies per transaction; CAS on `processedAt`, company status and holds | P2, P3, P4 |
| B6.1 | `markSent` creates the next row with calendar-day timing and threading; `repliedAt` written; import "Replied" flag; Sequence column and panel texts for held and stopped recipients | P3, P4, P5 |
| B6.2 | "company-replied" override honoured only for replies before the campaign's launch (§2.7) | P3 |
| B6.4 | Follow-ups, subject, headers, sender snapshot; the sweeper; every stop rule with where it is enforced (§2.5); company-wide stop; the full "before every send" guard (§2.5.1); outage hold (§2.8.3) | P1, P2, P3 |
| B6.5 | Simulated replies: campaign scope on real data, real scope in the practice copy; "Dry run:" / "Test:" labels on notifications and timeline | P4 |
| B6.6 | Order: follow-ups first, then High priority, then oldest due (gated already; ungated gains it) | P3 |
| B6.7 | A reply that threads to an UNKNOWN/UNCONFIRMED email proves it was sent (`markSent`); restore creates a missing follow-up row from the previous SENT step (bug fix) | P4, P3 |
| B6.10 | Matching (headers, from-address 90 days before arrival, known contacts, no domain *matching* but a reversible domain hold, unlinked), classification, effects per kind, possible replies, spam marking, deactivated users' campaigns and waiting replies | P1, P4, P5 |
| B6.11 | Stored replies from catch-up (log-only → `bodyAvailable = false`, upgraded when the full message arrives later); outage gaps merged across domains; M3 backlog processed | P1, P2, P4 |
| B6.14 | Notification types (§5.1), bell polling and pop-ups (§5.2–5.3), Settings › Notifications (§5.4), Notifications page (§4, §5.5) | P2, P4, P5 |
| B7 | New server actions (§9.10); `GET /api/notifications/summary?after=` | P4, P5, P3 |
| B8 | Event lane processes `InboundMessage` rows (§3.9); outage hold after every successful catch-up, at start-up and in the 5-minute maintenance; missing possible-reply holds applied by the maintenance; daily clean-up clears reply texts after 30 days | P4, P2, P3, P6 |
| B12 | Tests: follow-up scheduling across weekends and DST, threading headers, every stop rule, the outage hold, reply matching (headers, from-address, unlinked), auto-replies in three languages, possible replies, two processes writing at once (§11) | all |

### 1.3 What M3 left for M4, and the decisions

| M3 hook (M3-DESIGN §1.3, §9.3) | M4 decision |
|---|---|
| `MAX_SENDABLE_STEP = 0` | Becomes **3** (P3). Everything else already handles steps 1–3. |
| Launch switches off TEST/LIVE follow-up steps | **Removed** (P3): `finalizeLaunch` no longer touches `CampaignStep.enabled`; `LaunchSummary.followUpsOff`, `FOLLOW_UPS_OFF_TEXT` and the Schedule-step note go. **TEST/LIVE campaigns launched in M3 stay as they are**: their steps above 0 are switched off, they finished (or finish) after their first emails, and the campaign page shows those steps as "Switched off" (existing text). Nothing re-enables them. |
| Overdue dry-run follow-up rows created in M2/M3 | **Sent at once, to the outbox** (not re-timed). Why: dry runs never leave the PC; the outbox then shows exactly what a real campaign would have sent; the burst is bounded (25 per tick ungated, paced when gated), gated dry runs no longer crowd out TEST/LIVE candidates (separate candidate queries, §2.10), and every row still passes the send-time recheck, so stopped or edited recipients are skipped. Re-timing would add code and a one-off repair step for no owner benefit. In the practice copy these sends count toward the practice copy's own daily limit (as any practice send does), so the owner guide tells the Owner to cancel old practice campaigns before the M4 practice test (§12.3 item 12). |
| `InboundMessage` rows stored in M3 (`kind = null`, `processedAt = null`) | **Processed like any reply** by the event lane at the first M4 start, oldest first. Rows received more than 3 days earlier are **quiet**: kind, links, company status, stops, `repliedAt`, timeline and the waiting list all apply, but they send no notification of their own; each assignee gets one grouped `reply.summary` ("Older replies were found", §5.1). Replies to reply-test emails become `TEST_REPLY` and change nothing. M3 log-only rows are marked `bodyAvailable = false` by the migration (§8.4) so they become POSSIBLE_REPLY. |
| M3's narrow "before every send" guard (replies received during the campaign) | **Replaced by the full B6.4 guard** (§2.5.1): any unprocessed reply (whatever its date) from the address, from anyone at the company (through `Person.emailNorm`), or threading to one of our emails to that company or address holds that candidate; so does an undecided possible reply of the company; replies the processor will file as `TEST_REPLY` hold nothing. The guard runs when candidates are picked **and again in the final check** just before the hand-over. |
| Deactivating a user: "what about their active campaigns?" | The switch-off dialog lists their Scheduled / Running / Paused campaigns and asks **Pause them** (default) or **Let them finish, including follow-ups** (§9.8). Replies to them go to the Owner either way (M3 route repoint), and their unanswered waiting replies are reassigned to the Owner in the same transaction. |
| Outage hold using `catchup.outage` | **Built** (§2.8.3): hold on recipient rows (`HELD`, `holdReason "outage"`) for follow-ups whose last email went out before the end of the unchecked window **and for everyone else open at those companies** (TEST/LIVE), a gate that holds TEST/LIVE follow-ups while an outage is found but not yet held, per-sender release with "I've checked my inbox", Owner release for anyone. `OutageState` gains `heldFor`, `heldTo` and `heldCount`; gaps from several domains are merged. |
| `InboundSource.SIMULATED` unused | Used by the new Simulate reply buttons (§7). |
| Fake `/__fake/inbound` drops `headers` and `at` | Extended (§7.3) with headers, envelope sender, stripped text, content type, message id, time and presets. |

### 1.4 Deferred (not built in M4)

| Item | Milestone | Hook M4 leaves |
|---|---|---|
| Dashboard tiles: replies waiting per user ("You 3 · Ali 1"), held follow-ups | M6 | `waitingReplyCount` (P2), `listWaitingReplies` (P4) and `outageHoldSummary` (P2) are reusable |
| RECHECK state (address re-check after 24 h) | M5 | The candidate query already skips RECHECK recipients (§2.10); M5 releases them |
| What LIVE rows sent before go-live mean after go-live, the "(test list)" suffix after go-live | M6 | `sequenceSuffix` (P1) takes `countsAsEmailed` and `mode`, so M6 changes one input |
| "Quoted text matches your email to Firma GmbH" link hint (research §6.2) | not planned | The same-domain and removed-contact hints are built (§3.3.5); exact addresses of live contacts link by themselves (§3.3.3b) |
| Spreading weekend follow-ups at the same local time instead of window start (research C2 option) | not taken (§12.2 D14) | `followUpDueAt` is the one place to change |
| Service worker, web push, phone pop-ups | not planned (research A2) | — |
| Public holidays in follow-up timing | never (A5.4) | — |
| `Thread-Index` / `Thread-Topic` headers | never (research B2) | — |
| Muting in-app notification types | not planned (SPEC §10 asks for the bell to show them all) | Pop-up groups (§5.4) |
| Undo a real reply (a message filed as a real reply that was really automatic: restart the stopped follow-ups) | later (after M6, if the owner asks) | `CampaignRecipient.stoppedByInboundId` records which message stopped each recipient (§2.6), so the undo needs no migration |
| Holding the replier's own rows when a possible reply comes from a known Person at a *different* company than the one it links to | not planned (rare; "Real reply" then stops them, §3.7) | `holdCompany` takes one company |

---

## 2. Follow-ups

### 2.1 When a follow-up is due

A follow-up row is created by `markSent()` (and by the sweeper, and by the restore check) the moment the previous step
is recorded SENT. Its `dueAt` comes from ONE pure function:

```ts
// src/core/sending/follow-up.ts (P1)
export type FollowUpTiming = {
  /** resolveZone(company.timeZone, Setting defaultTimeZone): the recipient's zone, never the cap-day zone. */
  zone: string;
  window: SendingWindow;             // Setting "sending.window" (parseWindow)
  /** gateClass(campaign) !== "ungated": TEST, LIVE, and dry runs with "Ignore sending hours" off. */
  gated: boolean;
  /** Campaign.daysAsMinutes (a dry-run helper). */
  daysAsMinutes: boolean;
  mode: "DRY_RUN" | "TEST" | "LIVE";
};
/** When step N+1 is due after step N was accepted at `sentAt` (PLAN A5.4, B6.4). Pure, DST-safe. */
export function followUpDueAt(sentAt: Date, delayDays: number, t: FollowUpTiming): Date;
```

Rules, in order:

| # | Case | Result |
|---|---|---|
| 1 | `days = max(0, floor(delayDays))` (anything invalid → 0) | — |
| 2 | `daysAsMinutes && mode === "DRY_RUN"` | `sentAt + days × 60 s`, **no window shift** (the gates decide for a gated dry run; an ungated one goes when due) |
| 3 | otherwise | `local = Instant(sentAt).toZonedDateTimeISO(zone)`; `due = local.add({ days })` (calendar days: the same local clock time; DST gap → later instant, overlap → earlier, Temporal "compatible") |
| 4 | `gated` | `nextWindowOpen(due, zone, window)` (existing `@/core/sending/window`): a due time inside the window stays; outside it moves to the next window **start** |
| 5 | not gated | `due` unchanged |

The pre-shift in rule 4 makes the stored `dueAt` (and so "Waiting for follow-up 1 on Mon 28 Sep") match when it can
really go. The gates still check hours at send time, so a later change of the window or of the company's zone never
sends outside hours; `dueAt` is not recomputed after such a change (research C2, §12.2 D15).

**Examples** (window Mon–Fri 09:00–17:00; these are P1's test cases):

| Company zone | First email accepted (local) | Delay | Follow-up due (local) | Why |
|---|---|---|---|---|
| Europe/Berlin | Mon 21 Sep 2026 10:00 | 3 | Thu 24 Sep 10:00 | inside the window |
| Europe/Berlin | Wed 23 Sep 2026 10:00 | 3 | Mon 28 Sep 09:00 | Sat → next window start |
| Europe/Berlin | Thu 24 Sep 2026 16:30 | 3 | Mon 28 Sep 09:00 | Sun → next window start |
| Europe/Berlin | Fri 27 Mar 2026 16:45 CET | 3 | Mon 30 Mar 16:45 CEST | calendar days keep 16:45 (72 h would be 17:45 → Tue 09:00) |
| Europe/Berlin | Fri 23 Oct 2026 16:45 CEST | 3 | Mon 26 Oct 16:45 CET | across the October change |
| America/New_York | Fri 6 Mar 2026 15:00 EST | 3 | Mon 9 Mar 15:00 EDT | US spring change |
| America/New_York | Fri 30 Oct 2026 15:00 EDT | 3 | Mon 2 Nov 15:00 EST | US autumn change |
| Europe/Berlin | Fri 25 Sep 2026 16:59 | 4 | Tue 29 Sep 16:59 | inside the window |
| Europe/Berlin, dry run with "Treat follow-up days as minutes" | 10:00:00 | 3 | 10:03:00 | minutes, no shift |
| Europe/Berlin, dry run with "Ignore sending hours" | Sat 10:00 | 3 | Tue 10:00 | not gated: no shift |

Weekday spread for the A7 sequence (+3, then +4, then +7), each step sent the day it is due (research C1 table; a
P1 test): first email Mon → follow-ups Thu, Mon, Mon; Tue → Fri, Tue, Tue; Wed → Mon, Fri, Fri; Thu → Mon, Fri, Fri;
Fri → Mon, Fri, Fri.

**Who computes it:**
- `markSent` → `advanceRecipient` → `createNextStepRow(tx, prev, next, { sentAt, timing })` (P3). `markSent` loads the
  timing inside its transaction: company `timeZone` (`OutboundEmail.companyId` → Company, else the recipient's company),
  settings `sending.window` and `defaultTimeZone` (read with the settings it already reads), campaign `ignoreWindow`,
  `daysAsMinutes`, `mode`, and `practice.copy` for `gateClass`.
- The sweeper's `repairRecipient` (same timing, from the last SENT row's `sentAt`).
- The restore check when it creates a missing row (§2.11).
- `followUpDelayMs` in `mark-sent.ts` is deleted.

### 2.2 Threading headers

Stored on the row at creation (bare ids, lowercase, space-separated, as M3); the client adds the angle brackets
(`client.ts` `ids()`), so Mailgun gets `h:In-Reply-To=<id>` and `h:References=<id1> <id2>` (M3, unchanged).

```ts
// src/core/sending/follow-up.ts (P1)
/**
 * The ids of one sent email that a reply to it may carry: ours, then Mailgun's own when it rewrote ours. The provider
 * id counts only for TEST/LIVE rows that contain "@" (a dry run's provider id is "dry-run:<messageId>", never an id).
 */
export function sentIdsOf(row: { messageId: string; providerId: string | null; mode: "DRY_RUN" | "TEST" | "LIVE" }): string[];
/** Headers for the next step (RFC 5322 §3.6.4): In-Reply-To = the parent as received, References = the chain, oldest first. */
export function threadHeaders(prev: { messageId: string; providerId: string | null; references: string | null; mode: "DRY_RUN" | "TEST" | "LIVE" }): {
  inReplyTo: string;
  references: string;
};
/** RFC 5537 §3.4.4: when "References: <…> <…>" would pass 998 characters, drop ids after the first until it fits, keeping the last two. */
export function trimReferences(ids: readonly string[], maxLineChars?: number): string[];
```

| Field | Value |
|---|---|
| `inReplyTo` | the parent's id as the person received it: the last of `sentIdsOf(prev)` (Mailgun's id when it rewrote ours on a TEST/LIVE row), else `prev.messageId` |
| `references` | `prev.references` ids, then `sentIdsOf(prev)` (ours, then Mailgun's when different), de-duplicated in order, trimmed by `trimReferences` (limit: `"References: ".length + joined bracketed length ≤ 998`) |
| Message-ID | new, `pp.<24 hex>@<same domain as prev>` (M3 `newMessageId(messageIdDomainOf(prev.messageId))`) |
| Never | `Thread-Index`, `Thread-Topic`, `h:References` with CRLF (Mailgun folds if it wants; UNVERIFIED) |

Our ids are ~45–60 characters, so even 4 steps with rewritten ids stay far under 998; the trim is defence only.
When Mailgun rewrote an id, its stored form is lowercased (M3); whether clients compare ids case-sensitively is
UNVERIFIED (research B3.4), so ours stays in `References` as well. The M3 notice `message-id-rewritten` stays; the
owner's first real follow-up test checks threading in Gmail and Outlook.com (§12.1).

### 2.3 Subject and body

- Subject: `Re: <the first email's subject exactly as this person received it>`: the existing
  `renderCampaignEmail` reads the stored step-0 `OutboundEmail.subject` (the loop writes it just before the hand-over)
  and `followUpSubject` adds one `Re: ` (never `Re: Re:`). First subjects are already normalised at render (whitespace
  collapsed, trimmed; `core/templates/render.ts`), so the collapse in `followUpSubject` changes nothing. No code change.
- **A first subject may not start with `Re:`, `RE:`, `Fwd:`, `FW:` or `Fw:`** (Gmail's sender rules; research B3.1):
  `firstSubjectProblem` (P1, §2.13) is an error on Save in the template editor (P5), on the wizard's Message step
  (P3), on a per-person first-subject edit (`editUnsentEmail` step 0, used by Review and the campaign page; P3), and
  once more at launch for the campaign's and every `RecipientEdit`'s step-0 subject (drafts saved before M4; P3). A
  subject whose start matches `^\p{L}{1,3}\s?:\s` (the one regex of §2.13; e.g. "Art: …", "FYI: …", "AW: …") is a
  warning (Outlook threading trap).
- Body: the step's own text; no quoted original, no "On … wrote:" (A5.11); the same footer and unsubscribe handling.

### 2.4 Sender

Follow-ups copy `senderId` and `fromAddress` (the full From line) from the previous row, which copied the campaign's
launch snapshot (M2/M3, unchanged). A sender's address can't change while their TEST/LIVE campaigns are active (M3).
A switched-off sender's campaign that the Owner lets finish keeps sending from the same address; replies reach the
Owner through the repointed route and are assigned to the Owner (§4.2).

### 2.5 Stop rules and where each is enforced

SPEC §7 / B6.4: follow-ups stop for a person when they reply, unsubscribe, bounce or complain; when the company
becomes Replied, Client, Not interested or Do not contact; when anyone at the company replies (every campaign).

| Rule | Instantly (same transaction as the cause) | Event lane (≤ 1–2 s) | Before every send (guard, §2.5.1) | Claim / recheck / final check | Code written |
|---|---|---|---|---|---|
| They unsubscribe | webhook tx `stopRecipients(real)` (M3) | activity | unprocessed MailEvent for the address holds it (M3) | recheck + final check: person flag or suppression → SKIPPED (M3) | `unsubscribed` |
| They bounce (Mailgun event) | webhook tx (M3) | activity, health | as above | as above | `bounced` |
| They complain | webhook tx (M3) | activity, Owner notice | as above | as above | `complained` |
| A delivery-failure notice reaches our reply address (linked, not a delay, and it names that address or no address) | — | `stopRecipients({emailNorm, reason: "bounced", scope, recipientId})` (no suppression, no person flag) | unprocessed reply holds the address and company | recheck | `bounced` |
| They reply (REPLY) | — (stored unprocessed; §12.2 D1) | `stopCompany({kind: "reply"})`: every campaign (real scope); plus `stopRecipients` for the replier's own address when they are a Person at another company | unprocessed reply holds address + company + thread, at pick time and again in the final check | recipient STOPPED → claim skips (existing) | `replied` for the repliers, `company_replied` for the others |
| Anyone at the company replies | — | same `stopCompany` | same | same | `company_replied` |
| Possibly a reply (POSSIBLE_REPLY) | — | `holdCompany({reason: "possible-reply"})` | same while unprocessed; afterwards the undecided row holds candidates of that company (wait `possible-reply`), and the 5-minute maintenance, launch and Retry turn that into a real hold (§2.8.2) | HELD recipients are never picked (§2.10); a claimed row of a HELD recipient is put back | (held, not stopped) |
| A new email from an unknown address on the company's own domain (REPLY/POSSIBLE nature, unlinked) | — | `holdCompany({reason: "possible-reply"})` in real scope (domain hold, §3.3.4) | as possible replies | as possible replies | (held until Link / Answered / No answer needed) |
| Processing a message fails for good | — | fail-safe: `holdCompany({reason: "possible-reply"})` for the company its thread or sender points at (§3.8) | the unprocessed row held it until then | as possible replies | (held) |
| Company set to Replied / Client / Not interested / Do not contact **by a person** | `setCompanyStatus` / `bulkSetStatus` transaction: `stopCompany({kind: "status"})` (**new**, P3) | — | — | recheck (existing backstop: `status:X`) | `status:REPLIED` … |
| Company set to Replied **by a reply** | — | inside the reply's effects transaction | — | recheck | (the reply codes above) |
| Long outage (replies may have been missed) | — | `applyOutageHold` after the catch-up: the follow-ups and everyone else open at those companies (§2.8.3) | gate `outage-hold` for follow-ups while found but not yet held | HELD recipients never picked | (held) |
| Person removed, company deleted, address changed | — | — | — | recheck (existing) | `person_removed`, `company_deleted`, sentence |
| Removed from the test list (before go-live) | — | — | — | final check (M3) | sentence |
| Campaign cancelled | `cancelCampaign` (existing) | — | — | claim cancels (existing) | `campaign_cancelled` |

#### 2.5.1 The full "before every send" guard (replaces M3 §4.3.4)

```ts
// src/server/services/sending/gates.ts (P3)
export type ProblemIds = { pending: Set<number>; possibleReply: Set<number> };
export async function pendingProblemIds(cands: readonly Candidate[]): Promise<ProblemIds>;
```

`pendingProblemIds(cands)` (P3, `gates.ts`), batched, chunks of 400, for the gated candidates of a tick:

1. **Events (unchanged):** a `MailEvent {processedAt: null, recipient ∈ toNorms}` holds that address.
2. **Replies:** load every `InboundMessage {processedAt: null}` (no date filter; the lane keeps this near zero; the
   `processedAt` index serves it), select `id, fromEmail, inReplyTo, references, source`. Each row's thread targets
   (below) are cached in a module-level `Map<inboundId, …>` until the row is processed (a stored row never changes
   before processing); the map is pruned to the ids of this query on every call, so a large catch-up costs its lookups
   once, not every 5 s.
   - For TEST/LIVE candidates, rows with `source = SIMULATED` are ignored (a simulated reply belongs to a dry run).
   - Rows the processor will file as `TEST_REPLY` hold nothing (mirrors §3.3.0–§3.3.1): the sender is internal (a
     user's `email` or `replyInbox`, a `SenderAddress`, or an address on any `SendingDomain`), or the thread ids hit a
     `TestSend` (`messageId` **or** `providerId`) and no `OutboundEmail`, and the sender is that TestSend's `to`, a
     user's address or on the test list.
   - For the rest compute three sets: `froms` (their `fromEmail`), `fromCompanies` (companies of `Person.emailNorm ∈
     froms`, deleted people included), `threadTargets` (for every thread id: `OutboundEmail` with `messageId = id` or
     `providerId = id` → its `companyId` and `toNorm`).
   - A candidate is held (set `pending`, wait reason `pending-events`) when `c.toNorm ∈ froms`, or `c.companyId ∈
     fromCompanies`, or `c.companyId`/`c.toNorm` is among `threadTargets`.
3. **Undecided messages:** `undecidedHolds(db, companyIds of the candidates)` (P2, §2.8.2) → a candidate whose company
   has an undecided message in real scope, or in campaign scope for the candidate's own campaign, is held (set
   `possibleReply`, new wait reason `possible-reply`). This covers recipients created or reopened after the message
   was processed (a launch, a Retry) until the hold of §2.8.2 reaches them.
4. Candidates in either set are skipped this tick and the next candidate is tried (M3 behaviour).

**Again just before the hand-over** (P3, `loop.ts` `finalCheck`, TEST/LIVE): before the "touched" compare-and-set,
`pendingProblemIds([candidateOf(row)])` for that one row; held → `releaseClaim({countAttempt: false})`, outcome
`held`. This closes the gap between picking and the POST (claim, recheck, reservation, render), during which the
webhook may store a reply.

`GateContext.blockedIds` becomes `problems: ProblemIds` (P3 owns every use: `planTick`, `explainCampaignWaiting`).
`Candidate.campaignLaunchedAt` stays in the type but is no longer used by the guard. Update
`tests/integration/sending-m3/gates.test.ts:301-347` (a reply from before the launch now holds too).

### 2.6 Company-wide stop (P2, `stopCompany`)

```ts
// src/server/services/mail-events/stops.ts (P2)
export type StopReason = "bounced" | "complained" | "unsubscribed" | "suppressed" | "replied" | "company_replied";
export type CompanyStopInput = {
  companyId: number;
  /** The Person ids that replied (§0.3 "Replier") and the address they wrote from. */
  replierPersonIds: readonly number[];
  replierEmails: readonly string[];
  /** The InboundMessage that caused the stop: written to CampaignRecipient.stoppedByInboundId. */
  inboundId: number;
  /** Campaign scope (§3.6): only this campaign. Omitted/null: every campaign. */
  campaignId?: number | null;
  now: Date;
};
/** A reply stops the company (§2.5). */
export async function stopCompany(tx: Tx, input: CompanyStopInput): Promise<{ stopped: number; campaignIds: number[] }>;
/** A person set these companies' status (set-based, for up to 50 companies per call). */
export async function stopCompaniesForStatus(tx: Tx, input: { companyIds: readonly number[];
  status: "REPLIED" | "CLIENT" | "NOT_INTERESTED" | "DO_NOT_CONTACT"; now: Date }): Promise<{ stopped: number; campaignIds: number[] }>;
// StopInput (existing) gains `inboundId?: number | null` (written to stoppedByInboundId when given).
```

1. Recipients: `{companyId, included: true, state ∈ STOPPABLE_STATES ∪ {STOPPED}}` (and `campaignId` when given), any
   campaign mode and status. Uses the existing `(companyId, state)` index.
2. Reply stop (`stopCompany`): a recipient whose `personId ∈ replierPersonIds` or `emailNorm ∈ replierEmails` gets
   `replied`, every other one `company_replied`. Open ones → `STOPPED`, `nextDueAt null`, `holdReason null`, `heldAt
   null`, `stoppedByInboundId = inboundId`; their QUEUED rows → `SKIPPED` with the text of §2.6.1. Already STOPPED with
   a weaker rank → upgraded (same logic as `stopRecipients`). **Already STOPPED with `failed`** (rank −1) → overwritten
   with `replied`/`company_replied`, so Retry (which only reopens `failed` recipients, `control.ts:434`) can never
   reopen someone whose company replied, even in scopes where the status doesn't change (test mailboxes before go-live,
   dry runs) and the recheck couldn't catch it.
3. Status stop (`stopCompaniesForStatus`): every open recipient of those companies → `STOPPED` with `status:<STATUS>`
   in one `updateMany`; their QUEUED rows → SKIPPED in one `updateMany`; already stopped rows are left alone (a
   `status:` code is rank −1, never replaced and never replacing).
4. `releaseCompanyIfDone(tx, campaignId, companyId, now)` per touched (campaign, company). Returns the touched campaign
   ids, so the caller runs `finishCheck` for each **after** its transaction.
5. `stopRecipients` also clears `holdReason`/`heldAt` on the rows it stops and writes `stoppedByInboundId` when given
   (P2 edit).

**Who is a replier** (P4 computes the input, §0.3): `replierPersonIds` = the known Person whose `emailNorm =
fromEmail` (live), if one exists; otherwise the person the linked email went to. `replierEmails` = `[fromEmail]`. So
when Ben (a Person at Firma) answers the email to Anna, Ben gets `replied` and Anna `company_replied`; when an unknown
colleague or Anna's private address answers, Anna gets `replied`.

**Ranks** (`stopRank`, replaces M3's): `suppressed` 0 < `company_replied` 1 < `replied` 2 < `bounced` 3 <
`unsubscribed` 4 < `complained` 5; anything else −1. So "stopped because they unsubscribed" beats "they replied",
and "they replied" beats "someone at the company replied", in any order of arrival.

#### 2.6.1 Skip texts (`STOP_SKIP_TEXT`, shown as the email's `lastError`)

| Code | Text |
|---|---|
| `replied` | `Stopped: they replied` |
| `company_replied` | `Stopped: someone at the company replied` |
| `status:REPLIED` / `status:CLIENT` / `status:NOT_INTERESTED` / `status:DO_NOT_CONTACT` | `Stopped: the company was marked Replied` / `… Client` / `… Not interested` / `… Do not contact` |
| M3 codes | unchanged |

### 2.7 Company status changes

| Trigger | Change | Guard |
|---|---|---|
| REPLY in a scope that changes status (§3.6) | `updateMany {id, status ∈ [NOT_CONTACTED, CONTACTED]} → REPLIED`; activity `company.status` "Status changed to Replied: anna@firma.de replied" (actor null, `automatic: true`, mode of the email) | compare-and-set; Client, Not interested, Do not contact and Replied are never changed |
| same | `Company.repliedAt = receivedAt` when null or earlier (forward only); `Person.repliedAt` the same for the **repliers only** (§2.6: the known Person who wrote, else the person the email went to), never for a colleague who didn't write | forward only |
| Person sets a status (panel, bulk) to Replied / Client / Not interested / Do not contact | `stopCompaniesForStatus` in the same transaction as the status write (P3 edits `setCompanyStatus`, `bulkSetStatus`); only for companies whose status really changed | `bulkSetStatus` runs status changes that stop in chunks of ≤ 50 companies per transaction and yields (`setImmediate`) between chunks (CONVENTIONS ≲ 50 ms) |
| Person sets any other status | nothing stops or restarts | — |

**"Put back by hand" (A5.6) covers only replies before the launch.** `recheckRecipient` (P3) drops the
`company-replied` override when `Company.repliedAt > Campaign.launchedAt`. Reply processing also stops explicitly, so
this is the backstop for a status set by hand (m4-code-map §0.6 bug).

### 2.8 Holds

A held recipient gets nothing until released; unlike a stop, a hold is reversible. `CampaignRecipient.holdReason` holds
the reasons, sorted and comma-joined (`"outage"`, `"possible-reply"`, `"outage,possible-reply"`); `heldAt` is set
when the first reason arrives. Helpers (contract, step C, `@/core/sequences/hold-reasons`, §8.6): `parseHoldReasons(s)`,
`formatHoldReasons(list) → string | null`, `withHoldReason(s, reason, on) → string | null`, `heldReasonsOf({state,
holdReason})` (empty unless `state = HELD`, so a stale value left by old code can never keep anyone held) and
`outageGapCovered(state, gap)` (§2.8.3).

```ts
// src/server/services/sequences/holds.ts (P2)
export async function holdCompany(tx: Tx, input: { companyId: number; reason: "possible-reply"; campaignId?: number | null; now: Date }): Promise<{ held: number; campaignIds: number[] }>;
/** Removes "possible-reply" from the company's held recipients (in scope) that no remaining undecided message still affects. */
export async function releaseCompanyHold(tx: Tx, input: { companyId: number; reason: "possible-reply"; campaignId?: number | null; now: Date }): Promise<{ released: number }>;
/** Undecided messages (§0.3) of these companies: real scope (campaignId null) or campaign scope. Indexed, one query per 400 ids. */
export async function undecidedHolds(reader: DbOrTx, companyIds: readonly number[]): Promise<Array<{ companyId: number; campaignId: number | null }>>;
/** Holds open recipients that an undecided message should hold but doesn't yet (after a launch, a Retry, or a race). */
export async function applyPendingPossibleReplyHolds(opts: { companyIds?: readonly number[]; campaignId?: number; now: Date; tx?: Tx }): Promise<{ held: number }>;
export async function applyOutageHold(opts?: { now?: Date }): Promise<{ applied: boolean; held: number; senderIds: number[] }>;
export async function releaseOutageHold(actor: { id: number; name: string; role: "OWNER" | "MEMBER" }, input: { senderId: number | null; now?: Date }): Promise<{ released: number }>;
export type OutageHoldSummary = {
  detected: boolean; applied: boolean; from: string | null; to: string | null; total: number;
  /** Only Mailgun's stored-message retention was passed (replies recovered without text), no log gap. */
  textOnly: boolean;
  bySender: Array<{ userId: number | null; name: string; active: boolean; held: number; firstEmailsWaiting: number }>;
};
export async function outageHoldSummary(): Promise<OutageHoldSummary>;
/** One sender's "On hold" card: people they emailed who are held, their first emails waiting for others, the window. */
export async function myOutageHold(userId: number): Promise<{ held: number; firstEmailsWaiting: number; from: string | null; to: string | null }>;
```

#### 2.8.1 Hold and release rules

| Operation | Rows | Effect |
|---|---|---|
| hold (any reason) | open recipients (`SCHEDULED`, `WAITING`, `HELD`, included) | `state HELD`, reason added, `heldAt ??= now`; their QUEUED rows **stay QUEUED** (the candidate query skips HELD recipients, §2.10). Written as `updateMany` per group of rows with the same current `holdReason` (≤ 500 rows per transaction) |
| release a reason | `HELD` rows carrying that reason | reason removed; no reason left → `state = currentStep > 0 ? WAITING : SCHEDULED`, `heldAt null`; overdue rows go at the next open slot, paced. Chunked (≤ 500 rows per transaction, CAS on `state = HELD`), `setImmediate` between chunks |
| stop | any HELD row | STOPPED, hold fields cleared (§2.6) |
| **any other move out of HELD** | `skipClaimed`, `failForGood` (`loop.ts`), `cancelCampaign`, `skipRecipient`, `retryEmail` (`control.ts`), `advanceRecipient` → FINISHED (`mark-sent.ts`) | always write `holdReason: null, heldAt: null` together with the new state (P3). Readers use `heldReasonsOf`, which ignores the fields unless `state = HELD` |
| `markSent` of a HELD recipient's email (a race: claimed before the hold) | `advanceRecipient` | **keeps `HELD`** when there is a next step: creates the next row, updates `currentStep`/`nextDueAt`, never flips to WAITING; no next step → FINISHED with the hold fields cleared (P3) |
| campaign cancelled | HELD rows | `campaign_cancelled` (existing: HELD is an open state), hold fields cleared |
| Skip by hand | HELD rows | allowed (existing `canSkip` includes HELD), hold fields cleared |

#### 2.8.2 Possible-reply hold and undecided messages

- **Applied** by reply processing (§3.5) to every open recipient at the company: every campaign in real scope, only
  the linked campaign in campaign scope. The same hold comes from a domain hold (§3.3.4) and from the fail-safe after
  processing failed for good (§3.8).
- **Undecided message** (§0.3), as `undecidedHolds` reads it: `processedAt` set, `answerOutcome` null (so twins,
  `"duplicate"`, never count) and either `kind = POSSIBLE_REPLY` with `companyId` in the set, or `kind = UNLINKED`,
  `answeredAt` null, `heldCompanyId` in the set. Its scope is the stored `replyScope` (§3.6): `real` affects the
  company in every campaign, `campaign` only `campaignId`.
- **Recipients created or reopened later** (a campaign launched while a possible reply is undecided, a Retry): the
  guard (§2.5.1 step 3) never lets them send, and `applyPendingPossibleReplyHolds` turns that into a real hold: called
  by `finalizeLaunch` for the new campaign's companies, by `retryEmail` for the reopened recipient's company (both P3,
  inside their transactions), and by `runSendingMaintenance` every 5 minutes for everything (P3), so the campaign page
  shows "On hold: a possible reply needs checking" instead of a vague wait.
- **Released** by a decision (§3.5): the decided row is updated first, then `releaseCompanyHold` removes
  `possible-reply` only from recipients that **no remaining undecided message** affects (a real-scope one for their
  company, or a campaign-scope one for their campaign). So two open possible replies, or a real-scope and a
  campaign-scope one, never release each other's hold. "Real reply" turns the hold into a stop (§3.5).

#### 2.8.3 Outage hold (B6.4 "After a long outage", A4.3)

Found by the catch-up (M3 `walkEventLogs`: the logs cursor is older than `now − logRetention + 1 h`) and written to
SystemState `catchup.outage`. **Recording a gap** (P2 edits `catch-up.ts` `walkEventLogs`; the old "overwrite" loses a
second domain's gap, m4-code-map §9 item 10), with the new gap `{from, to}`:

| Current record | Write |
|---|---|
| none, or `handledAt` set and **not** `outageGapCovered` | a new record: `detectedAt = now`, `from`, `to`, `beyondLogRetention = true`, `handledAt = null` (keeps `heldFor`/`heldTo`/`heldCount` of the last hold) |
| a gap found and not yet held (`from` set, `handledAt` null) | merge: `from = min`, `to = max`, `detectedAt = now` |
| `handledAt` set and `outageGapCovered` | nothing (the same gap recorded again by an incomplete walk, or another domain's part of the same outage) |

`outageGapCovered(state, gap) = state.heldFor !== null && state.heldTo !== null && state.heldFor ≤ gap.from <
state.heldTo`: a gap starting inside the window that was already held is covered; a gap starting earlier (an older
domain's longer gap) or at/after its end (a new outage) is not. `fetchStoredReply`'s write (a reply older than message
retention) only sets `beyondMessageRetention = true` and `detectedAt ??= now`; it never touches `from`, `to` or
`handledAt` (those log-only replies are POSSIBLE_REPLY and hold their own company, §3.4).

1. **Gate while not yet held** (P3): `GateContext.outageHoldPending = outage.from !== null && outage.handledAt ===
   null`. While true, TEST/LIVE candidates with `step ≥ 1` wait with reason `outage-hold`; first emails go (the hold
   follows within seconds, from the catch-up's `onSuccess`).
2. **Follow-ups need a real catch-up after start** (P3): for TEST/LIVE `step ≥ 1`, the catch-up gate is
   `lastSuccessAt ≥ startedAt` without M3's 15-minute network fallback (§12.2 D7), because the outage is only found by
   a complete Logs walk. Waiting reason `catch-up`. First emails keep the M3 fallback. As in M3, Mailgun not connected
   or no start time given (tests calling the loop directly) → open.
3. **`applyOutageHold`** (P2), called by the catch-up job's `onSuccess` first (P6), at worker start-up after the
   Mailgun safety steps (P6), and by `runSendingMaintenance` every 5 minutes as a retry (P3). **Single-flight**: a
   module-level promise; a second call while one runs returns that run's result.
   1. Read `catchup.outage` (remember `from` as `heldFrom`). `handledAt` set, or nothing detected → `{applied: false}`.
   2. `from === null` (only `beyondMessageRetention`, no log gap) → CAS `handledAt = now`, no hold, return. Settings ›
      Sending shows the "recovered without their text" line (§9.9).
   3. `outageGapCovered` (defence; the writer above normally prevents it) → CAS `handledAt = now`, return (never
      re-holds recipients a sender already released).
   4. **Follow-ups**: `included`, `state ∈ {WAITING, HELD}` (a recipient already held for `possible-reply` gains
      `outage` too, so deciding the possible reply doesn't release it), `currentStep ≥ 1`, campaign `mode ∈ {TEST,
      LIVE}` and `status ∈ {SCHEDULED, RUNNING, PAUSED}`, whose newest SENT `OutboundEmail.sentAt < outage.to` (a reply
      to an email sent before the end of the unchecked window may have arrived unseen; later emails' replies were
      seen). Their companies are the **affected companies**.
   5. **Everyone else open at the affected companies** (SPEC §7 "anyone at the company replies"): `included`, `state ∈
      {SCHEDULED, WAITING, HELD}`, TEST/LIVE campaigns with the same statuses, `companyId` among the affected companies,
      any sender. This includes first emails to colleagues (a change from PLAN B6.4 "first emails are unaffected",
      §12.3 item 7). Dry runs are never held.
   6. Hold all of them with reason `outage`: chunks of ≤ 500 per transaction, `updateMany` per group of the same
      current `holdReason`; every chunk transaction re-reads `catchup.outage` and stops when `handledAt` is set or
      `from !== heldFrom`; `setImmediate` between chunks.
   7. Final CAS on `catchup.outage` requiring `from === heldFrom && handledAt === null`: `handledAt = now`, `heldFor =
      from`, `heldTo = to`, `heldCount = n`.
   8. After the CAS, when `n > 0`: notification `outage.hold` to each affected sender (active; inactive → counted for
      the Owner) and to the Owner (§5.1), each built in **that user's own `timeZone`**; one activity `followups.held`
      with a date-free summary ("Follow-ups of 12 people were put on hold because the PC was off too long to check for
      replies", actor null, `data {from, to, count}`; the Activity page renders `from`/`to` in the viewer's zone).
4. **Release** (`releaseOutageHold`, chunked ≤ 500 rows per transaction with a CAS on `state = HELD`): the sender for
   their own campaigns (`Campaign.senderId = actor.id`), or the Owner for any `senderId` (null = campaigns whose sender
   account is gone). A Member for someone else → "Only Ali or the Owner can continue Ali's follow-ups." Nothing held →
   "Nothing is on hold for Ali." (own card: "Nothing of yours is on hold.")
   1. The sender's recipients held for `outage` with `currentStep ≥ 1` (people they emailed) lose `outage`.
   2. Then, at every company where no recipient with `currentStep ≥ 1` is still held for `outage`, the remaining
      `outage` holds with `currentStep = 0` (colleagues nobody has emailed yet, any sender) are released too. So a
      colleague's first email waits until **every sender who emailed that company** has checked their inbox, not until
      its own sender does; a sender whose only held people are such colleagues has nothing to confirm (their card says
      so, §9.1).
   3. Activity `followups.released`: "Ali checked their inbox: follow-ups of 8 people continue" / "Arslan continued
      Ali's follow-ups after the PC was off (8 people)" (`data {count, senderId}`).
5. A hold that nobody releases keeps the campaign Running (existing `finishCheck` counts HELD as open) and keeps its
   reservations. The Owner sees it on Settings › Sending & Mailgun (§9.9); M6's dashboard will too.

Replies recovered by the same catch-up are processed by the lane as usual (a real reply stops a held recipient); log-
only recoveries (message retention passed) become POSSIBLE_REPLY (§3.4).

### 2.9 Reservations, finish check, sweeper

- Reservations: unchanged rules. A stop releases the company's reservation in that campaign when nothing is open there
  (`releaseCompanyIfDone`, called by `stopRecipients`/`stopCompany`). A hold keeps it (the company is still in play).
- `finishCheck`: unchanged (open emails QUEUED/SENDING/UNKNOWN/UNCONFIRMED; open recipients
  SCHEDULED/WAITING/HELD/RECHECK). Reply processing calls it for every campaign its stop touched (P4), so a campaign
  whose last open company replied finishes within seconds instead of at the next 5-minute maintenance.
- Sweeper (`sweepFollowUps`): unchanged selection (SCHEDULED/WAITING recipients); uses `followUpDueAt` and
  `threadHeaders` through `createNextStepRow`; HELD recipients are not repaired while held.

### 2.10 Picking and pacing (P3, `gates.ts`)

| Change | Where |
|---|---|
| `MAX_SENDABLE_STEP = 3` | `gates.ts:60` (every use follows) |
| Candidates only for recipients in `SCHEDULED` or `WAITING` | every `pickCandidates` query: `recipient: { state: { in: ["SCHEDULED", "WAITING"] }, … }`; `dueStatsWithZones` SQL `AND r.state IN ('SCHEDULED','WAITING')`; `explainCampaignWaiting` the same (fixes m4-code-map §9.1: HELD/RECHECK rows were sendable) |
| Ungated order `step desc, priorityRank asc, dueAt asc, id asc` | `pickCandidates` ungated `orderBy` (B6.6 "follow-ups first"; gated already had it) |
| **Gated candidates picked per class**: one query for TEST/LIVE rows (limit `GATED_CANDIDATE_LIMIT`, 500) and one for gated dry-run rows (limit 200), each with the gated order, then merged in that same order (`step desc, priorityRank asc, dueAt asc, id asc`) | `pickCandidates`. Why: with one query, a large gated dry run's due follow-ups (e.g. M2/M3 dry runs whose follow-ups become sendable now) filled all 500 slots while paced, so TEST/LIVE rows never became candidates |
| `prepareClaimed`: recipient `HELD`, `RECHECK` or `PENDING` → `releaseClaim({countAttempt: false})`, outcome `held` | `loop.ts` |
| `finalCheck` (TEST/LIVE): recipient `HELD`/`RECHECK` → release (not skip); then the one-row guard of §2.5.1 → release, outcome `held` | `loop.ts` |
| Gate order for a TEST/LIVE candidate: … `catch-up` (first emails M3 rule; follow-ups §2.8.3 rule 2) → **`outage-hold` (`step ≥ 1`)** → back-off → … → `pending-events` → **`possible-reply`** → limits and pacing (rest as M3) | `planTick` |
| `runSendingMaintenance` also calls `applyOutageHold()` when `outageHoldPending`, and `applyPendingPossibleReplyHolds({now})` (each never throws: logged) | `loop.ts` |
| Every write that moves a recipient out of HELD clears `holdReason`/`heldAt` (§2.8.1) | `loop.ts` `skipClaimed`, `failForGood`; `control.ts`; `mark-sent.ts` |

`tests/integration/sending/query-plans.test.ts` must still show index use for every candidate query, the due-stats
SQL, the sweeper and `undecidedHolds` (the recipient join is by primary key; re-run and update).

### 2.11 Other engine fixes that come with follow-ups (P3)

| File | Change |
|---|---|
| `launch.ts` | Delete the `followUpsOff` block and its activity field; header comments. **Refuse the launch** when the campaign's step-0 subject or any `RecipientEdit` step-0 subject has a `firstSubjectProblem` error (drafts saved before M4): `CampaignError` "A first subject starts with “Re:” or “Fwd:” (the campaign's, or one person's edit on the Review step). Change it before launching: Gmail's rules forbid it for emails that aren't real replies." (code `re-subject`). `finalizeLaunch` calls `applyPendingPossibleReplyHolds({companyIds: the campaign's companies, campaignId, tx})` in its transaction (§2.8.2). |
| `draft.ts` | Delete `LaunchSummary.followUpsOff`; Message-step save refuses a first subject with `firstSubjectProblem(…).level === "error"` (field `step0.subject`, the §2.13 text). |
| `restore.ts` | A missing follow-up row found by `(campaign_id, step, recipient)` threads to the recipient's **newest SENT row with a lower step** (not `step − 1`; m4-code-map §1.4), with `threadHeaders`. |
| `mark-sent.ts` | `createNextStepRow` gains `timing`; `prevSelect` gains `providerId`; the providerId passed to `markSent` is used for threading; `advanceRecipient` keeps HELD (§2.8.1) and **works out the next step from the recipient's highest SENT step** (a step-0 row proven SENT after step 1, e.g. by the restore scan, never moves `currentStep` backwards or re-creates step 1); FINISHED clears the hold fields; `followUpDelayMs` deleted. (`MarkSentOptions.onlyFrom` is added by P2 in wave 1, §3.7.) |
| `eligibility.ts` (`src/server/services/eligibility.ts`; server-only fix, `src/core/rules/eligibility.ts` unchanged) | `recheckRecipient` drops the `company-replied` override when `company.repliedAt > campaign.launchedAt` (§2.7). |
| `control.ts` | **Behaviour changes:** `editUnsentEmail` refuses a step-0 subject with a `firstSubjectProblem` error (the §2.13 text, code `re-subject`); `cancelCampaign`, `skipRecipient`, `retryEmail` clear `holdReason`/`heldAt`; `retryEmail` calls `applyPendingPossibleReplyHolds({companyIds: [company], campaignId, tx})` after reopening a recipient. |
| `queries.ts` + `components/campaigns/format.ts` | `CampaignStepOverview` gains `held`: QUEUED rows of HELD recipients, counted there and **left out** of `waiting`, `nextDueAt` and `emailsWaiting` (`queries.ts:383-385` counted every QUEUED row as waiting); `stepProgressText` adds "5 on hold" ("Follow-up 1: 12 waiting, next on 14 Oct · 5 on hold"). |

### 2.12 Recipient state labels (A6 wording)

Campaign page and Contacts "Sequence" column (`recipientStateText`, `companySequenceLabel`; P3) and the company panel
(`sequenceStateText`; P5) use the same words; panel texts start lowercase because they follow "·".

| State / code | Campaign page, Sequence column | Company panel |
|---|---|---|
| PENDING (draft) | Not launched yet | — (not shown) |
| SCHEDULED, due later | Scheduled for 3 Oct | scheduled for 3 Oct |
| SCHEDULED, due | First email waiting to send | waiting for the first email |
| WAITING, due later | Waiting for follow-up 2 on 12 Oct | waiting for follow-up 2 on 12 Oct |
| WAITING, overdue | Follow-up 2 waiting to send since 12 Oct | waiting for follow-up 2 since 12 Oct |
| HELD `outage` | On hold: replies may have been missed while the PC was off | on hold: replies may have been missed while the PC was off |
| HELD `possible-reply` (alone or with `outage`) | On hold: a possible reply needs checking | on hold: a possible reply needs checking |
| RECHECK | Waiting for the address to be checked again | waiting for the address to be checked again |
| FINISHED | Finished | finished |
| STOPPED `replied` | Stopped: they replied | stopped because they replied |
| STOPPED `company_replied` | Stopped: someone at the company replied | stopped because someone at the company replied |
| STOPPED `status:CLIENT` (and the other statuses) | Stopped: marked Client | stopped because the company was marked Client |
| STOPPED `bounced` / `unsubscribed` / `complained` / `suppressed` / `failed` / `campaign_cancelled` / "Skipped by Sara" | existing texts | existing texts |
| Email SENDING / UNKNOWN / UNCONFIRMED / FAILED, campaign PAUSED | existing texts | — |

Suffixes (both places, from `sequenceSuffix` in `@/core/sequences/wording`, P1): ` (dry run)` for a dry run that
doesn't count as emailed; ` (test)` for Mailgun's test mode; **` (test list)` for LIVE before go-live** (new). Both
`companySequences` (P3) and `getCompanyDetail` (P5) pass `countsAsEmailed(mode, {practiceCopy, goLive})` and `mode`
(ends the countsAsReal/countsAsEmailed mismatch, m4-code-map §4.5).

The HELD texts live once in `@/core/sequences/wording` (`holdStateText(reasons, "campaign" | "panel")`); both packages
call it.

### 2.13 First-subject rules (P1, used by P3 and P5)

```ts
// src/core/templates/subject-rules.ts (P1)
export function firstSubjectProblem(subject: string): { level: "error" | "warning"; text: string } | null;
```

| Subject starts with | Level | Text |
|---|---|---|
| `Re:`, `RE:`, `Fwd:`, `FW:`, `Fw:` (any case, optional spaces before the colon) | error | Don't start a first email with “Re:” or “Fwd:”. Gmail's rules forbid it for emails that aren't real replies. Follow-ups get “Re:” automatically. |
| `^\p{L}{1,3}\s?:\s` (the only regex for this rule, also quoted in §2.3; e.g. "Art: …", "FYI: …", "AW: …") | warning | Outlook would show the follow-ups as a separate conversation, because the subject starts with a short word and a colon. Reword the start of the subject. |
| digits first ("3D: …"), anything else | — | — |

Where the error is enforced (the warning is shown in the editors only): template editor save (P5), wizard Message step
(P3), `editUnsentEmail` for step 0 (P3), and launch (P3, §2.11).

---

## 3. Replies

### 3.1 Pipeline

```
Mailgun route store(notify) ──► POST /api/webhooks/mailgun/inbound ──► storeInbound (new fields, unprocessed) ─┐
Catch-up "stored" events ──► fetch or log-only ──► storeInbound (CATCHUP) ───────────────────────────────────────┤
Outbox "Simulate reply" ──► storeInbound (SIMULATED) + processInboundMessage right away ─────────────────────────┤
                                                                                                               ▼
                   event lane (1 s): processPendingInbound → processInboundMessage (one per row, oldest first)
                   internal sender? → link by thread ids → classify → special / from-address / known-contact links
                   → spam and domain hold → twins → kind → scope → effects → notifications → finishCheck
Meanwhile the sending guard (§2.5.1) holds every candidate the unprocessed row could concern, at pick time and again
just before the hand-over.
```

The inbound webhook stays **store-only** (M3 §4.4.1, unchanged): verification, one transaction, 200. Classification
and effects run in the worker's event lane within about a second, and nothing can be sent to the address or company
in between because of the guard. This keeps B6.4's "instant" promise without business logic in the web route
(§12.2 D1).

### 3.2 What is stored (P1 parser, P2 store)

`ParsedInbound` gains (contract §8.6) and `storeInbound` writes:

| Field | From | Rule |
|---|---|---|
| `envelopeSender` | notify form `sender`; stored-message JSON `sender`; log item `envelope.sender`; else the `X-Envelope-From` header | `"<>"`, `""` or only brackets/spaces → `""` (the null sender); missing everywhere → `null` (unknown). Otherwise the bare address, lowercased. |
| `strippedText` | `stripped-text` | newlines kept (`\r\n` → `\n`), at most 8,000 characters; missing or blank → `null` (Mailgun's parse failed) |
| `bodyText` | `body-plain` | newlines kept, at most 16,000 characters; missing → `null` |
| `bodyAvailable` | — | `false` only from `parseStoredLogOnly` (the stored body expired); else `true` |
| `headers` (existing) | `message-headers` | the 200-pair / 32 KB cap now keeps an **allow-list first**: `Content-Type`, `Auto-Submitted`, every `X-Auto*`, `Precedence`, `X-Precedence`, `List-*`, `X-Envelope-From`, `X-Mailer`, `X-Zendesk-*`, `X-Failed-Recipients`, `X-Loop`, `X-MS-Exchange-Inbox-Rules-Loop`, `Feedback-ID`, `Delivered-To`, `X-Mailgun-Sflag`, `X-Mailgun-Sscore`, `X-Mailgun-Spf`, `X-Mailgun-Dkim-Check-Result` (Mailgun's spam marking, B6.8 `spam_action=tag`), `Message-Id`, `In-Reply-To`, `References`, `From`, `To`, `Subject`; then the rest in order |
| `snippet` (existing) | — | unchanged at storage; replaced by the first lines of the new text at processing (§3.10) |

Nothing else about storage changes (dedupe by storage key, else Message-ID + recipient; M3), with one addition (P2,
`storeInbound`'s duplicate path): when the stored row has `bodyAvailable = false` (a log-only recovery, e.g. the
storage fetch was refused) and the new copy has text (a later notify retry), the stored row gets `envelopeSender`,
`strippedText`, `bodyText`, `headers`, `bodyAvailable = true` and the M3 `snippet` from the new copy. A row not yet
processed is then classified with its text; a processed one keeps its kind (someone decides it anyway) but its card
shows the text.

Reply texts are kept for 30 days only: the daily clean-up (P6, `worker/jobs/cleanup.ts`) sets `bodyText` and
`strippedText` to null 30 days after `processedAt` (the waiting-list card and the timeline use the `snippet`, and
decisions use `signals`), so the app never becomes a second inbox (SPEC "no inbox of its own").

### 3.3 Linking (P4 with P1 helpers)

Every time window below is measured from the message's **arrival** (`receivedAt`), never from the processing time, so
M3 backlog rows, catch-up recoveries and retried rows link to the email that was out when the message arrived:
`sentAt ∈ [receivedAt − REPLY_FROM_MATCH_MS, receivedAt]` (90 days).

#### 3.3.0 Internal senders

Before any link: when `fromEmail` is one of our own (a `User.email` or `User.replyInbox`, a `SenderAddress.address`, or
any address on a `SendingDomain.name`), the message is a team member forwarding or noting something (e.g. Ali forwards
Anna's reply to sara@): kind `TEST_REPLY`, `autoReason "internal"`, no effects, no notification, not listed.

#### 3.3.1 By thread ids (headers)

```ts
// src/core/replies/link-ids.ts (P1)
/** In-Reply-To first, then References newest → oldest; lowercase, no angle brackets, de-duplicated, at most 50. */
export function threadIds(m: { inReplyTo: string | null; references: string | string[] | null }): string[];
/** Our own ids found in a text (bounce notices quote the original headers): /pp\.[0-9a-f]{24}@[a-z0-9.-]+/gi. */
export function bodyMessageIds(text: string | null | undefined): string[];
/** Addresses a delivery-failure notice names: X-Failed-Recipients, "Final-Recipient: rfc822; x", the lines after
 *  "Delivery has failed to these recipients or groups:", "wasn't delivered to x", "delivered to one or more … x". */
export function bounceRecipients(input: { headers: readonly HeaderPair[]; text: string | null }): string[];
/** Addresses a challenge-response message names in its subject and first 10 lines of new text (lowercased, unique). */
export function namedRecipients(input: { subject: string; text: string | null }): string[];
```

For each id in order: `OutboundEmail` with `messageId = id` (unique), else `providerId = id` (indexed), else
`TestSend` with `messageId = id` or `providerId = id`. The first **usable** hit wins:
- a TEST or LIVE `OutboundEmail`: always;
- a `DRY_RUN` `OutboundEmail`: only for `source = SIMULATED`, or in the practice copy (`practice.copy` on), where dry
  runs stand in for live sends and the PLAN B12 end-to-end test posts signed reply webhooks to them. On real data a
  real message quoting a dry-run id (they never leave the PC) skips that id;
- a `TestSend`: only when `fromEmail` is that TestSend's `to`, a user's `email`/`replyInbox`, or on the test list
  (`sending.testList`). Otherwise (a prospect replying to a test email someone forwarded to them) the id is skipped and
  linking goes on, so a real reply is never silently filed as a test reply.

**No time limit** on header links.

#### 3.3.2 Special links for bounce notices and challenges

- Nature `BOUNCE` and 3.3.1 found nothing: `bodyMessageIds(bodyText ?? strippedText ?? snippet)` looked up as in 3.3.1
  (method `body-id`), else each `bounceRecipients(…)` address → the newest `OutboundEmail {toNorm, mode ∈ real modes,
  status: SENT, sentAt in the window}` (method `bounce-address`). The from-address and known-contact rules never apply
  to bounce notices (they come from mailer-daemon).
- Nature `AUTO` with `autoReason "challenge"` and 3.3.1 found nothing: each `namedRecipients(…)` address → the newest
  `OutboundEmail {toNorm, mode ∈ real modes, status: SENT, sentAt in the window}` (method `named-address`). A filter
  service writes from its own address with no thread headers, so without this link the sender would never hear that
  their email is held (research V20/V21).

#### 3.3.3 By from-address

When the nature is not `BOUNCE` and nothing linked: the newest `OutboundEmail {toNorm: fromEmail, mode ∈ real modes,
status: "SENT", sentAt in the window}` (index `(toNorm, sentAt)`), method `from`. LIVE includes pre-go-live test-list
sends (so the A8 test works). TEST rows are never matched (Mailgun's test mode delivers nothing). **No domain
matching.**

#### 3.3.3b By known contact (exact address)

Still nothing, nature not `BOUNCE`, and `fromEmail` equals a live `Person.emailNorm` whose company isn't deleted (Ben
at Firma, never emailed or emailed longer ago than the window, writes a new email): link to **that person's company**,
method `person`. `outboundEmailId` = the company's newest `OutboundEmail {companyId, mode ∈ real modes, status: SENT,
sentAt in the window}` (existing index `(companyId, sentAt)`; else null), `campaignId` from it; `personId` = that
email's person (the recipient the reply concerns), else Ben.
Scope from that email (§3.6); no email → real scope, `changesStatus = practiceCopy || goLive`. This is an exact-address
match against a known contact, never a domain match (§12.3 item 16). It makes processing agree with the guard, which
already holds a company while one of its people's messages is unprocessed.

#### 3.3.4 Domain hold (unlinked, reversible)

Still unlinked, nature `REPLY` or `POSSIBLE`, not internal, not spam (§3.5), and `usableEmailDomain(fromEmail)` (never
shared/free-mail domains) equals the `domain` of **exactly one** live company that has open recipients: that company
is held with `holdCompany({reason: "possible-reply", campaignId: null})` and its id is stored in `heldCompanyId` (the
message stays `UNLINKED`: nothing is linked, stopped or marked). It covers a colleague we don't know writing a new
email, and a colleague's reply recovered from the log without headers. Released when the message is linked (to that
company: the hold becomes the reply's stop; to another: released), marked Answered or No answer needed (§3.5). A hold
is reversible, so this is not domain *matching* (PLAN B6.10), but it is listed for the owner (§12.3 item 17).

#### 3.3.5 Otherwise unlinked, with hints for the UI only

`UNLINKED` (human mail) or an unlinked AUTO/BOUNCE (kept kind, null links). The waiting-list card shows hints that
never link by themselves (P1 `@/core/replies/hints`):

| Hint | When | Text |
|---|---|---|
| removed contact | a deleted `Person.emailNorm = fromEmail` exists, or that person's company is deleted | anna@firma.de was Anna Berg at Firma GmbH (C-1042), who was removed. |
| same domain | `usableEmailDomain(fromEmail)` (not shared/free-mail) equals a live company's `domain`; at most 3 companies | Same domain as Firma GmbH (C-1042). |
| on hold | `heldCompanyId` set | Follow-ups to Firma GmbH wait until you link this reply or mark it. |

The Link dialog pre-selects `heldCompanyId`, else the first same-domain company.

### 3.4 Classification (P1, `@/core/replies/classify`)

`classify(input: ClassifyInput): Verdict` is research Appendix A `classify()`, ported into `src/core/replies/`
(`classify.ts`, `phrases.ts`, `quote.ts`), with the regex lists of Appendix A unchanged and these rules:

1. Order of checks exactly as research §8.2: normalise → delivery report → read receipt → help desk →
   challenge-response → strong signals → medium signals → decision.
2. **Unlinked messages** (`linked: false`, Appendix A as written): **AUTO** needs one strong signal (help-desk mail:
   `Auto-Submitted` ignored) or two medium ones; exactly one medium signal, or help-desk mail without an
   acknowledgement → **POSSIBLE**; otherwise **REPLY**.
3. **Linked messages** (`linked: true`: a thread, from-address, known-contact or named-address link was found; the
   processor classifies again after a late link). A mistake here stops nothing and notifies nobody while a person
   waits for an answer, so AUTO needs **at least one strong signal left after the help-desk filter**: `Auto-Submitted`
   other than `no`, `X-Autoreply`/`X-Autorespond`/`X-Autoresponder`/`X-Autoreply-From`/`X-Mail-Autoreply`,
   `Precedence: auto_reply`, the null sender, `Delivered-To: Autoresponder`, an `AUTO_STATEMENT` in the first 10 lines,
   or a strong subject prefix (rule 5). Otherwise:
   - a help-desk acknowledgement or a challenge without a strong signal → **POSSIBLE**, `autoReason` kept as the hint
     (`helpdesk-ack`, `challenge`; a challenge still notifies the sender, §5.1);
   - medium signals alone, however many (text-only absence "I'm away this week, but I'd love a quote"; a CRM that
     stamps `List-Unsubscribe` and `Feedback-ID`) → **POSSIBLE**, never AUTO;
   - no signal → **REPLY**.
4. No text at all (`bodyAvailable === false`) → always **POSSIBLE** (the `autoReason` hint is kept), linked or not.
5. **Subject prefixes:** multi-word `AUTO_SUBJECT_PREFIX` phrases ("automatic reply", "fuera de la oficina") and
   `Auto:` are strong; one-word ones (`absence`, `absent(e)`, `ausencia`, `ausente`, `assenza`, `assente`, `abwesend`,
   `abwesenheit`, `afwezig`, `fravær`, `fråvær`, `frånvaro`, `nieobecny`/`nieobecna`/`nieobecność`, `ooo`, and the
   other single words of the list) are strong only when followed by `:` or ` -`, otherwise **medium** (a new email
   titled "Absence of prices on your site" is not an out-of-office).
6. `X-Auto-Response-Suppress` (All/OOF/AutoReply) and `Precedence: bulk|junk|list` are **medium** only;
   `Precedence: auto_reply` is strong (research §10 items 1–3, owner-visible §12.3).
7. **Challenge-response** needs the URL in the **new text** (`extractNewText`, first 10 lines), not in `fullBody`: our
   own quoted footer and unsubscribe link made the Appendix A condition always true.
8. **Bounce by subject alone isn't enough:** a bounce subject counts only together with a mailer-daemon/postmaster
   From (`BOUNCE_LOCALPART`/`BOUNCE_DISPLAY`), the null sender or bounce text; otherwise the checks go on to the
   reply/auto rules (a human new email titled "Undelivered parcel…" is not a bounce). Structural reports
   (`multipart/report`) are unchanged.
9. **Spam marking:** `X-Mailgun-Sflag: Yes` adds the signal `mailgun-spam` (no effect on the nature; the processor uses
   it for unlinked messages only, §3.5).
10. `sentSubjects`: the subjects of the SENT emails in the linked recipient's thread (step 0..n), so "Re: <our
    subject>" never counts as an auto-subject.
11. Inputs from a row: `subject`, `fromEmail`, `fromName`, `envelopeSender`, `headers`, `strippedText`,
    `bodyPlain = bodyText`, `snippet` (fallback for rows stored under M3), `bodyAvailable`, `linked`.
    `attachmentTypes` is not used (no column; §12.2 D11).
12. Signals are the strings of Appendix A plus `mailgun-spam`; `autoReason` values: `out-of-office`, `auto-reply`,
    `helpdesk-ack`, `challenge`, `left-company`, `read-receipt`, `dsn`, `delay`; plus `process-failed` (§3.8),
    `internal` (§3.3.0) and `spam` (§3.5), set only by P4.
13. **Cost:** `BOUNCE_PROSE`, `DELAY_PROSE`, `DSN_FIELD` and every body regex run on at most the first 4,000 characters;
    a P1 timing test (a 16,000-character single line; 2,000 lines starting with digits) stays under 50 ms per call.
14. Pure, deterministic, no I/O; every research vector V01–V40 and Q01–Q15 is a P1 test, with the vectors' `linked`
    flag taken from their "Kind after linking" column. Expectations that change with rule 3: **V08** (German webmail
    OOF, linked by from-address, no auto headers) and **V21** (challenge without headers, linked by named address) become
    POSSIBLE; V33 stays AUTO (multi-word prefix). New vectors (P1 adds them): (a) "We have received your samples, can
    you quote order #1042" linked → POSSIBLE; (b) a linked reply saying the captcha failed with our footer URL quoted →
    REPLY; (c) "I'm away this week, but when I return I'd love a quote" linked → POSSIBLE; (d) a linked reply with
    `List-Unsubscribe` + `Feedback-ID` only → POSSIBLE; (e) a linked new email "Absence of prices on your site" →
    POSSIBLE (one medium signal, never AUTO), "Abwesend: bis 5.10." → AUTO; (f) "Undelivered parcel" from a person →
    REPLY.

### 3.5 Kinds and what each does

```ts
// src/core/replies/kind.ts (P1)
export function storedKind(nature: Nature, link: LinkTarget): InboundKindValue;
```

| Nature \ link | email, or company (linked without an email) | test (TestSend, §3.3.1) or internal sender (§3.3.0) | none |
|---|---|---|---|
| REPLY | `REPLY` | `TEST_REPLY` | `UNLINKED` |
| POSSIBLE | `POSSIBLE_REPLY` | `TEST_REPLY` | `UNLINKED` (the card says "may be automatic") |
| AUTO | `AUTO_REPLY` | `TEST_REPLY` | `AUTO_REPLY` (null links) |
| BOUNCE | `BOUNCE_NOTICE` | `TEST_REPLY` | `BOUNCE_NOTICE` (null links) |

Effects (scope from §3.6, stored in `replyScope`/`changesStatus`; "status" = only when the scope changes status):

| Kind | Follow-ups | Company status, `repliedAt` | Timeline activity | Notification | Waiting list |
|---|---|---|---|---|---|
| `REPLY` | `stopCompany` in scope (repliers `replied`, others `company_replied`, §2.6); when the replier is a known Person at **another** company, also `stopRecipients({emailNorm: fromEmail, reason: "replied", scope, inboundId})` for their own rows (that company's status and other people are unchanged) | Replied (CAS) + `repliedAt` for the company and the repliers (status scopes only) | `reply.received` (+ `company.status` when it changed) | `reply.received` (§5.1) | yes, until Answered / No answer needed |
| `POSSIBLE_REPLY` | `holdCompany("possible-reply")` in scope | unchanged until "Real reply" | `reply.possible` | `reply.possible` (a challenge: `reply.attention` instead, §5.1) | yes ("Real reply?") |
| `AUTO_REPLY`, linked | none | none | `reply.auto` | none, except `challenge` and `left-company` → `reply.attention` (once per person and reason per 30 days, §5.5) | no |
| `AUTO_REPLY`, unlinked | none | none | none | none | Owner's "Messages we couldn't link" |
| `BOUNCE_NOTICE`, linked, not a delay, and `bounceRecipients()` is empty or contains `email.toNorm` | `stopRecipients({emailNorm: email.toNorm, reason: "bounced", scope, recipientId: email.recipientId, inboundId})` (campaign scope needs `recipientId`, `stops.ts:59-65`); no suppression, no person flag | none | `reply.bounce` | `reply.bounce` | no |
| `BOUNCE_NOTICE`, linked, naming **other** addresses only (Anna's mailbox forwarded our email to a dead address) | none | none | `reply.bounce` ("a forward failed") | `reply.attention` (forward failed, §5.1) | no |
| `BOUNCE_NOTICE`, delay, or unlinked | none | none | `reply.bounce` (delay, linked only) | none | Owner's list (unlinked) |
| `UNLINKED` | none; with a domain hold (§3.3.4) `holdCompany("possible-reply")` for `heldCompanyId` | none | none (Activity page entry without company: `reply.unlinked`) | `reply.unlinked` | yes ("Link to a company") |
| `UNLINKED` marked as spam (`mailgun-spam` signal, `autoReason "spam"`) | none, no domain hold | none | none | none | no: `answeredAt = processedAt`, `answerOutcome "spam"`, no assignee; listed in the Owner's "Messages we couldn't link" as "marked as spam by Mailgun" |
| `TEST_REPLY` | none | none | none | none | no (the reply test's page shows it) |

A linked message's spam flag is ignored (a real reply Mailgun thought was spam is still a reply).

Decisions on the waiting list (service functions in `src/server/services/replies/actions.ts`, P4, §10; every decision
is copied to the row's twins, §3.7):

| Action | Allowed kinds | Effect |
|---|---|---|
| **Answered** / **No answer needed** | REPLY and UNLINKED (both). A POSSIBLE_REPLY is decided first: clicking Answered on it → "Choose Real reply or It was an auto-reply first." | `answeredAt/ById`, `answerOutcome` `answered` / `not-needed`; activity `reply.answered` / `reply.notNeeded`; an UNLINKED row with `heldCompanyId` → `releaseCompanyHold` for that company |
| **Real reply** | POSSIBLE_REPLY | kind `REPLY`, `confirmedAt/ById`; REPLY effects now (stop, status, `repliedAt`, in the stored scope); activity `reply.confirmed`; stays on the list until answered |
| **It was an auto-reply** | POSSIBLE_REPLY | kind `AUTO_REPLY` (keeps `autoReason`, else `auto-reply`), `confirmedAt/ById`; then `releaseCompanyHold` (it releases only recipients no other undecided message still affects, §2.8.2); activity `reply.confirmed` |
| **Link to a company** | UNLINKED | see "Linking by hand" below |
| **Add jonas@firma.de to Firma GmbH** | any linked kind whose `fromEmail` isn't a Person anywhere | `addPerson(actor, companyId, {email, name: fromName})` (existing service); nothing else changes. If the address was added meanwhile: "jonas@firma.de already belongs to C-1042. Link the reply there instead." |
| **Undo** (toast, 10 s) | after Answered / No answer needed | clears the answer fields; an UNLINKED row with `heldCompanyId` is held again (`holdCompany`); activity `reply.reopened` |

**Linking by hand** (`linkReply(actor, id, {companyId, personId?, addPerson?, real?})`):
- **Email:** the newest `OutboundEmail {companyId, mode ∈ real modes, status SENT, sentAt in the window of §3.3}`,
  preferring one to the chosen person; `outboundEmailId`/`campaignId` from it (else null).
- **`personId`:** the chosen person, else that email's `personId` (the campaign's "Replied" count, `queries.ts:330`,
  needs it), else null.
- **Scope and status:** `replyScope` of that email (so a test-mailbox company before go-live doesn't become Replied);
  no email → real scope, `changesStatus = practiceCopy || goLive`. Stored in `replyScope`/`changesStatus`.
- **Assignee:** that email's sender per §4.2; no email → unchanged.
- **Kind:** `linkMethod "manual"`, `confirmedAt/ById`. When the classifier said possible the dialog asks "Is it a real
  reply?": **Yes** (default when it said reply) → kind `REPLY`, REPLY effects in that scope, activities `reply.linked` +
  `reply.received`; **No, it was automatic** → kind `AUTO_REPLY`, activity `reply.auto`, leaves the waiting list,
  nothing stops.
- **Domain hold:** a `heldCompanyId` other than the chosen company is released (`releaseCompanyHold`); the same company
  gets its stop (or, for "automatic", its release).
- Optional "Add as a person" (`addPerson`), as above.

### 3.6 Reply scope (P1 `replyScope`)

```ts
export function replyScope(input: { mode: "DRY_RUN" | "TEST" | "LIVE" | null; link: LinkTarget; simulated: boolean;
  practiceCopy: boolean; goLive: boolean }): { scope: ReplyScope; changesStatus: boolean; label: "" | "Dry run: " | "Test: " };
```

| Linked email | Scope | Changes status | Label |
|---|---|---|---|
| LIVE, after go-live | real (every campaign at the company) | yes | — |
| LIVE, before go-live (a test-list mailbox, M3 §1.7) | real | **no** (§12.3 item 4) | — |
| DRY_RUN in the practice copy (any source: simulated, or a signed webhook as in PLAN B12) | real | yes | — |
| DRY_RUN on real data (simulated only; a real message never links to one, §3.3.1) | campaign (only that campaign) | no | `Dry run: ` |
| TEST (Mailgun test mode; practically impossible) | campaign | no | `Test: ` |
| none, but a company was linked (link `company`: known contact without a recent email §3.3.3b, the fail-safe §3.8, or linked by hand) | real | `practiceCopy \|\| goLive` | — |
| TestSend (reply test, "Send me a test"), internal sender | none | no | — |
| none (unlinked) | none | no | — |

The result is stored on the row (`replyScope`, `changesStatus`) when it is processed, and every later decision ("Real
reply", "It was an auto-reply", releases) uses the stored values, never today's `practice.copy`/`sending.goLive`: a
test-mailbox reply confirmed as real after go-live still doesn't make the test company Replied. The label is derived
from `replyScope = "campaign"` plus the email's mode.

Real scope stops recipients in **every** campaign at the company, dry runs included (they would otherwise keep
filling the outbox with emails a real campaign would never send).

### 3.7 Special cases

| Case | Handling |
|---|---|
| A colleague we don't know replies to a forward (References carry our id) | REPLY linked to the thread's email; the thread's person is the replier (`replied`), everyone else `company_replied`; `fromEmail` isn't a Person → card shows "jonas@firma.de (not in your contacts)" and **Add jonas@firma.de to Firma GmbH**; never created automatically |
| A known person at the company, not the one we emailed (Ben), replies by headers | Ben is the replier: `replied` where he is a recipient, and `Person.repliedAt`; Anna (the thread's person) gets `company_replied` and no `repliedAt`; the stored `personId` stays Anna (the recipient the reply concerns) |
| A known person at **another** company replies to our email to Anna | Anna's company gets the full REPLY effects; Ben's own recipient rows stop (`stopRecipients` by his address, `replied`); Ben's company keeps its status and its other people. For a POSSIBLE nature only Anna's company is held (§1.4); "Real reply" then stops Ben's rows too |
| A known contact who wasn't emailed writes a new email | linked to their company by exact address (§3.3.3b) |
| An unknown address on the company's domain writes a new email | unlinked with a domain hold (§3.3.4) |
| A team member forwards or writes to our address (internal sender) | `TEST_REPLY`, `autoReason "internal"` (§3.3.0): nothing changes |
| Reply to the catch-all or a retired address (`senderAddressId` null, or a retired one) | linking unchanged; assignee = the email's sender; the Owner is also notified when `senderAddressId` is null |
| Reply to Sara's address about Ali's email | assignee Ali; Ali and Sara notified (§4.2) |
| Company is Client / Not interested / Do not contact | status unchanged, still stopped, logged, notified and listed (A5.5) |
| Sender switched off | assignee and notification go to the Owner |
| The linked email is UNKNOWN, UNCONFIRMED, or QUEUED again after the reconciler decided "never received" (TEST/LIVE) | a reply proves it arrived: `markSent(emailId, claimedAt ?? receivedAt, {onlyFrom: ["UNKNOWN", "UNCONFIRMED", "QUEUED"]})` before the effects (failure logged, never blocks). `onlyFrom` (P2 adds it to `MarkSentOptions` in wave 1) makes markSent's CAS `status IN onlyFrom`, so a row the loop has claimed (SENDING) or that Mailgun refused (FAILED) is never touched; then as usual |
| Duplicates (notify + catch-up, retries) | `storeInbound` dedupes (M3); processing CAS on `processedAt` |
| Twins: another processed row with the same **non-empty** `messageIdHeader` and the same `fromEmail`, whose `autoReason` isn't `process-failed` (e.g. To: ali@ and Cc: sara@) | copy kind, links, scope, assignee from the first; `answeredAt = now`, `answerOutcome "duplicate"`; no effects, no activity, no notification. Rows with no Message-ID are never twins. A twin is never undecided (§2.8.2), and every later decision on the first row (Real reply, It was an auto-reply, Link, Answered, No answer needed) is copied to its twins in the same transaction |
| Rows older than 3 days when processed (M3 backlog, long outage) | quiet: everything but their own notification; the assignee gets one grouped `reply.summary` (§5.1); the card says "Arrived on 12 Sep, before the app processed replies." (source NOTIFY) or "Arrived on 12 Sep while the PC was off." (source CATCHUP) |
| Processing fails for good (5 tries spread over about 81 minutes, §3.8) | **fail-safe**, never "release": the company its thread or sender points at is held and the row becomes POSSIBLE_REPLY `process-failed` (§3.8 "Fail-safe after the 5th failure") |
| A reply-test or "Send me a test" reply (sender is the test's `to`, a user or on the test list) | `TEST_REPLY`: nothing changes, M3's reply-test facts keep working (they read `fromEmail`/`toAddress` only) |
| Challenge-response ("confirm you are human") | AUTO_REPLY `challenge` (linked with a strong header, or unlinked; a filter address with no headers is linked by the address it names, §3.3.2); a linked one without a strong signal is POSSIBLE_REPLY with the `challenge` hint; either way `reply.attention` to the sender; the app never opens the link |
| "No longer with the company" | automatic → AUTO_REPLY `left-company`, `reply.attention` naming a suggested address when the text has one (`suggestedContact`, P1); human wording only → POSSIBLE_REPLY (V39) |
| A delivery-failure notice naming another address (a forward from the person's mailbox failed) | BOUNCE_NOTICE, nothing stops, `reply.attention` (§3.5) |
| Read receipt | AUTO_REPLY `read-receipt`, timeline only |

### 3.8 `processInboundMessage` (P4, `src/server/services/replies/process.ts`)

```ts
export const INBOUND_BATCH = 20;
export const QUIET_AFTER_MS = 3 * 86_400_000;          // "3 days"
export const REPLY_FROM_MATCH_MS = 90 * 86_400_000;    // PLAN B6.10 "last 90 days"
export const INBOUND_MAX_FAILURES = 5;
/** Wait before the 2nd, 3rd, 4th and 5th try of a message whose processing threw: 1, 5, 15 and 60 minutes. */
export const INBOUND_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
export type InboundFailures = Map<number, { count: number; nextTryAt: number }>;
export type ProcessedReply = { id: number; kind: InboundKindValue; companyId: number | null; campaignIds: number[] };
export async function processInboundMessage(id: number, opts?: { now?: Date }): Promise<ProcessedReply | null>;
export async function processPendingInbound(opts: { now: Date; limit?: number; failures?: InboundFailures;
  logger?: { error(m: string, e?: unknown): void } }): Promise<{ processed: number; failed: number }>;
```

Steps (reads outside the transaction; one short transaction for the writes):

1. Load the row; `processedAt` set → return null.
2. Settings `practice.copy`, `sending.goLive`, `sending.testList`.
3. Internal sender (§3.3.0) → go to 9 with kind `TEST_REPLY`, `autoReason "internal"`.
4. Link by thread ids (§3.3.1); a usable TestSend hit → go to 9 with kind `TEST_REPLY`.
5. `sentSubjects` from the linked recipient's SENT rows; `verdict = classify({…, linked})`.
6. Not linked: BOUNCE → body-id / bounce-address (§3.3.2); AUTO `challenge` → named-address (§3.3.2); otherwise
   from-address (§3.3.3), then known contact (§3.3.3b). When one of these links, classify again with `linked: true` and
   the new `sentSubjects` (a BOUNCE verdict can't change).
7. Still unlinked, nature REPLY/POSSIBLE: spam (`mailgun-spam`) → `autoReason "spam"`; else the domain hold (§3.3.4).
8. Twin check (§3.7).
9. `kind = storedKind(...)`; `scope = replyScope(...)`; repliers (§2.6); assignee and notify set (§4.2); `quiet =
   receivedAt < now − QUIET_AFTER_MS`; a linked UNKNOWN/UNCONFIRMED/QUEUED TEST/LIVE email → `markSent` with
   `onlyFrom` (§3.7).
10. `dbTx`: CAS `updateMany {id, processedAt: null}` → `{processedAt: now, kind, autoReason, signals, linkMethod,
    outboundEmailId, personId (§3.3: the recipient the reply concerns), companyId, campaignId, replyScope,
    changesStatus, heldCompanyId, assigneeId, answeredAt/answerOutcome (twins, spam), snippet (§3.10)}`; count 0 →
    return null (someone else did it). Then the effects of §3.5 for that kind and scope, the activities, and the
    notifications (a quiet row: the grouped `reply.summary` instead, §5.1), all in the same transaction.
11. After the transaction: `finishCheck(campaignId)` for every campaign `stopCompany`/`stopRecipients` touched.

**`processPendingInbound`**: rows `processedAt: null` and not in back-off (`id notIn` the ids whose `nextTryAt > now`),
ordered `receivedAt asc, id asc`, `limit` `INBOUND_BATCH` (20); each in its own try, with `await setImmediate`-style
yield between messages (CONVENTIONS: the worker's event loop stays responsive). A thrown error increments the id's
`count` in `failures` (the lane's map) and sets `nextTryAt = now + INBOUND_RETRY_DELAYS_MS[count − 1]`, so a bug or a
database busy for longer than `dbTx`'s own retries can't use up the 5 tries in 5 seconds; the guard keeps holding the
company meanwhile (the row is unprocessed).

**Fail-safe after the 5th failure** (one small transaction; never releases anything):
- Companies: the first thread id (§3.3.1 order) that hits an `OutboundEmail` → its `companyId` (TestSend hits and
  dry-run rows on real data ignored); else the live Person with `emailNorm = fromEmail` → their company.
- A company found → `holdCompany({companyId, reason: "possible-reply", campaignId: null})` (real scope), and the row is
  stored as `processedAt = now`, kind `POSSIBLE_REPLY`, `autoReason "process-failed"`, `companyId`, `outboundEmailId`
  when found, `replyScope "real"`, `changesStatus = practiceCopy || goLive`, assignee the Owner. "Real reply" and "It
  was an auto-reply" then work as for any possible reply (the card explains, §9.1.1).
- No company → kind `UNLINKED`, `autoReason "process-failed"`, assignee the Owner.
- Either way: notification `reply.unlinked` with the failure body (§5.1) to the Owner. A row with `autoReason
  "process-failed"` is never anyone's twin source (§3.7).

Simulated replies call `processInboundMessage` directly from the web process (§7.1); the CAS makes a parallel lane
run harmless (PLAN B12 "two processes writing at once": P6's test).

### 3.9 Event lane (P6 wires)

`EventLane({…, processInbound: (o) => processPendingInbound({...o, limit: INBOUND_BATCH, failures}).then((r) =>
r.processed + r.failed)})`; the lane keeps its own `inboundFailures: InboundFailures` map. The lane's option keeps its
shape; P6 passes `INBOUND_BATCH` explicitly (the lane itself calls it with `EVENT_BATCH`, 50, which the spread would
otherwise override, `event-lane.ts:65`). `run()` re-ticks at once when mail events filled `EVENT_BATCH` **or** replies
handled (processed + failed) ≥ `INBOUND_BATCH` (M3 only looked at events; m4-code-map §9.8). `oneRound()` already runs
the lane first.

### 3.10 First lines (the "snippet")

`snippet = firstLines(extractNewText(strippedText, bodyText))` (P1 `quote.ts`, research §7: Mailgun's stripped-text
first, else our cut of body-plain; ≤ 3 lines and 300 characters, stopping at a sign-off), else the stored M3 snippet,
else the subject. Shown on the timeline (`data.snippet`), the waiting-list card and nowhere else. Pop-ups never show it.

### 3.11 Activity entries

| Type | Summary (examples) | Ids | `data` |
|---|---|---|---|
| `reply.received` | `Anna Berg replied: “Re: 3D models for your shop”` · a known colleague: `Ben Braun replied to the email to Anna Berg: “Re: …”` · an unknown one: `jonas@firma.de replied to the email to Anna Berg: “Re: …”` · known contact, new email: `Ben Braun wrote: “Question about prices”` · linked by hand: `jonas@firma.de replied (linked by Ali): “Your 3D offer”` | company, the stored `personId` (the recipient the reply concerns), campaign; mode of the email | `{inboundId, snippet, subject, from, replierPersonIds, emailId, step, linkMethod}` |
| `reply.auto` | `Automatic reply from anna@firma.de (out of office)` (reason words from `autoReasonLabel`) | same | `{inboundId, snippet, autoReason}` |
| `reply.possible` | `Message from anna@firma.de may be a reply: follow-ups wait until someone checks it` | same | `{inboundId, snippet, signals}` |
| `reply.bounce` | `Delivery failure notice for anna@firma.de: follow-ups to this address stopped` · delay: `Delivery delay notice for anna@firma.de (the other server is still trying)` · forward failed: `Delivery failure notice after anna@firma.de's mailbox forwarded the email: follow-ups continue` | same | `{inboundId, delay, forwardFailed}` |
| `reply.unlinked` | `Reply from jonas@firma.de that couldn't be linked to a company` (+ ` (follow-ups to Firma GmbH wait)` with a domain hold) | none, or `heldCompanyId` as company | `{inboundId, subject, heldCompanyId}` |
| `reply.confirmed` | `Ali marked the message from anna@firma.de as a real reply` / `… as an automatic reply: follow-ups continue` | company, person, campaign | `{inboundId, real}` |
| `reply.linked` | `Ali linked the reply from jonas@firma.de to Firma GmbH` | company | `{inboundId}` |
| `reply.answered` / `reply.notNeeded` / `reply.reopened` | `Ali answered the reply from anna@firma.de` / `Ali marked the reply from anna@firma.de as needing no answer` / `Ali put the reply from anna@firma.de back on the waiting list` | company, person | `{inboundId}` |
| `company.status` (existing type) | `Status changed to Replied: anna@firma.de replied` | company, person, campaign | `{field, from, to, automatic: true}` |
| `followups.held` / `followups.released` | §2.8.3 (date-free summaries; the Activity page renders `data.from`/`data.to` in the viewer's time zone as a second line "Replies from 3 Oct to 9 Oct may have been missed." — the unchecked window, not the PC's off-time, review SPEC-03) | none | `{from, to, count, senderId}` |

`reply.*` entries appear under the company timeline's "Replies" filter (existing) and on the campaign page's
per-person timeline (existing query by `campaignId, personId`). P5 adds icons for the new types and `followups.` to
the Activity page's "Emails" group.

---

## 4. Replies waiting for an answer

### 4.1 Data

A reply is **waiting** when `kind ∈ {REPLY, POSSIBLE_REPLY, UNLINKED}` and `answeredAt IS NULL` and `processedAt IS NOT
NULL`. (The app can't see inboxes, so it stays until someone clicks Answered or No answer needed, PLAN Q7.) Built from
`InboundMessage`, never from notifications (read notifications are deleted after 90 days). Twins and spam are never
waiting (their `answeredAt` is set at processing).

**Dry-run replies** (`replyScope = "campaign"`: a simulated reply on real data, or Mailgun's test mode) are **listed**
with their "Dry run"/"Test" badge, so the workflow can be practised, but **not counted**: `waitingReplyCount` (the
bell line) and M6's tile count only rows whose `replyScope` isn't `"campaign"`. In the practice copy simulated replies
are real scope, so they count.

### 4.2 Who sees and does what

| Role | Assignee (`assigneeId`) | Notified (unless quiet) |
|---|---|---|
| Linked (email or manual link) | the email's campaign sender (`OutboundEmail.senderId`) when active, else the Owner | assignee; plus the owner of `toAddress` (`SenderAddress.userId`, active) when different; plus the Owner when `senderAddressId` is null (catch-all) |
| Linked to a company without an email (known contact §3.3.3b, fail-safe) | `toAddress`'s user when active, else the Owner (fail-safe: the Owner) | assignee (+ Owner for the catch-all) |
| Unlinked human | `toAddress`'s user when active, else the Owner | assignee (+ Owner for the catch-all) |
| Simulated (`source SIMULATED`) | the campaign's sender when active, else the Owner | **only** the assignee: the `toAddress`-owner and catch-all rules are skipped (a dry run of a sender who has a real address uses that address, `addresses.ts:6-11`, and a placeholder address has no `SenderAddress`, which would otherwise *trigger* the catch-all rule) |
| AUTO / BOUNCE unlinked, spam, TEST_REPLY | none | none |

- **Everyone** (SPEC §1: Members can do everything but settings and users) sees "Yours" and "Everyone's" and may act on
  any waiting reply. Default view: "Everyone's" for the Owner, "Yours" for Members. On Everyone's, each card shows
  "Waiting for Ali"; every action is logged with who did it (the activities of §3.11), so acting on a teammate's reply
  is visible.
- A switched-off user's unanswered waiting replies (`assigneeId = target, answeredAt null, kind ∈ WAITING_KINDS`) are
  reassigned to the active Owner inside `deactivateUser`'s transaction (P5), so they never fall out of every "Yours"
  list and the bell counts.
- Order: oldest first (`receivedAt asc`), 50 per page.

### 4.3 Where it lives

On the Notifications page, above the notification list (§9.1), until M6's dashboard. The bell's menu shows a line
"3 replies waiting for your answer" linking to `/notifications#replies` (P5), fed by `waitingReplyCount(userId)` (P2).
A reply notification links to `/notifications?reply=<id>#replies`: the page **pins that reply above the list**
(whatever page or view it is on, loaded by id with the same view builder) and highlights it; an id that isn't waiting
any more shows the one-line notice "This reply isn't on the list any more." instead. On a phone (≤ 640 px) the page
is one column: cards stack, their actions wrap onto a second line, and the Link dialog opens full screen (step S checks
it at 390 px, SPEC "usable on a phone for checking replies").

---

## 5. Notifications

### 5.1 Types (B6.14 list, complete)

Copy builders for the `reply.*` types live in P1 (`@/core/replies/copy`) so the processor, simulate and tests agree.
`<prefix>` is the scope label of §3.6 (`Dry run: ` / `Test: ` / nothing).

| Type | To | Title | Body | Link | Pop-up group |
|---|---|---|---|---|---|
| `reply.received` | §4.2 | `<prefix>New reply from Firma GmbH` | `Anna Berg replied to “3D models for your shop”.` · colleague: `Ben Braun replied to your email to Anna Berg (“3D models for your shop”).` (unknown colleague: `jonas@firma.de replied …`) · known contact, new email: `Ben Braun wrote to you: “Question about prices”.` · no company name: title `<prefix>New reply from anna@firma.de` | `/notifications?reply=<id>#replies` | reply |
| `reply.possible` | §4.2 | `<prefix>Did Firma GmbH really reply?` | `The app can't tell whether Anna Berg's message is a real reply or an automatic one. Their follow-ups wait until you choose.` | same | reply |
| `reply.unlinked` | §4.2 | `A reply we couldn't link to a company` | `From jonas@firma.de: “Your 3D offer”. Link it to a company so the right follow-ups stop.` (+ ` Follow-ups to Firma GmbH wait until you do.` with a domain hold) · failure: `The app couldn't read a message from jonas@firma.de, so it's listed here. Open it in your inbox, then decide on the Notifications page.` (+ ` Follow-ups to Firma GmbH wait until you do.` when the fail-safe held a company) | same | reply |
| `reply.summary` | each assignee of quiet rows | `Older replies were found` | `They arrived more than 3 days ago, while the app couldn't process them. They're on Replies waiting for an answer.` | `/notifications#replies` | reply |
| `reply.attention` (challenge) | sender | `<prefix>Anna Berg's spam filter is holding your email` | `It asks you to confirm you're a person. Open the message in your own inbox if you want to; the app never clicks such links. Follow-ups continue.` · when filed as a possible reply (§3.4 rule 3): last sentence `Follow-ups to Firma GmbH wait until you choose Real reply or It was an auto-reply.` and link `/notifications?reply=<id>#replies` | `/contacts?company=<id>` | reply |
| `reply.attention` (left company) | sender | `<prefix>Anna Berg has left Firma GmbH` | `Their automatic reply suggests info@firma.de instead. Follow-ups to Anna continue unless you skip her in the campaign.` (no suggestion: drop the first sentence) | `/campaigns/<id>?recipient=<rid>` | reply |
| `reply.attention` (forward failed) | sender | `<prefix>A forward from Anna Berg's mailbox failed` | `Anna's mailbox passed your email on to another address, and that address doesn't work. Anna's own address is fine, so her follow-ups continue.` | `/campaigns/<id>?recipient=<rid>` | reply |
| `reply.bounce` | sender | `<prefix>An email to anna@firma.de couldn't be delivered` | `A mail server sent back a delivery failure notice, so the follow-ups to this address stopped.` | `/campaigns/<id>?recipient=<rid>` | — |
| `outage.hold` | each affected active sender | `Follow-ups are on hold: replies from 3 Oct to 9 Oct may have been missed` (the unchecked window, not the PC's off-time) | `The PC was off too long for the app to see every reply. Check your inbox for replies to your campaigns from those days, then click I've checked my inbox. Follow-ups of 8 people are waiting.` (+ ` First emails to 2 other people at those companies wait too.` when there are any) | `/notifications#on-hold` | outage |
| `outage.hold` | Owner (also when a sender) | same title | `Follow-ups of 12 people wait until their senders have checked their inbox (Ali 8, Sara 4). You can continue them for anyone in Settings › Sending & Mailgun.` | `/settings/sending` | outage |
| `campaign.finished` | sender + creator (existing) | existing | existing | existing | campaign |
| `campaign.sender`, `campaign.reservationsExpired` | existing | existing | existing | existing | — |
| `sending.paused`, `sending.warning`, `sending.capReached`, `email.complained`, `email.unconfirmed`, `restore.checked` | existing (M3) | existing | existing | existing | `sending.paused`, `sending.warning`, `email.complained` → sending (Owner) |
| `ai.draftsReady`, `verify.finished` | M5 | — | — | — | — |
| `auth.lockout`, `user.*`, `system.*`, `task.failed`, `backup.*` | existing | existing | existing | existing | — |

The Owner gets one `outage.hold` (the Owner body) even when the Owner is also a sender with held follow-ups; the sender
body's action text then also applies to them on the Notifications page. Every date in a notification is written in
**the receiving user's own `timeZone`** (the notification is built per user, SPEC "times in each user's own time
zone"); activity summaries carry no dates (§3.11).

### 5.2 The bell (P5)

| Situation | Behaviour |
|---|---|
| Tab visible | poll `GET /api/notifications/summary?after=<lastShown>` every 20 s ± 2 s (a `setTimeout` chain) |
| Tab hidden, pop-ups on in this browser | poll every 60 s (Chrome/Edge clamp hidden timers to 1/min after 5 min anyway) |
| Tab hidden, pop-ups off | no polling (PLAN "pauses while the tab is hidden") |
| Tab becomes visible, window focus, `NOTIFICATIONS_CHANGED_EVENT` | poll at once (existing events; keep exporting `NOTIFICATIONS_CHANGED_EVENT` from `notification-bell.tsx`, P4 imports it) |
| 401 | stop polling (existing) |
| Unread count | neutral badge (existing) |
| Waiting replies | menu line `3 replies waiting for your answer` (`1 reply waiting …`) above the list, link `/notifications#replies` |

**Summary endpoint** (P5, `src/app/api/notifications/summary/route.ts`): `GET` with optional `after` (integer ≥ 0).
Response `{ userId, unread, latest (5), latestId, waitingReplies, legacyDesktopReplies, popups: { items, count,
latestId } }`, `Cache-Control: no-store`. `popups` = `popupsAfter(userId, {after, types:
popupTypesFor(prefs.popupGroups, user.role), now})` (P2): notifications with `id > after`, of those types, `createdAt
≥ now − 10 min`; `items` = at most 5, oldest first; `count` = how many match in total; `latestId` = the highest
matching id. **Empty (`{items: [], count: 0, latestId: null}`) when `after` is missing** (the first poll after a page
load only records `latestId`). The old `desktopReplies` field is renamed `legacyDesktopReplies` (only the per-browser
default of §5.3).

### 5.3 Desktop pop-ups (research Part A decision)

Computer only, no service worker, no push. The pure decisions are P1's (`@/core/notifications/popups`):

```ts
export type PopupPanelState = "insecure" | "phone" | "ask" | "on" | "off" | "blocked" | "unsupported";
export function popupPanelState(i: { secure: boolean; hasApi: boolean; coarsePointerOnly: boolean;
  permission: "default" | "granted" | "denied"; localOn: boolean | null; legacyDesktopReplies: boolean; failed: boolean }): PopupPanelState;
export function pollDelayMs(i: { hidden: boolean; popupsOn: boolean; random: () => number }): number | null; // 20 000 ± 2 000 | 60 000 | null
export function shouldPopUp(i: { hidden: boolean; focused: boolean }): boolean;                             // hidden || !focused
/** count > 3 → one batch pop-up ("N new notifications"), newLast = latestId; else show the items above lastShown. */
export function pickPopups<T extends { id: number }>(popups: { items: readonly T[]; count: number; latestId: number | null },
  lastShown: number): { show: T[]; batch: number | null; newLast: number };
```

- "On in this browser" is `localStorage["pp.popups.on.<userId>"]` = `"on"`/`"off"` (wrapped in try/catch). Missing →
  on when the M1–M3 account switch `desktopReplies` was on, else off.
- Shown only when `permission === "granted"`, the local switch is on, `shouldPopUp`, and the id is above
  `localStorage["pp.popups.last.<userId>"]` (high-water mark; written after showing).
- `new Notification(title, { body, tag: "pp-n-<id>", icon: "/icon-192.png" if present else none, data: { link } })`;
  more than 3 new (`count`, not just the 5 returned) → **one** pop-up `30 new notifications` / `Open the app to see
  them.`, tag `pp-n-batch`, link `/notifications`, and the high-water mark jumps to `latestId` (never six "5 new
  notifications" pop-ups in a row). No `renotify`, no `requireInteraction`.
- Click: `window.focus()`, `close()`, navigate with the existing `useGuardedNavigate`.
- A constructor that throws → store `pp.popups.unsupported.<userId> = "1"` and show the phone text in Settings.

### 5.4 Settings › Notifications (P5, everyone)

Card **"Pop-ups on this computer"**, exactly one state (copy in §9.6), and card **"What pops up"** with the pop-up
groups, saved per account in `User.notifyPrefs.popupGroups` (JSON, no migration):

| Group | Checkbox | Default | Who |
|---|---|---|---|
| reply | New replies, and messages you need to check | on | everyone |
| outage | Follow-ups put on hold after the PC was off | off | everyone |
| campaign | A campaign finished | off | everyone |
| sending | Sending paused, bounce and spam warnings | off | Owner only (ignored for Members) |

### 5.5 The Notifications page (P4) and throttling

- Page sections (top to bottom): the pinned reply (`?reply=`, §4.3), On hold card (when the viewer has held
  follow-ups or first emails waiting), "Replies waiting for an answer", "All notifications" with filter chips **All ·
  Unread · Replies · Campaigns · Sending and system** (`notificationFilterOf`, contract §8.5), Mark all read, 50 per
  page; Owner only: "Messages we couldn't link (last 30 days)" (automatic messages, delivery notices and spam that
  weren't linked), collapsed. Exact copy in §9.1.
- Opening a notification marks it read (existing). "Mark all read" (existing action).

| Throttle / dedupe | Rule |
|---|---|
| One notification per reply per person | the notify set of §4.2 is de-duplicated (`notifyUsers`, P2) |
| Twins, spam | none |
| Quiet (older than 3 days) | no notification of their own; `reply.summary` to each assignee, **skipped when that user already has an unread `reply.summary` created in the last 24 hours** (checked in the processing transaction), so a backlog of any size gives each person one notification a day at most |
| `reply.attention` | once per (person, or `fromEmail` when unlinked, and `autoReason`) per 30 days: skipped when an earlier row with the same key was processed in the last 30 days (a challenge filter or a "left the company" auto-reply answers every follow-up); the timeline entry is still written |
| `reply.bounce` | naturally once: the address stops |
| `outage.hold` | once per applied outage hold, per sender, plus one for the Owner |
| Pop-ups | only types of the chosen groups, only the last 10 minutes, at most 5 per poll, one batch pop-up when more than 3 are new, never twice (tag + high-water mark) |
| M3 notices | unchanged (`shouldSendNotice`) |

---

## 6. "Who has been emailed" everywhere: what's missing today and the fix

| # | Place (SPEC §3, A6) | Today | Fix | Package |
|---|---|---|---|---|
| 1 | `Company.repliedAt`, `Person.repliedAt` | never written | written by REPLY effects in status scopes (§2.7) | P4 |
| 2 | Company panel "Emailed" banner | no reply fact | `emailedSummary` appends `replied 2 days ago` (lowercase part, after the sequence) when `repliedAt` is set; a never-emailed company that replied: `Never emailed · replied 2 days ago` | P5 |
| 3 | Company panel people rows | "Replied" flag exists but was never set | flag now appears; its tooltip `Replied on 3 Oct` | P5 (P4 writes) |
| 4 | Panel / Sequence column held and reply stops | texts assumed M4 codes; HELD had one text | §2.12 texts from `holdStateText`; `holdReason` selected by `companySequences`, `getCompanyDetail`, `listCampaignRecipients`, `getRecipientDetail` | P3 (queries, campaign format), P5 (detail, emailed-text) |
| 5 | Suffix mismatch (`countsAsReal` vs `countsAsEmailed`), no "(test list)" | inconsistent | `sequenceSuffix` everywhere (§2.12) | P3, P5 |
| 6 | Contacts "Last emailed" tooltip | no reply | `lastEmailedTitle` adds a line `Replied 2 days ago` (row gains `repliedAt` from `companies/query.ts`) | P5 |
| 7 | Campaign page per-person timeline | no replies (nothing wrote them) | reply activities carry `campaignId` + thread `personId` (§3.11); the panel shows them through the existing timeline; the panel links "Simulate a reply in the dry-run outbox" for dry runs | P4 (data), P3 (link) |
| 8 | Campaign "Replied" count | reads `InboundMessage {campaignId, kind: REPLY, personId}` but nothing wrote it | filled by processing; unchanged query (index `(campaignId, kind)` added) | P4 |
| 9 | Import check flags | no replied flag | flag `Replied 3 days ago` (company `repliedAt`) or `anna@firma.de replied 3 days ago` (person), tone neutral | P5 |
| 10 | Team-rule and eligibility texts | fine | unchanged ("Company status is Replied (you can include it by hand)"); the override now only covers earlier replies (§2.7) | — |
| 11 | Activity page filter | `followups.*` not grouped | `followups.` added to the "Emails" group | P5 |
| 12 | Company timeline icons | none for the new types | icons for `reply.possible`, `reply.bounce`, `reply.unlinked`, `reply.confirmed`, `reply.linked`, `reply.answered`, `reply.notNeeded`, `reply.reopened`, `followups.*` (lucide `MessageCircleQuestion`, `MailX`, `Link`, `CheckCheck`, `PauseCircle`…) | P5 |

---

## 7. Test tools

### 7.1 Simulate a reply (dry runs only; P4)

The outbox's Simulate row (existing, `simulate-buttons.tsx`) gains three buttons after the M3 four: **Reply**,
**Out-of-office**, **Unclear reply**. They exist only for `mode = DRY_RUN`, `status = SENT` emails (as M3). The
campaign's recipient panel (P3) shows, for dry runs, the link "Simulate a reply in the dry-run outbox" to the latest
sent email of that person (`outboxHref({campaignId, open: emailId})`, existing helper).

```ts
// src/server/services/mail-events/simulate.ts (P4)
export type SimulateReplyKind = "reply" | "out-of-office" | "unclear";
export async function simulateReply(actor: { id: number; name: string }, emailId: number, kind: SimulateReplyKind, opts?: { now?: Date }): Promise<{ message: string }>;
```

1. Refusals (same as M3): not DRY_RUN → `Only dry-run emails can be simulated. Real emails get their replies from real
   mailboxes.`; not SENT → `This email hasn't gone out yet, so there's nothing to reply to.`
2. Once per email and kind: `storageKey = "sim:<emailId>:<kind>"`; a second click → `Already simulated.`
3. Store an `InboundMessage` (source `SIMULATED`) through `storeInbound`: `recipient` = the email's From address,
   `fromEmail` = the email's `toEmail`, `fromName` = the person's name, `inReplyTo` = the email's `messageId`,
   `references` = its references + messageId, `receivedAt = now`, `messageIdHeader = "sim.<emailId>.<kind>@simulated.invalid"`:

   | Kind | Subject | Text | Headers, envelope |
   |---|---|---|---|
   | reply | `Re: <email subject>` | `Hi <sender first name>,\n\nThanks, this sounds interesting. Could you send a few examples and your prices?\n\nBest,\n<person first name>` | — |
   | out-of-office | `Automatic reply: <email subject>` | `I am out of the office until next Monday with limited access to email.` | `Auto-Submitted: auto-replied`, `X-Autoreply: yes`; envelope `""` |
   | unclear | `Re: <email subject>` | `I'm out of the office this week, but yes, we're interested. Please send details.` | — |

4. `processInboundMessage(id)` right away (the lane would too). Notifications go to the campaign's sender only
   (§4.2 "Simulated").
5. Messages (toast):

   | Kind | Real data (campaign scope) | Practice copy (real scope) |
   |---|---|---|
   | reply | `Simulated a reply from anna@firma.de. In a dry run it only stops this campaign's emails to Firma GmbH; statuses don't change.` | `Simulated a reply from anna@firma.de: Firma GmbH is now Replied and its follow-ups stopped in every campaign.` |
   | out-of-office | `Simulated an out-of-office reply from anna@firma.de. It's logged as automatic, so follow-ups continue.` | same |
   | unclear | `Simulated an unclear reply from anna@firma.de. Follow-ups to Firma GmbH wait until someone chooses Real reply or It was an auto-reply on the Notifications page.` | same |

   If processing classified differently than intended (it shouldn't), the message says what the app decided:
   `Simulated a message from anna@firma.de; the app filed it as <kind words>.`

The Simulate row's help line becomes: "Test what happens when Mailgun reports back, or when the person answers.
<M3's scope sentence>" and the results line adds `Replied`, `Automatic reply`, `Possible reply` from the email's
linked `InboundMessage` rows.

### 7.2 What a simulated reply does per scope

As §3.5/§3.6: real data → only that campaign (no status, no `repliedAt`, "Dry run:" labels, the card shows a "Dry run"
badge on the waiting list so the workflow can be practised, and it isn't counted in the bell's waiting line, §4.1);
practice copy → every campaign, status, `repliedAt`, no labels, counted.

### 7.3 The fake Mailgun's inbound (P2), for tests and the lead's manual checks

`receive(input)` gains (research §9), all optional:

| Input | Effect |
|---|---|
| `envelopeSender?: string` (`""` = null sender) | notify field `sender` and stored `sender`; header `X-Envelope-From: <…>` or `<>`; the Logs `stored` event's `envelope.sender` |
| `strippedText?: string \| null` | `null` omits `stripped-text` (Mailgun's parse failed); default = `text` |
| `bodyPlain?: string` | `body-plain` (default `text`) |
| `contentType?: string` | replaces the default `Content-Type: text/plain; charset=utf-8` header |
| `messageId?: string` | fixed `Message-Id` (forward and twin scenarios) |
| `fromName?: string` | display name in the `From` header |
| `at?: Date` | already exists |

Admin `POST /__fake/inbound` accepts every field above plus `headers: [[name, value]]`, `at` (ISO), and
`preset: "reply" | "out-of-office" | "unclear" | "bounce-notice" | "new-email" | "spam"` with `inReplyTo` naming one of
the fake's own sent messages (`fake.messages`): the preset takes `from` = that message's `to`, `to` = its From address,
`subject` = `Re: <its subject>` / `Automatic reply: <its subject>` / `Undeliverable: <its subject>`, and the headers,
envelope and text of the §7.1 table (bounce-notice: `from mailer-daemon@<recipient domain>`, `contentType
multipart/report; report-type=delivery-status; boundary="b"`, envelope `""`, text `Delivery has failed to these
recipients or groups:\n\n<to>\nThe email address couldn't be found.\n\nOriginal message headers:\n\nMessage-ID: <<id>>`;
new-email: no thread headers, subject `Question`; spam: no thread headers, `from offers@bulk-mailer.example`, subject
`Grow your sales 300% this month`, headers `X-Mailgun-Sflag: Yes`, `X-Mailgun-Sscore: 12.5`). Explicit fields override
the preset. `notify: true` posts the signed notification to `--app` (existing).

Lead's manual check additions (after M3-DESIGN §6.3's recipe):
`Invoke-RestMethod -Method Post http://127.0.0.1:4010/__fake/inbound -ContentType application/json -Body '{"preset":"out-of-office","inReplyTo":"pp.…@send.example.com","notify":true}'`.

Test helpers (P2, `tests/integration/helpers/replies.ts`): `postInbound(fake, input)` (receive + signed POST through
the route handler in-process), `replyTo(fake, email, overrides)` (works for dry-run rows too: it threads to the row's
`messageId`, for the practice-copy end-to-end test), `vectorInput(vector)` (research vector → fake input).

---

## 8. Settings, state, schema and contracts (step C)

### 8.1 Settings

**No new Owner-edited settings.** The reply constants live in code (`QUIET_AFTER_MS`, `REPLY_FROM_MATCH_MS`,
`INBOUND_MAX_FAILURES`, `INBOUND_RETRY_DELAYS_MS`; `CLEANUP_RULES.replyTextsDays = 30` in `worker/jobs/cleanup.ts`).
Existing settings read by new code: `sending.window`, `defaultTimeZone`, `practice.copy`, `sending.goLive`,
`mailgun.logRetentionDays` (outage), `sending.testList` (the guard, TEST_REPLY rule).

Per-user JSON `User.notifyPrefs` (no migration): `{ popupGroups: PopupGroup[], desktopReplies?: boolean }` (the second
is M1–M3's switch, read only as the per-browser default, §5.3). Parsed by `readNotifyPrefs` (contract §8.5).

### 8.2 SystemState

| Key | Change | Written by | Read by |
|---|---|---|---|
| `catchup.outage` | `OutageState` gains `heldFor: string \| null`, `heldTo: string \| null` and `heldCount: number` (§8.6); `handledAt` now means "the hold of this outage was applied (or none was needed)" | P2 `applyOutageHold` and the catch-up's gap record (§2.8.3) | P3 gates, Settings › Sending; P2 summaries |
| `sending.pacer` | `WaitReason` gains `"outage-hold"` and `"possible-reply"` | P3 | P3 pages |
| everything else | unchanged | — | — |

No new notice keys.

### 8.3 Prisma schema diff (`prisma/schema.prisma`)

```diff
 enum InboundKind {
   REPLY
   AUTO_REPLY
   BOUNCE_NOTICE
   POSSIBLE_REPLY
   UNLINKED
+  /// A reply to a test email (the reply test or "Send me a test"): recorded, never changes anyone (M4-DESIGN §3.5).
+  TEST_REPLY
 }
```

```diff
 model CampaignRecipient {
   …
   currentStep     Int            @default(0)
   nextDueAt       DateTime?
+  /// While HELD: why, sorted and comma-joined: "outage", "possible-reply" or "outage,possible-reply" (M4-DESIGN §2.8).
+  /// Meaningless unless state = HELD; cleared on every move out of HELD.
+  holdReason      String?
+  /// When the current hold started.
+  heldAt          DateTime?
+  /// The InboundMessage whose reply stopped this recipient (M4-DESIGN §2.6), for a later "undo a real reply".
+  stoppedByInboundId Int?
   hasEdits        Boolean        @default(false)
   …
 }
```

```diff
 model InboundMessage {
   …
   headers         Json?
+  /// SMTP MAIL FROM as Mailgun reported it: "" = the null sender <>; null = not known (rows stored before M4).
+  envelopeSender  String?
+  /// Mailgun's stripped-text (the new text), newlines kept, at most 8,000 characters.
+  strippedText    String?
+  /// Mailgun's body-plain, newlines kept, at most 16,000 characters.
+  bodyText        String?
+  /// false: recovered from Mailgun's log after the stored message expired (no text at all).
+  bodyAvailable   Boolean       @default(true)
   kind            InboundKind?
   autoReason      String?
+  /// The classifier's signals (JSON array of strings), for the "why" line and tests.
+  signals         Json?
+  /// How it was linked: "headers" | "body-id" | "from" | "person" | "bounce-address" | "named-address" | "manual" | "simulated".
+  linkMethod      String?
+  /// Which recipients it may change, fixed when processed (M4-DESIGN §3.6): "real" | "campaign" | "none".
+  replyScope      String?
+  /// Whether it may set the company Replied and repliedAt (fixed when processed, §3.6).
+  changesStatus   Boolean?
+  /// UNLINKED only: the company held because the sender's address is on its domain (M4-DESIGN §3.3.4).
+  heldCompanyId   Int?
   outboundEmailId Int?
   personId        Int?
   companyId       Int?
   campaignId      Int?
+  /// Who should answer it (M4-DESIGN §4.2): the campaign's sender while active, else the Owner.
+  assigneeId      Int?
   answeredAt      DateTime?
   answeredById    Int?
+  /// "answered" | "not-needed" | "duplicate" (a twin of a message already processed) | "spam" (unlinked, marked by Mailgun).
+  answerOutcome   String?
   confirmedAt     DateTime?
   confirmedById   Int?
   …
   @@index([processedAt])
   @@index([companyId])
   @@index([fromEmail])
   @@index([messageIdHeader])
+  @@index([assigneeId, answeredAt])
+  @@index([kind, answeredAt])
+  @@index([campaignId, kind])
 }
```

Nothing else changes (no relations added; `InboundMessage` keeps no foreign keys, as M1).

### 8.4 Migration `prisma/migrations/20260923220000_m4_sequences_replies/migration.sql`

```sql
-- Milestone 4 (sequences and replies): new nullable/defaulted columns and three indexes. Safe on existing data.
-- InboundKind gains TEST_REPLY: SQLite stores enums as TEXT, so no statement is needed for it.

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN "holdReason" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "heldAt" DATETIME;
ALTER TABLE "CampaignRecipient" ADD COLUMN "stoppedByInboundId" INTEGER;

-- AlterTable
ALTER TABLE "InboundMessage" ADD COLUMN "envelopeSender" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "strippedText" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "bodyText" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "bodyAvailable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "InboundMessage" ADD COLUMN "signals" JSONB;
ALTER TABLE "InboundMessage" ADD COLUMN "linkMethod" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "replyScope" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "changesStatus" BOOLEAN;
ALTER TABLE "InboundMessage" ADD COLUMN "heldCompanyId" INTEGER;
ALTER TABLE "InboundMessage" ADD COLUMN "assigneeId" INTEGER;
ALTER TABLE "InboundMessage" ADD COLUMN "answerOutcome" TEXT;

-- CreateIndex: the waiting list per person.
CREATE INDEX "InboundMessage_assigneeId_answeredAt_idx" ON "InboundMessage"("assigneeId", "answeredAt");

-- CreateIndex: the Owner's "Everyone's" waiting list.
CREATE INDEX "InboundMessage_kind_answeredAt_idx" ON "InboundMessage"("kind", "answeredAt");

-- CreateIndex: the campaign page's "Replied" count.
CREATE INDEX "InboundMessage_campaignId_kind_idx" ON "InboundMessage"("campaignId", "kind");

-- Data: replies the M3 catch-up recovered from Mailgun's log only (no text) have no body to classify.
UPDATE "InboundMessage" SET "bodyAvailable" = false WHERE "source" = 'CATCHUP' AND "snippet" = '' AND "processedAt" IS NULL;
```

The lead checks the DDL against `prisma migrate diff` (the final `UPDATE` is hand-added), confirms the diff shows no
statement for the enum value, then runs `npx prisma generate`. The supervisor applies it with `migrate deploy` on the
next start (M2/M3 path).

### 8.5 `src/core/notification-types.ts` (new contract file, with code; P1 owns its tests)

```ts
/**
 * Milestone 4 contract (docs/dev/M4-DESIGN.md §5): notification types, pop-up groups, list filters and the per-user
 * preferences. Browser-safe, no I/O. The server, the summary route, the bell, the Notifications page and Settings ›
 * Notifications all use these, so a type is grouped the same way everywhere.
 */
export const REPLY_NOTIFICATION = {
  received: "reply.received",
  possible: "reply.possible",
  unlinked: "reply.unlinked",
  attention: "reply.attention",
  bounce: "reply.bounce",
  summary: "reply.summary",
} as const;
export const OUTAGE_HOLD_NOTIFICATION = "outage.hold";

export const POPUP_GROUPS = ["reply", "outage", "campaign", "sending"] as const;
export type PopupGroup = (typeof POPUP_GROUPS)[number];
export const DEFAULT_POPUP_GROUPS: readonly PopupGroup[] = ["reply"];
export const OWNER_ONLY_POPUP_GROUPS: readonly PopupGroup[] = ["sending"];
export const POPUP_GROUP_TYPES: Readonly<Record<PopupGroup, readonly string[]>> = {
  reply: ["reply.received", "reply.possible", "reply.unlinked", "reply.attention", "reply.summary"],
  outage: ["outage.hold"],
  campaign: ["campaign.finished"],
  sending: ["sending.paused", "sending.warning", "email.complained"],
};
export function popupGroupOf(type: string): PopupGroup | null {
  for (const g of POPUP_GROUPS) if (POPUP_GROUP_TYPES[g].includes(type)) return g;
  return null;
}
/** The notification types a person's pop-up groups cover (Owner-only groups dropped for Members). */
export function popupTypesFor(groups: readonly PopupGroup[], role: "OWNER" | "MEMBER"): string[] {
  return groups
    .filter((g) => role === "OWNER" || !OWNER_ONLY_POPUP_GROUPS.includes(g))
    .flatMap((g) => [...POPUP_GROUP_TYPES[g]]);
}

export type NotifyPrefs = {
  popupGroups: PopupGroup[];
  /** Milestones 1–3's "Desktop pop-ups for new replies" switch: only the per-browser default now. */
  desktopReplies: boolean;
};
export function readNotifyPrefs(value: unknown): NotifyPrefs {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const raw = Array.isArray(obj.popupGroups) ? obj.popupGroups : null;
  const groups = raw
    ? POPUP_GROUPS.filter((g) => raw.includes(g))
    : [...DEFAULT_POPUP_GROUPS];
  return { popupGroups: groups, desktopReplies: obj.desktopReplies === true };
}

export const NOTIFICATION_FILTERS = ["all", "unread", "replies", "campaigns", "system"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];
export const NOTIFICATION_FILTER_LABELS: Readonly<Record<NotificationFilter, string>> = {
  all: "All",
  unread: "Unread",
  replies: "Replies",
  campaigns: "Campaigns",
  system: "Sending and system",
};
/** Which list filter (besides All and Unread) a type belongs to. */
export function notificationFilterOf(type: string): "replies" | "campaigns" | "system" {
  if (type.startsWith("reply.")) return "replies";
  if (type.startsWith("campaign.") || type === OUTAGE_HOLD_NOTIFICATION || type === "email.unconfirmed") return "campaigns";
  return "system";
}
export function parseNotificationFilter(v: unknown): NotificationFilter {
  return typeof v === "string" && (NOTIFICATION_FILTERS as readonly string[]).includes(v) ? (v as NotificationFilter) : "all";
}
```

### 8.6 Contract edits

**`src/core/replies/types.ts`** (new, types and constants only):

```ts
/** Milestone 4 contract (docs/dev/M4-DESIGN.md §3): reply classification and processing types. */
import type { HeaderPair } from "@/core/mailgun/inbound";
export type { HeaderPair };

export type Nature = "REPLY" | "AUTO" | "BOUNCE" | "POSSIBLE";
export type Confidence = "certain" | "high" | "medium" | "low";
export type AutoReason =
  | "out-of-office" | "auto-reply" | "helpdesk-ack" | "challenge" | "left-company" | "read-receipt" | "dsn" | "delay"
  | "process-failed" | "internal" | "spam";
export type ClassifyInput = {
  subject: string;
  /** Normalised bare address. */
  fromEmail: string;
  fromName?: string | null;
  /** SMTP MAIL FROM: "" = null sender; null/undefined = unknown. */
  envelopeSender?: string | null;
  headers: readonly HeaderPair[];
  /** Mailgun stripped-text, newlines kept (absent when Mailgun's parse failed). */
  strippedText?: string | null;
  /** Mailgun body-plain, newlines kept. */
  bodyPlain?: string | null;
  /** M3's collapsed ≤ 300-character snippet (rows stored before M4). */
  snippet?: string;
  /** false: recovered from Mailgun's log only. */
  bodyAvailable?: boolean;
  /** Subjects of our sent emails in the linked thread. */
  sentSubjects?: readonly string[];
  /** A thread, from-address, known-contact or named-address link was found (M4-DESIGN §3.4 rule 3). Default false. */
  linked?: boolean;
};
export type Verdict = { nature: Nature; confidence: Confidence; autoReason: AutoReason | null; delay: boolean; signals: string[] };

export type InboundKindValue = "REPLY" | "AUTO_REPLY" | "BOUNCE_NOTICE" | "POSSIBLE_REPLY" | "UNLINKED" | "TEST_REPLY";
/** "company": linked to a company without an email (known contact without a recent email, fail-safe, by hand). */
export type LinkTarget = "email" | "company" | "test" | "none";
export type LinkMethod =
  | "headers" | "body-id" | "from" | "person" | "bounce-address" | "named-address" | "manual" | "simulated";
export type ReplyScope = "real" | "campaign" | "none";
export type AnswerOutcome = "answered" | "not-needed" | "duplicate" | "spam";
export type HoldReason = "outage" | "possible-reply";
export type SimulateReplyKind = "reply" | "out-of-office" | "unclear";
/** Kinds on the "Replies waiting for an answer" list. */
export const WAITING_KINDS: readonly InboundKindValue[] = ["REPLY", "POSSIBLE_REPLY", "UNLINKED"];
```

**`src/core/sequences/hold-reasons.ts`** (new, with code; P1 owns its tests; P2, P3 and P5 use it):

```ts
/** Milestone 4 contract (docs/dev/M4-DESIGN.md §2.8): CampaignRecipient.holdReason, "a,b" sorted, or null. */
import type { HoldReason } from "@/core/replies/types";
export const HOLD_REASONS: readonly HoldReason[] = ["outage", "possible-reply"];
export function parseHoldReasons(v: string | null | undefined): HoldReason[] {
  const parts = new Set((v ?? "").split(",").map((s) => s.trim()));
  return HOLD_REASONS.filter((r) => parts.has(r));
}
export function formatHoldReasons(list: readonly HoldReason[]): string | null {
  const set = new Set(list);
  const out = HOLD_REASONS.filter((r) => set.has(r));
  return out.length ? out.join(",") : null;
}
export function withHoldReason(v: string | null | undefined, reason: HoldReason, on: boolean): string | null {
  const list = parseHoldReasons(v).filter((r) => r !== reason);
  return formatHoldReasons(on ? [...list, reason] : list);
}
/** The reasons that really hold a recipient: none unless state is HELD (a stale value never counts). */
export function heldReasonsOf(r: { state: string; holdReason: string | null | undefined }): HoldReason[] {
  return r.state === "HELD" ? parseHoldReasons(r.holdReason) : [];
}
/** §2.8.3: a new log gap starting inside the window whose hold was already applied needs no new hold. */
export function outageGapCovered(
  state: { heldFor: string | null; heldTo: string | null },
  gap: { from: string },
): boolean {
  if (!state.heldFor || !state.heldTo) return false;
  const f = Date.parse(gap.from), hf = Date.parse(state.heldFor), ht = Date.parse(state.heldTo);
  return Number.isFinite(f) && Number.isFinite(hf) && Number.isFinite(ht) && hf <= f && f < ht;
}
```

**`src/core/system-state.ts`** (edit):

```diff
   | "pending-events"         // every due candidate has an unprocessed event or reply (§4.3.4)
+  | "outage-hold"            // M4: TEST/LIVE follow-ups wait while an outage is found but its hold isn't applied yet
+  | "possible-reply"         // M4: the company has a possible reply nobody has decided yet (M4-DESIGN §2.5.1 step 3)
   | "outside-hours"
 …
 export type OutageState = {
   …
-  /** Set by M4 once the hold is handled. */
+  /** When the hold of this outage was applied, or found unnecessary (M4-DESIGN §2.8.3); null = found, not held yet. */
   handledAt: string | null;
+  /** The `from` of the gap whose hold was last applied (with heldTo: outageGapCovered). */
+  heldFor: string | null;
+  /** The `to` of the gap whose hold was last applied. */
+  heldTo: string | null;
+  /** How many recipients that hold put on hold. */
+  heldCount: number;
 };
```

**`src/core/system-state-parse.ts`** (edit): `"outage-hold"` and `"possible-reply"` added to `WAIT_REASONS`;
`parseOutageState` reads `heldFor` and `heldTo` (ISO string or null) and `heldCount` (non-negative integer, default
0). Any existing test that builds an `OutageState` literal gets the three fields in the same step.

**`src/core/mailgun/inbound.ts`** (edit of the `ParsedInbound` type only; P1 implements the parsers and must not
change the type):

```diff
   storageKey: string | null;
   messageUrl: string | null;
   receivedAt: Date;
+  /** M4: SMTP MAIL FROM ("" = the null sender <>); null when the source doesn't say. */
+  envelopeSender?: string | null;
+  /** M4: stripped-text with newlines kept (≤ 8,000 characters); null when Mailgun sent none. */
+  strippedText?: string | null;
+  /** M4: body-plain with newlines kept (≤ 16,000 characters). */
+  bodyText?: string | null;
+  /** M4: false when only Mailgun's log was left (parseStoredLogOnly). Default true. */
+  bodyAvailable?: boolean;
 };
```

**`src/components/campaigns/format.ts`** (edit so the new union members compile; P3 owns the file afterwards):
`WaitReasonValue` gains `"outage-hold"` and `"possible-reply"`; `waitingText` cases → `"Waiting: the app is checking
whether replies were missed while the PC was off."` and `"Waiting: someone needs to decide whether a message from this
company is a real reply (Notifications page)."`.

`src/server/jobs.ts`: no new job types (the outage hold is a direct call, §2.8.3).

---

## 9. Screens and copy

Every page calls `requireUser()`/`requireOwner()` first; every action `requireUserAction()`/`requireOwnerAction()`
inside `runAction()`. One orange (primary) button per screen at most; everything else outline/ghost/destructive.
Dates in the viewer's `user.timeZone`. Reply text is plain text.

### 9.1 Notifications page (`/notifications`, everyone; P4)

| Part | Content and copy |
|---|---|
| Header | Title "Notifications"; description as today ("3 unread notifications." / "Everything is read."); action "Mark all read" (outline) when unread |
| Everything empty | When no notification, no waiting reply and no hold: existing EmptyState "You're all caught up." / "Replies to your campaigns, finished campaigns and anything that needs your attention will show up here." [Go to Contacts] |
| Pinned reply (`?reply=<id>`, §4.3) | the reply's card above everything else, highlighted, with heading "The reply you opened"; not waiting any more → "This reply isn't on the list any more." |
| On hold card (`id="on-hold"`, viewer has held people) | Title "Your follow-ups are on hold". Text "The PC was off too long, so the app may have missed replies that arrived from 3 Oct to 9 Oct. Look through your inbox for replies to your campaigns from those days. Follow-ups of 8 people wait until you confirm." (+ " First emails to 2 other people at those companies wait too.") **Primary: "I've checked my inbox"** → dialog title "Continue your follow-ups?" text "Did you check your inbox for replies from 3 Oct to 9 Oct? Follow-ups to 8 people will continue. If someone replied, set their company to Replied first, so their follow-ups stop." [I've checked my inbox] [Cancel] → toast "Thanks. Follow-ups of 8 people continue." · only first emails waiting for others (`held = 0`, `firstEmailsWaiting > 0`): title "Some of your first emails are on hold", text "First emails to 2 people wait until the senders who already emailed their companies have checked their inbox for replies from 3 Oct to 9 Oct. There's nothing for you to do.", no button · the button when nothing is left: error "Nothing of yours is on hold." |
| Replies section (`id="replies"`) | Heading "Replies waiting for an answer" + count. Toggle for everyone: "Everyone's (4)" / "Yours (3)" (`?scope=everyone|mine`; default everyone for the Owner, yours for Members). Help line: "The app can't see your inbox. Answer in your own email program, then mark the reply here." Empty: "No replies are waiting for an answer." (Everyone's: "Nobody's replies are waiting for an answer.") |
| Reply card, first line | `Anna Berg · Firma GmbH` (link to `/contacts?company=<id>`); known colleague: `Ben Braun · Firma GmbH`; unknown colleague: `jonas@firma.de (not in your contacts) · Firma GmbH`; unlinked: `jonas@firma.de` |
| Reply card, badge | "Reply" / "Real reply?" / "Reply we couldn't link to a company" (A6 wording), plus "Dry run" or "Test" when labelled; neutral colours |
| Reply card, meta | `Replied 2 hours ago to “Re: 3D models for your shop” · Germany Q4 · follow-up 1 · sent by Ali`; Everyone's view adds `· waiting for Ali`; quiet rows add a line `Arrived on 12 Sep, before the app processed replies.` (source NOTIFY) or `Arrived on 12 Sep while the PC was off.` (source CATCHUP) |
| Reply card, text | the first lines (§3.10), quoted in a muted block |
| REPLY actions | [Answered] [No answer needed] (outline), [Add jonas@firma.de to Firma GmbH] (ghost, when not a contact) → toasts "Marked as answered." / "Marked as needing no answer." (both with Undo), "Added jonas@firma.de to Firma GmbH." |
| POSSIBLE_REPLY | Line "The app isn't sure this is a real reply:" + the why lines of `possibleReplyReasons` (§9.1.1); actions [Real reply] [It was an auto-reply] (outline). "It was an auto-reply" asks: "Mark as automatic? Follow-ups to Firma GmbH will continue. Only do this if the message really was automatic." [Mark as automatic]. Toasts: "Marked as a real reply. Follow-ups to Firma GmbH stopped." (+ " and it's now Replied." when the status changed) / "Marked as automatic. Follow-ups to Firma GmbH continue." (when another undecided message still holds the company: "Marked as automatic. Follow-ups to Firma GmbH still wait for another message to be checked.") |
| UNLINKED | Hints (§3.3.5) as muted lines; actions [Link to a company] [Answered] [No answer needed] |
| Link dialog | Title "Link this reply to a company". Search box (label "Company", placeholder "Search by name or website", uses the existing `searchCompaniesAction`), pre-selected hint company. Then "Person" select: the company's people + "Not one of these people". Checkbox (shown when the address isn't a contact) "Add jonas@firma.de to this company as a person" (default ticked). When the classifier said possible: radios "Is it a real reply?" Yes / No, it was automatic. [Link reply] / [Cancel]. Toast "Linked to Firma GmbH. Its follow-ups stopped." (+ " and it's now Replied.") / "Linked to Firma GmbH as an automatic message." Errors: "Pick a company first." / "This company was deleted. Pick another one." / no search results: "No companies match. Try part of the name or the website." / add-person race: "jonas@firma.de already belongs to C-1042. Link the reply there instead." On a phone the dialog opens full screen. |
| All notifications | Heading "All notifications"; chips All · Unread · Replies · Campaigns · Sending and system (`?filter=`); existing list and pager; filter empty: "No notifications match this filter." [Show all] |
| Owner: other messages | `<details>` "Messages we couldn't link (last 30 days)": rows `From · Subject · what it was (out of office, delivery failure, help desk confirmation, marked as spam by Mailgun…) · received`; empty "None in the last 30 days." |
| Errors | "This reply was already handled by Sara. Refresh the page to see it." · "This reply isn't on the list any more. Refresh the page." · Answered on a possible reply: "Choose Real reply or It was an auto-reply first." |

#### 9.1.1 "Why" lines for possible replies (`possibleReplyReasons(signals, bodyAvailable)`, P1)

| Signal(s) | Line |
|---|---|
| `bodyAvailable === false` | It was recovered from Mailgun's log without its text, because the PC was off too long. |
| `autoReason "process-failed"` | The app couldn't read this message, so it held the company's follow-ups to be safe. Open it in your inbox. |
| `challenge` | It looks like a spam filter asking you to confirm you're a person. |
| `ack`, `body:ack` | It looks like an automatic "we received your message" confirmation. |
| `helpdesk`, `helpdesk-mailer` | It came through a help desk, which marks every email as automatic. |
| `body:absence-details` | It says when they're back, like an out-of-office message. |
| `body:absence` | It says they're away, but it may also contain a real answer. |
| `x-auto-response-suppress` | It carries a "don't auto-reply" marker that some mail programs add to normal emails too. |
| `body:left-company` | It mentions someone leaving the company. |
| `subject:absence-word` | Its subject mentions a holiday or leave. |
| `list-headers`, `precedence:*`, `feedback-id` | It looks like a newsletter or mailing-list email. |
| `from:no-reply` | It came from a no-reply address. |
| `loop-header`, `x-autogenerated` | A mail server marked it as possibly automatic. |
| anything else | Some signs say it was sent automatically. |

### 9.2 The bell (P5)

Unchanged look. Additions: the waiting line (§5.2) and pop-ups (§5.3). Pop-up titles and bodies are the notifications'
own (§5.1). Batch pop-up: "30 new notifications" / "Open the app to see them." (the total new, §5.3).

### 9.3 Campaign page (`/campaigns/[id]`; P3)

| Change | Copy |
|---|---|
| Remove the M3 notice | "Follow-ups are prepared … arrives in Milestone 4. …" is deleted |
| Possible-reply holds (count of HELD recipients with `possible-reply`, by company) | Notice: "Follow-ups to 2 companies are on hold until someone checks a possible reply." + link "Open Replies waiting for an answer" (`/notifications#replies`) |
| Outage holds | Notice (warning tone): "Follow-ups of 5 people are on hold because replies from 3 Oct to 9 Oct may have been missed. Ali can continue them from Notifications after checking their inbox." (Owner adds " You can also continue them in Settings › Sending & Mailgun.") |
| Waiting line | `outage-hold` and `possible-reply` texts (§8.6); the others as M3 |
| Recipient state and step lines | §2.12 texts; step timing "Sent 3 days after the first email if there's no reply" (existing); step progress counts held rows apart: "Follow-up 1: 12 waiting, next on 14 Oct · 5 on hold" (§2.11) |
| Recipient panel (P3) | state text with the hold reason; for dry runs the link "Simulate a reply in the dry-run outbox" under the latest sent email; replies show in the existing timeline |

### 9.4 Wizard (P3)

| Step | Change |
|---|---|
| Message | First-subject rules (§2.13): error under the subject field and on save; warning line for the Outlook trap |
| Review (per-person first subject, existing edit dialog) | the same error from `editUnsentEmail` (field message) |
| Launch | a draft with a `Re:`/`Fwd:` first subject (saved before M4) is refused with the §2.11 text |
| Schedule, "Sending hours and limits" | the `followUpsOff` note is deleted |
| Schedule, "When you launch" | follow-ups sentence: 1 → "Its follow-up goes out in the same email thread after its wait, unless someone at the company replies." · n → "Its 2 follow-ups go out in the same email thread, each after its wait, unless someone at the company replies." |
| Schedule, dry-run helper hint | "“3 days after” becomes 3 minutes after. Switch on Ignore sending hours too, so you can watch a whole sequence in minutes." |

### 9.5 Outbox (P4)

Simulate row: buttons [Delivered] [Bounce] [Complaint] [Unsubscribe] [Reply] [Out-of-office] [Unclear reply]
(outline, each once), help line and results line per §7.1.

### 9.6 Settings › Notifications (`/settings/notifications`, everyone; P5)

| Part | Copy |
|---|---|
| Title / description | "Notifications" / "The bell at the top shows new replies, finished campaigns and anything that needs your attention." |
| Card "Pop-ups on this computer", state insecure | "Pop-ups can't work on this address. Browsers only allow them on the secure address (https://outreach.example.com) or on the office PC itself (http://localhost:3000). Open the secure address and turn them on there." (no public address: "…only allow them on a secure (https) address or on the office PC itself (http://localhost:3000)."). The localhost address uses the port the page was loaded from (`window.location.port`, e.g. 3001 in the practice copy), never a fixed 3000. |
| phone / unsupported | "Pop-ups work on a computer only. On your phone, check the bell." |
| ask (permission default) | Button "Turn on pop-ups" (outline; its click calls `Notification.requestPermission()` with no `await` before it) + hint "Your browser will ask whether this app may show notifications. Click Allow." |
| blocked | "Your browser is blocking pop-ups from this app. Click the icon to the left of the address, set Notifications to Allow, then reload this page." |
| on / off (granted) | Switch "Pop-ups in this browser" (neutral colour); [Send a test pop-up] (outline); tip "Pop-ups only arrive while this app is open in a tab, even in the background. Pin the tab (right-click the tab, then Pin) so the browser keeps it running." After the test: "Did you see it? If not, check Windows Settings › System › Notifications: Do not disturb must be off (or your browser must be on its priority list), and your browser must be switched on in the list of apps." |
| Card "What pops up" | the checkboxes of §5.4; hint "The bell always shows everything. This only chooses what also pops up on your screen. Saved for your account." Saved on change: toast "Saved." |

### 9.7 Company panel, Contacts, import (P5)

Copy in §6 rows 2, 3, 6, 9 and §2.12.

### 9.8 Settings › Team: switching someone off (P5)

Dialog title "Switch off Ali?". Text: "Ali will be signed out everywhere and can't sign in. Their history stays. Replies
to Ali's sending address will come to your inbox from now on." When Ali has active campaigns: "Ali has 2 active
campaigns: Germany Q4 (running), Norway prints (scheduled). What should happen to them?" radios **"Pause them. You can
resume or cancel them later."** (default) / **"Let them finish, including follow-ups. Replies will come to you."**
Buttons [Switch off Ali] (destructive) [Cancel]. Toasts: "Ali is switched off. 2 campaigns paused." / "Ali is switched
off. Their campaigns keep going; replies come to you." The pause reason stored on each campaign: "Paused because Ali was
switched off". When Ali has waiting replies, the dialog adds: "Ali's 3 replies waiting for an answer move to you."
(always done, §4.2).

### 9.9 Settings › Sending & Mailgun, "Check with Mailgun" card (Owner; P3)

| Outage state | Line |
|---|---|
| found, hold not applied yet | (amber) "The PC was off for more than 5 days, so the app can't be sure it saw every reply. Follow-ups are waiting while the app puts them on hold." |
| held, people still held | (amber) "Replies from 3 Oct to 9 Oct may have been missed while the PC was off. Follow-ups of 12 people are on hold until their sender has checked their inbox:" then one row per sender "Ali · 8 people" [Continue Ali's follow-ups] (outline) → dialog "Continue Ali's follow-ups? Only do this after Ali has looked through their inbox for replies that arrived from 3 Oct to 9 Oct. Anyone who replied must not get a follow-up." [Continue follow-ups]; toast "Follow-ups of 8 people continue." Rows for switched-off senders say "Ali (switched off) · 3 people". A last line when colleagues wait: "First emails to 4 other people at those companies continue once everyone who emailed their company has checked." |
| held, nobody left on hold, or nothing was held | (neutral, for 7 days after `detectedAt`) "Replies from 3 Oct to 9 Oct may have been missed while the PC was off. No follow-ups are on hold now." |
| only message retention passed (`textOnly`: no log gap) | (neutral, for 7 days after `detectedAt`) "Some replies were recovered without their text, because the PC was off longer than Mailgun keeps received messages. They're on Replies waiting for an answer as possible replies." |

### 9.10 New server actions and routes (B7)

| Action / route | File | Access |
|---|---|---|
| `markReplyAnsweredAction({id})`, `markReplyNotNeededAction({id})`, `reopenReplyAction({id})`, `confirmReplyAction({id, real})`, `linkReplyAction({id, companyId, personId?, addPerson?, real?})`, `addReplySenderAction({id})`, `continueMyFollowUpsAction()` — thin wrappers of the P4 services in `src/server/services/replies/actions.ts` (§10) | `src/app/(app)/notifications/reply-actions.ts` (P4) | signed in (anyone, on any reply; §4.2) |
| `simulateReplyAction({emailId, kind})` | `src/app/(app)/campaigns/outbox/actions.ts` (P4) | signed in |
| `continueFollowUpsAction({senderId})` | `src/app/(app)/settings/sending/actions.ts` (P3, appended) | Owner |
| `savePopupGroupsAction({groups})` (replaces `setDesktopRepliesAction`) | `src/app/(app)/settings/notifications/actions.ts` (P5) | signed in |
| `switchOffAction({userId, campaigns: "pause" \| "finish"})` | `src/app/(app)/settings/team/actions.ts` (P5) | Owner |
| `GET /api/notifications/summary?after=<id>` | P5 | signed in |

---

## 10. Work packages

Every package: follow `CONVENTIONS.md`; run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`,
`npx eslint <owned paths>`, `npx vitest run <own test paths>`; never run `next build/dev/start`, `npm install`,
`prisma migrate *`; never touch `data/app.db`; never call real Mailgun. Report any needed contract change instead of
making it. Update the M3 tests listed for your files (m4-code-map §8) in the same package.

### P1 — Pure core: replies, follow-up timing, wording, pop-ups (wave 1)

**Owned paths:** `src/core/replies/{classify,phrases,quote,link-ids,kind,copy,hints,index}.ts`,
`src/core/sending/follow-up.ts`, `src/core/sequences/wording.ts`, `src/core/templates/subject-rules.ts`,
`src/core/notifications/popups.ts`, `src/core/mailgun/inbound.ts` (implementation; not the `ParsedInbound` type),
tests `tests/unit/replies-core/**`, `tests/unit/sequences-core/**`, `tests/unit/notifications-core/**` (incl. the
contract file `notification-types.ts`), `tests/unit/templates/subject-rules.test.ts`,
`tests/unit/mailgun-core/inbound-m4.test.ts`.

**Builds:** §3.3 helpers (incl. `namedRecipients`), §3.4 classifier with every rule (linked/unlinked, subject prefixes,
challenge URL in the new text, bounce-by-subject, `mailgun-spam`, the 4,000-character budget), §3.5 `storedKind`, §3.6
`replyScope`, §3.10 quoting, §5.1 copy builders (every row and variant), §9.1.1 why lines, hints (§3.3.5),
`suggestedContact`, `autoReasonLabel` (`out of office`, `automatic reply`, `help desk confirmation`, `spam filter
check`, `has left the company`, `read receipt`, `delivery failure`, `delivery delay`, `couldn't be read`, `sent by
your team`, `marked as spam by Mailgun`), `INBOUND_KIND_LABELS` (`Reply`, `Automatic reply`, `Delivery failure
notice`, `Real reply?`, `Reply we couldn't link to a company`, `Reply to a test email`), §2.1–§2.2 timing and
threading, §2.12 wording (`holdStateText`, `sequenceSuffix`, stop-code constants `REPLIED_STOP = "replied"`,
`COMPANY_REPLIED_STOP = "company_replied"`), §2.13 subject rules, §5.3 pop-up decisions, §3.2 parser fields and the
header allow-list (incl. the four `X-Mailgun-*` spam headers). Tests (only) for the contract files
`notification-types.ts` and `hold-reasons.ts` (incl. `heldReasonsOf`, `outageGapCovered`).

**Provides (exact names):** `classify`, `extractNewText`, `firstLines`, `findCut`, `threadIds`, `bodyMessageIds`,
`bounceRecipients`, `namedRecipients`, `storedKind`, `replyScope`, `possibleReplyReasons`, `autoReasonLabel`,
`INBOUND_KIND_LABELS`, `replyNotificationCopy(input) → {type, title, body, link} | null`,
`replySummaryCopy() → {type, title, body, link}`, `replyActivitySummary(input) → string`, `sameDomainHint`,
`removedContactHint`, `suggestedContact(text, {fromEmail, companyDomain, ownDomains})`, `followUpDueAt`, `sentIdsOf`,
`threadHeaders`, `trimReferences`, `holdStateText`, `sequenceSuffix`, `firstSubjectProblem`, `popupPanelState`,
`pollDelayMs`, `shouldPopUp`, `pickPopups`; `parseInboundForm`, `parseStoredMessage`, `parseStoredLogOnly` fill the
new fields.
**Consumes:** contract files; `@/core/sending/window`, `@/core/shared-domains`, `@/core/email-address`,
`@/core/rules/mode`.

`replyNotificationCopy` input: `{kind, autoReason, companyName, personName, fromEmail, fromName, replierIsKnown,
fromIsThreadPerson, newEmail, threadSubject, subject, suggested, label, failed, heldCompanyName, forwardFailed,
possibleChallenge, inboundId, companyId, campaignId, recipientId}`; returns null for kinds that notify nobody (§3.5).
`suggestedContact` skips our own sending domains, the `fromEmail` itself and no-reply local parts, prefers an address on
the company's domain, and returns at most one address (or null).

**Tests (SPEC "reply matching and auto-reply detection", "follow-up scheduling"; B12):**
- classifier: every research vector V01–V40 (nature, `autoReason`, first lines where given) with its `linked` flag,
  explicitly named groups: auto-replies in three languages (V03 en, V04 de, V05 nb; plus V32 fr, V33 es, V34 pl),
  possible replies (V08 and V21 now, V09, V11, V26, V27, V30, V37, V39), bounce order (V15), `Auto-Submitted: no`
  (V28), help desk (V10, V11, V12); the new vectors (a)–(f) of §3.4 rule 14; the same OOF vectors with only an M3-style
  snippet still AUTO; `bodyAvailable: false` always POSSIBLE; `X-Mailgun-Sflag: Yes` adds `mailgun-spam`; the timing
  test of rule 13.
- quoting Q01–Q15; `firstLines` ≤ 3 lines / 300 characters and the sign-off stop.
- link ids: order In-Reply-To then References newest→oldest, dedupe, case, brackets, 50 cap; `bodyMessageIds` only
  `pp.` ids; `bounceRecipients` on V13, V14, V15, V17; `namedRecipients` on V20, V21.
- `storedKind` table (incl. link `company`); `replyScope` table (every row of §3.6); why lines per signal (incl.
  `process-failed`, `challenge`, `ack`); copy builders for every §5.1 row incl. prefixes, the known and unknown
  colleague, the new-email, domain-hold, fail-safe, possible-challenge and forward-failed variants; `reply.summary`;
  hints (shared domains never hinted); `suggestedContact` rules.
- timing: every row of the §2.1 examples and the weekday table; invalid zone → default; delay 0; negative/NaN delay.
- threading: step 1 and step 2 headers; rewritten provider id (In-Reply-To = provider, References ours then
  provider); `trimReferences` keeps first + last two past 998; no duplicates.
- wording: every §2.12 row via `holdStateText`/`sequenceSuffix` ("Stopped: they replied"); `hold-reasons.ts` round trip
  (order, junk dropped, add/remove one reason, empty → null), `heldReasonsOf` ignores non-HELD states,
  `outageGapCovered` (same `from`, inside, before, at/after `heldTo`, nulls).
- subject rules table (one regex); pop-up decision table (each state), `pollDelayMs` bounds with a seeded random,
  `pickPopups` high-water mark, `count > 3` → one batch and `newLast = latestId`.
- inbound parser: `sender` `""`/`"<>"`/missing/`X-Envelope-From`; stripped-text newlines kept, 8,000 cap; body-plain
  16,000 cap; log-only `bodyAvailable false` with envelope sender from `envelope.sender`; the allow-list keeps
  `Auto-Submitted` and `X-Mailgun-Sflag` when 200 `Received` headers come first.
- `notification-types.ts`: `readNotifyPrefs` (missing → `["reply"]`, junk dropped, legacy flag), `popupTypesFor` drops
  `sending` for Members and includes `reply.attention`/`reply.summary` in `reply`, `notificationFilterOf`.

**Done when:** tests pass; every export has a doc comment; no I/O in `src/core`.

### P2 — Server foundations: stops, holds, outage record, inbound store, notifications, fake Mailgun (wave 1)

**Owned paths:** `src/server/services/mail-events/{stops,inbound-store}.ts`,
`src/server/services/mail-events/internal-senders.ts` (new), `src/server/services/sequences/holds.ts` (new),
`src/server/services/mailgun/catch-up.ts` (the gap record, `fetchStoredReply`'s outage write and the "M4" comments
only), `src/server/services/sending/mark-sent.ts` (**wave 1 only**, the `MarkSentOptions.onlyFrom` option and its CAS;
P3 owns the file in wave 2), `src/server/notifications.ts`, `tests/fake-mailgun/**`,
`tests/integration/helpers/replies.ts` (new), tests `tests/integration/stops-holds/**`,
`tests/integration/notifications-server/**`, `tests/integration/inbound-store/**`,
`tests/integration/fake-inbound/**`, `tests/integration/catch-up/outage-gaps.test.ts` (new),
`tests/integration/webhooks/inbound-route.test.ts`, `tests/integration/mail-events/stops*.test.ts` (and the
`stopRank`/`STOP_SKIP_TEXT` cases in other existing mail-events tests).

**Builds:** §2.6 (`stopCompany`, `stopCompaniesForStatus`, new ranks and texts, `failed` overwritten by reply stops,
`stoppedByInboundId`, hold fields cleared by stops, `StopInput.inboundId`), §2.8 (`holdCompany`, `releaseCompanyHold`
with the undecided check, `undecidedHolds`, `applyPendingPossibleReplyHolds`, single-flight `applyOutageHold` with
colleagues and per-chunk re-reads, chunked `releaseOutageHold` with the company-completion rule, `outageHoldSummary`,
`myOutageHold`), the catch-up's gap merge/coverage and `fetchStoredReply` write (§2.8.3), §3.2 storage of the new fields
and the log-only upgrade, `internalSenders(reader) → { isInternal(email): boolean; isTestSender(email, testSendTo):
boolean }` (users' `email`/`replyInbox`, `SenderAddress`, `SendingDomain` names, `sending.testList`; used by P3's guard
and P4's processor so both agree), `markSent`'s `onlyFrom`, `server/notifications.ts` additions, §7.3 fake extensions
and helpers. Update the doc lists in `notifications.ts` with every §5.1 type. `outage.hold` notifications are built
per user in their `timeZone` (P2's own copy).

**Provides:**
```ts
// src/server/notifications.ts
export async function listNotifications(userId: number, page?: number, pageSize?: number, filter?: NotificationFilter): Promise<NotificationPage & { filter: NotificationFilter }>;
export async function popupsAfter(userId: number, opts: { after: number; types: readonly string[]; now: Date; windowMs?: number; max?: number }): Promise<{ items: NotificationItem[]; count: number; latestId: number | null }>;
export async function latestNotificationId(userId: number): Promise<number>;
/** Creates one notification per distinct active user id (nulls and inactive users skipped). Returns how many. */
export async function notifyUsers(userIds: Iterable<number | null | undefined>, input: Omit<NotificationInput, "userId">, tx?: DbOrTx): Promise<number>;
/** Waiting replies assigned to the user (§4.1), dry-run ones (replyScope "campaign") not counted. */
export async function waitingReplyCount(userId: number): Promise<number>;
/** True when the user has an unread notification of this type created after `since` (the reply.summary rule). */
export async function hasUnreadSince(userId: number, type: string, since: Date, reader?: DbOrTx): Promise<boolean>;
export async function activeOwnerId(reader?: DbOrTx): Promise<number | null>;
// src/server/services/mail-events/internal-senders.ts
export async function internalSenders(reader?: DbOrTx): Promise<{ isInternal(email: string): boolean; isTestSender(email: string, testSendTo: string | null): boolean }>;
// src/server/services/sending/mark-sent.ts (option only)
// MarkSentOptions.onlyFrom?: readonly SendStatus[]  — CAS `status IN onlyFrom` instead of `status ≠ SENT`.
```
plus §2.6 and §2.8 signatures.
**Consumes:** contract files only from M4 (`hold-reasons.ts`, `notification-types.ts`, `replies/types.ts`,
`system-state.ts`; never P1's implementation, which is written at the same time; the `outage.hold` copy of §5.1 is
P2's own), existing `releaseCompanyIfDone`, `logActivity`, `createNotification`, `readTyped`/`updateTyped`, `realModes`.

**Tests:**
- `stopCompany`: two campaigns (LIVE + dry run) with company A (Anna, Ben) and B → A's open recipients stopped; replier
  Ben (known Person) → Ben `replied`, Anna `company_replied`; replier unknown → Anna (thread's person) `replied`; QUEUED
  rows SKIPPED with the §2.6.1 texts; `stoppedByInboundId` written; B untouched; campaign scope stops only that
  campaign; an earlier `bounced` stays `bounced` (rank); a later reply by the colleague upgrades `company_replied` →
  `replied`; a `failed` recipient becomes `replied`/`company_replied` (and `retryEmail` then refuses it); HELD
  recipients stopped with hold fields cleared; reservation released when nothing is open; touched campaign ids returned.
- `stopCompaniesForStatus`: `status:CLIENT` on every open recipient of 50 companies in one call; already stopped
  untouched; texts.
- holds: `holdCompany` holds SCHEDULED and WAITING (QUEUED rows stay QUEUED); release → WAITING (step ≥ 1) or
  SCHEDULED (step 0); two reasons: releasing one keeps HELD with the other; stop clears both; `releaseCompanyHold` keeps
  recipients held while another undecided message (real scope, or campaign scope for their campaign) exists, and ignores
  twins (`answerOutcome "duplicate"`); `undecidedHolds` for POSSIBLE_REPLY and domain-held UNLINKED rows;
  `applyPendingPossibleReplyHolds` holds a recipient created after the message was processed.
- outage: `applyOutageHold` holds TEST/LIVE WAITING **and HELD** follow-ups whose last SENT row is before `to` (a
  `possible-reply` hold gains `outage`), plus SCHEDULED/WAITING colleagues at those companies in any TEST/LIVE campaign
  (dry runs and unaffected companies untouched); sets `handledAt`, `heldFor`, `heldTo`, `heldCount`; notifications per
  active sender (dates in the sender's zone) + one for the Owner, none when 0 held; two concurrent calls hold once and
  notify once (single-flight); a chunk that sees `handledAt` set stops; `from === null` (message retention only) →
  `handledAt` set, nothing held; `releaseOutageHold` for own campaigns, Owner for anyone (incl. `senderId null`), Member
  for someone else refused with the §2.8.3 text; colleagues (step 0) released only when no emailed-held recipient is
  left at their company; activities with date-free summaries.
- catch-up gap record (`outage-gaps.test.ts`, fake Mailgun): two domains with different cursors → one merged gap
  (min `from`, max `to`); the same gap recorded again after its hold → nothing re-held (covered); an older domain's
  earlier gap after a hold → a new record and a new hold; a new outage after the held window → a new hold;
  `fetchStoredReply` for an expired body sets `beyondMessageRetention` without touching `handledAt`.
- inbound store: new fields written (caps, `""` envelope), M3-shaped `ParsedInbound` (no new fields) still stores; a
  log-only row gets text, headers and `bodyAvailable = true` from a later copy with text; the inbound route test still
  shows the route store-only, with the new fields.
- `markSent` with `onlyFrom`: a SENDING or FAILED row is left alone; UNKNOWN/UNCONFIRMED/QUEUED become SENT.
- `internalSenders`: users' addresses, sender addresses and sending domains are internal; the test-sender rule.
- notifications: each filter's `where`; `popupsAfter` (after, types, 10 minutes, `items` max 5 ascending, `count`,
  `latestId`); `notifyUsers` de-duplicates and skips inactive; `waitingReplyCount` (kinds, answered, processed, campaign
  scope not counted); `hasUnreadSince`.
- fake: `receive` with `envelopeSender ""`, `strippedText null` (field absent), `contentType`, `messageId`; notify
  form and stored JSON agree; admin `/__fake/inbound` presets (each, incl. `spam`) and explicit overrides; `notify:
  true` posts a valid signature to a loopback app.

**Done when:** tests pass; `node scripts/fake-mailgun.mjs --port 4010` accepts a preset.

### P3 — Sequences engine and campaign screens (wave 2)

**Owned paths:** `src/server/services/sending/{gates,loop,mark-sent,restore}.ts` (mark-sent after P2's wave-1 option),
`src/server/services/campaigns/{launch,draft,control,queries}.ts`, `src/server/services/eligibility.ts`,
`src/server/services/companies/mutations.ts` (`setCompanyStatus` only), `src/server/services/companies/bulk.ts`
(`bulkSetStatus` only), `src/components/campaign-wizard/**` except `review-step.tsx`,
`src/components/campaigns/**` except `outbox-*.tsx` and `simulate-*.tsx`, `src/app/(app)/campaigns/[id]/**` except
`setup/test-send-actions.ts`, `src/app/(app)/settings/sending/{page.tsx,load.ts,actions.ts}` (the outage part and the
new action), `src/components/settings/sending/check-with-mailgun.tsx`, tests `tests/integration/sending/**`,
`tests/integration/sending-m3/**`, `tests/integration/sequences/**` (new), `tests/integration/campaigns/**`,
`tests/integration/campaign-pages/**`, `tests/integration/campaign-wizard/**`, `tests/integration/rules/**`,
`tests/unit/sending/**`, `tests/unit/campaigns/**`, `tests/unit/campaign-wizard/**`, `tests/unit/rules/**`.

**Builds:** §2 in full except P2's stop/hold functions: §2.1 wiring, §2.5.1 guard (incl. the undecided step, the
thread-target cache, `internalSenders`, the SIMULATED skip, and the one-row guard in `finalCheck`), §2.7 status stops
(`stopCompaniesForStatus`, bulk chunks of ≤ 50) and the override fix, §2.8.1 HELD handling in the engine (hold fields
cleared on every move out of HELD), §2.8.2 calls of `applyPendingPossibleReplyHolds` (launch, Retry, maintenance),
§2.8.3 rules 1, 2 and the maintenance retry, §2.10 (per-class candidate queries), §2.11 (incl. `advanceRecipient` by the
highest SENT step, `editUnsentEmail` and launch subject checks, `CampaignStepOverview.held`), §2.12 campaign and
Sequence texts (`recipientStateText` gains `holdReason`; `companySequenceLabel(seq, tz, now)` keeps its signature, the
`seq` type gains optional `holdReason`, `countsAsEmailed`), §9.3, §9.4, §9.9, the M3 test rewrites
(`sending-m3/modes.test.ts:115`, `sending/loop.test.ts:130`, `unit/campaign-wizard/format-m3.test.ts:69`,
`wizard.test.ts:113`, `sending-m3/gates.test.ts:301-347`, `query-plans.test.ts`).

**Provides (for P6):** `runSendingMaintenance` (calls `applyOutageHold` and `applyPendingPossibleReplyHolds`);
`GateContext` fields `outageHoldPending`, `followUpCatchUpReady`, `problems` loaded by `loadGateContext`.
**Consumes:** P1 (`followUpDueAt`, `threadHeaders`, `holdStateText`, `sequenceSuffix`, `firstSubjectProblem`,
`threadIds`), P2 (`stopCompaniesForStatus`, `applyOutageHold`, `outageHoldSummary`, `releaseOutageHold`,
`undecidedHolds`, `applyPendingPossibleReplyHolds`, `internalSenders`), existing code.

**Tests (SPEC "follow-up scheduling and stop rules"; B12):**
- scheduling through `markSent` on a temp DB with a fixed clock: gated LIVE row sent Wed 10:00 Berlin, delay 3 → next
  row `dueAt` Mon 09:00 Berlin; Fri 27 Mar 16:45 → Mon 30 Mar 16:45 CEST; ungated dry run → no shift; minutes; the
  sweeper creates the same `dueAt`; a step-0 row proven SENT after step 1 (restore order) never moves `currentStep`
  back or creates a second step-1 row.
- threading against the fake: step 1 and 2 `h:In-Reply-To`/`h:References` bracketed and ordered, subject `Re: <first
  subject as stored>` (a per-person edited first subject is used), never `Re: Re:`; after `rewriteMessageId` the next
  row's In-Reply-To is the provider id and References carry both.
- `MAX_SENDABLE_STEP` 3: LIVE and TEST follow-ups go after their delay; follow-ups before first emails in both orders
  (gated and ungated); overdue M2/M3-style dry-run follow-ups go at the next tick; 600 due gated dry-run follow-ups
  don't keep a due LIVE first email from being a candidate (per-class queries).
- 30-day team rule with follow-ups (spec M4): in the practice copy, follow-up 1 to Anna and a first email to Ben (same
  company, same campaign) both go despite the 30-day rule; with `goLive = true`, a LIVE follow-up passes
  `ensureReservation`.
- HELD / RECHECK recipients' QUEUED rows never picked (gated and ungated); a claim that finds HELD is released
  (`held`), `markSent` keeps HELD; FINISHED/STOPPED/skip/cancel/retry clear `holdReason`/`heldAt`.
- outage gate: `from` set, `handledAt` null → follow-ups wait `outage-hold`, first emails go; follow-ups wait for a
  successful catch-up after start (network failure + 15 min opens it for first emails only).
- guard: an unprocessed reply from a colleague (unknown address) whose References carry our id to company A holds A's
  candidates; from a person at A holds A; from before the launch holds too; a reply-test thread from the test mailbox
  holds nothing but the same thread from a prospect holds; an internal sender holds nothing; a SIMULATED row doesn't
  hold a LIVE candidate; the next candidate is sent; an undecided POSSIBLE_REPLY of A holds a candidate of a campaign
  launched afterwards (`possible-reply`), and launch/maintenance turn it into a HELD recipient; **a reply stored after
  `planTick` and before the hand-over sends nothing to the fake** (the `finalCheck` guard releases the claim).
- status stops: `setCompanyStatus(CLIENT)` stops open recipients in two campaigns at once (`status:CLIENT`, rows
  SKIPPED); `bulkSetStatus` of 120 companies in chunks of ≤ 50; setting CONTACTED stops nothing.
- override fix: a put-back recipient is skipped at send time after `Company.repliedAt` moves past the launch.
- launch: TEST/LIVE follow-up steps stay enabled; an M3-launched campaign with disabled steps finishes after first
  emails; `LaunchSummary` has no `followUpsOff`; Message step refuses a `Re:` subject; `editUnsentEmail` refuses a step-0
  `Fwd:` subject; a draft with a `Re:` `RecipientEdit` subject can't launch.
- restore: with step 1 switched off, a missing step-2 row threads to step 0.
- campaign page render test: held notices, `outage-hold` and `possible-reply` waiting lines, step progress "· 5 on
  hold" (held rows not in `waiting`/`nextDueAt`), §2.12 texts ("Stopped: they replied"); Settings › Sending outage lines
  (incl. `textOnly`) and `continueFollowUpsAction` (Owner only; Member refused).
- query plans still index-driven (every candidate query, due stats, sweeper, `undecidedHolds`).

**Done when:** tests pass; M2/M3 sending tests pass except the listed rewrites; pages compile.

### P4 — Reply processing, the waiting list, the Notifications page, reply test tools (wave 2)

**Owned paths:** `src/server/services/replies/**` (new: `input.ts`, `link.ts`, `effects.ts`, `process.ts`,
`actions.ts`, `waiting.ts`, `index.ts`), `src/server/services/mail-events/simulate.ts`,
`src/app/(app)/notifications/**` (page, `notification-list.tsx`, `actions.ts`, new `reply-actions.ts`),
`src/components/replies/**` (new: `replies-section.tsx`, `reply-card.tsx`, `link-reply-dialog.tsx`,
`on-hold-card.tsx`, `other-messages.tsx`), `src/app/(app)/campaigns/outbox/**`,
`src/components/campaigns/{outbox-*,simulate-*}.tsx`, tests `tests/integration/replies/**`,
`tests/integration/notifications-page/**`, `tests/unit/replies-ui/**`, `tests/integration/mail-events/simulate*.test.ts`.

**Builds:** §3.3 (lookups, arrival-time windows, internal senders, known contact, named address, domain hold), §3.5
effects and decisions (twins copied, spam, forward-failed bounces), §3.7, §3.8 (back-off and the fail-safe), §3.10
storage of the snippet, §3.11, §4 (Members' toggle, the pinned `?reply=`, phone layout), §5.5 page and throttles
(`reply.summary`, `reply.attention` once per 30 days), §7.1–§7.2, §9.1, §9.5, §9.10 P4 actions.

**Provides (for P6):** `processPendingInbound`, `processInboundMessage`, `INBOUND_BATCH`, `InboundFailures`; (for the
M4 end-to-end test) the decision services; (for M6) `listWaitingReplies`. Keeps the existing exports
`markNotificationsReadAction` and `markAllNotificationsReadAction` of `src/app/(app)/notifications/actions.ts`
unchanged (the bell, P5, imports them).
```ts
// src/server/services/replies/actions.ts — every decision; the server actions and the tests call these.
export type ReplyActor = { id: number; name: string; role: "OWNER" | "MEMBER" };
export async function markReplyAnswered(actor: ReplyActor, id: number, opts?: { now?: Date }): Promise<{ message: string }>;
export async function markReplyNotNeeded(actor: ReplyActor, id: number, opts?: { now?: Date }): Promise<{ message: string }>;
export async function reopenReply(actor: ReplyActor, id: number, opts?: { now?: Date }): Promise<{ message: string }>;
export async function confirmReply(actor: ReplyActor, id: number, real: boolean, opts?: { now?: Date }): Promise<{ message: string }>;
export async function linkReply(actor: ReplyActor, id: number, input: { companyId: number; personId?: number | null;
  addPerson?: boolean; real?: boolean }, opts?: { now?: Date }): Promise<{ message: string }>;
export async function addReplySender(actor: ReplyActor, id: number): Promise<{ message: string }>;
// src/server/services/replies/waiting.ts
export type WaitingReplyView = {
  id: number; kind: "REPLY" | "POSSIBLE_REPLY" | "UNLINKED"; label: "" | "Dry run" | "Test";
  receivedIso: string; receivedAgo: string; receivedExact: string;
  /** Quiet rows: "Arrived on 12 Sep, before the app processed replies." / "… while the PC was off." */
  quietLine: string | null;
  fromEmail: string; fromName: string | null; fromIsContact: boolean;
  company: { id: number; name: string } | null; person: { id: number; name: string } | null;
  campaign: { id: number; name: string; step: number } | null; senderName: string | null; assigneeName: string | null;
  subject: string; firstLines: string; whyLines: string[]; hints: string[]; hintCompanyId: number | null;
  canAddPerson: boolean;
};
export async function listWaitingReplies(viewer: SessionUser, opts: { scope: "mine" | "everyone"; page?: number }): Promise<{ rows: WaitingReplyView[]; total: number; mine: number; everyone: number; page: number; pageCount: number }>;
/** One reply by id for the pinned card (§4.3), whatever page it is on; null when it isn't waiting. */
export async function getWaitingReply(viewer: SessionUser, id: number): Promise<WaitingReplyView | null>;
export async function listOtherMessages(viewer: SessionUser, now?: Date): Promise<Array<{ id: number; fromEmail: string; subject: string; what: string; receivedExact: string }>>;
```
**Consumes:** P1 (classifier, quote, link ids, kind, scope, copy, hints, labels), P2 (`stopCompany`,
`stopRecipients`, `holdCompany`, `releaseCompanyHold`, `undecidedHolds`, `internalSenders`, `notifyUsers`,
`hasUnreadSince`, `activeOwnerId`, `myOutageHold`, `releaseOutageHold`, `listNotifications`, `markSent`'s `onlyFrom`),
existing `markSent`, `finishCheck`, `addPerson`, `searchCompaniesAction`, `NOTIFICATIONS_CHANGED_EVENT`, `storeInbound`,
`realModes`.

**Tests (SPEC "reply matching and auto-reply detection"; B12 "reply matching (headers, from-address, unlinked),
auto-replies in three languages, possible replies"):** each through the real inbound route with the fake
(`postInbound`), then `processPendingInbound`:
- REPLY by In-Reply-To; by References only (unknown colleague: Anna `replied`, others `company_replied`, "not in your
  contacts", Add as a person; known colleague Ben: Ben `replied` + `repliedAt`, Anna `company_replied`, no `repliedAt`
  for Anna); by from-address 89 days **before arrival** (a backlog row processed today still links; an email sent after
  the reply arrived is never chosen), UNLINKED at 91 days; TEST rows never matched by from-address.
- known contact: Ben (Person at Firma, never emailed) writes a new email → REPLY `person`, Firma stopped (Anna
  `company_replied`), status per scope.
- domain hold: an unknown same-domain address writes → UNLINKED, `heldCompanyId` = Firma, Firma HELD `possible-reply`,
  the hint; No answer needed / Link elsewhere → released; Link to Firma → stopped.
- internal sender (Ali forwards Anna's reply to sara@) → TEST_REPLY `internal`, nothing changes; a prospect replying to
  a forwarded test email → linked on (not TEST_REPLY).
- AUTO in en/de/nb (V03, V04, V05 inputs): logged, nothing stopped, no notification; challenge and left-company notify
  with the §5.1 copy once per 30 days (a second one within 30 days: timeline only); a challenge from a filter address
  with no headers links by the named address (V20/V21); unlinked auto → Owner's other messages only.
- POSSIBLE (V09, V30, a log-only row): company held in every campaign, notification; "Real reply" → stops + Replied;
  "It was an auto-reply" → released, but kept held while another undecided possible reply of the company exists; a
  campaign launched while it's undecided is held too; a twin never keeps the hold after the decision.
- spam: preset `spam` (unlinked, `X-Mailgun-Sflag: Yes`) → no notification, not waiting, in the Owner's list "marked as
  spam by Mailgun"; the same flag on a linked reply → a normal REPLY.
- BOUNCE_NOTICE linked (V14 id in text, V15 address): that address stopped in every campaign (campaign scope: the one
  recipient), no suppression, no person flag; a notice naming only another address → nothing stops,
  `reply.attention` (forward failed); delay (V18) stops nothing.
- scopes: LIVE after go-live changes status; LIVE before go-live stops but leaves the status (and still leaves it after
  go-live is switched on and the reply is confirmed later: stored scope); practice-copy simulated reply → Replied + every
  campaign; **a signed NOTIFY reply to a dry-run email in the practice copy → REPLY in real scope**; real-data simulated
  reply → that campaign only, "Dry run:" labels, listed but not counted in `waitingReplyCount`.
- Client company: status kept, still stopped and notified.
- assignee and notify set: inactive sender → Owner; reply at Sara's address about Ali's email → both notified, Ali
  assignee; catch-all → Owner also notified; a simulated reply notifies only the campaign's sender (a real sender
  address or a placeholder alike).
- twins (same non-empty Message-ID and sender only; two rows without a Message-ID are not twins), notify+catch-up
  duplicates (one processing), quiet M3 backlog (no own notifications, effects applied, one `reply.summary` per
  assignee even for 45 rows over 3 batches), `TEST_REPLY` for a reply-test reply (the reply-test page still shows
  "Reply reached the app"), reply to an UNKNOWN email → SENT, reply to a SENDING row → left alone.
- failures: processing throws for a reply from anna@ → retried after 1, 5, 15, 60 minutes (not 5 times in 5 s); after
  the 5th failure Firma is HELD, the row is POSSIBLE_REPLY `process-failed`, and the next sending tick sends nothing to
  Firma; with no company found → UNLINKED `process-failed`, Owner notified.
- `finishCheck` runs: a campaign whose last open company replied finishes in the same call.
- actions (service functions): a Member acts on a teammate's reply (allowed, logged with the Member's name); each error
  text; Answered on a POSSIBLE_REPLY refused; Answered on UNLINKED allowed; Undo (and the domain hold comes back); Link
  (with and without Add as a person; possible → asks; "No, it was automatic" → AUTO_REPLY off the list; `personId`
  from the email when "Not one of these people"; scope from the email; assignee from the email); waiting list ordering,
  mine vs everyone, other messages.
- simulate: three kinds, refusals, repeat → "Already simulated.", messages per data/practice.
- page render: sections, filters, empty states, `?reply=` pins a reply that is on page 2, the not-waiting notice.

**Done when:** tests pass; the Notifications page and outbox compile and render with a seeded test DB.

### P5 — Bell, pop-ups, notification settings, who-has-been-emailed, team, templates (wave 2)

**Owned paths:** `src/app/api/notifications/summary/route.ts`, `src/components/shell/notification-bell.tsx`,
`src/app/(app)/settings/notifications/**`, `src/components/settings/desktop-popups-setting.tsx` (replaced by
`popups-settings.tsx`), `src/server/services/users.ts`, `src/app/(app)/settings/team/**`,
`src/components/settings/team-manager.tsx`, `src/components/settings/types.ts`,
`src/components/company-panel/{emailed-text.ts,company-panel.tsx,people-section.tsx,timeline.tsx}`,
`src/server/services/companies/{detail,query}.ts`, `src/components/contacts/format.ts`,
`src/server/services/imports/check.ts` (the replied flag only), `src/components/activity/activity-filters.ts`,
`src/app/(app)/activity/page.tsx` (the `followups.*` date line only), `src/components/templates/**`,
`src/server/services/templates.ts` (first-subject validation only), tests `tests/integration/team/**`,
`tests/integration/company-panel/**`, `tests/integration/contacts/**`, `tests/integration/import/**` (flag case),
`tests/integration/templates/**`, `tests/integration/notifications-summary/**`, `tests/unit/company-panel/**`,
`tests/unit/contacts/**`, `tests/unit/templates/**` (except P1's subject-rules test), `tests/unit/notifications-ui/**`.

**Builds:** §5.2–§5.4 (summary route with `popups: {items, count, latestId}`, batch pop-up), §6 rows 2, 3, 4 (panel
side), 5 (panel side), 6, 9, 11, 12, §9.2, §9.6–§9.8 (the localhost port from `window.location`), the template editor
subject rules (§2.13), the Activity page's second line for `followups.*` (`data.from/to` in the viewer's zone),
`users.ts` (`NotifyPrefs` via `readNotifyPrefs`, `setPopupGroups(userId, groups, role)`, `deactivateUser(actorId,
targetId, now = new Date(), opts: { campaigns?: "pause" | "finish" } = {})` with default `"pause"` calling the existing
`pauseCampaign` for each Scheduled/Running campaign of the target after its transaction, and **reassigning the target's
unanswered waiting replies to the active Owner inside its transaction** (§4.2), `TeamMember.activeCampaigns:
Array<{id, name, status}>` and `TeamMember.waitingReplies: number`), the `team.test.ts:347` update.

**Provides:** nothing other packages import (P6 only checks).
**Consumes:** contract `notification-types.ts`; P1 (`popupPanelState`, `pollDelayMs`, `shouldPopUp`, `pickPopups`,
`holdStateText`, `sequenceSuffix`, `firstSubjectProblem`); P2 (`popupsAfter`, `latestNotificationId`,
`waitingReplyCount`, `unreadSummary`); existing `pauseCampaign`, `useGuardedNavigate`.

**Tests:**
- summary route: first poll (no `after`) → no pop-ups; `after` + groups + 10 minutes + 5 items + `count`/`latestId`;
  Member never gets `sending` types; `reply.attention` and `reply.summary` in the reply group; `waitingReplies` (dry-run
  rows not counted); 401.
- `readNotifyPrefs`/`setPopupGroups` (legacy `desktopReplies` kept; unknown groups dropped).
- `deactivateUser` pause (default, campaigns Paused with the reason) and finish (untouched); the target's waiting
  replies move to the Owner in both cases (answered ones don't); the dialog's campaign list and reply count; existing M3
  team tests keep passing with the old call shape.
- emailed-text: replied part, HELD texts, "(test list)"; contacts title; import replied flag; timeline icons; the
  Activity page renders a `followups.held` entry's dates in the viewer's zone.
- templates: saving a `Re:` first subject refused with the §2.13 text; the warning shown for "Art: …".
- bell helpers through a jsdom-free unit test of the polling decision (P1 functions) and a render test of the
  settings panel states (as far as existing test tooling allows).

**Done when:** tests pass; bell, settings, team, panel, contacts and templates compile.

### P6 — Integration (after wave 2, one agent)

**Owned paths:** `worker/{main,event-lane}.ts`, `worker/jobs/index.ts`, `worker/jobs/cleanup.ts` (the reply-text
rule), `src/server/activity.ts` (doc list), `tests/integration/worker/**`, `tests/integration/milestone2/**`,
`tests/integration/milestone3/**`, `tests/integration/milestone4/**` (new),
`tests/integration/webhooks/two-process*.ts`, `README.md`, `docs/setup/2-mailgun-and-dns.md`,
`docs/dev/CONVENTIONS.md` (an "M4: sequences and replies rules" section).

**Builds:**
- `EventLane` gets `processInbound` (§3.9: `limit: INBOUND_BATCH`, returns processed + failed, the lane's
  `InboundFailures` map) and re-ticks when replies handled ≥ `INBOUND_BATCH`.
- `createCatchUpJob({ onSuccess })`: `applyOutageHold` first, then `evaluateWarmupDays`, then `runHealthCheck` (each
  failure logged, never failing the catch-up).
- Start-up (`startMailgunSafety`, after the restore step): `applyOutageHold()` when `catchup.outage` has `handledAt`
  null and something detected (logged on failure).
- Daily clean-up (`worker/jobs/cleanup.ts`): `CLEANUP_RULES.replyTextsDays = 30`; in chunks of 500, `InboundMessage
  {processedAt < now − 30 d, OR [bodyText not null, strippedText not null]}` → both set to null; counted in
  `CleanupCounts.replyTexts` and in `cleanupSummary` ("text of 12 replies older than 30 days").
- `activity.ts` doc list: `reply.possible`, `reply.bounce`, `reply.unlinked`, `reply.confirmed`, `reply.linked`,
  `reply.answered`, `reply.notNeeded`, `reply.reopened`, `followups.held`, `followups.released`.
- README: status "Milestone 4 of 6 (Sequences and replies)"; "What happens when the PC is off" gains the hold and "I've
  checked my inbox"; a short "Replies" section (the app can't see inboxes; Answered / No answer needed; reply texts are
  kept 30 days).
- `docs/setup/2-mailgun-and-dns.md`: new section **"19. Test follow-ups and replies (Milestone 4)"** at the end (and
  a pointer at the end of step 14), steps: (0) before practising in the practice copy, cancel old practice campaigns you
  no longer need (their waiting follow-ups would go to the outbox first and use the practice copy's daily limit); (1)
  in the Outlook.com test mailbox set an automatic reply (Outlook.com › Settings › Mail › Automatic replies (may be
  called "Automatic replies" / "Out of office"), UNVERIFIED path); (2) email the "Test mailboxes" list with a follow-up
  after 1 day; (3) when the first emails arrive, reply from the Gmail mailbox; (4) the Outlook.com mailbox answers
  automatically; (5) in the app: Notifications shows the Gmail reply under "Replies waiting for an answer", the Gmail
  company's follow-up shows "Stopped: they replied", the Outlook.com company's follow-up still waits; (6) the next day
  the follow-up reaches only the Outlook.com and other mailboxes, in the same thread; (7) check in Gmail and Outlook.com
  that the follow-up sits in the same conversation (Show original: the `In-Reply-To` line matches the first email's
  Message-ID); (8) mark the reply Answered; switch the automatic reply off. Section 17 ("What happens when the PC is
  off") mentions the hold, including first emails to colleagues at the same companies.
- CONVENTIONS "M4" section: rules 5–7 of §0.2; timing only through `followUpDueAt`; notification copy through
  `@/core/replies/copy`; pop-up groups from `notification-types.ts`; hold fields cleared on every move out of HELD;
  reply windows measured from `receivedAt`.
- M2 end-to-end update (follow-ups now go out in the dry run; replies simulated through §7.1) and M3 end-to-end update
  (no follow-ups switched off; the 3 stored reply-test replies become `TEST_REPLY` after the lane runs and stop
  nothing).
- Two-process test (PLAN B12 "two processes writing at once"): extend `tests/integration/webhooks/two-process.test.ts`
  so the child (web) process runs `processInboundMessage` for the same rows while the parent's lane runs
  `processPendingInbound`; assert each row processed exactly once (one activity, one notification set), no
  `SQLITE_BUSY` reaching either caller, and consistent recipient states.
- The M4 end-to-end test (§11.3).

**Done when:** `npm run check` passes; the worker bundles (the lead may run `node scripts/build-worker.mjs`); the lead's
manual check works end to end.

### Step S — Screen checks (lead, after P6)

See §11.4.

---

## 11. Tests

### 11.1 SPEC and PLAN coverage map

| Required (SPEC testing list, PLAN B12) | Where |
|---|---|
| Follow-up scheduling (weekends, DST) | P1 timing tables; P3 `markSent`/sweeper integration |
| Threading headers | P1 `threadHeaders`; P3 fake-Mailgun request assertions |
| Every stop rule | P2 `stopCompany`/holds; P3 status stops, guard (incl. the final-check guard), HELD filtering, outage gate; P4 reply/bounce-notice/possible/domain-hold/fail-safe effects; M3 unsubscribe/bounce/complaint tests unchanged; E2E part A (bounce, unsubscribe, reply in one run) |
| The outage hold | P2 `applyOutageHold`/release, gap merge; P3 gate; P6 worker wiring; E2E part C |
| Reply matching: headers, from-address, unlinked | P4 (route → lane) with P1 helpers |
| Auto-replies in three languages | P1 vectors V03/V04/V05 (+ fr/es/pl); P4 through the route |
| Possible replies | P1 vectors; P4 decisions |
| Notifications correct | P2, P4, P5; E2E (each user's notifications asserted) |
| The 30-day team rule with follow-ups (SPEC M4) | P3 (practice copy and go-live cases) |
| Two processes writing at once | P6 (`two-process.test.ts` with reply processing in both processes) |
| Owner-only actions refused for Members | P3 (`continueFollowUpsAction`), P5 (`switchOffAction`); reply actions are open to everyone (§4.2) |
| Auth coverage of every new action file | existing `tests/unit/security/auth-coverage.test.ts` (no allowlist change) |

### 11.2 M3 tests that change (m4-code-map §8)

| Test | Change | Owner |
|---|---|---|
| `sending-m3/modes.test.ts:115-128` | follow-ups stay on and go out | P3 |
| `milestone3/end-to-end.test.ts:331-388` | no switch-off; follow-up rows created and sent when due (or assert steps as launched); reply-test replies become `TEST_REPLY` after `runOnce` | P6 |
| `sending/loop.test.ts:130-144` | the follow-up goes out | P3 |
| `unit/campaign-wizard/format-m3.test.ts:69-73`, `wizard.test.ts:108-114` | new sentences (§9.4) | P3 |
| `webhooks/inbound-route.test.ts:59-84` | still valid (the route stays store-only); add the new fields | P2 |
| `catch-up/catch-up.test.ts:261-269` | still valid (`OutageState` literals get `heldFor`/`heldTo`/`heldCount` in step C) | lead (C) |
| `webhooks/two-process.test.ts` | extended with reply processing in both processes | P6 |
| campaign control tests (skip, cancel, retry) | hold fields cleared; Retry refuses a company-replied recipient; `editUnsentEmail` subject rule | P3 |
| `sending-m3/gates.test.ts:301-347` | full guard semantics | P3 |
| `team/team.test.ts:347-353` | `getNotifyPrefs` → `{popupGroups: ["reply"], desktopReplies: false}` | P5 |
| `team/team.test.ts:222-274`, `sender-addresses.test.ts:180-189` | `deactivateUser` old call shape still works | P5 |
| `sending/query-plans.test.ts:113-146` | re-run with the recipient-state filter and the new InboundMessage queries | P3 |
| `sending-m3/helpers.ts:217` (`resetSendingState` marks inbound processed) | keep; M4 tests that need unprocessed replies create them after it | — |

### 11.3 The M4 end-to-end test (`tests/integration/milestone4/end-to-end.test.ts`, P6)

**Part A — practice copy with fast follow-ups** (the PLAN B12 / SPEC definition-of-done shape: temp DB, `practice.copy
= true`, fixed clock Wed 23 Sep 2026 10:00 Europe/Berlin, worker `runOnce`/`tickOnce` with injected clock; the M3
helper sets the webhook signing key so signed webhooks verify; nothing is sent through Mailgun, the campaign is a dry
run):
1. Seed companies A (two people: anna@a.test, ben@a.test), B (carl@b.test), C (dora@c.test), D (dave@d.test), E
   (eve@e.test); a dry-run campaign created and sent by Ali (a Member) with 2 follow-ups (delays 1 and 2), "Treat
   follow-up days as minutes" on, "Ignore sending hours" on; tick every person; launch.
2. Tick → 6 first emails SENT; each recipient WAITING with a follow-up-1 row due in 1 minute; subjects stored.
3. Signed webhooks through the M3 helper `postEvent`: a permanent bounce for Dave's first email and an unsubscribe for
   Eve's → Dave `STOPPED bounced`, Eve `STOPPED unsubscribed`, their follow-up-1 rows `SKIPPED`.
4. Advance 1 minute, tick → exactly 4 follow-up-1 rows SENT (Anna, Ben, Carl, Dora); each has `inReplyTo` = its first
   email's id, `references` = that id, subject `Re: <first subject>`; follow-up-2 rows due in 2 minutes.
5. `postInbound` (signed inbound route) a reply from anna@a.test with `In-Reply-To` = Anna's follow-up-1 `messageId`
   (a dry-run row: links because the practice copy is on, §3.3.1), then `runOnce` → InboundMessage `REPLY`,
   linkMethod `headers`, `replyScope "real"`; company A `REPLIED`, `repliedAt` set, Anna `repliedAt`; Anna `STOPPED
   replied`, Ben `STOPPED company_replied`; their follow-up-2 rows `SKIPPED` ("Stopped: they replied" / "Stopped:
   someone at the company replied"); notification `reply.received` to Ali (no prefix: practice copy); waiting list has
   1; timeline `reply.received` with the first lines.
6. `simulateReply(ali, carlFollowUp1, "out-of-office")` → `AUTO_REPLY` `out-of-office`; B unchanged; no new
   notification.
7. `simulateReply(ali, doraFollowUp1, "unclear")` → `POSSIBLE_REPLY`; C's recipient `HELD possible-reply`; notification
   `reply.possible`.
8. Advance 2 minutes, tick → only Carl's follow-up 2 SENT (Dora held); campaign still Running.
9. `confirmReply(ali, doraReplyId, false)` (P4 service) → C released (WAITING); tick → Dora's follow-up 2 SENT.
10. `markReplyAnswered(ali, annaReplyId)` → waiting list empty; tick → campaign FINISHED; `campaign.finished`
    notification.
11. **Final assertions:** follow-up 1 went to exactly Anna, Ben, Carl, Dora and follow-up 2 to exactly Carl and Dora
    (outbox rows by step and address); nothing ever to Dave or Eve after their first email; Ali's notifications are
    exactly `reply.received` ×1, `reply.possible` ×1, `campaign.finished` ×1; the Owner's contain none of the reply
    types; the campaign overview counts sent 12, bounced 1, replied 1, unsubscribed 1; company A is Replied and B–E
    keep the status M3's rules gave them (Contacted after the first email; a bounce or unsubscribe doesn't change it).

**Part B — live campaign to the test list against the fake** (real-data config, go-live off; fake Mailgun connected
with M3 helpers; reply test passed; mode LIVE; test list gmail/outlook/other mailboxes; one company per mailbox;
clock Wed 23 Sep 2026 10:00 Berlin):
1. Launch a LIVE campaign with one follow-up after 1 day to the 3 test companies; ticks with the clock advancing past
   pacing gaps → 3 messages in `fake.messages`, no duplicates.
2. `postInbound` a reply from the Gmail mailbox with `In-Reply-To` = its message id → lane → `REPLY`; its follow-up row
   `SKIPPED`; company status unchanged (pre-go-live, §3.6); notification `reply.received` to the sender; waiting list 1.
3. `postInbound` an out-of-office from the Outlook.com mailbox (V03 shape: `Automatic reply: <subject>`,
   `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: All`, envelope `""`) → `AUTO_REPLY`; follow-up stays
   QUEUED; no notification.
4. A stored reply-test reply from before (Part B setup) → `TEST_REPLY`, nothing stopped.
5. Advance to Thu 24 Sep 10:05 Berlin, ticks → exactly 2 follow-ups in the fake (Outlook.com and other), none to Gmail;
   each has `h:In-Reply-To: <first id>`, `h:References: <first id>`, subject `Re: <first subject>`.
6. Campaign overview: sent 5, Replied 1.

**Part C — outage hold**:
1. A second LIVE campaign to the other two test companies with a 3-day follow-up; first emails sent Thu 24 Sep.
2. Advance the clock 7 days without catch-ups (set the `<domain>:logs` cursor to Thu 24 Sep); run the catch-up job
   (fake) → `catchup.outage` recorded → `onSuccess` → `applyOutageHold` → both recipients `HELD outage`;
   `outage.hold` notifications to the sender and the Owner; ticks send no follow-up (their recipients are held).
3. `releaseOutageHold(sender, {senderId})` → released; tick (inside the window) → follow-ups sent.
4. The same outage recorded again by a catch-up (same `from`, covered) → nothing re-held, no new notification.

### 11.4 Step S — the lead's screen checks

Stop the services; `next build` and `node scripts/build-worker.mjs`; seed a test database (a practice-data copy,
never `data/app.db`); start the fake (§7.3) and the app with `run-prod.mjs --db <test db>` (sets
`OUTREACH_TEST_RUN=1`). Playwright + axe (lead-written `tests/playwright/m4-screens.spec.ts`) or the browser by hand
plus axe: screenshots, main actions, empty states, errors, contrast and keyboard for:
- Notifications: everything empty; On hold card + dialog (and the "first emails waiting for others" variant); waiting
  list with REPLY, POSSIBLE_REPLY (why lines, incl. a `process-failed` one), UNLINKED (hints, a domain hold), quiet rows
  (both lines), a colleague reply with "Add as a person", Dry run badge; Everyone's/Yours for the Owner and for a
  Member (a Member answering a teammate's reply works and is logged); Link dialog (search, no results, person, possible
  question); filters and their empty state; Owner's "Messages we couldn't link" with a spam row; `?reply=` pins a
  reply from page 2; **the page at 390 px wide**: cards stack, actions wrap, the Link dialog is full screen.
- Bell: unread badge, the waiting line, "See all"; a pop-up on `http://localhost:3100` (secure context) with the tab
  in the background; the batch pop-up.
- Settings › Notifications in every state (office address over http → insecure text; localhost → ask, on, off,
  blocked; the phone text in a narrow touch emulation), the groups card (Owner sees "Sending paused…", Member doesn't).
- Campaign page: held notices (possible and outage), `outage-hold` and `possible-reply` waiting lines, §2.12 state
  texts incl. "(test list)" and "Stopped: they replied", a follow-up step line "waiting, next on … · 5 on hold", the
  recipient panel's simulate link and reply timeline.
- Wizard: Schedule's follow-up sentence and dry-run hint (no Milestone text left), Message step `Re:` error and Outlook
  warning, a Review per-person `Fwd:` subject refused; template editor the same.
- Outbox Simulate with the three new buttons and their toasts (real data and practice copy).
- Settings › Sending & Mailgun: the four outage lines (incl. "recovered without their text"), "Continue Ali's
  follow-ups" dialog.
- Settings › Team: switch-off dialog with and without active campaigns and waiting replies, both choices.
- Activity page: a `followups.held` entry with its dates in the viewer's zone.
- Company panel: banner with "replied …", people Replied flag tooltip, held and stopped sequence texts, new timeline
  icons; Contacts Sequence column and Last emailed tooltip; import check with a replied flag.
- Grep the built pages for "Milestone 4": no hits.

Manual flow against the fake (§7.3): LIVE campaign to the test list, `/__fake/inbound` presets `reply`,
`out-of-office`, `unclear`, `bounce-notice`, `new-email`, `spam` from the fake's own sent messages, and watch the page,
the bell and the pop-up.

---

## 12. Risks, decisions and owner-visible changes

### 12.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A real reply classified AUTO_REPLY | follow-ups continue to someone who answered | a **linked** message is AUTO only with a strong signal; medium signals alone, help-desk acknowledgements and challenges without a strong header become POSSIBLE (the company waits until someone decides); 55 research vectors plus the new ones as tests |
| An auto-reply classified REPLY/POSSIBLE | POSSIBLE: one click ("It was an auto-reply"); REPLY: follow-ups stay stopped and the company may become Replied | the card explains a possible reply; a REPLY can't be undone in M4: set the status back by hand (§12.3 item 14); `stoppedByInboundId` keeps an undo possible later without a migration |
| Processing a message keeps failing (a bug, a long-busy database) | follow-ups could reach someone who replied | retries spread over ~81 minutes (the guard holds meanwhile), then the fail-safe holds the company as a possible reply, never releases it (§3.8) |
| A reply stored while a follow-up is being prepared | the follow-up goes to someone who just replied | the guard runs again in the final check just before the hand-over (§2.5.1) |
| UNVERIFIED OOF wording and localised subjects | some OOFs become POSSIBLE | headers and the null sender catch Outlook/Exchange/Gmail; POSSIBLE is safe |
| Gmail's vacation responder may skip our emails (list headers; UNVERIFIED) | the owner's OOF test shows nothing | the guide uses Outlook.com automatic replies for the test |
| Mailgun rewrites Message-IDs, or changes their case (UNVERIFIED) | follow-ups may not thread in Gmail | In-Reply-To uses Mailgun's id when rewritten, References carry both; the M3 notice; the owner's first real test checks it (guide §19 step 7) |
| A hold nobody releases | follow-ups (and colleagues' first emails) never go; campaign stays Running | Owner release on Settings › Sending; notifications; the campaign page's notices; M6 dashboard |
| The domain hold holds a company because of an unrelated email from its domain | its follow-ups wait until someone links the message or marks it | only one live company with open recipients may match, never shared/free-mail domains; the card says so; No answer needed releases it |
| Follow-ups wait all day when Mailgun can't be reached after a restart | no follow-ups that day | intended (the outage check needs a real catch-up); first emails keep M3's fallback; `catchup-failing` notice after 3 h |
| Company stop across many campaigns in one transaction | SQLite contention | a company has few recipients; one transaction per reply; `stopCompany` uses the `(companyId, state)` index; bulk status stops ≤ 50 companies per transaction; holds and releases ≤ 500 rows per transaction with `updateMany` per group |
| Monday pile-up of follow-ups (research C1) | cap used by follow-ups first | pacing and the daily limit spread them; follow-ups-first is PLAN B6.6 |
| Old dry runs' overdue follow-ups at the first M4 start | on real data: an outbox burst (uncounted); in the practice copy: they use the practice copy's daily limit | per-class candidate queries keep TEST/LIVE sending unaffected; the guide tells the Owner to cancel old practice campaigns first (§12.3 item 12) |
| The M3 backlog processed at the first start marks companies Replied from old replies | surprise status changes | only real LIVE replies after go-live change status (none exist yet); quiet rows send one grouped notice per person |
| Pop-ups don't appear (http office address, Do not disturb, sleeping tabs) | people miss replies | Settings explains each state; the bell and the waiting list are the source of truth |
| Package P3 scope | wave-2 overrun | the lead may split P3 into P3a (engine: gates, loop, mark-sent, restore, eligibility, control, status stops) and P3b (screens: campaign page, wizard, formats, Settings › Sending) with the same owned paths divided by file |

### 12.2 Technical decisions the lead confirms

1. **D1 — Inbound webhook stays store-only.** B6.4's "instant stop" for replies is met by the full guard (§2.5.1, at
   pick time and in the final check) plus the 1-second lane; no classification in the web route.
2. **D2 — POSSIBLE_REPLY holds (HELD), not stops**, so "It was an auto-reply" can resume follow-ups; a release only
   frees recipients that no other undecided message affects.
3. **D3 — `InboundKind.TEST_REPLY`** (enum value, no SQL) instead of leaving test replies with `kind = null`; also used
   for internal senders.
4. **D4 — Quiet after 3 days** (`QUIET_AFTER_MS`), a constant, not a setting; quiet rows give one grouped
   `reply.summary` per person (at most one unread per 24 h).
5. **D5 — Overdue dry-run follow-ups go at once** (§1.3); gated candidates are picked per class so dry runs can't crowd
   out TEST/LIVE rows.
6. **D6 — Outage hold on recipient rows** (`HELD` + `holdReason`), gate-held until applied, single-flight, idempotent
   through `heldFor`/`heldTo` coverage; gaps from several domains merged; colleagues at affected companies held too and
   released when every sender who emailed that company has confirmed.
7. **D7 — Follow-ups need a successful catch-up after every start** (no 15-minute fallback), so an outage can't be
   missed; first emails keep the fallback.
8. **D8 — Real-scope company stops include dry-run campaigns.**
9. **D9 — Bounce notices stop the address only** (and only when they name that address or none), never add a
   suppression or a person flag (Mailgun events stay the authority).
10. **D10 — From-address, known-contact, bounce-address and named-address links use emails of the real modes** (LIVE
    incl. pre-go-live; plus DRY_RUN in the practice copy), sent within 90 days **before the message arrived**, latest
    first; header links have no time limit; dry-run ids link for simulated replies, and for any source in the practice
    copy.
11. **D11 — No `partTypes` column**; the top-level `Content-Type` identifies delivery reports.
12. **D12 — A reply proves sending**: a linked UNKNOWN/UNCONFIRMED (or reconciler-requeued QUEUED) TEST/LIVE email is
    marked SENT through `markSent({onlyFrom})`; a SENDING or FAILED row is never touched.
13. **D13 — Threading after a Mailgun id rewrite** uses the provider id in In-Reply-To and both ids in References.
14. **D14 — Weekend follow-ups go at the next window start** (PLAN B6.4 "next open slot"), not the same local time.
15. **D15 — `dueAt` pre-shifted into the window at creation**, never recomputed after a zone or window change (the
    gates still enforce hours).
16. **D16 — Stop ranks** suppressed < company_replied < replied < bounced < unsubscribed < complained; a reply stop
    also overwrites `failed`.
17. **D17 — Everyone may act on any waiting reply** (SPEC §1); the views default to Everyone's (Owner) and Yours
    (Members); every action is logged with its actor.
18. **D18 — Manual status changes stop recipients at once** (in the status write's transaction).
19. **D19 — The "put back" override covers only replies before the launch.**
20. **D20 — No new Owner settings, no new job types, no new notice keys.** New SystemState fields and wait reasons only.
21. **D21 — `deactivateUser`'s signature stays compatible** (options object last, default "pause"); it always moves
    the user's waiting replies to the Owner.
22. **D22 — Pop-ups: hidden tabs poll every 60 s only while pop-ups are on in that browser**; groups stored per account,
    the on/off switch per browser; one batch pop-up when more than 3 are new.
23. **D23 — Reply scope and "changes status" are stored at processing** (`replyScope`, `changesStatus`) and every
    later decision uses the stored values.
24. **D24 — Classification depends on the link**: linked messages need a strong signal to be AUTO (§3.4 rule 3).
25. **D25 — Reply processing failures back off (1, 5, 15, 60 min) and end in a fail-safe hold**, never a release.
26. **D26 — Reply texts (`bodyText`, `strippedText`) are cleared 30 days after processing**; the snippet and signals
    stay.
27. **D27 — `CampaignRecipient.stoppedByInboundId`** is written now for a later "undo a real reply" (no UI in M4).

### 12.3 For the owner: changes you should know about (plain words)

None blocks the build. For your M4 test you need the same things as for M3 (Mailgun set up, the reply test passed,
2–3 test mailboxes, one of them Outlook.com). Please confirm or say no:

1. **When the app isn't sure a message is a real reply, it asks you.** The company's follow-ups pause until you click
   "Real reply" or "It was an auto-reply" on the Notifications page. PLAN only did this for replies recovered without
   their text (B6.10). Messages that answer one of your emails need a clear automatic marker before the app treats
   them as automatic; otherwise it asks.
2. **Two email markers count only as hints, not proof of an automatic reply**: "don't auto-reply" markers and "bulk"
   markers, because normal emails carry them too. Help-desk confirmations ("Your request 48213 has been received") are
   automatic; any other help-desk email counts as a possible reply (B6.10).
3. **A "delivery failed" email that lands in your inbox stops the follow-ups to that one address only** and doesn't
   put it on the do-not-email list; Mailgun's own bounce reports still do that. If it is about a different address
   (the person's mailbox forwarded your email somewhere that doesn't work), nothing stops and you get a note.
4. **Replies from your test mailboxes don't change the test companies' status before go-live**, so you can repeat the
   test (like M3's rule for test mailboxes). The follow-up still stops, the bell still rings, and the reply is on the
   list. This stays true even if you confirm such a reply after going live.
5. **Changing a company's status to Replied, Client, Not interested or Do not contact now stops its follow-ups
   immediately**, in every campaign (before, they stopped just before their next email).
6. **Putting a Replied company back into a campaign by hand only covers replies from before the launch.** A new reply
   during the campaign stops it again.
7. **After the PC was off too long, the hold also covers first emails to other people at the same companies**, in any
   campaign (PLAN B6.4 said first emails are unaffected). Anyone at a company may have replied unseen, so nobody there
   gets an email until every sender who emailed that company has clicked "I've checked my inbox". Also: after the PC
   starts, follow-ups wait for the check with Mailgun, even if that takes a while (first emails still carry on after 15
   minutes, as in M3). This is what lets the app notice that the PC was off too long.
8. **Replies that arrived more than 3 days before the app processes them don't each ring the bell**; you get one
   notice "Older replies were found" instead (at most one a day), and they appear on "Replies waiting for an answer".
9. **Desktop pop-ups work on a computer, on the secure address or on the office PC itself**, also while the tab is in
   the background (checked about once a minute). You choose which kinds pop up; replies (and messages you need to
   check) are on by default. Pop-ups show who replied, like the bell does.
10. **Switching a teammate off asks what to do with their campaigns**: pause them (default) or let them finish, with
    replies coming to you. Their replies still waiting for an answer move to you either way.
11. **A first email's subject can't start with "Re:" or "Fwd:"** (checked in the template, the wizard, per-person edits
    and at launch), and you get a warning for subjects like "Art: …" that Outlook would split from their follow-ups.
12. **Follow-ups that were waiting in old dry runs go to the dry-run outbox right after the update.** In the practice
    copy they count toward its daily limit, so cancel old practice campaigns you don't need before trying M4 there.
13. **Weekend follow-ups go at the start of Monday's sending hours** in the recipient's time zone (PLAN A5.4); pacing
    and the daily limit spread them out.
14. **If the app files an automatic reply as a real reply, its follow-ups stay stopped** and the company may be
    Replied; set the status back by hand if you want to write to them again (an "undo" button may come later).
15. **Everyone can answer or mark any reply waiting for an answer**, not only their own (SPEC: Members can do
    everything but settings and users). Each person sees their own first ("Yours") and can switch to "Everyone's"; the
    Owner starts on "Everyone's". The timeline records who did what.
16. **A message from someone already in your contacts is linked to their company by their exact address**, even if
    nobody emailed them yet (for example a colleague of the person you wrote to), so that company's follow-ups stop.
    This is exact-address matching, not matching by domain.
17. **A new email from an unknown address on a company's own domain puts that company's follow-ups on hold** until
    someone links the message or marks it (Answered / No answer needed). Nothing is marked Replied by this; it only
    waits. Free-mail and shared domains never count.
18. **Messages Mailgun marks as spam that can't be linked don't ring the bell**; they're listed for the Owner under
    "Messages we couldn't link". A marked message that answers one of your emails is still treated as a reply.
19. **A message sent from your own team's addresses (for example Ali forwarding a reply to Sara) changes nothing.**
20. **Reply texts are kept for 30 days**, then only the first lines stay (the app is not an inbox).
21. **Replies to "Send me a test" or reply-test emails count as test replies only when they come from the test
    mailbox, your team or the test list**; if a prospect answers a test email someone forwarded to them, it counts as
    a real reply.
22. **The old replies from the M3 test campaign appear once on "Replies waiting for an answer"** after the update (the
    reply-test ones don't); mark them "No answer needed".
23. **A real reply also stops that company's dry-run campaigns**, so the outbox never shows follow-ups a real
    campaign would not send (D8).
24. **Status labels:** the Contacts "Sequence" column and the company panel add " (test list)" to live emails sent
    before you went live (for example "Finished (test list)"), and a person who replied shows "Stopped: they replied".

---

## 13. Critique decisions

Two critics reviewed the first version on 2026-09-23 ("spec" and "risk"). Every finding was checked against PLAN,
SPEC and the code. Accepted findings are folded into the sections named; the ones below were rejected or accepted only
in part.

| Finding | Decision | Reason |
|---|---|---|
| spec 1 / risk 1: fail-safe holds "every company found" | partly: one company (the thread's company, else the sender's) | `holdCompany` and the release take one company per message; a thread and a sender pointing at two different companies is too rare to justify a second column; the guard already held both while the row was unprocessed (§1.4) |
| risk 7a: decide whether the other company B gets `company_replied` | B's other people are not stopped; only the replier's own rows are | the reply concerns the company we wrote to; B's status and colleagues are unaffected unless someone links a message to B |
| risk 7a (POSSIBLE nature): hold the cross-company replier's own rows | rejected (listed in §1.4) | a hold is per company; "Real reply" then stops those rows; very rare |
| risk 3: V33 becomes POSSIBLE | rejected | "Fuera de la oficina" is a multi-word prefix, which the critic's own rule keeps strong; V33 stays AUTO |
| risk 15: one-off repair `m4.oldDryRunFollowUps` (re-time or cancel old dry-run follow-ups) | rejected; the crowding half accepted (per-class candidate queries, §2.10) | a repair step for practice data the Owner can cancel in two clicks; the guide says so (§12.3 item 12); on real data dry runs are uncounted and now can't block TEST/LIVE rows; old dry runs finishing send one `campaign.finished` each, which is correct |
| risk 19: neutral pop-ups by default with a "Show names" opt-in | rejected | pop-ups are off until someone turns them on in that browser, and SPEC §10 asks for desktop notifications for new replies; they show the same title as the bell. The body-retention half is accepted as spec 16 (30 days) |
| risk 21: cache thread targets | accepted as a module-level cache pruned every call (§2.5.1) | — |
| risk 18: dedupe `reply.bounce` | not needed | a bounce notice stops the address, so later follow-ups (and notices) don't happen; `reply.attention` is deduped |
| spec 11 / risk 13: grouped notice with counts ("4 replies arrived…") | accepted without counts | one unread `reply.summary` per person per 24 h can't keep a count current across lane runs; the title "Older replies were found" stays true |
| spec 12: add `stoppedByInboundId` now | accepted | cheap now, a migration later |
| risk 12: domain hold | accepted (§3.3.4), listed for the owner (§12.3 item 17) | reversible, never a link or a status change, so PLAN B6.10 "no matching by domain" still holds for linking |

---

## Summary of schema changes

- `enum InboundKind`: + `TEST_REPLY` (no SQL on SQLite).
- `CampaignRecipient`: + `holdReason String?`, + `heldAt DateTime?`, + `stoppedByInboundId Int?`.
- `InboundMessage`: + `envelopeSender String?`, + `strippedText String?`, + `bodyText String?`,
  + `bodyAvailable Boolean @default(true)`, + `signals Json?`, + `linkMethod String?`, + `replyScope String?`,
  + `changesStatus Boolean?`, + `heldCompanyId Int?`, + `assigneeId Int?`, + `answerOutcome String?`; indexes
  + `(assigneeId, answeredAt)`, + `(kind, answeredAt)`, + `(campaignId, kind)`.
- Migration `20260923220000_m4_sequences_replies` (ALTER TABLE ×14, CREATE INDEX ×3, one data UPDATE marking M3
  log-only replies `bodyAvailable = false`).
- SystemState (JSON, no migration): `OutageState` + `heldFor`, + `heldTo`, + `heldCount`; `WaitReason` +
  `"outage-hold"`, + `"possible-reply"`.
- `User.notifyPrefs` JSON (no migration): + `popupGroups`.
