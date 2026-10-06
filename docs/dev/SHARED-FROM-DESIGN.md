# Shared From address build design: every email arrives "From: contact@polygonparadise.com"

Written 2026-09-27 by the architect, for the lead and the build agents. It turns the owner's decision of 2026-09-27
("I want my receivers to receive email from contact@polygonparadise.com, not contact@mail.polygonparadise.com") into
decisions, contracts, screens, copy and work packages that 4 engineers per wave can build in parallel without talking to
each other.

**Review fixes of 2026-09-27 are listed in §13.** Where §13 and an earlier section differ, §13 and the code win; the
sections that the fixes made wrong have been updated and point to §13.

**Revised 2026-09-27 after two critiques** (safety: 15 points; owner experience, operations and buildability: 27
points). Every point is accepted or rejected, with the reason, in §12 "Critique decisions"; the body below already
carries every accepted change. The biggest changes: the reply test in shared-From mode now needs one **pasted original**
of a test email, which proves the From, the return address (Return-Path) on mail.polygonparadise.com, DMARC and the
signer (F25); test and live-test evidence counts only for the current From address (`TestSend.teamFrom`, F26); a bad
from-mx row holds live emails and tells the Owner (F27); a launch re-checks the From, the domain and go-live in its last
transaction (F29); the sending-key, region and sandbox cases are handled (F28, F30); the docs cover the trial plan,
GoDaddy's "@" default, the `_spfm` records and a DNS move to Cloudflare.

Sources, all read in full: `docs/dev/CONVENTIONS.md`; `docs/dev/research/mailgun-shared-from.md` (Mailgun mechanics,
"Shape A/Shape B", checked 2026-09-27); `docs/dev/research/shared-from-mail-behaviour.md` (replies, auto-replies, bounces,
reputation, inbox oddities, checked 2026-09-27); `docs/dev/shared-from-code-map.md` (every place the code assumes one
sending domain = one From address); the structure and rules of `docs/dev/M6-DESIGN.md` (§0, §2.1, §7, §8, §10, §12); and
the code they point at (`core/sender-address.ts`, `core/mailgun/routes.ts`, `core/dns/{checklist,dmarc}.ts`,
`core/sending/{mode-gates,go-live-copy}.ts`, `core/reply-test.ts`, `core/setting-types.ts`, `core/system-state.ts`,
`core/dashboard/attention.ts`, `server/settings.ts`, `server/mailgun/{context,send-guard}.ts`,
`server/services/sending/{addresses,transport,mailgun-transport,loop,mark-sent,reconcile,restore,gates,health-check}.ts`,
`server/services/campaigns/{launch,draft}.ts`, `server/services/mailgun/connect.ts`,
`server/services/checks/{domain-check,dns-facts,dns-lookup}.ts`, `server/services/{reply-test,test-send,go-live}.ts`,
`server/services/mail-events/internal-senders.ts`, `app/(app)/settings/sending/page.tsx`,
`components/settings/{profile-form.tsx,sending/connection-form.tsx}`, `components/campaign-wizard/sender-step.tsx`,
`components/campaigns/outbox-email.tsx`, `prisma/schema.prisma`, `tests/fake-mailgun/{state,inbound-presets,handlers/messages}.ts`,
`tests/integration/helpers/{mailgun,replies}.ts`, `tests/unit/docs/{guide-refs,labels}.test.ts`, `scripts/seed-m6-manual.ts`,
`playwright.config.ts`, `README.md`, `docs/setup/{2-mailgun-and-dns,3-cloudflare,4-going-live}.md`).

**The shape in one paragraph.** The owner keeps a Mailgun **sending subdomain**, `mail.polygonparadise.com` (MX →
Mailgun, US region, the app's `mailgun.domain` exactly as today), and the app puts `contact@polygonparadise.com` only in
the **From header**, with each teammate's display name ("Arslan from Polygon Paradise <contact@polygonparadise.com>")
and each teammate's own address on the subdomain as **Reply-To** (`arslan@mail.polygonparadise.com`). Recipients see
contact@polygonparadise.com; replies still pass through the per-person Mailgun routes (stored by the app, stopping
follow-ups, forwarded to each person's reply inbox, which may be contact@polygonparadise.com); the envelope sender,
tracking links, unsubscribe addresses, events, suppressions and stored replies all stay on the one Mailgun domain the app
already handles. `polygonparadise.com` keeps its Zoho MX for good: the app never makes it a Mailgun sending domain, never
creates a route, setting or API call for it, and turns a checklist row red (holding live emails and telling the Owner)
if its MX ever points to Mailgun. This is the research's "Shape B"; the lead's "Shape A" (sending through the root
domain) is rejected in §1.2. That Mailgun puts the envelope sender (Return-Path) on the subdomain is **Likely, not
confirmed** by any Mailgun page; the reply test proves it on the owner's real account before anything goes live (F25).

**Nothing in this work may ever call the real Mailgun, the real Anthropic API, a real website or Cloudflare during the
build, the tests or the lead's checks.** Mailgun is the local fake (`tests/fake-mailgun/**`), DNS the fake `DnsLookup`
or the fake-mode lookup, as in M6-DESIGN §0.2 rule 13. Nobody on the build side opens `data/app.db`.

---

## 0. How to use this document

### 0.1 Order of work

| Step | Who | What | Blocks |
|---|---|---|---|
| **C** (contracts) | Lead, before wave 1 | Stop the services and every `next dev`/worker window. Apply the schema edit and the migration `20260927200000_shared_from` (§7.3–§7.4), `npx prisma generate`. Write the contract files and edits of §7.5–§7.7 (one move of existing code, behaviour unchanged; the full list of step-C files is §7.9), the fake Mailgun and test-helper changes of §7.8. Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json` and `npx vitest run`: everything passes unchanged (every new parameter is optional and means "per-person mode" when absent). | everything |
| **Wave 1** | P1, P2, P3, P4 in parallel | P1 every email's From and Reply-To (snapshot, launch and its last re-check, rows, follow-ups, loop and `lastLiveSendAt`, transport, client check, reconciler, restore rows, route hold and the main-domain MX hold, simulate, campaign screens, wizard Sender step). P2 the From address setting (card, action, service, connect refusal, region change), the sending-domain texts, and the Domain checklist's facts, rows and notices. P3 the reply test (with the pasted original), the test sends, the test list, the go-live switch, card and dialog, and the Domain checklist page. P4 the words on My profile, Team and Limits, the sender-address notices, internal senders, the health note and the dashboard. | wave 2 |
| **Wave 2** | P5, P6 in parallel | P5 the owner docs (README, guides 2, 3, 4), SPEC/PLAN notes and the docs tests. P6 the end-to-end test of the owner's shape, the M6 manual-check seed in shared-From mode and the Playwright specs. | P7 |
| **Final** | P7 (one agent) | Integration: the whole suite, seams between packages, CONVENTIONS "Shared From address" section, activity/notification doc lists, `npm run check`, the worker bundle self-test. | step S |
| **S** (screens) | Lead, after P7 | `next build`, `node scripts/build-worker.mjs`, seed the manual-check databases (ready and live now in shared-From mode), run the Playwright suite and the manual checks of §9.5. | review |

### 0.2 Rules for every builder (in addition to `docs/dev/CONVENTIONS.md` and M6-DESIGN §0.2)

1. Only edit your **owned paths** (§8). Contract files from step C are read-only for everyone: if one is wrong or
   missing something, STOP and report it in your final answer.
2. In wave 2 you may import from wave-1 packages (their exports named here), the contract files and existing code, never
   from a wave-2 peer.
3. Every user-visible sentence in this document is the copy to use (§3). Change wording only to fix grammar. No
   "Milestone N", no PLAN question numbers, no builder's voice in any screen, script or doc.
4. **Per-person mode is sacred.** With Setting `mailgun.fromAddress` empty (the default, the practice copy, every existing
   test), every screen, header, row and sentence stays exactly as today. Every new parameter is optional and absent
   means per-person mode. An existing test that has to change is listed in §9.2; any other failing existing test is a bug
   in your package. **The only deliberate per-person changes** (critique decisions, §12): the go-live dialog's From line
   (F21, shown in both modes), `SENDING_DOMAIN_TEXTS.website` and the new sandbox refusal (F30), a region-only reconnect
   treated as a domain change (F28), the launch's last re-check (F29), `lastLiveSendAt` written by the campaign's domain
   (F6), and the reply test and live test counting only evidence from after the last From change (F26; with no From
   change ever, nothing is filtered). The review fixes of §13 add, on purpose: evidence also restarts at every
   sending-domain change, a region-only move included (SETTING-1); the launch's re-check also covers the region and the
   domain row (SEND-3); health counting runs from the first go-live on the sending domain (REPLIES-02); the reply test's
   answers are saved one click at a time and "Save the result" refuses answers that changed meanwhile (REPLIES-03); the
   go-live freshness sentence names the sending domain too; and **Remove the sending key** shows under Advanced
   whenever a sending key is saved (SCREENS-01).
5. **The From address and the Reply-To come from one place**: `senderHeaders()` / `senderSnapshot()` (§2.3). Nobody
   builds a From line for a campaign email, a test email or a reply-test email by hand.
6. **The Mailgun domain of an email is `mailgunDomainOf(fromLine, replyTo)`** (the Reply-To's domain when there is one),
   never the From address's domain alone (§2.3). In shared-From mode the email's Message-ID must be on that same domain
   (a second check, §2.4). Per-domain bookkeeping (`SendingDomain.lastLiveSendAt`) is written by the campaign's
   `sendingDomainId`, never by an address.
7. **polygonparadise.com is never a Mailgun domain for the app** (§2.5): never a `SendingDomain` row, never a path
   segment of a Mailgun request, never a route expression, never the name of an MX record the app asks for. The test of
   §9.3 step 9 checks it on every request the fake receives.
8. **Fail closed** (§2.4): an email whose From isn't on the sending domain goes out only with a Reply-To on the sending
   domain; otherwise nothing leaves the PC and sending pauses with the "From or reply address" sentence.
9. **Go-live has three doors now** (§2.7): `sending.goLive = true` only by `goLive()`; `sending.goLive = false` only in
   `src/server/services/mailgun/connect.ts`: a sending-domain change in `connectMailgun` (G8) or a From change in
   `saveFromAddress` (F13).
10. **No network inside a transaction; lock-first `dbTx`; owner-only actions checked server-side with
    `requireOwnerAction()`; zod for every action input; secrets never reach the browser.** Nothing in this design needs
    a network call inside a transaction: the From address is validated by a pure function.
11. Commands: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`, `npx eslint <owned paths>`,
    `npx vitest run <own test paths>`. Never `next build/dev/start`, `npm install`, `prisma migrate *`,
    `npx playwright test`.

### 0.3 Words used in this document

| Word | Meaning |
|---|---|
| **Sending domain** | Setting `mailgun.domain`, the one Mailgun domain the app sends and receives through: `mail.polygonparadise.com`. Unchanged meaning. |
| **Shared From address** / **team From** | Setting `mailgun.fromAddress`, e.g. `contact@polygonparadise.com`. Empty = per-person mode. |
| **From domain** | The domain of the shared From address: `polygonparadise.com`, the **main domain** (registrable domain) of the sending domain. |
| **Shared-From mode** | `mailgun.fromAddress` is set and valid. Emails: From = "<display name> <shared address>", Reply-To = the sender's own address. |
| **Per-person mode** | `mailgun.fromAddress` empty: From = "<display name> <sender's own address>", no Reply-To. Today's behaviour. |
| **Sender's own address** | The teammate's `SenderAddress` on the sending domain (`arslan@mail.polygonparadise.com`): the From in per-person mode, the Reply-To in shared-From mode, always the route address. Shown as **"Reply address"** in shared-From mode and **"Sending address"** in per-person mode (F19). |
| **Route address** | Where a reply lands and is caught by a Mailgun route: `replyTo ?? From address` of an email. |
| **DKIM signer** | The domain in the DKIM `d=` tag. Read from the DKIM record name Mailgun lists for the sending domain (`<selector>._domainkey.<signer>`), or, when Mailgun lists none, from the pasted original's passing `header.d=` (§3.2). |
| **Pasted original** | Shared-From mode: the full source of one reply-test email as a test mailbox received it (Gmail "Show original", Outlook.com "View message source"), pasted once into the reply test. The app reads the From, Return-Path, DMARC, DKIM signer and List-Unsubscribe from it and stores only what it read (`ReplyTestOriginal`, §7.2), never the text. |
| **Return-Path** (envelope sender, "mailed-by") | Where bounces and standard auto-replies go. Must be on the sending domain (F25). |

---

## 1. The decision and the shape

### 1.1 What the owner asked for, and what the research found

- The owner wants every outreach email to arrive From `contact@polygonparadise.com`, with each teammate's name, not
  From an address on a separate domain or subdomain. This reverses SPEC.md lines 21, 30 and 58 ("contact@… must NOT be
  used for cold sending"; "send … from a separate sending domain"), which the app enforces today
  (`WEBSITE_DOMAINS` and the reserved `contact` in `src/core/sender-address.ts`). The owner made the decision after being
  warned of the reputation risk; this design implements it and keeps the risk visible (§2.8, §10.3).
- Facts from public DNS (both research files, 8.8.8.8, 2026-09-27): polygonparadise.com's MX is Zoho
  (`mx.zoho.com`, `mx2`, `mx3`); DNS is at GoDaddy; SPF already includes Zoho and Mailgun and uses **9 of 10** DNS
  lookups; Mailgun's DKIM key `mx._domainkey.polygonparadise.com` is published and **1024-bit**; the tracking CNAME
  `email.polygonparadise.com → mailgun.org` means the root is a **US** Mailgun domain; there is **no DMARC record**;
  nothing at all is published under `mail.polygonparadise.com` yet.
- The deciding Mailgun fact (mailgun-shared-from.md §2.3, quoting
  https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-failures.md): "Mailgun can track
  delayed bounces, but only if the domain that the email message was sent from has MX records pointing to Mailgun;
  Otherwise, NDR email messages will not reach Mailgun." That Mailgun's envelope sender is on the Mailgun domain named
  in the API path (`POST /v3/mail.polygonparadise.com/messages`) even when the From header is on another verified
  Mailgun domain of the same account is **Likely, not confirmed**. The only quotes are "The mail-from host will remain
  the domain name being created, not the root domain" (OpenAPI `force_root_dkim_host`, about creating a domain) and
  "the sender domain is what the receiving email server sees when initiating the session … The sender must always be
  one of your Mailgun domains" (https://documentation.mailgun.com/docs/mailgun/faq/sending.md, fetched again
  2026-09-27; it says nothing about which domain Mailgun picks, and polygonparadise.com is itself one of the owner's
  Mailgun domains). SPF and DMARC would pass either way (the root's SPF includes mailgun.org), so only the Return-Path
  itself tells. **The reply test reads it from a pasted original and fails if it is on polygonparadise.com (F25)**, and
  §11 asks Mailgun support.
- The From header is free: "You can technically set the from field to be whatever you like. The sender must always be
  one of your Mailgun domains." (https://documentation.mailgun.com/docs/mailgun/faq/sending.md, quoted in
  mailgun-shared-from.md §2.1).
- DMARC accepts a subdomain as aligned: "When the Author Domain has the same Organizational Domain as an Authenticated
  Identifier, the two are said to be in relaxed alignment" (RFC 9989 §3.2.10.1), and relaxed is the default; Gmail and
  Yahoo accept relaxed alignment; Outlook shows no "via" when the DKIM or MAIL FROM domain "matches (or is a subdomain
  of)" the From domain (shared-from-mail-behaviour.md §3.1, §3.5).

### 1.2 Shape A (send through the root) against Shape B (send through the subdomain, root only in From)

| | Shape A: Mailgun sending domain = polygonparadise.com, Reply-To on a reply subdomain | **Shape B (chosen)**: Mailgun sending domain = mail.polygonparadise.com, From header on the root |
|---|---|---|
| What recipients see | From "Arslan from Polygon Paradise <contact@polygonparadise.com>" | **the same** |
| Envelope sender (Return-Path) | `bounce+…@polygonparadise.com` → Zoho | **Likely** `bounce+…@mail.polygonparadise.com` → Mailgun; proved by the reply test's pasted original before go-live (F25) |
| Late (asynchronous) bounces | **lost** at Zoho: no `failed` event, no suppression, the bounce auto-pause undercounts, dead addresses are emailed again | reach Mailgun → `failed` events, as today |
| RFC 3834 / Sieve auto-replies | to Zoho (rejected or in a catch-all) | to Mailgun, as today |
| `mailto:` half of List-Unsubscribe | Likely `u+…@polygonparadise.com` → Zoho: **unsubscribes lost** | Likely on the subdomain → Mailgun |
| Mailgun domains the app handles | two (sending root + receiving subdomain), maybe two regions; every inbound flow, the catch-up's stored walk, the checklist, the loop rule and the context change | **one, as today** |
| Risk of pointing polygonparadise.com's MX at Mailgun | the root becomes a Mailgun domain whose MX row is red forever; the checklist logic must be turned inside out | the root is never a Mailgun domain in the app; a checklist row guards its MX |
| DMARC alignment | strict (SPF and DKIM on the root) | DKIM: strict with the root's DKIM authority (Mailgun's default), else relaxed; SPF: relaxed |
| Mailgun's advice "use the same domain in From as the sending domain" ("Outlook/Hotmail is especially finicky") | followed | not followed (same organisation); the reply test's Outlook.com mailbox measures it (F12) |
| Code change | large (code map §0.3: context, settings, rows, catch-up, routes, checklist, loop rule, tests) | small: From header + Reply-To column + validators + checklist rows + wording |
| Plan | Foundation (two domains, routes, https links) | Foundation (the root stays in the account as DKIM signer; routes; https links) |

**Decision F1: Shape B.** Reasons, in order: it keeps late bounces, standard auto-replies and `mailto:` unsubscribes on
Mailgun, which the safety rules demand ("no lost unsubscribes/complaints"); it can never put Mailgun's MX on
polygonparadise.com because the root is never the Mailgun domain; it leaves every inbound flow the app already has
(routes, webhooks, catch-up, stored replies, suppressions, restore scan, warm-up, go-live keys) untouched; and recipients
see exactly the From line the owner asked for. Its one cost, Mailgun's "same domain" advice, is measured by the reply
test (F12) and has a way back (F3): pause, cancel the scheduled, running or paused test and live campaigns (or resume
and let them finish), empty the From address, resume, then run the reply test and a live test and go live again (§6.1
"Sending safely" spells out the order; review SCREENS-02, §13). Its one unconfirmed premise
(the Return-Path on the subdomain) is checked by the reply test on the owner's own account before anything goes live
(F25); if it fails, the owner stays in per-person mode on mail.polygonparadise.com and nothing was sent to prospects.

### 1.3 Where each job of "the sending domain" lives (code map §0.1)

| Role | Today | Shared-From mode |
|---|---|---|
| R1 API domain of `POST /v3/{d}/messages` | `mailgun.domain` | `mailgun.domain` (mail.polygonparadise.com), found by `mailgunDomainOf()` |
| R2 From address | the sender's own address | **the shared From address** (contact@polygonparadise.com) with the sender's display name |
| R3 Message-ID domain (`pp.<hex>@…`) | `mailgun.domain` | unchanged (`@mail.polygonparadise.com`), so the reconciler's control, the catch-up's own-send check and the reply test's TestSend filter keep working (code map A7) |
| R4 per-person address = route address | the From | **the Reply-To** (same `SenderAddress` row, same route) |
| R5 receiving (MX, routes, catch-all, dmarc@, stored replies) | `mailgun.domain` | unchanged |
| R6 Mailgun settings (tracking, unsubscribe, certificate, webhooks, spam, retention) | `mailgun.domain` | unchanged; Apply never touches polygonparadise.com |
| R7 per-domain state (checklist, reply test, warm-up, go-live, cursors, restore walk) | `mailgun.domain` | unchanged key; the reply test and go-live also record the From address (F12, F13) |

### 1.4 What the owner does in Mailgun and DNS (guide 2 has the steps; §6.2)

1. **Plan: Foundation** (two domains in the account, one route per teammate plus catch-all and dmarc@, https unsubscribe
   links, 5-day logs). The screenshots show an Upgrade button and a sandbox domain, so the account is probably on the
   Free plan or a trial. Free and Basic allow "1 custom sending domain" and 1 or 5 inbound routes
   (https://www.mailgun.com/pricing/, research §6.1), and polygonparadise.com already uses that one slot: **upgrade to
   Foundation first** (Account › Plan, it may be called Billing; **Upgrade**). If Mailgun says the domain limit is
   reached, upgrade; **never delete polygonparadise.com** to make room (its private DKIM key signs every email and
   "once private keys are created … they are never exported", research §3.4). Leave the sandbox domain alone.
2. **Keep polygonparadise.com in Mailgun** (US, SPF and DKIM verified). It signs the emails. Its MX stays "unverified"
   in Mailgun for good: that is correct, and nobody ever adds Mailgun's MX records to polygonparadise.com. Keep
   `include:mailgun.org` in its SPF record: Mailgun needs it to keep polygonparadise.com verified.
3. **mail.polygonparadise.com in the US region**, same account. How to see a domain's region: its DNS page lists MX
   values ending in `eu.mailgun.org` (EU) or just `mailgun.org` (US). If it was added in the EU region earlier: delete
   **mail.polygonparadise.com** (only that one) there and add it again in the US region. Nothing is lost (nothing is
   published under `mail.` and nothing was sent). Whether Mailgun lets the same name be re-added at once is **not
   confirmed**; if it refuses, wait a day or ask Mailgun support, and never pick EU in the app instead. DKIM: leave
   Mailgun's default DKIM authority (polygonparadise.com) and leave Automatic Sender Security off (it may be under
   advanced settings; labels not confirmed); if Mailgun switches it on by itself, that's fine too: the DKIM row then shows
   two records to add under `mail`.
4. **In the app:** Region **US**, sending domain **mail.polygonparadise.com**, the API key, and **leave the domain
   sending key empty** (whether a domain sending key may send a From on another domain is not confirmed, §11); then the
   new **From address** card: **contact@polygonparadise.com**. If the app says "…change Region to EU", don't: go back to
   point 3.
