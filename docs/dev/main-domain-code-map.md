# Code map: "own mailbox" mode (send through polygonparadise.com, replies go straight to Zoho)

Written 2026-09-28 for the owner's final decision of 2026-09-27 (made after two explicit warnings): the app sends
through **polygonparadise.com itself** (the Mailgun sending domain = polygonparadise.com, US region, already verified),
every email is `From: "<Name> from Polygon Paradise" <contact@polygonparadise.com>`, **no Reply-To**, **no Mailgun
routes**, and replies land straight in the owner's Zoho inbox (contact@), where the app can't see them. People mark
replies in the app by hand. The owner will not upgrade Mailgun (Free plan) and will not use mail.polygonparadise.com.

This file only maps the code, tests, the fake and the docs; nothing was changed. `file:line` points at the code as it is
today, after the shared-From build (`docs/dev/SHARED-FROM-DESIGN.md`, Shape B). Columns: **Today** = what the code
assumes now; **Own-mailbox mode needs** = the change; **Risk** = what breaks or needs watching. "Root" = polygonparadise.com.
"UNVERIFIED" = a Mailgun/Zoho fact nobody has confirmed; the app must never probe it.

Sources: `docs/dev/CONVENTIONS.md` ("Shared From address rules", lines 521–636), `docs/dev/SHARED-FROM-DESIGN.md` (§1.2
compares Shape B with "Shape A: send through the root"), `docs/dev/research/mailgun-shared-from.md`,
`docs/dev/research/shared-from-mail-behaviour.md`, `docs/dev/shared-from-code-map.md`, and the code. Two public pages
were read again on 2026-09-28 (no API was called): the pricing page and Mailgun's tracking pages (quoted in §0.1).

---

## 0. The short version

### 0.1 Facts the mode lives with

