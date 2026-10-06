# Own-mailbox build design: send through polygonparadise.com itself, replies go straight to contact@

Written 2026-09-28 by the architect, for the lead and the build agents. It turns the owner's final decision of
2026-09-27 ("listen, i just want to use polygonparadise.com not mail.polygonparadise.com"; made after two explicit
warnings; no Mailgun upgrade, Free plan) into decisions, contracts, screens, copy and work packages that the build agents
can build in parallel without talking to each other.

**Revised 2026-09-28 after two critiques** (a safety review and an owner/buildability review). §12 lists every point
with its decision and reason; the body below already carries every accepted change. The biggest ones: follow-ups to
prospects now **wait for a daily inbox check** (O33) instead of relying on reminders; the reply test **proves that
unsubscribe-by-email requests reach a mailbox** (O13); an interrupted launch can no longer leave a Message-ID that pauses
sending in a loop (O35); list-pulled complaints and bounces count toward the health auto-pause (O34); the connection
card's choice leads with the domain (O7, §3.1); and the owner's guide starts with a nine-line quick path (§6.1).

**Review fixes of 2026-09-28** (after the build): §13 lists every confirmed finding of the own-mailbox review and where it
was fixed; the sections it touches (§1.6, O13, O33, O34, §3.3–§3.9, §4, §9.4, §10.1, §10.3, §11 Q6) carry short notes.

Sources, all read in full: `docs/dev/CONVENTIONS.md` (with "Shared From address rules"); `docs/dev/SHARED-FROM-DESIGN.md`
(the Shape B build this mode sits next to; §1.2 compares it with "Shape A: send through the root", which is what the
owner now chose, minus the reply subdomain); `docs/dev/research/mailgun-shared-from.md`;
`docs/dev/research/shared-from-mail-behaviour.md`; `docs/dev/shared-from-code-map.md`;
`docs/dev/main-domain-code-map.md` (every `file:line` this design names without a new reading comes from it); and the code
it points at (`core/sending/{from-address,mode-gates,go-live-copy,caps}.ts`, `core/sender-address.ts`,
`core/dns/checklist.ts`, `core/reply-test.ts`, `core/setting-types.ts`, `core/dashboard/attention.ts`,
`server/settings.ts`, `server/mailgun/{context,errors}.ts`, `server/services/mailgun/{team-from,connect,routes,apply-settings,catch-up}.ts`,
`server/services/sending/{addresses,gates,usage,mailgun-transport}.ts`, `server/services/campaigns/{launch,control,draft}.ts`,
`server/services/{reply-test,test-send,go-live,users}.ts`, `server/services/checks/{domain-check,spf-count}.ts`,
`server/services/companies/mutations.ts`, `server/services/mail-events/stops.ts`, `server/services/replies/effects.ts`,
`components/settings/sending/connection-form.tsx`, `components/company-panel/{company-header,people-section,actions}.tsx`,
`app/(app)/campaigns/[id]/page.tsx`, `tests/fake-mailgun/{state,admin,cli,inbound-presets}.ts`, `playwright.config.ts`,
`tests/playwright/instances.ts`, `tests/unit/docs/guide-refs.test.ts`).

Public pages read again on 2026-09-28 (no API was called):

| Fact | Quote | Source |
|---|---|---|
| Free plan | "100 emails per day", "1 custom sending domain", "1 inbound route", "1 day of log retention", "1 day of message retention", "Email Validations: Available as add-on"; Basic "1 day of log retention", "5 inbound routes"; Foundation "5 days of log retention", "Full access to inbound routing" | https://www.mailgun.com/pricing/ |
| Logs on Free | "at least 30 days for paid accounts, and at least 2 days for free accounts" (contradicts the pricing page: plan with 1 day) | https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-messages.md (code map §0.1) |
| Late bounces | "Mailgun can track delayed bounces, but only if the domain that the email message was sent from has MX records pointing to Mailgun; Otherwise, NDR email messages will not reach Mailgun." | https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-failures.md |
| One-click unsubscribe | "The List-Unsubscribe header field MUST contain one HTTPS URI. It MAY contain other non-HTTP/S URIs such as MAILTO:." (§3.1) and "A mail receiver can do a one-click unsubscription by performing an HTTPS POST to the HTTPS URI in the List-Unsubscribe header." (§3.2) | https://www.rfc-editor.org/rfc/rfc8058.html |
| Who must offer one-click | "Starting February 1, 2024, email senders who send more than 5,000 messages per day to Gmail accounts must meet the requirements in this section." (one-click unsubscribe is in that section); for all senders: "Set up SPF or DKIM email authentication for your sending domains", "Keep spam rates reported in Postmaster Tools below 0.3%" | https://support.google.com/a/answer/81126 |
| Test mode | "Enables sending in test mode. Messages are processed normally but not actually delivered to recipients." The page read on 2026-09-22 also said "You are charged for messages sent in test mode!"; today's page no longer says it. Treated as counting toward the daily limit (safe side). | https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages.md, `research/mailgun-sending.md:45` |
| Send API answers | 200, 400, 429, 500 are the only codes the reference lists; nothing about quotas | same page |

**The shape in one paragraph.** The Mailgun sending domain is `polygonparadise.com` itself (US region, already verified:
SPF through GoDaddy's two `_spfm` includes, DKIM `mx._domainkey` 1024-bit, tracking CNAME `email` → `mailgun.org`; MX =
Zoho and never Mailgun). A new Owner choice on the Mailgun connection card, **How the app sends** = **From
polygonparadise.com itself (replies come to your own inbox)** (`mailgun.replies = "own-mailbox"`), switches the app into
**own-mailbox mode**: every email is `From: "<display name>" <contact@polygonparadise.com>` with **no Reply-To**,
Message-IDs `pp.…@polygonparadise.com`, no per-person sending address, no Mailgun route, no reply-route hold. Replies,
automatic replies, removal requests and late bounce notices land only in Zoho; people mark them in the app with a new
**They replied** button (or **Mark unsubscribed** / **Do not contact**), and **live follow-ups wait each day until
someone has read contact@ (inbox and Spam) and clicked "I've read contact@polygonparadise.com"** (the inbox check, O33).
The checklist's "Replies reach the app (MX)" row is replaced by the inverted guard "Mail for polygonparadise.com stays
with your mail provider (MX)" (red on any Mailgun MX, a null or missing MX, or Cloudflare Email Routing; holding every
live email and telling the Owner), the SPF row becomes include-aware and never proposes a merged record, the reply test
becomes a by-hand test that still proves inbox placement, DMARC, the signer and the unsubscribe paths (the link, and an
email to the `mailto:` address reaching a mailbox someone reads), and the app keeps to the Free plan: at most 90 campaign
emails a day inside a rolling 100-in-24-hours guard, 1 day of logs (complaints and bounces from Mailgun's lists still
count toward the health auto-pause), http unsubscribe links acknowledged at go-live, webhooks optional (events arrive
through the hourly Logs catch-up while `start.bat` runs). Per-person mode and shared-From mode (Shape B) stay
byte-for-byte as they are, except the few deliberate changes listed in §0.2 rule 4.

**Nothing in this work may ever call the real Mailgun, the real Anthropic API, a real website or Cloudflare during the
build, the tests or the lead's checks.** Mailgun is the local fake (`tests/fake-mailgun/**`), DNS the fake `DnsLookup` or
the fake-mode lookup, as in M6-DESIGN §0.2 rule 13. Nobody on the build side opens `data/app.db`, and nobody contacts the
owner's dev server on port 3000.

---

## 0. How to use this document

### 0.1 Order of work

| Step | Who | What | Blocks |
|---|---|---|---|
| **C** (contracts) | Lead, before wave 1 | First tell the owner in one line: "While the app is being built, the window running `npm run dev` may show errors; close it (Ctrl+C) and use start.bat once the build is done." No service or window is stopped: there is no schema change and no migration (§7.3), and nothing here needs a restart. Write the contract files and edits of §7.4–§7.8 (the full list is §7.9), including the three pinned places that quote `SENDING_DOMAIN_TEXTS.website` (§9.2 first rows) and the fake's own test file (§7.8). Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json` and `npx vitest run`: everything passes (every new parameter is optional and means "today's modes" when absent; `mailgun.replies` defaults to "app"). | everything |
| **Wave 1** | P1–P6 in parallel | P1 every email in own-mailbox mode (snapshot, launch and its last re-check, retry, gates: route hold, MX hold, plan-limit guard, **inbox-check gate**; the loop's final check and the blocked-twice rule; today's cap; transport; simulate; campaign page; wizard Sender step; outbox; `errors.ts`, `context.ts` and `client.ts` after step C). P2 connecting and the Sending page (connect, the mode switch and its labels, the plan select and the automatic Free plan, the From card, Apply, routes short-circuit, sending-domain texts; `team-from.ts` after step C). P3 the Domain checklist's facts and rows (own-mailbox rows, include-aware SPF, the last good MX, the website-domain guard, fake-mode DNS, notices). P4 the by-hand reply test (with the unsubscribe-by-email question and the DMARC gate), test sends, the go-live switch, card and dialog, the Domain checklist page (`mode-gates.ts` and `go-live-copy.ts` after step C). P5 people, limits, dashboard (the inbox-check item, the own-mailbox empty replies tile), health, log retention, the outage gap, the suppression pull's linking. P6 **replies by hand**: They replied (service, actions, company panel, campaign person panel, stop codes) and the inbox check (service, action, card, Notifications page). | wave 2 |
| **Wave 2** | P7, P8 in parallel | P7 the owner docs (the new own-mailbox guide, README, guides 2–4 notes, SPEC/PLAN notes, the docs tests). P8 the end-to-end test of the owner's shape, the manual-check seed state `own`, the Playwright specs, `run-prod.mjs --no-public-address`, the start.bat port message, and the fake Mailgun after step C. | P9 |
| **Final** | P9 (one agent) | Integration: the whole suite, the seams, CONVENTIONS "Own-mailbox rules", activity/notification doc lists, the whole-tree safety sweeps of §9.1, `npm run check`, the worker bundle self-test. | step S |
| **S** (screens) | Lead, after P9 | `next build`, `node scripts/build-worker.mjs`, seed `own` (and re-seed the others), run the Playwright suite per state and the manual checks of §9.5. | review |

### 0.2 Rules for every builder (in addition to `docs/dev/CONVENTIONS.md`, M6-DESIGN §0.2 and SHARED-FROM-DESIGN §0.2)

1. Only edit your **owned paths** (§8). Contract files from step C are read-only for everyone unless §8 hands one to
   your package: if one is wrong or missing something, STOP and report it in your final answer.
2. In wave 2 you may import from wave-1 packages (their exports named here), the contract files and existing code, never
   from a wave-2 peer. Wave-1 packages never import each other's new exports: everything they share is in step C.
3. Every user-visible sentence in this document is the copy to use (§3). Change wording only to fix grammar. No
   "Milestone N", no PLAN question numbers, no builder's voice in any screen, script or doc.
4. **Per-person mode and shared-From mode are sacred.** With `mailgun.replies` missing or "app" (the default, the
   practice copy, every existing test), every screen, header, row and sentence stays exactly as today. Every new
   parameter is optional and absent means "app". An existing test that has to change is listed in §9.2; any other failing
   existing test is a bug in your package. **The only deliberate changes in app mode** (§2.1 O30): the Mailgun connection
   card shows the "How the app sends" choice (default: through a sending subdomain) with a one-click switch when the
   website domain is typed, and, under Advanced, "Your Mailgun plan" (default Not sure = today's behaviour) and the new
   retention hint; `SENDING_DOMAIN_TEXTS.website` names the choice; a 400 or 403 **to a send** whose text says a sending
   limit is reached pauses instead of failing the email for good, and a "not allowed to send" refusal that mentions
   authorized recipients gets its own sentence (every mode; no other endpoint's error kinds change); **They replied**
   also shows in shared-From mode and in the practice copy; a plan the Owner chooses (never chosen by default in app
   mode) caps the daily limit and the log retention in every mode; the Domain checklist never proposes an MX record or an
   SPF value for polygonparadise.com even if it is somehow stored as an app-mode sending domain (O37); and start.bat's
   "port already in use" message names `npm run dev`.
5. **Own-mailbox mode is one flag.** Code decides it only from `loadTeamFrom().replies` or `MailgunContext.replies`
   (`loadPlanLimits()` also reads the flag, for the assumed Free plan; all three parse Setting `mailgun.replies` with
   `repliesOf()`), never from "the From address is on the sending domain" (per-person mode has that too) and never by
   reading the setting raw.
6. **The From line of an own-mailbox email comes from one place**: `ownMailboxHeaders()` (through `senderSnapshot(…, {
   ownMailbox })`, "Send me a test" and the reply test). No Reply-To is ever set in own-mailbox mode.
7. **polygonparadise.com's MX never points to Mailgun, and the app never asks for it** (§2.5): no row, record box, fix,
   guide line or Apply step proposes a Mailgun MX record for polygonparadise.com or any SPF value for it (in own-mailbox
   mode for the sending domain; in any mode for a `WEBSITE_DOMAINS` domain, O37). The only MX values the app or a guide
   ever names are the mail provider's own (the last good MX the app saw, O10, or Zoho's in the guide's troubleshooting),
   for putting them back; no MX record box exists in own-mailbox mode. The P3 safety test and the P8 end-to-end test
   check every row and every request.
8. **No Mailgun route in own-mailbox mode** (O8): `syncRoutes` is the one door and it creates, updates and deletes
   nothing while `replies = "own-mailbox"`.
9. **Fail closed** (§2.4): an own-mailbox email whose From isn't today's own From, that carries a Reply-To, or whose
   Message-ID isn't on the sending domain never reaches Mailgun; sending pauses with the "From or reply address"
   sentence.
10. **No network inside a transaction; lock-first `dbTx`; owner-only actions checked server-side with
    `requireOwnerAction()` (They replied and "I've read contact@…" are the two new actions open to Members,
    `requireUserAction()`, listed in `EVERYONE_ACTIONS`); zod for every action input; secrets never reach the browser.**
    Nothing in this design needs a network call inside a transaction.
11. Commands: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`, `npx eslint <owned paths>`,
    `npx vitest run <own test paths>`. Never `next build/dev/start`, `npm install`, `prisma migrate *`,
    `npx playwright test`, and never a request to port 3000.

### 0.3 Words used in this document

| Word | Meaning |
|---|---|
| **App mode** | Setting `mailgun.replies` missing or `"app"`: replies come back through Mailgun routes. It contains the two existing modes: **per-person mode** (`mailgun.fromAddress` empty) and **shared-From mode** (Shape B, a From on the sending domain's main domain). |
| **Own-mailbox mode** | Setting `mailgun.replies = "own-mailbox"`. The sending domain is the domain of the Owner's own mailbox (here polygonparadise.com, MX Zoho); every email is From the **own From** with the sender's display name, no Reply-To; replies land in that mailbox only. |
| **Own From** | Setting `mailgun.fromAddress` in own-mailbox mode, exactly on the sending domain: `contact@polygonparadise.com`. `loadTeamFrom().ownFrom` when saved and fitting. |
| **Evidence From** | `loadTeamFrom().evidenceFrom` = the shared From (shared-From mode) or the own From (own-mailbox mode), null in per-person mode. The From that test emails, the reply-test decision, the live test and go-live belong to. |
| **The root** | polygonparadise.com, the owner's website and everyday-email domain. |
| **Plan limits** | `planLimits(plan, replies)`: the daily limit and log retention of the Mailgun plan the Owner chose (Setting `mailgun.plan`), or of the Free plan when own-mailbox mode has none chosen. |
| **Rolling guard** | Nothing goes to Mailgun while the emails the app handed to Mailgun in the last 24 hours reach the plan's daily limit (campaign emails 10 earlier, keeping room for tests). |
| **They replied** | The new by-hand reply action (§2.9): every follow-up to the company stopped ("Stopped: they replied" / "Stopped: someone at the company replied"); company status Replied and `repliedAt` only when the company was really emailed (after go-live), as a real reply would (O17). |
| **Inbox check** | The daily "I've read contact@polygonparadise.com" click (O33): SystemState `sending.inboxCheck`. In own-mailbox mode a LIVE follow-up goes only when the last check is in today's cap day and later than that person's previous email. |

---

## 1. The decision and the shape

### 1.1 What the owner decided, and the facts it lives with

- The owner wants to use polygonparadise.com, not mail.polygonparadise.com, and will not upgrade Mailgun. Every email
  shows `"Name from Polygon Paradise" <contact@polygonparadise.com>`. Replies go straight to the Zoho inbox (contact@),
  where the app can't see them; the team marks replies in the app by hand. This is SHARED-FROM-DESIGN §1.2's Shape A
  without its reply subdomain (a reply subdomain needs a second custom domain and routes, which Free doesn't have).
- **Mailgun account:** Free plan (100 emails a day, 1 custom sending domain, 1 inbound route, 1 day of logs, validations
  an add-on). An https tracking certificate is probably not included (the app treats a 402 as "not in plan",
  `apply-settings.ts:507-509`). Free accounts without a card may only send to authorized recipients (research
  `mailgun-sending.md:60`; UNVERIFIED for this owner).
- **DNS of the root (GoDaddy):** MX `mx.zoho.com`, `mx2`, `mx3` (must never change); SPF = two GoDaddy `_spfm` includes
  (Zoho and Mailgun), 9 of 10 lookups; DKIM `mx._domainkey` 1024-bit (Mailgun) and `zmail._domainkey` (Zoho); tracking
  CNAME `email` → `mailgun.org` (US); no DMARC.
- **The app today:** `data/app.db` is empty apart from the Owner; no Mailgun settings; `APP_PUBLIC_URL` is empty (no
  Cloudflare); the owner runs `npm run dev` (no background sender). Today the app refuses polygonparadise.com as the
  sending domain (`sender-address.ts:131`), refuses contact@ on the sending domain as the From (`from-address.ts:150-151`),
  and even with both allowed would hold every live email for ever (`gates.ts:1031-1034`), refuse every launch
  (`launch.ts:172-179`), never pass the reply test (`core/reply-test.ts:179`), keep the `mx` row red and propose two DNS
  "fixes" that would break the owner's everyday mail (`checklist.ts:720-727,750-754`, `:547-549`; code map §0.2).

### 1.2 What own-mailbox mode gives up (compared with Shape B)

| Message | Shape B (mail.polygonparadise.com) | **Own-mailbox mode** | What the team does |
|---|---|---|---|
| A normal reply | route → app (stops follow-ups, Replied, notification) and forwarded | **contact@ only** (inbox, or Zoho's Spam folder) | **They replied** on the company; LIVE follow-ups wait for the day's inbox check (O33), so this happens before the next follow-up |
| New email typed to contact@, a colleague writing from a forward, the rest of a conversation | contact@ only | contact@ only | the same |
| Out-of-office / automatic reply (RFC 3834: to the Return-Path) | Mailgun | `bounce+…@polygonparadise.com` at Zoho: rejected, or a catch-all mailbox if one is set (UNVERIFIED; with the catch-all the reply test asks for, O13, it reaches contact@) | nothing (information only) |
| Auto-reply or non-standard bounce to the From | contact@ | contact@ | a "couldn't be delivered" notice → **Mark unsubscribed** on that person |
| Late (asynchronous) bounce | Mailgun → `failed` event, suppression, bounce brake | at Zoho: **lost**, or contact@ through a catch-all; no event, no suppression, the bounce brake counts fewer | a notice in contact@ → **Mark unsubscribed** |
| Immediate bounce (during the SMTP session) | Mailgun | **Mailgun → `failed` event** (unchanged) | automatic |
| Complaint (feedback loops; Gmail has none) | Mailgun | **Mailgun** (keyed on Mailgun's IPs, unchanged); if its Logs entry is missed while the PC is off, the complaints list still brings it and it counts toward the health auto-pause (O34) | automatic |
| Unsubscribe link in the body / one-click POST | Mailgun (https on Foundation) | **Mailgun**; the link is http on Free (§2.8), so mail programs' own "Unsubscribe" buttons are likely to use the `mailto:` below instead | automatic |
| `mailto:` unsubscribe (Likely `u+…@polygonparadise.com`) | Mailgun | **Zoho**: rejected unless a catch-all (or alias) catches it. **The reply test sends one by hand and fails until it reaches a mailbox someone reads** (O13) | a request in contact@ → **Mark unsubscribed** |
| `delivered` / `failed` events | webhooks + Logs | Logs every hour (webhooks only with a public address) | automatic, needs `start.bat` |
| Reply notifications, "Replies waiting", reply counts, auto-reply sorting, the dashboard's replies tile | yes | **empty** (the reply rate still counts They replied, O17) | — |

### 1.3 Where each job of "the sending domain" lives (SHARED-FROM-DESIGN §1.3)

| Role | App mode | Own-mailbox mode |
|---|---|---|
| R1 API domain of `POST /v3/{d}/messages` | `mailgun.domain` | `mailgun.domain` = polygonparadise.com (`mailgunDomainOf(from, null)`) |
| R2 From address | own address / shared From | **the own From** (contact@polygonparadise.com) with each sender's display name |
| R3 Message-ID domain | the sending domain | the sending domain (`pp.…@polygonparadise.com`), so the reconciler, the catch-up's own-send check and the reply test's filters keep working |
| R4 per-person address = route address | SenderAddress | **none** (no SenderAddress, no route) |
| R5 receiving (MX, routes, catch-all, dmarc@, stored replies) | Mailgun | **nothing**: MX is Zoho's and guarded |
| R6 Mailgun settings (tracking, unsubscribe, certificate, webhooks) | the sending domain | the root (Apply changes the root's Mailgun tracking settings, §2.8); spam filter and stored-reply retention are skipped |
| R7 per-domain state (checklist, reply test, warm-up, go-live, cursors, restore walk) | `mailgun.domain` | `mailgun.domain` (unchanged key); the reply test and go-live also record the evidence From and the mode |

### 1.4 What the owner does (the own-mailbox guide has the steps; §6.1)

1. Keep polygonparadise.com in Mailgun exactly as it is (US, SPF and DKIM verified, MX "unverified" for good). Never
   add Mailgun's MX records to it (Mailgun's domain page lists them: ignore them), never delete it, leave the sandbox
   domain alone.
2. Close the window running `npm run dev` (Ctrl+C) and start the app with **start.bat** (the first start builds for a few
   minutes; without the background sender nothing is sent, checked or caught up).
3. Create a Developer API key. Settings › Sending & Mailgun › Mailgun connection: Region **US**, How the app sends
   **From polygonparadise.com itself**, Sending domain **polygonparadise.com**, the API key, **Save and connect** (the
   app sets Your Mailgun plan to Free by itself, O22).
4. From address card: **contact@polygonparadise.com**, **Save From address**.
5. GoDaddy: add one TXT record `_dmarc` = `v=DMARC1; p=none`. Change nothing else.
6. Domain checklist › Check again, then Apply recommended settings.
7. My profile: display name ("Arslan from Polygon Paradise"), signature, the inbox for test emails.
8. Test list (one Outlook.com, one Gmail) and Sending mode **Live (test list only)**; the reply test by hand (including
   one email to the unsubscribe-by-email address; if it bounces, a catch-all in Zoho); a live test to the Test mailboxes
   companies; go live with the ticks.
9. Every working day: read contact@ (inbox and Spam), click **They replied** / **Mark unsubscribed**, then **I've read
   contact@polygonparadise.com** (Notifications › Inbox check): live follow-ups wait for that click.
10. Optional tidying: delete any `MAILGUN_…` line from `.env` (the app never reads them: keys live encrypted in
    Settings; `src/**` reads no `MAILGUN_*` variable).

### 1.5 What stays exactly as today

App mode entirely (per-person and shared-From), except §0.2 rule 4. In own-mailbox mode too: the test-list guard and
`validateTestList` (every mailbox on the sending domain is refused, so contact@ can never be a test mailbox); the
Message-ID and threading rules; `mailgunDomainOf`; the catch-up and its cursors (retention aside); suppressions push and
pull and "Remove it" (the pull links bounce and complaint entries to the email they concern, O34); the restore scan and
`domainsBefore` (retention aside); the reconciler (retention aside); health thresholds; warm-up steps and evaluation (the
cap aside); per-sender caps and pacing (keyed by the user); address checks; the practice copy (no Mailgun there, so no
mode; it gains the They replied button, O17); webhooks and their checks (when a public address exists); the
`delivered`/`failed`/`complained`/`unsubscribed` flows; `internalSenders()` (the evidence From is added, as in shared-From
mode); the loop's final check (plus the inbox check, O33).

### 1.6 Deferred (not built now)

| Item | Why it can wait | Hook left |
|---|---|---|
| Getting contact@ mail into the app (Zoho forwarding to a store-only route) | Free allows 1 route and Zoho's forwarding needs a paid plan (research `shared-from-mail-behaviour.md` §5); privacy cost | `syncRoutes` short-circuit (O8) is the one place a store-only route would start |
| A "When did they reply?" date on They replied | `repliedAt` = the click time is close enough for the reply rate; a date field adds a form | `markRepliedByHand(…, { at })` takes an optional `at` (UI sends none) |
| Reply counts on the campaign page from They replied | the counts are built from `InboundMessage` (`queries.ts:382-386`); the stop reason already shows "Stopped: they replied" per person | stop codes `replied` / `company_replied` with `stoppedByInboundId` null |
| A "Someone replied?" box on the dashboard (paste the sender's address, the app finds the person) | Contacts' search already finds a person by email address (`company-search.ts:45`); the inbox-check card says so | `markRepliedByHand` takes `personId` |
| ~~An app-built `List-Unsubscribe` header without the `mailto:`~~ **Built by review REPLIES-03 (§13)** as the self-checking last resort | offered only after the unsubscribe-by-email question is answered No (or its address can't be read); refused while a test or live campaign is scheduled, running or paused | `UnsubscribeTestSetting.leaveOutMailto`; `WEB_ONLY_LIST_UNSUBSCRIBE` added only by `MailgunClient.sendMessage`; the pasted original must show a link and no `mailto:` |
| A "Resume" confirmation for own-mailbox campaigns with overdue follow-ups | the inbox check (O33) already holds them until today's check after the last email | — |
| A per-person "They replied" in the status menu for app mode | per-person mode is sacred; the status picker already stops follow-ups | the same service |
| Removing the app's routes of an older domain after a switch to own-mailbox mode | they still catch late replies to earlier campaigns; Mailgun keeps them within the plan's rules | `syncRoutes` |
| An https certificate on Free | Mailgun decides per plan (UNVERIFIED); Apply keeps asking and the row turns "ok" by itself if it is granted | Apply's certificate step |
| Auto-detecting the Mailgun plan | no documented read-only endpoint was checked; the Owner chooses it (O22) | `mailgun.plan` |
| A daily-limit refusal status/text confirmed with Mailgun | never probed; the rolling guard keeps below it and the "limit" kind covers a 400/403 to a send with limit words (O24) | `classifyStatus(…, { send: true })` rule |

---

## 2. Decisions

### 2.1 Decision table

| # | Decision | Why |
|---|---|---|
| **O1** | **One explicit switch**: Setting `mailgun.replies: "app" \| "own-mailbox"`, default `"app"`; any other stored value reads as `"app"` (`repliesOf()`). Chosen on the Mailgun connection card ("How the app sends", §3.1), written only by `saveConnection` in `connect.ts` (through `connectMailgun`), read only through `loadTeamFrom()`, `loadPlanLimits()` and `getMailgunContext()`. | Deriving the mode from "the From is on the sending domain" can't work: per-person mode's From is on the sending domain too. The sending domain's validation depends on the mode (O7), so the choice belongs to the connection, and one flag keeps app mode byte-for-byte. A corrupted value falls back to app mode, where the root is refused at connect and every own-mailbox From is a misfit: sending fails closed; the checklist's DNS advice fails closed too (O37). |
| **O2** | **Changing the mode is a sending-domain change** (G8, F28): `connectMailgun`'s `changing` also compares the mode (`oldReplies !== replies`). Refused while a TEST/LIVE campaign is scheduled, running or paused; ends go-live; resets the reply test; restarts evidence (`restartEvidence`); clears the Apply run; re-pushes suppressions; logs `mailgun.domainChanged` with `fromReplies`/`toReplies`. | A mode switch changes where replies go, which DNS rows apply and what the reply test proved. The owner's switch to polygonparadise.com is also a domain change; the rare same-domain switch is treated the same way. |
| **O3** | **The own From is Setting `mailgun.fromAddress`** (one door, `saveFromAddress`), validated in own-mailbox mode by `validateOwnMailboxFrom`: exactly on the sending domain (never a subdomain, never another domain), not a mail-server or no-reply name (`TEAM_FROM_REFUSED_LOCAL_PARTS`, `pp-route-check…`); `contact@` allowed. Empty may be saved (so the Owner can always switch back without a deadlock), but then `loadTeamFrom().problem` = `OWN_MAILBOX_TEXTS.fromMissing(d)` and test and live launches, test sends and the reply test refuse. | One setting, one writer, as in shared-From mode. A From on another domain would fail DMARC; `contact` is exactly the owner's address. |
| **O4** | **`TeamFromState` keeps `address` = the shared From (Shape B) only** and gains `replies`, `ownFrom` and `evidenceFrom` (= `address ?? ownFrom`). In own-mailbox mode `address` is null. | Thirty readers use `address !== null` as "shared-From mode". Left untouched they fall to per-person paths that need a SenderAddress and a working route: in own-mailbox mode that refuses or holds (fail closed), never sends wrongly. Readers that need "the From this way of sending uses" switch to `evidenceFrom` (§7.5). |
| **O5** | **Headers**: From = `formatFromHeader(displayName, ownFrom)`, **no Reply-To**; Message-IDs on the sending domain; `Campaign.sendingDomainId` = the active domain row. Built by `ownMailboxHeaders()` via `senderSnapshot(user, mode, null, { ownMailbox })`. Nobody needs or gets a SenderAddress: `setSenderLocalPart` refuses, `saveConnection` moves no address, My profile hides the field. | A Reply-To to `arslan@polygonparadise.com` would bounce at Zoho; a per-person address on the root would create routes. The display name keeps the person visible. |
| **O6** | **Fail closed**: `senderHeaderProblem(d, from, replyTo, { ownMailboxFrom })` accepts in own-mailbox mode only From address = today's own From and no Reply-To; the transport also needs the Message-ID on `d`; `MailgunClient.sendMessage` runs the same check (the context gives the client `ownMailboxFrom`). Any mismatch: nothing sent, `SENDER_HEADERS_PAUSE`. | The From change, the mode switch and Retry are all refused while campaigns send (O2, O16), so a mismatch can only be a bug or a restored oddity. |
| **O7** | **The website domain may be the sending domain only in own-mailbox mode**: `validateSendingDomain(input, { replies: "own-mailbox" })` allows polygonparadise.com; `www.` names stay refused (`SENDING_DOMAIN_TEXTS.www`); Mailgun's sandbox and shared domains stay refused, and every own-mailbox refusal sentence uses polygonparadise.com as its example, never mail.polygonparadise.com (`emptyOwn`, `invalidOwn`, `sandboxOwn`, `sharedOwn`). App mode refuses the root as today (sentence O30); the connection form then offers a one-click switch to own-mailbox mode. The choice itself leads with the domain: **How the app sends** = "From polygonparadise.com itself (replies come to your own inbox)" / "Through a sending subdomain (replies come through the app)". | In app mode the root would get per-person addresses, routes and a red MX row. The owner thinks "use polygonparadise.com", so the choice is worded that way; the sandbox domain is the likeliest paste mistake (Mailgun lists it next to the real one). |
| **O8** | **No routes in own-mailbox mode**: `syncRoutes` returns `{ ok: true, … }` right after the connection check, touching neither Mailgun nor any SenderAddress; Apply's "routes" step is "Not needed" (ok: null); `connectMailgun`, `users.ts` and `removeOwnSuppression` queue no route sync in this mode. Routes of older domains stay in Mailgun as they are. | The Free plan has one inbound route; a catch-all on the root would never fire (MX Zoho) yet `/routes/match` would call it "ok". |
| **O9** | **Nothing waits on routes in own-mailbox mode**: no LIVE `reply-route` hold (`gates.ts:1031`), no `no-sender-address`/`no-reply-route` launch problems, no `senderHasReplyRoute`, no `sendersWithoutRoute`, no `ownerRoute`/`publicAddress` reply-test blockers, no reply-route notices; the loop rule doesn't apply to the own-mailbox domain (a reply or test inbox on polygonparadise.com is allowed). | There is nothing to route. The loop rule exists because routes forward to the inbox. |
| **O10** | **The root's MX guard, inverted and kept.** Own-mailbox mode has no `mx` row. The `from-mx` row is built for the sending domain itself with own-mailbox wording (§3.3): red on any Mailgun MX (either region), a null MX, no MX **or Cloudflare Email Routing**; no record box; every red fix deletes Mailgun's or Cloudflare's MX, names the **last good MX** the app saw (`DomainCheckState.lastGoodMx`, saved at every check where the row was ok: `mx.zoho.com` 10, `mx2.zoho.com` 20, `mx3.zoho.com` 50) to put back, and ends with `NEVER_MAILGUN_MX_TEXT(d)` ("Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to polygonparadise.com."). It gates Live mode, the reply test, a LIVE launch and go-live (`fromMx`/`fromMxUnchecked`), holds every LIVE email (`main-domain-mx`) and notifies the Owner once a day (`from-mx-bad`, own-mailbox body). In own-mailbox mode it applies, and the Domain checklist page shows it, whether or not a From is saved. | Replies, the owner's everyday email and every client's answer depend on it; one wrong GoDaddy record (its form fills Name with `@`) or switching on Cloudflare Email Routing (likely once the Cloudflare guide is followed) would silently lose all of it. "Your mail provider's MX records" alone can be read as Mailgun's by someone who thinks of Mailgun as their email provider. |
| **O11** | **SPF in own-mailbox mode**: the `spf` row (key `spf`, still a Live and go-live gate: the root's SPF is the sending SPF) is include-aware: Mailgun's include counts when it is anywhere in the include tree (`SpfLookupReport.names`); 9–10 lookups = "ok" with the "almost full" sentence; more than 10, an included name without a record, two records, no record, no Mailgun include or `+all` = "bad"; an unfinished count ≤ 10 = "unknown". Never a record box, never a merged or full value. No `from-spf` row in this mode. | Today's row reads only top-level includes, so GoDaddy's `_spfm` wrapping turns it red and its fix ("Change it to: v=spf1 include:mailgun.org include:dc-… include:dc-… ~all") needs 14 lookups and would break SPF for Zoho mail too (code map finding 1). |
| **O12** | **Rows that don't exist in own-mailbox mode**: `mx`, `spam-filter`, `retention`, `reply-routes`, `from-spf`. Changed: `dmarc` (on the root; the missing-record fix adds the everyday-email sentence; the rua fix never names an address), `https-links` (not in plan → "info", O20), `webhooks` and `remote-access` (no public address → "info", O21), `monthly-limit` (Free plan → "info"), `postmaster` (the shared-From rule: a Google record on the everyday domain never proves Postmaster), `reply-test` (by-hand texts), `dkim` (per-person wording for the root: "Your emails carry polygonparadise.com's digital signature (1024-bit; it works, 2048-bit is stronger)."), `mailgun-domain` (the not-active fix never sends the Owner to "the DNS records" on Mailgun's page, which list Mailgun's MX records: §3.3). | Nothing inbound reaches Mailgun, so its inbound rows mean nothing; the rest follow the Free plan honestly. |
| **O13** | **The reply test, by hand** (Setup A only; Setup B isn't offered): it can start only once the `dmarc` row exists and isn't "bad" (`dmarcFirst`, so the test emails don't report `dmarc=none` and waste sends); the test emails (From the Owner's display name + own From, no Reply-To) must be delivered (the app sees it through Logs or webhooks); per mailbox the Owner answers placement, "Did your reply arrive in contact@…? Look in its Spam folder too." and DMARC; one pasted original of a counted test email (From, Return-Path on the sending domain, DMARC, signer, List-Unsubscribe, and the full `mailto:` address, stored as `mailtoAddress`); the List-Unsubscribe question; **when the original shows a `mailto:`, the unsubscribe-by-email question**: "From one of your test mailboxes, send an email to {mailtoAddress} (any subject and text). Within the hour, did it arrive in {from} or another mailbox you read? Look in Spam too." (`mailtoArrived`; No **fails** the test with the catch-all → aliases → leave-out fix; since review REPLIES-01 Settings › Deliverability is never proof for an address on {d}, and since SECURITY-03 a `mailto:` whose address can't be read fails instead of counting as "not offered"); one unsubscribe click that reached the app. The last resort (review REPLIES-03, §13): **Leave out unsubscribe by email** (`leaveOutMailto`), after which the question isn't asked and a new original must show a link and no `mailto:`. The decision stores `from` = own From and `replies: "own-mailbox"`; `replyTestPassedFor(…, { ownMailbox: true })` counts it only in own-mailbox mode. | The app can't see replies any more; everything else it checked in Shape B it still checks, and the owner's own answer covers the reply path. On Free the unsubscribe link is http, so mail programs' own Unsubscribe buttons are likely to use the `mailto:`; an address Zoho rejects would silently lose those requests (a legal risk, and follow-ups to someone who asked to stop). Where the `mailto:` really goes (Zoho, a catch-all, or Mailgun through `email.` CNAME) is unknown until tried, so the test tries it. |
| **O14** | **Go-live in own-mailbox mode** needs: a checklist checked after the last change; the own-mailbox go-live rows "ok" (§3.4; webhooks and remote-access only when a public address is set; never `https-links`); Setup A; the by-hand reply test passed; not paused; a delivered live test with today's own From; the background sender running; and in the dialog two server-checked ticks: **the replies tick** (always; it names the inbox check and the Spam folder) and **the http-links tick** (while `https-links` isn't "ok"), plus the spam-placement tick when the reply test recorded spam (F12). The go-live card also recommends checking that the Mailgun account isn't limited to authorized recipients (`authorizedCheck`, not a gate). | The last moment to see, in plain words, what this mode costs before real prospects get email. The authorized-recipients limit can't be seen by a live test to the test list, but its only effect is a clean pause with the fix, so it is a recommendation, not a fourth tick. |
| **O15** | **Evidence belongs to one way of sending** (F26 extended): `TestSend.teamFrom` stores `evidenceFrom`; the reply test counts only emails with today's evidence From sent at or after `changedAt`; the live test counts only LIVE campaigns with `replyTo: null`, `fromAddress` = own From, launched at or after `changedAt`; `goLive()` writes `sending.goLiveFrom = evidenceFrom`; the dashboard's "go live again" item compares evidence Froms. | A per-person or shared-From test must never let own-mailbox mode go live, and the reverse. |
| **O16** | **Retry in own-mailbox mode** (`retrySnapshotProblem`): a TEST/LIVE snapshot fits only with no Reply-To and `fromAddress` = today's own From; anything else is refused with `RETRY_FROM_TEXTS.nowOwnMailbox` (or `team.problem`). An own-mailbox snapshot retried later in app mode is left to app mode's rules (a LIVE email then waits on the reply-route hold for ever: accepted, §10.1). | Same reasoning as SEND-1. |
| **O17** | **They replied**: a new one door `markRepliedByHand(actor, { companyId, personId?, at? })` and a **They replied** button (company panel header, campaign person panel; icon `MailCheck`), for everyone, shown in own-mailbox mode (with or without a fitting From), in shared-From mode and in the practice copy. One transaction: every open recipient of the company in every campaign stopped through `stopCompany` with the reply codes ("Stopped: they replied" for the person named, "Stopped: someone at the company replied" for everyone else; `inboundId` becomes optional and is null here) **even when the company is already Replied**; **the status (Not contacted/Contacted → Replied) and `repliedAt` (company and person, forward only) change only when the click counts as a real reply** — the company has a recipient in a campaign that counts as emailed (`countsAsEmailed`: LIVE launched after go-live, or the practice copy's dry runs), or nothing was open and the app has been live (`hasBeenLive`), the rule `process.ts:663-671` uses for real replies; activity `company.markedReplied`; then `finishCheck`. The status picker is unchanged. | Today the only by-hand path is the status picker, which never writes `repliedAt` (reply rate 0, the "put back by hand" rule blind) and does nothing for a company already Replied (`mutations.ts:148`), so a second reply wouldn't stop a later campaign. Real replies never change a test mailbox's status before go-live (`countsAsEmailed`); a rehearsal click must not either, or the next live test leaves the test companies out ("Company status is Replied", `eligibility.ts:252-253`) and the reply rate counts them. The practice copy teaches the habit the real setup needs. |
| **O18** | **Removal requests and bounce notices**: the person's existing **⋯ › Mark unsubscribed** (everyone; "Nobody will be able to email this address again") or the company's **Do not contact**; the Owner may also use Settings › Deliverability › Add an address. No new mechanism. | It already exists, works for Members and stops every campaign. |
| **O19** | **Reminders where follow-ups are decided**, on top of the inbox check (O33) that actually holds them: the campaign page line and the wizard Sender step line (`OWN_MAILBOX_TEXTS.followUpReminder`, naming the Spam folder), the From card's "Good to know", the dashboard's `inbox-check` item (warning tone) and the Notifications page's Inbox check card listing the companies, one bell notification a day in the Replies pop-up group while follow-ups wait, the own-mailbox empty states of the replies tile and Notifications › Replies, and the go-live replies tick. Simulate reply (dry runs) is refused in this mode (it shows a flow that never happens) and its links are hidden. | The one reminder shared-From mode showed only with a Reply-To (`campaigns/[id]/page.tsx:136`) would disappear here, and an empty "No replies are waiting" would read as "nobody replied". |
| **O20** | **https unsubscribe links**: Apply keeps asking Mailgun for the certificate; a 402 (`not-in-plan`) makes the own-mailbox `https-links` row "info" with the honest sentence (§3.3). The links then use http: they work when clicked, but RFC 8058 one-click needs https, so Gmail's and Yahoo's unsubscribe button may not show; only senders of more than 5,000 emails a day to Gmail must offer it. Going live needs the http-links tick; the go-live card recommends Foundation. | Honest and not blocking: the owner sends at most 100 a day, far under the bulk-sender line, and the app can't buy the certificate. |
| **O21** | **Webhooks optional in own-mailbox mode**: without `APP_PUBLIC_URL` the `webhooks` and `remote-access` rows are "info", Live mode doesn't need a public address, neither does the reply test, and go-live doesn't need those two rows; Mailgun's events arrive through the hourly Logs catch-up (and **Check with Mailgun now**). With a public address set, both rows and their gates are as today. Without one, Apply's public-address step is ok: null with "No public address yet: Mailgun's reports come through the app's hourly check instead. …" (`OWN_MAILBOX_TEXTS.applyNoPublicAddress`). | Nothing inbound needs the public address in this mode; Mailgun's suppression lists stop sends to unsubscribed, complained and bounced addresses even before the app hears. Cloudflare becomes optional (teammates reaching the app from outside still need it). |
| **O22** | **Mailgun plan setting** `mailgun.plan: "free" \| "basic" \| "foundation" \| "scale" \| null` (Owner, Advanced, saved with the retention numbers). `planLimits(plan, replies)`: a chosen plan's facts; none chosen → the Free plan's facts in own-mailbox mode (`assumed: true`), nothing in app mode (today's behaviour). **The first own-mailbox connect with no plan saved writes plan "free" and the retention numbers 1/1** in the connect transaction, with the retention activity (`saveConnection`; the only other writer is `saveRetentionAction`). | The app can't read the plan without probing; the safe default follows the owner's decision. Writing it at connect means the Advanced numbers never contradict the limits in force ("5 days of logs" next to "1 day"), and the owner has nothing to save. |
| **O23** | **The daily limit**: the campaign cap never exceeds the plan's limit minus 10 (`effectiveMaxDailyCap`, read through the one loader `loadEffectiveMaxDailyCap()`: 90 on Free), which also feeds the warm-up table, every warm-up line and the cap-override check; a **rolling guard** counts every email handed to Mailgun in the last 24 hours (TEST and LIVE campaign emails, "Send me a test", reply-test emails; SENDING/UNKNOWN/UNCONFIRMED from their claim), **or the distinct `accepted` events Mailgun reported for the last 24 hours when those are more** (other senders on the account, test sends lost to a restore): TEST/LIVE campaign emails wait with `plan-limit` at limit − 10; test sends and the reply test refuse at the limit. | Mailgun's day boundary is unknown: no 24-hour window can ever hold more than the limit. Test-mode emails are counted because Mailgun charged for them (2026-09-22) and may count them. The limit is per account, so what the app didn't send itself counts too. |
| **O24** | **A refusal that says a sending limit is reached** — a 400 or 403 **to `POST /v3/{d}/messages` only**, whose text matches the narrowed limit rule and not the size rule (§2.8), checked after business verification and before "not allowed" — is a new `MailgunErrorKind` `"limit"`: sending pauses (kind `mailgun-not-allowed`) with the plan sentence and the email goes back to the queue, never FAILED for good. 429 stays "rate-limited". Every other endpoint (address checks, Logs, routes, Apply, connect) keeps exactly today's kinds. A send refusal whose text the rule doesn't know stays "rejected"; the existing rejection breaker pauses after 3 of them (§2.8). | Today such a 400 is "rejected" and fails each email for good (`loop.ts:609-617`), losing follow-up steps. `classifyStatus` is shared by every Mailgun call (`client.ts:470`): a rule there would turn an address-check 402 "quota" into "transient" retries, a Logs 403 into no auth pause, and "size limit exceeded" into a wrong plan pause. |
| **O25** | **Authorized recipients only**: a "not allowed to send" refusal whose text mentions authorized recipients or "Free accounts are for test purposes" gets its own pause sentence (every mode): for **campaign emails** only "add a payment card in Mailgun, then click Resume" (`authorizedOnlyCampaign`); for **test sends and the reply test** also "or add this test mailbox under Authorized recipients" (`authorizedOnlyTest`). Never probed. | Research quotes the text (reported as 403); the existing `not-allowed` pause already stops everything; only the sentence was vague. Authorizing a prospect's address would make Mailgun email that prospect an invitation, outside the app's do-not-email, unsubscribe and test-list rules. |
| **O26** | **Log retention**: `effectiveLogRetentionDays(saved, limits)` = the smaller of the saved number and the plan's (1 day on Free; own-mailbox with no plan: 1). Used by the catch-up's window, the restore scan, the reconciler and every "more than N days" sentence. | With 5 kept on a 1-day plan, a PC off 2–5 days misses events without recording a gap and the restore scan may resend (code map §2.H). The smaller number only ever errs on the safe side. |
| **O27** | **No outage hold in own-mailbox mode**: `applyOutageHold` marks a found gap handled without holding anyone; the gap stays recorded for "Details". The inbox check (O33) takes its place: after a weekend with the PC off, Monday's LIVE follow-ups wait until someone has read contact@ that day, and complaints and bounces of the gap still count through the lists (O34). | The hold exists because replies may have been missed while the PC was off; here replies never pass through Mailgun, so a gap in Mailgun's logs says nothing about them, while the daily inbox check covers every day, gap or not. With 1-day logs the hold would otherwise fire after every weekend on top of the inbox check. |
| **O28** | **Practice copy unaffected**: connect already refuses there, so the mode is never set; `repliesOf` of the practice database is "app". | SPEC: the practice copy never talks to Mailgun. |
| **O29** | **Docs**: a new **Own-mailbox guide** (`docs/setup/2-own-mailbox.md`, 16 steps with a nine-line quick path at the top, the owner's real names); README "Start here" names it; guides 2, 3, 4 get short own-mailbox notes; SPEC/PLAN a dated note. | The owner follows guides literally; guide 2 describes Shape B and must not be followed in this setup, so everything this setup needs from it (the Test mailboxes list, the Pakistan sending-hours tip, putting the unsubscribed test mailbox back) is copied in. |
| **O30** | **Deliberate app-mode changes** (§0.2 rule 4): the connection card's two new controls, the one-click switch and the new retention hint (`PLAN_TEXTS.retentionHint`, all modes); `SENDING_DOMAIN_TEXTS.website` = "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4)."; the "limit" error kind on sends and the free-account sentences; They replied in shared-From mode and the practice copy; a chosen plan's caps and retention; the website-domain checklist guard (O37); start.bat's port message. | Each is either the way into the new mode or a safety fix that is right in every mode. |
| **O31** | **No Prisma migration.** Everything fits JSON settings (`mailgun.replies`, `mailgun.plan`, optional fields of `mailgun.unsubscribeTest`), SystemState JSON rows (the new key `sending.inboxCheck`; optional fields `replies` and `lastGoodMx` of `domain.check`) and existing columns (`TestSend.teamFrom`, `Campaign.replyTo` = null, `Company/Person.repliedAt`, `OutboundEmail.lastError`, `CampaignRecipient.stoppedByInboundId` = null). | Nothing to backfill; the real database is empty. |
| **O32** | **Test list and "Send me a test"**: `validateTestList` is unchanged (every address on or under the sending domain is refused, so contact@ can never be a test mailbox); "Send me a test" goes to the viewer's test inbox, which in own-mailbox mode may be contact@ (then the self-test note: look in spam). | Mail from contact@ to contact@ through another server may be hidden or filtered (UNVERIFIED, research §4.1). |
| **O33** | **The inbox check** (own-mailbox mode, every LIVE follow-up): SystemState `sending.inboxCheck` = `{ at, byUserId }`, written only by `markInboxChecked(actor)` ("I've read contact@polygonparadise.com", open to everyone, logged `sending.inboxChecked`). A LIVE candidate with step ≥ 1 goes only when `at` is inside today's cap day **and** later than that recipient's last SENT email; otherwise it waits with the new `WaitReason` `"inbox-check"` (`inboxCheckHeldIds`, part of `pendingProblemIds`, so the tick, the loop's final check, Retry and the campaign page's waiting line all see it). While follow-ups wait for it the Owner gets one bell notification a day (`reply.inboxCheck`, Replies pop-up group); the dashboard item and the Notifications page card list the companies. TEST (Mailgun's test mode: never delivered) and DRY_RUN never wait; first emails to companies nobody emailed before today never wait (since review SEND-1 a LIVE first email waits too while nobody has read contact@ today, when its company already got a live email before today's cap-day start). A stored check more than a minute ahead of the clock never counts, and the next click replaces it (SECURITY-02); held rows never crowd the candidate query (`pickRealRows`, SEND-3). No setting turns it off. | Every other automatic reply stop is gone in this mode (route hold, `pending-events`, `possible-reply`, outage hold); reminders alone help only when someone opens the right page, and resuming a paused campaign would send its overdue follow-ups at once. One click a working day is cheap; a follow-up to someone who answered costs a complaint against the everyday domain. "Later than the last email" makes the check cover the whole time since that person was emailed, even with same-day delays. |
| **O34** | **List-pulled complaints and bounces count** (own-mailbox mode): `pullSuppressions` links a new `complaints` or `bounces` entry (unless the health counts already see a complaint or hard bounce for that address, review REPLIES-10; before it: "an address with no local do-not-email entry yet") to the newest LIVE email SENT to that address in the 7 days before the entry's `created_at` by giving the event that email's Message-ID, and a linked bounce the reason `"list-bounce"` (never `suppress-*`); the health counts then see it; after a pull that linked any, the health check runs once. | With 1-day logs a weekend with the PC off loses Saturday's `complained`/`failed` events; the lists still stop those people, but `loadHealthCounts` only counts events linked to an email and skips `suppress-*` reasons (`usage.ts:201-221`, `suppressions.ts:46-70`), so the auto-pause that protects the everyday domain would never see them. |
| **O35** | **Leftover rows of an interrupted launch** get a new Message-ID when their id's domain isn't the snapshot's and the launch is own-mailbox or has a Reply-To (`launch.ts:832`, extended; per-person mode unchanged). In own-mailbox mode an email the transport blocks for its sender headers a second time (the claim-time `lastError` is `OWN_MAILBOX_TEXTS.senderBlocked`) is failed for good ("Didn't send", `senderBlockedTwice`) instead of pausing again. | A leftover `@dry-run.invalid` or old-domain id fails the own-mailbox transport check (§2.4), which pauses everything and puts the row back uncounted (`loop.ts:659-663`); on Resume the same row goes first and pauses again, for ever. |
| **O36** | **Stored checklist rows belong to one mode**: `DomainCheckState.replies` records the mode of the check; every reader that already ignores another domain's rows also ignores rows of the other mode (`checkMatchesMode`, step C). | After a same-domain mode switch, the old mode's rows (a from-mx "ok" of another domain, no own-mailbox rows) would pass Live mode and LIVE-launch checks until the next check. |
| **O37** | **The website domain never gets DNS advice for receiving**, in any mode: when the checklist's sending domain is in `WEBSITE_DOMAINS` and the facts aren't own-mailbox (a corrupted `mailgun.replies`, a seed, a manual edit), the `mx` row is "bad" with "Connect again with How the app sends = From polygonparadise.com itself" and no record box, the `spf` row uses the own-mailbox SPF logic (no box, no value), and no MX record box is emitted. | `validateSendingDomain` runs only at connect; the 6-hourly check would otherwise show `MX @ → mxa/mxb.mailgun.org` boxes and a merged SPF value that guide 2 tells the owner to copy. |
| **O38** | **The reply test waits for DMARC** (own-mailbox mode): `replyTestBlockers` also needs the `dmarc` row present and not "bad" (`MODE_GATE_TEXTS.dmarcFirst`). | Test emails sent before `_dmarc` exists report `dmarc=none`, fail the test and use up sends from the 100 a day. |

### 2.2 The mode, the sending domain and the From address (contracts §7.4–§7.5)

**Setting `mailgun.replies`** (`"app"` default). `repliesOf(v)` → `"own-mailbox"` only for exactly that string, else
`"app"`. Written only in `saveConnection` (P2), together with `mailgun.domain` and `mailgun.region`, in the same
transaction.

**`validateSendingDomain(input, opts?: { replies?: RepliesMode })`** (`core/sender-address.ts`), rules in order. App
mode uses today's sentences; own-mailbox mode uses the `…Own` sentences, whose example is polygonparadise.com:

1. Trim, lowercase, drop `https://`, trailing `/` and dots (as today). Empty → `SENDING_DOMAIN_TEXTS.empty` / `.emptyOwn`
   ("Enter the domain you send from, exactly as Mailgun shows it, for example polygonparadise.com.").
2. Not a host name → `SENDING_DOMAIN_TEXTS.invalid` / `.invalidOwn` ("That isn't a domain name. Enter it the way Mailgun
   shows it, for example polygonparadise.com.").
3. App mode (absent or `"app"`): a website domain → `SENDING_DOMAIN_TEXTS.website` (new sentence, O30).
   Own-mailbox mode: a name starting with `www.` → `SENDING_DOMAIN_TEXTS.www` ("Type your domain without www., for
   example polygonparadise.com."); a website domain without `www.` is **allowed**.
4. Mailgun's sandbox (`mailgun.org`, `*.mailgun.org`) → `SENDING_DOMAIN_TEXTS.sandbox` / `.sandboxOwn` ("That's
   Mailgun's sandbox domain, for tests only. Type polygonparadise.com, the domain Mailgun lists under Send › Domains next
   to it.").
5. A shared or free-mail domain → `SENDING_DOMAIN_TEXTS.shared` / `.sharedOwn` ("That domain belongs to an email
   provider. Type your own domain, for example polygonparadise.com.").
6. Otherwise `{ ok: true, domain }`.

The connection form (P2) checks as you type with the chosen mode. When "Through a sending subdomain" is chosen and the
typed domain is a `WEBSITE_DOMAINS` name without `www.`, the `.website` sentence shows under the field with an outline
button **Use From polygonparadise.com itself** (`OWN_MAILBOX_TEXTS.websiteSwitch`) that selects the own-mailbox option
and keeps the typed domain; nothing switches without that click.

**`validateFromAddressFor(input, sendingDomain, replies)`** (`core/sending/own-mailbox.ts`, the one dispatch every
writer and reader uses; `validateTeamFromAddress` itself is unchanged, so `from-address.ts` never imports the new file):
`"app"` → `validateTeamFromAddress(input, sendingDomain)`; `"own-mailbox"` → `validateOwnMailboxFrom(input,
sendingDomain)`, rules in order (`input` trimmed, a leading `mailto:` removed):

1. Empty → `{ ok: true, address: null }` (saving it is allowed; `loadTeamFrom` then reports `fromMissing`, O3).
2. No sending domain → `TEAM_FROM_TEXTS.notConnected`.
3. Not exactly one bare address → `TEAM_FROM_TEXTS.invalid("contact@<d>")`.
4. Its domain isn't exactly the sending domain (a subdomain of it, another domain, a free-mail domain) →
   `OWN_MAILBOX_TEXTS.fromWrongDomain(d)`: "The From address must end in @polygonparadise.com, your sending domain."
5. Local part in `TEAM_FROM_REFUSED_LOCAL_PARTS` or starting with `pp-route-check` →
   `TEAM_FROM_TEXTS.reserved(local, "contact@<d>")`.
6. Otherwise `{ ok: true, address }` (lowercase). `contact`, `info`, `hello`, `sales` are allowed.

**`loadTeamFrom()`** (`services/mailgun/team-from.ts`) reads `mailgun.fromAddress`, `mailgun.domain` and
`mailgun.replies` in one query:

| Mode | Saved | `address` | `ownFrom` | `evidenceFrom` | `problem` |
|---|---|---|---|---|---|
| app | nothing | null | null | null | null |
| app | fits (shared) | the address | null | the address | null |
| app | doesn't fit | null | null | null | `TEAM_FROM_TEXTS.misfit` / `notConnected` (today) |
| own-mailbox | nothing | null | null | null | `OWN_MAILBOX_TEXTS.fromMissing(d)` ("Type the address your emails come from in Settings › Sending & Mailgun › From address, for example contact@polygonparadise.com. Test and live campaigns can't start without it.") |
| own-mailbox | fits | **null** | the address | the address | null |
| own-mailbox | doesn't fit | null | null | null | `OWN_MAILBOX_TEXTS.misfit(saved, d)` ("The From address {saved} isn't on your sending domain {d}. Change it in Settings › Sending & Mailgun.") |
| any | no domain | null | null | null | `TEAM_FROM_TEXTS.notConnected` when something is saved (today) |

`saved`, `domain` and `changedAt` keep their meaning; `replies` is `repliesOf(row)`.

### 2.3 Headers, snapshot, launch, retry

- **`ownMailboxHeaders({ displayName, from })`** → `{ from: formatFromHeader(displayName, from), replyTo: null }`.
- **Snapshot** (`senderSnapshot(user, mode, senderAddress?, opts: { teamFrom?, ownMailbox? })`, P1): with
  `opts.ownMailbox = { from, domainId, domainName }` the sender address is ignored; `fromName` = display name,
  `fromAddress` = own From, `fromHeader` = `ownMailboxHeaders(…).from`, `replyTo: null`, `sendingDomainId = domainId`
  (all modes), `messageIdDomain` = `domainName` (TEST/LIVE) or `dry-run.invalid` (DRY_RUN). `teamFrom` and `ownMailbox`
  together throw (a programming error). Own-mailbox DRY_RUN without a fitting From: today's placeholder path (no sender
  address), so dry runs never need a From.
- **Launch** (`launch.ts`, P1): `team = loadTeamFrom()` read once (as today). In own-mailbox mode
  `launchModeProblems`: practice copy; Mailgun not connected; `team.problem` → `"from-invalid"`; TEST → today's
  `testModeBlockers`; LIVE → `liveLaunchBlockers(rows, { …, ownMailbox: true, publicAddress: pub !== null,
  replyTestPassedOnDomain: replyTestPassedFor(setting, ctx.domain, team.ownFrom, { ownMailbox: true }) })`; **no**
  `no-sender-address` and **no** `no-reply-route`. The senders' `senderAddresses` aren't read for the snapshot;
  `evaluateCompanies` gets `senderHasReplyRoute: undefined`; the snapshot uses `{ ownMailbox: { from: team.ownFrom,
  domainId: ctx.domainId, domainName: ctx.domain } }` for TEST/LIVE. **F29 extended**: `LaunchSettings` gains `replies?:
  RepliesMode`; `assertLaunchSettingsUnchanged` also re-reads `mailgun.replies` (absent in `expect` = not compared; the
  launch always passes it); in own-mailbox mode `expect.sendingDomain` is the context's domain row (id, name, region),
  which must still be active with the same name and region.
- **Leftover rows of an interrupted launch** (O35, `launch.ts:832`): `const newId = (ctx.replyTo !== null ||
  ctx.ownMailbox) && messageIdDomainOf(existing.messageId) !== ctx.messageIdDomain;` where `ctx.ownMailbox` is true for
  an own-mailbox snapshot (any mode: an own-mailbox DRY_RUN relaunch also renews an id made for the root). Per-person
  mode (`replyTo` null, not own-mailbox) keeps today's rule exactly.
- **Sender choices** (`listSenderChoices`, P1): own-mailbox → every active user, `fromLine` = their display name with the
  own From (or today's placeholder while none fits), `address: null`, `routeOk: null`, `placeholderAddress` = no fitting
  own From, new `ownFrom: string | null`.
- **Follow-ups, restore rows, reconciler, loop**: unchanged (they copy `replyTo` = null and the From line; the Mailgun
  domain is `mailgunDomainOf(from, null)` = the root).
- **Retry** (`retrySnapshotProblem(campaign, team)`, P1): new first branch for `team.replies === "own-mailbox"`: dry
  runs never refused; TEST/LIVE fits only when `replyTo` is null and `fromAddress` (lowercase) = `team.ownFrom`;
  otherwise `team.problem ?? RETRY_FROM_TEXTS.nowOwnMailbox` (a constant): "This campaign was launched with another From
  address or before replies went to your own mailbox. Start a new campaign to email this person again." App mode
  unchanged.

### 2.4 Fail-closed checks (O6)

| Layer | Check | What happens |
|---|---|---|
| Connect (P2) | own-mailbox with a saved From that isn't on the new domain | refused before the Mailgun test and again inside the transaction: `OWN_MAILBOX_TEXTS.domainMisfit(from, d)` ("Your From address {from} isn't on {d}. Clear it in the From address card first, then connect again.") |
| Launch (P1) | `team.problem` (own From missing or misfit) | TEST/LIVE refused, code `"from-invalid"` |
| Launch, last transaction (P1) | `mailgun.replies`, `mailgun.domain`, `mailgun.fromAddress`, `sending.goLive`, `mailgun.region` or the domain row changed | refused, `"changed"`, `LAUNCH_SETTINGS_CHANGED_TEXT` |
| Gates (P1) | the `from-mx` row "bad" (own-mailbox: whether or not a From is saved; rows of the other mode ignored, O36) | every LIVE email waits `main-domain-mx` |
| Gates (P1) | the rolling guard is used up | every TEST/LIVE email waits `plan-limit` |
| Gates and the loop's final check (P1) | own-mailbox, a LIVE follow-up, and no inbox check today after that person's last email (O33) | waits `inbox-check`; the Owner is told once a day |
| Transport (P1) | `senderHeaderProblem(domain, from, replyTo, { ownMailboxFrom: context.ownMailboxFrom })`; in own-mailbox mode also `messageIdDomainOf(messageId) === domain` | `TransportError` blocked + `SENDER_HEADERS_PAUSE`; the row is released with `lastError` = `OWN_MAILBOX_TEXTS.senderBlocked`, never failed the first time; a second block of the same row fails it for good (O35) |
| Client (P1) | the same check with the client's `ownMailboxFrom` option, next to `checkSendGuard` | `MailgunError` kind `"sender"`, `requestStarted: false` |
| Test sends and the reply test (P4) | `team.problem`; the rolling guard at the plan's limit | refused with the sentence |
| Retry (P1) | §2.3 | refused before anything is written |
| `setSenderLocalPart` (P5) | own-mailbox mode | refused: `OWN_MAILBOX_TEXTS.noSendingAddress(from)` ("Nobody needs an address of their own: every email comes from {from} with each person's display name.") |
| `syncRoutes` (P2) | own-mailbox mode | returns ok at once; no Mailgun call beyond the context |
| Simulate reply (P1) | own-mailbox mode | refused: `OWN_MAILBOX_TEXTS.simulateReply(from)` ("In your setup replies go to {from}, not through the app. Use They replied on the company instead.") |

`senderHeaderProblem` with `ownMailboxFrom` set accepts only: From address (lowercase) exactly `ownMailboxFrom`, on the
sending domain, and an empty Reply-To (`""` refuses everything). Without the option (null or absent): today's rules.
`MailgunContext.ownMailboxFrom` is `ownMailboxRuleFrom(team.replies, team.ownFrom)`: null in app mode, so app mode keeps
today's check.

### 2.5 polygonparadise.com's MX is never Mailgun's (safety in this mode)

1. The app never asks for a Mailgun MX record in own-mailbox mode: there is no `mx` row, the `from-mx` row has no record
   box and its fixes only say "delete … that point to Mailgun" (or switch Cloudflare Email Routing off) and "put back your
   mail provider's MX records: {the last good MX}", always followed by `NEVER_MAILGUN_MX_TEXT(d)`; the `mailgun-domain`
   row's not-active fix says Mailgun's MX records must never be added; the `spf` row has no record box and never states a
   full SPF value; Apply has no MX, route or DNS step; the own-mailbox guide says the only DNS record to add is `_dmarc`.
2. `from-mx` red (a Mailgun MX in either region, a null MX, no MX, Cloudflare Email Routing) blocks Live mode, the reply
   test, a LIVE launch and go-live, holds every LIVE email (`main-domain-mx`, `isMainDomainMxOk(rows, guard)` with `guard` =
   the sending domain in own-mailbox mode) and notifies the Owner once per 24 hours (`from-mx-bad`, body
   `FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn`).
3. No route can make the root a receiving domain: `syncRoutes` short-circuits (O8); the Free plan's one route stays unused.
4. **P3 safety unit test**, over every checklist row built in own-mailbox mode (every case of §3.3, DNS answers of every
   kind, with and without a last good MX) **and** in app mode with the sending domain `polygonparadise.com` (O37): no
   record box of type MX; no record box of type TXT at that domain whose value starts `v=spf1`; no fix text containing
   `v=spf1`; every fix text, with the exact `NEVER_MAILGUN_MX_TEXT(d)` sentence removed, contains no `mailgun.org` host
   (`mxa.mailgun.org`, `mxb.mailgun.org`, `mxa.eu.mailgun.org`, `mxb.eu.mailgun.org`); and every red `from-mx` fix and the
   not-active `mailgun-domain` fix contain `NEVER_MAILGUN_MX_TEXT(d)` (the latter `OWN_MAILBOX_TEXTS.mailgunDomainFix(d)`).
5. **P8 end-to-end test**: no request the fake received creates or changes a route (`POST/PUT /v3/routes`) or touches
   DNS; no row of the stored checklist state has an MX record box.
6. The From card, the guide and the README say, in plain words: "Never add Mailgun's MX records to polygonparadise.com
   and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving."
7. **Fail closed for a stored website domain in app mode** (O37): `buildChecklistRows` with a `WEBSITE_DOMAINS` sending
   domain and `facts.ownMailbox !== true` builds the `mx` row as "bad" (`OWN_MAILBOX_TEXTS.websiteInAppMode(d)`: "{d} is
   your own domain, and its mail must stay with your mail provider." fix `OWN_MAILBOX_TEXTS.websiteInAppModeFix`: "Open
   Settings › Sending & Mailgun and connect again with How the app sends = From polygonparadise.com itself.") with no
   record box, the `spf` row through `ownSpfRow`, and drops every MX record box of every other row.

### 2.6 Where every kind of message lands

§1.2 is the table. Additions: "Send me a test" from contact@ to a test inbox on polygonparadise.com goes Mailgun → Zoho
with SPF and DKIM passing; whether Zoho shows, files or filters it is UNVERIFIED (the self-test note says to look in
spam). DMARC aggregate reports: the guide says leave `rua` out (they would arrive in contact@ as attachments).

### 2.7 Switching modes and changing the From address

| Change | While a TEST/LIVE campaign is scheduled, running or paused | Otherwise |
|---|---|---|
| App → own-mailbox, or back (`connectMailgun` with another `replies`, usually another domain too) | refused: `domainChangeBlockedText(names, oldDomain)` | a domain change (O2): go-live ends, reply test reset (Setup A), evidence restarts, Apply run cleared, suppressions re-pushed, the domain sending key dropped unless a new one is given, a domain check queued (its rows carry the new mode, O36); own-mailbox: no address moves, no route sync, and with no plan saved yet the plan becomes Free with 1/1 days (O22); app: today's address move and route sync. The saved From stays when it fits the new mode and domain (contact@polygonparadise.com fits both own-mailbox on the root and shared-From on mail.polygonparadise.com), else the connect is refused (§2.4 first row, or F14 in app mode) |
| Own From changed or cleared (`saveFromAddress`, P2) | refused (F13, today's sentence) | F13 as today (go-live ends with the confirm dialog, reply test reset, domain check queued); own-mailbox validation and toasts (§3.2) |
| Plan chosen or changed (`saveRetentionAction`, P2) | allowed | saved with the retention numbers; takes effect at once (caps, guard, retention); no go-live change |
| Retry after any of the above | — | §2.3 |

**The way back to the full setup** (own-mailbox guide step 15; README): upgrade Mailgun to Foundation; add
mail.polygonparadise.com in the US region (guide 2 steps 3–4); **Pause all sending**; cancel every scheduled, running or
paused test or live campaign (or Resume and let them finish); Settings › Sending & Mailgun: How the app sends **Through
a sending subdomain**, Sending domain **mail.polygonparadise.com**, **Save and connect** (going live ends; the From address
contact@polygonparadise.com stays and now works as the shared From); Your Mailgun plan **Foundation**; everyone's reply
address in My profile; guide 2 from step 7 (DNS for `mail`, Apply, the reply test with the pasted original); a live test;
go live again.

### 2.8 Free-plan realities

**Plan facts** (`MAILGUN_PLAN_FACTS`, contract §7.4; the pricing page, 2026-09-28):

| Plan | Daily limit | Logs kept | Stored messages | Label |
|---|---|---|---|---|
| free | 100 | 1 day | 1 day | Free (100 emails a day) |
| basic | none | 1 day | 1 day | Basic |
| foundation | none | 5 days | 1 day | Foundation |
| scale | none | 30 days | 7 days | Scale or higher |

`planLimits(plan, replies)`: `plan` set → its facts; `null` and own-mailbox → Free's facts with `assumed: true`; `null`
and app → `null` (today's behaviour everywhere).

**Daily limit** (O23). `PLAN_TEST_RESERVE = 10`. `effectiveMaxDailyCap(maxDailyCap, limits)` = `min(maxDailyCap,
dailyLimit − 10)` when the plan has a daily limit, else `maxDailyCap`. Step C adds the one loader
`loadEffectiveMaxDailyCap(reader?)` (`services/mailgun/plan.ts`: Setting `sending.maxDailyCap` and `loadPlanLimits()`,
one call). Every place that builds the warm-up table, today's cap or the cap-override check uses it instead of
`sending.maxDailyCap`: `getTodayCap` (`usage.ts:104-110`), `evaluateWarmupDays` (`warmup-days.ts:133`), `goLive()`'s start
cap (`go-live.ts:276-277`), the Limits page's table (`limits/page.tsx:119`), the cap-override action
(`limits/actions.ts:149-150`), the Sending page (`sending/load.ts:396-397`), the dashboard's warm-up line
(`dashboard/load.ts:80`). Only the Limits form's field value and its save (`limits/page.tsx:257`, `limits/actions.ts:76-95`)
read the saved number itself. On Free the warm-up then ramps from 50 to 90 over the steps (warmupTable's own curve) and
every line says so. The Limits page adds `PLAN_TEXTS.capLine(90, 100)`: "Your Mailgun plan sends at most 100 emails a
day, so the app plans at most 90 campaign emails a day and keeps 10 for test emails." and, under the maximum daily limit
field while the plan lowers it, `PLAN_TEXTS.maxFieldHint(90)`: "Your Mailgun plan keeps this at 90 at most."

**Rolling guard** (O23). `countMailgunSendsSince(since)` (step C, `usage.ts`): the larger of (a) OutboundEmail rows with
mode TEST or LIVE that are SENT with `sentAt ≥ since`, or SENDING/UNKNOWN/UNCONFIRMED with `claimedAt ≥ since`, plus
TestSend rows with status ≠ FAILED and `sentAt ≥ since`, and (b) the number of distinct non-empty `messageId`s of
MailEvent rows with `type = "accepted"` and `occurredAt ≥ since` (every domain: the limit is the account's); returns
`{ total, oldestAt }` (the oldest counted time of whichever count won, for when room opens again). `planRoom(limits, used)` (pure) → `{ campaign: max(0, limit − 10 − used), tests: max(0, limit − used) }` or
`null` without a daily limit. `GateContext.planLeft` (campaign room) and `planOpensAt` (`oldestAt + 24 h`); `planTick`
holds every TEST/LIVE candidate with `plan-limit` (until `planOpensAt`) when `planLeft ≤ 0`, right after the Mailgun
back-off check. "Send me a test" refuses when `tests ≤ 0` (`PLAN_TEXTS.testsFull(limit)`: "Your Mailgun plan sends at
most 100 emails in 24 hours, and that many have gone out. Try again later."); the reply test refuses when its emails
don't fit `tests`. Waiting line (`waitingText`, reason `plan-limit`): "Waiting: your Mailgun plan's daily limit is used
up. The next email can go at {time}."

**A refusal that says the limit is reached** (O24). `classifyStatus(status, text, opts?: { send?: boolean })` (step C,
`errors.ts`): the new rule runs **only with `opts.send === true`** (set by `MailgunClient.sendMessage` alone, through its
call spec, step C in `client.ts`), **only for status 400 or 403**, after the 429, 5xx, <400 and business-verification
rules and **before** the not-allowed rule: the text matches
`/\b(daily|sending|messages?|account|plan)\s+(sending\s+)?(limit|quota)\b|\bquota\b|\b(emails|messages)\s+(per|a)\s+day\b/i`
(the last form catches "Free accounts are limited to 100 messages per day", which has no "limit" word) and does **not**
match `/\bsize\b|too large|attachment|recipients?\s+per\s+message/i` → kind `"limit"`. Without `send` (every other endpoint) and for every other status the
function returns exactly today's kinds. `plainMailgunError` `"limit"` → `PLAN_TEXTS.limitRefused`: "Mailgun refused an
email because your plan's sending limit is reached. Sending is paused: click Resume after the limit resets, or upgrade the
plan in Mailgun (Account › Plan) and choose it in Settings › Sending & Mailgun › Advanced." `mailgunFailure` (P1) maps
`"limit"` to `{ kind: "pause", pause: "mailgun-not-allowed", reason: "Mailgun's sending limit for your plan is reached",
fixText: PLAN_TEXTS.limitRefused }`; test sends pause the same way (`PAUSE_FOR.limit`, P4). The exact status and text
Mailgun uses is UNVERIFIED (§11 Q1); the fake answers 400 with "Domain <d> has reached its daily sending limit of 100
messages." so the rule is exercised, and a `fail-next` 429 stays "rate-limited". Cases the unit test pins: that 400 →
"limit"; 403 "sending quota exceeded" → "limit"; 400 "Free accounts are limited to 100 messages per day" → "limit"; 400
"Message size limit exceeded" → "rejected"; 400 "Recipient limit exceeded: 1000 recipients per message" → "rejected"; 400
"limit reached" (no plan words) → "rejected"; the same limit text on a non-send call (a 402 on address checks, a 403 on
Logs) → today's kind ("payment", "auth"); a business-verification 403 that mentions a limit → "business-verification".
A 400 to a send whose text the rule doesn't know stays "rejected" (the email FAILED, the person stopped); the existing
rejection breaker (`loop.ts:99-101,966-986`: 3 refusals of 3 different addresses within 30 minutes) then pauses sending
with Mailgun's own text, so an unknown account-level refusal fails at most 3 emails, which **Retry** can send again
after Resume (§11 Q1).

**Authorized recipients only** (O25). In `plainMailgunError` and `mailgunFailure`, a `"not-allowed"` error whose text
matches `/authori[sz]ed recipients|free accounts are for test purposes/i` (`isAuthorizedOnlyRefusal`) uses, for campaign
emails, `PLAN_TEXTS.authorizedOnlyCampaign`: "Mailgun sends only to authorized recipients on your free account, so it
refused this email. In Mailgun, add a payment card (Account › Billing, it may be called Plan), then click Resume. The Free
plan stays free." and, for test sends and the reply test (P4), `PLAN_TEXTS.authorizedOnlyTest`: "Mailgun sends only to
authorized recipients on your free account, so it refused this test email. In Mailgun, add a payment card (Account ›
Billing, it may be called Plan), or add this test mailbox under Authorized recipients, then try again." A prospect's
address is never suggested for authorizing (Mailgun would email them an invitation). `plainMailgunError` (no context)
uses the campaign sentence. The pause kind stays `mailgun-not-allowed`; reason "Mailgun sends only to authorized
recipients".

**Log retention** (O26). `effectiveLogRetentionDays(saved, limits)` = `limits ? min(clamp(saved, 1, 30, 5),
limits.logDays) : clamp(saved, 1, 30, 5)`. Readers: `catch-up.ts:747` (`logRetentionMs`), `restore.ts:722-723`,
`reconcile.ts:356-357`, `settings/sending/load.ts:117,335`, and the dashboard's outage texts, whose hard-coded "more than
5 days" (`attention.ts:160-161`) becomes `ATTENTION_TEXTS.outageHeld(people, days)` / `outageFound(days)` (with 5 when the
setting is 5 and no plan: unchanged in app mode). The Advanced hint becomes `PLAN_TEXTS.retentionHint` (every mode, O30):
"Mailgun's plans keep event logs for 1 day (Free, Basic), 5 days (Foundation) or 30 days (Scale), and stored replies for
1 day. Choosing your plan fills these in." The first own-mailbox connect with no plan saved writes plan "free",
`mailgun.logRetentionDays` 1 and `mailgun.messageRetentionDays` 1 (O22), so the numbers shown are the numbers in force.

**Complaints and bounces from Mailgun's lists** (O34, own-mailbox mode). `pullSuppressions(input)` gains `ownMailbox?:
boolean` (the catch-up passes `ctx.replies === "own-mailbox"`). For each entry of the `complaints` and `bounces` lists,
inside the pull's transaction and before `applyMailEvent`: when the address has no local Suppression row, find the
newest OutboundEmail with `toNorm` = the address, mode LIVE, status SENT, `sentAt ≤ (createdAt ?? now)` and `sentAt ≥
(createdAt ?? now) − 7 days`; if one exists, the event gets `messageId` = that email's `messageId` (so `matchEvent` links
it) and a bounce gets `reason: "list-bounce"`. Nothing else changes: the stop, the suppression, the date field and the
one Owner notice of the pull stay as today. `loadHealthCounts` counts a linked bounce (its reason doesn't start with
`suppress-`) and a linked complaint once per email (a Logs event for the same email doesn't add a second count). After a
pull that linked at least one entry, the catch-up runs the health check once.

**https unsubscribe links** (O20). §3.3's `https-links` rows; go-live's http-links tick; the recommendation
`GO_LIVE_RECOMMENDATION_TEXTS.planUpgrade` (§3.4).

**Webhooks and remote access** (O21). `APP_PUBLIC_URL` empty in own-mailbox mode: Apply's public-address step is ok:
null with `OWN_MAILBOX_TEXTS.applyNoPublicAddress` ("No public address yet: Mailgun's reports come through the app's
hourly check instead. Remote access is optional in your setup (Cloudflare guide)."), webhooks step ok: null
`APPLY_TEXTS.skippedNoPublicAddress` (today's), rows "info" (§3.3). The reply test section and the go-live card say
that Mailgun's reports arrive within the hour while the background sender runs, and point at **Check with Mailgun now**.

**Monthly limit row**: with a daily-limit plan (Free) the `monthly-limit` row is "info": "Your Mailgun plan stops at 100
emails a day, so a monthly safety limit isn't needed." `goLiveRecommendations` skips the monthly-limit line when the row
is "info" (only own-mailbox/Free rows can be "info").

### 2.9 Replies by hand

- **They replied** (O17): `markRepliedByHand(actor, input: { companyId: number; personId?: number | null; at?: Date },
  now?)` in `src/server/services/companies/replied-by-hand.ts` (new, P6). One `dbTx`: `loadActiveCompany` (refuses a
  deleted company with today's sentence); a `personId` must belong to the company and not be deleted
  (`ServiceError(REFRESH-style "That person isn't at this company any more. Refresh the page.")`);
  `stopCompany(tx, { companyId, replierPersonIds: personId ? [personId] : [], replierEmails: person?.emailNorm ?
  [person.emailNorm] : [], inboundId: null, now })` always (`stops.ts`, `inboundId` made optional by P6: the named person
  "Stopped: they replied", everyone else at the company "Stopped: someone at the company replied"; without a person
  everyone gets the second); then **`countsAsReply`** = the company has an included CampaignRecipient whose campaign
  `countsAsEmailed(campaign.mode, { practiceCopy, launchedGoLive: campaign.launchedGoLive })`, or nothing was open to stop
  and `hasBeenLive({ goLive, goLiveAt })` (the rule of `process.ts:663-671` for real replies); only when `countsAsReply`:
  status NOT_CONTACTED or CONTACTED → REPLIED (compare-and-set `updateMany({ where: { id, status } })`, activity
  `company.status` "Arslan set status to Replied" with `data.markedReplied: true`) and `Company.repliedAt` and the person's
  `repliedAt` set to `at ?? now` when null or older (forward only, as `effects.ts:121-135`); activity
  `company.markedReplied` ("Arslan marked Acme Studio as replied" — with a person: "Arslan marked Anna Berg (Acme Studio)
  as replied"), data `{ personId, stopped, statusFrom, statusTo, at, countsAsReply }`. After the commit `finishCheck` for
  each campaign `stopCompany` returned (best effort, as `setCompanyStatus`). Returns `{ stopped, statusChanged,
  companyName }`. A company that is Do not contact: refused ("This company is marked Do not contact: nothing is sent to it
  anyway."). The confirm dialog is told beforehand whether the status would change (`HeaderView.markReplied.countsAsReply`,
  computed with the same rule by `company-panel.tsx`).
- **Action** `markRepliedAction({ companyId, personId? })` in `src/components/company-panel/actions.ts` (P6):
  `requireUserAction()`, zod `{ companyId: id, personId: id.optional() }`, `revalidatePath("/contacts")` and
  `revalidatePath("/campaigns", "layout")`; message `THEY_REPLIED_TEXTS.toast(stopped, name)`. Added to
  `EVERYONE_ACTIONS` in `tests/integration/security/owner-actions.test.ts`.
- **Where**: the company panel header (outline button next to the status picker) and the campaign person panel (next to
  Skip/Retry), shown when `team.replies === "own-mailbox"` (with or without a fitting From), `team.address !== null`
  (shared-From mode) or Setting `practice.copy` is true, and the company isn't deleted and isn't Do not contact. Real
  per-person mode never shows it. The campaign person panel hides "Simulate a reply in the dry-run outbox"
  (`recipient-panel.tsx:154-160`) in own-mailbox mode.
- **"Please remove me" / "couldn't be delivered"**: the person's **⋯ › Mark unsubscribed** (existing,
  `markPersonUnsubscribedAction`, everyone) or the company's **Do not contact**. The texts point there (§3.2, §3.8).
- **The inbox check** (O33): `markInboxChecked(actor, now?)` in `src/server/services/sending/inbox-check.ts` (new, P6):
  refused outside own-mailbox mode (`INBOX_CHECK_TEXTS.notOwnMailbox`); writes SystemState `sending.inboxCheck` = `{ at:
  now, byUserId }` (`updateTyped`) and activity `sending.inboxChecked` (`INBOX_CHECK_TEXTS.activity(name, from)`: "Arslan
  read contact@polygonparadise.com (inbox and Spam)"), no transaction with anything else. `loadInboxCheck(now)` →
  `{ at, byName, today: boolean, waiting: Array<{ companyId, companyName, count }>, waitingTotal }` (LIVE follow-ups,
  QUEUED, step ≥ 1, due within the next 24 hours, campaign RUNNING or PAUSED, grouped by company, at most 20 companies
  listed). Action `markInboxCheckedAction()` in `src/components/replies/inbox-check-actions.ts` (P6, `requireUserAction`,
  no input, `revalidatePath("/", "layout")`), listed in `EVERYONE_ACTIONS`. The gate itself (`inboxCheckHeldIds`) is P1's
  (§8), reading the same SystemState key through `STATE_KEYS.inboxCheck`.
- **Reminders** (O19): §3.7 and §3.9.

---

## 3. Screens and copy (exact owner-facing texts)

Every string below is the copy. `{d}` = the sending domain (polygonparadise.com), `{from}` = the own From
(contact@polygonparadise.com), `{name}` = a person's name, `{company}` = a company's name. The contract objects
(`OWN_MAILBOX_TEXTS`, `PLAN_TEXTS`, `OWN_REPLY_TEST_TEXTS`, `THEY_REPLIED_TEXTS`, §7.4) hold them; P-packages never
retype them.

### 3.1 Settings › Sending & Mailgun › Mailgun connection (P2)

| Element | Copy |
|---|---|
| New fieldset, after Region, before Sending domain: legend | How the app sends |
| Option 1 (default) label / hint | **Through a sending subdomain (replies come through the app)** · For example mail.polygonparadise.com. Replies are recorded, stop follow-ups by themselves and are forwarded to your inbox. Needs Mailgun's Foundation plan (Mailgun guide). |
| Option 2 label / hint | **From polygonparadise.com itself (replies come to your own inbox)** · Every email comes from your own address, such as contact@polygonparadise.com. Replies land in that inbox, and you mark them in the app with They replied. Works on Mailgun's Free plan (Own-mailbox guide). |
| Note under the options while connected and the choice differs from the saved one | Changing this is like changing the sending domain: going live ends and the reply test starts again. |
| Sending domain hint / placeholder, own-mailbox chosen | Your own domain, exactly as Mailgun shows it, for example polygonparadise.com. · polygonparadise.com |
| Sending domain hint / placeholder, app | unchanged ("Exactly as Mailgun shows it, for example mail.polygonparadise.com." · mail.polygonparadise.com) |
| `SENDING_DOMAIN_TEXTS.website` (app mode, the root typed; O30) | polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4). |
| Under it, in the browser only (app chosen, a `WEBSITE_DOMAINS` name without `www.` typed): outline button | Use From polygonparadise.com itself (`OWN_MAILBOX_TEXTS.websiteSwitch`; selects option 2, keeps the typed domain) |
| `SENDING_DOMAIN_TEXTS.www` (own-mailbox, a `www.` name) | Type your domain without www., for example polygonparadise.com. |
| `.emptyOwn`, `.invalidOwn`, `.sandboxOwn`, `.sharedOwn` (own-mailbox) | §2.2 |
| Status line, own-mailbox (after "Connected to {d} ({region})") | · replies go to your own mailbox |
| "Save and connect" message, own-mailbox | Connected to {d} ({region}). Replies go to your own mailbox. Next: type your From address in the From address card below. (when no own From fits) — else today's "Next: click Apply recommended settings on the Domain checklist." / "Mailgun hasn't confirmed your DNS records yet: add them from the Domain checklist." Then, when this connect set the plan (O22): " The app keeps to Mailgun's Free plan (100 emails a day, 1 day of logs). If you upgrade, choose the plan under Advanced." (`OWN_MAILBOX_TEXTS.planSetFree`). The go-live-ended, sending-key and region notes follow as today. |
| Refused: own-mailbox with a saved From not on the new domain | Your From address {from} isn't on {d}. Clear it in the From address card first, then connect again. |
| Activity (`mailgun.domainChanged` data gains `fromReplies`, `toReplies`; a same-domain mode switch summary) | Arslan switched replies for polygonparadise.com to your own mailbox / Arslan switched replies for mail.polygonparadise.com to go through the app |
| Advanced: new first line, label | Your Mailgun plan |
| Select options | Not sure · Free (100 emails a day) · Basic · Foundation · Scale or higher |
| Hint | The app keeps to your plan's daily limit and log retention. Mailgun shows your plan under Account › Plan (it may be called Billing). |
| Own-mailbox with Not sure | Not chosen yet: the app keeps to the Free plan's limits (100 emails a day, 1 day of logs). |
| Retention hint (replaces "Foundation keeps 5 days of logs and 1 day of stored replies."; every mode) | Mailgun's plans keep event logs for 1 day (Free, Basic), 5 days (Foundation) or 30 days (Scale), and stored replies for 1 day. Choosing your plan fills these in. |
| Choosing a plan | fills the two numbers with the plan's (Free 1/1, Basic 1/1, Foundation 5/1, Scale 30/7); "Not sure" leaves them |
| Save button / toast | unchanged ("Save these numbers") / today's toast |
| Activity when the plan changes (existing retention activity, data gains `plan`; also written by the first own-mailbox connect, O22) | Arslan set the Mailgun plan to Free, with 1 day of event logs and 1 day of stored replies |

Layout: the two radio rows stack at 360–640 px (`grid-cols-1`); hints are muted text under each option; the page keeps
one orange button (today's precedence).

### 3.2 Settings › Sending & Mailgun › From address, own-mailbox mode (P2)

| Element | Copy |
|---|---|
| Card title | From address (unchanged) |
| Description | The address every campaign email comes from. Replies go straight to this mailbox. |
| Field label | From address |
| Placeholder | contact@{d} |
| Hint (`{shown}` as today) | People see "{ownerDisplayName} <{shown}>": each person's display name with this address. Replies go straight to this mailbox, not through the app. It must end in @{d}. |
| Nothing saved (destructive colour, above the field) | Type the address your emails come from, for example contact@{d}. Test and live campaigns can't start without it. |
| Saved but no longer fits | The saved From address {saved} isn't on your sending domain {d}, so test and live campaigns can't start. Change it below. |
| Risk note | `TEAM_FROM_TEXTS.riskNote(d)` (unchanged) |
| "Good to know" (closed `<details>`, while a From is saved) | **Good to know** · Replies come only to {from}, never to the app, and follow-ups don't stop by themselves. Read {from} every working day, its inbox and its Spam folder; when someone answered, open the company and click They replied: that stops every follow-up to it. Then click I've read {from} on the Notifications page: live follow-ups wait for that each day. · If someone asks to be removed, or {from} gets a "couldn't be delivered" notice about a campaign email, open the company and click ⋯ › Mark unsubscribed on that person (or set the company to Do not contact). · Automatic replies (out of office) and bounces that come later go to your mail provider too, or nowhere if it has no catch-all address. The app doesn't see them. · The unsubscribe link in each email reaches the app. Some mail programs unsubscribe by sending an email instead: the reply test checks that those emails reach a mailbox you read. Handle them with Mark unsubscribed. · Emails the app sends don't appear in the Sent folder of {from}. The company's timeline has them. · Never add Mailgun's MX records to {d} and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving. |
| Save button / confirm dialog while live | unchanged (`TEAM_FROM_TEXTS.saveButton`, `confirmTitle`, `confirmBody`, `confirmButton`, `cancelButton`) |
| Toast, From set | From now on, campaign emails show From {from}. Replies go straight to that mailbox (look in its Spam folder too): when someone answers, click They replied on their company. Run the reply test before live campaigns (Settings › Domain checklist). |
| Toast, From cleared | The From address is cleared. Test and live campaigns can't start until you type an address on {d}. |
| Refused: validation | §2.2 sentences under the field |
| Refused: on the test list / campaigns / lost connection | unchanged |
| Activity (`mailgun.fromAddressChanged`) | unchanged summaries (`fromChangedSummary`), except clearing in own-mailbox mode: "Arslan cleared the From address" |

Order and layout as the shared-From card (field → hint → Save → risk note → details; `grid-cols-1`,
`[overflow-wrap:anywhere]`, `SETTINGS_DIALOG_CLASS`).

### 3.3 Settings › Domain checklist, own-mailbox mode (P3 rows, P4 page)

**Page header** second line: `OWN_MAILBOX_TEXTS.checklistLine(from, d)` = "Emails show From {from} and go out through {d}
itself. Replies go straight to that mailbox." (no fitting From: "Emails go out through {d} itself. Type your From address
in Settings › Sending & Mailgun.").

**Recommended settings card**, own-mailbox mode: `APPLY_HINT` (`domain/page.tsx:16-17`) is replaced by
`OWN_MAILBOX_TEXTS.applyHint`: "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank
footers and asks Mailgun for secure unsubscribe links. With remote access it also sets the webhooks. It changes nothing
about receiving mail: mail for polygonparadise.com stays with your mail provider."

**Rows, in order**: mailgun-domain, spf, dkim, tracking-cname, https-links, dmarc, **from-mx**, tracking-off,
unsubscribe, signing-key, webhooks, sending-allowed, monthly-limit, remote-access, reply-test, postmaster, domain-age. Not
built: `mx`, `spam-filter`, `retention`, `reply-routes`, `from-spf`. The page shows no reply-routes list and no
placeholder "Replies reach each sender" row (`checklist.tsx:234`). The page's filter that drops `from-mx` and `from-spf`
while no From is saved (`domain/load.ts:194`) applies **only in app mode**: in own-mailbox mode the `from-mx` row shows
before a From is saved (O10).

**mailgun-domain**, own-mailbox: every case as today except the not-active one, whose fix is
`OWN_MAILBOX_TEXTS.mailgunDomainFix(d)`: "Check the SPF, DKIM and tracking rows below, then click Check again in a few
minutes. Mailgun's page for {d} also lists MX records: leave them out. Never add Mailgun's MX records (mxa.mailgun.org,
mxb.mailgun.org) to {d}."

**spf** (key `spf`, title `checklistTitle("spf", d)` = "Mailgun may send for polygonparadise.com (SPF)"; `wanted` =
Mailgun's own SPF includes, `spfIncludes(expectedSpf(m) ?? "v=spf1 include:mailgun.org ~all")`; `reached` = the
record's top-level includes plus `names` of the lookup report; no record box in any case):

| Case (checked in this order) | Status | Text | Fix |
|---|---|---|---|
| Mailgun's facts or the DNS couldn't be read | unknown | today's `mailgunUnavailable` / "Couldn't check right now." | — |
| 2+ SPF records on either resolver | bad | {d} has {n} SPF records, so mail servers ignore all of them: your campaign emails and your everyday email fail SPF. | Ask the person who set up the app to merge them into one record, keeping every part of both (including include:mailgun.org). |
| no SPF record (both agree) | bad | {d} has no SPF record, so mail servers can't tell that Mailgun may send for it. | `OWN_SPF_TEXTS.noRecordFix` (review DOMAIN-1): "Ask the person who set up the app to add an SPF record for {d} (Name @) as your mail provider's help pages show it, with include:mailgun.org just before ~all. Your everyday email depends on it too, so don't add it yourself. Then click Check again." |
| spreading / timeout | warn / unknown | "Still spreading. Check again in 30 minutes." / "Couldn't check right now." | — |
| review DOMAIN-1: the two resolvers' top-level records differ, a name dangles on only one of them, or their walks (each from its own record, repeated includes counted every time: `countRepeats`) differ in Mailgun reach or count | warn (unknown when a walk timed out and neither is complete) | "Still spreading. Check again in 30 minutes." (Details lists each resolver's walk) | — (never a fix) |
| an included name without an SPF record (`dangling`) | bad | {d}'s SPF record includes {name}, which has no SPF record, so mail servers treat {d}'s SPF as broken: your campaign emails and your everyday email fail SPF. | If {d}'s DNS moved recently, add the TXT record of {name} again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app. |
| `+all` | bad | today's text ("Your SPF record lets anyone send email for your domain (+all).") | Change +all at the end to ~all. |
| a count that couldn't finish, lower bound ≤ 10 | unknown | Couldn't count all the DNS lookups {d}'s SPF record needs: at least {n} of the 10 allowed. | — |
| more than 10 lookups | bad | {d}'s SPF record needs {n} DNS lookups (the limit is 10), so mail servers treat it as broken: your campaign emails and your everyday email fail SPF. | Ask the person who set up the app to remove services you no longer use from it. Keep include:mailgun.org: without it Mailgun can't send for {d}. |
| some `wanted` include not in `reached` (both complete walks agree, same count) | bad | {d}'s SPF record doesn't include Mailgun, so the app's emails fail SPF. | `OWN_SPF_TEXTS.noMailgunFix` (review DOMAIN-1): "Ask the person who set up the app to add include:mailgun.org to {d}'s SPF record (Name @), just before ~all, changing nothing else. Your everyday email depends on that record too, so don't edit it yourself. It uses {n} of 10 DNS lookups now, and include:mailgun.org adds about 5." |
| 9 or 10 lookups | ok | Mailgun may send for {d} (through its SPF record's includes). The record is almost full: {n} of 10 DNS lookups. Before you add another email service to {d}, ask the person who set up the app. | — |
| otherwise | ok | Mailgun may send for {d} ({n} of 10 DNS lookups). | — |

**from-mx** (title `checklistTitle("from-mx", d)` = "Mail for polygonparadise.com stays with your mail provider (MX)";
own-mailbox wording, never a record box, `problem` never used in this mode). `{putBack}` =
`OWN_MAILBOX_TEXTS.putBackMx(lastGoodMx)`: with a saved last good MX, "put back your mail provider's MX records: {host}
(priority {n}), …" (for this owner "mx.zoho.com (priority 10), mx2.zoho.com (priority 20), mx3.zoho.com (priority
50)"); without one, "put back your mail provider's MX records (its help pages list them)". `{never}` =
`NEVER_MAILGUN_MX_TEXT(d)` = "Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to {d}."

| Case | Status | Text | Fix |
|---|---|---|---|
| either resolver sees an MX host ending in `mailgun.org` | bad | {d}'s mail servers (MX) point to Mailgun. Your everyday email and every reply to your campaigns would go to Mailgun, where nobody reads them. Live campaign emails wait until this is fixed. | In the DNS panel for {d} (GoDaddy), delete the MX records of {d} (Name @) that point to Mailgun, and keep only {others}. {never} Then click Check again. (no other host: "…that point to Mailgun, and {putBack}. {never} Then click Check again.") |
| a null MX (`0 .`) | bad | {d}'s MX record says it takes no email (a "null MX"), so replies to your campaigns bounce, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed. | In the DNS panel for {d}, delete the MX record of {d} (Name @) whose value is just a dot, and {putBack}. {never} Then click Check again. |
| no MX (both agree) | bad | {d} has no mail servers (MX), so replies to your campaigns can't reach you, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed. | In the DNS panel for {d}, {putBack} (Name @). {never} Then click Check again. |
| Cloudflare Email Routing, none Mailgun | **bad** (own-mailbox only; app mode keeps "warn") | Mail for {d} goes to Cloudflare Email Routing ({hosts}), not to your mailbox at your mail provider, so your everyday email and the replies to your campaigns may never reach it. Live campaign emails wait until this is fixed. | In Cloudflare, switch Email Routing off for {d}, then in its DNS {putBack}. {never} Then click Check again. |
| spreading / timeout | warn / unknown | today's | — |
| otherwise | ok | Mail for {d} goes to your mail provider ({hosts}), not to Mailgun, so replies reach your inbox. Keep it that way. | — |

At every own-mailbox check whose `from-mx` row is "ok", `runDomainCheck` stores the MX answer (hosts and priorities of
the agreeing resolvers, at most 10, none ending in `mailgun.org` or `mx.cloudflare.net`) as
`DomainCheckState.lastGoodMx`; a later check passes it back in `ChecklistFacts.lastGoodMx`. A check of another domain or
mode clears it.

**https-links** (own-mailbox only differs when Apply recorded `not-in-plan`): status **info**, text "Your Mailgun plan
doesn't include secure (https) unsubscribe links, so they use http. They still work when clicked, but Gmail's and
Yahoo's one-click unsubscribe button needs https, so it may not show. That is required only above 5,000 emails a day to
Gmail." fix "Foundation and higher include https links. After upgrading, choose the plan in Settings › Sending & Mailgun ›
Advanced and click Apply recommended settings." Every other case as today (they don't gate go-live in this mode; the
go-live tick covers any row that isn't "ok").

**dmarc** (`dmarcRow` on the sending domain, as per-person mode, with two own-mailbox texts): missing → fix "Add a TXT
record. Name: _dmarc. Value: v=DMARC1; p=none. It also covers your everyday email from {d}; p=none changes nothing for
it."; an unauthorised `rua` → fix "Remove rua from the record, or use a mailbox at {d} that you read." All else as today.

**dkim**: `dkimRow` without team facts (per-person wording): "Your emails carry polygonparadise.com's digital signature
(1024-bit; it works, 2048-bit is stronger)."

**webhooks**, own-mailbox and no public address: **info**, "No public address yet, so Mailgun can't tell the app at
once. The app reads Mailgun's logs every hour instead, while the background sender runs." fix "Optional: remote access
(Cloudflare guide) lets Mailgun tell the app at once." With a public address: today's row.

**remote-access**, own-mailbox and no public address: **info**, "Remote access isn't set up: the app works on this PC and
your office network only." fix "Optional in your setup. To reach the app from elsewhere, follow the Cloudflare guide." With
a public address: today's row.

**monthly-limit**, a plan with a daily limit: **info**, `PLAN_TEXTS.monthlyNotNeeded(100)` = "Your Mailgun plan stops at
100 emails a day, so a monthly safety limit isn't needed." Otherwise today's row.

**reply-test** (own-mailbox texts; a pass counts only through `replyTestPassedFor(r, d, ownFrom, { ownMailbox: true })`):

| Case | Status | Text | Fix |
|---|---|---|---|
| passed for this domain, own From and mode | ok | The reply test passed{ on date} with the From address {from}: test emails arrived, your replies reached {from}, unsubscribing works, and the test email passed DMARC. | — |
| failed for them | bad | The reply test didn't pass with the From address {from}. | The reply test section says which check failed. |
| no fitting own From | warn | Type your From address in Settings › Sending & Mailgun first. | — |
| otherwise | warn | Not tested yet with the From address {from}. Live campaigns start once this passes. | — |

**postmaster**: the shared-From rule with the sending domain (`teamPostmasterRow` logic, `org` = {d}): a
`google-site-verification` TXT stays **info** ("A Google verification record is on {d}. Check at postmaster.google.com
that {d} is listed there."); none → info "Optional: see how Gmail rates {d}, the domain your everyday email uses."

**domain-age**: today's row with {d} (the owner enters 2024-08-22: ok, "polygonparadise.com is 767 days old.").

**tracking-cname, tracking-off, unsubscribe, signing-key, sending-allowed**: unchanged.

### 3.4 Mode gates and go-live (contract; §7.5)

- **Live mode, the reply test and a LIVE launch**, own-mailbox (`ctx.ownMailbox`): the DNS sentence covers
  mailgun-domain, spf, dkim and tracking-cname (no `mx`); right after it the from-mx sentences (`fromMxUnchecked` for a
  missing row, `fromMx` for "bad"), as in shared-From mode; tracking-off, unsubscribe, webhooks (an "info" row passes),
  signing-key, sending-allowed as today. The reply test needs no owner route and no public address; it needs the `dmarc`
  row present and not "bad" (`MODE_GATE_TEXTS.dmarcFirst`: "Add the DMARC record first (the DMARC row of the Domain
  checklist) and wait until it shows Done, so the test emails can pass DMARC.", O38) and Setup A: in this mode the stored
  setup is always A (O2 resets it; switching to B is refused), and if a restored database still says otherwise the
  blocker is `OWN_MAILBOX_TEXTS.setupNotNormal` ("The reply test is set to a check-only setup. Click Back to normal in the
  Reply test section.") with a **Back to normal** button there; `MODE_GATE_TEXTS.setupA` is never shown in this mode. A
  LIVE launch needs the reply test passed (O13) and, before go-live, a test list.
- **Go-live rows**, own-mailbox (`goLiveRowKeys(false, { ownMailbox: true, publicAddress })`): mailgun-domain, spf, dkim,
  tracking-cname, dmarc, from-mx, tracking-off, unsubscribe, signing-key, [webhooks], sending-allowed, [remote-access]
  (the two in brackets only with a public address). `GO_LIVE_ROW_KEYS` itself is unchanged (the guide-4 list test).
- **Go-live blockers**, own-mailbox: `sendersWithoutRoute` is `[]`; everything else as today (checklist fresh after the
  last change, rows, Setup A, reply test, not paused, live test, worker).
- `GO_LIVE_COPY.dialogOwnMailboxItem(from, d)` (third item, where the From line goes): "Every email shows From {from} and
  goes out through {d} itself. Replies come only to {from}: the app never sees them."
- `GO_LIVE_COPY.ownMailboxTick(from)` (a required checkbox, always in own-mailbox mode): "I read {from} every working
  day, its inbox and its Spam folder. When someone answers there, I click They replied on their company, I handle
  removal requests and "couldn't be delivered" notices with Mark unsubscribed, and then I click I've read {from}: live
  follow-ups wait for that each day."
  `GO_LIVE_COPY.ownMailboxRequired`: "Tick the box about replies in your own mailbox first."
- `GO_LIVE_COPY.httpLinksTick` (required while the https-links row isn't "ok"): "I know unsubscribe links use http on my
  Mailgun plan, so Gmail's and Yahoo's one-click unsubscribe button may not show." `GO_LIVE_COPY.httpLinksRequired`:
  "Tick the box about unsubscribe links first."
- `GO_LIVE_COPY.liveOwnFromLine(from)` (under the live line): "Emails show From {from}; replies go straight to that
  mailbox."
- `GO_LIVE_COPY.guideLineOwn`: "Step by step: Own-mailbox guide, step 11."
- Recommendations (`goLiveRecommendations`, own-mailbox): `GO_LIVE_RECOMMENDATION_TEXTS.postmasterOwn(d)` when the row
  isn't "ok" (instead of `postmasterTeam`, which points into the Mailgun guide): "Add {d} to Google Postmaster Tools, so
  you can watch how Gmail rates the domain your everyday email shares (Own-mailbox guide, step 14).";
  `GO_LIVE_RECOMMENDATION_TEXTS.authorizedCheck` while the plan is Free: "Check in Mailgun that your account can email
  anyone: if it says free accounts only send to authorized recipients, add a payment card (Account › Billing). Otherwise
  the first live email to a prospect pauses sending."; `GO_LIVE_RECOMMENDATION_TEXTS.planUpgrade` while the plan has a
  daily limit: "On Mailgun's Free plan the app sends at most 90 campaign emails a day, keeps 1 day of logs and uses http
  unsubscribe links. Mailgun's Foundation plan lifts all three and lets replies reach the app (Own-mailbox guide, step
  15)."; `GO_LIVE_RECOMMENDATION_TEXTS.checksFree` replaces the checks line while the plan is Free and no check was tried
  (review SCREENS-01: no other checker exists): "Address checks are optional but paid: Mailgun's Free plan doesn't
  include them (the Email Validations add-on costs about 1 cent per address). Going live doesn't need them, but after
  going live, live campaigns only email checked addresses. Try one check in Settings › Deliverability › Test address
  checks; if Mailgun refuses it, add Email Validations in Mailgun (Account › Billing) before your first real campaign."
  The monthly-limit line is skipped for an "info" row.
- Review SCREENS-11 (own-mailbox only): a "bad" from-mx row says `MODE_GATE_TEXTS.fromMxOwn` ("Mail for your domain
  doesn't go to your mail provider: it points to Mailgun or Cloudflare Email Routing, or is missing. …") instead of
  `fromMx`, and no live test yet says `liveTestNoneOwn` ("… (Own-mailbox guide, step 10).") instead of `liveTestNone`;
  a live test whose report is gone says `OWN_MAILBOX_TEXTS.liveTestGone` (REPLIES-08).

### 3.5 The reply test by hand (P4)

`OWN_REPLY_TEST_TEXTS` (contract):

- Intro (step 1 of the section): "Send the test emails: one to each mailbox on your test list, from {from}. Replies come
  straight to {from}, not to the app."
- Under the intro: "The app hears from Mailgun about deliveries and unsubscribes within the hour while the background
  sender runs. To check sooner, click Check with Mailgun now in Settings › Sending & Mailgun."
- Each mailbox's box, in this order: 1. `REPLY_TEST_TEAM_TEXTS.placementQuestion` (Yes / No); 2. "Reply to the test email
  from this mailbox. Did your reply arrive in {from}? Look in its Spam folder too." (Yes / No, stored as `inboxOk`);
  3. `REPLY_TEST_TEAM_TEXTS.dmarcQuestion` with "Not sure" → paste (as shared-From). The "dkim=pass or arc=pass" question
  and the "Reply reached the app" fact line are not shown.
- The pasted original part: as shared-From (heading, text, **Read the original**), lines from `testOriginalTexts(result,
  { from, d, org: d, ownMailbox: true })`:
  - From: "From: {from} ✓" / today's mismatch sentence (not accepted);
  - Return address on {d}: "Return address: …@{rp}. Bounces that come later and automatic replies go to your own mailbox
    (or nowhere), not the app."; elsewhere: "Return address: …@{rp}, not on {d}. Tell the person who set up the app.";
    none: today's sentence;
  - DMARC: `dmarcResultsText`; Signature: "Signed by {signer} ✓" / "No valid signature found.";
  - Unsubscribe link: https → "Unsubscribe link: https ✓"; http → "Unsubscribe link: http. It works when clicked, but
    Gmail's and Yahoo's one-click unsubscribe button needs https (Mailgun's Foundation plan)."; none → "The original shows
    no unsubscribe link in its headers.";
  - Unsubscribe by email: a mailto → "Unsubscribe by email goes to {mailtoAddress}. The question below checks that it
    reaches a mailbox you read." (`mailtoOwn`); none → "Unsubscribe by email: not offered." (then the question below
    isn't asked).
  - `parseTestOriginal` also returns `mailtoAddress` (the whole address of List-Unsubscribe's first `mailto:`, without
    `?…`, lowercase, at most 254 characters; null without one); `saveReplyTestOriginal` stores it in
    `ReplyTestOriginal.mailtoAddress`.
- The List-Unsubscribe question's note (`mailtoNote`): "It may also show a mailto: address: that's expected. The next
  question checks where emails to it arrive."
- **The unsubscribe-by-email question** (once, below the List-Unsubscribe question, only while the stored original has a
  `mailtoAddress`; stored as `UnsubscribeTestSetting.mailtoArrived`, reset with the round). **Review REPLIES-01**: for
  an address on {from}'s own domain (always in this mode) "From one of your test mailboxes, send an email to
  {mailtoAddress} (any subject and text). Within the hour, did it arrive in {from} or another mailbox you read? Look in
  Spam too." (`mailtoQuestion`), Yes / No, with a copy button next to the address, and under it (`mailtoAfter`): "Answer
  Yes only if you found that email in a mailbox you read. If the test mailbox got a "couldn't be delivered" notice back,
  or nothing arrived, answer No. Settings › Deliverability can't answer this: it lists the test mailbox because of the
  unsubscribe link you clicked." For an address on another domain the Deliverability proof stays, but only from the test
  mailbox whose link wasn't clicked (`mailtoAfterElsewhere`: "If Settings › Deliverability lists that mailbox now, click
  Remove there so the live test can reach it.").
- **Review SCREENS-04**: the List-Unsubscribe question in this mode is `headersQuestion` ("In one test mailbox, open the
  test email's original. Do you see a List-Unsubscribe: line with a link (http:// or https://)?") with `headersNote`
  (http and no List-Unsubscribe-Post are expected on Free); `mailtoNote` shows only while unsubscribe by email is offered.
- **Review SECURITY-03** (fail closed): `parseTestOriginal` reads every List-Unsubscribe header, percent-decodes the
  `mailto:` target, allows a quoted local part and keeps up to 998 characters; a `mailto:` it still can't read sets
  `mailtoUnreadable` (stored in own-mailbox mode). `mailtoOffered()` treats any mailto field as "offered", so such an
  original fails with `mailtoUnreadable` and its line says "Unsubscribe by email is offered, but the app can't read its
  address.", never "not offered"; a stored `mailtoAddress` that is malformed drops the whole stored original.
- **Review REPLIES-03** (the last resort, self-checking): `mailtoFailed` lists the ways forward in order (a catch-all;
  aliases `u@{d}` and `bounce@{d}` of {from}, "try it, the test shows whether it works"; then **Leave out unsubscribe by
  email** below). That button shows under the failure line once the question is answered No (or the address can't be
  read); **Leave it out** in its dialog calls `setLeaveOutMailtoAction` → `setLeaveOutMailto` (one transaction, round
  check, own-mailbox only, refused while a test or live campaign is scheduled, running or paused; clears the result, the
  original, `headersOk` and `mailtoArrived`; logs `settings.updated`). While `leaveOutMailto` is set, every own-mailbox send
  through `MailgunClient.sendMessage` (campaign emails, Send me a test, the reply test; the setting read fresh before each,
  an unreadable setting refuses before any request) carries `h:List-Unsubscribe: <%unsubscribe_url%>`, so Mailgun adds none
  with its `mailto:`. The verdict then skips the question and passes only if a new original shows an http(s) link and no
  `mailto:` (`leftOutMailtoStill` / `leftOutNoLink` fail; `leftOutSendAgain` while no new original), with `leftOutNote` in
  its warnings; **Offer unsubscribe by email again** / **Offer it again** undoes it the same way. A From or domain change
  rebuilds the setting from its defaults, so the choice is dropped (fail closed: Mailgun's header comes back).
- **Review REPLIES-08**: with 1 day of logs, a test email not delivered and sent before `reportsGoneBefore(now, logDays)`
  says `reportGone` ("…: Mailgun's report for this test email is no longer available, … Send the test emails again."),
  an unsubscribe seen only through Mailgun's list says `unsubscribeGone`, and the go-live card's live test says
  `liveTestGone`.
- What is still missing (`missing`, in the verdict's order): "{address}: send the test email first." (today) · "{address}:
  the test email hasn't been delivered yet." (today) · `placementUnanswered` · "{address}: answer whether your reply
  arrived in {from}." · `dmarcUnanswered` · `originalMissing` · `returnPathUnknown` · `headersUnanswered` / `headersMissing`
  · "Answer whether the email to the unsubscribe address arrived." (`mailtoUnanswered`, only with a `mailtoAddress`) ·
  `unsubscribe` · `needMicrosoft` / `needGmailOrYahoo`.
- Failures: "{address}: your reply didn't arrive in {from}. Check the Spam folder and the filters of {from}, then change
  the answer." · `dmarcFailed(address)` · "The test email's return address is on {rp}, not on {d}. Tell the person who set
  up the app." · "The test email has no List-Unsubscribe header. Click Apply recommended settings and send the test
  emails again; if it stays that way, ask the person who set up the app." · `mailtoFailed(mailtoAddress, d, from)`:
  "Emails to {mailtoAddress} don't reach anyone, so people who unsubscribe by email (a button some mail programs show)
  would never be removed. In your mail provider's admin settings for {d}, turn on a catch-all address that delivers to
  {from} (Zoho Mail: Admin Console › Domains › {d} › Catch-all Address, under Advanced Settings), send the email again
  and change the answer. If your mail provider can't do that, tell the person who set up the app." (superseded by review
  REPLIES-03: catch-all → aliases → Leave out unsubscribe by email, see above; Zoho's steps are
  quoted from https://www.zoho.com/mail/help/adminconsole/catch-all-setup.html: "Log in to Zoho Mail Admin Console and
  navigate to Domains", "Select your domain", "Go to Catch-all Address under Advanced Settings", "Enter the mailbox
  address in the Enter a catch-all address field", "click Update"; the page doesn't say which Zoho plans include it,
  §11 Q6.) A catch-all also catches `bounce+…@` mail, so late bounces and out-of-office replies sent to the return
  address then reach {from} too.
- The section's failure sentence: "The reply test didn't pass with the From address {from}. The lines above say which
  check failed." The decided line (passed): the reply-test row's ok text (§3.3).
- The Setup A/B switch (`reply-test-section.tsx:733-760`) is not shown; `switchUnsubscribeSetup` refuses a switch to B in
  own-mailbox mode ("Your setup always uses Setup A.", `setupAOnly`) and allows the switch back to A, shown only while the
  stored setup isn't A, as **Back to normal** (`OWN_MAILBOX_TEXTS.backToNormal`).
- Services (P4): `saveReplyTestAnswers` checks the round with `team.evidenceFrom` (`reply-test.ts:719`, today
  `team.address`) and reads DMARC pastes for the evidence From's domain (`:708-709`, `:723`); `saveReplyTestOriginal`
  needs `team.evidenceFrom` (not `team.address`, `:746-750`), uses `fromDomain` = {d} in own-mailbox mode (`:751`),
  `countsForToday(send, team.evidenceFrom, team.changedAt)` (`:766`) and `parsed.from !== team.evidenceFrom` (`:771`), and
  stores `from: evidenceFrom` and `mailtoAddress`; the answers schema accepts `mailtoArrived`.

### 3.6 Send me a test and the test list (P4)

- From "{senderDisplayName} <{from}>", no Reply-To, to the viewer's test inbox (Setting `User.replyInbox`, else the
  sign-in email). No sending address is needed. When the inbox equals {from}, the success message gains
  `TEAM_FROM_TEXTS.selfTestNote(from)` (" It comes from {from}, your own address: if it isn't in your inbox within a few
  minutes, look in spam.").
- The rolling guard: `PLAN_TEXTS.testsFull(limit)` (§2.8). The reply test refuses with the same sentence when its emails
  don't fit.
- An authorized-recipients refusal of a test email uses `PLAN_TEXTS.authorizedOnlyTest` (§2.8).
- The test list is unchanged (`validateTestList` refuses addresses on the sending domain, contact@ included).

### 3.7 My profile, Team, Limits, wizard, campaign page (P5, P1)

| Place | Own-mailbox copy |
|---|---|
| My profile, instead of the sending-address field | Your emails show "{displayName} <{from}>". Replies go straight to {from}. (no fitting From: "Your emails will show your display name with the From address the Owner sets in Settings › Sending & Mailgun.") |
| My profile, reply-inbox field label / hint | Inbox for your test emails · Send me a test sends your test emails here. Replies to your campaigns go to {from}. (the loop rule doesn't apply: contact@polygonparadise.com is allowed) |
| Signature hint suffix | " If your signature shows an email address, use {from}." |
| Profile toast | today's "Profile saved." (no address sentence) |
| Team switch-off intro | …Replies to {name}'s campaigns go to {from}, as before. |
| Limits: per-sender list | every active user (no "Nobody has a … address yet" state); the address column is titled "Emails show" and holds the From line |
| Limits: plan line (daily-limit plans) | Your Mailgun plan sends at most 100 emails a day, so the app plans at most 90 campaign emails a day and keeps 10 for test emails. |
| Limits: under the maximum daily limit field, while the plan lowers it | Your Mailgun plan keeps this at 90 at most. (`PLAN_TEXTS.maxFieldHint`) |
| Wizard Sender step | "Recipients see" the From line; no address or route line; bottom line: "Display names and signatures are set in Settings › My profile. The From address ({from}) is set by the Owner in Settings › Sending & Mailgun. The Owner sets each teammate's own daily limit in Settings › Limits & warm-up." and the reminder |
| Reminder (wizard, campaign page; `OWN_MAILBOX_TEXTS.followUpReminder(from)`) | Replies come straight to {from}, not to the app. Each day, read {from} and its Spam folder, click They replied on every company that answered, then click I've read {from} on the Notifications page: live follow-ups wait for that. |
| Campaign page header | "Sent by Arslan as Arslan from Polygon Paradise <contact@polygonparadise.com>" (no "replies to"); the reminder under the follow-ups while the campaign is an own-mailbox one (`fromAddress` = today's own From, `replyTo` null) with follow-ups to come, followed by a link **Open the inbox check** (`/notifications#inbox-check`); its waiting line may say "Waiting for today's inbox check (Notifications › Inbox check)." |
| Dry-run outbox | the Reply, Out-of-office and Unclear reply simulate buttons are hidden; Delivered, Bounce, Complaint and Unsubscribe stay |
| Campaign person panel | "Simulate a reply in the dry-run outbox" hidden (P6); They replied shown (§3.8) |

### 3.8 They replied (P6)

`THEY_REPLIED_TEXTS` (contract):

| Element | Copy |
|---|---|
| Button (outline, `MailCheck` icon, never `MessageSquareReply`, which the simulate link uses; company panel header next to the status picker; campaign person panel next to Skip/Retry) | They replied |
| Accessible name (review SCREENS-09, WCAG 2.5.3 Label in Name) | name = "They replied" (the visible label; no `aria-label`); description = "Mark as replied: stops every follow-up to this company" (`THEY_REPLIED_TEXTS.ariaLabel`, a visually hidden span named by `aria-describedby`, on both buttons) |
| Confirm dialog title (company / person) | Mark {company} as replied? / Mark {person} as replied? |
| Body, status will change (`countsAsReply` and Not contacted/Contacted) | Every follow-up to {company} stops, in every campaign, and its status becomes Replied. |
| Body, status stays (Replied, Client, Not interested) | Every follow-up to {company} stops, in every campaign. |
| Body, only test emails so far (not `countsAsReply`) | Every follow-up to {company} stops, in every campaign. Its status stays as it is, because it has only had test emails so far. (`bodyTestOnly`) |
| Stop wording afterwards (campaign page, company panel; existing `stopStateText`) | Stopped: they replied (the person named) · Stopped: someone at the company replied (everyone else) |
| Body suffix, person variant | {person} is noted as the one who replied. |
| Buttons | **Mark as replied** (primary) / Cancel |
| Toast | Marked as replied. Follow-ups to {n} {person/people} stopped. · Marked as replied. No follow-ups were waiting. |
| Refused: Do not contact | This company is marked Do not contact: nothing is sent to it anyway. |
| Refused: the person isn't at the company | That person isn't at this company any more. Refresh the page. |
| Activity | Arslan marked Acme Studio as replied · Arslan marked Anna Berg (Acme Studio) as replied |

The confirm dialog uses `SETTINGS_DIALOG_CLASS`-style full screen at 360–640 px (the company panel's `ConfirmDialog`).
"Mark unsubscribed" and the status picker are unchanged.

### 3.9 Dashboard, notices, pauses, waiting lines (P5, P1, P3)

- Attention item `inbox-check` (own-mailbox only, everyone, **tone warning**, right after `replies-waiting`), while
  nobody has done today's inbox check (`sending.inboxCheck.at` outside today's cap day) and LIVE follow-ups (step ≥ 1,
  QUEUED, due now or within the next 24 hours, campaign RUNNING **or PAUSED**) exist: `INBOX_CHECK_TEXTS.item(n, from)`
  "{n} follow-ups wait for today's check of {from}. Whoever reads it: read its inbox and Spam folder, click They replied
  on every company that answered, then click I've read {from}." (1: "1 follow-up waits …"); link `{ href:
  "/notifications#inbox-check", label: "Open the inbox check" }`. Gone once someone has clicked today. ("Whoever reads it"
  names the role without a new setting: a Member who doesn't read contact@ knows the click isn't theirs.)
- **Inbox check card** (P6, `src/components/replies/inbox-check-card.tsx`, own-mailbox only, id `inbox-check`, on the
  Notifications page above "Replies waiting for an answer", and shown even when the page would otherwise be empty):
  title "Today's inbox check"; text `INBOX_CHECK_TEXTS.intro(from)`: "Replies to your campaigns come only to {from}.
  Before live follow-ups go, read its inbox and its Spam folder. For every answer, open the company and click They
  replied (search Contacts for the address it came from). Then click the button below: live follow-ups wait for it each
  day."; the waiting list "Follow-ups due in the next 24 hours:" with each company as a link to `/contacts?company={id}`
  and its count (at most 20, then "and {n} more"); the last check line `INBOX_CHECK_TEXTS.last(when, name)` "Last read
  {today at 09:12 / on 26 Sep at 16:40} by {name}." or "Nobody has read it today."; button (primary while not done today,
  outline afterwards) `INBOX_CHECK_TEXTS.button(from)` "I've read {from}"; toast `INBOX_CHECK_TEXTS.done`: "Thanks. Live
  follow-ups due today can go now." Everyone may click it; the activity names who did.
- Bell notification (P1's loop, once per 24 hours, notice key `inbox-check`, type `reply.inboxCheck` in the Replies
  pop-up group, to the Owner) when a tick holds a LIVE follow-up for the inbox check: title "Follow-ups wait for today's
  inbox check" (since review SEND-1 "Live emails wait for today's inbox check"), body `INBOX_CHECK_TEXTS.notificationBody(from)`: "Read {from} (inbox and Spam), click They replied where
  someone answered, then click I've read {from}.", link `/notifications#inbox-check`.
- Waiting line (`waitingText`, reason `inbox-check`): "Waiting for today's inbox check (Notifications › Inbox check)."
- Empty states, own-mailbox: the dashboard's replies tile (`replies-list.tsx`, instead of "No replies are waiting for
  you.") and Notifications › Replies (`replies-section.tsx`, instead of "No replies are waiting for an answer.") say
  `OWN_MAILBOX_TEXTS.repliesEmpty(from)`: "Replies go straight to {from}, not to the app. When someone answers, click
  They replied on their company."
- Attention `go-live-again` after a From change compares evidence Froms (`currentFrom = evidenceFrom`); after a mode
  switch it is the domain-change item (the domain changed too) or, for a same-domain switch, the From-change item.
- Attention `checklist`: `badGoLiveRows(rows, teamFrom, { ownMailbox, publicAddress })` uses the own-mailbox keys.
- Attention `outage-hold` / outage sentences: "more than {n} days" from `effectiveLogRetentionDays` (§2.8).
- Notice `from-mx-bad`, own-mailbox body (`FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn(d)`): "{d}'s mail servers (MX) point to
  Mailgun or are missing, so your everyday email and the replies to your campaigns can be lost. Live campaign emails wait
  until it's fixed. Open Settings › Domain checklist." Title unchanged ("Mail for {d} goes to the wrong place"). Review
  DOMAIN-8: when the row's cause is Cloudflare Email Routing (`ownMxCause(mx)`, the same function the row picks its
  branch with) the body is `mxBodyOwnCloudflare(d)`: "Mail for {d} goes to Cloudflare Email Routing instead of your mail
  provider, so your everyday email and the replies to your campaigns can be lost. Live campaign emails wait until it's
  fixed: switch Email Routing off in Cloudflare. Open Settings › Domain checklist."
- Review SCREENS-11: the own-mailbox waiting line for `main-domain-mx` is `OWN_MX_WAITING_TEXT` ("Waiting: mail for your
  domain doesn't go to your mail provider (it points to Mailgun or Cloudflare Email Routing, or is missing), so your
  everyday email and replies to your campaigns can be lost. …"; `waitingText(…, { ownMailbox })`); the top-bar tooltip,
  the Live confirmation, the test list's hint and empty state and the Review step's Send me a test line say "your inbox
  for test emails" instead of "reply inbox".
- Review REPLIES-09: the Check with Mailgun card's outage line is `ownOutageLine` (Mailgun's reports couldn't be read;
  replies aren't affected), its description drops "and replies it missed", and the dashboard's not-yet-held item is
  `ATTENTION_TEXTS.outageFoundOwn(days)`. People still held by an app-mode hold from before a switch keep today's lines.
- Review REPLIES-05: the inbox-check card intro, the dashboard item and the notification body also say that removal
  requests, emails to the unsubscribe address and "couldn't be delivered" notices need ⋯ › Mark unsubscribed; the bell
  title is "Live emails wait for today's inbox check" (SEND-1: a first email may be what waits).
- Health warnings, own-mailbox: complaint warnings get the shared-From sentence with the evidence From (" Your emails come
  from {from}, so these complaints also count against your everyday email. Gmail's complaints aren't in this count: check
  Google Postmaster Tools."); bounce warnings get " Bounces that arrive later go to {from}, not the app, so the real
  number can be higher."
- Pauses: §2.8 (`limit`, authorized recipients). Waiting line `plan-limit` (§2.8). The main-domain MX waiting line is
  today's SCREENS-07 sentence. An email failed after a second sender block (O35) shows "Didn't send: this email doesn't
  fit your From address any more. Start a new campaign to email this person again." (`senderBlockedTwice`).

---

## 4. Every Mailgun flow in own-mailbox mode

| Flow | Own-mailbox mode | Package |
|---|---|---|
| Connect (`testMailgunConnection`, `connectMailgun`) | `validateSendingDomain(…, { replies })`; the mode is part of `changing` (O2); no address move; no route sync; F14-style From check with own-mailbox rules | P2 |
| Context (`getMailgunContext`) | gains `replies` and `ownFrom` (from `loadTeamFrom`); passes `ownMailboxFrom` to both clients | step C |
| Routes (`syncRoutes`, `/routes/match`) | short-circuit: `ok: true`, nothing touched (O8) | P2 |
| Apply | public address optional (O21); tracking off, unsubscribe on (Setup A), PII, certificate/https, signing key as today; spam filter and retention "Not needed: replies go to your own mailbox." (ok: null); webhooks only with a public address; routes "Not needed: replies go to your own mailbox." (ok: null). Review DOMAIN-3: on a plan without the certificate (402) the certificate step is ok: null with `APPLY_STEP_TEXTS.certNotInPlan`, the https step ok: null with `httpsNotInPlanOwn`, and without a public address the webhooks step ok: null with `webhooksOptionalOwn`; the card words them "Not in your plan" / "Optional" / "Not needed" in grey (`applyStepStatus`), and the job summary doesn't count them as left to do | P2 |
| Send (transport, client) | From = own From, no Reply-To, Message-ID on the root, path `/v3/polygonparadise.com/messages`; own-mailbox sender check (O6) and the blocked-twice rule (O35); plan-limit guard (O23); inbox-check gate for LIVE follow-ups (O33); "limit" (sends only) and authorized-recipient pauses (O24, O25) | P1 (client call spec: step C) |
| Event webhooks | only with a public address (today's route and checks) | — |
| Inbound webhook | never used by this mode's domain (routes of older domains keep working) | — |
| Catch-up (queue, drift, suppressions, Logs, stored replies) | unchanged except `logRetentionMs` = effective retention (1 day on Free); the `stored` walk finds nothing (harmless) | P5 |
| Outage gap | recorded; `applyOutageHold` holds nobody in own-mailbox mode (O27); the inbox check covers the days after | P5 |
| Reconciler, restore scan | effective retention | P5 |
| Suppressions push/pull, "Remove it" | push and "Remove it" unchanged; no route sync after a Remove in this mode; the pull links new complaint and bounce entries to the email they concern and triggers a health check (O34) | P5 (`suppressions.ts`) |
| Health counting, warm-up | unchanged rules; the cap through `effectiveMaxDailyCap`; own-mailbox warning sentences | P1 (cap), P5 (health) |
| Go-live | own-mailbox rows, ticks, evidence From (O14, O15) | P4 |
| Domain check | own-mailbox facts: the sending domain's MX/TXT/DMARC/SPF names (DNS only), the plan, the mode | P3 |
| Reply test, Send me a test | own-mailbox headers, by-hand verdict, rolling guard | P4 |
| Address checks | unchanged (a refusal on Free is today's error path; the "limit" kind never applies to them, O24) | — |
| Logs, routes, Apply, connect errors | unchanged kinds (the "limit" rule is send-only) | — |
| Simulate reply | refused (O19) | P1 |

---

## 5. Checklist facts and DNS gathering (P3)

- `ChecklistFacts` gains (step C) `ownMailbox?: boolean` (absent = app mode), `plan?: PlanLimits | null` (the plan
  limits in force; absent/null = no plan facts) and `lastGoodMx?: Array<{ priority: number; host: string }> | null` (O10).
  `FromDomainFacts.dns.spfLookups` gains `names?: string[]`. `DomainCheckState` gains `replies?: RepliesMode` (the mode
  the rows were built for; missing = "app", O36) and `lastGoodMx?: Array<{ priority: number; host: string }> | null`.
- `runDomainCheck` writes `replies` with every stored check and, in own-mailbox mode, `lastGoodMx` as §3.3 says; it reads
  the previous state's `lastGoodMx` only when that state's domain and mode are today's.
- Every reader of the stored rows that already ignores another domain's rows also ignores another mode's, through the
  step-C helper `checkMatchesMode(state, replies)` (`src/core/dns/check-state.ts`): `gates.ts:771`, `launch.ts`
  (`launchModeProblems`), `services/reply-test.ts:174,286`, `go-live.ts`, `domain/load.ts:76`, `domain/actions.ts`,
  `dashboard/load.ts`. The Domain checklist page then shows "Not checked yet" rows until the check queued by the switch
  has run.
- `spfLookupReport` (`spf-count.ts`) also returns `names: string[]`: every `include:`/`redirect=` name the walk looked
  up, in order, dangling ones included (it stops once the count passes 10, so a record over 10 may not list all names; it
  is "bad" by its count first). `countSpfLookups` is unchanged.
- `gatherFromDomainFacts(domain, lookups)` (`dns-facts.ts`) passes `names` through.
- `runDomainCheck` (`domain-check.ts`), own-mailbox mode (`team.replies === "own-mailbox"`): `facts.ownMailbox = true`;
  `facts.plan = limits` (`loadPlanLimits()`); `facts.from` is built **for the sending domain whatever the From**:
  `{ address: team.ownFrom ?? team.saved ?? "", domain: d, problem: null, signingDomain, originalSigner,
  originalPasted, dns: gatherFromDomainFacts(d, lookups) }` (the original is today's only when its `domain` = d and its
  `from` = `team.evidenceFrom`); `fromDomainFacts()` keeps today's behaviour in app mode. The rows it notifies about:
  `from-mx` "bad" → `from-mx-bad` with `mxBodyOwn`; no `from-spf-broken` in this mode (the `spf` row is a gate, and
  Live mode and go-live already name it). App mode: unchanged.
- `buildChecklistRows(facts)`: `facts.ownMailbox === true` → the own-mailbox list of §3.3 (`team` facts are never built in
  this mode: `teamOf` is not called, so the dmarc, dkim, postmaster, domain-age and reply-test rows use their per-person
  or own-mailbox branches); a `WEBSITE_DOMAINS` sending domain without `ownMailbox` → today's list with the §2.5 item 7
  guard (O37); otherwise exactly today's list.
- Fake mode (`mailgunRecordsLookup(domain, m, { fromDomain, ownMailbox })`, `dns-lookup.ts`): with `ownMailbox` the
  sending domain answers like a mailbox provider's domain instead of Mailgun's receiving records: MX `10
  mx.mail-provider.invalid`; TXT `v=spf1 include:dc-1._spfm.<d> include:dc-2._spfm.<d> ~all`; `dc-1._spfm.<d>` → `v=spf1
  include:_spf.mail-provider.invalid ~all`; `dc-2._spfm.<d>` → `v=spf1 include:mailgun.org ~all`;
  `_spf.mail-provider.invalid` → `v=spf1 ip4:192.0.2.10 ~all`; `mailgun.org` → `v=spf1 ip4:192.0.2.30 ~all` (4 lookups,
  Mailgun reached through the tree, nothing dangling); `_dmarc.<d>` = `v=DMARC1; p=none` once Mailgun's records are valid
  (today's rule); DKIM, tracking CNAME as today. So the manual checks show spf and from-mx green without real DNS. Fake
  mode can't show from-mx red: a unit render test does (§9.1).

---

## 6. Owner docs (P7)

Real names throughout: polygonparadise.com, contact@polygonparadise.com, Zoho Mail, GoDaddy, US region, Mailgun Free.
Every quoted label comes from §3 or `src/`. Guides 1–4 keep their step numbers (the `guide-refs` test); the new guide is
registered there.

### 6.1 `docs/setup/2-own-mailbox.md` (new; first heading "Own-mailbox guide"; 16 steps)

Intro box "Your setup, and what it gives up": the app sends through polygonparadise.com itself, every email From
contact@polygonparadise.com with each person's name; replies go straight to contact@ (Zoho), never to the app; the list of
§1.2 in plain words (replies, automatic replies, late bounces and unsubscribe-by-email land in Zoho or nowhere; the app
can't stop follow-ups by itself, so live follow-ups wait each day until someone has read contact@; http unsubscribe links
on Free; 100 emails a day; 1 day of logs); the reputation note (SHARED-FROM-DESIGN §2.8's words: everyday email shares the
reputation; Gmail's complaints only in Postmaster Tools).

**Quick path** box right under the intro (a numbered list inside the box; the steps it names are the `## N.` headings):

1. Close the window running `npm run dev` (click in it, press Ctrl+C), then double-click **start.bat** (step 1).
2. Connect Mailgun: US, **From polygonparadise.com itself**, polygonparadise.com, the API key (steps 3–4).
3. Save **contact@polygonparadise.com** as the From address (step 5).
4. Add the `_dmarc` record at GoDaddy (step 6).
5. **Check again**, then **Apply recommended settings** (step 7).
6. Add the test list and switch to **Live (test list only)** (step 9).
7. Run the reply test (step 9).
8. Send the live test to the Test mailboxes companies (step 10).
9. Go live (step 11).

| Step | Content |
|---|---|
| 1 Before you start | Mailgun Free (100 emails a day, 1 day of logs; "Email Validations: Available as add-on"). If Mailgun says free accounts only send to authorized recipients, add a payment card in Mailgun (Account › Billing, it may be called Plan): the Free plan stays free. Never authorize a prospect's address there (Mailgun would email them an invitation). Two test mailboxes: one Outlook.com, one Gmail; never contact@. **Always start the app with start.bat, never `npm run dev`**: close the window running `npm run dev` first (click in it, press Ctrl+C; if start.bat says "Port 3000 is already in use", that window is still open). The first start builds the app for a few minutes. Without the background sender nothing is sent, checked or heard from Mailgun. |
| 2 Keep polygonparadise.com in Mailgun as it is | Send › Domains: polygonparadise.com, US, SPF and DKIM verified; its MX shows "unverified": that's correct, for good. Mailgun's page lists MX records (mxa.mailgun.org, mxb.mailgun.org): never add them to GoDaddy. Never delete the domain (its signature key can't be recovered), leave the sandbox domain alone. If your website or another tool also sends through Mailgun as polygonparadise.com, tell the person who set up the app first: Apply changes that domain's tracking settings. |
| 3 The API key | API Security › create a key with the Developer role; copy it once. |
| 4 Connect | Settings › Sending & Mailgun › Mailgun connection: Region **US**, How the app sends **From polygonparadise.com itself (replies come to your own inbox)**, Sending domain **polygonparadise.com**, the API key, **Save and connect**. What you should see: "Connected to polygonparadise.com (US). Replies go to your own mailbox. Next: type your From address in the From address card below. The app keeps to Mailgun's Free plan (100 emails a day, 1 day of logs). …". If it says "Mailgun can't find polygonparadise.com in the EU region…": choose US. If it says "polygonparadise.com is your own domain…": click **Use From polygonparadise.com itself** under it. If it says "That's Mailgun's sandbox domain…": you pasted the sandbox domain; type polygonparadise.com. |
| 5 Your From address | From address card: `contact@polygonparadise.com` › **Save From address**; the toast of §3.2. Read "Good to know". |
| 6 DNS at GoDaddy: one record | Add **one** TXT record: Name `_dmarc`, Value `v=DMARC1; p=none` (it covers your everyday email too and changes nothing for it). GoDaddy's form may fill Name with `@`: change it to `_dmarc`. **Change nothing else**: never add or change an MX record, never edit the SPF record (`v=spf1 …`) or the `dc-…._spfm` records, `mx._domainkey` (Mailgun's key), `zmail._domainkey` (Zoho's) or `email` (Mailgun's tracking link). This setup never asks you to. Leave out `rua` (reports would arrive in contact@ as attachments). |
| 7 Check and apply | Domain checklist › **Check again** (the background sender must run), then **Apply recommended settings**. What you should see: the rows of §3.3, in particular "Mail for polygonparadise.com stays with your mail provider (MX)" done, "Mailgun may send for polygonparadise.com (SPF)" done ("almost full: 9 of 10" is fine), the DMARC row done once the record has spread (the reply test waits for it). Grey "information" rows you can leave: https links (Free), Mailgun tells the app what happened and Remote access (no Cloudflare yet), Monthly safety limit. |
| 8 Profiles | Everyone: My profile › display name "Arslan from Polygon Paradise"; signature (if it shows an email address, contact@polygonparadise.com); the inbox for test emails (contact@ is allowed; a Gmail address shows tests more reliably). There is no sending address to choose. |
| 9 The test list and the reply test (by hand) | Settings › Sending & Mailgun: the two test mailboxes in **Test list**; **Sending mode › Live (test list only)** › **Save mode** › **Switch to live** (the only mode switch before going live). Domain checklist › Reply test (it starts once the DMARC row is done) › send the test emails; in each mailbox: placement first ("before you move it out of spam"; Gmail's Promotions and Updates tabs count as the inbox), then reply from that mailbox and answer whether the reply arrived in contact@ (Zoho: look in Spam too), then the DMARC question; paste one test email's original (Gmail: ⋮ › Show original › Copy to clipboard; paste; **Read the original**) and what each line means (the return address is on polygonparadise.com: expected; http unsubscribe link: expected on Free); the List-Unsubscribe question; **the unsubscribe-by-email question**: from a test mailbox send an email to the address the app shows (`u+…@polygonparadise.com` or similar), then answer; if it bounced back, turn on a catch-all in Zoho that delivers to contact@ (Zoho Mail Admin Console › **Domains** › polygonparadise.com › **Catch-all Address**, under Advanced Settings; enter contact@polygonparadise.com, **Update**; if your Zoho plan doesn't offer it, stop here and tell the person who set up the app), send it again and change the answer; click the unsubscribe link in one test email; wait until the section shows "Unsubscribe reached the app ✓" (the hourly check, or click **Check with Mailgun now**), then **Settings › Deliverability**, find that test mailbox and click **Remove** (and the same for a mailbox the unsubscribe-by-email step listed); **Save the result**. Write down for the person who set up the app: where an out-of-office reply landed (contact@, nowhere), whether Gmail shows "via". |
| 10 Test companies and a live test | Guide 2 step 14's sub-steps, copied: Contacts › **New list** "Test mailboxes"; per test mailbox **Add company** ("Test – Gmail"; **Country: Pakistan**, so the emails follow your own sending hours, normally Monday to Friday 9:00–17:00; Add to list: Test mailboxes; First person › Email: the test mailbox). Then open the list, tick all, **Email these companies**; Sender shows "Arslan from Polygon Paradise <contact@polygonparadise.com>" and no reply address; any template (with a follow-up if you want to rehearse, Going-live guide step 3); **Launch campaign**. What you should see: "Sent by Arslan as Arslan from Polygon Paradise <contact@polygonparadise.com>", then Delivered within the hour. Replies from the test mailboxes arrive in contact@, not in the app: practise **They replied** on one test company (its status stays as it is before going live; its follow-ups show "Stopped: they replied"), and **I've read contact@polygonparadise.com** on the Notifications page (the other test company's follow-up waits for it). |
| 11 Going live | When the live test says delivered: Settings › Sending & Mailgun › **Go live**: read the dialog (on Free the warm-up line ends at 90 a day), tick "I read contact@polygonparadise.com every working day, its inbox and its Spam folder…" and, on Free, "I know unsubscribe links use http…" (and the spam box if the reply test's email landed in spam). The card's recommendations include checking in Mailgun that your account can email anyone. |
| 12 Every working day | Read contact@, its inbox and its **Spam** folder. A reply to a campaign: open the company (search Contacts by the address it came from) › **They replied** (it stops every follow-up to that company). "Please remove me", an unsubscribe email, or a "couldn't be delivered" notice: that person's ⋯ › **Mark unsubscribed** (or the company's status **Do not contact**). An out-of-office: nothing to do. Then **Notifications › Inbox check › I've read contact@polygonparadise.com**: live follow-ups wait for that click each day (the dashboard and the bell say when they are waiting). Anyone who reads contact@ may click it; the Activity page shows who did. Emails sent by the app are not in Zoho's Sent folder; the company's timeline has them. |
| 13 The Free plan's limits | At most 90 campaign emails a day (10 are kept for test emails), and never more than 100 emails in any 24 hours: the rest wait ("Waiting: your Mailgun plan's daily limit is used up…"). Logs are kept 1 day: keep the office PC on, with start.bat running, on working days, and over the weekend if you can. If the PC was off longer, the app can't read what Mailgun saw then; unsubscribes, complaints and bounces still come back through Mailgun's lists and still count toward the automatic pause. |
| 14 Optional: Google Postmaster Tools and your domain's age | Guide 2 step 16's two sub-steps for polygonparadise.com (add it at postmaster.google.com; Domain checklist › Domain age, 2024-08-22). |
| 15 Switching to the full setup later | §2.7's way back, step by step (Foundation; mail.polygonparadise.com in US; Pause all sending; cancel or finish test and live campaigns; How the app sends **Through a sending subdomain**; Sending domain mail.polygonparadise.com; plan Foundation; then the Mailgun guide from step 7). What changes: replies come back through the app and stop follow-ups by themselves; no daily inbox check; https links; 5 days of logs. |
| 16 Troubleshooting | "Mail for polygonparadise.com stays with your mail provider (MX)" red / "Live emails are waiting: mail for your main domain points to Mailgun…" → the row's fix names the records to put back; at GoDaddy delete the MX records of `@` that point to Mailgun (or switch Cloudflare Email Routing off) and put Zoho's back (`mx.zoho.com` 10, `mx2.zoho.com` 20, `mx3.zoho.com` 50), never Mailgun's; Check again. "Mailgun may send for polygonparadise.com (SPF)" red → don't edit it yourself; ask the person who set up the app. "Waiting for today's inbox check" → step 12. The reply test says "Emails to u+…@polygonparadise.com don't reach anyone" → step 9's Zoho catch-all. "Paused: Mailgun's sending limit for your plan is reached" → Resume the next day. "Paused: Mailgun sends only to authorized recipients" → step 1. Nothing is sent or checked → start.bat (not `npm run dev`). "Port 3000 is already in use" → close the `npm run dev` window. A reply doesn't stop the follow-ups → They replied (the app never sees replies). "Send me a test" to contact@ didn't arrive → look in spam, or use a Gmail address as your test inbox. |

**Tidy up (optional)** box at the end: open `.env` in the app folder; if a line starts with `MAILGUN_`, delete that line
(the app never reads it; keys live encrypted in Settings); change nothing else in `.env`.

The guide never shows a Mailgun MX record or any SPF value to add (§0.2 rule 7); the only MX values it names are Zoho's,
for putting them back (step 16). It never cites a question number of this design (the docs test forbids `Q8`–`Q14`) and
never shows "npm run dev" as a way to start the app.

### 6.2 README.md

- "Start here": step 2 becomes two choices, as plain paragraphs or bullets (no new `###` heading: `readme-topics.test.ts`
  pins exactly four level-3 headings there): "**Your setup:** the [Own-mailbox guide](docs/setup/2-own-mailbox.md): the
  app sends through polygonparadise.com and replies come to contact@polygonparadise.com, on Mailgun's Free plan. The
  [Mailgun guide](docs/setup/2-mailgun-and-dns.md) is the full setup (Mailgun Foundation, replies through the app)." The
  four existing guide links keep their order (the test finds each one's first link after "## Start here"). The Cloudflare
  guide line gains "(optional in the own-mailbox setup)". The start line says: "Close any window running `npm run dev`
  first; the first start builds for a few minutes."
- "Mailgun, DNS and reply routes": a first paragraph for the own-mailbox setup (one Mailgun domain = polygonparadise.com,
  no routes, no sending address, never Mailgun's MX, only `_dmarc`).
- "Replies": a first bullet for the own-mailbox setup: "**In your setup replies don't reach the app at all.** They land in
  contact@polygonparadise.com (look in its Spam folder too). When someone answers, open the company and click **They
  replied**: it stops every follow-up. For "please remove me" or a "couldn't be delivered" notice, click ⋯ › **Mark
  unsubscribed** on that person. Then click **I've read contact@polygonparadise.com** on the Notifications page: live
  follow-ups wait for that each day." The existing shared-From bullet stays and names They replied too. A note for the
  practice copy: "In the practice copy (start-demo.bat) simulated replies stop follow-ups by themselves; in your real
  setup they don't: practise They replied there too."
- "Sending safely": the Free plan's limits (§6.1 step 13) and "Always start the app with start.bat".
- "What it costs": Mailgun Free ($0) for the own-mailbox setup; Foundation for the full setup.
- Glossary: **They replied**, **Inbox check**, **How the app sends**, **Your Mailgun plan**.
- Troubleshooting: the step-16 entries in one line each, pointing at the guide.
- The quoted "Reply route: Being set up…" and every existing pinned quote stay.

### 6.3 Guides 2, 3 and 4

- Guide 2 (`2-mailgun-and-dns.md`): a box under the first heading: "Using polygonparadise.com itself on Mailgun's Free
  plan, with replies in contact@? Follow the [Own-mailbox guide](2-own-mailbox.md) instead." Step 6: the "How the app
  sends" choice (**Through a sending subdomain**) and the new `SENDING_DOMAIN_TEXTS.website` quote (line 114 is already
  updated in step C; P7 keeps it); the plan select (Foundation). Steps stay 19.
- Guide 3 (`3-cloudflare.md`): the intro says it's optional in the own-mailbox setup (without it the app works on the
  office network and Mailgun's reports arrive hourly); option (b)'s record list stays (it matters more now), and one
  sentence: "In the own-mailbox setup, never switch on Cloudflare Email Routing for polygonparadise.com: your mail would
  stop reaching Zoho."
- Guide 4 (`4-going-live.md`): step 1 gains "In the own-mailbox setup: How the app sends = From polygonparadise.com
  itself, Your Mailgun plan = Free"; step 2 gains an **un-numbered** sentence after the pinned list: "In the own-mailbox
  setup the list is shorter: {the titles, in order, of `goLiveRowKeys(false, { ownMailbox: true, publicAddress: false })`,
  each as `checklistTitle(key, "polygonparadise.com")` returns it, i.e. the titles the Domain checklist shows for
  polygonparadise.com}." and "the reply test passed by hand", and "On Mailgun's Free plan the warm-up line in the dialog
  ends at 90 a day instead of 1,000." (the pinned "…to 1,000 in about 4 weeks" item stays); step 3 (rehearsal) gains the
  own-mailbox rehearsal: "reply from a test mailbox; see it arrive in contact@; click They replied on that company (its
  status stays as it is before going live); check that its follow-up shows Stopped: they replied; the other test
  mailbox's follow-up waits for today's inbox check until you click I've read contact@polygonparadise.com"; step 8
  quotes the two ticks; step 13 names the switch (O2). Steps stay 13.

### 6.4 SPEC.md, PLAN.md, docs/dev/README.md

SPEC lines 21, 30, 58 (next to the 2026-09-27 note) and the "Replies" chapter (185–216) get: "Owner decision 2026-09-27
(final): the app sends through polygonparadise.com itself on Mailgun's Free plan; every email From
contact@polygonparadise.com with each sender's display name, no Reply-To; replies go straight to contact@ and are marked
in the app by hand (They replied); live follow-ups wait each day until someone has read contact@ (the inbox check). The
reply detection of this chapter applies only when replies go through the app (MAIN-DOMAIN-DESIGN.md)." PLAN.md: one
header note naming this design. `docs/dev/README.md`: one line naming this design and the code map.

### 6.5 Docs tests P7 keeps green and extends

- `tests/unit/docs/markdown.ts`: `OWNER_DOCS` lists files by name; add `"docs/setup/2-own-mailbox.md"`. That subjects the
  new guide to every owner-doc rule: "Settings › …" must name a real settings page (`labels.test.ts:65`), no build-history
  words or builder's voice, no `Q8`–`Q14`, relative links that resolve.
- `tests/unit/docs/guide-refs.test.ts`: `GUIDES["Own-mailbox"] = { file: "2-own-mailbox.md", h1: "Own-mailbox guide" }`,
  `STEP_COUNTS["2-own-mailbox.md"] = 16`, `TITLE_STEP` gains `Own-mailbox`.
- `tests/unit/docs/labels.test.ts`: new quotes (`OWN_MAILBOX_TEXTS.repliesOwnLabel`, `.repliesLegend`, `.websiteSwitch`,
  `PLAN_TEXTS.planLabel`, `THEY_REPLIED_TEXTS.button`, `INBOX_CHECK_TEXTS.button("contact@polygonparadise.com")`,
  `checklistTitle("from-mx", "polygonparadise.com")`, `checklistTitle("spf", "polygonparadise.com")`,
  `GO_LIVE_COPY.ownMailboxTick("contact@polygonparadise.com")`, `SENDING_DOMAIN_TEXTS.website` (guide 2 step 6), the
  own-mailbox go-live row titles in guide 4 as described in §6.3); the existing pins stay (`GO_LIVE_ROW_KEYS` list,
  "…to 1,000 in about 4 weeks", the from-mx title rules at `labels.test.ts:310-343`).
- `readme-topics` (four `###` under Start here, the four guide links in order), `no-milestone`, `m5-texts` green.

---

## 7. Settings, state and contracts (step C)

### 7.1 Settings (`SETTING_DEFAULTS`, JSON rows, no settings migration)

| Key | Default | Written by | Read by |
|---|---|---|---|
| `mailgun.replies` | `"app"` (`RepliesMode`) | only `saveConnection` (P2) | `loadTeamFrom()`, `loadPlanLimits()`, `getMailgunContext()`, each through `repliesOf()` |
| `mailgun.plan` | `null` (`MailgunPlan \| null`) | `saveRetentionAction` (P2), with the retention numbers and its activity, in one transaction (`setSettingIn`); and `saveConnection` (P2) once, on an own-mailbox connect while it is null, with the retention numbers 1/1 and the same activity (O22) | `loadPlanLimits()` (every reader) |
| `mailgun.unsubscribeTest` | existing; + optional `replies?: "own-mailbox"`, `mailtoArrived?: boolean \| null`; `original.unsubscribeScheme?`, `original.mailtoAddress?` | `decideReplyTest` writes `replies`; `saveReplyTestAnswers` writes `mailtoArrived`; `saveReplyTestOriginal` writes the scheme and the address; resets (and a newly stored original) clear `mailtoArrived` | `replyTestPassedFor`, the verdict, the original's lines |
| `mailgun.fromAddress` | existing | `saveFromAddress` (validation through `validateFromAddressFor`) | `loadTeamFrom()` |

`SettingValue`: `"mailgun.replies"` → `RepliesMode`; `"mailgun.plan"` → `MailgunPlan | null`. Comments name this design.

### 7.2 Types and SystemState

- `src/core/setting-types.ts`: `UnsubscribeTestSetting.replies?: "own-mailbox"` ("the decision belongs to own-mailbox
  mode; missing = app mode (MAIN-DOMAIN-DESIGN O13)"); `UnsubscribeTestSetting.mailtoArrived?: boolean | null` ("own-mailbox
  mode: did an email to the original's mailto: address reach a mailbox someone reads (O13); null/missing = not answered");
  `ReplyTestOriginal.unsubscribeScheme?: "https" | "http" | null` ("the scheme of List-Unsubscribe's web link; null =
  none; missing = read before this field existed"); `ReplyTestOriginal.mailtoAddress?: string | null` ("the whole
  mailto: address of List-Unsubscribe, for the by-hand question; null = none"). `DEFAULT_UNSUBSCRIBE_TEST` unchanged.
- `src/core/system-state.ts`: `WaitReason` += `"plan-limit"` ("TEST/LIVE rows held: the Mailgun plan's daily limit is used
  up in the last 24 hours (MAIN-DOMAIN-DESIGN O23)") and `"inbox-check"` ("LIVE follow-ups held in own-mailbox mode until
  someone has read the own mailbox today after the person's last email (MAIN-DOMAIN-DESIGN O33)"); `STATE_KEYS.inboxCheck
  = "sending.inboxCheck"` with `InboxCheckState = { at: string | null; byUserId: number | null }` (default both null);
  `DomainCheckState` += `replies?: RepliesMode`, `lastGoodMx?: Array<{ priority: number; host: string }> | null` (O10,
  O36). No new `ChecklistRowKey`, no new PauseKind.
- `src/core/system-state-parse.ts`: the wait-reason list += `"plan-limit"`, `"inbox-check"`; `parseInboxCheckState` (an ISO
  date string or null; a positive integer or null; anything else → the default); `parseDomainCheckState` keeps `replies`
  only when exactly `"own-mailbox"` or `"app"` and `lastGoodMx` only as an array of at most 10 `{ priority: integer 0–65535,
  host: a host name }` (else drops it); `parseUnsubscribeTest` keeps `replies` when it is exactly `"own-mailbox"`,
  `mailtoArrived` when boolean or null, `original.unsubscribeScheme` when it is `"https"`, `"http"` or null and
  `original.mailtoAddress` when a string of at most 254 characters containing one `@`, or null; drops them otherwise.
- `src/core/dns/check-state.ts` (new, pure): `checkMatchesMode(state: Pick<DomainCheckState, "replies">, replies:
  RepliesMode): boolean` = `repliesOf(state.replies) === replies` (O36).
- `src/core/notification-types.ts`: `REPLY_NOTIFICATION.inboxCheck = "reply.inboxCheck"` and it joins
  `POPUP_GROUP_TYPES.reply` (O33).
- `src/components/campaigns/format.ts`: `waitingText` case `"plan-limit"` → "Waiting: your Mailgun plan's daily limit is
  used up. The next email can go at {time}." (`{time}` as the other `until` cases; without `until`: "Waiting: your Mailgun
  plan's daily limit is used up."); case `"inbox-check"` → "Waiting for today's inbox check (Notifications › Inbox
  check)."

### 7.3 Prisma

No schema change and no migration (O31).

### 7.4 New contract files (the lead writes them in step C)

**`src/core/sending/own-mailbox.ts`** (new, pure, browser-safe):

```ts
import { parseEmail } from "@/core/email-address";
import { ROUTE_CHECK_LOCAL_PREFIX } from "@/core/mailgun/routes";
import {
  TEAM_FROM_REFUSED_LOCAL_PARTS,
  TEAM_FROM_TEXTS,
  formatFromHeader,
  validateTeamFromAddress,
  type TeamFromResult,
} from "@/core/sending/from-address";

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O1–O6): the app sends through the domain of the Owner's own mailbox
 * (polygonparadise.com), every email From the own From with each sender's display name and no Reply-To; replies land in
 * that mailbox only. One flag, Setting "mailgun.replies"; absent or anything else = app mode (per-person or shared-From),
 * exactly as before. Pure and browser-safe (the connection card and the From card check as you type).
 */

export type RepliesMode = "app" | "own-mailbox";

/** Setting "mailgun.replies" → the mode; anything but exactly "own-mailbox" is "app" (fail closed, O1). */
export function repliesOf(v: unknown): RepliesMode {
  return v === "own-mailbox" ? "own-mailbox" : "app";
}

/**
 * What the sender checks compare an own-mailbox email with (O6): null in app mode (today's rules), the own From in
 * own-mailbox mode, or "" when own-mailbox mode has no fitting From yet (then every email is refused).
 */
export function ownMailboxRuleFrom(replies: RepliesMode, ownFrom: string | null): string | null {
  return replies === "own-mailbox" ? (ownFrom ?? "").trim().toLowerCase() : null;
}

/** The From line of an own-mailbox email (§2.3). Never a Reply-To. */
export function ownMailboxHeaders(i: { displayName: string; from: string }): { from: string; replyTo: null } {
  return { from: formatFromHeader(i.displayName, i.from.trim().toLowerCase()), replyTo: null };
}

function cleanHost(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/** Setting "mailgun.fromAddress" in own-mailbox mode (§2.2): exactly on the sending domain. Empty → null (allowed). */
export function validateOwnMailboxFrom(input: string | null | undefined, sendingDomain: string | null | undefined): TeamFromResult {
  const v = (input ?? "").trim().replace(/^mailto:/i, "").trim();
  if (!v) return { ok: true, address: null };
  const d = cleanHost(sendingDomain);
  if (!d) return { ok: false, error: TEAM_FROM_TEXTS.notConnected };
  const example = `contact@${d}`;
  const parsed = parseEmail(v);
  if (!parsed || parsed.displayName || /[\s<>",;()]/.test(v) || parsed.email.toLowerCase() !== v.toLowerCase()) {
    return { ok: false, error: TEAM_FROM_TEXTS.invalid(example) };
  }
  const address = parsed.email.toLowerCase();
  if (parsed.domain.toLowerCase() !== d) return { ok: false, error: OWN_MAILBOX_TEXTS.fromWrongDomain(d) };
  const local = address.slice(0, address.lastIndexOf("@"));
  if (TEAM_FROM_REFUSED_LOCAL_PARTS.has(local) || local.startsWith(ROUTE_CHECK_LOCAL_PREFIX)) {
    return { ok: false, error: TEAM_FROM_TEXTS.reserved(local, example) };
  }
  return { ok: true, address };
}

/** The one dispatch (§2.2): today's shared-From rules in app mode, the own-mailbox rules otherwise. */
export function validateFromAddressFor(input: string | null | undefined, sendingDomain: string | null | undefined, replies: RepliesMode): TeamFromResult {
  return replies === "own-mailbox" ? validateOwnMailboxFrom(input, sendingDomain) : validateTeamFromAddress(input, sendingDomain);
}

/** O10: the sentence every red own-mailbox MX fix ends with (the P3 safety test requires it and allows Mailgun hosts only inside it). */
export const NEVER_MAILGUN_MX_TEXT = (d: string): string => `Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to ${d}.`;

/** Every own-mailbox sentence of §3 that isn't a checklist row's status text (rows live in checklist.ts). */
export const OWN_MAILBOX_TEXTS = {
  // Mailgun connection card (§3.1)
  repliesLegend: "How the app sends",
  repliesAppLabel: "Through a sending subdomain (replies come through the app)",
  repliesAppHint:
    "For example mail.polygonparadise.com. Replies are recorded, stop follow-ups by themselves and are forwarded to your inbox. Needs Mailgun's Foundation plan (Mailgun guide).",
  repliesOwnLabel: "From polygonparadise.com itself (replies come to your own inbox)",
  repliesOwnHint:
    "Every email comes from your own address, such as contact@polygonparadise.com. Replies land in that inbox, and you mark them in the app with They replied. Works on Mailgun's Free plan (Own-mailbox guide).",
  websiteSwitch: "Use From polygonparadise.com itself",
  switchNote: "Changing this is like changing the sending domain: going live ends and the reply test starts again.",
  domainHint: "Your own domain, exactly as Mailgun shows it, for example polygonparadise.com.",
  domainPlaceholder: "polygonparadise.com",
  statusSuffix: " · replies go to your own mailbox",
  connectedNext: "Replies go to your own mailbox. Next: type your From address in the From address card below.",
  connectedMode: "Replies go to your own mailbox.",
  planSetFree: " The app keeps to Mailgun's Free plan (100 emails a day, 1 day of logs). If you upgrade, choose the plan under Advanced.",
  domainMisfit: (from: string, d: string): string => `Your From address ${from} isn't on ${d}. Clear it in the From address card first, then connect again.`,
  switchedSummary: (actorName: string, d: string, to: RepliesMode): string =>
    to === "own-mailbox" ? `${actorName} switched replies for ${d} to your own mailbox` : `${actorName} switched replies for ${d} to go through the app`,
  // From address card (§3.2)
  cardDescription: "The address every campaign email comes from. Replies go straight to this mailbox.",
  fieldLabel: "From address",
  hint: (displayName: string, shown: string, d: string): string =>
    `People see "${displayName} <${shown}>": each person's display name with this address. Replies go straight to this mailbox, not through the app. It must end in @${d}.`,
  missingHere: (d: string): string => `Type the address your emails come from, for example contact@${d}. Test and live campaigns can't start without it.`,
  misfitHere: (saved: string, d: string): string =>
    `The saved From address ${saved} isn't on your sending domain ${d}, so test and live campaigns can't start. Change it below.`,
  goodToKnow: (from: string, d: string): string[] => [
    `Replies come only to ${from}, never to the app, and follow-ups don't stop by themselves. Read ${from} every working day, its inbox and its Spam folder; when someone answered, open the company and click They replied: that stops every follow-up to it. Then click I've read ${from} on the Notifications page: live follow-ups wait for that each day.`,
    `If someone asks to be removed, or ${from} gets a "couldn't be delivered" notice about a campaign email, open the company and click ⋯ › Mark unsubscribed on that person (or set the company to Do not contact).`,
    "Automatic replies (out of office) and bounces that come later go to your mail provider too, or nowhere if it has no catch-all address. The app doesn't see them.",
    "The unsubscribe link in each email reaches the app. Some mail programs unsubscribe by sending an email instead: the reply test checks that those emails reach a mailbox you read. Handle them with Mark unsubscribed.",
    `Emails the app sends don't appear in the Sent folder of ${from}. The company's timeline has them.`,
    `Never add Mailgun's MX records to ${d} and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving.`,
  ],
  savedOn: (from: string): string =>
    `From now on, campaign emails show From ${from}. Replies go straight to that mailbox (look in its Spam folder too): when someone answers, click They replied on their company. Run the reply test before live campaigns (Settings › Domain checklist).`,
  savedOff: (d: string): string => `The From address is cleared. Test and live campaigns can't start until you type an address on ${d}.`,
  clearedSummary: (actorName: string): string => `${actorName} cleared the From address`,
  // loadTeamFrom problems (§2.2)
  fromMissing: (d: string): string =>
    `Type the address your emails come from in Settings › Sending & Mailgun › From address, for example contact@${d}. Test and live campaigns can't start without it.`,
  misfit: (saved: string, d: string): string => `The From address ${saved} isn't on your sending domain ${d}. Change it in Settings › Sending & Mailgun.`,
  fromWrongDomain: (d: string): string => `The From address must end in @${d}, your sending domain.`,
  // Elsewhere
  checklistLine: (from: string | null, d: string): string =>
    from
      ? `Emails show From ${from} and go out through ${d} itself. Replies go straight to that mailbox.`
      : `Emails go out through ${d} itself. Type your From address in Settings › Sending & Mailgun.`,
  followUpReminder: (from: string): string =>
    `Replies come straight to ${from}, not to the app. Each day, read ${from} and its Spam folder, click They replied on every company that answered, then click I've read ${from} on the Notifications page: live follow-ups wait for that.`,
  openInboxCheck: "Open the inbox check",
  noSendingAddress: (from: string): string => `Nobody needs an address of their own: every email comes from ${from} with each person's display name.`,
  simulateReply: (from: string): string => `In your setup replies go to ${from}, not through the app. Use They replied on the company instead.`,
  repliesEmpty: (from: string): string => `Replies go straight to ${from}, not to the app. When someone answers, click They replied on their company.`,
  setupAOnly: "Your setup always uses Setup A.",
  setupNotNormal: "The reply test is set to a check-only setup. Click Back to normal in the Reply test section.",
  backToNormal: "Back to normal",
  applyHint:
    "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers and asks Mailgun for secure unsubscribe links. With remote access it also sets the webhooks. It changes nothing about receiving mail: mail for polygonparadise.com stays with your mail provider.",
  applyNoPublicAddress:
    "No public address yet: Mailgun's reports come through the app's hourly check instead. Remote access is optional in your setup (Cloudflare guide).",
  applyNotNeeded: "Not needed: replies go to your own mailbox.",
  // Domain checklist fixes (§3.3, §2.5; checklist.ts builds the rows with these)
  mailgunDomainFix: (d: string): string =>
    `Check the SPF, DKIM and tracking rows below, then click Check again in a few minutes. Mailgun's page for ${d} also lists MX records: leave them out. ${NEVER_MAILGUN_MX_TEXT(d)}`,
  putBackMx: (lastGood: ReadonlyArray<{ priority: number; host: string }> | null | undefined): string =>
    lastGood && lastGood.length > 0
      ? `put back your mail provider's MX records: ${[...lastGood].sort((a, b) => a.priority - b.priority).map((m) => `${m.host} (priority ${m.priority})`).join(", ")}`
      : "put back your mail provider's MX records (its help pages list them)",
  websiteInAppMode: (d: string): string => `${d} is your own domain, and its mail must stay with your mail provider.`,
  websiteInAppModeFix: "Open Settings › Sending & Mailgun and connect again with How the app sends = From polygonparadise.com itself.",
  // Sending (O35)
  senderBlocked: "This email didn't fit your From address, so sending paused once.",
  senderBlockedTwice: "Didn't send: this email doesn't fit your From address any more. Start a new campaign to email this person again.",
  profileFromLine: (displayName: string, from: string): string => `Your emails show "${displayName} <${from}>". Replies go straight to ${from}.`,
  profileFromMissing: "Your emails will show your display name with the From address the Owner sets in Settings › Sending & Mailgun.",
  testInboxLabel: "Inbox for your test emails",
  testInboxHint: (from: string): string => `Send me a test sends your test emails here. Replies to your campaigns go to ${from}.`,
  signatureHint: (from: string): string => ` If your signature shows an email address, use ${from}.`,
  switchOff: (name: string, from: string): string => `Replies to ${name}'s campaigns go to ${from}, as before.`,
  limitsColumn: "Emails show",
  senderStepInfo: (from: string): string =>
    `Display names and signatures are set in Settings › My profile. The From address (${from}) is set by the Owner in Settings › Sending & Mailgun. The Owner sets each teammate's own daily limit in Settings › Limits & warm-up.`,
  healthBounceNote: (from: string): string => ` Bounces that arrive later go to ${from}, not the app, so the real number can be higher.`,
} as const;

/** The daily inbox check (O33, §2.9, §3.9). */
export const INBOX_CHECK_TEXTS = {
  title: "Today's inbox check",
  intro: (from: string): string =>
    `Replies to your campaigns come only to ${from}. Before live follow-ups go, read its inbox and its Spam folder. For every answer, open the company and click They replied (search Contacts for the address it came from). Then click the button below: live follow-ups wait for it each day.`,
  waitingHeading: "Follow-ups due in the next 24 hours:",
  more: (n: number): string => `and ${n.toLocaleString("en-US")} more`,
  last: (when: string, name: string): string => `Last read ${when} by ${name}.`,
  notToday: "Nobody has read it today.",
  button: (from: string): string => `I've read ${from}`,
  done: "Thanks. Live follow-ups due today can go now.",
  notOwnMailbox: "Replies come through the app in your setup, so there's nothing to check by hand.",
  item: (count: number, from: string): string =>
    `${count === 1 ? "1 follow-up waits" : `${count.toLocaleString("en-US")} follow-ups wait`} for today's check of ${from}. Whoever reads it: read its inbox and Spam folder, click They replied on every company that answered, then click I've read ${from}.`,
  itemLink: "Open the inbox check",
  notificationTitle: "Follow-ups wait for today's inbox check",
  notificationBody: (from: string): string => `Read ${from} (inbox and Spam), click They replied where someone answered, then click I've read ${from}.`,
  activity: (actorName: string, from: string): string => `${actorName} read ${from} (inbox and Spam)`,
} as const;

/** "They replied" (§3.8). */
export const THEY_REPLIED_TEXTS = {
  button: "They replied",
  ariaLabel: "Mark as replied: stops every follow-up to this company",
  confirmTitleCompany: (company: string): string => `Mark ${company} as replied?`,
  confirmTitlePerson: (person: string): string => `Mark ${person} as replied?`,
  bodyStatusChanges: (company: string): string => `Every follow-up to ${company} stops, in every campaign, and its status becomes Replied.`,
  bodyStatusStays: (company: string): string => `Every follow-up to ${company} stops, in every campaign.`,
  bodyTestOnly: (company: string): string =>
    `Every follow-up to ${company} stops, in every campaign. Its status stays as it is, because it has only had test emails so far.`,
  bodyPerson: (person: string): string => `${person} is noted as the one who replied.`,
  confirm: "Mark as replied",
  cancel: "Cancel",
  toast: (stopped: number): string =>
    stopped > 0
      ? `Marked as replied. Follow-ups to ${stopped.toLocaleString("en-US")} ${stopped === 1 ? "person" : "people"} stopped.`
      : "Marked as replied. No follow-ups were waiting.",
  doNotContact: "This company is marked Do not contact: nothing is sent to it anyway.",
  personGone: "That person isn't at this company any more. Refresh the page.",
  activity: (actorName: string, company: string, person: string | null): string =>
    person ? `${actorName} marked ${person} (${company}) as replied` : `${actorName} marked ${company} as replied`,
} as const;

/** The by-hand reply test (§3.5). */
export const OWN_REPLY_TEST_TEXTS = {
  intro: (from: string): string => `Send the test emails: one to each mailbox on your test list, from ${from}. Replies come straight to ${from}, not to the app.`,
  logsNote:
    "The app hears from Mailgun about deliveries and unsubscribes within the hour while the background sender runs. To check sooner, click Check with Mailgun now in Settings › Sending & Mailgun.",
  replyQuestion: (from: string): string => `Reply to the test email from this mailbox. Did your reply arrive in ${from}? Look in its Spam folder too.`,
  replyUnanswered: (address: string, from: string): string => `${address}: answer whether your reply arrived in ${from}.`,
  replyFailed: (address: string, from: string): string =>
    `${address}: your reply didn't arrive in ${from}. Check the Spam folder and the filters of ${from}, then change the answer.`,
  returnPathFailed: (rp: string, d: string): string => `The test email's return address is on ${rp}, not on ${d}. Tell the person who set up the app.`,
  headersFailed:
    "The test email has no List-Unsubscribe header. Click Apply recommended settings and send the test emails again; if it stays that way, ask the person who set up the app.",
  mailtoNote: "It may also show a mailto: address: that's expected. The next question checks where emails to it arrive.",
  // The unsubscribe-by-email question (O13), asked while the stored original has a mailtoAddress
  mailtoQuestion: (mailto: string, from: string): string =>
    `From one of your test mailboxes, send an email to ${mailto} (any subject and text). Within the hour, did it arrive in ${from} or another mailbox you read (look in Spam too), or does Settings › Deliverability now list that test mailbox?`,
  mailtoAfter: "If Settings › Deliverability lists the test mailbox now, click Remove there so the live test can reach it.",
  mailtoUnanswered: "Answer whether the email to the unsubscribe address arrived.",
  mailtoFailed: (mailto: string, d: string, from: string): string =>
    `Emails to ${mailto} don't reach anyone, so people who unsubscribe by email (a button some mail programs show) would never be removed. In your mail provider's admin settings for ${d}, turn on a catch-all address that delivers to ${from} (Zoho Mail: Admin Console › Domains › ${d} › Catch-all Address, under Advanced Settings), send the email again and change the answer. If your mail provider can't do that, tell the person who set up the app.`,
  sectionFailed: (from: string): string => `The reply test didn't pass with the From address ${from}. The lines above say which check failed.`,
  passedRow: (when: string, from: string): string =>
    `The reply test passed${when} with the From address ${from}: test emails arrived, your replies reached ${from}, unsubscribing works, and the test email passed DMARC.`,
  failedRow: (from: string): string => `The reply test didn't pass with the From address ${from}.`,
  failedRowFix: "The reply test section says which check failed.",
  noFromRow: "Type your From address in Settings › Sending & Mailgun first.",
  // Pasted original lines (testOriginalTexts with ownMailbox)
  returnPathOwn: (rp: string): string =>
    `Return address: …@${rp}. Bounces that come later and automatic replies go to your own mailbox (or nowhere), not the app.`,
  returnPathElsewhere: (rp: string, d: string): string => `Return address: …@${rp}, not on ${d}. Tell the person who set up the app.`,
  linkHttps: "Unsubscribe link: https ✓",
  linkHttp: "Unsubscribe link: http. It works when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https (Mailgun's Foundation plan).",
  linkNone: "The original shows no unsubscribe link in its headers.",
  mailtoOwn: (mailto: string): string => `Unsubscribe by email goes to ${mailto}. The question below checks that it reaches a mailbox you read.`,
  mailtoNone: "Unsubscribe by email: not offered.",
} as const;
```

**`src/core/mailgun/plan.ts`** (new, pure, browser-safe):

```ts
import type { RepliesMode } from "@/core/sending/own-mailbox";

/**
 * The Mailgun plan the Owner chose (Setting "mailgun.plan", MAIN-DOMAIN-DESIGN O22–O26) and what the app keeps to:
 * https://www.mailgun.com/pricing/ as read on 2026-09-28. Pure and browser-safe.
 */

export type MailgunPlan = "free" | "basic" | "foundation" | "scale";
export const MAILGUN_PLANS: readonly MailgunPlan[] = ["free", "basic", "foundation", "scale"];

export type PlanFacts = { label: string; dailyLimit: number | null; logDays: number; messageDays: number };

export const MAILGUN_PLAN_FACTS: Readonly<Record<MailgunPlan, PlanFacts>> = {
  free: { label: "Free (100 emails a day)", dailyLimit: 100, logDays: 1, messageDays: 1 },
  basic: { label: "Basic", dailyLimit: null, logDays: 1, messageDays: 1 },
  foundation: { label: "Foundation", dailyLimit: null, logDays: 5, messageDays: 1 },
  scale: { label: "Scale or higher", dailyLimit: null, logDays: 30, messageDays: 7 },
};

/** Setting "mailgun.plan" → a plan, or null (not chosen, or unreadable). */
export function planOf(v: unknown): MailgunPlan | null {
  return typeof v === "string" && (MAILGUN_PLANS as readonly string[]).includes(v) ? (v as MailgunPlan) : null;
}

export type PlanLimits = PlanFacts & { plan: MailgunPlan; assumed: boolean };

/** The limits in force (O22): the chosen plan's; none chosen → Free's in own-mailbox mode (assumed), null in app mode. */
export function planLimits(plan: MailgunPlan | null, replies: RepliesMode): PlanLimits | null {
  if (plan) return { ...MAILGUN_PLAN_FACTS[plan], plan, assumed: false };
  if (replies === "own-mailbox") return { ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: true };
  return null;
}

/** Emails a day kept for "Send me a test" and the reply test on a plan with a daily limit (O23). */
export const PLAN_TEST_RESERVE = 10;

function wholeDays(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(max, n) : fallback;
}

/** Days of Mailgun logs the app may count on (O26): the saved number, never more than the plan keeps. */
export function effectiveLogRetentionDays(saved: unknown, limits: PlanLimits | null): number {
  const days = wholeDays(saved, 1, 30, 5);
  return limits ? Math.min(days, limits.logDays) : days;
}

/** The maximum daily limit the warm-up and today's cap use (O23): Setting "sending.maxDailyCap", never above the plan's limit minus the reserve. */
export function effectiveMaxDailyCap(maxDailyCap: unknown, limits: PlanLimits | null): number {
  const max = Math.max(0, Math.floor(Number(maxDailyCap) || 0));
  if (!limits || limits.dailyLimit === null) return max;
  return Math.max(0, Math.min(max, limits.dailyLimit - PLAN_TEST_RESERVE));
}

/** Room left in the rolling 24 hours (O23): for campaign emails (keeping the reserve) and for tests; null = no daily limit. */
export function planRoom(limits: PlanLimits | null, usedLast24h: number): { campaign: number; tests: number } | null {
  if (!limits || limits.dailyLimit === null) return null;
  const used = Math.max(0, Math.floor(usedLast24h));
  return { campaign: Math.max(0, limits.dailyLimit - PLAN_TEST_RESERVE - used), tests: Math.max(0, limits.dailyLimit - used) };
}

export const PLAN_TEXTS = {
  planLabel: "Your Mailgun plan",
  planNotSure: "Not sure",
  planHint: "The app keeps to your plan's daily limit and log retention. Mailgun shows your plan under Account › Plan (it may be called Billing).",
  assumedFree: "Not chosen yet: the app keeps to the Free plan's limits (100 emails a day, 1 day of logs).",
  retentionHint:
    "Mailgun's plans keep event logs for 1 day (Free, Basic), 5 days (Foundation) or 30 days (Scale), and stored replies for 1 day. Choosing your plan fills these in.",
  planSummary: (actorName: string, label: string, logDays: number, messageDays: number): string =>
    `${actorName} set the Mailgun plan to ${label}, with ${logDays} ${logDays === 1 ? "day" : "days"} of event logs and ${messageDays} ${messageDays === 1 ? "day" : "days"} of stored replies`,
  capLine: (cap: number, limit: number): string =>
    `Your Mailgun plan sends at most ${limit.toLocaleString("en-US")} emails a day, so the app plans at most ${cap.toLocaleString("en-US")} campaign emails a day and keeps ${(limit - cap).toLocaleString("en-US")} for test emails.`,
  maxFieldHint: (cap: number): string => `Your Mailgun plan keeps this at ${cap.toLocaleString("en-US")} at most.`,
  testsFull: (limit: number): string =>
    `Your Mailgun plan sends at most ${limit.toLocaleString("en-US")} emails in 24 hours, and that many have gone out. Try again later.`,
  limitRefused:
    "Mailgun refused an email because your plan's sending limit is reached. Sending is paused: click Resume after the limit resets, or upgrade the plan in Mailgun (Account › Plan) and choose it in Settings › Sending & Mailgun › Advanced.",
  limitReason: "Mailgun's sending limit for your plan is reached",
  /** Campaign emails (O25): never suggests authorizing a prospect's address. */
  authorizedOnlyCampaign:
    "Mailgun sends only to authorized recipients on your free account, so it refused this email. In Mailgun, add a payment card (Account › Billing, it may be called Plan), then click Resume. The Free plan stays free.",
  /** "Send me a test" and the reply test (O25): a test mailbox may be authorized. */
  authorizedOnlyTest:
    "Mailgun sends only to authorized recipients on your free account, so it refused this test email. In Mailgun, add a payment card (Account › Billing, it may be called Plan), or add this test mailbox under Authorized recipients, then try again.",
  authorizedReason: "Mailgun sends only to authorized recipients",
  monthlyNotNeeded: (limit: number): string =>
    `Your Mailgun plan stops at ${limit.toLocaleString("en-US")} emails a day, so a monthly safety limit isn't needed.`,
} as const;
```

**`src/server/services/mailgun/plan.ts`** (new):

```ts
import { planLimits, planOf, type PlanLimits } from "@/core/mailgun/plan";
import { repliesOf } from "@/core/sending/own-mailbox";
import { db, type DbOrTx } from "@/server/db";

/** The plan limits in force (O22): Settings "mailgun.plan" and "mailgun.replies", one query. Settings only. */
export async function loadPlanLimits(reader: DbOrTx = db): Promise<PlanLimits | null> {
  const rows = await reader.setting.findMany({ where: { key: { in: ["mailgun.plan", "mailgun.replies"] } }, select: { key: true, value: true } });
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return planLimits(planOf(value("mailgun.plan")), repliesOf(value("mailgun.replies")));
}

/**
 * The maximum daily limit every cap, warm-up table and cap-override check uses (O23): Setting "sending.maxDailyCap"
 * (its default when missing), never above the plan's limit minus the reserve. The only reader of the raw setting besides
 * the Limits form. `limits` is returned too, for callers that also show the plan line.
 */
export async function loadEffectiveMaxDailyCap(reader: DbOrTx = db): Promise<{ maxCap: number; limits: PlanLimits | null }> {
  const [row, limits] = await Promise.all([
    reader.setting.findUnique({ where: { key: "sending.maxDailyCap" }, select: { value: true } }),
    loadPlanLimits(reader),
  ]);
  const saved = row ? row.value : SETTING_DEFAULTS["sending.maxDailyCap"];
  return { maxCap: effectiveMaxDailyCap(saved, limits), limits };
}
```

(Imports: `effectiveMaxDailyCap` from `@/core/mailgun/plan`, `SETTING_DEFAULTS` from `@/server/settings`.)

### 7.5 Edited contract code (step C; behaviour unchanged when the new inputs are absent)

- **`src/core/sending/from-address.ts`**: `senderHeaderProblem(sendingDomain, fromLine, replyTo, opts?: {
  ownMailboxFrom?: string | null })`. When `opts.ownMailboxFrom` is a string (own-mailbox mode, `ownMailboxRuleFrom`): ""
  → "Own-mailbox mode has no From address yet."; the From address ≠ it → "The From address isn't the own From
  {ownMailboxFrom}."; its domain ≠ the sending domain → "The From address isn't on {d}."; a non-empty Reply-To → "An
  own-mailbox email has a reply address."; else null. Null/absent: today's rules, unchanged.
- **`src/core/sender-address.ts`**: `validateSendingDomain(input, opts?: { replies?: RepliesMode })` (§2.2) and
  `SENDING_DOMAIN_TEXTS.www`, `.emptyOwn`, `.invalidOwn`, `.sandboxOwn`, `.sharedOwn` (§2.2); the new `.website` sentence
  (O30). `.empty`, `.invalid`, `.sandbox`, `.shared` are unchanged (guide 2 quotes `.sandbox`, `labels.test.ts:364`).
  Afterwards P2's.
- **The three places that pin today's `.website` sentence**, updated in step C together with the constant so the suite
  stays green between step C and wave 2: `tests/unit/setup-core/sender-address.test.ts:75-77` (the literal becomes the new
  sentence), `tests/integration/mailgun-setup/connect.test.ts:131-133` (the same), and `docs/setup/2-mailgun-and-dns.md:114`
  (the quote becomes the new sentence, followed by "You typed polygonparadise.com as the sending domain: type
  mail.polygonparadise.com, or choose From polygonparadise.com itself and follow the Own-mailbox guide."; `labels.test.ts:363`
  compares the guide with the constant and stays as it is).
- **`src/server/services/mailgun/team-from.ts`**: `TeamFromState` += `replies: RepliesMode`, `ownFrom: string | null`,
  `evidenceFrom: string | null`; `loadTeamFrom` reads `mailgun.replies` in the same query and follows §2.2's table (code
  as written there; `validateOwnMailboxFrom` for own-mailbox mode). Afterwards P2's (defects only, no change to an
  exported name, signature or `TeamFromState` field).
- **`src/server/mailgun/context.ts`**: `MailgunContext` += `replies: RepliesMode`, `ownFrom: string | null`,
  `ownMailboxFrom: string | null` (= `ownMailboxRuleFrom(replies, ownFrom)`), read with one `loadTeamFrom()`; both clients
  get `ownMailboxFrom` in their options. Afterwards P1's (defects only, same rule).
- **`src/server/mailgun/client.ts`**: `MailgunClientOptions.ownMailboxFrom?: string | null` ("own-mailbox mode: the only
  From a send may carry, O6; null/absent = app mode"); `sendMessage` passes `{ ownMailboxFrom: this.#opts.ownMailboxFrom
  }` to `senderHeaderProblem` (`forRegion` already copies the options); `CallSpec` += `send?: boolean`, set only by
  `sendMessage`, and `#statusError` calls `classifyStatus(res.status, text, { send: spec.send === true })` (O24).
  Afterwards P1's (defects only, same rule).
- **`src/server/mailgun/types.ts`**: `MailgunErrorKind` += `"limit"` ("Mailgun refused a send because the plan's sending
  limit is reached (MAIN-DOMAIN-DESIGN O24): pause, never fail the email for good. Only POST /messages").
- **`src/server/mailgun/errors.ts`** (afterwards P1's, which may fix it without changing exported signatures):
  `classifyStatus(status, text, opts?: { send?: boolean })` with the send-only limit rule of §2.8 (400/403, after
  business verification, before not-allowed, the size exclusion); `plainMailgunError`: `"limit"` →
  `PLAN_TEXTS.limitRefused`; `"not-allowed"` whose `mailgunMessage` or `message` matches the authorized-recipients rule →
  `PLAN_TEXTS.authorizedOnlyCampaign`; exported `isAuthorizedOnlyRefusal(text: string): boolean` (the rule, for
  `mailgunFailure` and test sends).
- **`src/server/services/sending/usage.ts`**: `countMailgunSendsSince(since: Date, reader?: DbOrTx): Promise<{ total:
  number; oldestAt: Date | null }>` (§2.8: the larger of the local count and the distinct `accepted` events; SENT rows
  found by `sentAt` alone and kept when SENT, as `countedCampaignSends` does). Afterwards P1's.
- **`src/server/services/mailgun/plan.ts`**: `loadPlanLimits`, `loadEffectiveMaxDailyCap` (§7.4).
- **`src/core/reply-test.ts`**: `replyTestPassedFor(setting, domain, teamFrom, opts?: { ownMailbox?: boolean })`:
  `setting` gains `replies` in its `Pick`; a stored pass counts only when `(setting.replies === "own-mailbox") ===
  (opts?.ownMailbox === true)`, besides today's domain and From rules. Afterwards P4's.
- **`src/core/sending/mode-gates.ts`** (afterwards P4's, which writes its tests and may fix it without changing exported
  signatures):
  - `liveModeBlockers(rows, ctx)`: ctx += `ownMailbox?: boolean`; with it, the DNS gate's keys are `["mailgun-domain",
    "spf", "dkim", "tracking-cname"]` and the from-mx sentences follow as for `teamFrom`. `liveLaunchBlockers` and
    `replyTestBlockers` pass it through; `replyTestBlockers` with `ownMailbox` skips `ownerRouteOk` and `publicAddressOk`,
    needs the `dmarc` row present and not "bad" (`MODE_GATE_TEXTS.dmarcFirst`, O38) and needs Setup A, answering
    `OWN_MAILBOX_TEXTS.setupNotNormal` instead of `setupA` when it isn't.
  - `export function goLiveRowKeys(teamFrom: boolean, opts?: { ownMailbox?: boolean; publicAddress?: boolean }):
    readonly ChecklistRowKey[]`: `ownMailbox` → `["mailgun-domain", "spf", "dkim", "tracking-cname", "dmarc", "from-mx",
    "tracking-off", "unsubscribe", "signing-key", ...(publicAddress ? ["webhooks"] : []), "sending-allowed",
    ...(publicAddress ? ["remote-access"] : [])]`; otherwise today's.
  - `goLiveBlockers(rows, ctx)`: ctx += `ownMailbox?: boolean`, `publicAddress?: boolean` (used for the row keys).
  - `goLiveRecommendations(ctx)`: ctx += `ownMailbox?: boolean`, `planDailyLimit?: number | null`; own-mailbox:
    `postmasterOwn(d)` instead of `postmasterTeam` (`teamFrom` carries the own From), `authorizedCheck` and `planUpgrade`
    while `planDailyLimit` is set, `checksFree` instead of `checks` while it is set, the monthly-limit line skipped for an
    "info" row.
  - `MODE_GATE_TEXTS.dmarcFirst`; `GO_LIVE_RECOMMENDATION_TEXTS.planUpgrade`, `.checksFree`, `.postmasterOwn`,
    `.authorizedCheck` (§3.4).
- **`src/core/sending/go-live-copy.ts`** (afterwards P4's, same rule): `dialogOwnMailboxItem`, `ownMailboxTick`,
  `ownMailboxRequired`, `httpLinksTick`, `httpLinksRequired`, `liveOwnFromLine`, `guideLineOwn` (§3.4);
  `goLiveDialogItems(input)`'s `from` gains `ownMailbox?: { from: string; domain: string } | null` (set → the own-mailbox
  item in the From item's place).
- **`src/core/dns/checklist.ts`** (types only; afterwards P3's): `ChecklistFacts.ownMailbox?: boolean`,
  `ChecklistFacts.plan?: PlanLimits | null`, `ChecklistFacts.lastGoodMx?: Array<{ priority: number; host: string }> |
  null`; `FromDomainFacts.dns.spfLookups` gains `names?: string[]`.
- **`src/core/dns/check-state.ts`** (new): `checkMatchesMode` (§7.2).
- **`src/core/notification-types.ts`**: `reply.inboxCheck` (§7.2), and its test
  `tests/unit/notifications-core/notification-types.test.ts:45-51` (the reply group's list gains it).
- **`src/components/settings/types.ts`** (types only): `ConnectionView` += `replies: RepliesMode`, `plan: MailgunPlan |
  null`, `planAssumed: boolean`; `FromAddressView` += `replies: RepliesMode`; `SenderAddressView` += `ownFrom?: string |
  null`; `ReplyTestView` += `ownFrom?: string | null`, `mailtoAddress?: string | null`, `mailtoArrived?: boolean | null`;
  `GoLiveCardView` += `ownMailboxTick?: string | null`, `httpLinksTick?: string | null`.
- **`src/server/services/go-live.ts`**: `goLive(actor, opts)`'s opts += `confirmOwnMailbox?: boolean`,
  `confirmHttpLinks?: boolean` (unused until P4). Afterwards P4's.
- **`src/app/(app)/settings/sending/actions.ts`**: `goLiveSchema` += `confirmOwnMailbox`, `confirmHttpLinks`
  (`z.boolean().optional()`, passed to `goLive`); the connect schema += `replies: z.enum(["app", "own-mailbox"]).optional()`
  (passed to `connectMailgun`); the retention schema += `plan: z.enum(["free", "basic", "foundation", "scale"]).nullable()
  .optional()` (absent = unchanged). Afterwards P2's.
- **`src/server/services/mailgun/connect.ts`**: `ConnectInput.replies?: RepliesMode` (type only; absent = the saved
  mode). Afterwards P2's.
- **`src/server/settings.ts`**, **`src/core/setting-types.ts`**, **`src/core/system-state.ts`**,
  **`src/core/system-state-parse.ts`**, **`src/components/campaigns/format.ts`**: §7.1–§7.2.

### 7.6 Activity, notification and notice types

| Kind | Name | Copy | Package |
|---|---|---|---|
| Activity | `company.markedReplied` (new) | §3.8 (data `{ personId, stopped, statusFrom, statusTo, at, countsAsReply }`) | P6 |
| Activity | `company.status` (existing) | written by They replied when the status changes, data `markedReplied: true` | P6 |
| Activity | `sending.inboxChecked` (new) | `INBOX_CHECK_TEXTS.activity` ("Arslan read contact@polygonparadise.com (inbox and Spam)"), data `{ from }` | P6 |
| Activity | `mailgun.domainChanged` (existing) | data gains `fromReplies`, `toReplies`; a same-domain switch uses `switchedSummary` | P2 |
| Activity | `mailgun.connected` (existing) | data gains `replies` | P2 |
| Activity | the retention activity (existing, data key `mailgun.retention`) | data gains `plan`; the plan summary when it changes (also from the first own-mailbox connect) | P2 |
| Activity | `replyTest.decided`, `sending.goLive` (existing) | data gains `replies`; go-live also `ownMailboxConfirmed`, `httpLinksConfirmed` | P4 |
| Notice key | `from-mx-bad` (existing) | own-mailbox body `mxBodyOwn` | P3 |
| Notice key | `inbox-check` (new, type `reply.inboxCheck`, to the Owner, once per 24 hours) | `INBOX_CHECK_TEXTS.notificationTitle` / `.notificationBody(from)`, link `/notifications#inbox-check` | P1 (loop) |
| Notification type | `reply.inboxCheck` (new; Replies pop-up group, on by default; Notifications filter "Replies") | the notice above | step C (type), P1 (sender) |

P9 adds them to the doc comments of `src/server/activity.ts` and `src/server/notifications.ts`.

### 7.7 Environment variables and packages

None. The app reads no `MAILGUN_*` variable (checked: only `OUTREACH_MAILGUN_BASE_URL`, `src/server/mailgun/base-url.ts:53`
and `scripts/run-prod.mjs:95`), so the guide's optional advice to delete such lines from `.env` changes nothing in the
code.

### 7.8 Fake Mailgun and test helpers (step C; today's behaviour unchanged by default; afterwards P8's)

- `tests/fake-mailgun/state.ts`: `FakeMailgunOptions.receivesMail?: boolean` (default true; false = "the domain's MX
  isn't Mailgun's": `deliveredToFake` treats the fake's own domain and `otherDomains` as outside, so every preset to them
  answers `{ ok: true, stored: false, deliveredTo: "outside", to }`, and the receiving DNS records report `valid:
  "unverified"`); `plan?: "foundation" | "basic" | "free"`; `dailyLimit?: number` (default 100 on free, none otherwise);
  `authorizedRecipients?: string[] | null`; `retentionDays` default 1 on free (5 otherwise). `GET /__fake/state` reports
  `receivesMail`, `plan`, `dailyLimit`, `authorizedRecipients`, `sentLast24h`.
- `handlers/messages.ts`: on free, messages (test mode included) past `dailyLimit` in the fake's rolling 24 hours →
  400 `{"message": "Domain <d> has reached its daily sending limit of 100 messages."}` (text chosen for the tests,
  UNVERIFIED); with `authorizedRecipients`, any other `to` → 403 `{"message": "Domain <d> is not allowed to send: Free
  accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account
  Settings."}`. Nothing is stored or evented for a refused message.
- `handlers/x509.ts`: 402 on free (as basic). `handlers/routes.ts`: on free, a `POST /v3/routes` while one route exists →
  400 `{"message": "You've reached the inbound routes limit of your plan."}` (UNVERIFIED; exists so a test can prove the
  app never tries).
- `admin.ts` (`POST /__fake/inbound`) and `FakeMailgun.receivePreset`: honour `receivesMail`.
- `tests/fake-mailgun/cli.ts` and `scripts/fake-mailgun.mjs` usage: `--plan foundation|basic|free`, `--mx-elsewhere`,
  `--daily-limit N`, `--authorized a@x,b@y`.
- **`tests/integration/mailgun-client/fake-free.test.ts`** (new, step C, next to `fake.test.ts`): `receivesMail: false`
  makes every preset "outside" and stores nothing; the 101st message in 24 hours (test mode included) → the 400 limit
  answer, nothing stored or evented; with `authorizedRecipients` another `to` → the 403 answer; a second `POST
  /v3/routes` on free → the 400; x509 on free → 402; `/__fake/state` reports the new fields; `parseCliArgs` (or the CLI's
  own parser) accepts `--plan free --mx-elsewhere --daily-limit 5 --authorized a@x,b@y`; defaults unchanged (foundation,
  `receivesMail` true, no daily limit).
- `tests/integration/helpers/mailgun.ts`: `connectFakeMailgun(opts)` += `replies?: RepliesMode` (writes
  `mailgun.replies`), `plan?: MailgunPlan | null` (writes `mailgun.plan`); with `replies: "own-mailbox"` it expects the
  fake's `receivesMail: false` (throws otherwise: a test would prove replies it can never see) and creates no
  SenderAddress.
- `tests/unit/setup-core/originals.ts`: `testOriginal({ listUnsubscribe })` builds an http link when given one (only if it
  can't today).

### 7.9 Every file step C touches

`src/core/sending/own-mailbox.ts` (new); `src/core/mailgun/plan.ts` (new); `src/server/services/mailgun/plan.ts` (new);
`src/core/dns/check-state.ts` (new); `src/core/sending/from-address.ts`; `src/core/sender-address.ts`;
`src/server/services/mailgun/team-from.ts`; `src/server/mailgun/{context,client,types,errors}.ts`;
`src/server/services/sending/usage.ts` (one new function); `src/core/reply-test.ts` (`replyTestPassedFor`);
`src/core/sending/mode-gates.ts`; `src/core/sending/go-live-copy.ts`; `src/core/dns/checklist.ts` (types);
`src/core/notification-types.ts`; `src/server/settings.ts`; `src/core/setting-types.ts`; `src/core/system-state.ts`;
`src/core/system-state-parse.ts`; `src/components/campaigns/format.ts` (two cases); `src/components/settings/types.ts`;
`src/server/services/go-live.ts` (opts type); `src/app/(app)/settings/sending/actions.ts` (schemas);
`src/server/services/mailgun/connect.ts` (`ConnectInput` type);
`tests/fake-mailgun/{state,server,admin,cli,handlers/messages,handlers/x509,handlers/routes}.ts`;
`scripts/fake-mailgun.mjs` (usage text); `tests/integration/mailgun-client/fake-free.test.ts` (new);
`tests/integration/helpers/mailgun.ts`; `tests/unit/setup-core/originals.ts` (only if needed);
`tests/unit/setup-core/sender-address.test.ts` (lines 75-77); `tests/integration/mailgun-setup/connect.test.ts` (lines
131-133); `tests/unit/notifications-core/notification-types.test.ts` (lines 45-51); `docs/setup/2-mailgun-and-dns.md`
(line 114 only); literal fixes in tests that build `TeamFromState`, `MailgunContext`, `GateContext` or `DomainCheckState`
objects (§9.2). After step C each file belongs to the package §8 names, or stays read-only when no package names it.

---

## 8. Work packages

Every package: follow `CONVENTIONS.md`, M6-DESIGN §0.2, SHARED-FROM-DESIGN §0.2 and §0.2 here; run `npx tsc --noEmit`,
`npx tsc --noEmit -p tsconfig.worker.json`, `npx eslint <owned paths>`, `npx vitest run <own test paths>` (P9: the whole
suite); never run `next build/dev/start`, `npm install`, `prisma migrate *` or `npx playwright test`; never touch
`data/app.db` or port 3000; never call a real service. Ownership is by file; two packages of the same wave never own the
same file. Update the existing tests listed for your files (§9.2). New integration tests of this mode live in
`tests/integration/own-mailbox/` (each package its own files, named below) and use `connectFakeMailgun({ replies:
"own-mailbox", fromAddress: "contact@example.com", plan: "free" })` against a fake started with `{ domain: "example.com",
region: "US", plan: "free", receivesMail: false }`.

**Ownership at a glance**

| Step | Owner | Files |
|---|---|---|
| C | Lead | §7.9; afterwards read-only unless a package names the file (usage.ts, errors.ts, `mailgun/{context,client}.ts` → P1; sender-address.ts, sending/actions.ts, connect.ts, `services/mailgun/team-from.ts` → P2; checklist.ts → P3; core/reply-test.ts, go-live.ts, mode-gates.ts, go-live-copy.ts → P4; the fake Mailgun files and `fake-free.test.ts` → P8). A package that takes over a step-C file may fix a defect in it but never changes an exported name or signature (others import them in parallel); a needed signature change is reported in its final answer. |
| Wave 1 | P1 | sending services (addresses, gates, loop, mailgun-transport, usage, warmup-days), `mailgun/{errors,context,client}.ts` (the last two defects only), campaigns launch/draft/control, simulate, the campaign page, the outbox page and simulate buttons, the wizard's Sender step and page |
| Wave 1 | P2 | connect, Apply, routes, the Sending page (actions, load, page), the connection form, the From card, `core/sender-address.ts`, `services/mailgun/team-from.ts` (defects only) |
| Wave 1 | P3 | `core/dns/checklist.ts`, the domain-check services (facts, lookup, check, spf-count) |
| Wave 1 | P4 | `core/reply-test.ts`, `mode-gates.ts`, `go-live-copy.ts`, reply-test/test-send/go-live services, the Domain checklist page and components, the go-live card, view and dialog |
| Wave 1 | P5 | sender addresses, users, profile, limits (page and actions), team switch-off, internal senders, health check, the dashboard (load, attention, screen, replies tile), catch-up, suppressions, reconcile, restore, holds |
| Wave 1 | P6 | replies by hand: They replied (service, stop codes in `stops.ts`, company panel, campaign person panel), the inbox check (service, action, card, the Notifications page and its replies section), the owner-actions list |
| Wave 2 | P7, P8 | docs; the end-to-end test, the seed, Playwright, `run-prod.mjs`, `supervisor.mjs`, the fake after step C |
| Final | P9 | integration, CONVENTIONS, doc comments, the sweeps |

### P1 — Every email in own-mailbox mode (wave 1)

**Owned paths:** `src/server/services/sending/{addresses,gates,loop,mailgun-transport,usage,warmup-days}.ts`,
`src/server/mailgun/errors.ts` (beyond step C), `src/server/mailgun/{context,client}.ts` (after step C, defects only,
never an exported name, signature or field), `src/server/services/campaigns/{launch,draft,control}.ts`,
`src/server/services/mail-events/simulate.ts`, `src/app/(app)/campaigns/[id]/page.tsx`,
`src/app/(app)/campaigns/[id]/setup/sender/page.tsx`, `src/components/campaign-wizard/sender-step.tsx`,
`src/app/(app)/campaigns/outbox/page.tsx`, `src/components/campaigns/simulate-buttons.tsx`; tests
`tests/unit/sending/own-mailbox.test.ts` (new: the step-C helpers of `own-mailbox.ts`, `plan.ts`, `senderHeaderProblem`'s
option and `classifyStatus`'s limit rule), `tests/unit/sending/{addresses,gates,mailgun-transport}.test.ts` (new cases),
`tests/unit/mailgun-client/classify-limit.test.ts` (new), `tests/integration/own-mailbox/{sending,launch,retry,plan-limit,inbox-check,leftover}.test.ts`
(new), and the §9.2 updates marked P1.

**Builds:**
- `senderSnapshot(user, mode, senderAddress?, opts?: { teamFrom?; ownMailbox? })` (§2.3); `NoSenderAddressError` unchanged.
- `launch.ts` (§2.3): own-mailbox problems, snapshot, `senderHasReplyRoute: undefined`, `LaunchSettings.replies` and the
  domain row in `finalizeLaunch`'s re-check; the leftover-row rule of O35 (`ctx.ownMailbox` added to the snapshot
  context); rows of another mode ignored (`checkMatchesMode`, O36).
- `draft.ts`: `listSenderChoices()` own-mailbox choices (`SenderChoice.ownFrom`); `LaunchSummary` unchanged otherwise.
- `control.ts`: `retrySnapshotProblem` own branch; `RETRY_FROM_TEXTS.nowOwnMailbox`. Retry's guard read
  (`control.ts:576`) also refuses to release a row `inboxCheckHeldIds` holds, with the waiting line's sentence (it goes
  once today's check is done).
- `gates.ts`: `GateContext` += `ownMailbox: boolean`, `planLeft: number | null`, `planOpensAt: Date | null`;
  `loadGateContext` reads them (`loadTeamFrom`, `loadPlanLimits`, `countMailgunSendsSince(now − 24 h)`, `planRoom`) and
  ignores rows of another mode (`checkMatchesMode`, O36); `mainDomainMxOk = isMainDomainMxOk(rows, ownMailbox ?
  (team.saved ?? domain) : team.saved)`; `planTick`: after the Mailgun back-off check, a TEST/LIVE candidate waits
  `plan-limit` (until `planOpensAt`) when `planLeft ≤ 0`; the LIVE reply-route hold is skipped when `ownMailbox`; right
  after the `possible-reply` check, a candidate in `ctx.problems.inboxCheck` waits `inbox-check` and is recorded in the new
  `TickPlan.inboxHeld` (first one, like `routeHeld`). The documented check order gains "→ the plan's rolling daily limit
  (TEST/LIVE)" after the back-off and "→ today's inbox check (own-mailbox, LIVE follow-ups)" after the possible reply.
- **The inbox-check gate** (O33), in `gates.ts`: `ProblemIds` += `inboxCheck?: Set<number>`; `pendingProblemIds` step 5
  `out.inboxCheck = await inboxCheckHeldIds(cands, now)`; `export async function inboxCheckHeldIds(cands:
  readonly GuardCandidate[], now: Date): Promise<Set<number>>`: empty unless `loadTeamFrom().replies === "own-mailbox"`;
  only LIVE candidates with `step ≥ 1`; reads `STATE_KEYS.inboxCheck` and today's cap-day start (`capDayBounds(capDayOf(now,
  zone), zone)` with Setting `sending.capDayTimeZone`, as `countUserTestSends` does); a candidate is held when `at` is null,
  `at < dayStart`, or `at ≤` its recipient's newest SENT `sentAt` (one `groupBy` per 500 recipients, as `outageHeldIds`
  does). `pendingProblemIds` gains a `now` parameter (default `new Date()`; the tick and the final check pass theirs).
- `loop.ts`: the final check (`loop.ts:576`) also releases a row in `problems.inboxCheck` uncounted; after a tick whose
  plan has `inboxHeld`, `notice("inbox-check", now, { type: REPLY_NOTIFICATION.inboxCheck, title:
  INBOX_CHECK_TEXTS.notificationTitle, body: INBOX_CHECK_TEXTS.notificationBody(from), link: "/notifications#inbox-check"
  })` (at most once per 24 hours through `shouldSendNotice`); `applyFailure` "blocked" (O35): when the failure carries
  `ownMailbox: true` (set by the transport for its own-mailbox check) and the row's claim-time `lastError` (the claim
  select gains it if it lacks it) equals `OWN_MAILBOX_TEXTS.senderBlocked`, `failForGood(row, now,
  OWN_MAILBOX_TEXTS.senderBlockedTwice, …)` without pausing; otherwise `releaseClaim(row.id, { countAttempt: false, error:
  OWN_MAILBOX_TEXTS.senderBlocked })` and today's pause. App-mode blocks are unchanged.
- `usage.ts`: `getTodayCap` uses `(await loadEffectiveMaxDailyCap()).maxCap` for `maxCap` and the table (`TodayCap`'s
  shape is unchanged; other packages read the plan through `loadPlanLimits()`/`loadEffectiveMaxDailyCap()`, never through
  P1's code).
- `warmup-days.ts`: the table with `loadEffectiveMaxDailyCap()`.
- `mailgun-transport.ts`: `send()` passes `{ ownMailboxFrom: this.context.ownMailboxFrom }` to `senderHeaderProblem` and, in
  own-mailbox mode, requires `messageIdDomainOf(message.messageId) === domain` (else blocked + `SENDER_HEADERS_PAUSE`,
  with `ownMailbox: true` on the failure); `mailgunFailure`: kind `"limit"` → `{ kind: "pause", pause:
  "mailgun-not-allowed", reason: PLAN_TEXTS.limitReason, fixText: PLAN_TEXTS.limitRefused, mailgunMessage }`; kind
  `"not-allowed"` with `isAuthorizedOnlyRefusal(said)` → reason `PLAN_TEXTS.authorizedReason`, fix
  `PLAN_TEXTS.authorizedOnlyCampaign`.
- `errors.ts` (after step C): defects only (the §2.8 cases are pinned by P1's tests).
- `simulate.ts`: the reply kinds refuse in own-mailbox mode with `throw new ServiceError(OWN_MAILBOX_TEXTS.simulateReply(from))`
  (`ServiceError` from `services/companies/mutations`, which `outbox/actions.ts:29-31,54-56` turns into the sentence);
  bounce/complaint/unsubscribe/delivered stay.
- `outbox/page.tsx` passes `replies={team.replies !== "own-mailbox"}`; `simulate-buttons.tsx` gains `replies?: boolean`
  (default true) and hides the reply group when false.
- `[id]/page.tsx`: own-mailbox campaigns (`fromAddress === team.ownFrom`, `replyTo` null, mode TEST/LIVE) show no "replies
  to" and the `followUpReminder` line under the follow-ups (same condition as today's `followUpsToCome`) with the link
  `OWN_MAILBOX_TEXTS.openInboxCheck` → `/notifications#inbox-check`.
- `sender-step.tsx` + `setup/sender/page.tsx`: §3.7 (page passes `ownFrom`).

**Provides:** `senderSnapshot`'s `ownMailbox` option, `SenderChoice.ownFrom`, `GateContext.ownMailbox/planLeft/planOpensAt`,
`ProblemIds.inboxCheck`, `inboxCheckHeldIds`, `TickPlan.inboxHeld`, `RETRY_FROM_TEXTS.nowOwnMailbox`.

**Consumes:** step-C contracts only.

**Tests:**
- unit `own-mailbox.test.ts`: `repliesOf` ("own-mailbox" only; "Own-Mailbox", 1, null → "app"); `validateOwnMailboxFrom`
  table — `contact@example.com` with `example.com` ok; uppercase and `mailto:` normalised; `contact@mail.example.com` →
  fromWrongDomain; `contact@other.com` → fromWrongDomain; `contact@gmail.com` → fromWrongDomain; `noreply@`,
  `postmaster@`, `pp-route-check-1@` → reserved; `"Ali" <contact@example.com>` → invalid; empty → null; no domain →
  notConnected; `contact@polygonparadise.com` with `polygonparadise.com` ok; `validateFromAddressFor` dispatches (app mode
  gives exactly `validateTeamFromAddress`'s answers on the shared-From table); `ownMailboxHeaders` (quoted display names,
  `replyTo: null`); `ownMailboxRuleFrom`; `senderHeaderProblem` with the option: own From → null; another address on the
  domain → problem; a Reply-To → problem; "" → problem; without the option: today's answers (per-person with a Reply-To
  elsewhere → null). `plan.ts`: `planOf`, `planLimits` (chosen; null + own-mailbox → free assumed; null + app → null),
  `effectiveLogRetentionDays` (5 + free → 1; 5 + null → 5; 0/NaN → 5 then capped), `effectiveMaxDailyCap` (1000 + free →
  90; 50 + free → 50; 1000 + foundation → 1000), `planRoom`; `putBackMx` (sorted by priority; none → the help-pages
  sentence).
- unit `classify-limit.test.ts` (O24, every case of §2.8): with `{ send: true }`: 400 "…has reached its daily sending
  limit…" → "limit"; 403 "sending quota exceeded" → "limit"; 400 "Free accounts are limited to 100 messages per day" →
  "limit"; 400 "Message size limit exceeded" → "rejected"; 400 "Recipient limit exceeded: 1000 recipients per message" →
  "rejected"; 400 "limit reached" → "rejected"; 403 "…is not allowed to send: Free accounts are for test purposes only…" → "not-allowed" and
  `isAuthorizedOnlyRefusal` true; a 403 business-verification text that mentions a limit → "business-verification"; 429
  "…limit…" → "rate-limited"; 402 "quota" → "payment". Without `send`: 402 "quota" → "payment", 403 "limit reached" →
  "auth", 400 "daily sending limit" → "rejected" (today's kinds, for the address checks, Logs, routes and Apply).
  `plainMailgunError` for "limit" and the authorized-only refusal (the campaign sentence, never "Authorized recipients"
  as advice). App-mode regression: the verifier's `failureKindOf` (`mailgun-verifier.ts:61`) and the catch-up's
  `catchUpErrorKind` (`catch-up.ts:110`, which decides `pauseForAuth`) give today's answers for `MailgunError`s built
  through the client's non-send path from these texts.
- unit `addresses.test.ts`: own-mailbox snapshot (From line, `fromAddress`, `replyTo: null`, `sendingDomainId`,
  `messageIdDomain` = the domain; DRY_RUN → `dry-run.invalid`); `teamFrom` + `ownMailbox` together throw.
- unit `gates.test.ts`: `plan-limit` holds TEST and LIVE (not DRY_RUN) when `planLeft ≤ 0`, in the order of the check list;
  `null` planLeft holds nothing; the route hold skipped with `ownMailbox`; `main-domain-mx` holds with `ownMailbox` even
  without a saved From; a candidate in `problems.inboxCheck` waits `inbox-check` and fills `inboxHeld`; rows stored for the
  other mode don't pass the LIVE checks (O36).
- unit `mailgun-transport.test.ts`: an own-mailbox row goes to `/v3/example.com/messages` without `h:Reply-To`; a row with
  another From, a Reply-To or a Message-ID elsewhere → blocked + `SENDER_HEADERS_PAUSE` with `ownMailbox: true`; kind
  `"limit"` → pause with the plan sentence (never "rejected"); authorized-only → its pause with
  `authorizedOnlyCampaign`.
- integration `own-mailbox/sending.test.ts`: TEST and LIVE launches store `Campaign.fromAddress = contact@example.com`,
  `replyTo` null, `sendingDomainId` = example.com's row; the fake gets `from` "Ali from Polygon Paradise
  <contact@example.com>", no `h:Reply-To`, `h:Message-Id` `@example.com`; the follow-up copies them; a LIVE email goes with
  no SenderAddress in the database (no route hold); a `from-mx` "bad" row holds LIVE (`main-domain-mx`) and TEST goes;
  `lastLiveSendAt` of example.com set; the client check refuses a hand-built input with a Reply-To before any request.
- integration `own-mailbox/launch.test.ts`: no own From → TEST/LIVE refused `from-invalid` with `fromMissing`; LIVE without
  the own-mailbox reply-test pass → `replyTestPass`; with it → launched; `finalizeLaunch` refuses when `mailgun.replies`
  changed between the chunks; `launchModeProblems` never returns `no-sender-address`/`no-reply-route` in this mode.
- integration `own-mailbox/leftover.test.ts` (O35): a DRY_RUN launch of a draft interrupted after its first chunk (rows
  with `@dry-run.invalid` ids), the draft relaunched LIVE in own-mailbox mode → every leftover row gets an `@example.com`
  id and sends; a row whose id is forced back to `@dry-run.invalid` is blocked once (paused, back in the queue, `lastError`
  = `senderBlocked`), and after Resume blocked again → FAILED "Didn't send" (`senderBlockedTwice`), sending not paused a
  second time; per-person mode's leftover rule unchanged (a per-person relaunch keeps the id, as today).
- integration `own-mailbox/inbox-check.test.ts` (O33): a LIVE campaign with a follow-up due; no check → the follow-up waits
  `inbox-check`, the first email of another person goes, TEST follow-ups go; one `reply.inboxCheck` notification to the
  Owner, none more within 24 hours; a check dated yesterday → waits; a check today but before the person's first email
  was sent (`daysAsMinutes`) → waits; a check today after it → goes; the loop's final check releases a row the pick let
  through when the check is withdrawn meanwhile (state written directly); a PAUSED campaign resumed with overdue
  follow-ups → they wait until today's check; app mode → nothing is ever held for it; `explainCampaignWaiting` names
  `inbox-check`.
- integration `own-mailbox/retry.test.ts`: an own-mailbox snapshot retries; a shared-From snapshot after the switch →
  `nowOwnMailbox`; a per-person snapshot after the switch → `nowOwnMailbox`; dry runs never refused.
- integration `own-mailbox/plan-limit.test.ts`: 90 counted sends in the last 24 h (rows written directly: SENT LIVE, TEST,
  and TestSend) → the next TEST email waits `plan-limit` with `until` = oldest + 24 h; at 89 it goes; 95 distinct
  `accepted` MailEvents of the last 24 h with only 10 local rows → waits too (O23); `getTodayCap().cap` never above 90 on
  free; the fake's 400 limit answer (from `fail-next` with its text) → paused, the row back in the queue (never FAILED); a
  429 → rate-limited back-off as today.

**Done when:** tests pass; `grep -n "senderHeaderProblem(" src/` shows every call passing the own-mailbox option except the
pure file itself; no own-mailbox path reads `senderAddresses` for the snapshot; `classifyStatus(` is called with `{ send:
true }` only from the client's send path.

### P2 — Connecting, the Sending page, Apply and routes (wave 1)

**Owned paths:** `src/server/services/mailgun/{connect,apply-settings,routes}.ts`,
`src/app/(app)/settings/sending/{actions.ts,load.ts,page.tsx}` (actions.ts beyond step C),
`src/components/settings/sending/{connection-form,from-address-card}.tsx`, `src/core/sender-address.ts` (beyond step C),
`src/server/services/mailgun/team-from.ts` (after step C, defects only, never an exported name, signature or
`TeamFromState` field);
tests `tests/unit/setup-core/sender-address.test.ts` (new cases), `tests/unit/settings/{connection-form,from-address-card}.test.ts`
(new static-markup cases), `tests/integration/own-mailbox/{connect,from-address,apply-routes}.test.ts` (new), and the §9.2
updates marked P2.

**Builds:**
- `connectMailgun(actor, input)`: `replies = input.replies ?? repliesOf(saved)`; `validateSendingDomain(domain, { replies
  })` (both in `testMailgunConnection`, which gains the same optional `replies`, and in `connectMailgun`); `changing` also
  when the mode differs; the From check `fromMisfitFor(saved, domain, replies)` through `validateFromAddressFor` with the
  own-mailbox sentence (§2.4), before the Mailgun test and again inside the transaction; `saveConnection(tx, { …, replies
  })` writes `mailgun.replies`, skips the address move and the region-only route reset in own-mailbox mode, logs the mode in
  `mailgun.connected`/`mailgun.domainChanged` data (a same-domain switch uses `switchedSummary`) and, on an own-mailbox
  connect while `mailgun.plan` is null, writes plan "free", `mailgun.logRetentionDays` 1 and
  `mailgun.messageRetentionDays` 1 with the retention activity in the same transaction (O22); after the commit no route
  sync in own-mailbox mode; the message of §3.1 (with `planSetFree` when this connect set the plan).
- `saveFromAddress`: `validateFromAddressFor(input, domain, replies)` (outside and inside the transaction); own-mailbox
  toasts (`savedOn`, `savedOff`) and `clearedSummary`; everything else as today (F13).
- `saveRetentionAction`: the optional `plan` (null = Not sure), written with the numbers and the activity in one `dbTx`
  (`setSettingIn`); the plan summary when the plan changed; `revalidatePath("/", "layout")`.
- `connectMailgunAction` passes `replies`; nothing else in `sending/actions.ts` changes.
- `sending/load.ts`: `ConnectionView.replies/plan/planAssumed`, the status line suffix; `FromAddressView.replies`; the
  outage line's days from `effectiveLogRetentionDays`; the warm-up table from `loadEffectiveMaxDailyCap()`;
  `validateTestList` gets `teamFrom: team.evidenceFrom`.
- `connection-form.tsx`: the "How the app sends" radio (§3.1; keyboard reachable, `RadioGroup` as Region), the note, the
  domain hint and placeholder by choice, as-you-type validation with the chosen mode (the `…Own` sentences in own-mailbox
  mode), the one-click **Use From polygonparadise.com itself** button under the `.website` sentence, the plan select
  (`Select` from `components/ui`) that fills the two numbers, the assumed-Free line; sends `replies` with "Save and
  connect" and `plan` with "Save these numbers"; keeps typed values on errors and on a lost connection.
- `from-address-card.tsx`: own-mailbox copy (§3.2) when `view.replies === "own-mailbox"`, validating as you type with
  `validateFromAddressFor`; app mode exactly as today.
- `core/sender-address.ts`: the texts (O30, `www`, the `…Own` sentences), if step C left anything to fix.
- `apply-settings.ts` (`runAll`), own-mailbox mode (`ctx.replies`): public-address step ok: null
  `OWN_MAILBOX_TEXTS.applyNoPublicAddress` when no public address; `setUnsubscribeTracking(d, true, …)` always (Setup A);
  spam-filter and retention steps ok: null `applyNotNeeded` (no Mailgun call); certificate/https, PII and the signing key as
  today; webhooks only with a working public address; routes step ok: null `applyNotNeeded` (never `syncRoutes`).
- `routes.ts` (`syncRoutes`): right after the connection check, `if (ctx.replies === "own-mailbox") return { ok: true,
  created: 0, updated: 0, deleted: 0, problems: [], senders: 0, retryable: false }` (no public-address check, no
  `listRoutes`, no status writes). The route-sync job (`routes.ts:541`) then finishes at once.
- `domain/page.tsx`'s Apply hint is P4's (§3.3); P2 only runs Apply.

**Provides:** `connectMailgun`'s mode, `saveRetentionAction`'s plan, the views.

**Consumes:** step-C contracts.

**Tests:**
- unit `sender-address.test.ts`: `polygonparadise.com` refused in app mode with the new `.website` sentence and allowed
  with `{ replies: "own-mailbox" }`; `www.polygonparadise.com` in own-mailbox mode → `.www`; `sandbox123.mailgun.org`
  and `gmail.com` refused in both modes, with `.sandbox`/`.shared` in app mode and `.sandboxOwn`/`.sharedOwn` in
  own-mailbox mode; empty and invalid input give `.emptyOwn`/`.invalidOwn` in own-mailbox mode; **no own-mailbox refusal
  sentence contains "mail.polygonparadise.com"**; `send.example.com` allowed in both.
- unit `connection-form.test.ts` / `from-address-card.test.ts` (`renderToStaticMarkup`): the radio with both options and
  hints, the own-mailbox option checked for an own-mailbox view; the one-click switch button rendered for an app view
  with `polygonparadise.com` typed (initial value) and absent for `mail.polygonparadise.com`; the plan select with "Free
  (100 emails a day)" and the assumed line; the own-mailbox From card (description, hint, missing state, Good to know
  items, no "(optional)"); app-mode markup identical to today's for an app view apart from the two new controls and the
  retention hint (a snapshot of the relevant text nodes); `truncate-chain` passes.
- integration `own-mailbox/connect.test.ts` (fake `example.com`, US): first connect with `replies: "own-mailbox"` → settings
  `mailgun.replies`, domain, region; `mailgun.plan` "free" with retention 1/1 and the plan activity (O22), and a second
  connect leaves a plan the Owner changed alone; one SendingDomain; no SenderAddress; no `mailgun.syncRoutes` job; a
  `mailgun.checkDomain` job; the message names own mailbox and the Free plan. Switching an app-mode connection (send.example.com with two
  SenderAddresses, a passed reply test, go-live on) to own-mailbox on example.com: refused while a LIVE campaign runs;
  after cancelling: `sending.goLive` false, reply test reset (Setup A), `mailgun.fromAddress` row's `updatedAt` moved, no
  address moved, the old addresses untouched on the inactive row, suppressions' `pushedToMailgunAt` cleared, activity data
  `fromReplies: "app"`, `toReplies: "own-mailbox"`. A saved shared From `contact@example.com` + connecting own-mailbox on
  `example.com` keeps it (fits); a saved `contact@other.com` → refused with `domainMisfit`. App mode with `polygonparadise.com`
  → the `.website` sentence and no fake request.
- integration `own-mailbox/from-address.test.ts`: own-mailbox saves `contact@example.com`; refuses `a@mail.example.com`,
  `noreply@example.com`; clearing is allowed and `loadTeamFrom().problem` becomes `fromMissing`; toasts; live → needs
  `confirmEndGoLive`; the Member case refused.
- integration `own-mailbox/apply-routes.test.ts`: Apply in own-mailbox mode with a fake on free: no `POST/PUT/DELETE
  /v3/routes`, no spam-action or `message_ttl` PUT, the certificate 402 → `not-in-plan`, steps' texts; `syncRoutes` returns
  ok with zero calls to `/v3/routes`; the route-sync job completes; the retention action with `plan: "free"` writes both
  settings and the activity in one transaction.

**Done when:** tests pass; the Sending page renders the card in app and own-mailbox mode; `owner-actions.test.ts` still
covers every changed action without an allowlist change.

### P3 — The Domain checklist's facts and rows (wave 1)

**Owned paths:** `src/core/dns/checklist.ts` (beyond step C), `src/server/services/checks/{dns-facts,dns-lookup,domain-check,spf-count}.ts`;
tests `tests/unit/checks/checklist-own-mailbox.test.ts` (new), `tests/unit/checks/spf-count.test.ts` (new `names` cases),
`tests/unit/checks/own-mailbox-lookup.test.ts` (new, fake-mode answers), `tests/integration/own-mailbox/domain-check.test.ts`
(new), and the §9.2 updates marked P3.

**Builds:** §5 and §3.3: `spfLookupReport` `names`; `gatherFromDomainFacts` passes them; `runDomainCheck` own-mailbox facts
(`ownMailbox`, `plan`, `lastGoodMx`, `from` for the sending domain whatever the From; `teamFromChanged` also compares
`replies`), and the stored state's `replies` and `lastGoodMx`; `mailgunRecordsLookup(…, { ownMailbox })`;
`buildChecklistRows` own-mailbox list with `ownSpfRow`, own-mailbox `fromMxRow` wording and fixes (`putBackMx`,
`NEVER_MAILGUN_MX_TEXT`, Cloudflare Email Routing "bad"), the own-mailbox `mailgun-domain` fix,
`https-links`/`webhooks`/`remote-access`/`monthly-limit`/`reply-test`/`postmaster`/`dmarc` variants; the website-domain
guard for app-mode facts (O37, §2.5 item 7); `FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn` and the notices (no `from-spf-broken` in
this mode; Cloudflare Email Routing notifies like a Mailgun MX). `checklistTitle` is unchanged.

**Provides:** the rows, `spfLookupReport().names`, `FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn`, the stored `replies` and
`lastGoodMx`.

**Tests:**
- unit `checklist-own-mailbox.test.ts`: the own-mailbox row list and order (no `mx`, `spam-filter`, `retention`,
  `reply-routes`, `from-spf`); every `spf` case of §3.3 with GoDaddy-style facts (two `_spfm` includes, 9 lookups, Mailgun
  reached through `dc-2._spfm` → ok "almost full"; Mailgun missing from the tree → bad with the add-include fix; 11 → bad;
  dangling `dc-1._spfm` → bad; two records → bad; none → bad; +all; incomplete ≤ 10 → unknown); every `from-mx` case with
  own-mailbox wording, with and without `lastGoodMx` (the Zoho hosts named in priority order), Cloudflare Email Routing →
  bad; the not-active `mailgun-domain` fix; `https-links` not-in-plan → info; `webhooks`/`remote-access` without a
  public URL → info, with one → today's rows; `monthly-limit` with free → info; `reply-test` cases (a pass for app mode or
  another From → warn); `dmarc` missing fix and rua fix; `dkim` per-person wording with the 1024 note; `postmaster` stays
  info with a Google record. **Safety** (§2.5 item 4) over every case, and over app-mode facts with the sending domain
  `polygonparadise.com` (O37: the `mx` row is the reconnect row with no box; no MX box anywhere; no `v=spf1` value). App-mode
  facts for any other domain produce exactly today's rows (the existing `checklist.test.ts` unchanged).
- unit `spf-count.test.ts`: `names` in walk order, dangling included, a timeout's name included, `countSpfLookups` unchanged.
- unit `own-mailbox-lookup.test.ts`: the fake-mode own-mailbox answers of §5 (4 lookups, Mailgun reached, nothing dangling,
  MX a provider's).
- integration `own-mailbox/domain-check.test.ts`: own-mailbox with an injected DNS table (§9.3) → rows present and ok,
  `from-mx` titled with example.com; MX switched to `mxa.mailgun.org` → from-mx bad and one `from-mx-bad` notification
  with `mxBodyOwn` (a second check within 24 h adds none), and its fix names the MX hosts of the earlier ok check; a check
  with no From saved still builds from-mx; the stored state carries `replies: "own-mailbox"`; the spf row with a
  top-level-only record (`v=spf1 include:mailgun.org ~all`) → ok; app mode after switching back → today's rows, `replies:
  "app"`, `lastGoodMx` cleared.

**Done when:** tests pass; no own-mailbox row has a record box other than DKIM, tracking CNAME and `_dmarc`.

### P4 — The reply test by hand, test sends, go-live and the Domain checklist page (wave 1)

**Owned paths:** `src/core/reply-test.ts` (beyond step C), `src/core/sending/{mode-gates,go-live-copy}.ts` (beyond step
C), `src/server/services/{reply-test,test-send,go-live}.ts`, `src/app/(app)/settings/domain/{load.ts,page.tsx,actions.ts}`,
`src/components/settings/domain/{reply-test-section,checklist}.tsx`,
`src/components/settings/sending/{go-live-card.tsx,go-live-view.ts,go-live-dialog.tsx}`; tests
`tests/unit/setup-core/reply-test-own.test.ts` (new), `tests/unit/setup-core/test-original.test.ts` (new cases),
`tests/unit/sending-core/mode-gates-own.test.ts` (new, for the step-C gate code), `tests/unit/go-live/**` (new cases),
`tests/unit/settings/domain-checklist-own-render.test.ts` (new), `tests/integration/own-mailbox/{reply-test,test-send,go-live,evidence}.test.ts`
(new), and the §9.2 updates marked P4.

**Builds:**
- `core/reply-test.ts`: `evaluateReplyTest(setting, facts, unsubscribeSeen, opts?: { teamFrom?; sendingDomain?;
  ownMailbox? })` with the own-mailbox rules of O13 (`nextStepOwn`: sent, delivered, `inboxOk` Yes, `dmarcOk` pass; every
  mailbox answers placement and DMARC; an original for today's domain and own From with `returnPathOk === true`; `dmarc !==
  "fail"`; `headersOk === true`; when the original has a `mailtoAddress`, `mailtoArrived === true` (No → failed with
  `mailtoFailed`, null → missing `mailtoUnanswered`); `unsubscribeSeen`; no `replyStored`, no `authOk`; `mailtoOk` itself
  never fails in this mode; failures and missing texts of §3.5; `warnings` = spam placements); `parseTestOriginal` also
  returns `unsubscribeScheme` (the scheme of the first http(s) URL in `List-Unsubscribe`, linear scan, REPLIES-04 caps)
  and `mailtoAddress`; `testOriginalTexts(result, { from, d, org, ownMailbox })` own lines; `currentOriginal` unchanged
  (domain + From).
- `mode-gates.ts`, `go-live-copy.ts` (after step C): defects only; P4's tests pin them.
- `services/reply-test.ts`: `GateInputs` += `replies`, `ownFrom`, `evidenceFrom`, `publicAddressSet`, `planLimits`,
  `httpsLinksOk`; stored rows of another mode ignored (`checkMatchesMode`, `reply-test.ts:174,286`); `replyTestPassedOnDomain`
  with `{ ownMailbox }`; `loadLiveTest(domainId, testList, { teamFrom, since, ownFrom })` (own: `replyTo: null`,
  `fromAddress: ownFrom`, `launchedAt ≥ since`); `modeBlockersFor`, `replyTestBlockersFor`, `goLiveBlockersFor`,
  `goLiveRecommendationsFor` pass `ownMailbox`, `publicAddress`, `planDailyLimit` (and `sendersWithoutRoute: []`,
  `teamFrom: evidenceFrom` for the recommendation); `spamPlacementsOf(setting, testList, evidenceFrom)`;
  `sendReplyTestEmails` own-mailbox: no owner address needed, `ownMailboxHeaders` with the Owner's display name,
  `TestSend.teamFrom = evidenceFrom`, the rolling guard (`planRoom().tests`), `authorizedOnlyTest` for an
  authorized-only refusal; `loadReplyTest` counts emails of today's evidence From (the F26 filters with `evidenceFrom`),
  shows no "Reply reached the app" fact in own-mailbox mode, and passes `mailtoAddress`/`mailtoArrived` to the view;
  `saveReplyTestAnswers` checks the round with `team.evidenceFrom` and reads DMARC pastes for its domain
  (`reply-test.ts:707-723`, today `team.address`), and stores `mailtoArrived`; `saveReplyTestOriginal` works with
  `team.evidenceFrom` throughout (`:744-771`: the From requirement, `fromDomain` = {d} in own-mailbox mode,
  `countsForToday(send, team.evidenceFrom, team.changedAt)`, the From comparison), stores `unsubscribeScheme` and
  `mailtoAddress`, and clears `mailtoArrived` when the stored `mailtoAddress` changes; `decideReplyTest` stores `from:
  evidenceFrom` and `replies: "own-mailbox"`, compare-and-set also on `mailgun.replies`; `switchUnsubscribeSetup` refuses
  B with `setupAOnly` in own-mailbox mode and allows A.
- `test-send.ts`: `sendMeATest` own-mailbox: no SenderAddress needed, `ownMailboxHeaders`, `teamFrom: evidenceFrom`, the self
  note when the inbox equals the own From, the rolling guard (`PLAN_TEXTS.testsFull`) inside the transaction that records
  the send; `testSendInfo`'s blocker includes the guard; `PAUSE_FOR.limit = { kind: "mailgun-not-allowed", reason:
  PLAN_TEXTS.limitReason }`; the authorized-only reason for `not-allowed` with `isAuthorizedOnlyRefusal`, fix
  `PLAN_TEXTS.authorizedOnlyTest`.
- `go-live.ts`: `IN_TX_KEYS` += `"mailgun.replies"`, `"mailgun.plan"`; `sameInputs` compares the mode and the plan;
  stored rows of another mode ignored; `goLive(actor, opts)`: in own-mailbox mode refuses without `confirmOwnMailbox`
  (`ownMailboxRequired`) and, while the https-links row isn't "ok", without `confirmHttpLinks` (`httpLinksRequired`),
  before the transaction; writes `sending.goLiveFrom = gate.evidenceFrom`; the start cap from
  `loadEffectiveMaxDailyCap()`; activity data `replies`, `ownMailboxConfirmed`, `httpLinksConfirmed`; `GoLiveView` +=
  `ownMailbox: { from: string; domain: string; httpLinksTick: boolean } | null`; `endedOnFrom` compares `evidenceFrom`;
  `ownFromExample` null in own-mailbox mode.
- The go-live card, view and dialog: `dialogOwnMailboxItem`, `liveOwnFromLine`, `guideLineOwn`, the two ticks (sent with the
  existing confirm), the start cap line from the effective cap (90 on Free), the own-mailbox recommendations.
- Domain checklist page: the header line; `OWN_MAILBOX_TEXTS.applyHint` instead of `APPLY_HINT` in own-mailbox mode; the
  `from-mx`/`from-spf` filter of `domain/load.ts:194` only in app mode (own-mailbox shows `from-mx` without a saved From);
  rows of another mode not shown (`checkMatchesMode`); no reply-routes list and no placeholder row in own-mailbox mode;
  the reply test section's own-mailbox questions (with the unsubscribe-by-email question, its copy button and
  `mailtoAfter`), intro, logs note, original lines, mailto note, failure sentence; no Setup switch (a **Back to normal**
  button only while the stored setup isn't A); the domain-age form with {d}.
- `domain/actions.ts`: the answers schema accepts `inboxOk` in own-mailbox mode (unchanged field) and `mailtoArrived:
  z.boolean().nullable().optional()`; nothing new otherwise.

**Provides:** `GateInputs.replies/ownFrom/evidenceFrom/publicAddressSet/planLimits/httpsLinksOk`, `GoLiveView.ownMailbox`,
`parseTestOriginal().unsubscribeScheme/mailtoAddress`.

**Tests:**
- unit `reply-test-own.test.ts`: incomplete until each group has delivered + inbox Yes + DMARC pass and every mailbox
  answered placement and DMARC and an original is stored; inbox No → failed with `replyFailed`; DMARC fail → failed; an
  original with a Return-Path on another domain → failed; headers No → failed with `headersFailed`; an original with a
  `mailtoAddress`: unanswered → incomplete (`mailtoUnanswered`), No → failed with `mailtoFailed`, Yes → passes; an
  original without a mailto never asks; placement No → passed with a warning; an app-mode pass never counts in
  own-mailbox mode and the reverse (`replyTestPassedFor`); per-person and shared-From verdicts unchanged.
- unit `test-original.test.ts`: `unsubscribeScheme` https / http / none; `mailtoAddress` (`<mailto:u+x@example.com?subject=unsubscribe>`
  → `u+x@example.com`; none → null); folded header; 200k garbled paste still linear.
- unit `mode-gates-own.test.ts`: `liveModeBlockers` with `ownMailbox` never names `mx`, names `fromMx`/`fromMxUnchecked`;
  `replyTestBlockers` without owner route and public address; with the `dmarc` row missing or "bad" → `dmarcFirst`, "ok"
  or "warn" → passes that gate (O38); a stored Setup B → `setupNotNormal`, never `setupA`; `goLiveRowKeys(false, {
  ownMailbox: true, publicAddress })` both ways; `goLiveBlockers` sentences use the rows' titles; recommendations
  (`postmasterOwn` never "Mailgun guide", `authorizedCheck`, `planUpgrade`, `checksFree`, monthly-limit skipped for
  "info"); absent options → today's answers.
- unit go-live view/card/dialog: own-mailbox items, both ticks (the replies tick names the inbox check and the Spam
  folder), the live line, the 90 start cap on Free; app mode unchanged.
- unit `domain-checklist-own-render.test.ts` (static markup): a red own-mailbox from-mx row with its fix and no record box;
  the from-mx row rendered in own-mailbox mode with **no From saved** (the `load.ts:194` filter is app-only) and hidden in
  per-person mode as today; the own-mailbox Apply hint; the reply test section in own-mailbox mode (question order, no
  dkim question, the unsubscribe-by-email question with the address, no Setup switch, the logs note, "The reply test
  passed" never "Setup A passed"); the page without the reply-routes placeholder.
- integration `own-mailbox/reply-test.test.ts` (fake, `receivesMail: false`): blockers without owner route and public
  address, and the DMARC gate; emails From contact@example.com, no `h:Reply-To`, `TestSend.teamFrom`; preset replies →
  `outside`, nothing stored; answers (through `saveReplyTestAnswers` with the own-mailbox round), a pasted original
  (`testOriginal` with the fake's Message-ID, Return-Path `bounce+x@example.com`, dkim `example.com`, dmarc pass,
  `<mailto:u+x@example.com>, <http://email.example.com/u/x>`) stored with `unsubscribeScheme: "http"` and `mailtoAddress:
  "u+x@example.com"`; `mailtoArrived` No → failed with `mailtoFailed`, Yes → on; an unsubscribe via the fake read by a
  catch-up run → `unsubscribeSeen`; decide → passed with `replies`; an authorized-only 403 on a test email → the test
  sentence.
- integration `own-mailbox/test-send.test.ts`: "Send me a test" From contact@example.com, no Reply-To, to a test inbox
  `contact@example.com` (allowed) with the self note; refused with `fromMissing`; refused at 100 in 24 h; the fake's limit
  400 → paused with the plan reason.
- integration `own-mailbox/go-live.test.ts`: blockers without routes; `goLive()` without the replies tick → refused; with it
  but https-links not ok and no http tick → refused; with both → live, `goLiveFrom = contact@example.com`, activity data,
  the warm-up start cap from the effective cap; a mode change between the gate read and the transaction →
  `GO_LIVE_COPY.changed`.
- integration `own-mailbox/evidence.test.ts`: a shared-From pass and live test on send.example.com, then the switch to own
  mailbox on example.com → reply test incomplete, live test "none", go-live blocked; new own-mailbox evidence counts; a
  same-domain switch leaves the old mode's stored rows out of every gate until the next check (O36).

**Done when:** tests pass; the Domain checklist page and the go-live card render both modes; `goLiveCardView`'s signature
is unchanged.

### P5 — People, limits, dashboard, health, log retention (wave 1)

**Owned paths:** `src/server/services/{sender-addresses,users}.ts`, `src/app/(app)/settings/profile/{page.tsx,actions.ts}`,
`src/components/settings/profile-form.tsx`, `src/app/(app)/settings/limits/{page.tsx,actions.ts}`,
`src/components/settings/limits/sender-caps-form.tsx`, `src/app/(app)/settings/team/{switch-off-text.ts,page.tsx}`,
`src/server/services/mail-events/internal-senders.ts`, `src/server/services/sending/{health-check,reconcile,restore}.ts`,
`src/server/services/mailgun/{catch-up,suppressions}.ts`, `src/server/services/sequences/holds.ts`,
`src/app/(app)/dashboard/load.ts`, `src/core/dashboard/attention.ts`,
`src/components/dashboard/{types.ts,dashboard-screen.tsx,replies-list.tsx}`; tests
`tests/integration/own-mailbox/{people,retention,dashboard,list-health}.test.ts` (new), `tests/unit/dashboard/attention.test.ts`
(new cases), `tests/unit/setup-core/ui.test.ts` (profile cases), and the §9.2 updates marked P5.

**Builds:**
- `sender-addresses.ts`: `setSenderLocalPart` refuses in own-mailbox mode (`noSendingAddress`); `getSenderAddressInfo`
  returns `ownFrom` (the profile view).
- `users.ts`: `sendingDomainNames()` → the loop domains: every SendingDomain name except the active one while
  `replies = "own-mailbox"`; `queueRouteSync` returns at once in own-mailbox mode.
- Profile page, form and action: §3.7 (no address field, the From line, the test-inbox label and hint, the signature
  suffix); the action never saves a local part in own-mailbox mode.
- Limits page, its actions and the sender caps form: every active user, the "Emails show" column, the plan line and the
  field hint (`loadEffectiveMaxDailyCap()`, step C), the table from the effective cap; the cap-override check
  (`limits/actions.ts:149-150`) against the effective cap; the form's field still shows and saves the saved number.
- Team switch-off text: §3.7.
- `internalSenders()`: the evidence From (instead of `address`) and its domain.
- `health-check.ts`: the evidence From for the complaint sentence; `healthBounceNote` on bounce warnings in own-mailbox mode.
- `catch-up.ts` (`logRetentionMs`), `restore.ts` (`retentionDays`), `reconcile.ts` (`retentionMs`): `effectiveLogRetentionDays(
  saved, await loadPlanLimits())`. `catch-up.ts` passes `ownMailbox: ctx.replies === "own-mailbox"` to
  `pullSuppressions` and runs the health check once after a pull that linked an entry (O34).
- `suppressions.ts`: `removeOwnSuppression` (`:383`) queues no route sync in own-mailbox mode; `pullSuppressions`'s
  linking of new `complaints`/`bounces` entries in own-mailbox mode (§2.8, O34), inside the existing transaction, with
  `listEntryEvent` itself unchanged (a linked copy of the event is passed to `applyMailEvent`); the result gains
  `linked: number`.
- `holds.ts` (`applyOutageHold`): in own-mailbox mode (`loadTeamFrom().replies`) mark the found gap handled with nobody held
  (`heldCount: 0`), and log `[outage] own-mailbox mode: no hold` once.
- Dashboard: facts `ownMailbox: { from, inboxCheckedToday: boolean, followUpsDue: number } | null` (`followUpsDue` =
  OutboundEmail QUEUED, step ≥ 1, mode LIVE, `dueAt ≤ now + 24 h`, campaign RUNNING **or PAUSED**; `inboxCheckedToday`
  from `STATE_KEYS.inboxCheck` and today's cap day), `goLive.currentFrom = evidenceFrom`, the outage days, the warm-up
  line from `loadEffectiveMaxDailyCap()`; stored rows of another mode ignored (`checkMatchesMode`); `attentionItems` adds
  `inbox-check` (§3.9: warning, only while `!inboxCheckedToday && followUpsDue > 0`, link to the Notifications card);
  `badGoLiveRows(rows, teamFrom, opts?)` uses `goLiveRowKeys`' own-mailbox keys; `ATTENTION_TEXTS.outageHeld(people,
  days)` and `outageFound(days)` take the days. `dashboard-screen.tsx` passes `ownFrom` to `RepliesList`, whose empty
  state is `OWN_MAILBOX_TEXTS.repliesEmpty(from)` when it is set (the app-mode text unchanged).

**Tests:** words in own-mailbox mode (profile view, switch-off, limits column, plan line, field hint); `setSenderLocalPart`
refused; `checkProfileInput` accepts `contact@example.com` as the inbox in own-mailbox mode and refuses it in app mode on
example.com; no route-sync job from a profile save or a "Remove it" in own-mailbox mode; `internalSenders` includes
contact@example.com; the health bounce sentence; retention: saved 5 + own-mailbox → the catch-up's window starts 23 h
back and a 30-hour-old cursor records a gap; `applyOutageHold` holds nobody in own-mailbox mode and today's holds in app
mode; the restore scan treats a 2-day-old backup as beyond retention on free; a cap override of 95 on free refused with the
effective maximum; attention `inbox-check` for Owner and Member (warning; counts a PAUSED campaign's due follow-up; gone
after `sending.inboxCheck` is written for today; absent in app mode); the replies tile's own-mailbox empty text;
`outageHeld(…, 1)` says "more than 1 day"; app-mode texts unchanged ("more than 5 days").
integration `own-mailbox/list-health.test.ts` (O34): a LIVE email SENT to a@x.example 2 days ago with no events (the Logs
missed them); the fake's complaints list has a@x.example created yesterday → after the pull the complaint event is linked
to that email, the email's `complainedAt` is set, `loadHealthCounts` counts 1 complaint, the health check ran; a bounces
list entry the same way counts as a bounce (reason `list-bounce`); an entry for an address that already has a local
do-not-email entry, or whose last email is older than 7 days, is not linked; a Logs `complained` event for the same email
plus the list entry still count once; app mode → nothing linked (today's behaviour).

**Done when:** tests pass; the Playwright-pinned per-person texts are unchanged.

### P6 — Replies by hand: They replied and the inbox check (wave 1)

**Owned paths:** `src/server/services/companies/replied-by-hand.ts` (new), `src/server/services/mail-events/stops.ts`
(`CompanyStopInput.inboundId` optional only), `src/server/services/sending/inbox-check.ts` (new),
`src/components/company-panel/{actions.ts,company-header.tsx,company-panel.tsx,types.ts}` (and `timeline-view.ts` if it
maps activity types), `src/components/campaigns/{recipient-panel,recipient-actions}.tsx`,
`src/components/replies/{inbox-check-card.tsx,inbox-check-actions.ts}` (new), `src/components/replies/replies-section.tsx`,
`src/app/(app)/notifications/page.tsx`, `tests/integration/security/owner-actions.test.ts` (the `EVERYONE_ACTIONS` line
only), `tests/integration/own-mailbox/{they-replied,inbox-check-card}.test.ts` (new),
`tests/unit/company-panel/they-replied.test.ts` (new, static markup), `tests/unit/replies/inbox-check-card.test.ts` (new,
static markup).

**Builds:** §2.9, §3.8 and §3.9:
- `stops.ts`: `CompanyStopInput.inboundId?: number | null` (`writeStop(…, input.inboundId ?? null)`); nothing else.
- `markRepliedByHand` (one `dbTx`, `stopCompany` with the reply codes always, the `countsAsReply` rule for status and
  `repliedAt`, compare-and-set status, forward-only `repliedAt`, the two activities, `finishCheck` after the commit);
  `markRepliedAction` (`requireUserAction`, zod, revalidation, toast); `HeaderView.markReplied: { countsAsReply: boolean }
  | null` built in `company-panel.tsx` (shown when `team.replies === "own-mailbox"`, `team.address !== null` or Setting
  `practice.copy` is true, and the company isn't deleted or Do not contact); the header button (`MailCheck`) and confirm
  dialog with the body of §3.8; the person panel's button (`MarkRepliedButton` in `recipient-actions.tsx`, shown by
  `recipient-panel.tsx` under the same rule for TEST/LIVE campaigns, and for dry runs in the practice copy, with
  `personId`); `recipient-panel.tsx` hides "Simulate a reply in the dry-run outbox" in own-mailbox mode.
- `inbox-check.ts`: `markInboxChecked`, `loadInboxCheck` (§2.9); `inbox-check-actions.ts`: `markInboxCheckedAction`
  (`requireUserAction`, listed in `EVERYONE_ACTIONS`); `inbox-check-card.tsx`: the card of §3.9 (a client component for
  the button, `useTransition`, the toast; the company links; `grid-cols-1` and `[overflow-wrap:anywhere]` at 360 px).
- Notifications page: in own-mailbox mode the card goes first (id `inbox-check`, `scroll-mt-4`), the page's "You're all
  caught up." empty state isn't used while the card shows, and `RepliesSection` gets `ownFrom` for its empty text
  (`OWN_MAILBOX_TEXTS.repliesEmpty`); app mode unchanged.

**Tests:** integration `they-replied.test.ts`: a company in two running LIVE campaigns launched after go-live (one
Contacted, one already Replied from a put-back) → They replied stops both ("replied" for the named person, "company_replied"
for a colleague, `stoppedByInboundId` null), status Replied, `repliedAt` set, the person's `repliedAt` set, activities, the
campaigns finish when nothing is left; a second click stops nothing new and changes nothing; **before go-live** a test
company in a LIVE test-list campaign → its follow-up stops, its status and `repliedAt` stay as they were, the next live
test still includes it (`evaluateCompanies` doesn't leave it out), `countsAsReply: false` in the activity; after go-live a
company with nothing open → status Replied (`hasBeenLive`); in the practice copy a dry-run company → status Replied; Do not
contact refused; a person of another company refused; a Member may do it; the dashboard's reply rate (`pipeline.ts`)
counts only the `countsAsReply` clicks. Integration `inbox-check-card.test.ts`: `markInboxChecked` writes the state and the
activity, refuses in app mode; a Member may do it; `loadInboxCheck` lists companies of RUNNING and PAUSED campaigns with
LIVE follow-ups due within 24 hours, at most 20. Unit: the They replied button renders only when `markReplied` is set,
with `MailCheck`, the confirm texts per case (status changes / stays / test only), never in real per-person mode, shown in
the practice copy; the person panel without the simulate link in own-mailbox mode; the card's texts, the button label with
contact@example.com, "Nobody has read it today." and the last-read line.

**Done when:** tests pass; `owner-actions.test.ts` passes with the two new actions listed on purpose; `stopCompany`'s
existing callers and tests are unchanged.

### P7 — Owner docs (wave 2)

**Owned paths:** `README.md`, `docs/setup/2-own-mailbox.md` (new), `docs/setup/{2-mailgun-and-dns,3-cloudflare,4-going-live}.md`,
`SPEC.md` (the dated lines), `PLAN.md` (header note), `docs/dev/README.md` (one line),
`tests/unit/docs/{guide-refs,labels}.test.ts`, `tests/unit/docs/markdown.ts` (`OWNER_DOCS`),
`tests/unit/settings/m5-texts.test.ts` (only if a README sentence it reads moves).

**Builds:** §6. **Tests:** `tests/unit/docs/**` and `m5-texts.test.ts` green with the new guide registered in
`OWNER_DOCS`, `GUIDES`, `STEP_COUNTS` (16) and `TITLE_STEP`, and the new quotes (§6.5). **Done when:** every quote is
copied from §3 or `src/`; a reader following the own-mailbox guide never sees a Mailgun MX record or an SPF value to add,
never sees "npm run dev" as the way to start (only as the window to close), and meets the only DNS change (`_dmarc`)
once; the guide carries the quick path, the Test mailboxes and Pakistan sub-steps, the Remove step after the unsubscribe
click, the unsubscribe-by-email step, the inbox check and one mode switch (Live (test list only)); no `Q8`–`Q14` and no
§ reference anywhere in an owner doc; the README keeps four `###` under "Start here"; the guide-4 own-mailbox sentence is
not numbered and uses `checklistTitle(key, "polygonparadise.com")` titles.

### P8 — End-to-end test, seed, Playwright and the start scripts (wave 2)

**Owned paths:** `tests/integration/own-mailbox/end-to-end.test.ts` (new), `scripts/seed-m6-manual.ts`,
`tests/playwright/**`, `playwright.config.ts`, `scripts/run-prod.mjs`, `scripts/lib/supervisor.mjs`
(`portBusyMessage` only), `tests/unit/ops/run-prod.test.ts`, and after step C the fake Mailgun (`tests/fake-mailgun/**`,
`scripts/fake-mailgun.mjs`, `tests/integration/mailgun-client/fake-free.test.ts`).

**Builds:**
- §9.3; the seed state `own` (§9.4) whose checklist rows are built with **no public address** (webhooks and
  remote-access "info"); the Playwright instance and spec (§9.4).
- `run-prod.mjs`: a `--no-public-address` option: on another database `testRunEnv` then sets `OUTREACH_TEST_RUN=1` and
  **removes** `APP_PUBLIC_URL` from the child environment instead of adding a loopback one (the app's own database is
  refused with the option, "--no-public-address is only for test runs on another database."); `tests/unit/ops/run-prod.test.ts`
  cases for both.
- `playwright.config.ts` / `tests/playwright/instances.ts`: `E2eInstance` gains `fakeArgs?: string` (appended to the fake's
  command, `--plan free --mx-elsewhere` for `own`) and `publicAddress?: boolean` (false → no `APP_PUBLIC_URL` in the
  instance env and `--no-public-address` for the app); **every existing spec is reviewed for the `own` state**:
  `auth.spec.ts` runs in it as is; each other spec's tests get `onlyIn` guards where their data or screens don't exist in
  `own` (the manifest's `replies` field says which).
- `supervisor.mjs`: `portBusyMessage` gains, after its first sentence, "If you started the app with npm run dev, close
  that window first (click in it and press Ctrl+C)." (every mode; no test pins the text).

**Tests:** the e2e passes; `node --import tsx scripts/seed-m6-manual.ts --state all` succeeds (its address check still
accepts only example.com and `*.example`); the seed unit tests, `run-prod.test.ts` and `fake-free.test.ts` stay green.

### P9 — Integration (final, one agent)

**Owned paths:** anything needed to join the packages (reported per file), `docs/dev/CONVENTIONS.md` (new section
"Own-mailbox rules", §10.2 as bullets, the `own` commands of §9.4), `src/server/activity.ts` and
`src/server/notifications.ts` (doc comments), `tests/unit/sending-core/own-mailbox-sweep.test.ts` (new).

**Builds:** the whole suite green (`npm run check`); the worker bundle self-test; the sweeps of §9.1 ("Whole-tree
guards"); the seams: P2's `sending/load.ts` against P4's `goLiveViewFrom`/`goLiveCardView` (unchanged signatures; P2
builds its own views from `loadTeamFrom()` and `loadPlanLimits()`, never from P4's new `GateInputs` fields); P1's
`getTodayCap`, P4's go-live start cap and P5's Limits page and dashboard agree on the cap (all through
`loadEffectiveMaxDailyCap()`); P1's `inboxCheckHeldIds`, P5's dashboard item and P6's card agree on "checked today" (the
same SystemState key and cap day) and on which follow-ups count (LIVE, step ≥ 1; the gate holds only due ones, the item
and card count those due within 24 hours); P6's two actions in `owner-actions.test.ts`; P5's `badGoLiveRows` signature
against the dashboard loader; every reader of the stored checklist rows uses `checkMatchesMode`; the shared-From
vocabulary sweep (`shared-from-words.test.ts`) still green.

---

## 9. Tests

### 9.1 Coverage map

| Requirement | Test |
|---|---|
| Emails From contact@ with each person's name, no Reply-To, Message-IDs on the root | P1 unit + integration; P8 e2e |
| App mode (per-person and shared-From) unchanged | the whole existing suite (§0.2 rule 4); P2/P3/P4 "app mode identical" cases |
| The root allowed as sending domain only in own-mailbox mode | P2 unit + integration |
| polygonparadise.com's MX never Mailgun's; the app never asks for MX or an SPF value | P3 safety unit test; P8 e2e (requests and rows); the from-mx hold (P1) and notice (P3) |
| SPF read through GoDaddy's `_spfm` includes; no merged fix | P3 unit |
| No routes, no route hold, no sending address | P2 apply-routes integration; P1 sending; P5 people; P8 e2e |
| Replies that land in contact@ are never pretended to reach the app | fake `receivesMail: false` (step C); P4 reply test; P8 e2e |
| They replied stops every follow-up with the reply stop codes, writes status and `repliedAt` only for a real (post-go-live) reply, works on a company already Replied | P6 integration; P8 e2e steps 4 and 6 |
| LIVE follow-ups wait for the day's inbox check; the Owner is told; resuming doesn't bypass it | P1 integration (`inbox-check.test.ts`); P5 dashboard; P6 card; P8 e2e step 6 |
| The reply test by hand passes and fails for the right reasons (DMARC gate, the unsubscribe-by-email question); evidence belongs to the mode and the From | P4 unit + integration |
| Go-live ticks; own-mailbox rows | P4 unit + integration; P8 e2e |
| 100 a day: never planned above 90; the rolling guard (local and Mailgun's accepted events); a limit refusal to a send pauses, never fails for good; other endpoints' kinds unchanged | P1 unit (`classify-limit.test.ts`) + integration; P4 test-send; P8 e2e |
| Authorized recipients only → a clear pause that never asks to authorize a prospect | P1 unit; P4 test-send; P8 e2e |
| An interrupted launch's leftover rows never pause sending in a loop | P1 integration (`leftover.test.ts`) |
| 1-day logs: catch-up, restore, reconciler; no outage hold; list-pulled complaints and bounces count toward the health auto-pause | P5 integration (`retention`, `list-health`) |
| Stored checklist rows belong to one mode; the website domain never gets MX or SPF values | P1/P4 unit + integration (O36); P3 safety test (O37) |
| Webhooks optional; events through the Logs catch-up | P3 rows; P4 reply test (unsubscribe via catch-up); P8 e2e |
| Switching modes both ways | P2 integration; P8 e2e step 11 |
| Owner-only, zod, no network in a transaction | `owner-actions.test.ts`; code review |
| Docs | P7 docs tests |
| Fake Mailgun's free-plan behaviour | `fake-free.test.ts` (step C) |
| Screens | P8 Playwright + axe (lead runs; the `own` instance has no public address, so the info rows, "No public address yet" and go-live without webhooks show); static-markup renders of a red own-mailbox from-mx row (P3/P4), which fake mode can't show |
| **Whole-tree guards** (P9 `own-mailbox-sweep.test.ts`) | (1) `mailgun.replies` appears as a string literal only in `server/settings.ts`, `services/mailgun/{team-from,plan,connect}.ts`, tests, seeds; (2) `validateTeamFromAddress(` is called only in `core/sending/{from-address,own-mailbox}.ts` and `services/mailgun/team-from.ts` (writers use `validateFromAddressFor`); (3) every function of `OWN_MAILBOX_TEXTS`, `OWN_REPLY_TEST_TEXTS`, `THEY_REPLIED_TEXTS` and `INBOX_CHECK_TEXTS`, called with sample values, says neither "reply address", "sending address" nor "reply route", and none but `repliesAppHint` contains "mail.polygonparadise.com" (nor do `SENDING_DOMAIN_TEXTS.www`, `.emptyOwn`, `.invalidOwn`, `.sandboxOwn`, `.sharedOwn`); (4) `new MailgunClient(` in `src/server/mailgun/context.ts` passes `ownMailboxFrom`; (5) `"sending.maxDailyCap"` is read only in `server/settings.ts`, `services/mailgun/plan.ts`, `settings/limits/{page,actions}.ts` (the form's value and save) and tests; (6) `classifyStatus(` with `send: true` appears only in `server/mailgun/client.ts`; (7) `STATE_KEYS.inboxCheck` is written only in `services/sending/inbox-check.ts` |

### 9.2 Existing tests that change

| Test | Change | Package |
|---|---|---|
| `tests/unit/setup-core/sender-address.test.ts:75-77` | pins the `.website` sentence as a literal: the literal becomes the new sentence **in step C**, with the constant; P2 adds the own-mailbox cases | step C, then P2 |
| `tests/integration/mailgun-setup/connect.test.ts:131-133` | the same literal, updated **in step C** | step C |
| `docs/setup/2-mailgun-and-dns.md:114` (read by `labels.test.ts:363`, which compares it with the constant) | the quote updated **in step C**, so the docs test stays green until P7 | step C, then P7 |
| `tests/unit/notifications-core/notification-types.test.ts:45-51` | the reply pop-up group's list gains `reply.inboxCheck` | step C |
| `tests/unit/settings/*` render tests of the connection form, if any | the two new controls and the retention hint | P2 |
| `tests/unit/sending/gates.test.ts`, `tests/integration/sending-m3/gates.test.ts` | `GateContext` literals gain `ownMailbox: false`, `planLeft: null`, `planOpensAt: null`; `TickPlan` gains `inboxHeld: null` | P1 |
| `tests/unit/sending-core/mode-gates.test.ts` | unchanged (new cases live in `mode-gates-own.test.ts`) | P4 |
| `tests/unit/mailgun-client/**`, errors tests | unchanged: the limit rule applies only with `{ send: true }` and to 400/403, so a send case whose 400 text has the limit words, if any, becomes "limit" | P1 |
| `tests/integration/security/owner-actions.test.ts` | `EVERYONE_ACTIONS` += `markRepliedAction`, `markInboxCheckedAction` | P6 |
| `tests/unit/dashboard/attention.test.ts` | the outage texts take days (5 in today's cases) | P5 |
| `tests/unit/docs/{guide-refs,labels}.test.ts`, `tests/unit/docs/markdown.ts` | the new guide (in `OWNER_DOCS` too); new quotes | P7 |
| `tests/playwright/{instances,manifest,fake-check}.ts`, `playwright.config.ts`, every spec (`onlyIn` guards for `own`) | the `own` state | P8 |
| `tests/unit/ops/run-prod.test.ts` | `--no-public-address` cases | P8 |
| any test building `TeamFromState`, `MailgunContext` or `DomainCheckState` literals | the new fields (`replies: "app"`, `ownFrom: null`, `evidenceFrom` = `address`, `ownMailboxFrom: null`; `DomainCheckState` fields are optional) | step C (type fixes only) |
| fake tests of `plan`/presets | unchanged by default (`receivesMail` true, plan foundation) | step C |

### 9.3 The end-to-end test of the owner's shape (P8, `tests/integration/own-mailbox/end-to-end.test.ts`)

Fake Mailgun `{ domain: "example.com", region: "US", plan: "free", receivesMail: false }`; an injected DNS table (both
resolvers):

| Name | Answers |
|---|---|
| example.com | MX `10 mx.provider.example`; TXT `v=spf1 include:dc-1._spfm.example.com include:dc-2._spfm.example.com ~all`, `google-site-verification=abc` |
| dc-1._spfm.example.com | TXT `v=spf1 include:_spf.provider.example ~all` |
| dc-2._spfm.example.com | TXT `v=spf1 include:mailgun.org ~all` |
| _spf.provider.example | TXT `v=spf1 ip4:192.0.2.20 ~all` |
| mailgun.org | TXT `v=spf1 include:_spf.mailgun.org ~all` |
| _spf.mailgun.org | TXT `v=spf1 ip4:192.0.2.40 ~all` |
| pdk1._domainkey.example.com | the fake's DKIM value |
| email.example.com | CNAME `mailgun.org` |
| _dmarc.example.com | `v=DMARC1; p=none` |

1. The Owner connects through `connectMailgunAction({ region: "US", domain: "example.com", apiKey, replies: "own-mailbox" })`
   and saves `contact@example.com` through `saveFromAddressAction`; the connect set the plan to Free with 1/1 days (O22).
   No SenderAddress exists; no route-sync job; `loadTeamFrom()` gives `ownFrom` contact@example.com, `address` null.
   `APP_PUBLIC_URL` is empty (the integration default): Live mode and the reply test are allowed without it, the webhooks
   and remote-access rows are "info", Apply's public-address step says `applyNoPublicAddress`, and `goLiveRowKeys` for the
   gate has neither `webhooks` nor `remote-access`.
2. Domain check → spf ok ("5 of 10" with this table), dkim ok, from-mx ok (titled "Mail for example.com stays with your
   mail provider (MX)"), dmarc ok; no `mx`, `spam-filter`, `retention`, `reply-routes`, `from-spf` rows; the stored state
   has `replies: "own-mailbox"` and `lastGoodMx` `[{ priority: 10, host: "mx.provider.example" }]`. With example.com's MX
   switched to `mxa.mailgun.org`: from-mx bad, its fix names `mx.provider.example (priority 10)` and ends with
   `NEVER_MAILGUN_MX_TEXT`, `liveModeBlockers`, `replyTestBlockersFor` and `goLiveBlockersFor` name it, one `from-mx-bad`
   notification with `mxBodyOwn`, a LIVE email waits `main-domain-mx`; switched back. With `dc-2._spfm.example.com`
   removed: spf bad ("includes dc-2._spfm.example.com, which has no SPF record"), no fix contains `v=spf1`; restored.
   With `_dmarc.example.com` removed: `replyTestBlockersFor` names `dmarcFirst`; restored.
3. Apply (fake) → no `/v3/routes` request at all, no spam-action or `message_ttl` PUT, the certificate 402 → https-links
   "info"; the `routes`, `spam-filter`, `retention` steps say "Not needed: replies go to your own mailbox.".
4. The reply test (mode Live (test list only)): emails From "Arslan from Polygon Paradise <contact@example.com>", no
   `h:Reply-To`, `TestSend.teamFrom` = contact@example.com; a `reply` preset → `deliveredTo: "outside"`, nothing stored;
   answers (placement Yes for Gmail, No for Outlook; inbox Yes; DMARC pass by a pasted Gmail header); a pasted original
   (Return-Path `bounce+x@example.com`, `dkim=pass header.d=example.com`, `dmarc=pass`, `List-Unsubscribe:
   <mailto:u+x@example.com>, <http://email.example.com/u/x>`) stored with `unsubscribeScheme: "http"` and
   `mailtoAddress: "u+x@example.com"`; decide with `mailtoArrived` unanswered → incomplete, No → failed with
   `mailtoFailed`, Yes → on; an unsubscribe on the fake read by `runCatchUp` → `unsubscribeSeen`; decide → passed with
   `replies: "own-mailbox"`, `from: contact@example.com`.
5. A LIVE campaign to the test list (before go-live, with a follow-up, `daysAsMinutes`), delivered (fake `deliver`, read by
   the catch-up). **Rehearsal**: They replied on the first test company → its follow-up SKIPPED, recipient STOPPED
   `replied`, status and `repliedAt` unchanged; the second test company's follow-up waits `inbox-check` and one
   `reply.inboxCheck` notification reaches the Owner; `markInboxChecked` → it goes. Then `goLive()` without ticks refused
   (`ownMailboxRequired`), with the replies tick only refused (`httpLinksRequired`), with both and the spam tick → live,
   `sending.goLiveFrom = contact@example.com`. A new live test to the test list still includes the first test company.
6. A LIVE campaign with one follow-up to three checked prospects: path `/v3/example.com/messages`, no `h:Reply-To`,
   `h:Message-Id` `@example.com`. The follow-ups wait `inbox-check` until `markInboxChecked` is called after the first
   emails went (a check made before them doesn't count). Prospect 1's `reply` preset → outside, nothing stored, its
   follow-up still QUEUED; `markRepliedByHand` for its company with its person → recipient STOPPED `replied`, follow-up
   SKIPPED, company Replied, `repliedAt` set. The same company also in a second running campaign (put back by hand,
   status already Replied) → a second They replied stops it there too (`company_replied` for a colleague). Prospect 2: a
   permanent `failed` event read by the catch-up → bounced, suppression, stopped. Prospect 3: an unsubscribe event →
   suppression, stopped. `SendingDomain(example.com).lastLiveSendAt` set.
7. The daily limit: 89 counted Mailgun sends of the last 24 hours are written directly; one more TEST email goes (90),
   the next waits `plan-limit`; "Send me a test" still goes (room for tests) until 100; a `fail-next` 400 with the fake's
   limit text on a LIVE email → paused (`mailgun-not-allowed`, the plan reason), the email back in the queue, never FAILED;
   the same text on an address-check call → today's kind, no sending pause.
8. Authorized recipients: the fake restarted with `authorizedRecipients` = the test list; a LIVE email to a prospect → 403 →
   paused with `PLAN_TEXTS.authorizedOnlyCampaign` (no "Authorized recipients" advice); nothing FAILED for good.
9. Safety: no request the fake received has a path under `/v3/routes`; no stored checklist row has an MX record box;
   `SenderAddress` count 0; every sent message's `from` is exactly the own From line and none has `h:Reply-To`.
10. Retention: `mailgun.logRetentionDays` = 5 saved; the catch-up's Logs window starts 23 hours back; a 30-hour-old cursor
    records an outage gap and `applyOutageHold` holds nobody; a complaint added to the fake's complaints list for a
    prospect emailed yesterday, with no Logs event, is linked by the pull and counted by `loadHealthCounts`.
11. Switching back: the fake also answers `send.example.com` (`otherDomains`); reconnecting with `replies: "app"` and
    `send.example.com` is refused while the LIVE campaign runs; after cancelling it: go-live ended, the reply test reset,
    `contact@example.com` still saved and now the shared From (`address` set), the stored own-mailbox rows no longer pass
    any gate (O36), `liveModeBlockers` names the `mx` row again after the next check (app mode's DNS gate), no LIVE
    follow-up waits `inbox-check` any more, and the dashboard's `go-live-again` item shows.

### 9.4 Playwright and the seed (P8; the lead runs them)

- **Seed state `own`** (`scripts/seed-m6-manual.ts --state own`, also part of `all`; `data/manual-check/m6-own.db` and
  `m6-own.json`): settings `mailgun.domain = "example.com"`, `mailgun.region = "US"`, `mailgun.replies = "own-mailbox"`,
  `mailgun.plan = "free"`, `mailgun.logRetentionDays = 1`, `mailgun.fromAddress = "contact@example.com"` written before
  the checklist state with its `updatedAt` backdated to before `checkedAt`; one SendingDomain `example.com`; no
  SenderAddress; the checklist rows from `buildChecklistRows` with own-mailbox facts and **no public address** (all ok,
  https-links "info" not-in-plan, webhooks and remote-access "info"), stored with `replies: "own-mailbox"` and a
  `lastGoodMx`; the reply test passed (`replies: "own-mailbox"`, `from`, an `original` with `unsubscribeScheme: "http"`
  and a `mailtoAddress`, `mailtoArrived: true`) with its `TestSend` rows (`teamFrom`); a delivered live test; go-live
  **off** (so the dialog and its ticks can be seen); one RUNNING LIVE campaign to test-list recipients with follow-ups due
  within 24 hours and no inbox check today (the dashboard item and the Notifications card); a company with a queued
  follow-up (They replied). The manifest gains `replies: "own-mailbox" | "app"`.
- **Instance** `own` in `tests/playwright/instances.ts`: port 3105, fake 4013 started with `--domain example.com --region
  US --plan free --mx-elsewhere` (`fakeArgs`), worker on, no DKIM authority, `publicAddress: false` (the app is started
  with `--no-public-address` and no `APP_PUBLIC_URL`, like the owner's PC); `fake-check.ts` refuses a reused 4013 fake whose
  `/__fake/state` doesn't say `receivesMail: false` and `plan: "free"` ("The fake Mailgun on 4013 wasn't started with
  --plan free --mx-elsewhere. Stop it and run again."). `E2E_STATES` gains `own`, and every existing spec is guarded for it
  (P8).
- **Spec** `tests/playwright/own-mailbox.spec.ts` (state `own`, phone and laptop): Settings › Sending & Mailgun shows "How
  the app sends" with "From polygonparadise.com itself (replies come to your own inbox)" chosen, "Your Mailgun plan" =
  Free, the own From card with "Good to know"; the Domain checklist has no "Replies reach the app (MX)", shows "Mail for
  example.com stays with your mail provider (MX)" done and "Mailgun may send for example.com (SPF)" done, the https,
  webhooks and remote-access rows grey, the own-mailbox Apply hint; the reply test section asks "Did your reply arrive in
  contact@example.com?" and the unsubscribe-by-email question, and shows no Setup switch; the go-live dialog (390 px full
  screen) keeps **Go live** disabled until both ticks are ticked (checked, then closed without going live); a company
  panel shows **They replied** and its confirm dialog (closed without confirming); a campaign page shows the reminder and
  the link to the inbox check; the wizard's Sender step shows "<contact@example.com>" and no address; My profile shows no
  address field and "Inbox for your test emails"; the dashboard shows the inbox-check item (warning) and the own-mailbox
  replies tile text; Notifications shows the Inbox check card with the company list and the button (not clicked); axe on
  each; screenshots to `test-results/shots/`.
- Commands (also in CONVENTIONS, P9):
  ```powershell
  node --import tsx scripts/seed-m6-manual.ts --state own
  node scripts/fake-mailgun.mjs --port 4013 --app http://127.0.0.1:3105 --domain example.com --region US --plan free --mx-elsewhere --settings-applied
  $env:PP_E2E_STATE = "own"; npm run test:e2e
  ```
  The other states are unchanged (ready and live stay shared-From, busy per-person). Review SCREENS-12 / SECURITY-01:
  `--settings-applied` starts the fake with tracking off and unsubscribe handling on (what the seeded Apply run records),
  `E2E_INSTANCES.own.fakeArgs` carries it, `fake-check.ts` refuses a reused 4013 fake without it and the seed checks the
  instance's arguments; the go-live test may skip only when the one blocker is `checkStale`, and the own screens assert
  that no pause is shown.

### 9.5 Step S — the lead's manual checks (fake only)

1. `own` instance: Settings › Sending & Mailgun (both controls, the From card), the Domain checklist (rows, header line,
   Apply hint), My profile, the wizard's Sender step, a campaign page, the dashboard, Notifications (the Inbox check card).
2. `POST /__fake/inbound {"preset": "reply", "inReplyTo": "<a sent id>", "notify": true}` → `"deliveredTo": "outside"`,
   nothing in the app; then **They replied** on that company → the person's follow-up shows "Stopped: they replied"
   (before go-live the company's status stays as it was).
3. The inbox check: the campaign page's waiting line says "Waiting for today's inbox check (Notifications › Inbox
   check)."; **I've read contact@example.com** on the card → the follow-up goes; the Activity page names who clicked.
4. "Send me a test" → the fake's message From contact@example.com without `h:Reply-To`.
5. `POST /__fake/fail-next` with the limit 400 on `POST /v3/:d/messages` → the Sending page's pause card shows the plan
   sentence; Resume.
6. The practice copy (`start-demo.bat` against a copy): the connection card isn't shown there (practice sentence), the
   company panel shows **They replied** and it stops that company's follow-ups.
7. start.bat's port message, with something already listening on the port (a scratch `node -e` server on a spare port
   and `--port` to match, never 3000): it names `npm run dev`.

The owner's own first real checks (own-mailbox guide steps 7–10): the SPF and MX rows green on the real DNS; the reply
test's pasted original (Return-Path on polygonparadise.com, DMARC pass, signed by polygonparadise.com, the unsubscribe
link's scheme and mailto host); where an out-of-office lands; whether "Send me a test" to contact@ arrives.

---

## 10. Risks, decisions, owner-visible changes and the definition of done

### 10.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A reply in contact@ isn't marked before the next follow-up | a follow-up to someone who answered: annoyance, a complaint against the everyday domain | **the inbox check (O33)**: no LIVE follow-up goes until someone has read contact@ (inbox and Spam) that cap day, after that person's last email, and clicked I've read contact@polygonparadise.com; a resumed campaign's overdue follow-ups meet the same gate; one bell notification a day, the dashboard's warning item and the Notifications card list what waits; They replied (one click, everyone); the go-live tick; guide step 12. What's left: a reply that lands between the day's check and a follow-up sent later that same day (a few hours out of the days between steps), and a reply someone reads but doesn't mark |
| Nobody does the inbox check (a holiday, a forgotten day) | live follow-ups wait; first emails to companies nobody emailed before today still go (review SEND-1) | safe by design; the daily notification and the dashboard item; the waiting line names it; held rows never crowd first emails out of the candidate query (SEND-3) |
| `mailto:` unsubscribes lost at Zoho | an unsubscribe by email ignored (legal risk), follow-ups to someone who asked to stop | **the reply test fails until an email to the `mailto:` address reaches a mailbox someone reads** (O13; Zoho's catch-all, §3.5); Mark unsubscribed by hand; the link in the body and the header still reach Mailgun |
| Zoho's plan offers no catch-all | the reply test can't pass, so live campaigns can't start | guide step 1 turns the catch-all on before any setup work; the fix sentence names the aliases `u@`/`bounce@` next (the test shows whether Zoho's sub-addressing delivers `u+…@` to `u@`), then **Leave out unsubscribe by email** (review REPLIES-03: built, self-checking; §1.6, §3.5, §13); §11 Q6 |
| Late bounces lost at Zoho (no catch-all) | dead addresses emailed again; the bounce brake undercounts | the catch-all the reply test asks for also catches `bounce+…@`; Mark unsubscribed on a "couldn't be delivered" notice; immediate bounces still reach Mailgun; address checks before live sends (M5); the own-mailbox bounce sentence; 100 a day at most |
| The root's MX pointed to Mailgun by mistake (GoDaddy's "@" default, a copied box from guide 2), or Cloudflare Email Routing switched on | everyday mail and replies lost | no MX box anywhere in this mode; the guide names only Zoho's MX, for putting back; from-mx red blocks, holds and notifies (O10), its fix names the last good MX the app saw and ends with "Never add Mailgun's MX records…"; the website-domain guard in app mode too (O37) |
| The SPF record edited wrongly (a second record, over 10 lookups) | SPF fails for Zoho and the app | no SPF value is ever shown; the row is red and gates Live and go-live; "ask the person who set up the app" |
| Mailgun's 100 a day counted differently (UTC day, test mode, refused messages, other senders on the account) | refusals | the rolling 24-hour guard at 100 (campaigns at 90), counting Mailgun's own `accepted` events when they are more; a refusal with limit words pauses instead of failing (O24); an unknown text fails at most 3 emails before the rejection breaker pauses (Retry sends them again); §11 Q1 |
| Free account limited to authorized recipients | every prospect refused after go-live | a clear pause sentence that only suggests a payment card (O25: authorizing a prospect would make Mailgun email them); guide step 1 and the go-live recommendation `authorizedCheck`; the live test to the test list passes either way, so it can't reveal it: §11 Q2 |
| An interrupted launch leaves Message-IDs of another domain | the own-mailbox sender check pauses sending in a loop | leftover ids renewed (O35); a row blocked twice fails "Didn't send" instead of pausing again |
| http unsubscribe links | Gmail/Yahoo may not show their unsubscribe button; people press "Report spam" instead | honest row and tick (O20); far below the 5,000-a-day bulk line; the link in the footer works; upgrade path |
| 1-day logs and a PC off for a weekend | events of that time not read | suppressions come back through Mailgun's lists, and new complaint and bounce entries are linked to the email they concern so the health auto-pause counts them (O34); retention set to 1 so gaps are recorded; no outage hold (O27), the inbox check covers the replies; guide step 13 (keep start.bat running, weekends too if possible) |
| The owner keeps using `npm run dev` | nothing sends, no checks, no catch-up | the guide's first step and troubleshooting; the existing worker-down notices and the go-live `workerRunning` blocker |
| Apply changes the root's Mailgun tracking settings | another tool that sends through Mailgun as polygonparadise.com would get Mailgun's unsubscribe handling | guide step 2 asks first; §11 Q9 |
| An own-mailbox snapshot retried after switching back to app mode | a LIVE email waits on the reply-route hold for ever; a TEST email goes (test list only) | accepted: the switch is rare and refused while campaigns run; the waiting line names the route hold |
| Mailgun reports the root not "active" (MX unverified) | the mailgun-domain row red, Live blocked | screenshots show it verified; §11 Q8; the row's text says what Mailgun says |
| Address checks not in the Free plan | live campaigns after go-live email only checked addresses | the `checksFree` recommendation (review SCREENS-01: optional but paid, try one check, add Email Validations in Mailgun if refused); own guide step 10 tries one check. No other checker exists (an earlier version of this row said otherwise) |
| "Send me a test" from contact@ to contact@ hidden by Zoho | the owner thinks sending is broken | the self note; guide troubleshooting: use a Gmail test inbox |
| Wording drift between modes | confusing screens | contract text objects; P9 sweep; P2/P4 "app mode identical" render tests |

### 10.2 Technical decisions the lead confirms

1. **D1 — One flag, Setting `mailgun.replies`** (`"app"` default), written only by `saveConnection`, read only through
   `loadTeamFrom`, `loadPlanLimits`, `getMailgunContext` (`repliesOf`) (O1); a mode switch is a domain change (O2).
2. **D2 — The own From is `mailgun.fromAddress`**, validated by `validateFromAddressFor` (O3); `TeamFromState.address` stays
   shared-From only; `ownFrom` and `evidenceFrom` are new (O4).
3. **D3 — No migration** (O31).
4. **D4 — Headers from `ownMailboxHeaders` only; no Reply-To; no SenderAddress; no routes** (O5, O8, O9).
5. **D5 — Fail closed** in the transport and the client with `ownMailboxFrom` (O6); the launch re-check covers the mode.
6. **D6 — The root's sending allowed only in own-mailbox mode** (O7).
7. **D7 — Checklist**: no `mx`/`spam-filter`/`retention`/`reply-routes`/`from-spf`; from-mx for the sending domain with
   the hold and notice; include-aware SPF gate with no box; info rows for plan and public-address limits (O10–O12).
8. **D8 — The reply test by hand**, stored with `replies: "own-mailbox"` (O13); evidence by `evidenceFrom` (O15).
9. **D9 — Go-live**: own-mailbox rows and two server-checked ticks (O14).
10. **D10 — They replied** as the one new door for replies by hand, open to Members (O17).
11. **D11 — Plan setting and limits**: `mailgun.plan`, `planLimits`, `effectiveMaxDailyCap`, the rolling guard, the
    "limit" kind, the authorized-only sentence, `effectiveLogRetentionDays` (O22–O26).
12. **D12 — Webhooks optional in own-mailbox mode; no outage hold** (O21, O27).
13. **D13 — The deliberate app-mode changes of O30**.
14. **D14 — The inbox check** (O33): SystemState `sending.inboxCheck`, WaitReason `inbox-check`, notification type
    `reply.inboxCheck`; no setting turns it off.
15. **D15 — The reply test proves the `mailto:` path and waits for DMARC** (O13, O38).
16. **D16 — Leftover ids renewed, a row blocked twice fails** (O35); **list-pulled complaints and bounces linked** so the
    health auto-pause counts them (O34).
17. **D17 — Stored checklist rows belong to one mode** (`DomainCheckState.replies`, O36); **the website domain never gets
    receiving DNS advice in any mode** (O37); the last good MX is stored for the from-mx fixes (O10).

### 10.3 For the owner: changes you should know about (plain words)

1. **Your emails come from contact@polygonparadise.com**, with each person's name ("Arslan from Polygon Paradise"), sent
   through polygonparadise.com itself on Mailgun's Free plan. Nothing to buy, no subdomain.
2. **Replies never reach the app.** They land in contact@ (Zoho), sometimes in its Spam folder. When someone answers,
   open their company and click **They replied**: it stops every follow-up to that company (once you're live it also
   sets the company to Replied and counts in the dashboard's reply rate; before that, test companies keep their status).
3. **Live follow-ups wait for your daily inbox check.** Every working day, read contact@ (inbox and Spam), click They
   replied where someone answered, then click **I've read contact@polygonparadise.com** (Notifications › Today's inbox
   check). Until someone clicks it that day, live follow-ups wait, and so do first emails to a company that was already
   emailed before today (a colleague may have answered); first emails to companies nobody emailed before still go. A bell notification and a
   dashboard item tell you when follow-ups are waiting. Anyone on the team who reads contact@ may click it.
4. **"Please remove me", unsubscribe emails and "couldn't be delivered" notices** also land in contact@: click ⋯ ›
   **Mark unsubscribed** on that person (or set the company to Do not contact). Out-of-office replies need nothing.
5. **The reply test is by hand** and now includes one extra step: from a test mailbox, send an email to the
   unsubscribe-by-email address the app shows. If it bounces, turn on a catch-all in Zoho (Admin Console › Domains ›
   polygonparadise.com › Catch-all Address, delivering to contact@polygonparadise.com), or add `u@` and `bounce@` as
   aliases of contact@. The test can't pass until that email reaches a mailbox you read, because otherwise people who
   unsubscribe that way would be ignored; if nothing works, **Leave out unsubscribe by email** makes your emails offer
   only the link, and the test then checks that. It also waits until the DMARC row is done.
6. **Some things are still lost or only partly seen**: bounces that come later and out-of-office replies reach contact@
   only through that catch-all, never the app, so the app's bounce count can be lower than the real one.
7. **Never touch polygonparadise.com's MX or SPF records**, and never switch on Cloudflare Email Routing for it. The only
   DNS record to add is `_dmarc` (`v=DMARC1; p=none`). If the MX ever points to Mailgun (or Cloudflare), live emails wait,
   the app tells you and names Zoho's records to put back.
8. **Mailgun Free**: at most 90 campaign emails a day (10 are kept for tests), never more than 100 emails in 24 hours; 1 day
   of logs; unsubscribe links use http (they work, but Gmail's and Yahoo's one-click button may not show).
9. **Always start the app with start.bat**, never `npm run dev`: close the `npm run dev` window first (Ctrl+C); the
   first start builds for a few minutes. Without the background sender nothing is sent, checked or heard from Mailgun.
   Keep the office PC on during working days, and over weekends if you can.
10. **Remote access (Cloudflare) is optional** in this setup: Mailgun's reports arrive through the hourly check.
11. **Going live asks for two ticks**: that you read contact@ (inbox and Spam) every working day, click They replied and
    then I've read contact@polygonparadise.com; and that unsubscribe links use http on your plan.
12. **In Settings › Sending & Mailgun** there are two new controls: **How the app sends** (choose **From
    polygonparadise.com itself**) and, under Advanced, **Your Mailgun plan** (the app sets Free by itself when you
    connect).
13. **To move to the full setup later**: the own-mailbox guide's step 15 (Mailgun Foundation, mail.polygonparadise.com,
    How the app sends = Through a sending subdomain; contact@ stays your From address).

### 10.4 Definition of done

| Requirement | Evidence |
|---|---|
| Emails From contact@polygonparadise.com with each person's name, no Reply-To, sent through polygonparadise.com | P1 tests; P8 e2e steps 4–6 |
| No route, no sending address, no MX or SPF value ever asked for; the root's MX guarded (hold + notice) | P2, P3 safety tests; P1 hold; P8 e2e steps 2, 3, 9 |
| They replied stops follow-ups (also for a company already Replied) and writes `repliedAt` | P6 integration; P8 e2e step 6 |
| The by-hand reply test (DMARC first, the unsubscribe-by-email question) and go-live with ticks | P4 unit + integration; P8 e2e steps 2, 4–5 |
| LIVE follow-ups wait for the day's inbox check, resumed campaigns included; one notification a day | P1 `inbox-check.test.ts`; P5, P6 tests; P8 e2e steps 5–6 |
| An interrupted launch never pauses sending in a loop; list-pulled complaints and bounces count | P1 `leftover.test.ts`; P5 `list-health.test.ts`; P8 e2e step 10 |
| Stored rows of another mode never pass a gate; the website domain never gets an MX box or SPF value | P1/P4 tests (O36); P3 safety test (O37); P8 e2e step 11 |
| Free plan: 90/100, rolling guard, limit and authorized-only pauses, 1-day logs, no outage hold, http links honest, webhooks optional | P1, P4, P5 tests; P8 e2e steps 7, 8, 10 |
| App mode unchanged except O30 | the whole existing suite green (P9) |
| Owner-only, zod, no network in a transaction; They replied open to Members on purpose | `owner-actions.test.ts`; code review |
| Docs follow the owner's real setup | P7 docs tests; the lead's read-through |
| Type-check, lint, tests | P9 `npm run check` |
| Build and screens | step S: `next build`, worker bundle, Playwright + axe for `own` (and the other states unchanged) |

---

## 11. Open questions (for Mailgun support, Zoho or the owner's first test; the app never probes)

1. **Free plan's daily limit**: which HTTP status and text Mailgun answers past 100 a day; whether the day is UTC or
   rolling; whether test-mode messages and refused messages count. (The rolling guard should keep the app below it. If
   Mailgun refuses anyway: a 400/403 whose text has limit words pauses with the plan sentence; a 403 without them reads
   as "auth" and pauses with the key sentence; a 400 without them is "rejected", fails that email for good and stops the
   person, and the rejection breaker pauses sending after 3 such refusals within 30 minutes, with Mailgun's text in the
   pause; those emails can be sent again with Retry after Resume.)
2. **Authorized recipients**: does this owner's Free account (no card on file?) send only to authorized recipients?
   (Account settings; guide step 1.)
3. **https tracking on Free**: does `POST /v2/x509/email.polygonparadise.com` answer 402? (Apply finds out; the row is
   honest either way.)
4. **Mailgun's List-Unsubscribe on Free with http links**: does it still add `List-Unsubscribe-Post`, and is the mailto
   `u+…@polygonparadise.com`? (The pasted original shows it.)
5. **Logs retention on Free**: 1 day (pricing) or "at least 2 days" (tracking page)? The app plans with 1.
6. **Zoho**: is a catch-all address set, so that `bounce+…@` late bounces and `u+…@` unsubscribe emails reach a person?
   Does the owner's Zoho plan offer one at all (Zoho's help page gives the steps, Admin Console › Domains › the domain ›
   Advanced Settings › Catch-all Address, but not the plans; UNVERIFIED)? The reply test finds out whether the `mailto:`
   address reaches a mailbox. Does Zoho show "Send me a test" from contact@ to contact@ through Mailgun? Since review
   REPLIES-03 there is a way forward either way: the aliases `u@`/`bounce@` (whether Zoho's sub-addressing delivers
   `u+…@` to `u@` is UNVERIFIED; the test shows it), then **Leave out unsubscribe by email** (whether Mailgun fills in
   `%unsubscribe_url%` inside an `h:` header is UNVERIFIED: Mailgun documents it for the body only; the pasted original
   proves it, and the test fails with `leftOutNoLink` when it isn't filled in).
7. **Where out-of-office replies land** (Return-Path at Zoho → rejected or catch-all; From → contact@). Guide step 9 asks
   the owner to note it.
8. **Mailgun's domain state** for polygonparadise.com with its MX "unverified": "active"? (The screenshots say verified.)
9. **Other Mailgun senders on polygonparadise.com** (website forms, another tool)? Apply turns open/click tracking off and
   Mailgun's unsubscribe handling on for every Mailgun email from the domain.
10. **Address checks on Free** ("Email Validations: Available as add-on"): does a Mailgun validation call work on this
    account without the add-on?

---

## 12. Critique decisions

Two reviews of the first version (2026-09-28): a safety review (S1–S11) and an owner/buildability review (B1–B29).
Every point is below with its decision, the reason, and where the body now carries it. "Accepted" = every proposed fix
is in the body; "In part" names what was left out and why; "Rejected" gives the reason. Each code claim of both
reviews was re-read against the tree before deciding (`launch.ts:826-836`, `loop.ts:99-101,452-476,607-666,960-986`,
`errors.ts:120-139`, `mailgun-transport.ts:245-269`, `control.ts:503-528`).

### 12.1 Safety review

| # | Point | Decision | Why, and where in the body |
|---|---|---|---|
| S1 | Nothing stops a follow-up to someone who replied; only reminders | **Accepted** (the strong fix, not the minimum) | O33 (§2.9, §3.9, P1, P5, P6): LIVE follow-ups (step ≥ 1) wait `inbox-check` until `sending.inboxCheck.at` lies in today's cap day and after that person's last SENT email; the click "I've read contact@polygonparadise.com" is open to everyone and logged (the outage-release pattern); the dashboard item is warning tone, counts PAUSED campaigns and links to the Notifications card, which lists the companies; one bell notification a day (Replies group, on by default); "and its Spam folder" is in `followUpReminder`, `goodToKnow`, the item, the card, the notification and the go-live tick. **Not built: a separate Resume confirmation**, because a resumed campaign's overdue follow-ups meet the same gate (`inbox-check.test.ts` pins it), so a Resume tick would only repeat it (§1.6). O27's outage hold is replaced by the inbox check, which covers every day, gap or not. |
| S2 | Unsubscribe-by-email requests and late bounces lost, while three texts say they arrive | **In part: the `mailto:` fix accepted and made a hard gate; the Return-Path step and the go-live-tick fallback rejected** | O13, §3.5: the pasted original's whole `mailto:` address is stored (`mailtoAddress`) and the reply test asks the owner to email it from a test mailbox; No **fails** the test with the catch-all fix (Zoho's exact menu path, quoted from Zoho's help page; plan availability UNVERIFIED, §11 Q6). The three texts now claim only what the test proves (`goodToKnow[3]`, `mailtoNote`, `mailtoOwn`), and `mailtoOk` is no longer the only check. **Rejected: a third go-live tick "unsubscribe emails are lost"**: a knowingly broken opt-out path is a legal risk nobody should be able to tick past; if Zoho can't catch the address, the way out is the deferred app-built `List-Unsubscribe` without the `mailto:` (§1.6, risk row in §10.1). **Rejected: a by-hand Return-Path step**: late bounces and out-of-office replies are information, not a request the sender must honour; the catch-all the `mailto:` fix requires also catches `bounce+…@`, and guide step 9 already asks the owner to note where an out-of-office landed. |
| S3 | Leftover rows of an interrupted launch keep a foreign Message-ID, pausing sending in a loop | **Accepted, with a narrower renewal rule** | Confirmed at `launch.ts:832` and `loop.ts:659-663`. O35, §2.3: the id is renewed when the snapshot is own-mailbox (any launch mode) or has a Reply-To and the id's domain differs. Not "whenever mode ≠ DRY_RUN": per-person mode is sacred (§0.2 rule 4) and its transport never checks the id's domain (`mailgun-transport.ts:260-269` checks only shared-From), so it can't loop. A row blocked twice for its sender headers fails "Didn't send" (`senderBlockedTwice`) instead of pausing again. Test: `leftover.test.ts` (interrupted DRY_RUN, then a LIVE own-mailbox relaunch). |
| S4 | The O25 fix text tells the Owner to authorize prospects | **In part: the texts accepted; the go-live confirmation made a recommendation** | O25, §2.8: `authorizedOnlyCampaign` suggests only a payment card; `authorizedOnlyTest` (test sends, the reply test) may also suggest authorizing the test mailbox; `plainMailgunError` without context uses the campaign sentence. Guide step 1 says never to authorize a prospect. A go-live **tick** is not added: the owner can't check the restriction in the app, and its only effect is a clean pause with the right fix and nothing failed for good, so it is the go-live recommendation `authorizedCheck` (O14) plus guide step 1. |
| S5 | The "limit" rule in the shared `classifyStatus` changes every Mailgun call | **Accepted** | O24, §2.8, §7.5: the rule runs only with `{ send: true }` (set by `MailgunClient.sendMessage` alone) and only for 400/403; every other endpoint keeps today's kinds. P1's `classify-limit.test.ts` pins the non-send cases and the app-mode answers of the verifier's `failureKindOf` and the catch-up's `catchUpErrorKind`; sweep (6) of §9.1. |
| S6 | MX texts still steer toward Mailgun; Cloudflare Email Routing only amber | **Accepted** | O10, O12, §3.3, §2.5: the own-mailbox `mailgun-domain` fix (`mailgunDomainFix`: "…also lists MX records: leave them out. Never add Mailgun's MX records…"); `DomainCheckState.lastGoodMx` stored at every ok check and named in every red from-mx fix (`putBackMx`), each ending with `NEVER_MAILGUN_MX_TEXT`; Cloudflare Email Routing "bad" in own-mailbox mode with the hold and the `from-mx-bad` notice (app mode keeps "warn"); the P3 safety test requires the sentence. Guide 3 gains "never switch on Cloudflare Email Routing for polygonparadise.com". |
| S7 | O1's fail-closed covers sending, not DNS advice | **Accepted** | O37, §2.5 item 7, §5: `buildChecklistRows` with a `WEBSITE_DOMAINS` sending domain and no own-mailbox facts builds the `mx` row as "reconnect with How the app sends = From polygonparadise.com itself", no MX box anywhere and the SPF row through the own-mailbox logic; the P3 safety test covers app-mode facts for polygonparadise.com. |
| S8 | Complaints and bounces during a gap of more than 23 hours never reach the health auto-pause | **Accepted (the linking); the acknowledgement hold rejected** | O34, §2.8, P5: `pullSuppressions` links a new `complaints`/`bounces` entry to the newest LIVE email SENT to that address within 7 days (the event gets that Message-ID; a bounce gets reason `list-bounce`), then the health check runs once; `list-health.test.ts`. A hold "N complaints came in while the PC was off" is not added: linking makes the existing auto-pause count them without a new click, and the inbox check already holds follow-ups each day. Guide step 13: keep start.bat running, weekends too if possible. |
| S9 | Stored checklist rows aren't tied to the mode | **Accepted (store the mode)** | O36, §5, §7.2: `DomainCheckState.replies`; every reader that ignores another domain's rows also ignores another mode's (`checkMatchesMode`, step C), so the page shows "Not checked yet" until the switch's queued check runs. Clearing rows on a switch is not needed on top. |
| S10 | The rolling guard's blind spots; §11 Q1 overstates the backstop | **In part: the guard and the Q1 text accepted; "pause on any unnamed 4xx" rejected** | O23, §2.8: `countMailgunSendsSince` takes the larger of the local count and the distinct `accepted` MailEvents of the last 24 hours (every domain, since the limit is the account's). §11 Q1 now says exactly what each unknown answer does. The limit rule also catches "…limited to 100 messages per day" (a "per day" form without the word "limit"), with a "recipients per message" exclusion and tests. **Rejected: pausing on the first 4xx that doesn't name the recipient or a parameter**: it would have to parse texts nobody has seen, and a single bad prospect address (the common 400) would stop all sending. The existing rejection breaker (3 refusals of 3 addresses within 30 minutes, `loop.ts:99-101,966-986`) already caps an unknown account-level refusal at 3 FAILED emails, pauses with Mailgun's text, and Retry sends them again (`control.ts:520`). |
| S11 | Reply-test call sites a builder would have to guess; They replied tied to `evidenceFrom` | **Accepted** | §3.5 last bullet and P4 name `reply-test.ts:707-723` (the round check and DMARC pastes with `team.evidenceFrom`) and `:744-771` (`saveReplyTestOriginal`: the From requirement, `fromDomain`, `countsForToday(…, team.evidenceFrom, …)`, the From comparison); O17 and §2.9 show They replied whenever `replies === "own-mailbox"`, with or without a fitting From. |

### 12.2 Owner/buildability review

| # | Point | Decision | Why, and where in the body |
|---|---|---|---|
| B1 | They replied makes test mailboxes "Replied" during the rehearsal | **Accepted** | O17, §2.9: status and `repliedAt` change only when `countsAsReply` (a recipient in a campaign that `countsAsEmailed`, or nothing open and `hasBeenLive`), the rule real replies use (`process.ts:663-671`); the follow-ups always stop; the confirm dialog says which (`bodyTestOnly`); P6 test and e2e step 5 (the next live test still includes the company). |
| B2 | "Stopped: they replied" promised, "Stopped: marked Replied" shown | **Accepted (the first option)** | §2.9: `stopCompany` with the reply codes (`replied` for the person named, `company_replied` for colleagues); `CompanyStopInput.inboundId` optional, `stops.ts` owned by P6 for that one change. |
| B3 | start.bat looks like it worked while `npm run dev` holds port 3000 | **Accepted** | Guide step 1 and the quick path; README start line; `portBusyMessage` names `npm run dev` (`supervisor.mjs`, P8, O30); step C's lead tells the owner in one line and stops nothing (no Prisma change). |
| B4 | Guide step 10 can't be followed (the Test mailboxes list comes from guide 2) | **Accepted** | §6.1 step 10 copies guide 2 step 14's sub-steps, Country = Pakistan included. |
| B5 | The unsubscribed test mailbox is never put back | **Accepted** | §6.1 step 9: wait for "Unsubscribe reached the app ✓" (or Check with Mailgun now), then Settings › Deliverability › Remove; the same for a mailbox the unsubscribe-by-email step listed (`mailtoAfter`). |
| B6 | Two mode switches where one is enough | **Accepted** | §6.1 step 9: one switch to Live (test list only); step 10 needs none. |
| B7 | Steps the owner doesn't need | **In part** | The nine-line quick path heads the guide; the `.env` clean-up is an optional "Tidy up" box; there is no plan step (the first own-mailbox connect sets Free, O22). **Step 2 stays** as a short read-only step: it carries the "never add Mailgun's MX records" warning at the place the owner meets those records (Mailgun's domain page); the quick path skips it. |
| B8 | The reply test can start before DMARC exists | **Accepted** | O38: `replyTestBlockers` in own-mailbox mode needs the `dmarc` row present and not "bad" (`MODE_GATE_TEXTS.dmarcFirst`); P4 unit test, e2e step 2; guide step 9 says it waits for DMARC. |
| B9 | Refusal sentences point at mail.polygonparadise.com | **Accepted** | O7, §2.2: `.emptyOwn`, `.invalidOwn`, `.sandboxOwn`, `.sharedOwn`, `.www`, all with polygonparadise.com; P2 unit cases; sweep (3). |
| B10 | The mode choice is framed around replies, defaulting away from the owner's wish | **Accepted (the one-click switch)** | O7, §3.1: legend "How the app sends"; the options lead with the domain ("From polygonparadise.com itself (replies come to your own inbox)"); typing polygonparadise.com under the subdomain option shows the new `.website` sentence with the button **Use From polygonparadise.com itself**. The choice itself never flips without that click: it decides what happens to replies. The app-mode option stays the default, because every existing install and test relies on it (§0.2 rule 4). |
| B11 | Contradictory numbers; a settings migration missing | **Accepted** | O22: the first own-mailbox connect with no plan writes plan "free" and retention 1/1 with the activity in the connect transaction (§7.1's writer list relaxed accordingly); the Limits page shows `capLine` and `maxFieldHint` (90); the retention-hint change is listed in O30. |
| B12 | "Setup A" jargon | **Accepted** | `passedRow` "The reply test passed…"; `MODE_GATE_TEXTS.setupA` never shown in this mode (`setupNotNormal` + **Back to normal** for a restored Setup B); the Setup switch hidden; P4 render test. |
| B13 | The Apply description is wrong in this mode | **Accepted** | `OWN_MAILBOX_TEXTS.applyHint` (§3.3, §7.4), P4. |
| B14 | Empty reply screens read as "nobody replied" | **Accepted** (the campaign's reply count stays deferred) | `OWN_MAILBOX_TEXTS.repliesEmpty` for the dashboard tile (`replies-list.tsx`, P5) and Notifications › Replies (`replies-section.tsx`, P6); `components/dashboard/texts.ts` needs no change (the tile picks the own text when given `ownFrom`). Counting They replied in the campaign's reply numbers stays deferred (§1.6): they are built from `InboundMessage`, and the stop reason already shows per person. |
| B15 | A dead-end "Simulate a reply" link, same icon as They replied | **Accepted** | P6 hides the link in own-mailbox mode; They replied uses `MailCheck`, never `MessageSquareReply`; the outbox's reply buttons hidden and `simulate.ts` refuses with a `ServiceError` (P1). |
| B16 | `postmasterTeam` points into guide 2 | **Accepted** | `GO_LIVE_RECOMMENDATION_TEXTS.postmasterOwn(d)` → Own-mailbox guide step 14. |
| B17 | Every reminder is passive | **In part: (a) and (b) accepted, (b) with no off switch; (c) deferred; "name who reads it" accepted as wording** | (a) one bell notification a day in the Replies pop-up group when a tick holds a live follow-up, linking to the card that names the companies; (b) the inbox check (O33) is always on in this mode: a setting would be the first thing a busy week turns off, and it is the only reply stop left. (c) The "Someone replied?" box is deferred (§1.6): Contacts' search already finds a person by email address (`company-search.ts:45`) and the card says so. The dashboard item now says "Whoever reads it: …", so a Member who doesn't read contact@ knows the click isn't theirs; a "who reads contact@" setting isn't added (the Activity page names who clicked). |
| B18 | The practice copy teaches the opposite habit | **Accepted** | They replied shows in the practice copy (O17); README note. |
| B19 | Step C breaks two existing tests | **Accepted** | §7.5 and §9.2: step C updates `sender-address.test.ts:75-77`, `connect.test.ts:131-133` and guide 2 line 114 with the constant, so `labels.test.ts:363` stays green. |
| B20 | The MX guard row can be built but hidden | **Accepted** | §3.3 and P4: the `load.ts:194` filter applies only in app mode; render test with no From saved. |
| B21 | Step-C logic no package may fix | **Accepted, extended** | After step C: `mode-gates.ts`, `go-live-copy.ts`, `core/reply-test.ts`, `go-live.ts` → P4; `errors.ts`, `usage.ts`, `mailgun/context.ts`, `mailgun/client.ts` → P1; `services/mailgun/team-from.ts`, `sender-address.ts`, `sending/actions.ts`, `connect.ts` → P2; `checklist.ts` → P3; the fake files and `fake-free.test.ts` → P8. Each may fix defects but never change an exported name, signature or field (others build against them in parallel). |
| B22 | Files with no owner | **Accepted** | §8: `replies-list.tsx` (P5), `replies-section.tsx` and `stops.ts` (P6), `supervisor.mjs` and `run-prod.mjs` (P8); `dashboard/texts.ts` needs no change (B14). |
| B23 | P1's simulate refusal underspecified | **Accepted** | P1: `throw new ServiceError(OWN_MAILBOX_TEXTS.simulateReply(from))`, the class `outbox/actions.ts:29-31,54-56` translates. |
| B24 | The effective daily cap re-derived in five packages | **Accepted** | Step C's `loadEffectiveMaxDailyCap()` (`services/mailgun/plan.ts`) is the one loader; sweep (5) checks nobody else reads `sending.maxDailyCap` except the Limits form. |
| B25 | The design contradicts itself on MX records in the guide | **Accepted (reword)** | §0.2 rule 7 and §6.1: never Mailgun's MX, never an SPF value; the only MX values named are the mail provider's (the last good MX, Zoho's in troubleshooting), for putting them back. |
| B26 | Missing tests (a)–(f) | **Accepted** | (a) P6 `they-replied.test.ts`; (b) P4 `domain-checklist-own-render.test.ts`; (c) P2 unit + sweep (3); (d) `fake-free.test.ts` in step C; (e) e2e step 1 asserts the no-public-address facts; (f) the size and "recipients per message" exclusions with negative cases in `classify-limit.test.ts`. |
| B27 | The Playwright `own` state can't show the owner's real screens | **Accepted** | P8: `run-prod.mjs --no-public-address` (+ `run-prod.test.ts` cases); `E2eInstance.publicAddress: false`; the `own` seed stores rows built with no public address. |
| B28 | Adding `own` to `E2E_STATES` runs every spec in it | **Accepted** | P8 reviews every spec (`onlyIn` guards; `auth.spec.ts` as is); `E2eInstance.fakeArgs` carries `--plan free --mx-elsewhere`; `fake-check.ts` refuses a wrongly started fake. |
| B29 | Traps for P7 (a)–(d) | **Accepted** | (a) no question or § numbers in any owner doc (§6.1 last paragraph, P7 "Done when"); (b) no new `###` under "Start here", the four guide links keep their order; (c) the new guide added to `OWNER_DOCS`; (d) guide 4's own-mailbox sentence is un-numbered and uses `checklistTitle(key, "polygonparadise.com")` titles, the pinned "…to 1,000 in about 4 weeks" item stays and a sentence says Free ends at 90. |

## 13. Review fixes (2026-09-28)

The own-mailbox review (`review-own-mailbox`, 2026-09-28) confirmed 36 findings and rejected 6. Four engineers fixed them
in parallel; one integrator wired the call sites they couldn't reach, the docs and the design. Every fix keeps app mode
as it was unless the row says "every mode". No Prisma change, no migration, no new package.

| Finding | What changed | Where |
|---|---|---|
| REPLIES-01, SCREENS-02 (high/medium) | On the From's own domain the unsubscribe-by-email question accepts only "arrived in a mailbox you read"; `mailtoAfter` says a bounce means No and that Settings › Deliverability can't answer it (the link click lists the test mailbox). Another domain keeps the Deliverability proof, only from the mailbox whose link wasn't clicked (`mailtoAfterElsewhere`). Guide step 9 orders Remove before the question. | `mailtoOnOwnDomain`, `OWN_REPLY_TEST_TEXTS.mailtoQuestion/mailtoAfter/mailtoAfterElsewhere`; `reply-test-section.tsx`; guide step 9 |
| DOMAIN-1 (medium) | The own-mailbox `spf` row walks both resolvers, each from its own record, counting repeated includes every time (`countRepeats`); any disagreement is "Still spreading" (unknown after a timeout) and never a fix; the add-include and no-record fixes go through the person who set up the app (`OWN_SPF_TEXTS`). App mode's single walk is unchanged (its repeated-include undercount is left for the lead). | `spf-count.ts`, `dns-facts.ts`, `domain-check.ts`, `checklist.ts`; §3.3 |
| DOMAIN-4 (low) | A `WEBSITE_DOMAINS` sending domain checked in app mode (O37) gathers both walks and the dangling names (`gatherDnsFacts(…, { everydaySpf })`); its fixes say to reconnect in own-mailbox mode (`websiteInAppModeFix`), never to add include:mailgun.org. | `dns-facts.ts`, `domain-check.ts`, `checklist.ts` |
| REPLIES-02 (medium) | A handled restore marker resets `sending.inboxCheck` to nobody-has-read (`forgetInboxCheck`); in own-mailbox mode the restore pause's fix text, the notification and the Last restore card say which They replied clicks were undone and to read contact@ again from the backup's time. | `restore.ts`; README restore step 5; guide 4 step 5 |
| REPLIES-03 (medium) | `mailtoFailed` lists catch-all → aliases `u@`/`bounce@` → **Leave out unsubscribe by email**. The last resort is built and checks itself: `UnsubscribeTestSetting.leaveOutMailto` (only when true), set by `setLeaveOutMailto` (own-mailbox only, round-checked, refused while a test or live campaign is scheduled, running or paused; clears the result, the original, `headersOk` and `mailtoArrived`); `MailgunClient.sendMessage` alone adds `h:List-Unsubscribe: <%unsubscribe_url%>` in own-mailbox mode (read fresh before every send; unreadable → refused before any request); the verdict skips the question and passes only on a new original with an http(s) link and no `mailto:`. A From or domain change drops the choice (fail closed). Sweep guard (8) pins the one place. | `own-mailbox.ts`, `core/reply-test.ts`, `setting-types.ts`, `system-state-parse.ts`, `services/reply-test.ts`, `domain/actions.ts`, `mailgun/client.ts`, `reply-test-section.tsx`, `domain/load.ts` (`mailtoLeftOut`); §1.6, §3.5; guide steps 1, 9, 16 |
| SECURITY-03 (medium) | Fail closed on an unreadable `mailto:`: every List-Unsubscribe header read, percent-decoding, quoted local parts, 998-character cap; `mailtoUnreadable` stored; `mailtoOffered()`; the verdict fails with `mailtoUnreadable` and the line never says "not offered"; a malformed stored `mailtoAddress` drops the whole original. | `core/reply-test.ts`, `system-state-parse.ts`, `setting-types.ts`, `services/reply-test.ts` |
| SCREENS-04 (low) | The own-mailbox List-Unsubscribe question asks for a line with a link (http or https), with `headersNote` (http and no List-Unsubscribe-Post expected on Free). | `headersQuestion`, `headersNote`; section; guide 9.6 |
| REPLIES-08 (low) | With 1 day of logs: `reportsGoneBefore`; an undelivered test email past it says `reportGone` (the mailbox's Test email line too: "Sent, but Mailgun's report is gone: send the test emails again"); a list-only unsubscribe says `unsubscribeGone`; the go-live card's live test says `liveTestGone`. | `core/reply-test.ts`, `services/reply-test.ts`, `own-mailbox.ts`, `domain/load.ts` |
| REPLIES-05 (low) | The inbox-check card intro, the dashboard item and the bell's body send removal requests, unsubscribe emails and "couldn't be delivered" notices to ⋯ › Mark unsubscribed. | `INBOX_CHECK_TEXTS` |
| SECURITY-02 (medium) | A stored check more than a minute ahead of the clock never counts (`inboxCheckTime`, `inboxCheckedToday`, `INBOX_CHECK_CLOCK_SKEW_MS`) at the gate, on the card and on the dashboard; the next click replaces it. | `gates.ts`, `inbox-check.ts`, `dashboard/load.ts` |
| SEND-1, REPLIES-04 (low) | A LIVE first email waits for today's inbox check too when its company already got a live email before today's cap-day start (any campaign; SENT, possibly sent, or an ExternalSend); same-day colleagues and never-emailed companies still go. The bell title is "Live emails wait for today's inbox check". | `inboxCheckHeldIds`; `INBOX_CHECK_TEXTS.notificationTitle`; O33; guide step 12 |
| SEND-3, REPLIES-07 (low) | Held rows never crowd the candidate query: `pickRealRows` pages past held rows (at most 10 pages), keeping one held row for the waiting line. | `gates.ts` |
| SEND-2 (low, every mode) | The reply test admits all its emails in one lock-first transaction (plan and cap counted with them, rows SENDING before the first POST; unsent reservations released in a `finally`); the loop's final check recounts the rolling 24 hours without its claimed email (`startGatesClosed`). | `test-send.ts`, `gates.ts`, `usage.ts` |
| SEND-5 (low, any mode with a plan limit) | Tests may use today's cap plus the 10 kept for them (`testCapFor`); the refusal says so and drops "change today's limit" when the cap is already the plan's highest. | `test-send.ts` |
| SEND-6 (low) | Retry refuses an own-mailbox email that itself wouldn't pass the sender check (`retryEmailProblem`, code `from-changed`, `RETRY_FROM_TEXTS.emailDoesntFit`), without pausing. | `control.ts` |
| DOMAIN-3, SCREENS-06 (low) | Own-mailbox Apply on Free: certificate, https and (no public address) webhooks steps are ok: null; the card words them "Not in your plan" / "Optional" / "Not needed" in grey (`applyStepStatus`); the job summary doesn't count them. App mode keeps the red step. | `checklist.ts` (`APPLY_STEP_TEXTS`), `apply-settings.ts`, `checklist.tsx`; §4; guide step 7 |
| DOMAIN-6 (low) | `runCheckRound` compares the saved domain and mode with the round's context twice (after the mode read, before writing); a switch in between writes no rows and sends no notice. | `domain-check.ts` |
| DOMAIN-8 (low) | `ownMxCause()` picks the from-mx branch and the notice body; Cloudflare Email Routing gets `mxBodyOwnCloudflare`. | `checklist.ts`, `domain-check.ts`; §3.9 |
| SCREENS-01 (medium) | `checksFree`: optional but paid, try one check, add Email Validations if refused; guide step 1 "Only address checks may cost money", step 10 tries one check. | `mode-gates.ts`; §3.4, §10.1 |
| SCREENS-05 (low) | Advanced's plan and retention follow the saved view unless typed over (`advancedShown`, `advancedSavedKey`). | `connection-form.tsx` |
| SCREENS-11 (low) | Own-mailbox words: "your inbox for test emails" in the Live confirmation, the test list's hint and empty state, the top-bar tooltip and the Review step's Send me a test line; `fromMxOwn` and `OWN_MX_WAITING_TEXT` name Cloudflare Email Routing; `liveTestNoneOwn` points to Own-mailbox guide step 10. | `sending/texts.ts`, `sending-mode-form.tsx`, `test-list-editor.tsx`, `sending/page.tsx`, `core/sending/label.ts`, `sending-state.ts`, `test-send.ts` (`TestSendInfo.ownMailbox`), `review-step.tsx`, `mode-gates.ts`, `campaigns/format.ts`, both callers of `waitingText` |
| REPLIES-09, SCREENS-07 (low) | Own-mailbox outage wording: `ownOutageLine` on the Check with Mailgun card (and its description without "replies it missed"), `ATTENTION_TEXTS.outageFoundOwn` on the dashboard. People held by an app-mode hold from before a switch keep today's lines. | `sending/load.ts`, `sending/page.tsx`, `core/dashboard/attention.ts` |
| REPLIES-10 (low) | `linkListEntry` links a complaints/bounces entry even when a local do-not-email entry exists, unless the health counts already see a complaint or hard bounce for the address. | `suppressions.ts`; O34 |
| SCREENS-08 (low) | Guide 4 step 11 "The way back" and step 13: never empty the own From; move to the full setup first; Postmaster points to Own-mailbox guide step 14. | `docs/setup/4-going-live.md` |
| SCREENS-09 (low) | They replied's name is its visible label on both buttons; the explanation is its description (`aria-describedby`, visually hidden span). | `company-header.tsx`, `recipient-actions.tsx`; §3.8 |
| SCREENS-12, SEND-7, DOMAIN-7, REPLIES-11, SECURITY-01 (harness) | The fake's `--settings-applied` (tracking off, unsubscribe on, blank footers, kept by `reset()`) in the own instance's `fakeArgs`, checked by `fake-check.ts` and the seed; the seed records today's Apply steps; the go-live spec may skip only on `checkStale`, the own screens assert no pause. | `tests/fake-mailgun/**`, `tests/playwright/**`, `playwright.config.ts`, `scripts/seed-m6-manual.ts`; §9.4 |
| SECURITY-04 (low) | Sweep guards (4) and (7) read whole comment-stripped files (multi-line calls, `ownMailboxFrom: null` caught), (4b) no other client-building file sends, (7) allows only `markInboxChecked` and the restore reset, (8) new: the app's own List-Unsubscribe only in `MailgunClient.sendMessage`. | `tests/unit/sending-core/own-mailbox-sweep.test.ts` |
| Rejected: SEND-4, DOMAIN-2, DOMAIN-5, REPLIES-06, SCREENS-03, SCREENS-10 | The review's own reasons (explicit design decisions that fail closed, or unreachable for this owner). | — |

Open for the lead: app mode's SPF rows still skip a repeated include's subtree (DOMAIN-1 kept app mode sacred); the
Playwright `own` state must be reseeded and rerun with the new fake flag; whether Mailgun fills in `%unsubscribe_url%` in
an `h:` header is only proved by a real pasted original (§11 Q6).

## Summary of schema changes

- No Prisma change, no migration.
- Settings (JSON): new `mailgun.replies` (`"app" | "own-mailbox"`, default `"app"`) and `mailgun.plan` (`"free" | "basic" |
  "foundation" | "scale" | null`, default null; also written once by the first own-mailbox connect); `mailgun.unsubscribeTest`
  gains optional `replies`, `mailtoArrived`, `original.unsubscribeScheme` and `original.mailtoAddress` (review fixes, §13:
  also `leaveOutMailto` and `original.mailtoUnreadable`, each stored only when true).
- SystemState: new key `sending.inboxCheck` (`{ at, byUserId }`); `domain.check` gains optional `replies` and `lastGoodMx`.
- `WaitReason` += `plan-limit`, `inbox-check`. `MailgunErrorKind` += `limit`. No new checklist key or pause kind.
- New activity types `company.markedReplied` and `sending.inboxChecked`; existing activities gain data fields (§7.6). New
  notification type `reply.inboxCheck` (Replies pop-up group) and notice key `inbox-check`.

## Summary of package changes

None.