5. **DNS at GoDaddy (or Cloudflare, if moved in the Cloudflare guide):** the records the Domain checklist shows for
   `mail` (two MX, one SPF TXT), `email.mail` (tracking CNAME), a DKIM record only if its row shows a box, and
   `_dmarc` (TXT `v=DMARC1; p=none`) for polygonparadise.com. GoDaddy's form may fill **Name** with `@`: change it to
   `mail` before saving. **Never add, change or delete the MX or the SPF record of `@`, and leave every other existing
   record alone**, including `dc-…._spfm` (GoDaddy's SPF helper records), `mx._domainkey` (Mailgun's key) and
   `zmail._domainkey` (Zoho's key).
6. **Profiles:** each teammate's reply address (`arslan@mail.polygonparadise.com`); a reply inbox such as
   `contact@polygonparadise.com` is allowed.
7. **Test list:** one Outlook.com and one Gmail mailbox (never contact@polygonparadise.com), then the reply test with its
   two new questions per mailbox and one pasted original (F25).

### 1.5 What stays exactly as today

The per-person mode (F3); `validateSendingDomain` (still refuses polygonparadise.com and www.polygonparadise.com as the
sending domain; only its refusal sentence changes, and Mailgun's sandbox domains are now refused too, F30); `RESERVED_LOCAL_PARTS` (still includes `contact` for per-person addresses); the reply-inbox loop rule
(`isSafeForwardAddress` against `SendingDomain` names only, so contact@polygonparadise.com is already a valid reply
inbox); `getMailgunContext` and its one domain; `domainsToSync`; routes and their specs; webhooks; the catch-up and its
cursors; suppressions and "Remove it"; the restore scan and `domainsBefore`; the warm-up and health counting; Apply
recommended settings; threading; reply linking and attribution (`senderAddressId` of the route address); the test-list
guard; per-sender caps and pacing (keyed by the sender, never by the From address); address checks; the practice copy.

### 1.6 Deferred (not built now)

| Item | Why it can wait | Hook left |
|---|---|---|
| Copying contact@ mail into the app (a Zoho forward or filter to a store-only Mailgun route) to catch replies that bypass Reply-To | needs a paid Zoho plan ("the Email Forwarding feature will not be available" on new Free plans), a verification email, a new store-only route kind with no `forward()`, noise filtering for ordinary customer mail, and it sends all contact@ mail through Mailgun and the app (privacy). The owner reads contact@ daily and sets the company to Replied (F17). | `storeInbound` already de-duplicates twins by Message-ID and sender (`findTwinSource`); a future route kind in `core/mailgun/routes.ts` |
| Per-person From addresses on polygonparadise.com (arslan@polygonparadise.com) | the owner asked for one address; it would need a Zoho mailbox per person and puts more inbound mail outside the app | the per-person display name already carries the person |
| A custom MAIL FROM host (`mailfrom_host`, undocumented) | Shape B gets the same result with documented features | — |
| Rotating the root's 1024-bit Mailgun DKIM key to 2048 from the app | Mailgun and Zoho keys on the root are both 1024-bit and accepted everywhere; rotation is a DNS change the owner can do later in Mailgun | guide 2 step 16 mentions it |
| Two regions for two Mailgun domains | the app keeps one Mailgun domain | — |
| A "Mark as replied" button separate from the status menu | setting the company status to Replied already stops every follow-up (`stopCompaniesForStatus`) | — |
| Taking every email's Mailgun domain from its Message-ID instead of its headers | the headers and the Message-ID come from the same launch snapshot; per-person tests pin today's header rule; shared-From rows are already cross-checked against the Message-ID (§2.4) | `messageIdDomainOf` (§7.5) |
| A hard go-live block while the Outlook.com test email lands in junk | new domains often start in junk at Microsoft; a hard block could never clear. Instead a required tick in the go-live dialog (F12) | `GateInputs.spamPlacements` |
| A per-reply notification reminder about contact@ | a notification is about a reply that *did* reach the app; the reminder sits where follow-ups are decided (campaign page, wizard, From card) | `TEAM_FROM_TEXTS.followUpReminder` |

---

## 2. Decisions

### 2.1 Decision table

| # | Decision | Why |
|---|---|---|
| **F1** | **Shape B**: send through `mail.polygonparadise.com`; contact@polygonparadise.com only in the From header (§1.2). | Bounces, auto-replies and unsubscribes stay on Mailgun; the root never becomes a Mailgun domain; small change. |
| **F2** | **One team-level From address**, Setting `mailgun.fromAddress`, Owner-only, on Settings › Sending & Mailgun. Each person keeps their own display name ("Arslan from Polygon Paradise") and their own address as Reply-To. | The owner asked for one address; the display name keeps the person visible; the per-person Reply-To keeps attribution, notifications and the route per person. |
| **F3** | **Empty = per-person mode**, exactly today's behaviour. | Existing tests and the practice copy stay unchanged; it is the owner's way back if the main domain's reputation suffers. |
| **F4** | **One Mailgun domain in the app.** polygonparadise.com is not stored anywhere in the app except as the domain of `mailgun.fromAddress`: no `SendingDomain` row, no API call, no route, no Apply step. It stays in the Mailgun account as the DKIM signer. The app reads which domain signs from the DKIM record name Mailgun lists for the sending domain. Region: US (the root is verified there; a subdomain's DKIM authority across regions is unknown). | Nothing in the app can then create Mailgun state for the root; `getMailgunContext` and everything behind it stay single-domain. DMARC passes whichever domain signs (strict with the root, relaxed with the subdomain). |
| **F5** | **Validation** (`validateTeamFromAddress`, §2.2): the From address must be on the main (registrable) domain of the sending domain, never on the sending domain itself or a subdomain of it; the sending domain must therefore be a subdomain; `contact`, `info`, `hello`… are allowed; mail-server names and no-reply names are refused. `validateSendingDomain` is unchanged. | The website domain is allowed only as the From domain, and only when the sending domain is its subdomain: it can never become the Mailgun domain (no Mailgun MX), and the From always aligns for DMARC. |
| **F6** | **Headers**: From = `formatFromHeader(displayName, sharedFrom)`, Reply-To = the sender's own address; Message-IDs stay on the sending domain; the Mailgun domain of any email is the domain of `replyTo ?? From`, and in shared-From mode its Message-ID must be on that domain too. `SendingDomain.lastLiveSendAt` is written by the campaign's `sendingDomainId` (the loop's candidate carries it), never by an address. | One rule for launch, follow-ups, the loop, the reconciler, test sends and the reply test. The From line of a shared-From email names the root, which has no `SendingDomain` row: an address-based `lastLiveSendAt` would stop updating and the catch-up and restore scans would drop the domain 60 days after a later domain change (critique C1-3). |
| **F7** | **Schema: `Campaign.replyTo` and `OutboundEmail.replyTo`** (nullable, null = per-person mode); migration `20260927200000_shared_from` (§7.3). | The Reply-To decides where a reply lands; it must survive exactly as sent: follow-ups copy it, the restore scan re-creates rows from the campaign, the reconciler and the route hold need it. No existing column can hold it without changing what `Campaign.fromAddress` means to its readers. |
| **F8** | **Fail closed**: a From outside the sending domain without a Reply-To on it never reaches Mailgun (transport pre-check → pause; client check `MailgunError` kind `"sender"` → the same pause); TEST/LIVE launches and test sends refuse when the saved From doesn't fit the sending domain. | A missing Reply-To silently sends every reply to Zoho, where the app never sees it; a misaligned From fails DMARC. |
| **F9** | **The loop rule stays on the sending domain only**; contact@polygonparadise.com is a valid reply inbox (already true; a test pins it). | Only domains whose MX is Mailgun can loop. |
| **F10** | **Domain checklist**: every existing row stays on the sending domain, except that in shared-From mode the DMARC row checks the From domain (with a strict-alignment check; its report-address fix names `dmarc@{d}`), the Gmail dashboard and Domain age rows name the From domain, the DKIM row names the signer (and, when Mailgun lists no DKIM record, reads the signer from the reply test's pasted original), and the reply-test row counts only a pass for the current From. Two new rows in shared-From mode, titled with the From domain: **from-mx** "Mail for polygonparadise.com stays with your mail provider (MX)" (never Mailgun, never empty, not Cloudflare Email Routing; needed by Live, the reply test and going live; a bad row also holds live emails, F27) and **from-spf** "polygonparadise.com's SPF record (your everyday email)" (never blocks; "info" when almost full, "bad" only when broken). A **1024-bit DKIM key is "ok" with a note** in both modes. | Receivers judge DMARC by the From domain; the root's MX is the one thing that must never change; its SPF is almost full and carries the owner's everyday mail; with the root's DKIM authority the signature uses the root's existing 1024-bit key, and M6's "every go-live row must be ok" would otherwise block going live for ever on a key Gmail, Yahoo and Microsoft accept. |
| **F11** | **Routes, webhooks, events, catch-up, suppressions, restore scan, health counting, warm-up, Apply, threading, attribution, the test-list guard: unchanged** (§4). Review REPLIES-02 (§13) refined health counting: it runs from the **first go-live on the sending domain** (`sending.healthSinceGoLiveAt`), so a From change that ends go-live, followed by a new go-live, no longer drops the earlier bounces and complaints. | One Mailgun domain. A From change keeps the Mailgun domain, the IPs and the DKIM signer, so the reputation the brake protects doesn't restart. |
| **F12** | **Reply test in shared-From mode**: the test emails carry the team headers (From contact@, Reply-To the Owner's own address); each mailbox gets two more answers, "Did the test email arrive in the inbox, not in spam or junk?" (every mailbox must answer; a No never fails the test, but it becomes a go-live recommendation **and a required tick in the go-live dialog**, so an Outlook.com junk placement can't go unseen) and "Does its original say DMARC: PASS?" (must pass; a pasted original is read by `parseDmarcResult`); plus **one pasted original** of a test email (F25); the List-Unsubscribe question also checks that any `mailto:` address is on the sending domain; a pass counts only for the same sending domain **and** the same From address (`replyTestPassedFor`), everywhere it is shown or used (gates, launch, the checklist row, the reply-test section). | The research's open points (the Return-Path, DMARC alignment, Outlook's "finicky" filter, the `mailto:` host) are exactly what the owner can see once in "Show original"; nothing else can see them. The research called Outlook.com placement the deciding check: the tick makes the Owner decide on it knowingly without a block that might never clear. |
| **F13** | **Changing the From address** (on, off, or another address) is refused while a TEST or LIVE campaign is active, resets the reply test (answers and the pasted original cleared, the chosen Setup kept), asks for a domain check, and **ends go-live** (the second writer of `sending.goLive = false`, in `connect.ts`); `goLive()` records `sending.goLiveFrom`. A launch that is running while the From changes is refused at its last step (F29). | Same reasoning as M6 G8: a new From address changes whose reputation and which DMARC record apply, so the checklist, the reply test and a live test must pass again, with evidence sent after the change (F26). No running campaign is affected (the change is refused while any sends); each campaign keeps its launch snapshot. |
| **F14** | **A sending-domain change must keep the From address valid**: `connectMailgun` refuses a new domain the saved From address doesn't fit ("Clear or change it in the From address card first"). | The From address is only valid relative to the sending domain. |
| **F15** | **Test list**: the shared From address can't be a test mailbox; saving a From address that is on the test list is refused. "Send me a test" to a reply inbox that equals the From address adds a sentence ("look in spam"). | Mail "from yourself to yourself" through another server may be hidden or filtered (Gmail's same-address rule, Zoho unknown); the reply test must use outside mailboxes. |
| **F16** | **`internalSenders()` includes the shared From address and its domain.** | Mail from contact@ or any polygonparadise.com mailbox reaching a route is the team, never a prospect reply (unless it answers our email to that very address, as today). |
| **F17** | **Replies that land only in contact@ are not captured** (new emails typed to contact@, forwards, clients ignoring Reply-To, the rest of a conversation answered from Zoho, auto-replies and non-standard bounce notices addressed to the From). The From address card, the campaign page and the wizard (one-line reminder), guide 2, guide 4 and the README say so and give the actions: a reply → set the company's status to **Replied**; "please remove me" → put the address on the do-not-email list (Owner: Settings › Deliverability › **Add an address**; anyone: set the company to **Do not contact**); a "couldn't be delivered" notice about a campaign email → put that address on the do-not-email list; forwarding such an email from contact@ to a reply address doesn't help (F16: mail from contact@ is the team's own). Capturing them is deferred (§1.6). | No safe, cheap mechanism exists without a paid Zoho plan and sending all contact@ mail through Mailgun. Today such opt-outs and bounce notices reach the route and stop everything by themselves; in shared-From mode only a person can, so the instruction must be concrete. |
| **F18** | **Late bounces, standard auto-replies and `mailto:` unsubscribes stay on Mailgun** by F1 (Return-Path on the subdomain, MX Mailgun), provided the pasted original proves the Return-Path and the `mailto:` host (F25). No custom return path. | Research §2.3, §2.6, §4.2; the premise is Likely, so it is measured, not assumed. |
| **F19** | **Words**: in shared-From mode the per-person address is called **"Reply address"** on every screen and in every sentence (`senderAddressWords(true)`); in per-person mode it stays **"Sending address"**. | The owner never sends *from* it any more; one helper keeps the two vocabularies consistent. |
| **F20** | **Health**: thresholds unchanged (the defaults pause at the 2nd complaint in the last 1,000 counted emails and at more than 3 % bounces of the last 200); in shared-From mode the existing half-limit warning adds one sentence about the everyday email, and the From card's risk note says plainly what the app can't see. | The auto-pause is an early brake, **not** stricter than Gmail's "below 0.1 %" (its default trips at 0.2 %, above Mailgun's own 0.08 %, `MAILGUN_LIMITS`), and it only counts complaints Mailgun hears about: "Gmail has no feedback loop; its complaints show only in Postmaster Tools" (research §4.3). The owner must know that, keep Settings › Deliverability › Thresholds as they are, and watch Postmaster Tools. |
| **F21** | **Go live**: the dialog gains a From line **in both modes** (shared: "Every email shows From contact@…. Complaints about them count against polygonparadise.com, the domain your everyday email uses."; per-person: "Every email shows From the sender's own address, for example …"), so an owner who skipped the From card sees it before real prospects get email; in shared-From mode the card shows "Emails show From …", recommendations gain the reply test's spam placements and Google Postmaster for the main domain, and a spam placement needs a tick (F12). | The last moment to see the From address and the risk before real prospects get email. |
| **F22** | **Practice copy unaffected**: no From address there; the card shows the practice sentence; the action refuses. | SPEC: the practice copy never talks to Mailgun. |
| **F23** | **Docs** rewritten with the owner's real names (§6); SPEC.md and PLAN.md record the decision with its date. | The owner follows the guides literally. |
| **F24** | **No migration of settings**: both new settings default to null; the real database is empty; the practice copy is per-person; stored reply-test results without `from` mean per-person. | Additive only. |
| **F25** | **The pasted original** (shared-From mode, required once per reply-test round): the Owner pastes the full source of one reply-test email from a test mailbox; `parseTestOriginal` reads the From, the Return-Path (and `smtp.mailfrom=`), DMARC, the passing DKIM signer and the List-Unsubscribe `mailto:` host; the service accepts it only when its Message-ID is one of the current round's reply-test emails. The test **fails** when the Return-Path or the `mailto:` host is on the From domain (or anywhere not on or under the sending domain) or DMARC fails; it stays incomplete until an original is pasted. | The critique showed that Shape B's premise (Return-Path on the subdomain) is Likely, not confirmed, and that SPF/DMARC and inbox questions can't tell the difference. One paste proves it on the owner's own account, closes the "old email" loophole of F26 once more, and gives the DKIM row a signer when Mailgun lists none. |
| **F26** | **Evidence belongs to one From address.** `TestSend.teamFrom` records the shared From address a test email showed (null = per-person). The reply test counts only reply-test emails with `teamFrom` = today's From **and** sent at or after the From address last changed (`loadTeamFrom().changedAt`), and their unsubscribe events; the live test counts only LIVE campaigns with the same From (`replyTo` set and `fromAddress` = today's From in shared-From mode, `replyTo` null in per-person mode) launched at or after that moment. `decideReplyTest` is a compare-and-set against the From it judged. Since review SETTING-1 (§13) `changedAt` also moves on every sending-domain change, a region-only move included (`restartEvidence`), and in shared-From mode a reply counts only when it answers one of the counted test emails (REPLIES-01). | A From change keeps the domain, so the domain filter alone hid nothing: the app could go live without one email ever sent From contact@ (critique C1-1). |
| **F27** | **A bad from-mx row holds live emails** (wait reason `main-domain-mx`) and notifies the Owner at most once per 24 hours (notice key `from-mx-bad`); a broken from-spf row (2+ records, a missing included record, more than 10 lookups) notifies too (`from-spf-broken`). Never checked, "warn" or "unknown" hold nothing. | After go-live a Mailgun MX at the root (GoDaddy's "@" default makes it easy) only turned a row red while everyday mail and forwarded replies were lost; the check runs every 6 hours and nobody opens the checklist unprompted. |
| **F28** | **A region-only reconnect is a domain change** (`connectMailgun`: same name, other region): the same refusals and resets (reply test, Apply run, suppressions re-pushed, go-live ended), every current address's route back to "pending" and a route sync. Connecting a subdomain that exists only in the other region gets a sentence that doesn't push the owner to EU. | Moving mail.polygonparadise.com from EU to US is a new Mailgun domain with new routes, keys and suppression lists; the app's `wrongRegionText` would otherwise tell the owner to pick EU. |
| **F29** | **A launch re-checks its sending settings in its last transaction**: `finalizeLaunch` re-reads `mailgun.domain`, `mailgun.fromAddress` and `sending.goLive` and refuses when any differs from what the launch used ("The sending settings changed while this campaign was being launched…"). Since review SEND-3 (§13) it also re-reads `mailgun.region` and the sender address's `SendingDomain` row (still active, same name and region). | A launching campaign is still a draft, so the From-change refusal (and the domain-change one) never sees it; without this, a campaign could run From contact@ with `launchedGoLive: true` after the Owner emptied the From. |
| **F30** | **Sending-domain texts**: `SENDING_DOMAIN_TEXTS.website` points to the From card ("Type mail.polygonparadise.com here. Your emails can still show From contact@polygonparadise.com: set that in the From address card below."); Mailgun's sandbox domains (`*.mailgun.org`) are refused ("That's Mailgun's sandbox domain, for tests only…"). | Typing polygonparadise.com as the sending domain is the owner's most likely first mistake, and the old sentence read as the app overruling the owner's decision; the sandbox domain in the screenshots would otherwise connect and make the From card say "must end in @mailgun.org". |

### 2.2 The From address setting (`validateTeamFromAddress`, contract §7.5)

Setting `mailgun.fromAddress`: `string | null`, default `null`. Written only by `saveFromAddress` (P2). Read through
`loadTeamFrom()` (§7.5), never raw.

Rules, in order (`input` trimmed; a pasted leading `mailto:` removed):

1. Empty → `{ ok: true, address: null }` (per-person mode).
2. No sending domain yet → "Connect Mailgun first: the From address must fit your sending domain."
3. Not exactly one bare address (a display name, `<`, `>`, quotes, commas, spaces) → "That isn't an email address. Type it
   the way people should see it, for example contact@polygonparadise.com." (the example uses the main domain).
4. The sending domain isn't a subdomain of a main domain (e.g. `send-studio.com` itself) → "A shared From address needs a
   sending domain that is part of your main domain, for example mail.polygonparadise.com. send-studio.com isn't: leave
   this empty, or add a subdomain such as mail.<your domain> in Mailgun and connect it above (Mailgun guide, step 4)."
5. The address is on the sending domain or under it → "Leave this empty to send from each person's own address on
   mail.polygonparadise.com. A shared From address goes on your main domain, for example contact@polygonparadise.com."
6. A shared or free-mail domain (`isSharedDomain`) → "That domain belongs to an email provider. Use your own address,
   for example contact@polygonparadise.com."
7. Not on the main domain of the sending domain → "The From address must end in @polygonparadise.com, the main domain
   of your sending domain mail.polygonparadise.com."
8. Local part in `TEAM_FROM_REFUSED_LOCAL_PARTS` (postmaster, abuse, hostmaster, mailer-daemon, noreply, no-reply,
   donotreply, do-not-reply, bounce, bounces, unsubscribe, u, dmarc) or starting with `pp-route-check` → "noreply@ can't
   receive replies or is kept for mail servers. Use the address your team reads, for example contact@polygonparadise.com."
9. Otherwise `{ ok: true, address }` (lowercase). `contact`, `info`, `hello`, `sales`, `support` are allowed here; they
   stay reserved for per-person addresses (`RESERVED_LOCAL_PARTS` is unchanged).

`WEBSITE_DOMAINS` is not consulted: the website domain is allowed exactly when it is the main domain of the sending
domain, which is the owner's case, and the sending domain can still never be the website domain.

### 2.3 Headers of every email

- **`senderHeaders({displayName, senderAddress, teamFrom})`** (contract): per-person → `{ from: "Name <own>", replyTo:
  null }`; shared-From → `{ from: "Name <shared>", replyTo: own }`. Used by `senderSnapshot` (launch, the wizard's sender
  list), "Send me a test" and the reply test.
- **Launch snapshot** (`senderSnapshot(user, mode, senderAddress, { teamFrom })`, P1): `fromName` = display name;
  `fromAddress` (Campaign) = the bare From address (the shared address in shared-From mode); **`replyTo`** (Campaign and
  each row) = the sender's own address in shared-From mode, else null; `fromHeader` (rows) = the From line;
  `sendingDomainId` and `messageIdDomain` = the sender address's domain row and name (the sending domain) in both modes.
  A dry run without a sender address in shared-From mode: From = "Name <shared>", Reply-To null, Message-IDs on
  `dry-run.invalid` (nothing is sent).
- **Follow-ups** (`createNextStepRow`) copy `replyTo` with `fromAddress`; Message-IDs keep the previous row's domain.
- **Restore scan** (`matchByRecipient`) re-creates a row with `formatFromHeader(campaign.fromName, campaign.fromAddress)`
  and `replyTo: campaign.replyTo`.
- **The loop** passes `row.replyTo` in `OutgoingMessage.replyTo`; `buildSendInput` already sends `h:Reply-To`.
- **The Mailgun domain** (`mailgunDomainOf(fromLine, replyTo)` = the domain of `replyTo ?? bare From`): used by
  `MailgunTransport.send` and the reconciler's Logs search. In per-person mode it is the From's domain, as today. In
  shared-From mode (a From off the domain and a Reply-To on it) the email's Message-ID must also be on that domain
  (`messageIdDomainOf(messageId) === domain`), or the email is blocked with the sender pause (§2.4).
- **`SendingDomain.lastLiveSendAt`** is written after a LIVE send by `Candidate.sendingDomainId` (the campaign's
  `sendingDomainId`, selected with the candidate), never from an address. The catch-up's `domainsToSync` and
  `restore.mjs readSendingDomains` keep an inactive domain for 60 days after it, so a later domain change still catches
  up the old domain's late bounces, complaints, unsubscribes and stored replies.
- **Threading** is unchanged: In-Reply-To/References use Message-IDs; Reply-To doesn't affect them.
- **The route hold** (gates: a LIVE email waits while its reply route isn't working) is keyed by the route address
  `campaign.replyTo ?? campaign.fromAddress`.

### 2.4 Fail-closed checks (F8)

| Layer | Check | What happens |
|---|---|---|
| Launch (`launchModeProblems`, P1) | TEST/LIVE with a saved From address that doesn't fit the sending domain (`loadTeamFrom().problem`) | refused, code `"from-invalid"`, the misfit sentence |
| Transport (`MailgunTransport.send`, P1) | `senderHeaderProblem(domain, from, replyTo)` for the domain found by `mailgunDomainOf`; no `SendingDomain` row for that domain (existing NOT_ON_DOMAIN) | `TransportError` "blocked" with a `mailgun-settings` pause: reason "an email's From or reply address doesn't fit the sending domain", fix "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then click Resume." The row is released, never failed. |
| Transport, shared-From rows only (P1) | the Message-ID's domain differs from the domain found by `mailgunDomainOf` | the same blocked + `mailgun-settings` pause |
| Client (`MailgunClient.sendMessage`, P1) | the same `senderHeaderProblem(domain, input.from, input.replyTo)`, next to `checkSendGuard` | `MailgunError` kind `"sender"`, `requestStarted: false`; `mailgunFailure` maps it to the same blocked + pause; a test send shows the sentence |
| Mailgun refuses the key (401/403) in shared-From mode while a domain sending key is saved (P1) | `mailgunFailure(err, { …, teamFromWithSendingKey: true })` | the existing `mailgun-auth` pause, its fix text followed by " If this started after the From address was set, remove the domain sending key (Settings › Sending & Mailgun › Advanced › Remove the sending key) and click Resume: the API key sends then." (whether a domain sending key may send a From on another domain is not confirmed, §11 Q7). Since review SCREENS-01/SEND-2 (§13) the **Remove the sending key** button exists, and "Send me a test" and the reply test get the same pause and the sentence "Mailgun didn't accept the domain sending key." + that fix (`sendingKeyRefusedText`) |
| Launch, last transaction (P1, F29) | `mailgun.domain`, `mailgun.fromAddress` or `sending.goLive` differ from what the launch used; since review SEND-3 (§13) also `mailgun.region`, and the sender address's `SendingDomain` row is no longer active with the same name and region | refused, code `"changed"`, `LAUNCH_SETTINGS_CHANGED_TEXT`; the draft stays a draft (the existing failed-launch clean-up) |
| Test sends and the reply test (P3) | `loadTeamFrom().problem` | refused with the misfit sentence |

`senderHeaderProblem` accepts: a From on the sending domain (per-person mode; any Reply-To, as today); or a From on the
sending domain's main domain with a Reply-To that is one bare address on the sending domain itself. Everything else is
refused. A shared-From row that somehow lost its Reply-To resolves to the From domain, which has no `SendingDomain` row:
NOT_ON_DOMAIN pauses first.

### 2.5 polygonparadise.com is never Mailgun's (safety)

1. `validateSendingDomain` keeps refusing polygonparadise.com and www.polygonparadise.com: the root can never be
   `mailgun.domain`, so it never gets a `SendingDomain` row, a route, Apply, a webhook, a suppression push or an MX row
   asking for Mailgun.
2. `validateTeamFromAddress` refuses a From on (or under) the sending domain and requires the sending domain to be a
   subdomain: the From domain and the Mailgun domain can never be the same.
3. The checklist's MX row checks only the sending domain (its fix names `mail`, never `@`); the new **from-mx** row is red
   when the From domain's MX points to Mailgun (either region), and red blocks Live, the reply test and going live,
   **holds every LIVE email** (wait reason `main-domain-mx`, F27) and notifies the Owner once per 24 hours (notice key
   `from-mx-bad`). Guide 2 step 7 warns that GoDaddy's record form may fill Name with `@`.
4. A unit test (P2) builds every checklist row in shared-From mode and asserts that no row's record box is an MX record
   for the From domain, and that no fix tells the owner to add an MX record for the From domain pointing to a Mailgun
   host: the from-mx fixes only ever ask to delete Mailgun's records there or to put back the mail provider's.
5. The end-to-end test (P6, §9.3 step 9) asserts that no request the fake received has the From domain as a path segment
   and that no route expression names it.
6. Guides and the From address card say, in plain words: "Never point polygonparadise.com's mail servers (MX) to
   Mailgun, and never forward contact@polygonparadise.com to an address on mail.polygonparadise.com."

### 2.6 Where every kind of message lands (shared-From mode)

| Message | Lands | The app sees it? |
|---|---|---|
| Reply from a client that honours Reply-To (the usual case) | route `arslan@mail…` → stored + forwarded to the reply inbox | **yes**: stops follow-ups, Replied, notification |
| Reply-all in a client that also adds the From | both: route (app) and contact@ | yes (the contact@ copy is just in Zoho) |
| New email typed to contact@; a colleague writing to the address in a forward; a client ignoring Reply-To; the rest of a conversation the teammate continued from Zoho | contact@ (Zoho) only | **no** (F17: a reply → set the company to Replied; "please remove me" → do-not-email list or Do not contact) |
| Auto-reply sent to Reply-To (probably Gmail/Outlook style, unconfirmed) | route → app | yes (AUTO_REPLY; follow-ups continue) |
| Auto-reply sent to the Return-Path (RFC 3834, Sieve vacation) | Mailgun's bounce address (Likely; F25 proves the Return-Path) | no (as today) |
| Auto-reply or non-standard bounce sent to the From | contact@ only | **no** (F17: a "couldn't be delivered" notice → put that address on the do-not-email list; today such a notice to the route stops the person by itself) |
| Late bounce (DSN to the Return-Path) | Mailgun → `failed` event (Likely; F25) | yes (as today) |
| One-click unsubscribe (https) and complaints (feedback loops) | Mailgun (tracking host `email.mail…`; sending IPs) | yes (as today); Gmail/Workspace complaints never (no feedback loop) |
| `mailto:` unsubscribe | Likely `u+…@mail.polygonparadise.com` → Mailgun | yes; the pasted original checks the host (F25) |
| A forward of any of the above from contact@ to a reply address | route → app | treated as the team's own mail (F16), never a prospect reply: forwarding doesn't help |
| DMARC aggregate reports (optional `rua=mailto:dmarc@mail…`) | dmarc@ route → the Owner's inbox | forwarded, not stored (as today) |

### 2.7 Changing the From address or the sending domain

| Change | While a TEST/LIVE campaign is active | Otherwise |
|---|---|---|
| From address on, off or changed (`saveFromAddress`, P2) | refused: "Finish or cancel “Germany Q4” first: it sends with the current From address." | saved in one transaction with: `sending.goLive = false` when it was true (after the Owner confirmed in the dialog; the server requires `confirmEndGoLive: true` while live), the reply test reset to "untested" (`{...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [], setup: current.setup}`: answers and the pasted original cleared, the Setup kept, F13), activity `mailgun.fromAddressChanged`; then a domain check is queued. `sending.goLiveAt`, `goLiveDomain` and `goLiveFrom` stay for the card's "You were live with …". Earlier test emails and live campaigns stop counting (F26). |
| Sending domain changed (`connectMailgun`, existing G8) | refused (existing) | also refused when the saved From address wouldn't fit the new domain (F14), checked before the Mailgun test and again inside the transaction |
| Same sending domain, other region (`connectMailgun`, F28) | refused (as a domain change) | treated as a domain change: reply test reset, Apply run cleared, suppressions re-pushed, go-live ended, every current address's route "pending" and a route sync queued. Since review SETTING-1 (§13) every domain change, this one included, also re-writes the `mailgun.fromAddress` row with its own value (`restartEvidence`), so `loadTeamFrom().changedAt` moves and the old region's reply-test emails, pasted original, live test and checklist check stop counting; "Save and connect" adds `regionMovedText` |
| Retry of an email in a finished TEST/LIVE campaign after the From address or the sending domain changed (review SEND-1, §13) | — | refused before anything is written, code `"from-changed"` (`retrySnapshotProblem`): a shared-From snapshot whose From isn't today's, or whose Reply-To isn't on today's sending domain, or a per-person snapshot after a From address was saved. Dry runs are never refused; per-person mode with nothing saved is unchanged |
| Any of the above while a campaign is being launched | — | the launch's last transaction sees the change and refuses (F29): "The sending settings changed while this campaign was being launched (the From address, the sending domain or going live). Open the campaign and launch it again." |

Each campaign keeps its launch snapshot (From line and Reply-To), so running follow-ups never change their From.

### 2.8 The accepted risk, in the app

- The From address card shows the risk note and the "Good to know" list (§3.1) whenever a From address is saved.
- The go-live dialog names the main domain (F21); the health warning adds one sentence (F20).
- Guide 2 and the README carry the plain-words risk note: the decision is the owner's; what the app can and can't see
  (Mailgun reports complaints from Microsoft, Yahoo and others; Gmail and Google Workspace complaints never reach the
  app, only Google Postmaster Tools shows them); what to watch (the dashboard's Domain health tile, Settings ›
  Deliverability, Google Postmaster Tools for polygonparadise.com weekly); keep Settings › Deliverability › Thresholds
  as they are; the way back, in order (review SCREENS-02, §13): **Pause all sending** → cancel every scheduled, running
  or paused test or live campaign (or Resume sending and let them finish: nothing finishes while sending is paused) →
  empty the From address and click Save From address (**Change it** when live) → **Resume sending** (the reply test
  refuses while paused) → run the reply test, send a live test to the test list, click Check again, and go live again.

---

## 3. Screens and copy (exact owner-facing texts)

Every string below is the copy. `{from}` = the shared From address, `{org}` = its domain (polygonparadise.com), `{d}` =
the sending domain (mail.polygonparadise.com), `{name}` = a person's name, `{address}` = a person's own address.

### 3.1 Settings › Sending & Mailgun: the "From address" card (P2)

Placed right after "Mailgun connection". The contract `TEAM_FROM_TEXTS` (§7.5) holds these strings.

| Element | Copy |
|---|---|
| Card title | From address |
| Description | The address every campaign email comes from. Leave it empty to send from each person's own address. |
| Practice copy (instead of the form) | The practice copy never talks to Mailgun, so there is no From address to set here. |
| Not connected (instead of the form) | Connect Mailgun first: the From address must fit your sending domain. |
| Field label | From address (optional) |
| Placeholder | contact@{org} |
| Hint (`{shown}` = the typed address while it is valid, else the saved one, else the placeholder) | People see "{ownerDisplayName} <{shown}>": each person's display name with this address. Replies go to each person's own address on {d}, and from there to their reply inbox. It must end in @{org}. |
| `{ownerDisplayName}` | the Owner's `senderDisplayName`, else `suggestedSenderName(name)` ("Arslan from Polygon Paradise"; profiles are filled in later, guide 2 step 12) |
| Saved but no longer fits (`problem`; shown above the field in the destructive colour) | The saved From address {saved} doesn't fit your sending domain {d}, so test and live campaigns can't start. Change it or clear it below. |
| Risk note (shown while the field or the saved value is not empty) | Your everyday email from {org} shares this address's reputation. If people mark these emails as spam, your normal emails can land in spam too, and that takes weeks to fix. The app pauses sending when Mailgun reports complaints, but Gmail and Google Workspace never report them: only Google Postmaster Tools shows those. Keep Settings › Deliverability › Thresholds as they are, and look at Postmaster Tools once a week. |
| "Good to know" (a closed `<details>` whose summary is the heading; shown while a From address is saved) | **Good to know** · Most replies come back through the app. If someone writes a new email to {from} instead of pressing Reply, or a colleague of theirs writes to it, the app doesn't see it and the follow-ups continue: set that company's status to Replied. · If someone asks at {from} to be removed, or {from} gets a "couldn't be delivered" notice about a campaign email, put that address on the do-not-email list (Settings › Deliverability › Add an address), or set the company to Do not contact. · Forwarding such an email from {from} to a reply address doesn't help: the app treats mail from {from} as your team's own. · When you answer a prospect from {from}, the rest of that conversation stays in your inbox; the app only knows about their first reply. · Emails the app sends don't appear in the Sent folder of {from}. The company's timeline has them. · Never point {org}'s mail servers (MX) to Mailgun, and never forward {from} to an address on {d}. |
| Layout (top to bottom; the card's content is one `grid-cols-1` column, addresses with `[overflow-wrap:anywhere]`) | field → hint → Save button → risk note → "Good to know". The confirm dialog uses `SETTINGS_DIALOG_CLASS` (`src/components/settings/dialog-classes.ts`: full screen at 360–640 px). |
| Save button (outline: the page keeps one orange button) | Save From address · while saving: Saving… |
| Confirm dialog, only while live | Title "Change the From address?" · Body "Going live ends: live campaigns only reach your test list until the reply test passes again and you go live again." · Buttons **Change it** (primary) / **Keep it** |
| Toast, From set | From now on, campaign emails show From {from}, and replies go to each person's address on {d}. Run the reply test before live campaigns (Settings › Domain checklist). |
| Toast, From cleared | From now on, each person's campaign emails come from their own address on {d}. Run the reply test before live campaigns (Settings › Domain checklist). |
| Toast suffix when go-live ended | Going live ended: go live again once the reply test has passed with the new From address (Settings › Sending & Mailgun › Go live). |
| Same value | Nothing changed. |
| Refused: campaigns | Finish or cancel “Germany Q4” first: it sends with the current From address. (plural: …“A” and “B” first: they send with…) |
| Refused: on the test list | {from} is on your test list. Remove it from the test list first: it can't be a test mailbox. |
| Refused: validation | the §2.2 sentences, under the field |
| Refused: a lost connection | Couldn't reach the app, so nothing was saved. Check your connection and try again. (the existing SCREENS-11 sentence, as in `profile-form.tsx`) |

Activity `mailgun.fromAddressChanged`: "Arslan set the From address to contact@polygonparadise.com" / "Arslan changed the
From address from a@x to b@x" / "Arslan cleared the From address: each person's own address is the From again"; data
`{from, to, goLiveEnded}`.

`connectMailgun` refusal (F14), field `domain`: "Your From address {from} doesn't fit {newDomain}. Clear or change it in
the From address card first."

**Mailgun connection card** (P2; `src/core/sender-address.ts` and `connect.ts`, both modes, F28, F30):

| Case | Copy |
|---|---|
| `SENDING_DOMAIN_TEXTS.website` (polygonparadise.com or www typed as the sending domain) | Type mail.polygonparadise.com here. Your emails can still show From contact@polygonparadise.com: set that in the From address card below. |
| `SENDING_DOMAIN_TEXTS.sandbox` (new; `mailgun.org` or any `*.mailgun.org`, checked after `website`) | That's Mailgun's sandbox domain, for tests only. Type mail.polygonparadise.com (add it in Mailgun first: Send › Domains › Add new domain). |
| Wrong region, the domain is a subdomain of a main domain (`teamFromDomainFor(domain)` set; `wrongRegionSubdomainText(domain, region, other)` in `connect.ts`) | Mailgun can't find {domain} in the {region} region, only in {other}. If your main domain is in the {region} region in Mailgun, delete {domain} there and add it again in the {region} region (Mailgun guide, step 4). Otherwise change Region to {other}. |
| Wrong region, any other domain | the existing `wrongRegionText` (unchanged) |
| Region-only change: activity summary | Arslan moved mail.polygonparadise.com from the EU region to the US region (type `mailgun.domainChanged`, data `{from, to, fromRegion, toRegion, …}`) |
| Region-only change: the go-live-ended note | the existing `GO_LIVE_COPY.endedByDomainChange(old, new)` with `old` = "mail.polygonparadise.com (EU)" and `new` = "mail.polygonparadise.com (US)" |

### 3.2 Settings › Domain checklist (P2 rows, P3 page)

**Page header** (P3, `domain/load.ts`): unchanged first line "Domain checklist for mail.polygonparadise.com (US) ·
checked 2 minutes ago"; in shared-From mode a second line: "Emails show From contact@polygonparadise.com and go out
through mail.polygonparadise.com."

**Row order**: unchanged, with the two new rows right after "Mail servers know your policy (DMARC)", only in
shared-From mode. Both are in the "dns" group.

**Titles of the two new rows.** `row()` in `checklist.ts` titles every row with `checklistTitle(key, f.domain)` (the
sending domain). The from-* rows are built by a separate helper, `fromRow(f, key, …)`, which calls
`checklistTitle(key, f.from!.domain)`, so they read "Mail for polygonparadise.com …", never "Mail for
mail.polygonparadise.com …". The seed and every doc quote use `checklistTitle("from-mx", <From domain>)` (§6.2, §9.4).
The MX row's own title stays "Replies reach the app (MX)" (critique C2-19: the two titles are already distinct).

**from-mx** — title `Mail for {org} stays with your mail provider (MX)`; never-checked title (CHECKLIST_ROW_TITLES)
"Mail for your main domain stays with your mail provider (MX)". No record box (the app doesn't know the provider's
values); Details = both resolvers' answers.

| Case | Status | Text | Fix |
|---|---|---|---|
| either resolver sees an MX host ending in `mailgun.org` | bad | {org}'s mail servers (MX) point to Mailgun. Email to {from} would go to Mailgun instead of your inbox, and replies the app forwards there would be lost. Live campaign emails wait until this is fixed. | In the DNS panel for {org}, delete the MX records of {org} (Name @) that point to Mailgun, and keep only {others, comma-separated}. Never add Mailgun's MX records to {org}. Then click Check again. — with no other host: "…that point to Mailgun, and put back your mail provider's MX records. Never add…" |
| both resolvers: no MX | bad | {org} has no mail servers (MX), so nobody can email {from}, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed. | Add your mail provider's MX records for {org} (Name @). Its help pages list them. Then click Check again. |
| an MX host ending in `mx.cloudflare.net` (Cloudflare Email Routing), none Mailgun | warn | Mail for {org} goes to Cloudflare Email Routing ({hosts}), not straight to your mail provider. | If your mailbox is with another provider, switch Email Routing off for {org} in Cloudflare and put back the provider's MX records (Cloudflare guide, step 1). |
| one resolver sees MX, the other not yet | warn | Still spreading. Check again in 30 minutes. | — |
| a timeout and no answer | unknown | Couldn't check right now. | — |
| MX present, none Mailgun or Cloudflare, both agree | ok | Mail for {org} goes to your mail provider ({hosts}), not to Mailgun. Keep it that way. | — |
| the saved From doesn't fit the sending domain | bad | The From address {saved} doesn't fit your sending domain {d}. Change or clear it in Settings › Sending & Mailgun. | — |

A "warn" here blocks going live (every go-live row must be "ok") but never Live mode or sending. An owner who really
routes {org}'s mail through Cloudflare Email Routing can't go live in shared-From mode; that isn't this owner (Zoho),
and the guides say never to switch it on.

**from-spf** — title `{org}'s SPF record (your everyday email)`; never-checked title "Your main domain's SPF record
(your everyday email)". Never blocks anything; "bad" notifies the Owner (F27). No fix ever suggests removing
`include:mailgun.org` or builds a merged record (a merge from includes alone would drop `ip4`/`a`/`mx` terms and change
`-all`).

| Case | Status | Text | Fix |
|---|---|---|---|
| 2+ SPF records on either resolver | bad | {org} has {n} SPF records, so mail servers ignore all of them. This affects your everyday email. | Ask the person who set up the app to merge them into one record, keeping every part of both (including include:mailgun.org). |
| an `include:` (or `redirect=`) whose name has no SPF record on both resolvers (`countSpfLookups(…).dangling`) | bad | {org}'s SPF record includes {name}, which has no SPF record, so mail servers treat {org}'s SPF as broken. This affects your everyday email. | If {org}'s DNS moved recently, add the TXT record of {name} again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app. (review SCREENS-09: the old DNS host usually stops showing the zone after the move) |
| more than 10 DNS lookups | bad | {org}'s SPF record needs {n} DNS lookups (the limit is 10), so mail servers treat it as broken. This affects your everyday email. | Ask the person who set up the app to remove services you no longer use from it. Keep include:mailgun.org: Mailgun needs it to keep {org} verified, and {org} signs your emails. |
| 9 or 10 lookups | info | {org}'s SPF record is almost full ({n} of 10 DNS lookups). Before you add another email service to {org}, ask the person who set up the app. | — |
| no SPF record (both agree) | info | {org} has no SPF record. The app's emails don't use it, but your everyday email should have one. | Your mail provider's help pages show the record to add (Name @). |
| spreading / timeout | warn / unknown | the standard sentences | — |
| otherwise | ok | {org}'s SPF record is fine ({n} of 10 DNS lookups). The app's emails don't use it; they use {d}'s. | — |

(At 9 of 10 lookups the owner's zone shows the grey "info" row, never amber, so amber keeps meaning "look at this".)

**dmarc** in shared-From mode (per-person mode unchanged): checks `_dmarc.{org}` (the walk starts at the From domain).
Record box value stays `v=DMARC1; p=none`, name `_dmarc`.

| Case | Status | Text | Fix |
|---|---|---|---|
| none found | bad | No DMARC policy found for {org}, the domain in your From address. | Add a TXT record. Name: _dmarc. Value: v=DMARC1; p=none. It also covers your everyday email from {org}; p=none changes nothing for it. |
| `aspf=s`, and `adkim=s` with a signer other than {org} (or no signer known) | bad | {org}'s DMARC record asks for strict alignment (adkim=s and aspf=s), so emails sent through {d} fail it. | Remove adkim=s and aspf=s from the record (relaxed is the default). Don't change anything else in it. |
| two records, spreading, timeout | as today (with {org}) | | |
| unauthorised rua | warn | as today (with {org}) | Use dmarc@{d} or remove rua. (the sending domain: its dmarc@ route forwards reports to you; the same organisation, so no authorisation record is needed. dmarc@{org} would go to your everyday inbox, not through the app.) |
| found, p=none | ok | {org}'s policy: monitor only. Right for now. | — |
| found, quarantine/reject | ok | {org}'s policy: {p}. | — |

**dkim** (both modes): a 1024-bit key is now **ok**: per-person "Your emails carry {d}'s digital signature (1024-bit;
it works, 2048-bit is stronger)."; other sizes as today. Shared-From mode names the signer (`signingDomainOf`: the part
after `._domainkey.` of the first active DKIM record Mailgun lists): signer = {org} → "Your emails carry {org}'s digital
signature{bits}, which matches your From address."; signer = {d} (or another subdomain of {org}) → "Your emails carry
{signer}'s digital signature{bits}. It fits your From address {from}: same main domain. ({org} doesn't sign them: if you
expected it to, check that both domains are in the same Mailgun account and region, US.)" Missing/mismatch texts
unchanged.

Shared-From mode, **Mailgun lists no DKIM record** for {d} (today: "unknown", "Check the domain in Mailgun", which
would block going live with no way forward):

| Case | Status | Text | Fix |
|---|---|---|---|
| the reply test's pasted original for this domain and From (`facts.from.originalSigner`) shows `dkim=pass` with `header.d` = {org}, {d} or another subdomain of {org} | ok | Mailgun doesn't list a DKIM record for {d}, but the reply test's email was signed by {signer} (dkim=pass), which fits your From address. | — |
| no pasted original yet | unknown | Mailgun didn't list a DKIM record for {d}. With a From address, {org} usually signs your emails. | Run the reply test (below) and paste one test email's original: the app reads the signature from it. If it shows no signature, check in Mailgun (Send › Domains) that {org} and {d} are both there, in the same region (US). |
| an original was pasted but shows no passing signature of {org} or its subdomains | warn | The reply test's email carried no valid signature of {org}. | Check in Mailgun (Send › Domains) that {org} is still there and verified, and that {d} is in the same region (US). Then send the reply test's emails again and paste a new original. |

"Unknown" and "warn" never block Live mode or the reply test (`isMissing` counts only missing and "bad"), so the reply
test can always run again and settle the row; going live needs "ok" and a fresh check (as always).

**postmaster** in shared-From mode reads the From domain's TXT: ok "A Google verification record is on {org}. Check at
postmaster.google.com that {org} is listed there."; info "Optional: see how Gmail rates {org}, the domain in your From
address." fix "Open postmaster.google.com, click Add new domain, type {org}, copy the TXT record it shows and add it
(Name @). It shows data only once you send enough email."

**domain-age** in shared-From mode is about the From domain: "{org} is 1,132 days old." and the date field "When did
you buy polygonparadise.com?" (P3's form label uses the From domain). The owner enters 2024-08-22.

**reply-routes** empty-list sentence (P3, `checklist.tsx`): shared-From mode "Nobody has a reply address yet. Everyone
adds theirs in Settings › My profile › Reply address."

**reply-test** row (P2, `replyTestRow`; the facts carry `replyTest.from` and today's From): a pass counts only through
`replyTestPassedFor(setting, f.domain, today's From)`. Per-person texts unchanged. Shared-From mode:

| Case | Status | Text | Fix |
|---|---|---|---|
| passed for this domain and From | ok | Setup {setup} passed on {date} with the From address {from}: replies arrive in your inbox, unsubscribe links work, and the test email passed DMARC. | — |
| failed for this domain and From | bad | Setup {setup} didn't pass with the From address {from}. | The reply test section says which check failed. If it was the return address or DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on {d}) and ask the person who set up the app. |
| a stored result for another From (or none) | warn | Not tested yet with the From address {from}. Live campaigns start once this passes. | — |

The per-person failed-row fix ("a separate reply address such as ali@reply.<domain>…") is never shown in shared-From
mode.

### 3.3 Mode gates and go-live (contract; §7.5)

- `MODE_GATE_TEXTS.fromMx` (the row is "bad"): "Mail for your main domain points to Mailgun or is missing. It must stay
  with your mail provider, never Mailgun (Domain checklist)." `MODE_GATE_TEXTS.fromMxUnchecked` (no from-mx row yet,
  e.g. right after the From address was saved): "The Domain checklist hasn't checked your main domain's mail servers
  (MX) yet. Click Check again on the Domain checklist." Shown for Live, the reply test and a LIVE launch in shared-From
  mode, right after the DNS sentence.
- Going live (shared-From mode) also needs the from-mx row "ok" (`goLiveRowKeys(true)`), in the "…: not done yet
  (Domain checklist)." form (the sentence uses the row's own title, so it names polygonparadise.com). The Domain
  checklist must have been checked after the From address last changed; when it wasn't (but is otherwise fresh), the
  blocker is `MODE_GATE_TEXTS.checkBeforeFromChange`: "The Domain checklist was checked before the From address or the
  sending domain changed. Click Check again on the Domain checklist, then come back." (instead of `checkStale`; "or the
  sending domain" since review SETTING-1, §13).
- `GO_LIVE_COPY.dialogTeamFromItem(from, org)`: "Every email shows From {from}. Complaints about them count against
  {org}, the domain your everyday email uses." (third item, after "Warm-up starts today…").
- `GO_LIVE_COPY.dialogOwnFromItem(example)` (per-person mode, F21): "Every email shows From the sender's own address,
  for example {example}." (`example` = the Owner's From line, "Arslan from Polygon Paradise
  <arslan@mail.polygonparadise.com>"; the same place as the team item). Shown only when the caller passes `from`, so
  existing callers and tests are unchanged.
- `GO_LIVE_COPY.spamPlacementTick(where)` (a required checkbox in the dialog while the reply test recorded a spam
  placement, F12): "I know the reply test's email landed in spam at {where}. Go live anyway: fewer people there may see
  our emails at first." `GO_LIVE_COPY.spamPlacementRequired`: "Tick the box about the spam folder first."
- `GO_LIVE_COPY.liveFromLine(from)`: "Emails show From {from}; replies go to each sender's own address." (under the
  live line).
- `GO_LIVE_COPY.descriptionAfterFromChange(was, now)`: "You were live with {was ?? "each person's own address"} as the
  From address. After the change to {now ?? "each person's own address"}, live campaigns only reach your test list until
  you run the reply test and go live again."
- `GO_LIVE_COPY.endedByFromChange`: "Going live ended: go live again once the reply test has passed with the new From
  address (Settings › Sending & Mailgun › Go live)."
- `GO_LIVE_RECOMMENDATION_TEXTS.spamPlacement(where)`: "The reply test's email landed in spam at {where}. Emails from
  your From address may land in spam there at first: start with small campaigns and watch the replies." (`where` e.g.
  "Outlook.com (tess@outlook.com)").
- `GO_LIVE_RECOMMENDATION_TEXTS.postmasterTeam(org)`: "Add {org} to Google Postmaster Tools, so you can watch how Gmail
  rates the domain your everyday email shares (Mailgun guide, step 16)."

### 3.4 The reply test in shared-From mode (P3)

- Test emails: From "{ownerDisplayName} <{from}>", Reply-To the Owner's own address; each `TestSend` row stores
  `teamFrom` = {from} (F26). The intro line (reply-test-section line 300): "Send the test emails: one to each mailbox on
  your test list, from {from} (replies go to {ownerAddress})."
- **Which emails count** (F26): per mailbox the newest reply-test email with `teamFrom` = today's From and `sentAt` ≥ the
  From address's last change; the unsubscribe click counts only on those emails. Emails sent before a From change show
  as "Not sent yet with this From address", so the Owner sends the test emails again.
- **Order of the questions** in each mailbox's box (placement first, because the test email's body asks to move it to the
  inbox before replying): 1. "Did the test email arrive in this mailbox's inbox, not in spam or junk? (Gmail's
  Promotions or Updates tab counts as the inbox.)" Yes / No. 2. the existing "Did the reply arrive in your reply inbox,
  not in spam?" 3. the existing "Does it say dkim=pass or arc=pass?" 4. "Open the test email's original (Gmail: ⋮ › Show
  original. Outlook.com: ⋯ › View › View message source). Does it say DMARC: PASS (Gmail) or dmarc=pass?" Yes / No / Not
  sure. "Not sure" opens "Paste the test email's original here, and the app reads it for you." with the existing **Read
  the headers** button; the text is never stored.