| Fact | Source |
|---|---|
| Free plan: "100 emails/day included", 1 custom sending domain, "1 inbound route", "1 day of log retention", "1 day of message retention"; Basic "No daily email limit", 1 day logs; Foundation "5 days of log retention" | https://www.mailgun.com/pricing/ (read 2026-09-28) |
| Logs/Events retention: "at least 30 days for paid accounts, and at least 2 days for free accounts" (contradicts the pricing page; plan with the pricing page's 1 day) | https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-messages.md (read 2026-09-28) |
| HTTPS tracking: "When set to HTTPS Mailgun will generate a Let's Encrypt TLS certificate for your tracking domain"; the page "does not specify which pricing tiers" have it. The app treats a 402 as "not in plan" (`apply-settings.ts:507-509`) | same page; plan requirement UNVERIFIED (research: Likely Foundation+) |
| "Mailgun can track delayed bounces, but only if the domain that the email message was sent from has MX records pointing to Mailgun; Otherwise, NDR email messages will not reach Mailgun." | https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-failures.md (read 2026-09-28) |
| "The mail-from host will remain the domain name being created, not the root domain" → the Return-Path is `…@polygonparadise.com` → Zoho | OpenAPI `force_root_dkim_host`, quoted in `research/mailgun-shared-from.md` §2.2 |
| RFC 3834 auto-replies go to the Return-Path; Mailgun's `mailto:` List-Unsubscribe is Likely `u+…@<sending domain>` | `research/mailgun-shared-from.md` §2.6, §4.2 |
| Free accounts without a card on file may only send to authorized recipients (≤ 5) | help article 217531258 quoted in `research/mailgun-sending.md:60` (UNVERIFIED for this owner) |
| Root DNS: MX Zoho (`mx.zoho.com`/`mx2`/`mx3`), SPF = two GoDaddy `_spfm` includes (Zoho + Mailgun), **9 of 10 lookups**, DKIM `mx._domainkey` 1024-bit, tracking CNAME `email` → `mailgun.org` (US), no DMARC | `research/mailgun-shared-from.md` §0 |
| `APP_PUBLIC_URL` empty (no Cloudflare yet); `data/app.db` empty (Owner only, no Mailgun settings); the owner runs `npm run dev` (no background sender) | task facts |

What the mode loses compared with today's Shape B (SHARED-FROM-DESIGN §1.2, rejected there as "Shape A"): replies,
late (asynchronous) bounces, RFC 3834 out-of-office replies and `mailto:` unsubscribes all go to Zoho (the last three to
addresses like `bounce+…@`/`u+…@polygonparadise.com` that don't exist there: rejected, or a Zoho catch-all if one is set,
UNVERIFIED). Immediate bounces, complaints (feedback loops, keyed on Mailgun's IPs), https one-click unsubscribes and
`delivered`/`failed` events still reach Mailgun and the app.

### 0.2 What happens today if the Owner types polygonparadise.com

1. **Connecting is refused.** `validateSendingDomain` returns `SENDING_DOMAIN_TEXTS.website` for polygonparadise.com and
   www (`src/core/sender-address.ts:100,106-107,131`), called by `testMailgunConnection` (`connect.ts:111`) and
   `connectMailgun` (`connect.ts:261`).
2. **Saving contact@ as the From address is refused.** `validateTeamFromAddress` (`src/core/sending/from-address.ts:137-159`)
   answers `noSubdomain` when the sending domain is a main domain (line 150) and `onSendingDomain` for a From on the
   sending domain (line 151); `saveFromAddress` (`connect.ts:530`) and `loadTeamFrom` (`team-from.ts:43`) use it.
3. **Per-person mode can't give contact@ to everyone.** Each person's address is `<local>@<domain>`
   (`sender-addresses.ts:187`), `contact` is a reserved local part (`sender-address.ts:38`) and `address` is unique.
4. **Live, the reply test and go-live stay blocked**: the `mx` row asks for Mailgun MX on the root and is red forever
   (`checklist.ts:714-769`, gate `mode-gates.ts:92`, go-live `:105`); the `spf` row is red because GoDaddy wraps the
   includes (`checklist.ts:532-549`, see §2.E); routes can't work (loop rule, 1 route on Free), so the LIVE route hold
   (`gates.ts:1031-1034`), `no-reply-route` (`launch.ts:175-179`, `core/rules/eligibility.ts:423-426`) and
   `sendersWithoutRoute` (`mode-gates.ts:334-337`) never clear; the reply test needs a reply the app stores
   (`core/reply-test.ts:179`).
5. **Two DNS "fixes" would damage the owner's everyday mail** if copied: the MX row's record boxes say `MX @ →
   mxa/mxb.mailgun.org` (`checklist.ts:720-727,750-754`), and the SPF row's fix says "Change it to: v=spf1
   include:mailgun.org include:dc-…_spfm… include:dc-…_spfm… ~all" (`checklist.ts:547-549`), which needs 14 DNS lookups
   (limit 10) and breaks SPF for Zoho too. Guide 2 step 7 tells the owner to copy every record box.

### 0.3 The biggest items (design decides these first)

1. **One switch for the mode.** Recommended: an explicit Owner-only setting (e.g. `mailgun.replyMode: "app" |
   "own-mailbox"`, default "app") rather than deriving it from "From on the sending domain", so per-person and
   shared-From mode stay byte-for-byte as today (CONVENTIONS "per-person mode is sacred"). Every rule below reads that
   one flag. The From address can stay Setting `mailgun.fromAddress` (read through `loadTeamFrom`) with a new validator
   branch: in own-mailbox mode it must be **on** the sending domain, and the sending domain may be the website domain.
2. **The root becomes a Mailgun domain on purpose.** Everything SHARED-FROM-DESIGN §2.5 built to stop that
   (`validateSendingDomain`, F5, the end-to-end "never Mailgun's" test, CONVENTIONS lines 569-574) must allow it in this
   mode only, and be replaced by the inverse guard: **the root's MX must never point to Mailgun, and no route may exist**.
3. **No SenderAddress, no routes.** Launch, gates, go-live, the reply test, Send me a test, the wizard, My profile and
   Limits all require a per-person SenderAddress with `routeStatus = "ok"`. The mode needs a snapshot built from the
   display name + shared From + the active domain row, with every route condition skipped.
4. **The checklist's MX and SPF rows must be replaced** (the dangerous fixes in §0.2 item 5) by the from-mx and from-spf
   logic applied to the sending domain, with SPF made include-aware.
5. **The reply test becomes a by-hand test** (§3): the app can still see delivery, the unsubscribe click and a pasted
   original; it can never see the reply.
6. **Free-plan limits reach into the code**: 100/day (warm-up goes to 1,000; TEST-mode and test emails don't all count
   in the app's cap), 1-day logs (the app assumes 5 days in the catch-up, the outage hold, the restore scan and the
   reconciler), probably no https certificate (a go-live row), 1 route (Apply creates up to 3+).
7. **Webhooks need `APP_PUBLIC_URL`** and the `webhooks` row gates Live mode (`mode-gates.ts:95`); without Cloudflare
   the owner can't choose Live at all. Events can come from the hourly Logs catch-up instead (§2.H), which works without
   a public address, but it runs only in the background sender (the owner runs `npm run dev`, which has none).
8. **Marking a reply by hand is weaker than a real reply** (§2.I): status Replied doesn't write `repliedAt`, is a no-op
   when the company is already Replied, and nothing reminds anyone before a follow-up goes.

---

## 1. Settings, state and schema

| Key / column | Where | Today | Own-mailbox mode needs |
|---|---|---|---|
| `mailgun.domain` | `src/server/settings.ts:92` | never the website domain | polygonparadise.com (allowed only in this mode) |
| `mailgun.region` | `settings.ts:91` (default EU) | chosen at connect | US (the root is US). `wrongRegionText` already says "change Region to US" for a main domain (`connect.ts:146`, `teamFromDomainFor` is null for the root) |
| `mailgun.fromAddress` | `settings.ts:98`, read by `loadTeamFrom` (`team-from.ts:32`) | shared From on the main domain of a subdomain | contact@polygonparadise.com, on the sending domain itself |
| (new) mode flag | — | — | e.g. `mailgun.replyMode`; Owner-only; changing it ends go-live like a From change (F13) |
| `mailgun.logRetentionDays` | `settings.ts:99` (default **5**) | Foundation | **1** (Free); see §2.H for every reader |
| `mailgun.messageRetentionDays` | `settings.ts:100` (1) | stored replies | irrelevant (nothing is stored); Apply still sets `message_ttl` |
| `mailgun.unsubscribeTest` | `settings.ts:102` | Setup A/B + answers + pasted original | a by-hand variant (§3); Setup B has no purpose (no forwarded replies) |
| `sending.maxDailyCap` | `settings.ts:42` (1000); range 50–10,000 `components/settings/limits/limits-format.ts:70-71` | warm-up to 1,000 | ≤ 100 on Free, minus test traffic (§2.H) |
| `SendingDomain` row | created by `getMailgunContext` (`context.ts:83-93`) and `saveConnection` (`connect.ts:421-426`) | never the root | the root gets the row (needed by the transport's NOT_ON_DOMAIN check, `mailgun-transport.ts:249-254`) |
| `SenderAddress` rows | `sender-addresses.ts:168-240`; moved on a domain change `connect.ts:428-450` | one per sender, route per row | none needed; a domain change must not create `<local>@polygonparadise.com` rows |
| `Campaign.replyTo`, `OutboundEmail.replyTo` | schema (SHARED-FROM §7.3) | set in shared-From mode | always null; every reader already handles null (`mailgunDomainOf`, `routeAddressOf`) |
| `TestSend.teamFrom` | `test-send.ts:345,472` | today's From per test email | contact@ (F26 evidence filter keeps working) |

No migration is needed if the flag is a Setting (JSON row). The real database is empty.

---

## 2. Code map by area

### A. Sending domain, From address, connect

| Where | Today | Own-mailbox mode needs | Risk |
|---|---|---|---|
| `src/core/sender-address.ts:100` `WEBSITE_DOMAINS`, `:106-107` `.website` text, `:131` refusal | root and www refused as sending domain; the text points to the From card | allow polygonparadise.com **only** in this mode (www stays refused); a mode-aware sentence | allowing it in the other modes would put per-person addresses and routes on the root |
| `src/core/sending/from-address.ts:137-159` `validateTeamFromAddress` (F5): `:150` noSubdomain, `:151` onSendingDomain, `:153` wrongDomain, `:155` refused local parts | From must be on the main domain of a subdomain sending domain | own-mailbox branch: From must be exactly on the sending domain; keep the refused local parts (`contact` is allowed there already, `:58-72`) | `loadTeamFrom().problem` (`team-from.ts:43`) makes every TEST/LIVE launch refuse with `from-invalid` (`launch.ts:143`) until this changes |
| `from-address.ts:197-207` `senderHeaderProblem` | From on the domain (per-person) or main domain + Reply-To | already accepts From on the domain with no Reply-To (`:201`) | none: the transport works as is |
| `from-address.ts:166-170` `senderHeaders` | shared mode always sets Reply-To = own address | own-mailbox: `{from: "Name <contact@…>", replyTo: null}` without any SenderAddress | a Reply-To to a non-existent `arslan@polygonparadise.com` would bounce at Zoho |
| `from-address.ts:75-126` `TEAM_FROM_TEXTS` (hint "Replies go to each person's own address on {d}", good-to-know, followUpReminder) | shared-From wording | own-mailbox wording: "Replies come to {from}; mark them Replied" | owner-facing copy; `tests/unit/sending-core/shared-from-words.test.ts` sweeps the words |
| `src/server/services/mailgun/connect.ts:251-366` `connectMailgun`: `:261` validate, `:290-295` F14 misfit, `:328-333` clears Apply run, `:352-356` queues suppression push and route sync | subdomain only | allow the root in this mode; never queue a route sync (`:354-356`) | — |
| `connect.ts:379-489` `saveConnection`: `:421-426` row + deactivate others, `:428-450` **moves every current SenderAddress to `<local>@<new domain>`**, `:456-460` reply-test reset | addresses follow the domain | skip the address move in this mode (or retire all rows) | moved rows create routes on the root on the next sync |
| `connect.ts:522-605` `saveFromAddress` / `saveFrom` (F13: refused while TEST/LIVE campaigns run, ends go-live, resets the reply test) | shared-From | keep; switching mode must go through the same door | — |
| `connect.ts:620-630` `removeSendingKey`, `mailgun-transport.ts:140-141` `SENDING_KEY_TEAM_FROM_FIX` | a domain sending key may refuse a From on another domain (§11 Q7) | moot: the From is on the sending domain, so a sending key works normally | — |
| `src/server/mailgun/context.ts:66-108` | one domain, one row | unchanged (one domain) | — |
| `src/components/settings/sending/connection-form.tsx:170,177` hint/placeholder "mail.polygonparadise.com"; `:240-267` retention "Foundation keeps 5 days of logs and 1 day of stored replies" | Foundation | mode-aware example; retention hint for Free (1 day) | owner keeps 5 → §2.H |
| `src/components/settings/sending/from-address-card.tsx` (whole card) | shared-From card | own-mailbox copy + mode switch | — |

### B. Headers, snapshot, launch, retry, test sends

| Where | Today | Own-mailbox mode needs | Risk |
|---|---|---|---|
| `src/server/services/sending/addresses.ts:68-101` `senderSnapshot`: `:76` throws `NoSenderAddressError` for TEST/LIVE without a SenderAddress; `:86-87` `sendingDomainId`/`messageIdDomain` from the SenderAddress | per-person row required | own-mailbox: From = `formatFromHeader(displayName, contact@)`, `replyTo: null`, `sendingDomainId` = the active domain row, `messageIdDomain` = the sending domain | Message-IDs must stay `@polygonparadise.com` (reconciler `reconcile.ts:383`, catch-up `isOwnSend` `catch-up.ts:215`, reply test `reply-test.ts:580`) |
| `src/server/services/campaigns/launch.ts:354-359` sender's `senderAddresses` (active domain); `:405` `address`; `:499-504` snapshot | needs an address | no address in this mode | — |
| `launch.ts:130-183` `launchModeProblems`: `:143` from-invalid, `:157-167` liveLaunchBlockers, `:172-174` `no-sender-address`, `:175-179` `no-reply-route` | both for TEST/LIVE | skip both address checks in this mode | every launch refused today |
| `launch.ts:457` `senderHasReplyRoute` → `src/core/rules/eligibility.ts:423-426` reason `no-reply-route` | LIVE launch leaves out everyone whose sender has no route | pass `undefined` in this mode | a LIVE launch would exclude every person |
| `launch.ts:869-912` last re-check (F29/SEND-3: domain, From, go-live, region, the sender address's SendingDomain row) | row read from the SenderAddress | re-check the active domain row instead (and the mode flag) | — |
| `src/server/services/sending/mark-sent.ts:180`, `restore.ts:472,528`, `loop.ts:213,796`, `reconcile.ts:383`, `mailgun-transport.ts:248-269` | copy/forward `replyTo`; Mailgun domain = domain of `replyTo ?? From` | unchanged (null Reply-To → the From's domain = the root) | none |
| `src/server/services/campaigns/control.ts:420-438` `retrySnapshotProblem` (SEND-1) | a snapshot with `replyTo` null while a From is saved → `nowShared` refusal (`:426-428`) | treat an own-mailbox snapshot (From = saved From on the sending domain, no Reply-To) as fitting | every Retry refused |
| `src/server/services/test-send.ts:268-385` "Send me a test": `:306-311` needs the sender's SenderAddress; `:312-316` `senderHeaders`; `:318-321` to the user's reply inbox; `:333-334` counts toward today's cap; `:380` self-test note | per-person/shared | no SenderAddress; From contact@; the "reply inbox" becomes just the test inbox | from contact@ to contact@ through Mailgun: Zoho may hide or spam it (UNVERIFIED, research §4.1) |
| `src/server/mailgun/send-guard.ts:48-64` test-list guard (`:53-58` self-test must go to `ownInbox`) | about `to` only | unchanged | — |
| `src/server/mailgun/client.ts` `sendMessage` (sender check + guard) | — | unchanged | — |

### C. Per-person SenderAddress rows, route status, and every check that needs them

| Where | Today | Own-mailbox mode needs | Risk |
|---|---|---|---|
| `src/server/services/sender-addresses.ts:113-121` `activeSendingDomain`, `:138-158` `getSenderAddressInfo`, `:168-240` `setSenderLocalPart` (`:173` `validateLocalPart`, `:236-238` queues a route sync) | the person's own address + route | hidden/disabled; never create rows | a saved local part creates `arslan@polygonparadise.com` (a Zoho address that doesn't exist) and a route |
| `src/app/(app)/settings/profile/page.tsx:21-46` `senderView` ("Reply route: working / Not working / Being set up…", `:25-35`) | status line per address | no address field, no route line | README quotes "Reply route: Being set up…" (`tests/unit/docs/labels.test.ts:169`) |
| `src/components/settings/profile-form.tsx:176-178` Reply inbox "Replies to your campaigns are forwarded here."; `:196` signature hint; `:254ff` `SendingAddressField` | forwarding target | reword: replies come to contact@; the inbox is only where "Send me a test" goes | — |
| `src/app/(app)/settings/profile/actions.ts:44-71` (address save, `:49` `checkProfileInput`) | saves the local part | skip | — |
| `src/server/services/users.ts:667-669` loop text, `:675-698` `checkProfileInput` (`:685-686` refuses an inbox on or under any SendingDomain), `:701-703` `sendingDomainNames`, `:709ff` `updateProfile` | reply inbox never on a sending domain (loop rule) | with no routes there is no loop: allow `contact@polygonparadise.com` in this mode | today the Owner can't save contact@ as reply inbox once the root is a SendingDomain |
| `users.ts:203-211` `queueRouteSync` (Owner always, if an active SendingDomain exists) | route sync on inbox changes | never in this mode | a sync creates the catch-all `^.*@polygonparadise\.com$` and `dmarc@` routes (§D) |
| `src/server/services/sending/gates.ts:235,256` candidate `routeAddress` = `replyTo ?? fromAddress`; `:767,796` `routeOk` map from SenderAddress; **`:1031-1034` LIVE held ("reply-route")** | every LIVE email needs a working route for its route address | skip the hold in this mode | with From contact@ and no SenderAddress row, `routeOk.get("contact@…")` is undefined: **every LIVE email waits for ever** |
| `src/server/services/sending/loop.ts:102,1002-1014` notice "Live emails are waiting: a reply route isn't working" after 1 h | Owner notice | never in this mode | a false alarm every 24 h |
| `src/server/services/reply-test.ts:307-325` `ownerAddress`, `sendersWithoutRoute` (SenderAddresses of the domain row) | gate inputs | empty in this mode, not "missing" | — |
| `src/core/sending/mode-gates.ts:266` `ownerRoute` (reply test), `:334-337` "X has no working reply route." (go-live) | block | drop in this mode | the reply test and go-live never clear |
| `reply-test.ts:488-503` `replyTestBlockersFor` (`:500-502` "Add your sending address first" instead of ownerRoute) | needs an owner address | no address needed | — |
| `src/components/campaign-wizard/sender-step.tsx:18-21` `routeText`, `:86` "replies go to them", `:124-133` address + route line, `:153-158` "replies go to X's inbox", `:159-174` no-address note, `:175-192` shared-From lines | per-person/shared | own-mailbox: "Recipients see Name <contact@…>"; "Replies go to contact@polygonparadise.com: mark them Replied"; no address, no route | the follow-up reminder must show here |
| `src/server/services/campaigns/draft.ts:356-395` `listSenderChoices` (`:378-393` snapshot, `routeOk`), `:1300-1310` launch summary's `launchModeProblems` | needs addresses | own-mailbox snapshot | — |
| `src/app/(app)/settings/limits/page.tsx:106,117,134,289,302` and `components/settings/limits/sender-caps-form.tsx` ("Sending address" column, "Nobody has a … address yet") | per-sender list keyed on addresses | list senders without addresses | empty state would say nobody can send |
| `src/app/(app)/settings/team/switch-off-text.ts:70` "Replies to X's sending address will come to your inbox" | routes forward to the Owner | "Replies already go to contact@" | — |
| `src/server/services/mailgun/suppressions.ts:316-335` `removableAddresses` (reply inboxes), `:337-387` `removeOwnSuppression` (`:383` route sync) | Remove for test mailboxes and reply inboxes | keep for test mailboxes; no route sync | — |

### D. Routes and Apply recommended settings

| Where | Today | Own-mailbox mode needs | Risk |
|---|---|---|---|
| `src/core/mailgun/routes.ts:49-56` sender route, `:63-71` catch-all, `:74-82` dmarc@, `:116-126` `isSafeForwardAddress`, `:129-138` `sendingDomainOf` | routes per SendingDomain | none of them in this mode | an apex catch-all never fires (MX = Zoho) but `/routes/match` reports it "ok" (`services/mailgun/routes.ts:497-523`) |
| `src/server/services/mailgun/routes.ts:126-439` `syncRoutes`: `:153-157` every SendingDomain is a loop domain, `:195-209` plans, `:270-323` catch-all + dmarc@ per domain (only the active one gets new ones, `:293-298`), `:332-368` `/match`, `:370-411` writes routeStatus, `:419-427` notice | sync | short-circuit in this mode: create nothing; delete the app's own `outreach-app:` routes if any exist | Free allows **1 inbound route** (pricing page): creating 3+ fails, turning statuses to "error" and the job retrying |
| `src/server/services/mailgun/apply-settings.ts:258-437` `runAll` | 12 steps on `ctx.domain` | per step below | each step now changes the **root's** Mailgun settings |
| — `:283-297` public address (GET `<pub>/api/health`) | needs `APP_PUBLIC_URL` | still needed for webhooks only | without Cloudflare: webhooks skipped (`:420-422`) |
| — `:319-373` open/click off, unsubscribe on (Setup A) / off (B) | Setup A for live | always Setup A; drop B | Mailgun's unsubscribe footer settings apply to every Mailgun send from the root (only the app sends through Mailgun) |
| — `:376-381` `spam_action: "tag"` | inbound spam filter | skip (no inbound) or keep harmless | row `spam-filter` is a go-live row (§E) |
| — `:382-389` `message_ttl` | stored replies | skip or keep (Free lists 1 day of message retention) | row `retention` is a go-live row |
| — `:390-397` PII redaction off | events | keep | — |
| — `:399-416`, `:475-512` certificate `email.polygonparadise.com` + `web_scheme` https (402 → `not-in-plan`, `:507-509`) | Foundation | keep trying; on Free expect `not-in-plan` (UNVERIFIED) | `https-links` row red → go-live blocked (§E); http unsubscribe links |
| — `:419,455-470` signing key | account | keep (webhooks need it) | — |
| — `:423-434` webhooks + **routes** | both | webhooks only; never routes | the "routes" step fails and re-queues a route sync (`:433`) |
| `src/components/settings/domain/apply-rule.ts:4-13` `APPLY_FIXES_ROWS` includes `reply-routes`, `retention`, `spam-filter`, `https-links` | Apply stays orange while one isn't ok | drop the rows the mode doesn't have | Apply stays the orange button for ever |
| `src/app/(app)/settings/domain/page.tsx:17` Apply description ("keeps stored replies… and the reply routes") | copy | mode-aware | — |
| `src/server/services/reply-test.ts:872-895` `switchUnsubscribeSetup` (queues Apply) | Setup B check | not offered | — |
| `src/app/(app)/settings/domain/load.ts:105-113` manual route values (`senderRouteSpec`, `isSafeForwardAddress`) | guide 2 step 15 fallback | not shown | — |

### E. Domain checklist rows, gates and go-live rows

Rows are built by `buildChecklistRows` (`src/core/dns/checklist.ts:1586-1620`) from `runDomainCheck`
(`src/server/services/checks/domain-check.ts:178-371`). "Live" = `LIVE_ROW_GATES` (`mode-gates.ts:91-98`: a missing or
"bad" row blocks Live mode, the reply test and a LIVE launch). "Go-live" = `GO_LIVE_ROW_KEYS` (`mode-gates.ts:101-118`:
must be "ok"; + `from-mx` in shared-From mode, `:121-131`). The guide-4 step-2 list is pinned to `GO_LIVE_ROW_KEYS`
(`tests/unit/docs/labels.test.ts:94`).

| Row | Where | Today on the root | Gates today | Own-mailbox mode needs |
|---|---|---|---|---|
| `mailgun-domain` | `checklist.ts:449-502` | ok if Mailgun's state is "active" (SPF/DKIM verified; MX not needed, Likely) | Live, go-live | unchanged |
| `spf` | `:509-563` (good test `:532-535` only looks at top-level includes; fix `:547-549` builds a merged record) | **bad**: the root's record includes two `dc-…._spfm` names, not `mailgun.org`; fix "Change it to: v=spf1 include:mailgun.org include:dc-… include:dc-… ~all" (14 lookups) | Live (dns), go-live | include-aware check (is `mailgun.org` reached through the include tree? `spf-count.ts:37-64` already walks it) + the from-spf rules (`:1064-1153`: 9–10 lookups "info", >10 or dangling "bad", never a merged record). It **must** stay a gate here (the root's SPF is the sending SPF), unlike from-spf | a copied fix breaks SPF for Zoho mail (permerror) |
| `dkim` | `:641-712` | ok (`mx._domainkey`, 1024-bit is "ok", `:586-590`) | Live, go-live | unchanged |
| `mx` | `:714-769` (records `:720-727` name `@`; fix `:750-754`; ok text `:768`) | **bad**: "Replies to polygonparadise.com don't go to Mailgun." with record boxes `MX @ → mxa/mxb.mailgun.org` | Live (dns), go-live | **replace** by the from-mx logic (`fromMxRow`, `:995-1055`) for the sending domain: red when Mailgun MX or null MX, warn on Cloudflare Email Routing, no record box, never asks for Mailgun MX | copying the box sends all Zoho mail (and every reply) to Mailgun: everyday mail lost |
| `tracking-cname` | `:771-797` | ok (`email` → `mailgun.org`) | Live, go-live | unchanged |
| `https-links` | `:799-834` (`not-in-plan` `:801-809`) | bad on Free if the certificate is refused | go-live | decide: keep (needs Foundation) or "warn" on Free |
| `dmarc` | `:845-890` (rua fix "Use dmarc@${d}" `:880`) | bad (no record); fix `_dmarc` `v=DMARC1; p=none` is safe | go-live | unchanged; the rua fix should not suggest `dmarc@polygonparadise.com` without a Zoho mailbox (and never a route) |
| `from-mx`, `from-spf` | `:995-1153`; emitted only when `facts.from` is set (`:1604`); facts `domain-check.ts:114-136`; notices `:378-398` (`from-mx-bad`, `from-spf-broken`) | shared-From only | from-mx: Live, reply test, go-live; hold `main-domain-mx` (`gates.ts:703-706,1027-1030`) | fold into `mx`/`spf` above for the sending domain (keep the hold and the notices: an MX at Mailgun is the one thing that must never happen). `fromSpfRow`'s ok text "The app's emails don't use it" (`:1152`) is false here |
| `tracking-off`, `unsubscribe` | `:1155-1186` | ok after Apply | Live, go-live (+ `isLiveReady`, `gates.ts:689-692`) | unchanged (Setup A only) |
| `spam-filter`, `retention` | `:1188-1215` | ok after Apply (probably) | go-live | drop from the mode's go-live keys (nothing inbound) |
| `signing-key` | `:1217-1239` | ok | Live, go-live | unchanged |
| `webhooks` | `:1241-1264` (no public URL → bad `:1243-1251`) | **bad** while `APP_PUBLIC_URL` is empty | **Live mode**, go-live | decide: keep (Cloudflare first) or make it "warn" when the Logs catch-up runs, since events then arrive within the hour |
| `reply-routes` | `:1278-1338` (empty list → bad `:1283-1287`); UI `components/settings/domain/checklist.tsx:76,203-234` | bad (no senders) | go-live | drop in this mode |
| `sending-allowed` | `:1342-1355` | ok | Live, go-live | unchanged |
| `monthly-limit` | `:1363-1376` | warn/unknown | never | unchanged (on Free the 100/day is Mailgun's own brake) |
| `remote-access` | `:1384-1479` | bad (no public address) | go-live | decide with `webhooks` (Cloudflare is also how teammates reach the app) |
| `reply-test` | `:1491-1531` (per-person fail fix "ali@reply.<domain>…" `:1527`) | warn | via `replyTestPassedFor` (§F) | by-hand test texts |
| `postmaster` | per-person `:1554-1567` (any `google-site-verification` → "ok, looks set up") vs team `:1539-1552` (SCREENS-03: stays "info") | the root already has a verification record for another Google service → misleading "ok" | never | use the team variant |
| `domain-age` | `:1570-1579` | the root: old, ok once the date is entered | recommendation only | unchanged |

Also: `mode-gates.ts:23` the DNS sentence, `:134-158` `CHECKLIST_ROW_TITLES` ("Replies reach the app (MX)", "Stored
replies are kept", "Replies reach each sender"), `checklistTitle` (`checklist.ts:256-303`); the fake-mode DNS
(`src/server/services/checks/dns-lookup.ts:75-108` answers the sending domain's MX as Mailgun's valid records, so fake
mode can't show the inverted row; it needs a mail-provider MX for the sending domain in this mode); the dashboard's
checklist attention item (`src/core/dashboard/attention.ts:297-306`, `badGoLiveRows`).

### F. The reply test (Setup A/B) and every use of `replyTestPassedFor`

What it requires the app to see today:

| Fact | Where | Own-mailbox mode |
|---|---|---|
| test email **delivered** (a `delivered` MailEvent on the TestSend) | `reply-test.ts:597-601`, `core/reply-test.ts:178` | possible (webhook or the Logs catch-up) |
| **reply reached the app**: an InboundMessage from the test mailbox to `ownerAddress` after the send (shared-From: its thread names a counted test email) | `reply-test.ts:602-629`, `core/reply-test.ts:179` | **impossible** (no route, no inbound) |
| "reply arrived in your reply inbox" (`inboxOk`), "dkim=pass or arc=pass" (`authOk`) | `core/reply-test.ts:180-181,271-272`; UI `reply-test-section.tsx:522-539` | inbox answer by hand in Zoho; the dkim/arc question checked Mailgun's forward, which no longer exists: drop |
| one Outlook.com and one Gmail/Yahoo mailbox complete | `core/reply-test.ts:290-305` | keep |
| List-Unsubscribe headers answered | `core/reply-test.ts:334-335` | keep |
| an **unsubscribe** that reached the app (`unsubscribed` event on a counted TestSend, source WEBHOOK/LOGS) | `reply-test.ts:634-649` | possible (Logs) |
| shared-From extras: placement, DMARC answer, one pasted original (`parseTestOriginal`, `core/reply-test.ts:911-952`) with `returnPathOk`/`mailtoOk` = on the sending domain | `core/reply-test.ts:274-279,307-332` | placement and DMARC keep; with the sending domain = the root, `returnPathOk` and `mailtoOk` pass, but their meaning flips: a root Return-Path/`mailto:` means bounces, auto-replies and mailto unsubscribes go to Zoho. The texts "(bounces and automatic replies reach the app)" (`testOriginalTexts`, `:958ff`) would be false |
| Setup A for live; Setup B "check only" | `mode-gates.ts:39,237,269,331`; `gates.ts:689-692`; UI `reply-test-section.tsx:733-760` | always A; hide B |

Blockers and uses:

| Where | Today | Own-mailbox mode needs |
|---|---|---|
| `mode-gates.ts:248-271` `replyTestBlockers`: mode ≠ dry run, `liveModeBlockers` (so `mx`, `spf`, `webhooks`…), `ownerRouteOk`, `publicAddressOk`, test list, Setup A/B | all must clear | drop `ownerRoute`; decide `publicAddress` (only webhooks need it); the rows per §E |
| `reply-test.ts:409-439` `sendReplyTestEmails` (`:418` needs `ownerAddress`; `:431-435` headers) | From the Owner's address/shared | From contact@ with the Owner's display name, no Reply-To |
| `reply-test.ts:568-683` `loadReplyTest`; `:703ff` answers; `:739ff` original; `:820ff` `decideReplyTest` (compare-and-set) | verdict `evaluateReplyTest` (`core/reply-test.ts:246-340`) | a by-hand verdict (§3) behind its own `setup` value (e.g. "M"), so `replyTestPassedFor` keeps working |
| `core/reply-test.ts:347-355` `replyTestPassedFor` — used by `reply-test.ts:372` (`replyTestPassedOnDomain`), `launch.ts:163`, `checklist.ts:1495`, `settings/domain/load.ts:128-160`, `go-live.ts:217-227` | pass per (domain, From) | unchanged key; the stored decision records the mode too |
| `mode-gates.ts:218-241` `liveLaunchBlockers` (`:237` Setup A, `:238` passed); `:294-342` `goLiveBlockers` (`:331-332`) | block until passed | block until the by-hand test passed |
| `core/reply-test.ts:1036-1071` `validateTestList` (`:1052-1056` no mailbox on a sending domain, `:1057` not the From); `reply-test.ts:904-931` `saveTestList` | test mailboxes outside the sending domains | unchanged (every @polygonparadise.com mailbox is refused, which is right) |
| `core/reply-test.ts:1004-1024` the test email ("Please reply to this email") | reply to the route | the reply goes to contact@ |

### G. Go-live

| Where | Today | Own-mailbox mode needs | Risk |
|---|---|---|---|
| `reply-test.ts:254-401` `loadGateInputs` → `goLiveBlockersFor` (`:442-459`) | checklist fresh, go-live rows ok, Setup A, reply test passed, not paused, every sender has a route, delivered live test, worker running | rows per §E; no route condition | — |
| `reply-test.ts:167-179` `isCheckFresh` (1 hour, after the From/domain change) | works | unchanged | needs the worker to run the check |
| `reply-test.ts:192-233` `loadLiveTest` (`:200-208`: shared-From → `replyTo: { not: null }` and `fromAddress = teamFrom`; per-person with `since` → `replyTo: null`) | the live test counts only campaigns of today's way of sending | own-mailbox: `replyTo: null` **and** `fromAddress = contact@` launched since the change | with today's filter a shared-From teamFrom demands a Reply-To: the live test never counts |
| `src/server/services/go-live.ts:137-176` view, `:261-310` `goLive` (writes `goLiveFrom`, `:303`), spam-placement tick `:275` | shared-From aware | add an acknowledgement tick ("replies come to contact@ only; I mark Replied by hand before follow-ups go") like the spam-placement tick | — |
| `src/core/sending/go-live-copy.ts` dialog items (`dialogTeamFromItem`, `liveFromLine` "replies go to each sender's own address") | shared-From copy | own-mailbox copy | — |
| `mode-gates.ts:353-390` recommendations (`:377` "after going live, live campaigns only email checked addresses") | address checks | on Free, validations aren't listed on the pricing page (UNVERIFIED): check the eligibility impact before go-live | live campaigns may email nobody |

### H. Events, catch-up, restore scan, suppressions, health, warm-up, limits

| Where | Today | Own-mailbox mode | Risk |
|---|---|---|---|
| `src/server/services/mailgun/catch-up.ts:684-821` `runCatchUp` (hourly, `worker/periodic.ts:117-126`); `:308-367` `walkEventLogs` (accepted, delivered, failed, complained, unsubscribed; `:85`) | Logs polling per domain | **works without inbound and without webhooks**: this is how events arrive when `APP_PUBLIC_URL` is empty | runs only in the background sender (`start.bat`), never under `npm run dev` |
| `catch-up.ts:445-495` `walkStoredReplies` (`stored` events) | stored replies | walks and finds nothing (harmless; one call per hour) | — |
| `catch-up.ts:747-748` `logRetentionMs = clampDays(logRetentionDays, 1, 30, 5)`; `:261-274` `logsWindow` (a gap only when the cursor is older than the floor) | assumes the setting matches the plan | the owner must set **1 day** (Settings › Sending & Mailgun › Advanced, `components/settings/sending/connection-form.tsx:240-267`; action `settings/sending/actions.ts:244-259`) | with 5 kept on a 1-day plan, a PC off for 2–5 days loses events **without** recording an outage gap |
| `src/server/services/sending/gates.ts:625-639` `isCatchUpReady`, `:650-656` `isFollowUpCatchUpReady` | TEST/LIVE wait for a catch-up since start (follow-ups: no fallback) | unchanged (Logs work) | — |
| outage hold: `catch-up.ts:287-306` `recordOutageGap`; texts `src/core/dashboard/attention.ts:159-161` and `settings/sending/load.ts:117` ("more than 5 days", hard-coded in attention.ts), README 198-199 | holds follow-ups because replies may have been missed while the PC was off | replies never pass through Mailgun, so the reason doesn't apply; events come back from the suppression lists. Decide: keep (harmless extra step) or skip in this mode; fix "5 days" to follow the setting | wrong day count on Free |
| `src/server/services/sending/restore.ts:684-805` `runRestoreScan` (`:722-727` retention from the setting, `:746-775` `accepted` + tag `outreach` per domain) | finds sends after the backup | works; needs `logRetentionDays = 1` | with 5 kept, a 2–5 day old backup is scanned as "within retention" and due emails aren't marked "Not sure it was sent" → possible second sends |
| `src/server/services/sending/reconcile.ts:356-357` retention | UNKNOWN rows vs Logs | needs the right retention | same |
| `src/server/services/mailgun/suppressions.ts:91-160` pull, `:175-207` push (to the root's unsubscribe list) | per domain | unchanged; Mailgun's lists on the root affect only Mailgun sends (Zoho unaffected) | — |
| `src/server/services/mail-events/webhook.ts` events + inbound routes; `src/app/api/webhooks/mailgun/{events,inbound}` | need a public address | events optional (Logs); inbound never used | — |
| `src/server/services/sending/health-check.ts:62-135` (bounces of the last 200, complaints of the last 1,000) | Mailgun events | **undercounts**: late bounces never reach Mailgun (§0.1 quote); Gmail complaints never did | the auto-pause brakes later than it should on the root, the owner's everyday domain |
| `src/core/sending/caps.ts:8-10` `DEFAULT_WARMUP_TABLE` (50 … step 6 = **110** … 1,000), `:45-54` `domainCapFor` (min of warm-up and `sending.maxDailyCap`) | ramp to 1,000 | set `sending.maxDailyCap` to ≤ 100 (allowed: 50–10,000); decide whether the mode clamps it | Free: "100 emails/day" |
| `src/core/rules/mode.ts:25-27` `countsAsReal` (LIVE only); `test-send.ts:333-334` test sends count; reply-test emails count | TEST-mode campaign emails are **not** in the app's cap | Mailgun Free probably counts test-mode messages toward 100/day (UNVERIFIED, `research/mailgun-sending.md:46`) | the app's cap can be under 100 while Mailgun refuses |
| `src/server/mailgun/errors.ts:128-139` `classifyStatus`; `mailgun-transport.ts:149-211` `mailgunFailure` (`:164-165` other 4xx → "rejected"; `:186-193` "is not allowed to send" → pause); `loop.ts:609-617` `failForGood`, `:960-961` rejection breaker (3 in 30 min → pause) | per status | unknown which status the 100/day refusal uses (UNVERIFIED): a generic 4xx fails each email **for good**; 429 would retry; the authorized-recipients refusal ("Free accounts are for test purposes only…", `research/mailgun-api-reference.md:137`) pauses all sending | lost follow-up steps; a pause at the first non-authorized prospect after go-live |
| `src/server/services/sending/warmup-days.ts`, `src/server/services/sending/usage.ts` | keyed by `mailgun.domain` | the root: ramp starts at go-live | — |

### I. Replies, stops, marking a reply by hand, notifications and dashboard

| Where | Today | Own-mailbox mode | Risk |
|---|---|---|---|
| `src/server/services/mail-events/stops.ts:332-362` `stopCompaniesForStatus` (stop code `status:REPLIED`, every campaign, QUEUED → SKIPPED) | the one door for a status stop | **the only way a reply stops follow-ups** | — |
| `src/server/services/companies/mutations.ts:137-166` `setCompanyStatus`, **`:148` returns "unchanged" (no stop) when the company already has that status**; UI `src/components/company-panel/company-header.tsx:137-176` `StatusPicker`; bulk `src/server/services/companies/bulk.ts:76-119` (`:94` same filter); import `src/server/services/imports/commit.ts:733` | status by hand | a company that is already Replied (e.g. put back by hand into a new campaign, `campaigns/audience.ts:889`) can't be stopped again by choosing Replied | follow-ups continue after a second reply unless another status is chosen |
| no "Mark as replied" control exists (`SHARED-FROM-DESIGN §1.6` deferred it; the reply actions `src/server/services/replies/actions.ts:284,350,499` need a stored InboundMessage) | — | recommended: a one-click "They replied" on the company panel and the campaign page (writes Replied, `repliedAt`, stops, logs who) | — |
| `src/server/services/replies/effects.ts:120-135` the only writer of `Company.repliedAt` / person `repliedAt` | set by processed replies | never written by a status change | dashboard reply rate (`src/server/services/dashboard/pipeline.ts:23-38`) stays 0; "put back by hand" rule (`src/server/services/eligibility.ts:612-614`) never sees a later reply; import check "Replied … ago" (`imports/check.ts:207-210`) empty |
| `src/server/services/campaigns/queries.ts:382-386,509` campaign "replied" count = InboundMessage REPLY rows | counts replies | always 0 | results look like nobody replied |
| `src/app/(app)/campaigns/[id]/page.tsx:123-136` "Sent by … replies to …"; **`:136` the follow-up reminder shows only when `overview.replyTo` is set** | shared-From reminder | show it for every own-mailbox campaign with follow-ups to come | the one reminder that prevents follow-ups to repliers disappears |
| `TEAM_FROM_TEXTS.followUpReminder` (`from-address.ts:97-98`), wizard `sender-step.tsx:188-191` | shared-From only | own-mailbox wording | — |
| notifications: `waitingReplyWhere` (`src/server/notifications.ts`), bell, `src/server/services/dashboard/replies.ts:16-34`, attention "replies-waiting" (`attention.ts:214`), Notifications › Replies, Team page counts, reply notification types, desktop pop-ups | built from InboundMessage | always empty | owners may read "no replies" as "no interest" |
| `system.replyRoute` notices (`loop.ts:1008-1013` "reply-route-down", `services/mailgun/routes.ts:419-427` "reply-inbox-suppressed") | route problems | never in this mode | false alarms |
| `src/server/services/mail-events/internal-senders.ts:46-94` (every @SendingDomain address and the From domain are "internal") | who is "us" | irrelevant (nothing inbound) | — |
| `src/server/services/mail-events/simulate.ts:210-274` Simulate reply (dry runs) | stores a fake reply to `replyTo ?? From` | still works in dry runs; it shows a flow the real app never has in this mode | practice misleads |
| worker event lane `processPendingInbound`, `src/server/services/replies/**`, auto-reply classification | process replies | idle | — |

### J. Practice copy, seeds, fake Mailgun, test helpers, Playwright

| Where | Today | Own-mailbox mode needs |
|---|---|---|
| `scripts/make-demo-data.ts:130,139-142` (reply inbox = login, `practice.copy`, dry run; no SendingDomain) and `addresses.ts:33,92` placeholder `name@your-sending-domain` | per-person placeholder, "Sending address" | nothing breaks; decide whether the practice copy can show the mode (the From card refuses in the practice copy, F22). README:165 explains the words |
| `scripts/seed-m6-manual.ts:308-309` `DOMAIN = "send.example.com"`, `:443` reply inboxes, `:472-491` from-* rows, `:504` mx row "Replies go to Mailgun.", `:520` reply-test row, `:543` titles, `:591-601` From saved first, `:616-617` SenderAddress `routeStatus: "ok"`, `:640` reply test, `:998` old domain | shared-From (ready, live) and per-person (busy, `--per-person`) | a new flag/state (e.g. `--own-mailbox`: `mailgun.domain = example.com`, From `contact@example.com`, no SenderAddress, inverted mx/spf rows, a by-hand reply test, `logRetentionDays = 1`); the address check `:1397-1410` allows example.com |
| `scripts/seed-m5-manual.ts:111,246,261-265` | per-person send.example.com | unchanged (per-person) |
| `tests/fake-mailgun/state.ts:93-94` plan `"foundation" \| "basic"`; `handlers/x509.ts:23,59` 402 on basic; `handlers/routes.ts` no route limit; `handlers/messages.ts` no daily limit; `cli.ts:15,23,78-81` `--plan`, `--retention-days` | Foundation-like | a `free` plan: 1 route (refuse the 2nd, status UNVERIFIED), 100/day (refusal UNVERIFIED), 402 on x509, 1-day logs, optional "authorized recipients only" switch |
| `tests/fake-mailgun/admin.ts:173-175` a preset addressed on the fake's own domain is stored and posted | the domain's MX is Mailgun | an "MX elsewhere" option: in this mode every preset (`new-email`, `reply`, `out-of-office`, bounce notices to contact@) answers `deliveredTo: "outside"`; otherwise tests would prove the app sees replies it never can (the C1-4 lesson) |
| `tests/fake-mailgun/state.ts:323-324` receiving MX records; `src/server/services/checks/dns-lookup.ts:75-108` fake-mode DNS | MX = Mailgun | fake-mode answers a mail-provider MX and a GoDaddy-style `_spfm` SPF for the sending domain |
| `tests/integration/helpers/mailgun.ts:31-75` `connectFakeMailgun({fromAddress})` (`:61` deactivates others) | shared-From | an own-mailbox option (domain = From domain, flag set) |
| `tests/integration/helpers/replies.ts` (`replyInput` to `replyTo ?? fromAddress`), `tests/integration/mailgun-setup/helpers.ts` (`addSenderAddress`, `writeDomainCheck`) | route-based | not used by the mode's tests except to prove nothing arrives |
| `playwright.config.ts:36-40,88` (fakes 4010/4011/4012, `--dkim-authority`); `tests/playwright/{shared-from,go-live,settings,dashboard,screens}.spec.ts`, `manifest.ts` | three seeded states | one own-mailbox state (screens: From card, My profile without an address, wizard Sender step, checklist rows, the by-hand reply test, go-live dialog, campaign page reminder) |

### K. Existing tests that pin today's rules (they stay for the other modes; the new mode needs its own)

- Sending domain / From: `tests/unit/setup-core/sender-address.test.ts:58-59,74` (root refused);
  `tests/unit/contracts-shared-from/from-address.test.ts:107,113-118` and `tests/unit/sending/from-address.test.ts:41-42,52`
  (noSubdomain, onSendingDomain); `tests/integration/mailgun-setup/{connect,from-address,region-move}.test.ts`.
- Never Mailgun's: `tests/integration/shared-from/end-to-end.test.ts:660-724` (step 9: the From domain is never a path
  segment, a SendingDomain or a route). The mode needs the inverse test: no route, no MX record asked, no Reply-To.
- Gates: `tests/unit/sending-core/mode-gates.test.ts:49,76,323-383`; `tests/unit/sending/gates.test.ts`;
  `tests/integration/sending-m3/{gates,launch-control}.test.ts`; `tests/unit/rules/eligibility.test.ts` (no-reply-route);
  `tests/integration/shared-from/{hold,sending,launch-race,retry-from,evidence}.test.ts`.
- Checklist: `tests/unit/checks/checklist.test.ts` (mx, spf merge fix), `tests/unit/settings/domain-checklist-render.test.ts`,
  `tests/integration/checks/{domain-check,fake-mode-dns}.test.ts`, `tests/unit/checks/from-domain-lookup.test.ts`.
- Routes/Apply/reply test: `tests/unit/setup-core/routes.test.ts`, `tests/integration/mailgun-setup/{routes,apply,reply-test,actions}.test.ts`,
  `tests/unit/setup-core/{reply-test,reply-test-team,test-original}.test.ts`.
- People: `tests/integration/sender-addresses/{sender-addresses,words}.test.ts` (reply inbox on a sending domain refused),
  `tests/unit/setup-core/ui.test.ts`, `tests/unit/sending-core/shared-from-words.test.ts`, `tests/unit/campaigns/ui.test.ts`.
- Test sends: `tests/integration/test-send/{test-send,team-from}.test.ts`.
- Go-live: `tests/integration/go-live/*.test.ts` (gate-inputs, switch, team-from, launch-summary, sending-page).
- Catch-up/restore: `tests/integration/catch-up/*.test.ts`, `tests/integration/backups/restore-review.test.ts`.
- Docs: `tests/unit/docs/labels.test.ts` (`:94` guide-4 row list = `GO_LIVE_ROW_KEYS`, `:169`, `:277-526` shared-From
  quotes), `tests/unit/docs/guide-refs.test.ts` (guide 2 keeps 19 steps, guide 4 keeps 13), `readme-topics.test.ts`,
  `tests/unit/settings/m5-texts.test.ts`; whole-tree guards `tests/integration/security/owner-actions.test.ts` (a new
  Owner action), `tests/unit/core/no-milestone-text.test.ts`.

### L. Owner docs and specs

| Doc | Where | Says today |
|---|---|---|
| `SPEC.md` | 21-22, 31-32, 60-61 (dated decisions: subdomain + Reply-To), 36 ("The app detects replies"), 147-154 (reply counts and stops), 185-200 ("Replies": route per sender, match, mark Replied, auto-replies), 205-216 (reply notifications, dashboard reply rate), 294 ("MX for replies, and the inbound routes") | the whole reply-detection chapter this mode gives up; needs a dated owner note |
| `README.md` | 16, 22-23 (Foundation), 43-51 (Mailgun, DNS and reply routes), 80 ("The app sets Contacted and Replied by itself"), 165, 181-187 (the way back), 198-199 ("up to about 5 days", Foundation), 332, 344-346 (costs), 376 (Reply address glossary); "Reply route: Being set up…" is a pinned quote | every reply-route sentence |
| `docs/setup/2-mailgun-and-dns.md` | intro 3-18; step 1 (26 Foundation, 31); step 2 (46-58 the subdomain); 3 (upgrade); 4 (add mail.polygonparadise.com, 67-82); 6 (103 retention "right for Foundation", 105-117); **7 (119-149: MX `mail` records, "copy every record")**; 8 (151-170); 11 (189-222: routes, stored replies, certificate); 12 (224-239: reply address, reply inbox); 13 (241-289: the reply test); 14 (291-320: replies reach the app); 15 (322-340: routes); 17 (348-350: "replies always reach…"); 18 | written for Shape B; 19 steps pinned |
| `docs/setup/3-cloudflare.md` | 24 ("Never use mail.polygonparadise.com … for the app"), 54, 72 (never Email Routing for the root: still right, more so) | — |
| `docs/setup/4-going-live.md` | 9, 17-22 (Foundation, Reply address, "Reply route: working"), 32-64 (the 16 pinned rows incl. "Replies reach the app (MX)", "Stored replies are kept", "Replies reach each sender"; routes for every sender), 68-110 (rehearsal: "the answer goes to your reply address, through the app"; Notifications lists the reply; "Stopped: they replied"), 268ff (step 13) | the rehearsal must become "reply lands in contact@, mark Replied, watch the follow-up stop" |
| `docs/dev/CONVENTIONS.md` | 521-636 ("Shared From address rules": 569-574 "The From domain is never a Mailgun domain", 604-617 checklist and what the app can't see), 267-316 (M4 replies), 211-265 (M3) | a new "Own mailbox mode rules" section |
| `PLAN.md` | header note naming SHARED-FROM-DESIGN; Q8 (separate domain) | a note naming this mode's design |

### M. Operations that decide whether any of this runs

- The owner runs `npm run dev`: no background sender, so no sending loop, no catch-up (the only event source without
  webhooks), no domain check ("Check again" and "Apply recommended settings" only queue jobs), no reply-test emails (job
  `send.testEmail`), no warm-up evaluation. `start.bat` is required (`worker/periodic.ts:98-166`, CONVENTIONS "Jobs and
  loops"). Go-live checks the worker's heartbeat (`mode-gates.ts:47,340`).
- `APP_PUBLIC_URL` empty: `webhooks` row bad → **Live mode can't be chosen** (`mode-gates.ts:95`), the reply test is
  blocked (`publicAddress`, `:267`), `remote-access` blocks go-live. Test mode sends with Mailgun's test mode
  (`mailgun-transport.ts:78`), which delivers nothing, so without a decision here the owner can reach no inbox except
  through "Send me a test".

---

## 3. Checks that become impossible, and what could replace them

| Check today | Why impossible or meaningless now | Replacement (by hand unless said) |
|---|---|---|
| **Reply reached the app** (reply test, `core/reply-test.ts:179`) | replies go to Zoho | "Reply from each test mailbox; did the reply arrive in contact@polygonparadise.com, not in spam?" Yes/No. Optional proof: paste the reply's headers; the app checks that its In-Reply-To/References names a counted test email (`threadIds`, as REPLIES-01 does) |
| dkim/arc of the forwarded reply (`authOk`) | there is no forward | drop |
| Setup B (unsubscribe handling off, check only) | it existed to protect forwarded replies | drop; always Setup A |
| Owner's reply route and every sender's route (`ownerRoute`, `sendersWithoutRoute`, `reply-routes` row, LIVE route hold, `no-reply-route`) | no routes | a one-time acknowledgement at go-live: "Replies come only to contact@. I set the company to Replied before its next follow-up is due." |
| "Replies reach the app (MX)" row | the MX is Zoho by design | inverted row: "Mail for polygonparadise.com stays with Zoho (MX)" (from-mx logic), gating Live and go-live, holding LIVE emails and notifying once a day when red |
| "Stored replies are kept", "Spam filter marks, never deletes" | nothing inbound | drop from the mode's go-live rows |
| Return-Path on the sending subdomain (pasted original, F25) | the Return-Path is on the root by definition | keep the paste, but read it as facts to acknowledge: From = contact@ ✓, DMARC pass ✓, signed by polygonparadise.com ✓ (strict alignment), https List-Unsubscribe ✓; "late bounces and automatic replies go to contact@ (or nowhere)" and "unsubscribe by email goes to …@polygonparadise.com: handle it by hand" shown as warnings, not passes |
| Late (asynchronous) bounces → `failed` events → suppression and the bounce auto-pause | NDRs go to the root's MX (§0.1 quote) | by hand: a "couldn't be delivered" notice in contact@ → put that address on the do-not-email list (Settings › Deliverability › Add an address) or set Do not contact. Whether Zoho even delivers `bounce+…@` mail depends on a Zoho catch-all (UNVERIFIED); the health numbers undercount |
| `mailto:` unsubscribes | go to `u+…@polygonparadise.com` at Zoho | the https one-click link still reaches Mailgun and the app (automatic, via Logs or webhooks); a `mailto:` request that shows up in contact@ → do-not-email list by hand |
| Out-of-office / auto-reply classification | nothing inbound | the owner judges in Zoho; no status change |
| Replies waiting, bell, notifications, "Stopped: they replied", campaign reply counts, reply rate | built from InboundMessage | status Replied by hand (company-wide stop); better with a "They replied" action that also writes `repliedAt` (so the reply rate and the put-back rule work) and a no-op-proof path for companies already Replied |
| Outage hold ("replies may have been missed while the PC was off") | replies never pass through Mailgun | not needed for replies; events recover from the suppression lists; decide |
| Test email delivered; unsubscribe reached the app; delivered live test; checklist freshness | — | **still automatic** (webhooks or the hourly Logs catch-up, which needs the background sender) |
| DMARC pass, placement (inbox or spam) per test mailbox | — | still by hand (as today in shared-From mode) |

A by-hand reply test therefore passes when: every test mailbox's test email was delivered (app); one Outlook.com and
one Gmail/Yahoo mailbox answered placement and "the reply arrived in contact@" Yes; one pasted original shows From
contact@, DMARC pass and a polygonparadise.com signature; the List-Unsubscribe headers answer is Yes; one unsubscribe
click reached the app; and the Owner ticked the two acknowledgements (replies only in contact@; bounces and mailto
unsubscribes by hand).

---

## 4. Open questions (not verified; the app never probes)

1. Free plan: which HTTP status and text Mailgun returns past 100 emails a day, and whether test-mode (`o:testmode`)
   messages count toward it (decides `rejected` vs `rate-limited` vs pause, §2.H).
2. Free plan without a card on file: are sends limited to authorized recipients for this owner? (Account settings.)
3. Free plan: does `POST /v2/x509/email.polygonparadise.com` answer 402, and does `PUT` of `message_ttl` 86,400 succeed?
4. Free plan: what `POST /v3/routes` answers for a second route (only relevant if a stale route sync runs).
5. Logs retention on Free: 1 day (pricing page) or "at least 2 days" (tracking page)? Plan with 1.
6. Zoho: is a catch-all set, so that `bounce+…@` NDRs and `u+…@` mailto unsubscribes land somewhere a person sees them?
   And does Zoho show, thread or filter "Send me a test" from contact@ to contact@ through Mailgun?
7. Gmail/Yahoo: are http (not https) unsubscribe links acceptable at 100 a day (below the bulk-sender threshold)?
8. Does Mailgun report the root as `state: "active"` with its MX unverified (the `mailgun-domain` row)?