- The "Show original" help for the **reply** (question 3) adds the reply inbox the owner actually uses: "Zoho Mail: open
  the email, click ⋯ (More actions) › Show original (it may be called View original)." (label not confirmed).
- **One pasted original** (new part, below the mailboxes, shared-From mode only; required, F25): heading "The test
  email's original"; text "Open one test email in a test mailbox, show its original (Gmail: ⋮ › Show original › Copy to
  clipboard; Outlook.com: ⋯ › View › View message source, select all, copy) and paste the whole text here. The app reads
  who sent it, its return address, DMARC and the signature, and doesn't keep the text."; a text box and the button
  **Read the original** (outline). After reading, one line per check, from `testOriginalTexts(result, {from, d, org})`:
  - From: "From: {from} ✓" / "From: {found}, not {from}: paste the original of a test email sent after the From address
    was set." (not accepted);
  - Return-Path: "Return address: …@{returnPathDomain} ✓ (bounces and automatic replies reach the app)" / "Return address:
    …@{returnPathDomain}, not on {d}: bounces and automatic replies would go to your everyday inbox instead of the app." /
    "The original doesn't show a return address. Paste the whole original, starting at the first line.";
  - DMARC: the `dmarcResultsText` sentence;
  - Signature: "Signed by {signer} ✓" / "No valid signature found.";
  - Unsubscribe: "Unsubscribe by email: …@{mailtoDomain} ✓" / "Unsubscribe by email goes to …@{mailtoDomain}, not to
    {d}." / (no mailto) "Unsubscribe by email: not offered (the link works) ✓".
  The service accepts the paste only when the original's `Message-ID` is one of the reply-test emails that count (above);
  otherwise: "This isn't one of the current test emails. Paste the original of a test email sent with the From address
  {from}." It then stores `ReplyTestOriginal` (§7.2) in `mailgun.unsubscribeTest.original` and sets that mailbox's DMARC
  answer from it (`dmarcFromHeaders: true`).
- The List-Unsubscribe question gets a note in shared-From mode: "If it also shows a mailto: address, the part after the
  @ must end in {d} (for example u+…@{d} or …@email.{d}). If it is …@{org}, answer No."
- **Verdict in shared-From mode** (`evaluateReplyTest(…, { teamFrom, sendingDomain })`): incomplete until every mailbox
  has answered placement and DMARC and an original is stored; **failed** when any DMARC answer is "fail", the original's
  `returnPathOk` is false, its `mailtoOk` is false, or the headers answer is No; **passed** otherwise (per-person rules
  unchanged), with `warnings` for each spam placement.
- `REPLY_TEST_TEXTS` additions (P3): per mailbox next steps "{address}: answer whether the test email arrived in the
  inbox." and "{address}: answer whether the test email's original says DMARC: PASS."; "Paste one test email's original
  (below the mailboxes)."; failures "{address}: the test email didn't pass DMARC, so inbox providers may treat it as
  fake. Check the "Mail servers know your policy (DMARC)" row on the Domain checklist.", "The test email's return
  address is on {returnPathDomain}, not on {d}, so bounces and automatic replies would go to your everyday inbox instead
  of the app. Clear the From address in Settings › Sending & Mailgun and ask the person who set up the app."; warning
  (verdict passes) "{address}: the test email landed in spam."; headers failure in shared-From mode "The test email's
  List-Unsubscribe header is missing, or its mailto: address isn't on {d}. Click Apply recommended settings and send the
  test emails again; if it stays that way, ask the person who set up the app."; the shared-From failure sentence of the
  section (replacing "a separate reply address such as ali@reply.<domain>…", reply-test-section.tsx line 455): "The reply
  test didn't pass with the From address {from}. The lines above say which check failed. If it was the return address or
  DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on {d})
  and ask the person who set up the app."
- `parseDmarcResult(text, {fromDomain})` reads the top-most Authentication-Results set that isn't Mailgun's (same
  selection as `parseAuthResults`): `dmarc=pass` → "pass", `dmarc=fail` → "fail", anything else (none, bestguesspass,
  temperror, permerror, missing) → null; a result whose `header.from=` names another domain is ignored.
  `dmarcResultsText`: "The original says DMARC: PASS." / "The original says DMARC: FAIL." / "The original doesn't show a
  DMARC result. Paste the whole original, starting at the first line."
- `parseTestOriginal(text, { sendingDomain, fromDomain })` (pure, `core/reply-test.ts`, P3) returns `{ messageId, from,
  returnPathDomain, returnPathOk, dmarc, dkimSigner, mailtoDomain, mailtoOk }`: `from` = the first `From:` header's
  address; `returnPathDomain` = the domain of the top-most `Return-Path:` header, else of `smtp.mailfrom=` in the chosen
  Authentication-Results set (null when neither); `returnPathOk` = that domain is {d} or ends with ".{d}" (null when
  unknown; exactly {org} or anything else → false); `dmarc` = `parseDmarcResult`; `dkimSigner` = the `header.d` (or
  `header.i` domain) of a `dkim=pass` result in the chosen set whose signer is {org} or under it, else null;
  `mailtoDomain`/`mailtoOk` = the host of a `mailto:` in `List-Unsubscribe:` (true when there is no mailto, false when
  it is exactly {org} or not on or under {d}, null when there is no List-Unsubscribe header). Unfolds continuation
  lines, ignores comments, case-insensitive; never stores the text.
- `decideReplyTest` stores `from: teamFrom` and is a compare-and-set: inside its transaction it re-reads
  `mailgun.fromAddress` and `mailgun.domain` and refuses when either differs from what the verdict was computed with
  ("The From address or the sending domain changed while you were deciding. Open the reply test again.").
- The section's stored-result line ("decided") shows only a decision for today's domain **and** From.

### 3.5 Send me a test (P3)

Shared-From mode: From "{senderDisplayName} <{from}>", Reply-To the sender's own address, to the viewer's reply inbox
(unchanged guard). When that inbox equals the From address, the success message gains: " It comes from {from}, your own
address: if it isn't in your inbox within a few minutes, look in spam." Without a reply address:
"{Name} has no reply address yet. {Name} can add one in Settings › My profile."

### 3.6 My profile, Team, Limits (P4) — `senderAddressWords(teamFrom)`

| Place | Per-person mode (unchanged) | Shared-From mode |
|---|---|---|
| Profile field label | Sending address | Reply address |
| Profile hint | People see this address in their inbox. Replies to it are forwarded to your reply inbox. | People see {from} as the sender, with your display name. When they press Reply, their answer goes to this address: the app records it, and Mailgun forwards it to your reply inbox. |
| Profile, nothing yet | No sending address yet. Type the name before the @ and save your profile. | No reply address yet. Type the name before the @ and save your profile. |
| Signature hint | Plain text. It's added where a template says {{sender_signature}}. | + " If your signature shows an email address, use your reply address ({address}), so answers reach the app." |
| Profile toast | Profile saved. Your sending address is now {address}; its reply route is being set up. | Profile saved. Your reply address is now {address}; its reply route is being set up. |
| Owner notice (sender-addresses.ts) | title "{name} changed their sending address", body "From now on {name}'s campaigns come from {address}." | title "{name} changed their reply address", body "From now on, replies to {name}'s campaigns go to {address}." |
| Activity | "{name} set their sending address to {address}" | "{name} set their reply address to {address}" |
| Limits column / empty text | Sending address · "Nobody has a sending address yet. Each person adds one in Settings › My profile." | Reply address · "Nobody has a reply address yet. Each person adds one in Settings › My profile." |
| Team switch-off intro | …Replies to {name}'s sending address will come to your inbox from now on. | …Replies to {name}'s reply address will come to your inbox from now on. |
| Profile, before Mailgun is connected (`SENDER_ADDRESS_TEXTS.noDomain`, sender-addresses.ts:39; profile-form.tsx:245) | Your sending address is set up once the Owner connects the sending domain in Settings › Sending & Mailgun. | unchanged (no From address can be saved before a domain exists) |
| Someone else's address (`notYours`, sender-addresses.ts:40) | Only the Owner can change someone else's sending address. | Only the Owner can change someone else's reply address. |
| Change blocked (sender-addresses.ts:46) | You can't change your sending address while your campaigns are running or paused (…). … | You can't change your reply address while your campaigns are running or paused (…). … |
| Profile saved, address unchanged (profile/actions.ts:59) | Your profile is saved, but your sending address didn't change: … | Your profile is saved, but your reply address didn't change: … |
| Limits table cell (sender-caps-form.tsx:88) | No sending address yet | No reply address yet |
| "Reply route: …" status lines | unchanged | unchanged |

P1 and P3 carry the same words in their files (`addresses.ts:18`, `launch.ts:150`, `test-send.ts:73`,
`reply-test.ts:346` `OWNER_ADDRESS_MISSING_TEXT` → "Add your reply address first in Settings › My profile.",
`sender-step.tsx`, `checklist.tsx:76`, `reply-test-section.tsx:300`). P7's vocabulary sweep (§9.1) checks that no text
built in shared-From mode says "sending address".

### 3.7 Campaign wizard, campaign page, outbox (P1)

- Sender step: "Recipients see" shows the From line ("Arslan from Polygon Paradise <contact@polygonparadise.com>"); the
  second label is **Reply address** (shared-From) / Sending address; the bottom info line becomes "Reply addresses,
  display names and signatures are set in Settings › My profile. The From address ({from}) is set by the Owner in
  Settings › Sending & Mailgun. The Owner sets each teammate's own daily limit in Settings › Limits & warm-up." The
  no-address note uses the words helper ("{name} has no reply address yet: …").
- Launch problem `no-sender-address`: "{who} has no reply address yet. {who} can add one in Settings › My profile."
  (shared-From); new `from-invalid`: the misfit sentence.
- Campaign page header: "Sent by Arslan as Arslan from Polygon Paradise <contact@polygonparadise.com>, replies to
  arslan@mail.polygonparadise.com".
- Campaign page, shared-From campaigns with follow-ups still to come, one muted line under the follow-ups
  (`TEAM_FROM_TEXTS.followUpReminder(from)`): "Replies written straight to {from} don't reach the app. If someone
  answered there, set their company to Replied so the follow-ups stop." The wizard's Sender step shows the same line in
  shared-From mode.
- Waiting line for the new hold (`waitingText`, reason `main-domain-mx`, F27; reworded by review SCREENS-07 to match
  the gate text and the notice): "Waiting: mail for your main domain points to Mailgun or is missing, so replies
  forwarded to your inbox would be lost. The Owner can see how to fix it in Settings › Domain checklist." Since review
  SECURITY-3 the hold applies only while a From address is saved (per-person mode never waits on a leftover row).
- Launch refused because a setting changed meanwhile (F29, `LAUNCH_SETTINGS_CHANGED_TEXT`): "The sending settings
  changed while this campaign was being launched (the From address, the sending domain or going live). Open the campaign
  and launch it again."
- Dry-run outbox email: a "Reply-To" row after "From" when set.

### 3.8 Dashboard, health, notices (P4)

- Attention item `go-live-again` also after a From change (not live, `sending.goLiveAt` set, same domain,
  `sending.goLiveFrom` ≠ today's From): Owner "You changed the From address. Live campaigns only reach your test list
  until you run the reply test and go live again." (link "Open Go live"); Member "Live campaigns only reach the test list
  until the Owner goes live again with the new From address."
- The checklist attention item counts the from-mx row as a go-live row in shared-From mode.
- Health warning (the existing half-limit notice) in shared-From mode, appended to its body: " Your emails come from
  {from}, so these complaints also count against your everyday email. Gmail's complaints aren't in this count: check
  Google Postmaster Tools." (bounce warnings unchanged).
- Owner notices from the domain check (P2, `domain-check.ts`, through `shouldSendNotice`, type `system.mailgun`, link
  `/settings/domain`; F27):
  - key `from-mx-bad`, while the from-mx row is "bad": title "Mail for {org} goes to the wrong place", body "{org}'s
    mail servers (MX) point to Mailgun or are missing, so your everyday email and forwarded replies can be lost. Live
    campaign emails wait until it's fixed. Open Settings › Domain checklist.";
  - key `from-spf-broken`, while the from-spf row is "bad": title "{org}'s SPF record is broken", body "{the row's
    text} Open Settings › Domain checklist."

---

## 4. Every Mailgun flow, one by one

| Flow | Shared-From mode | Package |
|---|---|---|
| Connect (`connectMailgun`) | unchanged, plus F14, F28 (region change) and the subdomain wrong-region sentence | P2 |
| Context (`getMailgunContext`, `domainsToSync`, `clientFor`) | unchanged; `lastLiveSendAt`, which `domainsToSync` and restore.mjs read, is written by `sendingDomainId` (F6) | P1 (the loop) |
| Routes (per sender `^arslan@mail\.polygonparadise\.com$`, catch-all, dmarc@) and `/routes/match` | unchanged; the per-sender route address is the Reply-To; forwards to each reply inbox (contact@ allowed) | — |
| Loop rule (`isSafeForwardAddress`, profile, routes, domain page) | unchanged (F9) | — (a pinning test in P4) |
| Event webhooks, inbound webhook, `isOurDomain` | unchanged (events carry `mail.`) | — |
| Catch-up (queue, drift, suppressions, Logs, stored replies) | unchanged | — |
| Reconciler | domain from `mailgunDomainOf(row.fromAddress, row.replyTo)` | P1 |
| Restore scan, `domainsBefore`, restore.bat | unchanged; re-created rows get the campaign's From and Reply-To | P1 |
| Suppressions push/pull, "Remove it" | unchanged | — |
| Health counting, warm-up, per-sender caps, pacing | unchanged (app-wide or by sender); health note (F20) | P4 |
| Go-live (`goLiveDomain` = mail.polygonparadise.com, G8) | unchanged key; + `goLiveFrom`, F13 | P3 |
| Apply recommended settings | unchanged; never touches the From domain | — |
| Domain check | + From-domain DNS facts (DNS only, never a Mailgun call for it) | P2 |
| Threading, Message-IDs | unchanged | — |
| Inbound attribution (`senderAddressId`, assignees, notify set) | unchanged: the route address is still the SenderAddress | — |
| Reply processing, classification, internal senders | internal senders + From address and domain (F16) | P4 |
| Test-list guard (`checkSendGuard`) | unchanged; the sender-header check sits next to it (F8) | P1 |
| Sending gates | + the `main-domain-mx` hold for LIVE (F27) | P1 |
| Send me a test, reply test | team headers; `TestSend.teamFrom`; F12, F15, F25, F26 | P3 |
| Address checks | unchanged (account-level) | — |

---

## 5. Checklist facts and DNS gathering (P2)

- `ChecklistFacts.from?: FromDomainFacts | null` (contract type, §7.5): absent/null = per-person mode.
- `signingDomainOf(m: MailgunDomainFact): string | null` (P2, `core/dns/checklist.ts`): the part after `._domainkey.`
  of the first active TXT/CNAME sending record whose name contains `._domainkey.`; null when none.
- `gatherFromDomainFacts(fromDomain, lookups)` (P2, `checks/dns-facts.ts`): TXT at the From domain (both resolvers), the
  SPF lookup count and the includes that have no SPF record (first resolver, `countSpfLookups`, which gains
  `dangling: string[]`: include/redirect names whose TXT answer is "missing" or holds no `v=spf1` record; a timeout
  still only makes the count incomplete; the existing SPF row ignores the new field), MX (both), the DMARC walk from the
  From domain (both) and rua authorisations — the same helpers `gatherDnsFacts` uses. No Mailgun call.
- `runDomainCheck` (P2): reads `loadTeamFrom()`; when a From address is saved, fills `facts.from` (with `problem` when it
  doesn't fit, and `originalSigner` = `mailgun.unsubscribeTest.original.dkimSigner` when that original's `domain` and
  `from` equal today's); passes today's From into `facts.replyTest.from`; the DKIM key-size measurement is unchanged (it
  reads Mailgun's own key, whichever domain it is named on). After storing the rows it sends the F27 notices (§3.8).
- Fake mode (`mailgunRecordsLookup(domain, m, { fromDomain })`, P2): besides today's answers, for the From domain: MX
  `10 mx.mail-provider.invalid`, TXT `v=spf1 include:_spf.mail-provider.invalid ~all`, `_spf.mail-provider.invalid` TXT
  `v=spf1 ip4:192.0.2.10 ~all` (so the include isn't dangling), and `_dmarc.<fromDomain>` = `v=DMARC1; p=none` once
  every Mailgun record is valid (today's rule); every other From-domain name is "missing". So the lead's manual checks
  show from-mx and from-spf green without touching real DNS. Fake mode can't show from-mx red: a unit render test does
  (§9.1).
- `buildChecklistRows` (P2) adds from-mx and from-spf after dmarc when `facts.from` is set; the dmarc, dkim, postmaster
  and domain-age rows use `facts.from` as §3.2 says.

---

## 6. Owner docs (P5)

Real names throughout: polygonparadise.com, contact@polygonparadise.com, mail.polygonparadise.com, Zoho Mail (the
owner's mail provider), GoDaddy (DNS today), US region. Step numbers and the guides' first headings stay (the
`guide-refs` test: guide 2 has 19 steps, guide 4 has 13); heading texts may change, and every link and anchor that
points at a changed heading is updated (the links test checks them). Every quoted label comes from §3 or `src/`.

### 6.1 README.md

- "Start here": guide 2 line becomes "…the sending subdomain mail.polygonparadise.com, Mailgun, the DNS records, your
  From address contact@polygonparadise.com, the reply test…".
- "Have these ready": replace "a domain just for sending email (never polygonparadise.com)" with "nothing new to buy for
  sending: the app sends through mail.polygonparadise.com, part of your own domain, and your emails show From
  contact@polygonparadise.com"; test mailboxes "none of them your reply inbox or contact@polygonparadise.com".
- "Mailgun, DNS and reply routes": the subdomain in the **US** region; polygonparadise.com stays in Mailgun and signs
  the emails; the From address card; each person's reply address; never Mailgun's MX on polygonparadise.com.
- "A campaign in six steps": "2. **Sender**: whose name, reply address and signature it goes out with."
- "Replies": a new first-level bullet: "**Replies sent straight to contact@polygonparadise.com don't reach the app.**
  Most people press Reply, which goes to the sender's reply address and through the app. When someone writes a new
  email to contact@ instead (or a colleague of theirs does), set that company's status to **Replied** so the follow-ups
  stop. If someone asks there to be removed, or contact@ gets a "couldn't be delivered" notice about a campaign email,
  set the company to **Do not contact** (the Owner can also put just that address on the do-not-email list: Settings ›
  Deliverability › Add an address). Forwarding such an email from contact@ to a reply address doesn't help: the app
  treats mail from contact@ as your team's own."
- "Your team": the profile sentence names **Reply address** ("the part before the @ on mail.polygonparadise.com") and
  says the reply inbox may be contact@polygonparadise.com. One line for the practice copy: "The practice copy has no
  From address, so it still says **Sending address** and shows a placeholder From; the real app says Reply address."
- "Sending safely": new bullet "**Your main address's reputation.**" with the risk note of §2.8 in plain words (Gmail and
  Google Workspace complaints never reach the app; keep Settings › Deliverability › Thresholds as they are), what to
  watch (Domain health on the dashboard, Settings › Deliverability, Google Postmaster Tools for polygonparadise.com,
  weekly) and **the way back, in order** (rewritten by review SCREENS-02, §13; the README carries the exact words): "1.
  Click **Pause all sending**. 2. Cancel every test or live campaign that is scheduled, running or paused (**Cancel
  campaign**); nothing finishes while sending is paused, so to let one finish, click **Resume sending** and wait (it
  keeps sending From contact@polygonparadise.com). 3. Empty the From address and click **Save From address** (after
  going live: **Change it**). 4. If sending is still paused, click **Resume sending**: the reply test can't send while
  paused. 5. Run the reply test, send a live campaign to the test list, click **Check again**, and go live again."
- "Going live" bullet: "If you change the sending domain or the From address later, going live ends…".
- Troubleshooting: the from-mx red row (and "Live emails are waiting: mail for your main domain points to Mailgun");
  "Send me a test didn't arrive" (from yourself to yourself: look in spam, or use another reply inbox for the test);
  "The reply test says the return address is on polygonparadise.com" → clear the From address, ask the person who set
  up the app.
- "What it costs": domains row "No domain to buy for sending (mail.polygonparadise.com is part of polygonparadise.com);
  maybe one for the app's address." The Mailgun row says Foundation is needed (an existing Free or trial account must be
  upgraded).
- Glossary: **From address** ("the address every email shows, contact@polygonparadise.com; set by the Owner"),
  **Reply address** ("each person's own address on mail.polygonparadise.com; replies go there, the app records them and
  Mailgun forwards them to that person's reply inbox"). "Warm-up" no longer says "a new sending domain" only.
- The quoted "Reply route: Being set up…" stays.

### 6.2 docs/setup/2-mailgun-and-dns.md (rewritten for this shape; 19 steps kept)

| Step | Content |
|---|---|
| intro | This guide sets up Mailgun so that your emails arrive From contact@polygonparadise.com, sent through the subdomain mail.polygonparadise.com; names used are the real ones (line 7's "send.example.com stands for…" is replaced). The risk note (a short box "Your decision, and what to watch", with the Gmail/Workspace sentence of §2.8). |
| 1 Before you start | Foundation plan (an existing Free or trial account must be upgraded); business verification; DNS at GoDaddy; your mail provider is Zoho Mail and stays so; test mailboxes (one Outlook.com, one Gmail; never contact@); Mailgun's rules on cold email. Line 17 ("A separate domain just for outreach… Never polygonparadise.com itself") is replaced. The "What you'll set up" table without "buy a domain" and with "the domain (US)" (line 29). |
| 2 Your sending subdomain (nothing to buy) | mail.polygonparadise.com is part of polygonparadise.com; check in GoDaddy's DNS panel that no record named `mail` exists yet (a `mail` CNAME would block the MX and SPF records: tell the person who set up the app); never switch on email forwarding for `mail`. (The domain-buying text moves to guide 3 step 1 (c).) |
| 3 The Mailgun account | "You already have a Mailgun account. Open **Account › Plan** (it may be called **Billing**). If it doesn't say **Foundation**, click **Upgrade** and choose Foundation." Business verification as today. (Line 54's "Sign up … choose Foundation" is replaced.) |
| 4 Add mail.polygonparadise.com in Mailgun | Send › Domains: **polygonparadise.com is already there: keep it. Never delete it** (its signature key can't be moved or recovered), **and leave the sandbox domain alone.** It signs your emails. Mailgun shows its MX records as unverified: that's correct; never add them. Add **mail.polygonparadise.com**, **Region: US** (the same as polygonparadise.com). How to tell a domain's region: its DNS page lists MX values ending in `eu.mailgun.org` (EU) or just `mailgun.org` (US). If mail.polygonparadise.com already exists in the EU region, delete **that one** and add it again in US (nothing is lost yet); if Mailgun won't take the name again straight away, wait a day or ask Mailgun support (unconfirmed). If Mailgun says you've reached your domain limit, upgrade first (step 3). DKIM: leave the DKIM authority on polygonparadise.com (Mailgun's default) and leave **Automatic Sender Security** off (line 64's instruction to switch it on is replaced; labels "(it may be called …)"); if Mailgun switches it on by itself, that's fine: the DKIM row then shows two records to add under `mail`. What you should see: the DKIM record name ends in `._domainkey.polygonparadise.com` (verified); if it ends in `._domainkey.mail.polygonparadise.com`, you add it in step 7. |
| 5 Create the API key | unchanged. |
| 6 Connect Mailgun and set the From address | Region **US** (lines 85, 96: EU → US), Sending domain **mail.polygonparadise.com**, key, **leave Advanced closed and the Domain sending key empty**, **Save and connect**; then the **From address** card: `contact@polygonparadise.com`, **Save From address**. What you should see: "Connected to mail.polygonparadise.com (US) …" and the toast of §3.1. If it goes wrong: "Mailgun can't find mail.polygonparadise.com in the US region, only in EU…": **don't** change Region to EU; go back to step 4. "Type mail.polygonparadise.com here…": you typed polygonparadise.com; type mail.polygonparadise.com. |
| 7 Add the DNS records | at GoDaddy (My Products › polygonparadise.com › DNS; or Cloudflare if moved): table — SPF TXT Name `mail` `v=spf1 include:mailgun.org ~all`; DKIM: usually nothing new (the row turns green because polygonparadise.com's `mx._domainkey` record already exists), add only if the row shows a box; MX ×2 Name `mail` `mxa.mailgun.org`, `mxb.mailgun.org` priority 10 (lines 112–113's EU values replaced); CNAME Name `email.mail` → `mailgun.org` (line 113); DMARC TXT Name `_dmarc` `v=DMARC1; p=none` (for polygonparadise.com; covers your everyday email too, changes nothing for it). **GoDaddy's form may fill Name with `@`: change it to `mail` (or `email.mail`, `_dmarc`) before you save.** **Never add, delete or change the MX records or the SPF record of `@` (polygonparadise.com itself), and leave every record that is already there alone, including `dc-…._spfm` (GoDaddy's helpers for the SPF record), `mx._domainkey` (Mailgun's signature key) and `zmail._domainkey` (Zoho's): they carry your everyday Zoho mail and sign your emails.** The only-one-SPF-record rule (line 121) applies to `mail`, not to `@`. If you use Mailgun's automatic DNS setup (it may be called "Authorize" or "Automatic setup"), check afterwards that the "Mail for polygonparadise.com stays with your mail provider (MX)" row is **Done**. Optional rua: leave it out (the daily reports would arrive as attachments in contact@); if wanted, `rua=mailto:dmarc@mail.polygonparadise.com`, never dmarc@polygonparadise.com. |
| 8 Wait, then check | the rows including the two new ones (quoted with `checklistTitle`, §3.2); the SPF row "polygonparadise.com's SPF record (your everyday email)" is grey (information) at 9 of 10 lookups: nothing to do, just don't add another email service to polygonparadise.com without asking. The DKIM row may say "Mailgun didn't list a DKIM record…" until the reply test (step 13): that's expected. Line 137's "five record rows green" and "(EU)" updated. |
| 9–11 | unchanged in substance (names updated: email.mail.polygonparadise.com). |
| 12 Everyone's reply address | each person's address on mail.polygonparadise.com; what recipients see; the reply inbox (contact@polygonparadise.com allowed; never an address on mail.polygonparadise.com); the signature hint. |
| 13 The test list and the reply test | line 222 "sent from your sending address" → "sent From contact@polygonparadise.com, with replies going to your reply address"; the placement question first ("before you move it out of spam"; Gmail's Promotions and Updates tabs count as the inbox), then the existing two, then the DMARC question; the **Zoho Mail** "Show original" path for the reply ("it may be called View original"); the **pasted original** (§3.4: in Gmail, ⋮ › Show original › **Copy to clipboard**, paste, **Read the original**; what each line means; the return address must end in mail.polygonparadise.com); the mailto note (§3.4); line 239's failure text replaced by the shared-From failure sentence; what to write down for the person who set up the app: where out-of-office replies landed, whether Gmail shows "via", whether Outlook.com shows "on behalf of". |
| 14 First live campaign | unchanged in substance; "Send me a test" note; the campaign page's contact@ reminder. |
| 15 Reply routes | route expressions on mail.polygonparadise.com. |
| 16 Optional: Gmail's dashboard, and your domain's age | Postmaster Tools for **polygonparadise.com** (recommended now): "**Add a new TXT record** (Name `@`) with the value Postmaster shows. Don't edit the TXT record that starts with v=spf1." Domain age: enter 2024-08-22 (or the date in GoDaddy); DKIM key 1024-bit → optional rotation later in Mailgun. |
| 17 | unchanged. |
| 18 Troubleshooting | + "Mail for polygonparadise.com stays with your mail provider (MX)" red (and live emails "Waiting: mail for your main domain points to Mailgun…") → delete Mailgun's MX records at `@`, put Zoho's back, click Check again; + "Mailgun shows polygonparadise.com's MX as unverified" → expected; + "a reply went to contact@ instead of the app" → set the company to Replied; + "someone asked at contact@ to be removed" / "contact@ got a couldn't-be-delivered notice" → Do not contact / do-not-email list; + "Changing the From address" → the order of §6.1 "Sending safely", then reply test and go live again; + "Paused: Mailgun didn't accept the API key" right after setting the From address → remove the domain sending key under Advanced (§2.4); line 319's EU/US region sentence and line 328's EU MX values updated to US. |
| 19 | unchanged. |

Required quotes (P5 adds them to `labels.test.ts`): `TEAM_FROM_TEXTS.cardTitle`, `.fieldLabel`, `.saveButton`,
`checklistTitle("from-mx", "polygonparadise.com")` (the title as the screen shows it, computed in the test; the generic
`CHECKLIST_ROW_TITLES["from-mx"]` only where a doc speaks of "your main domain"), the reply test's two new questions and
the "Read the original" button, the "Reply address" label (source `src/core/sending/from-address.ts`),
`SENDING_DOMAIN_TEXTS.website`, `GO_LIVE_COPY.dialogTeamFromItem` (in guide 4). The existing quotes
(`liveConfirmText(["…"])`, `MODE_OPTION_TEXTS.LIVE.title`, "Test list only") stay in guide 2.

### 6.3 docs/setup/3-cloudflare.md

Step 1 (c) gets the domain-buying steps that leave guide 2 step 2 (Register domains, Purchase, ICANN email, "don't
switch on Email Routing"). "Never use the sending domain from the Mailgun guide" becomes "Never use mail.polygonparadise.com
(the Mailgun guide's sending subdomain) for the app: keep outreach email and the app apart."

Option (b) (moving polygonparadise.com to Cloudflare) now carries the records every outreach email depends on, so its
step 2 lists **every record to compare and copy** from GoDaddy, not only the website's: the MX records of `@` (Zoho),
the SPF TXT of `@` **and every `dc-…._spfm` TXT record it includes** (without them the SPF record breaks for your
everyday email too), `mx._domainkey` (Mailgun's key, which signs every outreach email) and `zmail._domainkey` (Zoho's),
`_dmarc`, the `google-site-verification` TXT, `email` (the old tracking CNAME), and the Mailgun guide's `mail` (two MX,
one TXT) and `email.mail` (CNAME). Step 3 adds: "`email` and `email.mail` must be **DNS only** (grey cloud)." A new
line: "**Never switch on Email Routing for polygonparadise.com**: it replaces Zoho's MX records." After the move:
"Open Settings › Domain checklist, click **Check again**, and check that 'Your emails are signed (DKIM)', 'Mail for
polygonparadise.com stays with your mail provider (MX)' and 'polygonparadise.com's SPF record (your everyday email)' are
still fine." The from-spf row turns red on a missing included record and the from-mx row warns on Cloudflare Email
Routing (§3.2), so a lost record doesn't go unnoticed.

### 6.4 docs/setup/4-going-live.md

- Line 9 ("send.example.com stands for…"): real names. Step 1: domain age of polygonparadise.com (line 17); Mailgun plan
  and region "Foundation, US" (lines 18, 24); profiles with a **Reply address** (line 21); a new bullet "**Settings ›
  Sending & Mailgun › From address** shows contact@polygonparadise.com".
- Step 2: after the numbered list (unchanged, pinned) an **un-numbered** sentence (the step-2 list test matches
  `^\d+\. `): "With a From address (contact@polygonparadise.com), going live also needs **Mail for polygonparadise.com
  stays with your mail provider (MX)**." (the title as the screen shows it). And "the reply test passed with the current
  From address, including the pasted original"; "the check must be newer than your last From address change".
- Step 3 (rehearsal): the Outlook.com out-of-office may land in contact@ instead of the app: "Note where it arrived: in
  the app (the timeline says 'Automatic reply …'), in contact@, or nowhere. Tell the person who set up the app; either
  is fine."
- Step 8 (Go live dialog): quote `dialogTeamFromItem`; the spam-placement tick when the reply test's email landed in
  junk.
- Step 13: "Changing the sending domain or the From address later" (the heading keeps number 13; anchors updated); line
  210's wording follows.
- A short "Watching your main domain" part in step 11 or 12: complaints (Gmail's only in Postmaster), Postmaster weekly,
  what to do with removal requests and bounce notices that land in contact@, the way back in the order of §6.1.

### 6.5 SPEC.md, PLAN.md

SPEC lines 21, 30, 58 get the dated owner decision: "Owner decision 2026-09-27: every outreach email shows From
contact@polygonparadise.com (each sender's display name), sent through the Mailgun subdomain mail.polygonparadise.com,
with each sender's own address on that subdomain as Reply-To (SHARED-FROM-DESIGN.md). polygonparadise.com's MX stays
with its mail provider." The README topics test's SPEC headings are not renamed. PLAN.md gets one header note naming this
design.

### 6.6 Docs tests P5 must keep green

`tests/unit/docs/**` (guide-refs step counts and links, labels with the new quotes, readme-topics, no-milestone) and
`tests/unit/settings/m5-texts.test.ts` lines 43–54, which also read the README.

---

## 7. Settings, state, schema and contracts (step C)

### 7.1 Settings (`SETTING_DEFAULTS`, JSON rows, no settings migration)

| Key | Default | Written by | Read by |
|---|---|---|---|
| `mailgun.fromAddress` | `null` (`string \| null`) | only `saveFromAddress` (P2) | `loadTeamFrom()` (every reader) |
| `sending.goLiveFrom` | `null` (`string \| null`) | only `goLive()` (P3): the shared From address at go-live, or null | go-live card, dashboard `go-live-again` |
| `mailgun.unsubscribeTest` | existing; + optional `from: string \| null` and `original: ReplyTestOriginal \| null` | `decideReplyTest` writes `from`; `saveReplyTestOriginal` (P3) writes `original`; resets clear both and keep `setup` | `replyTestPassedFor`; the verdict; the DKIM fallback |

`SettingValue` gains both new keys in the `string | null` branch.

### 7.2 Setting types and SystemState

- `src/core/setting-types.ts`: `UnsubscribeTestSetting.from?: string | null` ("the shared From address the decision
  belongs to; missing or null = per-person mode"); `UnsubscribeTestSetting.original?: ReplyTestOriginal | null`;
  `ReplyTestMailbox.placementOk?: boolean | null`, `dmarcOk?: "pass" | "fail" | "unsure" | null`, `dmarcFromHeaders?:
  boolean`. `DEFAULT_UNSUBSCRIBE_TEST` unchanged (fields optional). New type:

  ```ts
  /**
   * Shared-From mode (SHARED-FROM-DESIGN F25): what the app read from one pasted original of a reply-test email. The
   * pasted text itself is never stored.
   */
  export type ReplyTestOriginal = {
    /** The sending domain and the shared From address this original belongs to (a reset or a change makes it stale). */
    domain: string;
    from: string;
    /** The test-list mailbox whose copy was pasted, and the TestSend it matched by Message-ID. */
    address: string;
    testSendId: number;
    /** The Return-Path (or smtp.mailfrom) domain; null when the original shows neither. */
    returnPathDomain: string | null;
    /** returnPathDomain is the sending domain or under it. False: the From domain or anything else. Null: not shown. */
    returnPathOk: boolean | null;
    dmarc: "pass" | "fail" | null;
    /** header.d of a passing DKIM signature of the From domain or a subdomain of it; null when none passed. */
    dkimSigner: string | null;
    /** The host of List-Unsubscribe's mailto:, null when there is none (or no header). */
    mailtoDomain: string | null;
    /** True: no mailto, or a mailto on or under the sending domain. False: anything else. Null: no List-Unsubscribe. */
    mailtoOk: boolean | null;
    readAt: string;
  };
  ```
- `src/core/system-state.ts`: `ChecklistRowKey` += `"from-mx" | "from-spf"`; `WaitReason` += `"main-domain-mx"` ("LIVE
  rows held: the main domain's MX points to Mailgun or is missing (shared-From mode, F27)"). No new SystemState key.
- `src/core/system-state-parse.ts`: `CHECKLIST_KEYS` += both; the wait-reason list += `"main-domain-mx"`;
  `parseUnsubscribeTest` keeps the new optional fields (and a well-typed `original`) when their types are right, drops
  them otherwise.

### 7.3 Prisma schema diff (`prisma/schema.prisma`)

```diff
 model Campaign {
   …
   fromName         String?
+  /// The From address at launch (bare): the sender's own address in per-person mode, the shared From address
+  /// (Setting "mailgun.fromAddress") in shared-From mode (SHARED-FROM-DESIGN §2.3).
   fromAddress      String?
+  /// Shared-From mode: the sender's own address on the sending domain at launch, sent as Reply-To; the reply-route
+  /// hold is keyed by it. Null = per-person mode (replies go to fromAddress).
+  replyTo          String?
   sendingDomainId  Int?
   …
 }

 model OutboundEmail {
   …
   fromAddress    String
+  /// The Reply-To sent with this email (copied to follow-ups and to rows the restore scan re-creates). Null = none:
+  /// replies go to the From address. The Mailgun domain is the domain of replyTo ?? the From address.
+  replyTo        String?
   subject        String
   …
 }
```

```diff
 model TestSend {
   …
   purpose     String     @default("SELF")
+  /// The shared From address this test email showed (Setting "mailgun.fromAddress" when it was sent); null = per-person
+  /// mode (the From was the sender's own address). The reply test counts only emails of today's From (SHARED-FROM-DESIGN F26).
+  teamFrom    String?
   messageId   String?    @unique
   …
 }
```

No index (the reply test's query already narrows by `purpose`, `to` and the Message-ID suffix; the rows are few), no
enum, no relation.

### 7.4 Migration `prisma/migrations/20260927200000_shared_from/migration.sql`

```sql
-- Shared From address (SHARED-FROM-DESIGN §2.3, F7, F26): the Reply-To each campaign and email was sent with, and the
-- shared From address each test email showed. Null = per-person mode, which every existing row is. Nothing to backfill.

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "replyTo" TEXT;

-- AlterTable
ALTER TABLE "OutboundEmail" ADD COLUMN "replyTo" TEXT;

-- AlterTable
ALTER TABLE "TestSend" ADD COLUMN "teamFrom" TEXT;
```

The lead checks with `prisma migrate diff` (the M5/M6 procedure) that the schema edit produces exactly these three
statements, then `npx prisma generate`. The supervisor applies it with `migrate deploy` on the next start (the scripts
make a "Before a database upgrade" backup first); the practice copy (`data/demo.db`) gets it the same way. A backup from
before this migration restores normally (restore.bat's migrate deploy adds the columns).

### 7.5 New contract files and contract code (the lead writes them in step C)

**`src/core/sending/from-address.ts`** (new, pure, browser-safe):

```ts
import { getDomain as registrableDomain } from "tldts";
import { parseEmail } from "@/core/email-address";
import { isSharedDomain } from "@/core/shared-domains";
import { ROUTE_CHECK_LOCAL_PREFIX } from "@/core/mailgun/routes";

/**
 * The From line, the Reply-To and the shared From address (SHARED-FROM-DESIGN §2.2–§2.4). Pure and browser-safe, so the
 * From address card checks as you type with the rules the server applies.
 */

/** Characters that force quoting in an RFC 5322 display name. */
const NEEDS_QUOTES = /[()<>[\]:;@\\,."]/;

/** `Ali from Polygon Paradise <ali@send.example.com>`; the name is quoted when it needs to be. (Moved from addresses.ts.) */
export function formatFromHeader(name: string, address: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").trim();
  if (!clean) return address;
  const display = NEEDS_QUOTES.test(clean) ? `"${clean.replace(/(["\\])/g, "\\$1")}"` : clean;
  return `${display} <${address}>`;
}

/** "Ali <ali@send.example.com>" → "ali@send.example.com" (lowercase); a bare address stays. (Moved from mailgun-transport.ts.) */
export function fromAddressOf(fromLine: string): string {
  const m = /<([^<>]+)>\s*$/.exec(fromLine ?? "");
  return (m ? m[1]! : (fromLine ?? "")).trim().toLowerCase();
}

/** The domain part of an address, lowercase, or null. (Moved from mailgun-transport.ts.) */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  const d = at > 0 ? address.slice(at + 1).trim().toLowerCase() : "";
  return d || null;
}

function cleanHost(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/** The main (registrable) domain of `sendingDomain` when the sending domain is a subdomain of it, else null. */
export function teamFromDomainFor(sendingDomain: string | null | undefined): string | null {
  const d = cleanHost(sendingDomain);
  if (!d) return null;
  const org = registrableDomain(d);
  return org && org !== d && d.endsWith(`.${org}`) ? org : null;
}

/** Names that can't receive replies or belong to mail servers; refused as the shared From address. */
export const TEAM_FROM_REFUSED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "postmaster", "abuse", "hostmaster", "mailer-daemon", "noreply", "no-reply", "donotreply", "do-not-reply",
  "bounce", "bounces", "unsubscribe", "u", "dmarc",
]);

export const TEAM_FROM_TEXTS = {
  cardTitle: "From address",
  cardDescription: "The address every campaign email comes from. Leave it empty to send from each person's own address.",
  practiceCopy: "The practice copy never talks to Mailgun, so there is no From address to set here.",
  notConnected: "Connect Mailgun first: the From address must fit your sending domain.",
  fieldLabel: "From address (optional)",
  /** `shown`: the typed address while it is valid, else the saved one, else `contact@<org>`. */
  hint: (displayName: string, shown: string, org: string, d: string): string =>
    `People see "${displayName} <${shown}>": each person's display name with this address. Replies go to each person's own address on ${d}, and from there to their reply inbox. It must end in @${org}.`,
  misfitHere: (saved: string, d: string): string =>
    `The saved From address ${saved} doesn't fit your sending domain ${d}, so test and live campaigns can't start. Change it or clear it below.`,
  riskNote: (org: string): string =>
    `Your everyday email from ${org} shares this address's reputation. If people mark these emails as spam, your normal emails can land in spam too, and that takes weeks to fix. The app pauses sending when Mailgun reports complaints, but Gmail and Google Workspace never report them: only Google Postmaster Tools shows those. Keep Settings › Deliverability › Thresholds as they are, and look at Postmaster Tools once a week.`,
  goodToKnowHeading: "Good to know",
  goodToKnow: (from: string, org: string, d: string): string[] => [
    `Most replies come back through the app. If someone writes a new email to ${from} instead of pressing Reply, or a colleague of theirs writes to it, the app doesn't see it and the follow-ups continue: set that company's status to Replied.`,
    `If someone asks at ${from} to be removed, or ${from} gets a "couldn't be delivered" notice about a campaign email, put that address on the do-not-email list (Settings › Deliverability › Add an address), or set the company to Do not contact.`,
    `Forwarding such an email from ${from} to a reply address doesn't help: the app treats mail from ${from} as your team's own.`,
    `When you answer a prospect from ${from}, the rest of that conversation stays in your inbox; the app only knows about their first reply.`,
    `Emails the app sends don't appear in the Sent folder of ${from}. The company's timeline has them.`,
    `Never point ${org}'s mail servers (MX) to Mailgun, and never forward ${from} to an address on ${d}.`,
  ],
  followUpReminder: (from: string): string =>
    `Replies written straight to ${from} don't reach the app. If someone answered there, set their company to Replied so the follow-ups stop.`,
  saveButton: "Save From address",
  saving: "Saving…",
  savedOn: (from: string, d: string): string =>
    `From now on, campaign emails show From ${from}, and replies go to each person's address on ${d}. Run the reply test before live campaigns (Settings › Domain checklist).`,
  savedOff: (d: string): string =>
    `From now on, each person's campaign emails come from their own address on ${d}. Run the reply test before live campaigns (Settings › Domain checklist).`,
  nothingChanged: "Nothing changed.",
  confirmTitle: "Change the From address?",
  confirmBody: "Going live ends: live campaigns only reach your test list until the reply test passes again and you go live again.",
  confirmButton: "Change it",
  cancelButton: "Keep it",
  onTestList: (from: string): string => `${from} is on your test list. Remove it from the test list first: it can't be a test mailbox.`,
  domainMisfit: (from: string, newDomain: string): string =>
    `Your From address ${from} doesn't fit ${newDomain}. Clear or change it in the From address card first.`,
  misfit: (from: string, d: string): string =>
    `The From address ${from} doesn't fit your sending domain ${d}. Change or clear it in Settings › Sending & Mailgun.`,
  checklistLine: (from: string, d: string): string => `Emails show From ${from} and go out through ${d}.`,
  selfTestNote: (from: string): string => ` It comes from ${from}, your own address: if it isn't in your inbox within a few minutes, look in spam.`,
  invalid: (example: string): string => `That isn't an email address. Type it the way people should see it, for example ${example}.`,
  noSubdomain: (d: string): string =>
    `A shared From address needs a sending domain that is part of your main domain, for example mail.polygonparadise.com. ${d} isn't: leave this empty, or add a subdomain such as mail.<your domain> in Mailgun and connect it above (Mailgun guide, step 4).`,
  onSendingDomain: (d: string, org: string): string =>
    `Leave this empty to send from each person's own address on ${d}. A shared From address goes on your main domain, for example contact@${org}.`,
  wrongDomain: (d: string, org: string): string => `The From address must end in @${org}, the main domain of your sending domain ${d}.`,
  shared: (example: string): string => `That domain belongs to an email provider. Use your own address, for example ${example}.`,
  reserved: (local: string, example: string): string =>
    `${local}@ can't receive replies or is kept for mail servers. Use the address your team reads, for example ${example}.`,
} as const;

export type TeamFromResult = { ok: true; address: string | null } | { ok: false; error: string };

/** Setting "mailgun.fromAddress" (§2.2). Empty → per-person mode. */
export function validateTeamFromAddress(input: string | null | undefined, sendingDomain: string | null | undefined): TeamFromResult {
  const v = (input ?? "").trim().replace(/^mailto:/i, "").trim();
  if (!v) return { ok: true, address: null };
  const d = cleanHost(sendingDomain);
  if (!d) return { ok: false, error: TEAM_FROM_TEXTS.notConnected };
  const org = teamFromDomainFor(d);
  const example = `contact@${org ?? registrableDomain(d) ?? d}`;
  const parsed = parseEmail(v);
  if (!parsed || parsed.displayName || /[\s<>",;()]/.test(v) || parsed.email.toLowerCase() !== v.toLowerCase()) {
    return { ok: false, error: TEAM_FROM_TEXTS.invalid(example) };
  }
  const address = parsed.email.toLowerCase();
  const domain = parsed.domain.toLowerCase();
  if (!org) return { ok: false, error: TEAM_FROM_TEXTS.noSubdomain(d) };
  if (domain === d || domain.endsWith(`.${d}`)) return { ok: false, error: TEAM_FROM_TEXTS.onSendingDomain(d, org) };
  if (isSharedDomain(domain)) return { ok: false, error: TEAM_FROM_TEXTS.shared(example) };
  if (domain !== org) return { ok: false, error: TEAM_FROM_TEXTS.wrongDomain(d, org) };
  const local = address.slice(0, address.lastIndexOf("@"));
  if (TEAM_FROM_REFUSED_LOCAL_PARTS.has(local) || local.startsWith(ROUTE_CHECK_LOCAL_PREFIX)) {
    return { ok: false, error: TEAM_FROM_TEXTS.reserved(local, example) };
  }
  return { ok: true, address };
}

/** From line and Reply-To for one sender (§2.3). `senderAddress` is their own address on the sending domain. */
export function senderHeaders(i: { displayName: string; senderAddress: string; teamFrom: string | null }): { from: string; replyTo: string | null } {
  const own = i.senderAddress.trim().toLowerCase();
  const team = (i.teamFrom ?? "").trim().toLowerCase();
  return team ? { from: formatFromHeader(i.displayName, team), replyTo: own } : { from: formatFromHeader(i.displayName, own), replyTo: null };
}

/** Where a reply to this email lands: the Reply-To when set, else the From address. */
export function routeAddressOf(fromLine: string, replyTo: string | null | undefined): string {
  const r = (replyTo ?? "").trim().toLowerCase();
  return r || fromAddressOf(fromLine);
}

/** The Mailgun sending domain an email goes through (§2.3): the route address's domain. */
export function mailgunDomainOf(fromLine: string, replyTo: string | null | undefined): string | null {
  return domainOfAddress(routeAddressOf(fromLine, replyTo));
}

/** "pp.1a2b@mail.example.com" or "<pp.1a2b@mail.example.com>" → "mail.example.com" (lowercase), or null. */
export function messageIdDomainOf(messageId: string | null | undefined): string | null {
  return domainOfAddress((messageId ?? "").trim().replace(/^<|>$/g, ""));
}

/**
 * Why this From line and Reply-To can't go out through `sendingDomain` (null = fine, §2.4): a From on the sending domain
 * (per-person mode, any Reply-To as before), or a From on its main domain with one bare Reply-To on the sending domain.
 */
export function senderHeaderProblem(sendingDomain: string, fromLine: string, replyTo: string | null | undefined): string | null {
  const d = cleanHost(sendingDomain);
  const fromDomain = domainOfAddress(fromAddressOf(fromLine));
  if (!d || !fromDomain) return "The email has no From address.";
  if (fromDomain === d) return null;
  if (fromDomain !== teamFromDomainFor(d)) return `The From address isn't on ${d} or its main domain.`;
  const r = (replyTo ?? "").trim().toLowerCase();
  if (!r) return "An email from the shared From address has no reply address.";
  if (/[,;<>"\s]/.test(r) || domainOfAddress(r) !== d) return `The reply address isn't on ${d}.`;
  return null;
}

/** The per-person address's name on screens (F19). */
export function senderAddressWords(teamFrom: boolean): { label: string; lower: string; noneYet: string; plural: string } {
  return teamFrom
    ? { label: "Reply address", lower: "reply address", noneYet: "No reply address yet", plural: "Reply addresses" }
    : { label: "Sending address", lower: "sending address", noneYet: "No sending address yet", plural: "Sending addresses" };
}

/** The launch's last transaction saw another From address, sending domain or go-live state (F29). */
export const LAUNCH_SETTINGS_CHANGED_TEXT =
  "The sending settings changed while this campaign was being launched (the From address, the sending domain or going live). Open the campaign and launch it again.";
```

**Moves (behaviour unchanged)**: `src/server/services/sending/addresses.ts` re-exports `formatFromHeader` from the new
file (its own copy deleted); `src/server/services/sending/mailgun-transport.ts` re-exports `fromAddressOf` and
`domainOfAddress`. Every existing import keeps working.

**`src/server/services/mailgun/team-from.ts`** (new):

```ts
import { validateTeamFromAddress, TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { db, type DbOrTx } from "@/server/db";

export type TeamFromState = {
  /** The shared From address when it is saved and fits the sending domain; null in per-person mode or when broken. */
  address: string | null;
  /** What is saved (lowercase), even when it doesn't fit; null = nothing saved. */
  saved: string | null;
  /** Setting "mailgun.domain". */
  domain: string | null;
  /** Set when something is saved but doesn't fit (TEAM_FROM_TEXTS.misfit / notConnected): TEST/LIVE must refuse. */
  problem: string | null;
  /** When the From address setting last changed (its row's updatedAt), for the checklist's freshness. */
  changedAt: Date | null;
};

/** Reads Setting "mailgun.fromAddress" and checks it against "mailgun.domain". Settings only: the dashboard may call it. */
export async function loadTeamFrom(reader: DbOrTx = db): Promise<TeamFromState> {
  const rows = await reader.setting.findMany({
    where: { key: { in: ["mailgun.fromAddress", "mailgun.domain"] } },
    select: { key: true, value: true, updatedAt: true },
  });
  const fromRow = rows.find((r) => r.key === "mailgun.fromAddress");
  const domainRow = rows.find((r) => r.key === "mailgun.domain");
  const saved = typeof fromRow?.value === "string" && fromRow.value.trim() ? fromRow.value.trim().toLowerCase() : null;
  const domain = typeof domainRow?.value === "string" && domainRow.value.trim() ? domainRow.value.trim().toLowerCase() : null;
  const changedAt = fromRow?.updatedAt ?? null;
  if (!saved) return { address: null, saved: null, domain, problem: null, changedAt };
  const v = validateTeamFromAddress(saved, domain);
  if (v.ok && v.address) return { address: v.address, saved, domain, problem: null, changedAt };
  return { address: null, saved, domain, problem: domain ? TEAM_FROM_TEXTS.misfit(saved, domain) : TEAM_FROM_TEXTS.notConnected, changedAt };
}
```

**`src/core/reply-test.ts`** (add only this; P3 owns the rest of the file):

```ts
/** A stored pass counts only for the same sending domain and the same shared From address (null = per-person, F12). */
export function replyTestPassedFor(
  setting: Pick<UnsubscribeTestSetting, "status" | "domain" | "from">,
  domain: string | null,
  teamFrom: string | null,
): boolean {
  if (!domain || setting.status !== "passed") return false;
  if ((setting.domain ?? "").toLowerCase() !== domain.toLowerCase()) return false;
  return ((setting.from ?? "").trim().toLowerCase() || null) === ((teamFrom ?? "").trim().toLowerCase() || null);
}
```

and, in the same file, `validateTestList(input, ctx)`'s ctx gains `teamFrom?: string | null`: an address equal to it is
refused with `TEAM_FROM_TEXTS.onTestList(teamFrom)` (three lines; absent = today's rules). So P2's Sending page loader
and P3's `saveTestList` both pass it without waiting for each other.

**`src/core/sending/mode-gates.ts`** (edit; behaviour unchanged when the new inputs are absent):

- `MODE_GATE_TEXTS.fromMx`, `.fromMxUnchecked`, `.checkBeforeFromChange` (§3.3).
- `CHECKLIST_ROW_TITLES["from-mx"] = "Mail for your main domain stays with your mail provider (MX)"`,
  `["from-spf"] = "Your main domain's SPF record (your everyday email)"`.
- `export const GO_LIVE_TEAM_FROM_ROW_KEYS: readonly ChecklistRowKey[] = ["from-mx"];`
- `export function goLiveRowKeys(teamFrom: boolean): readonly ChecklistRowKey[]` → `GO_LIVE_ROW_KEYS` plus
  `GO_LIVE_TEAM_FROM_ROW_KEYS` when true. `GO_LIVE_ROW_KEYS` itself is unchanged (the guide-4 list test).
- `liveModeBlockers(rows, ctx)`: ctx gains `teamFrom?: boolean`; when true, a missing from-mx row adds
  `fromMxUnchecked` and a bad one adds `fromMx`, right after the DNS sentence. `liveLaunchBlockers` and
  `replyTestBlockers` pass their ctx through (their ctx types gain `teamFrom?: boolean`).
- `goLiveBlockers(rows, ctx)`: ctx gains `teamFrom?: boolean` and `checkBeforeFromChange?: boolean`; the row loop uses
  `goLiveRowKeys(ctx.teamFrom === true)`; when `checkFresh` is false only because of the From change
  (`checkBeforeFromChange === true`), the first sentence is `checkBeforeFromChange` instead of `checkStale`.
- `goLiveRecommendations(ctx)`: ctx gains `teamFrom?: string | null` and `spamPlacements?: readonly string[]`; after the
  monthly-limit line, `spamPlacement(list joined with ", ")` when the list isn't empty; after the address-checks line,
  `postmasterTeam(domain of teamFrom)` when `teamFrom` is set and the postmaster row isn't "ok".
- `GO_LIVE_RECOMMENDATION_TEXTS.spamPlacement`, `.postmasterTeam` (§3.3).

**`src/core/sending/go-live-copy.ts`** (edit): `dialogTeamFromItem`, `dialogOwnFromItem`, `liveFromLine`,
`descriptionAfterFromChange`, `endedByFromChange`, `spamPlacementTick`, `spamPlacementRequired` (§3.3).
`goLiveDialogItems(input)` gains `from?: { team: { from: string; org: string } | null; ownExample: string | null } |
null`: absent → today's items exactly; `team` set → `dialogTeamFromItem` right after the warm-up item; else
`ownExample` set → `dialogOwnFromItem` in the same place.

**`src/core/dns/checklist.ts`** (edit; P2 owns the file afterwards): the type

```ts
/** Shared-From mode only (SHARED-FROM-DESIGN §5): the From domain's own DNS, never Mailgun's. */
export type FromDomainFacts = {
  address: string;
  domain: string;
  /** Set when the saved From address doesn't fit the sending domain; `dns` is null then. */
  problem: string | null;
  /** The DKIM signer Mailgun lists for the sending domain (signingDomainOf), or null. */
  signingDomain: string | null;
  /**
   * The passing DKIM signer read from the reply test's pasted original, when that original belongs to today's sending
   * domain and From address; null otherwise. The DKIM row's fallback when Mailgun lists no DKIM record (§3.2).
   */
  originalSigner: string | null;
  /** Whether an original for today's domain and From was pasted at all (null signer + true = "no valid signature"). */
  originalPasted: boolean;
  dns: {
    txt: TwoAnswers<string[]>;
    spfLookups: { count: number; complete: boolean; dangling: string[] } | null;
    mx: TwoAnswers<Array<{ priority: number; exchange: string }>>;
    dmarc: DnsFacts["dmarc"];
  } | null;
};
```

`ChecklistFacts.from?: FromDomainFacts | null`; `ChecklistFacts.replyTest` gains `from?: string | null` (the stored
decision's From); `GROUP["from-mx"] = GROUP["from-spf"] = "dns"`; `checklistTitle` cases (§3.2; the `d` argument is the
From domain for these two keys). `buildChecklistRows` doesn't emit them yet.

**`src/server/settings.ts`**: the two keys of §7.1 with comments. **`src/core/setting-types.ts`**,
**`src/core/system-state.ts`**, **`src/core/system-state-parse.ts`**: §7.2.

**`src/components/settings/types.ts`** (types only):
`FromAddressView = { practiceCopy: boolean; connected: boolean; sendingDomain: string | null; mainDomain: string | null;
saved: string | null; problem: string | null; goLive: boolean; ownerDisplayName: string; testList: string[] }`
(`ownerDisplayName` already falls back to `suggestedSenderName`); `SenderAddressView.teamFrom?: string | null`;
`ReplyTestView.teamFrom?: string | null`, its mailbox answers `placementOk?`, `dmarcOk?`, `dmarcFromHeaders?`,
`original?: ReplyTestOriginal | null`, and `warnings?: string[]`; `GoLiveCardView.fromLine?: string | null`,
`GoLiveCardView.spamPlacementTick?: string | null`.

**`src/core/sender-address.ts`**: unchanged in step C (P2 changes its texts, F30).

**`src/server/mailgun/types.ts` and `errors.ts`** (moved here from P1, so P3 can rely on them): `MailgunErrorKind` +=
`"sender"` ("Refused by the client's own sender check: no request was made."); `plainMailgunError` case `"sender"` →
"An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending
& Mailgun, then try again." The `replyTo` comments of `SendMessageInput` say "shared-From mode: the sender's own address".
Nothing constructs the kind yet.

**`src/core/system-state.ts`, `src/core/system-state-parse.ts` and `src/components/campaigns/format.ts`**: the wait
reason `"main-domain-mx"` in all three unions/lists and its `waitingText` case (§3.7), so `tsc` stays green; nothing
holds with it until P1.

**`src/server/services/go-live.ts`**: `goLive(actor, opts)`'s opts type gains `confirmSpamPlacement?: boolean` (unused
until P3). **`src/app/(app)/settings/sending/actions.ts`**: `goLiveSchema` gains `confirmSpamPlacement:
z.boolean().optional()`, passed to `goLive`. Both files then belong to their packages (go-live.ts P3, actions.ts P2).

**`tests/integration/mailgun-setup/helpers.ts`**: `GROUP` becomes `Partial<Record<ChecklistRowKey, ChecklistGroup>>`
with today's 20 keys; `writeDomainCheck` writes the two from-* rows only when `statuses` names them (group "dns"), so
every existing caller writes exactly today's rows.

### 7.6 Activity, notification and notice types

| Kind | Name | Copy | Package |
|---|---|---|---|
| Activity | `mailgun.fromAddressChanged` | §3.1 (data `{from, to, goLiveEnded}`) | P2 |
| Activity | `sending.goLive` (existing) | data gains `from` (the shared From address or null) | P3 |
| Activity | `replyTest.decided` (existing) | data gains `from` | P3 |
| Activity | `mailgun.domainChanged` (existing) | a region-only change writes it too, data gains `fromRegion`, `toRegion` (F28) | P2 |
| Notification | none new type | the sender-address notice changes wording in shared-From mode (§3.6); the two domain-check notices use the existing type `system.mailgun` | P4, P2 |
| Notice key | `from-mx-bad`, `from-spf-broken` | §3.8 | P2 |

P7 adds them to the doc comments in `src/server/activity.ts` and `src/server/notifications.ts` (the notice-key list).

### 7.7 Environment variables and packages

None. No npm package change; `tldts` (already installed) gives the main domain.

### 7.8 Fake Mailgun and test helpers (step C; per-person behaviour unchanged)

- `tests/fake-mailgun/inbound-presets.ts`: each preset has its **real target** (critiques C1-4, C2-24), a new field of
  `presetInbound`'s result, `target: "reply-to" | "from"`:
  - `reply`, `out-of-office`, `unclear`, `spam` → the Reply-To when the sent message had one, else the From (as today);
  - `new-email` and `bounce-notice` → **always the From address** (a new email is typed to the visible From; a human
    bounce notice goes to the From when it isn't standard), so in shared-From mode they go to contact@….
  `presetInbound(preset, message, opts?: { to?: "reply-to" | "from" })` lets a caller override the target. The greeting
  still uses the From line's display name. With a From on the sending domain (per-person mode) both targets are the same
  address, so every existing preset test is unchanged.
- `tests/fake-mailgun/admin.ts` (`POST /__fake/inbound`) and a new `FakeMailgun.receivePreset(preset, messageId, opts)`:
  when the target address is not on the fake's domain or one of its `otherDomains` (or under them), nothing is stored,
  no `stored` event is added and nothing is posted to `--app`; the answer is `{ ok: true, stored: false, deliveredTo:
  "outside", to }` ("it lands in the mail provider's inbox, which the fake doesn't model"). The endpoint also accepts
  `"to": "reply-to" | "from"`. Plain `receive()` is unchanged: tests use it on purpose for odd input.
- `tests/fake-mailgun/state.ts`: `FakeMailgunOptions.dkimAuthority?: string` (default: the domain); `dnsRecords` names
  the DKIM record `pdk1._domainkey.<dkimAuthority ?? domain>` (a subdomain signed by its root's authority);
  `GET /__fake/state` reports `dkimAuthority`.
- `tests/fake-mailgun/cli.ts` and `scripts/fake-mailgun.mjs` usage: `--dkim-authority <domain>`.
- The fake keeps accepting any From (as Mailgun does); nothing else changes: the fake has one sending domain.
- `tests/integration/helpers/mailgun.ts`: `connectFakeMailgun(opts)` gains `fromAddress?: string | null` (writes Setting
  `mailgun.fromAddress` when given) and passes `fake.dkimAuthority`.
- `tests/integration/helpers/replies.ts`: `ReplyTarget.replyTo?: string | null`; `loadTarget` selects `replyTo`;
  `replyInput` sends to `bareAddress(email.replyTo ?? email.fromAddress)`.
- `tests/unit/setup-core/originals.ts` (new fixture, used by P3's and P6's tests): `testOriginal({ from, returnPath,
  messageId, dmarc, dkimD, listUnsubscribe, provider: "gmail" | "outlook" })` builds a Gmail- or Outlook.com-style
  original (Return-Path, Authentication-Results with `smtp.mailfrom=`, `dkim=… header.d=…`, `dmarc=… header.from=…`,
  List-Unsubscribe, From, Message-ID).

### 7.9 Every file step C touches

`prisma/schema.prisma`; `prisma/migrations/20260927200000_shared_from/migration.sql`; `src/core/sending/from-address.ts`
(new); `src/server/services/mailgun/team-from.ts` (new); `src/server/services/sending/addresses.ts` and
`mailgun-transport.ts` (re-exports only); `src/core/reply-test.ts` (`replyTestPassedFor`, `validateTestList`'s
`teamFrom`); `src/core/sending/mode-gates.ts`; `src/core/sending/go-live-copy.ts`; `src/core/dns/checklist.ts` (types,
GROUP, titles); `src/server/settings.ts`; `src/core/setting-types.ts`; `src/core/system-state.ts`;
`src/core/system-state-parse.ts`; `src/components/campaigns/format.ts` (one case); `src/components/settings/types.ts`;
`src/server/mailgun/{types,errors}.ts`; `src/server/services/go-live.ts` (opts type); `src/app/(app)/settings/sending/actions.ts`
(`goLiveSchema`); `tests/integration/mailgun-setup/helpers.ts`; `tests/fake-mailgun/{inbound-presets,admin,server,state,cli}.ts`;
`scripts/fake-mailgun.mjs` (usage text); `tests/integration/helpers/{mailgun,replies}.ts`; `tests/unit/setup-core/originals.ts`
(new). After step C each file belongs to the package §8 names, or stays read-only when no package names it (a builder who
needs to change one STOPs and reports, §0.2 rule 1).

---

## 8. Work packages

Every package: follow `CONVENTIONS.md`, M6-DESIGN §0.2 and §0.2 here; run `npx tsc --noEmit`, `npx tsc --noEmit -p
tsconfig.worker.json`, `npx eslint <owned paths>`, `npx vitest run <own test paths>` (P7: the whole suite); never run
`next build/dev/start`, `npm install`, `prisma migrate *` or `npx playwright test`; never touch `data/app.db`; never
call a real service. Ownership is by file; two packages of the same wave never own the same file. Update the existing
tests listed for your files (§9.2).

**Order and ownership at a glance** (the revision kept every file with exactly one owner):

| Step | Owner | Files (full lists below and in §7.9) |
|---|---|---|
| C | Lead | the contracts of §7.9; afterwards read-only unless a package below names the file (sending/actions.ts → P2, go-live.ts → P3, checklist.ts → P2, core/reply-test.ts → P3) |
| Wave 1 | P1 | sending services, the Mailgun client, launch/draft/queries, simulate, the campaign page, outbox, the wizard's Sender step and its page |
| Wave 1 | P2 | connect, the Sending page (actions, load, page, the From card), `core/sender-address.ts`, `core/dns/checklist.ts`, the domain-check services (facts, lookup, check, spf-count) |
| Wave 1 | P3 | `core/reply-test.ts`, reply-test/test-send/go-live services, the Domain checklist page and components, the go-live card, view and dialog |
| Wave 1 | P4 | profile, limits, team switch-off, sender-addresses, internal senders, health check, the dashboard loader and attention items |
| Wave 2 | P5, P6 | docs; the end-to-end test, the seed, Playwright |
| Final | P7 | integration, CONVENTIONS, activity/notification doc comments, the vocabulary sweep |

### P1 — Every email's From and Reply-To (wave 1)

**Owned paths:** `src/server/services/sending/{addresses,mark-sent,loop,mailgun-transport,reconcile,restore,gates,transport}.ts`,
`src/server/mailgun/client.ts` (errors.ts and types.ts are step C's and read-only), `src/server/services/campaigns/{launch,draft,queries}.ts`,
`src/server/services/mail-events/simulate.ts`, `src/app/(app)/campaigns/[id]/page.tsx`,
`src/components/campaigns/outbox-email.tsx`, `src/components/campaign-wizard/sender-step.tsx` and
`src/app/(app)/campaigns/[id]/setup/sender/page.tsx` (the page that renders `SenderStep`; it passes `teamFrom`); tests
`tests/unit/sending/{addresses,mailgun-transport,from-address}.test.ts`, `tests/unit/sending/gates.test.ts`,
`tests/unit/mailgun-client/**` (sender check cases), `tests/integration/shared-from/{sending,launch-race,hold}.test.ts`
(new), and the §9.2 updates marked P1.

**Builds:**
- `senderSnapshot(user, mode, senderAddress?, opts?: { teamFrom?: string | null })` returns also `replyTo: string |
  null` (§2.3); `NoSenderAddressError` uses `senderAddressWords(Boolean(opts.teamFrom))`.
- `launch.ts`: reads `loadTeamFrom()`; TEST/LIVE with `problem` → `ModeProblem` `"from-invalid"` (the misfit sentence),
  checked right after "mailgun-not-connected"; the live checks use `replyTestPassedFor(replyTest, ctx.domain,
  team.address)` and `liveLaunchBlockers(…, { teamFrom: team.address !== null })`; the snapshot takes `teamFrom =
  team.address` (DRY_RUN: `team.address ?? team.saved`); `writeChunk` rows get `replyTo`; `finalizeLaunch` writes
  `Campaign.replyTo`; the no-sender-address sentence uses the words helper. **F29:** `finalizeLaunch` gets `expect: {
  domain, teamFrom, goLive }` (what this launch read: `ctx.domain`, `team.address`, `settings.goLive`), re-reads
  `mailgun.domain`, `mailgun.fromAddress` and `sending.goLive` with `tx.setting.findMany` first thing in its transaction
  and throws `CampaignError(LAUNCH_SETTINGS_CHANGED_TEXT, "changed")` when any differs (normalised: trimmed, lowercase,
  empty = null); the existing catch gives back reservations, ticks and rechecks.
- `draft.ts`: `listSenderChoices()` builds `fromLine` with the team From and returns `teamFrom: string | null`;
  `LaunchSummary` passes through `launchModeProblems` (no change otherwise).
- `mark-sent.ts`: `prevSelect` and `createNextStepRow` copy `replyTo`.
- `loop.ts`: `ClaimedRow` gets `replyTo`; `OutgoingMessage.replyTo = row.replyTo`; **`lastLiveSendAt` by
  `next.sendingDomainId`** (`updateMany({ where: { id: next.sendingDomainId } })`, skipped when null), never from an
  address (F6); the route-hold notice (997-1010) names the route address.
- `gates.ts`: the candidate selects `campaign.replyTo` and `campaign.sendingDomainId`; `Candidate.routeAddress` =
  `(campaign.replyTo ?? campaign.fromAddress).toLowerCase()` (renamed from `fromAddress`, comment "the reply-route hold
  is keyed by the route address") and `Candidate.sendingDomainId: number | null`; `GateContext.mainDomainMxOk` = no
  checklist row (of today's domain) with key `from-mx` and status "bad"; a LIVE candidate is held with
  `"main-domain-mx"` right after the `live-not-ready` check (F27). `isLiveReady` is unchanged.
- `mailgun-transport.ts`: `send()` finds the domain with `mailgunDomainOf(message.from, message.replyTo)`; then
  `senderHeaderProblem` → the SENDER_HEADERS pause of §2.4; for a shared-From row (From off the domain, Reply-To set)
  also `messageIdDomainOf(message.messageId) === domain`, else the same pause; `mailgunFailure(err, ctx)` maps kind
  `"sender"` to the same pause, and its ctx gains `teamFromWithSendingKey?: boolean` (the transport passes `true` when
  the message is a shared-From row and `this.context.sendClient` uses the domain sending key), which appends the §2.4
  sending-key sentence to the `mailgun-auth` fix text.
- `client.ts`: `sendMessage(domain, input)` calls `senderHeaderProblem(domain, input.from, input.replyTo)` next to
  `checkSendGuard` (before any request) and throws `MailgunError({ kind: "sender", requestStarted: false, message:
  "Stopped by the sender check: " + problem })` (the kind and its sentence come from step C).
- `reconcile.ts`: selects `replyTo`; domain by `mailgunDomainOf`.
- `restore.ts` (`matchByRecipient` only): selects `campaign.replyTo`; the created row gets `replyTo`.
- `simulate.ts`: To and recipient = `routeAddressOf(email.fromAddress, email.replyTo)`.
- `queries.ts`: campaign overview and outbox rows carry `replyTo`; `[id]/page.tsx` and `outbox-email.tsx` show it
  (§3.7); `[id]/page.tsx` shows `TEAM_FROM_TEXTS.followUpReminder(from)` for a shared-From campaign whose follow-ups are
  still to come.
- `sender-step.tsx` and `setup/sender/page.tsx`: the §3.7 words and the reminder line in shared-From mode.

**Provides:** `senderSnapshot` (final signature above), `SenderSnapshot.replyTo`, `SenderChoice.teamFrom`, the
`"from-invalid"` launch problem code, `Candidate.routeAddress`, `Candidate.sendingDomainId`,
`GateContext.mainDomainMxOk`.

**Consumes:** step-C contracts (`from-address.ts`, `loadTeamFrom`, `replyTestPassedFor`, `liveLaunchBlockers` ctx).

**Tests:**
- unit `from-address.test.ts` (the step-C helpers): `validateTeamFromAddress` table — `contact@example.com` with
  `send.example.com` ok; uppercase and `mailto:` normalised; `contact@send.example.com` → onSendingDomain;
  `a@x.send.example.com` → onSendingDomain; `contact@other.com` → wrongDomain; `contact@www.example.com` → wrongDomain;
  sending domain `send-studio.com` → noSubdomain; `noreply@`, `postmaster@`, `pp-route-check-1@` → reserved;
  `"Ali" <contact@example.com>` → invalid; empty → null; no domain → notConnected; `contact@polygonparadise.com` with
  `mail.polygonparadise.com` ok; `contact@polygonparadise.co.uk` with `mail.polygonparadise.co.uk` ok (public suffix).
  `senderHeaders` both modes (quoted display names). `mailgunDomainOf`, `routeAddressOf`. `senderHeaderProblem`: every
  branch; per-person with a Reply-To elsewhere → null (the existing client test's case).
- unit `addresses.test.ts`: team snapshot (From line, `fromAddress`, `replyTo`, `messageIdDomain` = sending domain,
  `sendingDomainId` = the address's row); DRY_RUN without an address in team mode (From contact@, `replyTo` null,
  `dry-run.invalid`); TEST without address throws "…has no reply address yet…"; per-person unchanged.
- unit `mailgun-transport.test.ts`: `buildSendInput` passes `replyTo`; `send` with a team row goes to the sending domain
  with `h:Reply-To`; a team row without `replyTo` → blocked with NOT_ON_DOMAIN; a From on an unrelated domain with a
  Reply-To on the sending domain → the sender pause; kind `"sender"` → blocked + pause (never `guard`).
- unit client: the sender check refuses before any request (fake request log empty), for each refused case.
- integration `shared-from/sending.test.ts` (fake Mailgun, `fromAddress: "contact@example.com"`): TEST and LIVE launches
  store `Campaign.fromAddress = contact@example.com`, `Campaign.replyTo = ali@send.example.com` and the rows' line and
  `replyTo`; the fake receives `from` "Ali from Polygon Paradise <contact@example.com>", `h:Reply-To`
  `ali@send.example.com`, path `/v3/send.example.com/messages`, `h:Message-Id` `@send.example.com`; the follow-up row
  copies both; a LIVE email waits "reply-route" while Ali's route isn't ok and goes once it is; an UNKNOWN team row is
  confirmed by the reconciler through Logs of send.example.com; a restore-created row gets the team From and `replyTo`;
  Simulate reply (dry run) is stored with `toAddress` = the Reply-To and the SenderAddress; a preset reply (to Reply-To)
  processed by `processPendingInbound` stops the recipient and marks the company Replied; a saved From that no longer
  fits (setting written directly) → TEST launch refused with the misfit sentence; per-person campaigns in the same file
  are unchanged (no `h:Reply-To`); **`lastLiveSendAt`**: after a shared-From LIVE send, `SendingDomain(send.example.com)
  .lastLiveSendAt` is set (and a per-person LIVE send still sets it); a shared-From row whose Message-ID is on another
  domain → the sender pause, nothing sent; a sending-key 401 on a shared-From row → the `mailgun-auth` pause with the
  extra sentence.
- integration `shared-from/launch-race.test.ts` (F29): a launch whose `finalizeLaunch` sees `mailgun.fromAddress`
  changed (written between the chunks through an injected hook or by calling `finalizeLaunch`'s check directly), then
  `sending.goLive` changed, then `mailgun.domain` changed → each refused with `LAUNCH_SETTINGS_CHANGED_TEXT`, the
  campaign still a draft, reservations and ticks given back; an unchanged launch goes through.
- integration `shared-from/hold.test.ts` (F27): with a from-mx row "bad" (written with `writeDomainCheck(domain, {
  "from-mx": "bad" })`) a LIVE email waits with `main-domain-mx` and a TEST email goes; "warn", "unknown" or no row
  hold nothing; the waiting text.
- unit `gates.test.ts`: the `main-domain-mx` hold in the order of §8 P1; `routeAddress` keys.

**Done when:** tests pass; `grep -n "domainOfAddress(fromAddressOf(" src/` finds nothing outside `from-address.ts`;
`grep -n "lastLiveSendAt" src/server/services/sending/loop.ts` shows only the `sendingDomainId` write; every
`sendMessage(` call site outside `src/server/services/test-send.ts` passes a `replyTo` from a row or none.

### P2 — The From address setting and the Domain checklist's rows (wave 1)

**Owned paths:** `src/server/services/mailgun/connect.ts`, `src/app/(app)/settings/sending/{actions.ts,load.ts,page.tsx}`
(actions.ts beyond step C's `goLiveSchema`), `src/components/settings/sending/from-address-card.tsx` (new),
`src/components/settings/sending/connection-form.tsx` (no change expected), `src/core/sender-address.ts` (texts and the
sandbox refusal, F30), `src/core/dns/checklist.ts` (beyond step C),
`src/server/services/checks/{dns-facts,dns-lookup,domain-check,spf-count}.ts`; tests `tests/unit/checks/checklist.test.ts`
(from rows, 1024-bit), `tests/unit/checks/from-domain-lookup.test.ts` (new, the fake-mode answers),
`tests/unit/checks/spf-count.test.ts` (the `dangling` cases), `tests/unit/setup-core/sender-address.test.ts` (new
sandbox cases), `tests/unit/settings/from-address-card.test.ts` (new, static markup), `tests/integration/checks/{domain-check,fake-mode-dns}.test.ts`,
`tests/integration/mailgun-setup/{from-address,connect}.test.ts`, and the §9.2 updates marked P2.

**Builds:**
- `saveFromAddress(actor, input: { fromAddress: string; confirmEndGoLive?: boolean }, now?)` in `connect.ts`: practice
  copy → refuse; `validateTeamFromAddress(input, mailgun.domain)` → field error; same as saved → `nothingChanged`; the
  new address on the test list → `onTestList`; `activeMailgunCampaigns()` → the §3.1 refusal; live without
  `confirmEndGoLive` → refuse with `TEAM_FROM_TEXTS.confirmBody`; then one `dbTx`: campaigns re-checked (throw →
  refusal), `sending.goLive = false` when true, `mailgun.fromAddress` (null when empty), `mailgun.unsubscribeTest` reset
  to `{...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [], setup: current.setup}` (the Setup kept, `from` and `original`
  cleared), the activity; after the commit `enqueueJob({type: "mailgun.checkDomain", dedupeKey: "mailgun:domain-check",
  priority: 20})`. Returns `{ ok: true; message; fromAddress; goLiveEnded } | { ok: false; field: "fromAddress" | null;
  error }`.
- `connectMailgun` (F14): with a saved From address, a new domain it doesn't fit → `{ ok: false, field: "domain", error:
  TEAM_FROM_TEXTS.domainMisfit(from, domain) }` before the Mailgun test, and again inside `saveConnection` (throw →
  same refusal). **F28:** `changing = oldDomain !== null && (oldDomain !== domain || oldRegion !== region)`; a
  region-only change runs every domain-change step (the campaign refusal, go-live ended, the sending key dropped, the
  reply test reset, suppressions re-pushed, the Apply run cleared), sets every current `SenderAddress` of the domain to
  `routeStatus: "pending"`, queues the route sync, and logs `mailgun.domainChanged` with the §3.1 summary and
  `fromRegion`/`toRegion`. `testMailgunConnection`: when the domain is found only in the other region and
  `teamFromDomainFor(domain)` is set, the error is `wrongRegionSubdomainText` (§3.1); otherwise `wrongRegionText`.
- `sender-address.ts` (F30): `SENDING_DOMAIN_TEXTS.website` new sentence; `SENDING_DOMAIN_TEXTS.sandbox` and the check
  `d === "mailgun.org" || d.endsWith(".mailgun.org")` right after the website check.
- `saveFromAddressAction(input: { fromAddress: string; confirmEndGoLive?: boolean })` in `sending/actions.ts`:
  `runAction`, `requireOwnerAction()`, zod `{ fromAddress: z.string().max(320), confirmEndGoLive: z.boolean().optional() }`,
  `revalidatePath("/", "layout")`; the toast is the service's message.
- `sending/load.ts` builds `FromAddressView` (with `loadTeamFrom()`, the Owner's display name falling back to
  `suggestedSenderName(name)`, `teamFromDomainFor`); it passes `teamFrom: team.address` to `validateTestList` (the
  step-C option); `goLiveCardView(view, ctx)` keeps its signature (P3 keeps it too); `page.tsx` places the card after
  "Mailgun connection"; `from-address-card.tsx` (client) validates as you type with `validateTeamFromAddress`, shows the
  hint with the typed or saved address, the misfit line, the risk note and the "Good to know" `<details>` in the §3.1
  order, the confirm dialog (with `SETTINGS_DIALOG_CLASS`) while live, keeps what was typed on errors and on a lost
  connection, and uses an outline Save button.
- `checklist.ts`: `signingDomainOf`, `fromRow` (titles with the From domain), the from-mx and from-spf rows (with the
  Cloudflare and dangling-include cases, 9–10 lookups "info"), the dmarc changes (rua fix `dmarc@{d}` in team mode),
  the dkim changes (1024-bit "ok", signer texts, the no-record fallback from `originalSigner`), the postmaster and
  domain-age changes, and `replyTestRow` through `replyTestPassedFor` with the team texts (§3.2); `buildChecklistRows`
  emits the new rows after dmarc when `facts.from` is set.
- `spf-count.ts`: `countSpfLookups` also returns `dangling: string[]` (§5).
- `dns-facts.ts`: `gatherFromDomainFacts(fromDomain, lookups)` (§5). `dns-lookup.ts`: `mailgunRecordsLookup(domain, m,
  opts?: { fromDomain?: string | null })` (§5, with the `_spf.mail-provider.invalid` answer). `domain-check.ts`:
  `facts.from` from `loadTeamFrom()`, `signingDomainOf` and the stored original; `facts.replyTest.from`; fake mode passes
  `fromDomain`; after the state is stored, the `from-mx-bad` and `from-spf-broken` notices (§3.8).

**Provides:** `saveFromAddress`, `saveFromAddressAction`, `signingDomainOf`, `gatherFromDomainFacts`, the rows, the
notices, `SENDING_DOMAIN_TEXTS.sandbox`.

**Consumes:** step-C contracts.

**Tests:**
- unit `checklist.test.ts`: from-mx every case of §3.2 (Mailgun MX in EU and US hosts; fix naming Zoho hosts; no other
  host; no MX; Cloudflare Email Routing → warn; spreading; timeout; misfit); from-spf (2 records → bad, the fix never
  contains a merged record; a dangling include → bad; 9 → info; 11 → bad, the fix contains "Keep include:mailgun.org";
  none → info; ok; no from-spf text or fix ever says "don't need include:mailgun.org"); the **titles** of both rows
  contain the From domain and never the sending domain; dmarc in team mode (walk from the From domain; missing → bad
  with the From-domain fix; unauthorised rua → the fix names `dmarc@{sending domain}`; `adkim=s; aspf=s` with signer =
  sending domain → bad; `aspf=s` alone → ok; `adkim=s` with signer = From domain and `aspf=s` → ok; p=reject → ok);
  dkim 1024 → ok with the note (both modes), signer texts (the {d}-signer note), the no-record cases (original signer
  {org} → ok; none pasted → unknown with the reply-test fix; pasted without a signature → warn); reply-test row (a pass
  for another From → warn "Not tested yet with the From address…"; the team failed-row fix never mentions
  "reply.<domain>"); postmaster and domain-age with the From domain; per-person facts produce exactly today's rows;
  **safety**: in team mode, no row has a record of type MX whose fqdn is the From domain, and no fix asks to add an MX
  record for the From domain that points to a `mailgun.org` host (the from-mx fixes only say "delete … that point to
  Mailgun" or "put back your mail provider's MX records").
- unit `spf-count.test.ts`: an include with NXDOMAIN or a TXT without `v=spf1` → `dangling`; a timeout → not dangling,
  `complete: false`.
- unit fake-mode lookup: From-domain MX, TXT, `_spf.mail-provider.invalid` and `_dmarc` answers; other names missing.
- unit `sender-address.test.ts`: `sandbox123.mailgun.org` and `mailgun.org` → `SENDING_DOMAIN_TEXTS.sandbox`; the
  website case still returns `SENDING_DOMAIN_TEXTS.website`.
- unit `from-address-card.test.ts` (static markup, `renderToStaticMarkup`): the four states plus the misfit state; the
  hint shows a typed `hello@example.com` (not contact@); the display-name fallback; the element order field → hint →
  Save → risk note → details; `truncate-chain` (`tests/unit/shell/truncate-chain.ts`) passes.
- integration `domain-check.test.ts`: team mode with an injected DNS table (§9.3 table) → rows present and ok; the
  From domain's MX on `mxa.mailgun.org` → from-mx bad and one `from-mx-bad` notice (a second check within 24 h adds
  none); a second SPF record at the From domain → from-spf bad and one `from-spf-broken` notice; a saved misfit From →
  from-mx bad with the misfit text; no Mailgun request path contains the From domain; Mailgun listing no DKIM record +
  a stored original with `dkimSigner: "example.com"` for today's domain and From → dkim ok; the same original for
  another From → dkim unknown.
- integration `from-address.test.ts`: every branch of `saveFromAddress` (ok on, change, clear, same, invalid, on test
  list, campaigns active, live without confirmation, live with confirmation → `sending.goLive` false in the same
  transaction, `goLiveAt/goLiveDomain` kept, reply test reset with `setup: "B"` kept, activity data, domain-check job
  queued once); the action as a Member → "Only the Owner can do this." and nothing written; the practice copy refuses.
- integration `connect.test.ts` (added cases): a domain change with a saved From that doesn't fit → refused before any
  fake request; one that fits → allowed; the same name in the other region (the fake answering for both) → treated as a
  domain change (reply test reset, go-live ended, suppressions' `pushedToMailgunAt` cleared, addresses "pending", a
  `mailgun.syncRoutes` job); a subdomain found only in EU while US was chosen → `wrongRegionSubdomainText`.

**Done when:** tests pass; the Sending page renders the card in its five states (practice copy, not connected, empty,
saved with the list, saved but misfit); `owner-actions.test.ts` covers the new action without an allowlist change.

### P3 — Reply test, test sends, test list, go-live and the Domain checklist page (wave 1)

**Owned paths:** `src/core/reply-test.ts` (beyond step C), `src/server/services/{reply-test,test-send,go-live}.ts`,
`src/app/(app)/settings/domain/{load.ts,page.tsx,actions.ts}`, `src/components/settings/domain/{reply-test-section.tsx,checklist.tsx,domain-age-form.tsx}`,
`src/components/settings/sending/{go-live-card.tsx,go-live-view.ts,go-live-dialog.tsx}`; tests `tests/unit/setup-core/reply-test*.test.ts`,
`tests/unit/setup-core/test-original.test.ts` (new), `tests/unit/sending-core/mode-gates.test.ts` (new cases for the
step-C gate code), `tests/unit/go-live/**`, `tests/unit/settings/domain-checklist-render.test.ts` (new, static markup),
`tests/integration/mailgun-setup/reply-test.test.ts`, `tests/integration/shared-from/evidence.test.ts` (new),
`tests/integration/test-send/**`, `tests/integration/go-live/**`, and the §9.2 updates marked P3.

**Builds:**
- `core/reply-test.ts`: `evaluateReplyTest(setting, facts, unsubscribeSeen, opts?: { teamFrom?: string | null;
  sendingDomain?: string | null })` with the team-mode steps and failures of §3.4 (`placementOk` answered by every
  mailbox, `dmarcOk === "pass"`, an original stored for today's domain and From with `returnPathOk === true`, `dmarc !==
  "fail"`, `mailtoOk !== false`), `ReplyTestVerdict.warnings?: string[]` (spam placement), the team-mode texts;
  `parseDmarcResult`, `dmarcResultsText`, `parseTestOriginal`, `testOriginalTexts` (§3.4).
- `reply-test.ts`: `loadGateInputs` gains `teamFrom`, `teamFromProblem`, `teamFromChangedAt`, `spamPlacements` (from the
  stored answers of current test-list mailboxes, labelled "Outlook.com (tess@outlook.com)") and `checkBeforeFromChange`;
  `replyTestPassedOnDomain = replyTestPassedFor(setting, domain, teamFrom)`; `isCheckFresh` also requires the check at
  or after `teamFromChangedAt` (and `checkBeforeFromChange` = fresh by the old rule but older than that); `modeBlockersFor`,
  `replyTestBlockersFor`, `goLiveBlockersFor` pass `teamFrom` (and `checkBeforeFromChange`) and put `teamFromProblem`
  first when set; `goLiveRecommendationsFor` passes `teamFrom` and `spamPlacements`; `OWNER_ADDRESS_MISSING_TEXT` by
  words. **F26:** `loadReplyTest` filters the reply-test `TestSend` rows by `teamFrom: gate.teamFrom` (null matches
  null) and, when `teamFromChangedAt` is set, `sentAt >= teamFromChangedAt`, and computes `unsubscribeSeen` from those
  rows only; `loadLiveTest(domainId, testList, { teamFrom, since })` adds `campaign: { replyTo: teamFrom ? { not: null
  } : null, fromAddress: teamFrom ?? undefined, launchedAt: since ? { gte: since } : undefined }`; `decided` is shown
  only for today's domain and From. `saveReplyTestAnswers` accepts `placementOk`, `dmarcOk`, `dmarcPasted` (read with
  `parseDmarcResult`, never stored); new `saveReplyTestOriginal(actor, { address, pasted })`: `parseTestOriginal`, the
  Message-ID must match a reply-test `TestSend` that counts (F26), stores `original` (with today's `domain` and `from`),
  sets that mailbox's `dmarcOk`/`dmarcFromHeaders`, never stores the text; `decideReplyTest` stores `from: teamFrom`,
  logs it, and is a compare-and-set (§3.4); `saveTestList` passes `teamFrom`.
- `test-send.ts`: "Send me a test" and the reply test use `senderHeaders` with `loadTeamFrom()` (refuse on `problem`),
  send `replyTo`, and store `TestSend.teamFrom` (the shared From or null) on every row they create; the self-test note
  (§3.5); sentences by the words helper.
- `go-live.ts`: `IN_TX_KEYS` += `"mailgun.fromAddress"`; `sameInputs` also compares the saved From address and
  `replyTest.from`; `goLive(actor, opts)` refuses with `GO_LIVE_COPY.spamPlacementRequired` when
  `gate.spamPlacements` isn't empty and `opts.confirmSpamPlacement !== true` (before the transaction; the transaction
  re-reads the answers through `sameInputs`); writes `sending.goLiveFrom` and activity data `from` (and
  `spamPlacementConfirmed` when ticked); `GoLiveView` gains `from: string | null`, `ownFromExample: string | null` (the
  Owner's per-person From line), `spamPlacements: string[]` and `endedOnFrom: { was: string | null } | null` (not live,
  `goLiveAt` set, same domain, `goLiveFrom` ≠ today's From). `goLiveCardView(view, ctx)` keeps its signature; the card
  and dialog (`go-live-view.ts`, `go-live-card.tsx`, `go-live-dialog.tsx`) show `liveFromLine`,
  `descriptionAfterFromChange`, pass `from` to `goLiveDialogItems` in both modes (F21), and show the spam-placement
  tick, sending `confirmSpamPlacement` with the existing confirm.
- Domain checklist page: the header line (§3.2), the domain-age form's domain (the From domain in team mode), the
  reply-routes empty sentence, the reply test section's team-mode questions in the §3.4 order, the Zoho help, the
  pasted-original part with its lines, the mailto note, the intro line and the shared-From failure sentence.
- `domain/actions.ts`: the answers action's zod schema gains the new fields; new `saveReplyTestOriginalAction({ address,
  pasted: z.string().max(200_000) })` (`requireOwnerAction()`, like the other reply-test actions).

**Provides:** `parseDmarcResult`, `parseTestOriginal`, `GateInputs.teamFrom/teamFromProblem/teamFromChangedAt/
spamPlacements/checkBeforeFromChange`, `GoLiveView.from/ownFromExample/spamPlacements/endedOnFrom`.

**Consumes:** step-C contracts; existing code.

**Tests:**
- unit reply-test: team verdicts (incomplete until every placement and DMARC answer and an original; DMARC fail →
  failed; `returnPathOk` false → failed with the return-address text; `mailtoOk` false → failed; placement No → passed
  with a warning; an original for another From doesn't count; per-person unchanged); `parseDmarcResult` on Gmail,
  Outlook.com and Zoho-style headers, Mailgun sets ignored, `header.from` of another domain ignored, `bestguesspass` →
  null; `validateTestList` with `teamFrom`; `replyTestPassedFor` (domain and From must match; a stored pass without
  `from` counts only in per-person mode).
- unit `test-original.test.ts` (with `tests/unit/setup-core/originals.ts`): Return-Path `bounce+x@send.example.com` →
  ok; `bounce+x@email.send.example.com` → ok; `bounce+x@example.com` → false; only `smtp.mailfrom=` → read from it; none
  → null; List-Unsubscribe `mailto:u+x@send.example.com` → ok, `mailto:u+x@example.com` → false, https only → ok (true),
  no header → null; `dkim=pass header.d=example.com` → signer; a Mailgun ARC set ignored; folded headers; the text never
  appears in the result.
- unit mode-gates: `liveModeBlockers` with `teamFrom` (from-mx missing → `fromMxUnchecked`, bad → `fromMx`, right after
  the DNS sentence; ok → nothing; absent → unchanged); `goLiveBlockers` with `teamFrom` (the from-mx title sentence) and
  `checkBeforeFromChange` (its sentence instead of `checkStale`); recommendations (spam placement, Postmaster for the
  main domain; absent → unchanged); `goLiveDialogItems` with `from` (team and own items) and without (unchanged).
- unit `domain-checklist-render.test.ts` (static markup): a from-mx "bad" row and its fix render (fake mode can't show
  it); the reply test section in shared-From mode (question order, the original part, the failure sentence without
  "reply.<domain>"); the go-live card with the from-mx blocker and with the spam-placement tick.
- integration `shared-from/evidence.test.ts` (F26, critique C1-1): a per-person reply test passes and a per-person live
  campaign to the test list is delivered; then the From is set (setting written directly, with its `updatedAt`) → the
  reply test's facts show no sent email for each mailbox, the verdict is incomplete, `unsubscribeSeen` false,
  `liveTest` "none" and the go-live blockers contain `liveTestNone`; new team reply-test emails and a team live campaign
  make them count again; `decideReplyTest` against a From changed after the verdict → refused, nothing written; a pasted
  original of a pre-change email → refused ("This isn't one of the current test emails…").
- integration reply test in team mode (fake): the test emails' `from`/`h:Reply-To` and `TestSend.teamFrom`; preset
  replies to the Reply-To reach the app (`replyStored`); answers with a pasted DMARC header; a pasted original
  (`testOriginal` with the fake's Message-ID) stored with its facts; decide → `from` stored; switching the From address
  resets it (setting written directly here; the service is P2's).
- integration test-send: the self test's headers and `teamFrom`; the note when the inbox equals the From address;
  refusal on a misfit.
- integration go-live: `goLive()` in team mode writes `sending.goLiveFrom`; a spam placement without the tick → refused
  with `spamPlacementRequired`, with it → live and activity `spamPlacementConfirmed`; a From address changed between
  `loadGateInputs` and the transaction → `GO_LIVE_COPY.changed`; `loadGoLiveView` after a From change (settings written
  directly) → `endedOnFrom`; blockers include the from-mx sentence when the row is missing; a checklist checked before
  the From change → `checkBeforeFromChange`, not `checkStale`.

**Done when:** tests pass; the reply test section renders both modes; the go-live card renders the live and
ended-by-From states; `goLiveCardView`'s signature is unchanged.

### P4 — People, words and safety nets (wave 1)

**Owned paths:** `src/server/services/sender-addresses.ts`, `src/app/(app)/settings/profile/{page.tsx,actions.ts}`,
`src/components/settings/profile-form.tsx`, `src/app/(app)/settings/limits/page.tsx`,
`src/components/settings/limits/sender-caps-form.tsx`, `src/app/(app)/settings/team/switch-off-text.ts`,
`src/server/services/mail-events/internal-senders.ts`, `src/server/services/sending/health-check.ts`,
`src/app/(app)/dashboard/load.ts`, `src/core/dashboard/attention.ts`, `src/components/dashboard/types.ts`; tests
`tests/integration/sender-addresses/**`, `tests/unit/setup-core/ui.test.ts` (profile cases), `tests/integration/inbound-store/internal-senders.test.ts`,
`tests/integration/sending-m3/health-warmup.test.ts` (added case), `tests/unit/dashboard/attention.test.ts`, `tests/integration/dashboard/load.test.ts`,
`tests/unit/setup-core/routes.test.ts` (the pinning case only), and the §9.2 updates marked P4.

**Builds:** the §3.6 words through `senderAddressWords(teamFrom)` with `loadTeamFrom()` (profile page, profile action
toast and its "didn't change" sentence at `actions.ts:59`, the Owner notice and activity in `setSenderLocalPart`, the
`notYours` and change-blocked sentences of `sender-addresses.ts`, the limits column, empty text and table cell, the
switch-off text); the profile hint and signature hint; `internalSenders()` adds the shared From address to the team's addresses and its domain to the internal domains
(one extra settings read in the same `Promise.all`); `runHealthCheck` appends the §3.8 sentence to complaint warnings in
team mode; the dashboard loader reads `mailgun.fromAddress` and `sending.goLiveFrom`, `attentionItems` adds the
From-change `go-live-again` item (new pure `fromChangeEndedGoLive`) and `badGoLiveRows(rows, teamFrom)` uses
`goLiveRowKeys`.

**Tests:** words in both modes (profile page view, toast, notice title/body, activity, limits empty text, switch-off);
`internalSenders` with a team From (contact@example.com and info@example.com internal; a test-list mailbox on
example.com answering its own email is not internal); the loop rule pins `isSafeForwardAddress("contact@polygonparadise.com",
["mail.polygonparadise.com"]) === true` and `…("ali@mail.polygonparadise.com", …) === false`; the health warning
sentence (team, with the Gmail/Postmaster sentence) and unchanged (per-person); `fromChangeEndedGoLive` table; the
attention item for Owner and Member; `badGoLiveRows` with the from-mx row; `notYours`, change-blocked, "didn't change"
and the limits cell in both modes.

**Done when:** tests pass; the Playwright-pinned per-person texts ("Nobody has a sending address yet…") are unchanged.

### P5 — Owner docs (wave 2)

**Owned paths:** `README.md`, `docs/setup/2-mailgun-and-dns.md`, `docs/setup/3-cloudflare.md`, `docs/setup/4-going-live.md`,
`SPEC.md` (the three lines), `PLAN.md` (header note), `docs/dev/README.md` (one line naming this design),
`tests/unit/docs/labels.test.ts` (new quotes), `tests/unit/settings/m5-texts.test.ts` (only if a README sentence it
reads has to move).

**Builds:** §6 (every line number listed in §6.2 and §6.4 is checked and rewritten). **Tests:** `tests/unit/docs/**` and
`tests/unit/settings/m5-texts.test.ts` green (§6.6: guide-refs step counts and links, labels with the new quotes of §6.2
computed with `checklistTitle`, readme-topics, no-milestone, the M5 README texts). **Done when:** every quote is copied
from §3 or `src/`; a reader following guide 2 never sees an instruction to add or change an MX or SPF record of `@`, or
to switch on Automatic Sender Security, or to choose EU; the new guide-4 step-2 sentence is not numbered.

### P6 — End-to-end test, seeds and Playwright (wave 2)

**Owned paths:** `tests/integration/shared-from/end-to-end.test.ts` (new), `scripts/seed-m6-manual.ts`,
`tests/playwright/**`, `playwright.config.ts`.

**Builds:** §9.3; the seed's `ready` and `live` states in shared-From mode (Setting `mailgun.fromAddress =
"contact@example.com"` **written before the checklist state** and with its `updatedAt` backdated to before the seeded
`checkedAt`, so the go-live freshness rule holds; the checklist constant with from-mx and from-spf rows ok, titled with
`checklistTitle(key, "example.com")` for the from-* keys (the seed's `checklistRows()` passes the From domain for them,
line 466); `mailgun.unsubscribeTest.from` and an `original` for `send.example.com`/`contact@example.com`; the seeded
reply-test `TestSend` rows with `teamFrom`; `live`: `sending.goLiveFrom`, campaigns and rows with the team From line and
`replyTo` = `<local>@send.example.com`), `busy` stays per-person; the manifest gains `fromAddress: string | null`;
`playwright.config.ts` starts the `ready` and `live` fakes with `--dkim-authority example.com` and, when it reuses a fake
already running, reads `GET /__fake/state` and refuses to run when its `dkimAuthority` differs ("The fake Mailgun on
4011 was started without --dkim-authority example.com. Stop it and run again."); a new
`tests/playwright/shared-from.spec.ts` (ready and live): Settings › Sending & Mailgun shows the From address card with
contact@example.com and the "Good to know" summary; at 390 px the card's Save button is visible without opening the
details, and the confirm dialog (live) opens full screen (checked, then closed without confirming); the Domain
checklist shows "Mail for example.com stays with your mail provider (MX)" done and the header's second line; the
wizard's Sender step shows "<contact@example.com>", "Reply address" and the reminder; My profile shows "Reply address";
a campaign page shows "replies to" and the reminder; axe on each; screenshots to `test-results/shots/`. The existing
go-live spec keeps one **per-person** go-live dialog screenshot (the `busy` state, or a per-person reseed of `ready`
named in the spec) so the per-person From item is seen too.

**Tests:** the e2e passes; `node --import tsx scripts/seed-m6-manual.ts --state all` succeeds (its address check still
accepts only example.com and *.example); the seed unit tests stay green.

### P7 — Integration (final, one agent)

**Owned paths:** anything needed to join the packages (reported per file), `docs/dev/CONVENTIONS.md` (new section
"Shared From address rules", §10.2 as bullets, plus the §9.4 commands), `src/server/activity.ts` and
`src/server/notifications.ts` (doc comments, the two notice keys), `tests/unit/sending-core/shared-from-words.test.ts`
(new, the vocabulary sweep).

**Builds:** the whole suite green (`npm run check`); the worker bundle self-test; the grep checks of P1's "done when"
over the whole tree; the CONVENTIONS section; the vocabulary sweep: every exported text function that takes the words
helper or `teamFrom` (the §3.6 list, `NoSenderAddressError`, the launch problem, the test-send and reply-test sentences,
the checklist's reply-routes and reply-test texts) is called in shared-From mode and none returns "sending address"
(case-insensitive); the seams: P2's `load.ts` compiles against P3's final `goLiveCardView`/`goLiveViewFrom`, P2's
`goLiveAction` passes `confirmSpamPlacement` to P3's `goLive`.

---

## 9. Tests

### 9.1 Coverage map

| Requirement | Test |
|---|---|
| Recipients see From contact@ with each person's name | P1 unit + integration (fake message fields); P6 e2e |
| Replies still reach the app and stop follow-ups | P1 integration (preset to Reply-To); P3 reply test; P6 e2e |
| Per-person mode unchanged | the whole existing suite (§0.2 rule 4); P1/P2/P4 per-person cases |
| polygonparadise.com never Mailgun's | P2 unit safety test; P6 e2e step 9; existing `validateSendingDomain` tests |
| contact@ is a valid reply inbox | P4 pinning test; P6 e2e step 4 |
| No wrong sends | existing guard tests; P1 sender check (no request made) |
| No lost unsubscribes/complaints | P6 e2e steps 7–8 (events on the sending domain); the pasted original's Return-Path and mailto checks (P3 unit + integration; the owner's real check) |
| Mail that lands in contact@ is not pretended to reach the app | fake presets with real targets (step C); P6 e2e step 7b |
| Fail closed without Reply-To | P1 transport and client tests |
| Evidence belongs to today's From (reply test, live test) | P3 `evidence.test.ts`; P6 e2e step 10 |
| From change ends go-live, resets the reply test (Setup kept) | P2 integration; P3 go-live view; P6 e2e step 10 |
| A launch racing a settings change | P1 `launch-race.test.ts` |
| `lastLiveSendAt` after shared-From sends | P1 `sending.test.ts` |
| A bad from-mx holds live emails and tells the Owner | P1 `hold.test.ts`; P2 `domain-check.test.ts` (notices) |
| Region-only reconnect; sandbox and website texts | P2 `connect.test.ts`, `sender-address.test.ts` |
| Checklist rows (titles, DKIM fallback, from-spf, DMARC rua, reply-test row) | P2 unit + integration |
| Go-live freshness after a From change; spam-placement tick; From line in both modes | P3 unit + integration |
| The From card's states, order and phone layout | P2 static-markup test; P6 Playwright at 390 px |
| Shared-mode vocabulary ("Reply address" everywhere) | P4 word tests; P7 sweep |
| Owner-only | `owner-actions.test.ts` sweep; P2 Member case; the new `saveReplyTestOriginalAction` |
| Docs | P5 docs tests (with `m5-texts.test.ts`) |
| Screens | P6 Playwright + axe (lead runs); a static-markup render of a red from-mx row (P3), which fake mode can't show |

### 9.2 Existing tests that change

| Test | Change | Package |
|---|---|---|
| `tests/unit/checks/checklist.test.ts` (DKIM 1024-bit case) | expects "ok" and the new text | P2 |
| `tests/unit/sending/addresses.test.ts` | new team cases only (`formatFromHeader` import unchanged via the re-export) | P1 |
| `tests/unit/sending/mailgun-transport.test.ts` | new cases; existing NOT_ON_DOMAIN case unchanged | P1 |
| `tests/unit/sending/gates.test.ts`, `tests/integration/sending-m3/gates.test.ts` | the candidate field is `routeAddress` (per-person values unchanged) | P1 |
| `tests/unit/sending-core/mode-gates.test.ts` | new cases only | P3 |
| `tests/unit/setup-core/reply-test.test.ts` | new cases only | P3 |
| `tests/integration/mailgun-client/client.test.ts` | new sender-check cases; "Reply-To when asked" unchanged (From on the sending domain) | P1 |
| `tests/unit/docs/labels.test.ts` | new quotes | P5 |
| `tests/playwright/manifest.ts` | `fromAddress` | P6 |
| any test reading `DomainCheckState` keys through the parser | two more keys accepted | step C |
| `tests/integration/mailgun-setup/helpers.ts` (type-checked by `tsc`) | `GROUP` partial; from-* rows only on request | step C |
| `tests/unit/setup-core/sender-address.test.ts` | new sandbox cases (the website case compares against the constant, unchanged) | P2 |
| `tests/unit/checks/spf-count.test.ts` | new `dangling` cases; existing counts unchanged | P2 |
| `tests/integration/mailgun-setup/connect.test.ts` | a test that reconnects the same name in another region, if any, now expects the domain-change resets (F28) | P2 |
| `tests/unit/go-live/card.test.ts`, go-live view tests | unchanged for callers without `from`; new cases with it | P3 |
| `tests/playwright/go-live.spec.ts` | the dialog's From item; the per-person shot kept | P6 |
| fake-inbound tests of the `new-email`/`bounce-notice` presets | unchanged in per-person mode (both targets are the same address); new shared-From cases | step C |

### 9.3 The end-to-end test of the owner's shape (P6, `tests/integration/shared-from/end-to-end.test.ts`)

Fake Mailgun `send.example.com`, region US, `dkimAuthority: "example.com"`; an injected DNS table:

| Name | Answers |
|---|---|
| send.example.com | TXT `v=spf1 include:mailgun.org ~all`; MX `mxa.mailgun.org`, `mxb.mailgun.org` |
| pdk1._domainkey.example.com | the fake's DKIM value |
| email.send.example.com | CNAME `mailgun.org` |
| example.com | MX `10 mx.provider.example`; TXT `v=spf1 include:_spf.provider.example ~all` |
| _spf.provider.example | TXT `v=spf1 ip4:192.0.2.20 ~all` (so the include isn't dangling) |
| _dmarc.example.com | `v=DMARC1; p=none` |

1. Connect; the Owner saves `contact@example.com` through `saveFromAddressAction`. Right after, before any check,
   `liveModeBlockers` shows `fromMxUnchecked`.
2. Domain check → from-mx, from-spf, dmarc (on example.com), dkim ("example.com's digital signature …, which matches your
   From address") all ok, titles naming example.com. With example.com's MX switched to `mxa.mailgun.org` in the table:
   from-mx bad, `liveModeBlockers`, `replyTestBlockersFor` and `goLiveBlockersFor` name it, one `from-mx-bad`
   notification; switched back.
3. Apply recommended settings (fake) → routes for the senders on send.example.com.
4. The Owner's reply inbox `contact@example.com` saves (profile check) and the Owner's route forwards to it.
5. Reply test: messages From "Arslan from Polygon Paradise <contact@example.com>", `h:Reply-To`
   `arslan@send.example.com`, `TestSend.teamFrom` = contact@example.com; preset replies reach the app; answers
   (placement Yes for Gmail and No for Outlook, inbox Yes, dkim pass, DMARC pass by a pasted Gmail header); a pasted
   original (`testOriginal` with the Gmail email's Message-ID, Return-Path `bounce+…@send.example.com`, `dkim=pass
   header.d=example.com`, `dmarc=pass`, `mailto:u+…@send.example.com`) stored; unsubscribe via the fake; decide →
   passed with `from: contact@example.com`; the go-live recommendations contain the spam-placement line. A second run of
   the verdict with a pasted original whose Return-Path is `bounce+…@example.com` → failed with the return-address text
   (then the good one is pasted again).
6. A live campaign to the test list, delivered → `goLive()` without the tick → refused (`spamPlacementRequired`); with
   `confirmSpamPlacement` → `sending.goLiveFrom = contact@example.com`; the dialog items contain `dialogTeamFromItem`.
7. A LIVE campaign with one follow-up to three checked prospects: team headers; prospect 1 replies (preset, to
   Reply-To) → stopped, Replied, notification to Arslan; prospect 2 sends an out-of-office (preset) → AUTO_REPLY, the
   follow-up goes a day later with the same From line and Reply-To and In-Reply-To = the first email's id; prospect 3's
   permanent-fail webhook (domain send.example.com) → bounced, suppression, stopped; `SendingDomain(send.example.com)
   .lastLiveSendAt` set.
7b. Mail that lands in contact@ (critiques C1-4, C2-24): prospect 2 also sends a `new-email` preset (target: the From)
   → the fake answers `stored: false, deliveredTo: "outside"`, no `stored` event exists for `@example.com`, nothing is
   stored in the app, and prospect 2's follow-up still goes; then a person sets prospect 2's company to Replied → the
   remaining follow-ups stop.
8. An unsubscribe webhook for prospect 2's follow-up → suppression, stopped.
9. Safety: no request path the fake received has `example.com` as a whole path segment (`/\/example\.com(\/|$)/`);
   `SendingDomain` rows = `send.example.com` only; no route expression contains `@example\.com$`.
10. Clearing the From address while the LIVE campaign runs → refused; after cancelling it → allowed (with
    `confirmEndGoLive`), `sending.goLive` false, reply test reset (Setup A kept), the dashboard's `go-live-again` item
    present; a LIVE launch is now **refused** with `MODE_GATE_TEXTS.replyTestPass` (the reply test must pass again),
    and the go-live blockers contain `liveTestNone` (the earlier team live test doesn't count for per-person mode); a
    TEST launch to the test list goes, and its email is From `arslan@send.example.com` without `h:Reply-To`.

### 9.4 Playwright and seeds (P6; the lead runs them)

As §8 P6. `busy` stays per-person so both vocabularies are screenshotted. The go-live spec's "Live on send.example.com
since" still holds (the go-live domain is the sending domain).

Exact commands (also in CONVENTIONS, P7), each fake started by hand only when Playwright shouldn't start it:

```powershell
node --import tsx scripts/seed-m6-manual.ts --state ready
node scripts/fake-mailgun.mjs --port 4011 --app http://127.0.0.1:3103 --dkim-authority example.com
$env:PP_E2E_STATE = "ready"; npm run test:e2e
node --import tsx scripts/seed-m6-manual.ts --state live
node scripts/fake-mailgun.mjs --port 4012 --app http://127.0.0.1:3104 --dkim-authority example.com
$env:PP_E2E_STATE = "live"; npm run test:e2e
```

`empty` and `busy` fakes (4010) run without `--dkim-authority`. A reused ready/live fake without the flag is refused by
`playwright.config.ts` (§8 P6).

### 9.5 Step S — the lead's manual checks (fake only)

1. `live` instance: Settings › Sending & Mailgun (From card with the list), Domain checklist (header's second line, the
   two new rows, DKIM signer text), My profile ("Reply address"), the wizard's Sender step, a campaign page.
2. `POST /__fake/inbound {"preset": "reply", "inReplyTo": "<a sent id>", "notify": true}` → the reply arrives for the
   Reply-To address and stops the recipient; the same with `"preset": "new-email"` → `"deliveredTo": "outside"`, nothing
   in the app.
3. "Send me a test" in the `ready` instance → the fake's message has the team From and `h:Reply-To`.
4. In `ready`: clear the From address → the toast; the checklist rows disappear after the check; set it again. In `live`:
   change it → the confirm dialog, go-live ends, the dashboard item; reseed afterwards.
5. The practice copy (`start-demo.bat` against a copy): the From card's practice sentence.

The owner's own first real checks (after setup, in guide 2 step 13 and guide 4 step 3, not the build): the pasted
original (the app reads the Return-Path, DMARC, the signer and the mailto host); in Gmail's details, mailed-by
`mail.polygonparadise.com`, signed-by `polygonparadise.com`, no "via"; Outlook.com (Inbox or Junk, "on behalf of"?);
where an out-of-office lands; whether "Send me a test" to contact@ arrives.

---

## 10. Risks, decisions, owner-visible changes and the definition of done

### 10.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Mailgun puts the Return-Path on polygonparadise.com after all (Shape B's unconfirmed premise) | late bounces, standard auto-replies and `mailto:` unsubscribes silently go to Zoho | the reply test's pasted original fails on it before anything goes live (F25); the owner then stays in per-person mode; Mailgun support question (§11 Q6) |
| Outlook/Hotmail junk-folders mail whose From domain differs from the sending domain ("especially finicky") | fewer replies from Microsoft mailboxes | same organisational domain and aligned DKIM (Microsoft's own rule accepts a subdomain); the reply test records the placement for every mailbox (an Outlook.com one is required), go-live recommends caution and needs a tick when it landed in junk (F12); way back documented |
| Complaints on outreach hurt the owner's everyday Zoho mail (same `d=` and From domain) | client mail, quotes and invoices land in spam; weeks to recover | the owner's informed decision; the auto-pause (default: the 2nd complaint in 1,000) counts only complaints Mailgun hears about, **never Gmail's or Workspace's** (F20), so Google Postmaster Tools for polygonparadise.com weekly is part of the plan; the half-limit warning names the everyday email; warm-up from 50 a day; DMARC `p=none` only, never tightened by the app; the way back documented in order |
| Replies, opt-outs and bounce notices written straight to contact@ are missed | follow-ups to someone who answered or asked to be removed (a complaint and legal risk on the main domain) | the From card, the campaign page and wizard reminder, guide 2, guide 4, README: Replied / Do not contact / do-not-email list (F17); a store-only copy route deferred (§1.6) |
| A reply email or row without Reply-To | replies go to Zoho, unseen | Reply-To stored per row (F7); transport and client fail closed (F8); P1's grep |
| polygonparadise.com's MX pointed to Mailgun by mistake (GoDaddy's "@" default) | everyday mail lost; forwarded replies lost | never asked by the app; guide 2 step 7 warns about "@"; from-mx red blocks Live, reply test and go-live, **holds live emails and notifies the Owner** (F27) |
| A second SPF record at `@`, or a lost `_spfm` record after a DNS move | SPF permerror for everyday mail | the guides say leave every record alone and list what to copy; from-spf "bad" and a notice (F27) |
| A DNS move to Cloudflare drops `mx._domainkey` | DKIM fails everywhere; DMARC rests on SPF | guide 3 lists it; "check the DKIM row right after the move" |
| The subdomain's DKIM authority isn't the root (EU/US mix, or chosen differently) | d=mail.polygonparadise.com: still aligned (relaxed); maybe Gmail "via" | keep both in US; the checklist names the signer and says when the root doesn't sign; the pasted original; Mailgun support question (§11) |
| Mailgun lists no DKIM record for a subdomain signed by its root | the DKIM row "unknown" would block going live | the row reads the signer from the reply test's pasted original (§3.2); its fix says what to check in Mailgun |
| The account is on Free/Basic (one custom domain) | adding mail.polygonparadise.com fails; the owner might delete polygonparadise.com and lose its key | guide 2 steps 3–4: upgrade first, never delete polygonparadise.com |
| mail.polygonparadise.com was added in EU | the app's region message would push the owner to EU | the subdomain-aware wrong-region sentence and guide 2 step 6 (F28); a region change counts as a domain change |
| A domain sending key refuses a From on another domain (unconfirmed) | a misleading "API key" pause | the guide says leave it empty; the pause gains a sentence in shared-From mode (§2.4); §11 Q7 |
| The 1024-bit root key | slightly weaker signature | accepted everywhere; the row says so; rotation later in Mailgun (guide 2 step 16) |
| SPF on the root at 9 of 10 lookups | one more service breaks SPF for everyday mail | from-spf shows "information" (never amber); guide says ask first; the app's mail doesn't use the root's SPF; `include:mailgun.org` stays |
| "Send me a test" From contact@ to contact@ hidden or filtered | the owner thinks sending is broken | the note; README troubleshooting; use another reply inbox for the test |
| A From change mid-live ends go-live | a second go-live round | by design (F13), confirmed in a dialog, refused while campaigns send; a launch in progress refuses at its last step (F29) |
| Old evidence counted for a new From | going live without one email ever sent From contact@ | F26: evidence filtered by `TestSend.teamFrom`, the campaign's From and the change time |
| The migration on the demo and real databases | a failed start | additive nullable columns; the scripts back up before migrating; the lead checks with `migrate diff` |
| Wording drift between the two vocabularies | confusing screens | one helper (F19); tests in both modes; labels test |
| Mailgun adds a `Sender:` header when From ≠ sending domain | Outlook shows "on behalf of" | unknown; the owner's check; Mailgun support question |

### 10.2 Technical decisions the lead confirms

1. **D1 — Shape B** (F1): one Mailgun domain (`mail.polygonparadise.com`), the root only in the From header.
2. **D2 — Setting `mailgun.fromAddress`**, Owner-only, empty = per-person mode (F2, F3); read only through
   `loadTeamFrom()`; validated by `validateTeamFromAddress` (F5).
3. **D3 — Migration `20260927200000_shared_from`**: `Campaign.replyTo`, `OutboundEmail.replyTo` (F7),
   `TestSend.teamFrom` (F26).
4. **D4 — The Mailgun domain of an email is `mailgunDomainOf(from, replyTo)`**; Message-IDs stay on the sending domain
   and are cross-checked for shared-From rows; `lastLiveSendAt` is written by the campaign's `sendingDomainId` (F6).
5. **D5 — Fail closed** at transport (pause) and client (`MailgunError` kind `"sender"`) (F8); a launch refuses when
   its sending settings changed meanwhile (F29).
6. **D6 — The loop rule, routes, webhooks, catch-up, suppressions, restore scan, warm-up and Apply are unchanged** (F9,
   F11).
7. **D7 — Checklist**: from-mx (gating in team mode; "bad" holds live emails and notifies, F27), from-spf (never
   gating; "info" when almost full; "bad" notifies), DMARC on the From domain with the strict check and the `dmarc@{d}`
   fix, DKIM signer text and the pasted-original fallback, 1024-bit = ok in both modes, the reply-test row per (domain,
   From) (F10).
8. **D8 — Reply test**: two more answers per mailbox and one required pasted original in team mode (Return-Path,
   DMARC, signer, mailto host); pass per (domain, From); evidence only from after the last From change; a spam
   placement needs a tick at go-live (F12, F25, F26).
9. **D9 — A From change ends go-live** (second writer of `sending.goLive = false`, in `connect.ts`), resets the reply
   test, is refused while TEST/LIVE campaigns are active, needs a confirmation while live; `sending.goLiveFrom` records
   the From at go-live (F13); a domain change must keep the From valid (F14).
10. **D10 — Test list refuses the shared From address**; "Send me a test" note (F15).
11. **D11 — Internal senders include the shared From address and its domain** (F16).
12. **D12 — Replies sent only to contact@ are not captured**; the store-only copy route is deferred (F17, §1.6).
13. **D13 — "Reply address" / "Sending address" by mode** (F19).
14. **D14 — Health thresholds unchanged**; the warning's extra sentence; the risk note says Gmail's complaints are
    invisible to the app (F20).
15. **D15 — Region US** for the owner (the app's default stays EU for new installs; guide 2 says US for this owner); a
    region-only reconnect is a domain change (F28).
16. **D16 — Sending-domain texts**: the website refusal points to the From card; sandbox domains refused (F30).

### 10.3 For the owner: changes you should know about (plain words)

1. **Your emails now show From contact@polygonparadise.com**, with each person's name ("Arslan from Polygon Paradise").
   They are sent through **mail.polygonparadise.com**, a part of your own domain that Mailgun handles; you don't buy
   anything.
2. **Replies still come back through the app.** When someone presses Reply, their answer goes to that person's reply
   address (arslan@mail.polygonparadise.com): the app records it, stops the follow-ups, and Mailgun forwards it to
   the person's reply inbox, which can be contact@polygonparadise.com.
3. **Emails written straight to contact@ don't reach the app.** If a prospect writes a new email to contact@ (or a
   colleague of theirs does), the follow-ups continue until you set that company's status to **Replied**. If someone
   asks at contact@ to be removed, or contact@ gets a "couldn't be delivered" notice about a campaign email, set the
   company to **Do not contact** (or put that address on the do-not-email list). Forwarding it to the app doesn't help.
   When you answer from contact@, the rest of that conversation stays in your inbox.
4. **Your everyday email shares the reputation.** If people mark the emails as spam, your normal emails from
   polygonparadise.com can start landing in spam too, and that takes weeks to fix. The app pauses sending when Mailgun
   reports complaints, but it never hears about Gmail's: only Google Postmaster Tools shows those, so look there once a
   week, and keep Settings › Deliverability › Thresholds as they are.
5. **Never point polygonparadise.com's mail servers (MX) to Mailgun, and leave its existing DNS records alone** (the
   SPF record, `dc-…._spfm`, `mx._domainkey`, `zmail._domainkey`). Mailgun will keep showing polygonparadise.com's MX
   records as "unverified": that's correct. If the MX ever points to Mailgun, live emails wait and the app tells you.
6. **Upgrade Mailgun to Foundation first, keep polygonparadise.com in Mailgun** (it signs your emails; never delete it)
   and add mail.polygonparadise.com in the **US** region. Leave the domain sending key empty.
7. **In My profile, the address field is now called "Reply address".**
8. **The reply test asks two more things** per test mailbox (did the test email reach the inbox; does its original say
   "DMARC: PASS"), and once you **paste one test email's original**: the app checks that bounces come back to
   mail.polygonparadise.com. If that check fails, the shared From address isn't safe on your account: clear it.
9. **Changing the From address later ends going live**: run the reply test and go live again. To go back to each
   person's own address: Pause all sending → cancel the scheduled, running or paused test and live campaigns (or
   Resume sending and let them finish) → empty the From address → Resume sending → reply test, a live test to the test
   list, Check again, and go live again (README "Sending safely"; review SCREENS-02).
10. **The Domain checklist has two new rows** about polygonparadise.com: its mail servers must stay with Zoho (red if
    Mailgun), and its SPF record (grey information: it's almost full; nothing to do, just ask before adding another
    email service).
11. **A 1024-bit DKIM key counts as done now** (it's accepted everywhere; 2048 is stronger and optional).
12. **"Send me a test" to contact@ comes from contact@**: if it doesn't show up, look in spam.
13. **Going live shows the From address** in its dialog, and asks you to tick a box if the reply test's email landed in
    spam at Outlook.com (or elsewhere).
14. **Still to confirm**: the earlier change lists (guide 4 step 1) and Mailgun's answers to §11's questions, if you ask
    them.

### 10.4 Definition of done

| Requirement | Evidence |
|---|---|
| Emails show From contact@polygonparadise.com with each person's name; Reply-To = their own address | P1 tests; P6 e2e steps 5–7 |
| Replies stop follow-ups and mark Replied; auto-replies logged | P1 integration; P6 e2e step 7 |
| Bounces, unsubscribes and complaints recorded | P6 e2e steps 7–8; the pasted original proves the Return-Path (P3) |
| Evidence only for today's From; launches can't race a settings change | P3 `evidence.test.ts`; P1 `launch-race.test.ts` |
| polygonparadise.com never becomes Mailgun's; its MX guarded (hold + notice) | P2 safety unit test and notices; P1 `hold.test.ts`; P6 e2e step 9 |
| contact@polygonparadise.com usable as a reply inbox | P4 pinning test; P6 e2e step 4 |
| Per-person mode unchanged | the whole existing suite green (P7) |
| Owner-only, zod, no network in a transaction | `owner-actions.test.ts`; code review |
| Docs follow the owner's real setup | P5 docs tests; the lead's read-through |
| Type-check, lint, tests | P7 `npm run check` |
| Build and screens | step S: `next build`, worker bundle, Playwright + axe |

---

## 11. Open questions (for Mailgun support or the owner's first test; the app never probes)

1. Does `mail.polygonparadise.com`'s `sending_dns_records` list the root's DKIM record (`mx._domainkey.polygonparadise.com`)
   when its DKIM authority is the root? (The DKIM row no longer depends on it: the pasted original settles it, §3.2.)
2. Does Mailgun add a `Sender:` header when the From domain isn't the sending domain?
3. Is the `mailto:` in Mailgun's automatic List-Unsubscribe on the sending domain? (The pasted original checks it.)
4. Does a subdomain share the root's DKIM authority across regions? (Avoided by keeping both in US.)
5. Where do Gmail, Outlook.com and Zoho send their out-of-office replies (Return-Path, Reply-To or From)? (Guide 4
   step 3 records it.)
6. **When a message is sent through `POST /v3/mail.polygonparadise.com/messages` with From on polygonparadise.com
   (itself a verified domain in the same account), is the envelope sender (MAIL FROM / Return-Path) on
   mail.polygonparadise.com or on polygonparadise.com?** Not confirmed by any public page (§1.1). The reply test's pasted
   original checks it on the owner's account before go-live (F25).
7. **May a domain sending key of mail.polygonparadise.com send a message whose From is on polygonparadise.com?** Not
   confirmed. The guide says leave the sending key empty; a refusal shows the §2.4 sentence.
8. Can a domain name deleted in one region be added again in the other region at once? (Guide 2 step 4 says wait or ask
   support if not.)
9. What Mailgun's controls for DKIM authority and Automatic Sender Security on a subdomain are called today (guide 2
   step 4 marks them "it may be called …").

## Summary of schema changes

- `Campaign.replyTo String?`, `OutboundEmail.replyTo String?` and `TestSend.teamFrom String?` (comments in §7.3);
  migration `20260927200000_shared_from` (three `ALTER TABLE … ADD COLUMN … TEXT`). No index, enum or relation.
- Settings (JSON): new `mailgun.fromAddress` and `sending.goLiveFrom` (both `string | null`, default null);
  `mailgun.unsubscribeTest` gains optional `from`, `original` (`ReplyTestOriginal`) and per-mailbox `placementOk`,
  `dmarcOk`, `dmarcFromHeaders`.
- `ChecklistRowKey` += `from-mx`, `from-spf` (SystemState `domain.check` rows); `WaitReason` += `main-domain-mx`. No
  new SystemState key.
- Type-only: `MailgunErrorKind` += `"sender"` (with its sentence, step C); view types of §7.5.
- New activity type `mailgun.fromAddressChanged`; `sending.goLive` and `replyTest.decided` data gain `from`;
  `mailgun.domainChanged` data gains the regions. New notice keys `from-mx-bad`, `from-spf-broken`.

## Summary of package changes

None.

---

## 12. Critique decisions

Two critics reviewed the first version on 2026-09-27: C1 (safety, 15 points) and C2 (owner experience, operations,
docs and buildability, 27 points). Every point is listed here with the decision and why; "where" names the sections
that now carry it. C1's "checked and sound" list (attribution through `senderAddressId`, the route-hold key, the
reconciler's positive control, the test-list guard needing today's `goLive`, polygonparadise.com never becoming a
`SendingDomain` or a route) is kept as it was. No new web research could be run for this revision (the session's search
budget was used up); one Mailgun FAQ page was fetched again (§1.1). Everything that stays unconfirmed is in §11.

### 12.1 Critic 1 (safety)

| # | Point | Decision | Why, and where |
|---|---|---|---|
| C1-1 | Reply test and live test can pass on emails sent before the From change | **Accepted** | A From change keeps the domain, so the Message-ID filter hid nothing. `TestSend.teamFrom` (migration), reply-test emails and their unsubscribes filtered by it and by `sentAt ≥ changedAt`; the live test by the campaign's From/`replyTo` and `launchedAt ≥ changedAt`; tests turn the From on after a per-person pass and expect incomplete + `liveTestNone`. F26, §3.4, §7.3, P3 `evidence.test.ts`, e2e step 10. |
| C1-2 | Shape B's premise (Return-Path on the subdomain) is unconfirmed | **Accepted, in a stronger form** | The only quotes don't cover a From on another verified domain of the same account, and SPF/DMARC can't tell. The reply test now requires one **pasted original**, read by `parseTestOriginal`: Return-Path/`smtp.mailfrom` must be on or under {d}, the `mailto:` host on or under {d} and never {org}; the paste must match a current reply-test Message-ID. A paste proves more than a hand-answered "mailed-by" question and costs the owner one copy-paste. §1.1 now says "Likely"; §11 Q6; the headers note reworded as suggested. F25, §3.4. |
| C1-3 | `lastLiveSendAt` stops updating in shared-From mode | **Accepted; the "better still" part partly** | Written by `Candidate.sendingDomainId`, with a P1 test. Making the Message-ID the source of the API domain everywhere is not done: headers and Message-ID come from the same launch snapshot, and per-person tests pin today's header rule. Instead a shared-From row whose Message-ID isn't on the chosen domain is blocked (§2.4); the full switch is deferred (§1.6). F6, §2.3, P1. |
| C1-4 | The fake's presets would make tests prove the opposite of F17 | **Accepted, except plain `receive()`** | Presets get real targets (`new-email`, `bounce-notice` → the From); `/__fake/inbound` and the new `receivePreset` store nothing for a recipient outside the fake's domains; e2e step 7b. Plain `receive()` keeps accepting any recipient: tests use it on purpose to feed odd mail, and whether mail reaches Mailgun's MX is a question of who it is addressed to, which the presets now model. §7.8, §9.3. |
| C1-5 | Opt-outs and bounce notices that land in contact@ are lost without instructions | **Accepted, except the per-notification line** | "Good to know", the README, guides 2 and 4 now say what to do (Do not contact / do-not-email list; forwarding doesn't help); a one-line reminder on the campaign page and the wizard. Not in every reply notification: a notification is about a reply that did reach the app, so the line would be noise there (§1.6). F17, §2.6, §3.1, §3.7, §6. |
| C1-6 | A Mailgun MX (or a second SPF record) at the root only turns a row red | **Accepted, including the hold** | Notices `from-mx-bad` and `from-spf-broken` (once per 24 h); LIVE emails wait with the new reason `main-domain-mx` while from-mx is "bad" (never on "warn", "unknown" or unchecked); guide 2 step 7 warns about GoDaddy's "@". F27, §2.5, §3.7, §3.8, P1, P2. |
| C1-7 | A From change can commit while a campaign is being launched | **Accepted (first option)** | `finalizeLaunch` re-reads `mailgun.domain`, `mailgun.fromAddress` and `sending.goLive` in its transaction and refuses on any difference; this also closes the same gap for domain changes and go-live. The `isLaunching()` option isn't needed on top: the check inside the flipping transaction is the authoritative one. F29, §2.4, §2.7, P1 `launch-race.test.ts`. |
| C1-8 | The from-spf fix text contradicts "keep polygonparadise.com verified" | **Accepted** | Every from-spf fix now says keep `include:mailgun.org`; no fix builds a merged record; >10 lookups → ask to remove other services. §3.2, P2 tests. |
| C1-9 | DKIM fallback and region check left to the builder | **Accepted** | Team mode reads the signer from the pasted original when Mailgun lists no DKIM record (ok / unknown with a concrete fix / warn); a {d}-signer note says the root doesn't sign and to check account and region; the subdomain-aware wrong-region sentence (F28). §3.2, §3.1, P2. |
| C1-10 | Moving DNS to Cloudflare can drop the DKIM key | **Accepted** | Guide 3 option (b) lists `mx._domainkey`, `zmail._domainkey`, the `@` MX and SPF, the `_spfm` records and the rest, and says to check the DKIM, from-mx and from-spf rows right after. §6.3. |
| C1-11 | The reply-test result shown on screen isn't From-aware | **Accepted** | `facts.replyTest.from` and today's From reach `replyTestRow` (through `replyTestPassedFor`); `loadReplyTest().decided` is From-aware; `decideReplyTest` is a compare-and-set; a team-mode failed-row fix replaces "ali@reply.<domain>". §3.2, §3.4, P2, P3. |
| C1-12 | Outlook.com placement never blocks | **Accepted (the tick option)** | Every mailbox must answer placement (an Outlook.com mailbox is already required); a junk placement makes going live need a server-checked tick. A hard block was rejected because a new domain's first emails often land in Microsoft's junk and the block might never clear (§1.6). F12, §3.3, P3. |
| C1-13 | The DMARC report-address fix would send reports to Zoho | **Accepted** | Team mode names `dmarc@{d}` (same organisation, no authorisation record needed). §3.2. |
| C1-14 | A From change resets `setup` to "A" | **Accepted** | The reset keeps `setup`. F13, §2.7, P2 test with Setup B. |
| C1-15 | Unconfirmed: may a domain sending key send a From on another domain? | **Accepted, with a different mapping** | §11 Q7; guide 2 says leave the sending key empty. A refusal is not mapped to the From/reply-address pause, because a 401 can also be a real key problem; the `mailgun-auth` pause instead gains a sentence in shared-From mode when a sending key is in use. §2.4, P1. |

### 12.2 Critic 2 (owner experience, operations, buildability)

| # | Point | Decision | Why, and where |
|---|---|---|---|
| C2-1 | The app still says the owner's decision is forbidden; the sandbox domain would connect | **Accepted** | New `SENDING_DOMAIN_TEXTS.website` pointing to the From card; `*.mailgun.org` refused; P2 owns `core/sender-address.ts`. F30, §3.1. |
| C2-2 | Trial plan and the existing account not handled | **Accepted** | Guide 2 steps 3–4: open Account › Plan, upgrade to Foundation; never delete polygonparadise.com; leave the sandbox alone. §1.4, §6.2. |
| C2-3 | EU→US collides with the app's message; a region change isn't a change | **Accepted** | How to see a region; "don't pick EU, go back to step 4"; a subdomain-aware wrong-region sentence; a same-name region change is a domain change (resets, route sync). Accepted limitation: the dashboard's "go live again" item compares domain names, so it stays silent after a region-only move (the Go live card still shows the ended note); the real database is empty and the owner connects once, in US. F28, §3.1, §6.2, P2. |
| C2-4 | The DKIM "unknown" dead end | **Accepted** | Built now (P2) from the pasted original; guide 2 step 4 "What you should see". Same as C1-9. |
| C2-5 | from-spf fixes invite editing the root SPF; the merge would harm everyday mail | **Accepted** | No merged value; "keep include:mailgun.org"; "ask the person who set up the app"; guide 2's one-SPF rule applies to `mail`. §3.2, §6.2. |
| C2-6 | Cloudflare option (b) puts outreach records at risk unnoticed | **Accepted** | Records list incl. `_spfm`, DNS-only CNAMEs, never Email Routing; from-spf "bad" on a missing included record (`dangling`); from-mx "warn" on Cloudflare Email Routing; tests. §3.2, §5, §6.3, P2. |
| C2-7 | New rows titled with the sending domain by default | **Accepted** | `fromRow` titles with the From domain; the seed uses `checklistTitle(key, "example.com")`; a unit test. §3.2, P2, P6. |
| C2-8 | The go-live spec fails on freshness; the stale sentence is wrong | **Accepted** | The seed writes the From before the check (backdated `updatedAt`); a separate `checkBeforeFromChange` sentence with a test. §3.3, P3, P6. |
| C2-9 | The e2e's last step can't pass | **Accepted** | Step 10 now asserts the LIVE launch is refused (reply test), then checks the headers with a TEST launch. §9.3. |
| C2-10 | Step C breaks `tsc` in a test helper | **Accepted** | `helpers.ts` is a step-C file; `GROUP` partial; from-* rows only on request. §7.5, §7.9, §9.2. |
| C2-11 | The risk note promises protection the app can't give | **Accepted** | Gmail/Workspace complaints named as invisible; "Settings › Deliverability › Thresholds"; F20's reasoning corrected (the default trips at 0.2 %). F20, §2.8, §3.1. |
| C2-12 | The "one-click way back" isn't one click | **Accepted** | The real order everywhere: Pause all sending → finish or cancel → empty the From → reply test and go live. §1.2, §2.8, §6.1, §10.3. |
| C2-13 | The From card's copy contradicts itself | **Accepted** | Hint built from the typed/saved address; "again" dropped; display-name fallback to `suggestedSenderName`; a misfit state. §3.1, §7.5. |
| C2-14 | "Sending address" survives in shared mode; wrong failure advice | **Accepted** | §3.6 lists every place; the shared-mode failure sentence; P4 word tests plus P7's whole-tree vocabulary sweep (instead of one P4 test, because the words live in P1, P3 and P4 files). §3.4, §3.6, P7. |
| C2-15 | Old guide lines not listed | **Accepted** | §6.2 and §6.4 name the lines (EU values, Automatic Sender Security, "sent from your sending address", "Foundation, EU"…); Automatic Sender Security off, with the fallback if Mailgun turns it on. |
| C2-16 | Docs quote the generic title; the screen shows the real one | **Accepted** | Quotes use `checklistTitle("from-mx", "polygonparadise.com")` computed in labels.test; the guide-4 sentence is un-numbered. §6.2, §6.4. |
| C2-17 | Reply-test steps don't fit the owner's inbox | **Accepted** | Zoho "Show original" path ("it may be called …"); placement answered first; Promotions/Updates count as inbox. §3.4, §6.2. |
| C2-18 | Root records the owner must not tidy; the Postmaster TXT at @ | **Accepted** | "Leave every existing record alone, including `dc-…._spfm` and `mx._domainkey`"; step 16 "add a new TXT, don't edit the v=spf1 one"; automatic DNS setup → check the from-mx row. §1.4, §6.2. |
| C2-19 | from-spf leaves a permanent amber row | **Partly accepted** | 9–10 lookups → "info" (grey). Rejected: a separate "Your main domain" card (two rows don't need a new card or group, and their titles already name polygonparadise.com) and renaming the MX row (the titles are already distinct, and the name feeds go-live sentences, guide 4's pinned list and labels tests). §3.2. |
| C2-20 | From card layout at phone width | **Accepted** | Order field → hint → Save → risk note → `<details>`; `SETTINGS_DIALOG_CLASS`; `overflow-wrap:anywhere`; truncate-chain and a 390 px Playwright check. §3.1, P2, P6. |
| C2-21 | The fromMx sentence accuses when the row is simply unchecked | **Accepted** | `fromMxUnchecked` for a missing row, `fromMx` for "bad". §3.3. |
| C2-22 | Nothing warns an owner who skipped the From card | **Accepted, except the get-started item** | The go-live dialog shows a From line in both modes (optional parameter, so existing tests stay); guide 4 step 1 checks the From card. No dashboard "Set your From address" item: per-person mode is a valid choice and its dashboard stays unchanged (§0.2 rule 4). F21, §3.3, §6.4. |
| C2-23 | Package seams and test scope | **Accepted** | `goLiveCardView` signature kept (P3); `validateTestList`'s `teamFrom` moved to step C so P2 passes it; `MailgunErrorKind "sender"` and its sentence moved to step C; the wizard page named (`campaigns/[id]/setup/sender/page.tsx`); `m5-texts.test.ts` in P5's scope; `goLiveSchema` edited in step C. §7.5, §7.9, §8. |
| C2-24 | The fake answers every preset at the Reply-To | **Accepted** | Same as C1-4 (with the `to` override on `/__fake/inbound`). §7.8. |
| C2-25 | Playwright and manual-check gaps | **Accepted** | Exact commands (§9.4, CONVENTIONS); `playwright.config.ts` refuses a reused fake without `--dkim-authority`; a static render of a red from-mx row; one per-person go-live shot kept. §8 P6, §9.4. |
| C2-26 | Missing tests | **Accepted** | Each listed case is now in a package's tests (P2: titles, region, dangling SPF, texts, card states; P3: freshness, failure copy; P7: vocabulary sweep). §8, §9.1. |
| C2-27 | Minor wording and docs | **Accepted** | README line about the practice copy; leave `rua` out (never dmarc@polygonparadise.com); `noSubdomain` next step; "forwarding doesn't help" in Good to know. §3.1, §6.1, §6.2, §7.5. |

C2's "not confirmed" items (Mailgun's labels for DKIM authority and Automatic Sender Security, re-adding a name in the
other region, Zoho's "Show original" label, where the `_spfm` records come from) are marked "(it may be called …)" in
the guides or listed in §11; none of them changes what the owner is told to do (leave existing records alone either way).

## 13. Review fixes (2026-09-27)

The review of the built shared-From work confirmed 22 findings (3 medium, 19 low) and rejected 9 (SETTING-2, SETTING-5,
SETTING-7, SCREENS-05, SCREENS-06, SECURITY-2, SECURITY-4, SECURITY-5, SECURITY-6: not reachable, or explicit
decisions of this design). Four engineers fixed them in parallel; the integration step (P7-style) closed the seams
marked "P7". Nothing here changes per-person mode except what §0.2 rule 4 now lists.

| ID | What changed | Where |
|---|---|---|
| REPLIES-02 (medium) | Health counting no longer restarts when you go live again on the same sending domain. `goLive()` also writes `sending.healthSinceGoLiveAt = {since, goLiveAt, domain}` (`nextHealthSince`: `since` kept while `sending.goLiveDomain` is the same domain). The health check, Domain health (`loadHealthView`) and the warm-up's health judgement pass `healthGoLiveAt(sending.goLiveAt, sending.healthSinceGoLiveAt)` to `healthCountingSince`; a missing, unreadable or other go-live's value falls back to `sending.goLiveAt`. The warm-up restart still uses `sending.goLiveAt`. P7: the M5 and M6 manual-check seeds write the setting too. | `core/sending/health-since.ts`, `core/setting-types.ts`, `server/settings.ts`, `go-live.ts`, `health-check.ts`, `warmup-days.ts`, `mail-events/deliverability.ts`; README, guide 4 steps 8 and 13 |
| SCREENS-01 (medium) | **Remove the sending key** (Settings › Sending & Mailgun › Advanced, outline button, shown only while a sending key is saved): `removeSendingKey` deletes only `mailgun.sendingKey` and logs `mailgun.keysRemoved` data `{keys: ["sendingKey"]}`; `removeSendingKeyAction` is Owner-only with a strict empty schema. `SENDING_KEY_TEAM_FROM_FIX` names "… › Advanced › Remove the sending key". P7: the owner-actions sweep names the action explicitly. | `mailgun/connect.ts`, `settings/sending/actions.ts`, `connection-form.tsx`, `mailgun-transport.ts`; guide 2 steps 6 and 18 |
| SECURITY-1 (medium) | A DMARC answer read from a pasted original can't be overwritten by stale page state: the section re-syncs from the saved answers (`replyTestAnswersKey`), "Read the original" shows `{address, dmarc}` at once, a click saves one field with `was`, and `mergeReplyTestAnswers` refuses to replace a paste-derived `dmarcOk` unless `was` matches (`REPLY_TEST_TEXTS.dmarcReadMeanwhile`). One `dbTx` re-reads the setting and the From address. | `core/reply-test.ts`, `server/services/reply-test.ts`, `reply-test-section.tsx`, `settings/domain/actions.ts` |
| REPLIES-03 | One field per click (other mailboxes' answers are never overwritten); every save and "Save the result" carry the round the page showed and are refused for another round (`REPLY_TEST_TEXTS.roundChanged`); `decideReplyTest` also refuses answers that changed inside its transaction. P7: the round also carries `since` (`loadTeamFrom().changedAt`, the view's `roundSince`, shared-From only), so a page from before a From change and back, or before a region-only move, is refused too. | same files, `components/settings/types.ts`, `settings/domain/load.ts` |
| REPLIES-01 | In shared-From mode a reply counts for "Reply reached the app" only when its In-Reply-To or References names a counted test email (its Message-ID or Mailgun's `providerId`), and it came after that email. Per-person mode keeps the time rule alone. A client that drops both headers shows "Not yet" (fails closed). | `server/services/reply-test.ts` |
| REPLIES-04 | The pasted-original and pasted-headers parser runs in linear time: unfolded headers capped at 8,000 characters, values at 2,000, U+2028/U+2029 read as spaces, linear scans instead of the backtracking address regexes, `tldts` skipped over 253 characters. | `core/reply-test.ts` |
| SEND-1 | Retry refuses (code `"from-changed"`, `RETRY_FROM_TEXTS`, before anything is written) when a TEST/LIVE campaign's snapshot no longer fits: a shared-From From that isn't today's, a Reply-To off today's sending domain, or a per-person snapshot after a From address was saved. Dry runs never; per-person mode with nothing saved as before. | `campaigns/control.ts` (`retrySnapshotProblem`) |
| SEND-2 | "Send me a test" and the reply test, refused (401/403) while a shared From and a domain sending key are in use: the text is `sendingKeyRefusedText()` ("Mailgun didn't accept the domain sending key." + `SENDING_KEY_TEAM_FROM_FIX`) and the pause is the loop's (`mailgunFailure(…, {teamFromWithSendingKey: true})`). Otherwise `AUTH_TEXT` as before. | `server/services/test-send.ts` |
| SEND-3 | `finalizeLaunch`'s last re-check also compares `mailgun.region` (missing = EU, any case) and re-reads the sender address's `SendingDomain` row (still active, same name and region). | `campaigns/launch.ts` |
| SETTING-1 | Evidence belongs to one way of sending: every sending-domain change, a region-only move included, re-writes the `mailgun.fromAddress` row with its own value (`restartEvidence`), so `loadTeamFrom().changedAt` moves and the F26 filters drop the old region's evidence. "Save and connect" adds `regionMovedText(oldRegion)`. The old region's late events can't be read (the domain had to be deleted there). P7: `checkBeforeFromChange` now says "…before the From address or the sending domain changed…". | `mailgun/connect.ts`, `core/sending/mode-gates.ts`; guide 2 step 4, guide 4 step 2 |
| SETTING-3 | A null MX (`0 .`) on the From domain is a red from-mx row with its own sentence and fix. | `core/dns/checklist.ts` |
| SETTING-4 | An incomplete SPF lookup count of 10 or less is grey "unknown" ("Couldn't count all the DNS lookups …: at least n of the 10 allowed."); over 10 stays "bad". | `core/dns/checklist.ts` |
| SETTING-6 = SECURITY-3 | `runDomainCheck` re-reads `loadTeamFrom()` before writing and runs again (at most `FROM_CHANGE_RERUNS` = 2 more rounds) when the From, the domain or `changedAt` moved; `saveFromAddress` and `connectMailgun` queue a second check (`mailgun:domain-check-after-change`) behind a running one. P7: the main-domain MX hold applies only while a From address is saved (`isMainDomainMxOk(rows, loadTeamFrom().saved)`), and the Domain checklist page drops from-mx/from-spf rows when none is saved. | `checks/domain-check.ts`, `mailgun/connect.ts`, `sending/gates.ts`, `settings/domain/load.ts` |
| SCREENS-02 | The way back, everywhere: Pause all sending → cancel every scheduled, running or paused test or live campaign (or Resume and let it finish) → empty the From address (Change it when live) → Resume sending → reply test, live test, Check again, go live. | README, guide 4 steps 11 and 13, guide 2 step 18; this document §1.2, §2.8, §6.1, §10.3 |
| SCREENS-03 | A `google-site-verification` TXT on the From domain keeps the Gmail dashboard row grey "info" (same sentence, plus a fix), so the Postmaster go-live recommendation stays. | `core/dns/checklist.ts`; guide 2 step 16 (P7) |
| SCREENS-04 | The test list refuses the From address with its own sentence (`REPLY_TEST_TEXTS.fromOnTestList`); `TEAM_FROM_TEXTS.onTestList` stays for the From card. | `core/reply-test.ts` |
| SCREENS-07 | Waiting line: "…points to Mailgun or is missing, … The Owner can see how to fix it in Settings › Domain checklist." (§3.7) | `components/campaigns/format.ts`; README, guides 2 and 4 |
| SCREENS-08 | The DKIM row's fixes say to click Check again after pasting the original (no check is queued by the paste). | `core/dns/checklist.ts`; guide 2 steps 8 and 18, guide 4 step 2 |
| SCREENS-09 | Guide 3 option (b): write down every record (the two `dc-…._spfm` values) before changing the nameservers; step 8 adds the missing record in Cloudflare from those notes. P7: the from-spf "included name without a record" fix says the same ("add the TXT record of {name} again with the name and value you wrote down before the move"). | guide 3, `core/dns/checklist.ts` |
| SCREENS-10 | Strict alignment: the DMARC record box offers the owner's own record with only `adkim=`/`aspf=` removed (`withoutStrictAlignment`), never `v=DMARC1; p=none`. | `core/dns/checklist.ts` |

Seams the integration step checked: SEND-2's text and pause use `SENDING_KEY_TEAM_FROM_FIX`, which names the button
SCREENS-01 added (`labels.test.ts` ties the label to guide 2); `sending.healthSinceGoLiveAt` is read, through
`healthGoLiveAt`, in all three `healthCountingSince` callers; the region-only move's new `changedAt` reaches the reply
test, the live test, the go-live freshness and (P7) the reply test's round. Left as they are, on purpose: old-region
emails show "Not sent yet with this From address"; the key pause keeps the reason "Mailgun didn't accept the API key"
(identical to the loop's pause); SCREENS-08 asks for Check again instead of queueing a check after a paste.
