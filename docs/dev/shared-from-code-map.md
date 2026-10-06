# Code map: one shared From address (contact@polygonparadise.com)

Written 2026-09-27 for the design of the owner's decision: every outreach email arrives
`From: "Arslan from Polygon Paradise" <contact@polygonparadise.com>` (display name per person), with a per-person
`Reply-To` on a Mailgun reply subdomain (e.g. `arslan@mail.polygonparadise.com`), so replies still pass through Mailgun
routes (stored, notified, forwarded to each person's reply inbox, which may be `contact@polygonparadise.com`).
polygonparadise.com keeps its own MX (Zoho, per `docs/setup/3-cloudflare.md:53`); its MX must never point to Mailgun.

This file only maps the code and docs; nothing was changed. Paths are relative to the repo root, `file:line` points at
the code as of today. "Today" = what the code assumes now; "Change" = what the shared-From shape needs; "Risk" = what
breaks, or what to watch. "From domain" = polygonparadise.com; "reply domain" = mail.polygonparadise.com (or whatever
the design picks). "UNVERIFIED" marks facts about Mailgun that this map did not check and the research must confirm.

---

## 0. The short version

### 0.1 "The sending domain" is seven things today

Today one domain (Setting `mailgun.domain`, one active `SendingDomain` row) plays every role below. The new shape
splits them between two Mailgun domains:

| Role today (all = `mailgun.domain`) | Where in code | New shape |
|---|---|---|
| R1 Mailgun API domain of `POST /v3/{d}/messages` | `mailgun-transport.ts:216-232`, `test-send.ts:297,436` | From domain |
| R2 From address domain (`<local>@<d>` per person) | `sender-addresses.ts:127`, `addresses.ts:60-85` | From domain, ONE shared address `contact@` |
| R3 Message-ID domain (`pp.<hex>@<d>`) | `addresses.ts:74,88`, `test-send.ts:90-98` | should stay the From domain (see §A7) |
| R4 Domain of each person's address = the reply route address | `SenderAddress`, `core/mailgun/routes.ts:49-56` | reply domain (becomes the Reply-To) |
| R5 Receiving domain (MX → Mailgun, catch-all, dmarc@, stored replies, `stored` Logs) | `services/mailgun/routes.ts:270-368`, `catch-up.ts:445-495` | reply domain only |
| R6 Domain whose Mailgun settings are applied/checked (tracking, unsubscribe, https cert, webhooks, spam, retention, queues) | `apply-settings.ts:258-437`, `domain-check.ts:86-268` | sending settings → From domain; receiving settings (spam filter, retention, reply routes, MX) → reply domain |
| R7 The key of per-domain state (checklist, reply test, warm-up, go-live, catch-up cursors, restore walk, suppression lists) | §B below | mostly From domain; catch-up `stored` walk and route checks need the reply domain too |

### 0.2 What would happen if the Owner simply typed polygonparadise.com today

1. `validateSendingDomain` refuses it: "Use a separate sending domain, not polygonparadise.com itself."
   (`src/core/sender-address.ts:97,102,122`; called by `connect.ts:81,182`).
2. If that check were just deleted: everyone's address would become `<name>@polygonparadise.com` (per person, not
   `contact@`), and `contact` itself is refused as a name (`sender-address.ts:38`).
3. The MX row checks the From domain (`core/dns/checklist.ts:541-596`) and would be red forever (Zoho MX), and "mx" is
   in the Live gate (`core/sending/mode-gates.ts:68`) and the go-live rows (`mode-gates.ts:81`): Live and go-live
   blocked.
4. Routes would be created for `…@polygonparadise.com` (catch-all `^.*@polygonparadise\.com$`, `dmarc@`), which never
   fire (mail goes to Zoho), yet `/routes/match` would report them "ok" (`services/mailgun/routes.ts:333-368`): the
   checklist would say replies work when they don't.
5. A reply inbox `contact@polygonparadise.com` is refused as a loop ("Your reply inbox can't be on the sending domain")
   (`users.ts:666-698`, `core/mailgun/routes.ts:116-138`, `services/mailgun/routes.ts:201-204,272-278`), and so is
   every test mailbox on polygonparadise.com (`core/reply-test.ts:346-350`).
6. Nothing ever sets `h:Reply-To` (`OutgoingMessage.replyTo` "never set", `transport.ts:38-39`; `loop.ts:780-796`),
   so replies would go straight to Zoho and the app would never see them: no stop, no "Replied", follow-ups go on.

### 0.3 The biggest items (design must decide these first)

1. **Two Mailgun domains, one context.** `getMailgunContext()` knows one domain, one region, one `domainId`
   (`src/server/mailgun/context.ts:15-25,66-108`). Everything that talks to Mailgun hangs off it. The design needs a
   "reply domain" (and possibly its own region) in the context, settings and `SendingDomain` model.
2. **Reply-To must be stored per email.** Follow-ups, the reconciler, the restore scan and replies all work from the
   `OutboundEmail` row; today it has only `fromAddress` (the full From line). A Reply-To snapshot (Campaign +
   OutboundEmail, maybe TestSend) is a schema change (`prisma/schema.prisma:511-546,632-682`).
3. **Everything keyed by "the From address" must be re-keyed by the reply address**: the live-send route hold
   (`gates.ts:239,761,990`), the test-send/reply-test "from" lookup (`test-send.ts:255-260,357,367`), the reply-test
   "reply reached the Owner's address" fact (`reply-test.ts:432-437`), the fake's and the test helpers' "reply goes
   to the From address" (`tests/fake-mailgun/inbound-presets.ts:59-62`, `tests/integration/helpers/replies.ts:85-97`),
   simulated replies (`mail-events/simulate.ts:250-270`).
4. **The loop rule must be about the reply domain, not "every sending domain".** `isSafeForwardAddress` /
   `sendingDomainOf` (`core/mailgun/routes.ts:116-138`) refuse any inbox on or under any `SendingDomain` row. If the
   From domain becomes a row, `contact@polygonparadise.com` (the owner's intended reply inbox) is refused. Only
   domains whose MX is Mailgun can loop.
5. **Checklist rows need a domain each.** MX, spam filter, retention, reply routes, the catch-all probe belong to the
   reply domain; SPF/DKIM/tracking CNAME/https/DMARC/tracking/unsubscribe/webhooks/queues belong to the From domain
   (the reply domain also needs its own SPF/DKIM only if it sends forwards, which it does: UNVERIFIED whether Mailgun
   requires them for forward()).
6. **Replies that ignore Reply-To land only in Zoho.** Nothing in the app can see them (no code path). The design needs
   a decision (accept the risk, or a Zoho forward to a store-only Mailgun address with no forward back, see §G risk
   notes), because follow-ups keep going to people who replied that way.
7. **Region.** One Setting `mailgun.region` (`settings.ts:76`). polygonparadise.com is in US (owner's screenshots); the
   reply domain may have been added in EU. Routes, stored-message URLs and the webhook signing key are fetched through
   the region's API host (`client.ts:1098-1107,1157-1239,1247-1259`). Easiest: both domains in the same region (US),
   i.e. delete and re-add an EU reply domain in US. Whether routes and the signing key are per region: UNVERIFIED.

---

## 1. Data: settings, secrets, state, tables

### 1.1 Setting keys (`src/server/settings.ts`)

| Key | Line | Today | Change |
|---|---|---|---|
| `mailgun.domain` | 77 | THE sending domain (all roles R1–R7); read by ~30 places (context, warm-up, gates, launch, go-live, dashboard, reply test) | keep as the From domain (R1, R3, R6-sending, R7) so warm-up/go-live/dashboard keep working; add a reply-domain key |
| `mailgun.region` | 76 | one region for the account's API host (default EU) | From domain's region; add a reply-domain region only if the design allows two regions |
| (new) reply domain | — | — | e.g. `mailgun.replyDomain` (+ `mailgun.replyRegion`?) |
| (new) shared From address | — | — | e.g. the From local part (`contact`) or full address; validated to sit on the From domain; must NOT go through `validateLocalPart` (it reserves `contact`, `sender-address.ts:38`) |
| `mailgun.unsubscribeTest` | 81 | `{setup "A"/"B"/"C", status, domain, …}`; a pass counts only for `domain === mailgun.domain` (`reply-test.ts:282`, `launch.ts:141`, `go-live.ts:180-181`) | the shape is literally "Setup C" (reply subdomain). `setup` "C" exists in the type (`core/setting-types.ts:25`) but is refused by `replyTestBlockers` (`mode-gates.ts:35,217`) and by `isLiveReady` (`gates.ts:671-674`, needs "A") and `liveLaunchBlockers`/`goLiveBlockers` (`mode-gates.ts:187,268`). Decide: keep "A" (unsubscribe handling on the From domain) and treat Reply-To as always on, or make "C" the live setup |
| `mailgun.domainRegisteredOn` | 83 | purchase date of the sending domain (Domain age row) | the From domain (polygonparadise.com is old: the row turns ok) |
| `mailgun.messageRetentionDays` | 79 | message_ttl applied to `mailgun.domain` | applies to where replies are stored: the reply domain (UNVERIFIED which domain's `message_ttl` governs `store()`) |
| `mailgun.logRetentionDays` | 78 | account plan fact | unchanged |
| `sending.goLiveDomain` | 24 | domain go-live was switched on for; G8 compares with `mailgun.domain` | stays the From domain |
| `sending.goLive` | 20 | `false` written only by a sending-domain change (`connect.ts:283-294`) | decide whether changing the REPLY domain ends go-live (probably not; it doesn't change the sending reputation) |
| `sending.testList` | 25 | validated "not on (or under) a sending domain" (`core/reply-test.ts:335-364`, `reply-test.ts:610-621`) | refuse only reply-domain addresses (and probably the shared From address itself); allow other polygonparadise.com mailboxes |
| `footer.*`, `portfolioUrl` | 64-67 | unchanged | — |

### 1.2 Secrets (`src/server/secrets.ts`, used in `connect.ts`, `context.ts`)

| Key | Today | Change |
|---|---|---|
| `mailgun.apiKey` | account key, one region host (`context.ts:71-81`) | unchanged (account-level); used on both domains' region hosts |
| `mailgun.sendingKey` | domain sending key, only for `POST /messages` of `mailgun.domain`; dropped on a domain change (`connect.ts:296-301`; `mailgun-transport.ts:229-230`) | the From domain's key; must not be dropped when only the reply domain changes |
| `mailgun.webhookSigningKey` | fetched from the connect region (`connect.ts:233-246`, `apply-settings.ts:455-470`) | if the two domains are in different regions: UNVERIFIED whether the signing key is the same; inbound POSTs come from the reply domain's region |

### 1.3 SystemState keys (`src/core/system-state.ts:9-28`)

| Key | Shape assumption | Change |
|---|---|---|
| `domain.check` (`DomainCheckState`, 362-369) | ONE `domain`, `region`, one row list | rows for two domains (either two states, or one state with a domain per row); every reader filters `check.domain === mailgun.domain` (`reply-test.ts:204`, `launch.ts:127-129`, `gates.ts:735-737`, `dashboard/load.ts:278-284`, `go-live.ts:185-186`) |
| `mailgun.setup` (`MailgunSetupState`, 309-315) | one run, one certificate host `email.<domain>`; `setupFitsDomain`/`certificateHostFits` (`apply-settings.ts:100-113`) | the certificate belongs to the From domain (email.polygonparadise.com, already verified); the steps list gains reply-domain steps |
| `warmup` (`WarmupState.domain`, 99-115) | ramp belongs to `mailgun.domain` | stays the From domain (the sending reputation) |
| `mailgun.catchUp` (`CatchUpSummary.domains`, `oldDomains`, 163-193) | active domain completes → `lastSuccessAt`; inactive ones are "old" and never block | the reply domain's `stored` walk must count toward `lastSuccessAt` (see §F), not be an "old domain" |
| `restore` (`domainsBefore`, 245-254) | the sending domains of the replaced DB | only accepted sends matter: From domain(s); reply domain harmless |
| `mailgun.logsForm` | message_id filter form proven on the sending domain | unchanged |
| `webhooks.stats` | counted rejections "its domain is ours" | the reply domain must count as ours (`webhook.ts:158-163,280`) |
| `sending.pacer` (`routeWaitSince`, reason `reply-route`, 126,157) | LIVE held while the From address's route isn't ok | re-keyed to the reply address (§A5) |

SyncCursor keys (table `SyncCursor`, `schema.prisma:887-891`): `${domain}:logs` (`catch-up.ts:309`), `${domain}:stored`
(`catch-up.ts:446`), `${domain}:suppressions` (`mailgun/suppressions.ts:141`). Per domain name, so they already work
for two domains once both are walked.

### 1.4 Tables and columns (`prisma/schema.prisma`)

| Model / column | Line | Today | Change |
|---|---|---|---|
| `User.senderDisplayName` | 170 | the display name ("Ali from Polygon Paradise", `users.ts:55-59`) | unchanged: exactly the per-person name the shape wants |
| `User.replyInbox` | 171 | the inbox routes forward to; never on a sending domain | may now be `contact@polygonparadise.com` (the From address itself) |
| `SendingDomain` (name, region, active, lastLiveSendAt, catchAllRouteId, dmarcRouteId) | 195-207 | one active row = the sending domain; others inactive "old domains" (`connect.ts:304-309`); catch-all/dmarc route ids per row | needs a role (from / reply), or a second table/setting; `active` today means "the one current domain" and `connect.ts:309` deactivates every other row, which would deactivate the reply domain; catch-all/dmarc ids belong only on reply-domain rows |
| `SenderAddress` (userId, domainId, localPart, address @unique, mailgunRouteId, routeStatus, forwardTo, routeCheckedAt, routeError, retiredAt; @@unique([domainId, localPart])) | 209-229 | the person's From AND reply address on the sending domain | becomes the person's Reply-To on the reply domain (route per row stays as is); no longer the From |
| `Campaign.fromName` / `fromAddress` / `sendingDomainId` | 518-520 | snapshot at launch: display name, the person's bare address, the address's domain row (`launch.ts:559-561,848-850`) | `fromAddress` = shared From; add a reply-address snapshot (e.g. `replyTo`); `sendingDomainId` must stay the From domain (it feeds `loadLiveTest`, `reply-test.ts:129`), not the SenderAddress's domain |
| `OutboundEmail.fromAddress` | 645 | the full From line; its domain is used as the Mailgun domain (`mailgun-transport.ts:216-222`), for `lastLiveSendAt` (`loop.ts:929-932`), for the reconciler's domain (`reconcile.ts:379`) | keep = From line (domain = From domain: those three stay right); add `replyTo` column, copied to follow-up rows (`mark-sent.ts:175`) and to restored rows (`restore.ts:525`) |
| `OutboundEmail.messageId` | 649 | `pp.<hex>@<sending domain>`; next rows reuse the previous row's domain (`mark-sent.ts:179`) | keep the From domain (§A7) |
| `TestSend.messageId` / `to` / `purpose` | 684-701 | `pp.t.…@<domain>`, the reply test is recognised by `messageId endsWith @domain` (`reply-test.ts:417`) | keep the From domain; maybe store the Reply-To used |
| `InboundMessage.toAddress` / `senderAddressId` | 759-760 | the route's recipient; `senderAddressId` when it equals a SenderAddress (`inbound-store.ts:112`) | unchanged in shape: the recipient is now the reply address, which still is a SenderAddress |
| `MailEvent.raw.domain` | 735 | used by `apply.ts:194` (push marker only for the active domain) | From domain events; forward events of the reply domain aren't watched (§F) |
| `Suppression.pushedToMailgunAt` | 456 | pushed to the active domain's unsubscribes | From domain (sending lists) |

Activity/notification types that talk about the address: `user.senderAddress` (`activity.ts`, `notifications.ts:41`),
`mailgun.domainChanged` / `mailgun.connected` (`connect.ts:339-361`, `activity.ts:58`), `system.replyRoute`
(`services/mailgun/routes.ts:421-426`, `loop.ts:1003-1005`), `replyTest.decided` (`reply-test.ts:566-571`).

The real database (`data/app.db`) is empty and the practice copy has no Mailgun rows, so a schema change needs no data
migration of real rows, only the migration itself and the seeds.

---

## 2. Code map by area

### A. Sender identity, validation, profile

| Where | Today | Change | Risk |
|---|---|---|---|
| `src/core/sender-address.ts:16-40` `RESERVED_LOCAL_PARTS` (incl. `contact` 38, `info`, `hello`, `dmarc`, `pp-route-check`) | names a person may not take on the sending domain | keep for reply-domain local parts (dmarc@ and the route probe live there); the shared From `contact@` must be validated by a separate rule | if the From address reuses `validateLocalPart` it is refused |
| `sender-address.ts:96-104` `WEBSITE_DOMAINS`, `SENDING_DOMAIN_TEXTS` (website 102, placeholders 100-103 "mail.polygonparadise.com") | the sending domain must not be polygonparadise.com / www | split: a From-domain rule (polygonparadise.com allowed) and a reply-domain rule (must not be the From domain or www; must be a subdomain whose MX goes to Mailgun) | SPEC.md:21,30 and PLAN Q8 (PLAN.md:107-111) state the opposite; update them with the owner's decision |
| `sender-address.ts:111-125` `validateSendingDomain` | one validator, used by `connect.ts:81,182` | two validators (From, reply) | a reply domain equal to the From domain would make MX → Mailgun on the apex: must be refused |
| `sender-address.ts:87-94` `suggestedLocalPart` | first name for the address | unchanged (now the reply local part) | — |
| `src/server/services/sender-addresses.ts:8-13,38-42` texts ("sending address … once the Owner connects the sending domain") | wording | "reply address" wording | label tests (§E) |
| `sender-addresses.ts:58-66` `activeSendingDomain()` | Setting `mailgun.domain` → active row | the reply domain row | every address query below uses it |
| `sender-addresses.ts:80-100` `getSenderAddressInfo` | current address on the active domain | on the reply domain | — |
| `sender-addresses.ts:110-186` `setSenderLocalPart` (127 `address = local@domain`; 134-135 blocked while campaigns run; 152-171 activity + Owner notice "From now on X's campaigns come from <address>"; 182-184 route sync) | the person's From changes | the person's Reply-To changes; the notice text changes ("replies to X's campaigns go to …") | blocking while campaigns run is still right if Campaign/OutboundEmail snapshot the Reply-To |
| `src/server/services/users.ts:55-59` `suggestedSenderName` | "Ali from Polygon Paradise" | unchanged (matches the lead's shape) | — |
| `users.ts:197-211` `queueRouteSync` | only while an active SendingDomain exists | check the reply domain | — |
| `users.ts:666-669` `replyInboxOnSendingDomainText`; `675-698` `checkProfileInput` (685 `sendingDomainOf`) ; `700-703` `sendingDomainNames()` (every row); `713` `updateProfile` | the reply inbox may not be on (or under) any sending domain | pass only the reply domain(s) | if the From domain stays in the list, `contact@polygonparadise.com` is refused (§0.3 item 4) |
| `src/app/(app)/settings/profile/actions.ts:37-48,52-61,66-67` | checks and saves the local part; toast "Your sending address is now …; its reply route is being set up." | reply-address wording | — |
| `src/app/(app)/settings/profile/page.tsx:17-42,66-67` `senderView` | status line "Reply route: working/Being set up…" (label test pins "Reply route: Being set up…", `tests/unit/docs/labels.test.ts:160`) | same, under a "Reply address" field; show the shared From as read-only text | — |
| `src/components/settings/profile-form.tsx:223` hint "People see this address in their inbox. Replies to it are forwarded…"; `229-303` `SendingAddressField` (272 addon `@{domain}`; 243-245, 298 texts); `114-136` display-name field | the per-person address IS the From | the field becomes the Reply-To (`@mail.polygonparadise.com`); the hint must say people see contact@ | UI test `tests/unit/setup-core/ui.test.ts:279-323` |
| `src/components/settings/types.ts:42-61` `ProfileValues.senderLocalPart`, `SenderAddressView.domain` | comments "the active sending domain" | reply domain | — |

### B. Settings › Sending & Mailgun (connection, region, keys, test list)

| Where | Today | Change | Risk |
|---|---|---|---|
| `src/server/services/mailgun/connect.ts:75-126` `testMailgunConnection` | `GET /v4/domains/{d}` in the chosen region; on 401/404 asks the other region (105-125) | test both domains, each in its region | mixed regions double every region-dependent call |
| `connect.ts:172-261` `connectMailgun`: 177-185 validate; 202-207 change detection & refusal while TEST/LIVE campaigns run; 233-246 signing key; 248-252 jobs (check, push, routes) | one domain | connect From + reply (both, or two forms) | refusing while campaigns run: needed for a From change; for a reply-domain change the Reply-To snapshot must decide |
| `connect.ts:270-363` `saveConnection`: 283-294 G8 `sending.goLive = false` (the only writer); 296-301 drops `mailgun.sendingKey`; 302-303 settings; 304-309 upsert row + **deactivate every other row**; 311-333 **moves every current SenderAddress to `<local>@<new domain>`**; 335-338 resets `mailgun.unsubscribeTest`, re-pushes suppressions; 339-361 activity | the sending domain carries the addresses | addresses live on the reply domain: moving them happens on a reply-domain change, not a From change; deactivation must not hit the reply domain row; G8 on a From change only | a From change that "moves addresses" to `@polygonparadise.com` would create routes on the apex |
| `connect.ts:228-231` clears `mailgun.setup` on a domain change | — | per domain | — |
| `src/server/mailgun/context.ts:15-25` `MailgunContext {domain, region, domainId, client, sendClient}`; `66-108` `getMailgunContext` (69 `mailgun.domain`, 75 region, 83-93 repairs the row) | one domain | add the reply domain (name, id, region, client) | every caller (routes, domain check, apply, catch-up, test sends, reply test, suppressions) |
| `context.ts:111-119` `domainsToSync` (active, or inactive with `lastLiveSendAt` < 60 days) | the reply domain never "sends live" (`lastLiveSendAt` is set from the From domain, `loop.ts:929-932`) | always include the reply domain (for `stored` replies) | reply recovery after the PC was off silently stops |
| `context.ts:122-124` `clientFor` | account client for another region | reply-domain client | — |
| `context.ts:142-155` `loadSendGuard` (`ownInbox`) | own reply inbox for "Send me a test" | unchanged | if own inbox = contact@ = From: a mail "from yourself to yourself" (see §C risk) |
| `src/app/(app)/settings/sending/actions.ts:49-54` `connectSchema` (region, domain, keys); `56-78` action; `139` test list action | one domain field | two domains (and maybe two regions), the From address | — |
| `src/components/settings/sending/connection-form.tsx:139` region hint; `144-156` "Sending domain … for example mail.polygonparadise.com"; `185` "It works for one domain only, so changing the sending domain removes it." | one domain | From domain + reply domain fields; the example becomes polygonparadise.com / mail.polygonparadise.com | — |
| `src/app/(app)/settings/sending/load.ts:302-308` status "Connected to <d> (<region>)…"; `339-343` test-list warnings (`sendingDomains: []`) | one domain | name both | — |
| `src/components/settings/types.ts:77-89` `ConnectionView` | one domain/region | two | — |
| `src/components/settings/sending/texts.ts:36,45` "Real emails from your sending domain…" | wording | fine as is, or "from contact@…" | — |
| `src/core/reply-test.ts:335-364` `validateTestList` (346-350 "is on your sending domain") ; `src/server/services/reply-test.ts:610-621` `saveTestList` (every SendingDomain row + `mailgun.domain`) | no test mailbox on (or under) a sending domain | only the reply domain (and the shared From address) | pinned by `tests/unit/setup-core/reply-test.test.ts:360`, `tests/integration/mailgun-setup/actions.test.ts:182`, `reply-test.test.ts:263-275` |

### C. Transport, From header, Reply-To, Message-ID, threading

| Where | Today | Change | Risk |
|---|---|---|---|
| `src/server/services/sending/addresses.ts:1-12,23-24` placeholders `your-sending-domain`, `dry-run.invalid` | dry run without an address: `<login local part>@your-sending-domain` | dry run: `contact@<from domain or placeholder>` + a placeholder Reply-To | `tests/unit/sending/addresses.test.ts:17-68` (48: `sara@your-sending-domain`), `tests/integration/campaigns/seed.ts:208` |
| `addresses.ts:30-35` `formatFromHeader(name, address)` | `Name <address>` with quoting | unchanged (name = the person's display name, address = contact@) | — |
| `addresses.ts:43-85` `senderSnapshot` → `fromName`, `fromAddress` (the person's address), `fromHeader`, `sendingDomainId` (the address's domain row), `messageIdDomain` (the address's domain) | From = the person's address | From = shared address; add `replyTo` = the person's SenderAddress; `sendingDomainId` and `messageIdDomain` = the From domain (not the SenderAddress's domain) | if `messageIdDomain` follows a SenderAddress moved to the reply domain, the reconciler control, the catch-up duplicate watch and the reply test's TestSend filter break (§A7 below) |
| `addresses.ts:88-101` `newMessageId`, `messageIdDomainOf` | `pp.<24 hex>@<domain>` | keep | — |
| `src/server/services/campaigns/launch.ts:103,147-156` `launchModeProblems` (`no-sender-address`, `no-reply-route` "Replies to X can't reach X yet") | a sender needs an address; LIVE needs its route ok | same checks, on the Reply-To | — |
| `launch.ts:330-335,381` sender's `senderAddresses where retiredAt null, domain.active` | active = the sending domain | the reply domain row | if the reply row isn't "active", nobody has an address |
| `launch.ts:465-469` snapshot; `517-518` ChunkContext `fromHeader`, `messageIdDomain`; `772` `fromAddress: ctx.fromHeader`; `795` `messageId: newMessageId(ctx.messageIdDomain)`; `848-850` Campaign `fromName`, `fromAddress`, `sendingDomainId` | From per person | add Reply-To to the chunk rows and the Campaign | schema change |
| `src/server/services/sending/mark-sent.ts:149-188` `createNextStepRow` (175 `fromAddress: prev.fromAddress`, 179 `newMessageId(messageIdDomainOf(prev.messageId))`) | follow-ups copy the From line and the id domain | also copy `replyTo` | a follow-up without Reply-To sends replies to Zoho only |
| `src/server/services/sending/transport.ts:19-46` `OutgoingMessage` (23-24 From, 38-39 `replyTo` "Setup C only; never set in Milestone 3") | field exists, unused | always set for TEST/LIVE | — |
| `src/server/services/sending/loop.ts:196-222` `loadClaimed` (212 `fromAddress`); `780-796` builds `OutgoingMessage` without `replyTo` | no Reply-To | select and pass `replyTo` | — |
| `loop.ts:929-932` `lastLiveSendAt` from the From line's domain | From domain = sending domain | still right (From domain) | — |
| `loop.ts:997-1010` notice "Live emails are waiting: a reply route isn't working" | route of the From address | route of the Reply-To | — |
| `src/server/services/sending/mailgun-transport.ts:33-44` `fromAddressOf`, `domainOfAddress`; `57-79` `buildSendInput` (71 passes `replyTo`); `104-108` NOT_ON_DOMAIN pause "The sender's address isn't on a connected sending domain"; `215-237` `send` (216-222 Mailgun domain = From line's domain looked up in `SendingDomain`; 230 sending key only when `domain === ctx.domain`) | Mailgun domain derived from the From address | still works if the From domain has a `SendingDomain` row; add a guard that a TEST/LIVE campaign email carries a Reply-To on the reply domain (fail closed) | without that guard a missing Reply-To silently loses replies; `tests/unit/sending/mailgun-transport.test.ts:48-52,67` |
| `src/server/mailgun/types.ts:20-48` `SendMessageInput` (21-22 From comment, 33-34 `replyTo` "Setup C only") | — | comment/doc | — |
| `src/server/mailgun/client.ts:563-636` `sendMessage` (577 `from`, 592 `h:Reply-To` when set) | supports Reply-To already | none | `tests/integration/mailgun-client/client.test.ts:98` (no Reply-To by default), `104-113` (Reply-To when asked) |
| `src/server/mailgun/send-guard.ts:48-64` `checkSendGuard` | checks only `to` | optionally: a campaign email must have a Reply-To on the reply domain | — |
| `src/server/services/test-send.ts:34` doc "from the Owner's sending address"; `89-98` `newTestMessageId`, `replyTestMessageId` (`@<domain>`); `252-260` "Send me a test" finds the sender's SenderAddress on `ctx.domainId`; `269` id on `ctx.domain`; `297-309` `sendMessage(ctx.domain, {from: formatFromHeader(name, from.address)})` without Reply-To; `357,366-367` reply test From = Owner's address; `376` ids; `436-448` send without Reply-To | From = the person's address | From = shared, Reply-To = the sender's (Owner's) reply address; the address lookup on the reply domain | the reply test then really tests Setup C; `tests/integration/test-send/test-send.test.ts:131-140,252,259` pin `Ali from Polygon Paradise <ali@${D}>` and the ids |
| `src/server/services/sending/reconcile.ts:208-257` positive control (225, 243 `messageId endsWith @${s.domain}`), `366-382` domain from `fromAddressOf(row.fromAddress)` | the id domain = the From domain = the Logs domain | keep Message-IDs on the From domain | if ids move to the reply domain, the control never finds a row and UNKNOWN rows become "Not sure it was sent" |
| `src/server/services/sending/restore.ts:500-539` creates a missing row with `fromAddress: formatFromHeader(campaign.fromName, campaign.fromAddress)` (525) | From from the Campaign snapshot | also the Reply-To snapshot | follow-ups of a restored row without Reply-To |
| `src/core/sending/follow-up.ts` `threadHeaders`, `sentIdsOf` (CONVENTIONS "M4") | threading by Message-IDs | unchanged (Reply-To doesn't affect In-Reply-To/References) | — |
| `src/server/services/mail-events/simulate.ts:250-270` simulated reply `To: email.fromAddress`, `recipient` = From address | replies go to the From | use the Reply-To | with a shared From, a simulated reply is stored with `toAddress = contact@…` and no SenderAddress (audience still by senderId, `effects.ts:207-210`) |

**A7. Which domain for Message-IDs.** Three readers assume "our Message-ID ends with the domain whose Logs we read":
the reconciler's control (`reconcile.ts:225,243`), the catch-up duplicate watch (`catch-up.ts:215-220`, `isOwnSend`,
with a `send_id` fallback), and the reply test's TestSend filter (`reply-test.ts:417`). So Message-IDs must stay on the
From domain (the domain Mailgun sends and logs for). `senderSnapshot` must stop taking it from the SenderAddress.

### D. Routes (Apply recommended settings › routes) and the loop rule

| Where | Today | Change | Risk |
|---|---|---|---|
| `src/core/mailgun/routes.ts:49-56` `senderRouteSpec` (`^<address>$` → forward, store+notify, stop) | per SenderAddress | unchanged, on the reply address | — |
| `routes.ts:63-71` `catchAllRouteSpec`, `74-82` `dmarcRouteSpec` | per sending domain | reply domain only | on the apex they never fire (Zoho MX) but look "ok" |
| `routes.ts:116-126` `isSafeForwardAddress(email, sendingDomains)`; `129-138` `sendingDomainOf` | refuse an inbox on or under any sending domain | pass only domains whose MX is Mailgun (reply domain(s)) | `contact@polygonparadise.com` must pass; `…@mail.polygonparadise.com` must still fail. Pinned by `tests/unit/setup-core/routes.test.ts:78-94` |
| `routes.ts:169-172` `routeCheckAddress(domain, …)` | probe on the sending domain | reply domain | — |
| `src/server/services/mailgun/routes.ts:60-63` `routeLoopText` "its reply inbox is on the sending domain" | wording | "on the reply domain" | pinned by `tests/integration/mailgun-setup/routes.test.ts:236-242` |
| `services/mailgun/routes.ts:126-150` needs the context and a public address | one context | reply-domain client (its region) | routes are fetched/created on the From region's host (`ctx.client.listRoutes()` 181) |
| `:153-157` `domainNames` = every SendingDomain | the loop list | reply domains only | see above |
| `:163` Owner inbox (catch-all, dmarc@, switched-off users) | — | unchanged | — |
| `:176` `current` = rows on `ctx.domainId` | addresses of the sending domain | reply domain id | — |
| `:195-209` plans: forward to the user's inbox (Owner's for switched-off users), refuse loops (201-204) | — | loop list = reply domains | — |
| `:211-221` `suppressionListsFor(inboxes, ctx)` | Mailgun's lists of `ctx.domain` | the lists that block `forward()` (the reply domain's?: UNVERIFIED) | a wrong domain here shows "ok" while Mailgun silently won't forward |
| `:270-323` catch-all and dmarc@ for **every** SendingDomain (only the active one gets new routes, 293-298); `272-281` "The catch-all route can't forward to your reply inbox (…): it's on the sending domain" | per sending domain | reply domains only; the From domain gets none | an apex catch-all row would be created on connect |
| `:324-330` deletes the app's catch-all/dmarc routes of unknown domains | — | unchanged | — |
| `:333-368` `/routes/match` per current address, probe `routeCheckAddress(ctx.domain)`, `dmarc@${ctx.domain}` | sending domain | reply domain | a match on the apex is meaningless |
| `:370-411` writes `SendingDomain.catchAllRouteId/dmarcRouteId`, `SenderAddress.routeStatus/forwardTo/…` | — | on reply-domain rows | — |
| `:419-427` notice "Mailgun won't forward replies to <inbox>" | — | unchanged | — |
| `src/app/(app)/settings/domain/load.ts:77-112` senders on `mailgun.domain`'s row; `93,100` `isSafeForwardAddress(forwardTo, all domain names)` for the manual-fallback values | sending domain | reply domain | — |

### E. Apply recommended settings, Domain checklist, mode gates, go-live

**Apply** (`src/server/services/mailgun/apply-settings.ts`, one domain `d = ctx.domain`, 280):

| Step | Lines | Domain today | Domain in the new shape |
|---|---|---|---|
| public address | 283-297 | — | — |
| `getDomain(d)` | 299-317 | sending | both (each step needs its own domain's info) |
| tracking open/click off, unsubscribe on (Setup A) / off (B) | 319-373 | sending | From domain (the sent mail); the reply domain: all tracking off ("Setup C": PLAN.md:989) |
| spam filter `spam_action tag` | 376-381 | sending | reply domain (inbound replies); UNVERIFIED whether it matters on the From domain |
| retention `message_ttl` | 382-389 | sending | reply domain (stored replies); UNVERIFIED |
| PII redaction off | 390-397 | sending | From domain (events) and reply domain (inbound) |
| certificate `email.<d>` + web_scheme https | 399-416, 474-526, poll 534-620 | sending | From domain (email.polygonparadise.com is verified per the owner's screenshots) |
| signing key | 419, 455-470 | account | account (region caveat §1.2) |
| webhooks (5 event types) | 424, `webhooks-setup.ts:48-103` | sending | From domain; optionally also the reply domain to see failed forwards (§F) |
| routes | 426-433 | sending (+ every domain's catch-all) | reply domain |
| activity "applied … to <domain>" | 440-451 | — | name both |

**Domain check** (`src/server/services/checks/domain-check.ts`, `d = ctx.domain`, 110): 113-130 `getDomain`/verify (404
pauses sending "Mailgun can't find d", 127-129); 133-135 DNS facts; 136-138 certificate `webPrefix.d`; 139 tracking;
141-142 webhooks; 145-158 signing key; 160-183 sender routes on `ctx.domainId` + `suppressionListsFor`; 184 catch-all
id; 186 sending queues; 187 monthly limit; 207-248 facts; 256 state `{domain: d}`. Change: run the reply-domain
checks (Mailgun knows it, MX, spam filter, retention, routes, catch-all; maybe SPF/DKIM) against the reply domain; a
404 on the reply domain must not pause sending (but must block live: replies wouldn't arrive).

**Checklist rows** (`src/core/dns/checklist.ts`, one `f.domain`; `buildChecklistRows` 1095-1119; titles 209-252;
`zoneOf` 273-275 gives `polygonparadise.com` for both, so DNS-panel names stay relative, good):

| Row (key) | Lines | Checks today | Should check | Note |
|---|---|---|---|---|
| Mailgun knows your domain (`mailgun-domain`) | 331-384 | sending domain, region | both domains | "wrong region" text per domain |
| SPF (`spf`) | 386-445 | TXT at d, include from Mailgun's record, merge, lookups ≤ 10 | From domain (apex SPF must merge Zoho's include and Mailgun's; the merge advice already exists 400-412, 429-431); reply domain only if forwards need it (UNVERIFIED) | apex SPF edits touch the owner's Zoho mail |
| DKIM (`dkim`) | 447-539 | Mailgun's `_domainkey` records of d | From domain (selector `mx._domainkey.polygonparadise.com`, verified) | Zoho's own DKIM selector is untouched |
| MX (`mx`) | 541-596 | d's MX = Mailgun's receiving records; "Replies to d go to Mailgun" | **reply domain only**; the From domain's MX must stay Zoho (never suggest Mailgun MX for the apex) | today the row would tell the owner to point the apex MX at Mailgun (578-581): dangerous |
| tracking CNAME (`tracking-cname`) | 598-624 | `email.d` → mailgun.org | From domain (verified) | — |
| HTTPS links (`https-links`) | 626-661 | certificate of `webPrefix.d` | From domain | "Foundation and higher" plan text (633) |
| DMARC (`dmarc`) | 663-717 | `_dmarc.d` (walks to the org domain); fix "Use dmarc@${d}" (707) | From domain (the apex record governs the owner's Zoho mail too; p=none only monitors); the rua suggestion should be `dmarc@<reply domain>` (routed) or a Zoho mailbox | a `dmarc@polygonparadise.com` rua goes to Zoho, not the app's route |
| tracking off, unsubscribe on (`tracking-off`, `unsubscribe`) | 719-750 | d's tracking | From domain; reply domain: all off | — |
| spam filter, retention (`spam-filter`, `retention`) | 752-779 | d | reply domain (UNVERIFIED) | — |
| signing key (`signing-key`) | 781-803 | account | account | region caveat |
| webhooks (`webhooks`) | 805-828 | d | From domain | — |
| reply routes (`reply-routes`) | 842-902 | SenderAddresses on d + catch-all id | reply domain | text "Nobody has a sending address yet" (848-850, and `components/settings/domain/checklist.tsx:76`) |
| Mailgun lets you send (`sending-allowed`) | 904-919 | d's queue | From domain | — |
| monthly limit | 921-940 | account | account | — |
| remote access | 948-1043 | public address | unchanged | — |
| reply test (`reply-test`) | 1045-1062 | pass on d; failed fix "a separate reply address such as ali@reply.<domain>… needs a small change to the app and your OK" (1058) | From domain; the fix text is now the chosen shape | — |
| postmaster (`postmaster`) | 1064-1077 | TXT at d | From domain (polygonparadise.com may already have Google verification) | — |
| domain age (`domain-age`) | 1079-1089 | purchase date of d | From domain | — |

Also `src/server/services/checks/dns-facts.ts:70-101` (`gatherDnsFacts(d)`: TXT, DKIM, MX, tracking, DMARC for one
domain) and `dmarc-walk.ts`, `spf-count.ts`, `dns-lookup.ts` (`mailgunRecordsLookup` in fake mode) — call once per
domain with the rows each needs.

**Mode gates and go-live** (`src/core/sending/mode-gates.ts`):
- `:19` "Mailgun hasn't confirmed your DNS records yet"; `:67-74` `LIVE_ROW_GATES` (`mailgun-domain, spf, dkim, mx,
  tracking-cname` → dns; tracking; unsubscribe; webhooks; signing key; sending allowed). The `mx` gate must mean the
  reply domain's MX. Pinned by `tests/unit/sending-core/mode-gates.test.ts:49`, `tests/integration/sending-m3/launch-control.test.ts:106`.
- `:77-94` `GO_LIVE_ROW_KEYS` (includes `mx`, `spam-filter`, `retention`, `reply-routes`), `:97-118`
  `CHECKLIST_ROW_TITLES`: the Going-live guide step 2 lists these titles in order (label test
  `tests/unit/docs/labels.test.ts:82-86`). New reply-domain rows change that list and the guide.
- `:35` `setupForReplyTest` "Setup C isn't built yet…", `:198-219` `replyTestBlockers` (217), `:170-191`
  `liveLaunchBlockers` (187 Setup A), `:240-279` `goLiveBlockers` (268 Setup A, 271-274 senders without a working
  route), `:48` `domainAge` "Your sending domain is less than 30 days old". Tests: `mode-gates.test.ts:113,160,276`.
- `src/server/services/sending/gates.ts:671-674` `isLiveReady` (Setup A + tracking/unsubscribe rows), `:719,735-737`
  checklist rows only of `mailgun.domain`, `:733,761` `routeOk` map keyed by `SenderAddress.address`, `:239` candidate
  `fromAddress = Campaign.fromAddress`, **`:990` LIVE held unless `routeOk.get(c.fromAddress)`**: with a shared From
  this holds every LIVE email for ever ("reply-route"). Key by the campaign's Reply-To. Tests:
  `tests/unit/sending/gates.test.ts:47,94,250-252`, `tests/integration/sending-m3/gates.test.ts:269`.
- `src/server/services/reply-test.ts:173-304` `loadGateInputs`: 190 domain; 204 rows of this domain; 225-243
  `ownerAddress` and `sendersWithoutRoute` from SenderAddresses of `mailgun.domain`'s row (→ reply domain row);
  282 `replyTestPassedOnDomain`; 293 `loadLiveTest(domainRow.id)` (126-152: `campaign.sendingDomainId` = the From
  domain row, so the snapshot must keep the From domain id); 346,360 `OWNER_ADDRESS_MISSING_TEXT`.
- `reply-test.ts:406-483` `loadReplyTest`: 417 TestSend `messageId endsWith @domain`; **432-437 a reply counts only
  when `toAddress = ownerAddress`** (the Owner's SenderAddress: with Reply-To on the reply domain, that address is the
  Owner's reply address, so this stays right if `ownerAddress` = the reply address); 453-462 unsubscribe seen.
- `reply-test.ts:553-573` `decideReplyTest` stores `domain`; `579-602` `switchUnsubscribeSetup` (A/B only).
- `src/server/services/go-live.ts:113-135` view (`domain`, `endedOnDomain`), `172-188` `sameInputs` (domain, reply
  test domain, check domain), `205-268` `goLive` (213-214, 233 `sending.goLiveDomain`). Stays on the From domain.
- G8: only `connect.ts:283-294` ends go-live (a From-domain change). Tests: `tests/integration/go-live/domain-change.test.ts:61-150`.

**Domain checklist page and Apply UI**: `src/app/(app)/settings/domain/load.ts:56-173` (65 header "Domain checklist for
<d> (<region>)", 67-69 setup fits domain, 77-112 senders, 114-172 reply test); `actions.ts:183-207` domain age;
`src/components/settings/domain/checklist.tsx:20` ("Whether Mailgun has your sending domain."), `:76`;
`src/components/settings/domain/reply-test-section.tsx:300` ("…from {ownerAddress ?? "your sending address"}");
`src/components/settings/types.ts:133-177` (`SenderRouteView`, `ReplyTestView.setup "A"|"B"|"C"`).

### F. Events, catch-up, suppressions, restore, webhooks

| Where | Today | Change | Risk |
|---|---|---|---|
| `src/server/services/mailgun/catch-up.ts:163-199` `checkAccount` (queue + tracking drift, active domain) | sending domain | From domain | — |
| `catch-up.ts:215-220` `isOwnSend` (`pp.…@<logs domain>` or `send_id`) | id domain = logs domain | keep ids on the From domain (§A7) | — |
| `catch-up.ts:308-367` `walkEventLogs` (cursor `${domain}:logs`, filter `domain = d`) | per domain | From domain; the reply domain's events are only forwards (`is-routed`) | forward failures (Zoho refusing) are invisible unless walked/webhooked |
| `catch-up.ts:403-438` `fetchStoredReply` (candidate `/v3/domains/${r.domain}/messages/…`, 410) ; `445-495` `walkStoredReplies` (cursor `${domain}:stored`, filter `domain = d`, events `stored`) | stored replies of the sending domain | **the reply domain** (that is where `store()` runs) | must run every hour and count for `lastSuccessAt`: the follow-up catch-up gate relies on it |
| `catch-up.ts:498-522` `catchUpDomain` (pull suppressions per domain, push only for the active one) | — | pull/push on the From domain; the reply domain: stored walk (+ maybe lists) | — |
| `catch-up.ts:676-820` run: `718-719` `domainsToSync` + active; `731-770` an inactive domain's failure is an "old domain" problem, never blocking; `oldDomains` notice 590-672 | the reply domain would be an "old domain" if inactive | treat the reply domain as a second active domain whose failure fails the run | otherwise a broken reply walk never holds follow-ups |
| `src/server/services/mailgun/suppressions.ts:85-160` pull (cursor `${domain}:suppressions`); `168-207` `pushLocalSuppressions` → `ctx.domain` unsubscribes; `316-329` `removableAddresses` (test list + reply inboxes); `337-387` `removeOwnSuppression` deletes from `ctx.domain`'s three lists, then route sync | sending domain | push/pull on the From domain; "Remove it" for a reply inbox must also clear the reply domain's lists (whichever blocks `forward()`, UNVERIFIED) | — |
| `src/server/mailgun/suppression-lookup.ts:19-44` `suppressionListsFor` (`ctx.domain`) | used for forward inboxes (routes, domain check) | reply domain's lists | — |
| `src/server/services/mail-events/apply.ts:187-194,308-314` `pushedToMailgunAt` only for events of the active domain | — | From domain | — |
| `src/server/services/mail-events/webhook.ts:158-163` `isOurDomain`; 220 (event domain), 280 (inbound `f.domain`) | counted rejections for our domains | reply domain must be "ours" | — |
| `src/core/mailgun/events.ts:28-29,148,209` `NormalizedEvent.domain` | sending domain | unchanged | — |
| `src/server/services/sending/restore.ts:681-800` restore scan: `domainsToSync` + `domainsBefore`, accepted events with tag `outreach` per domain (743-764) | sending domains | From domain(s) only matter; the reply domain is harmless (routed forwards carry no `outreach` tag) | — |
| `scripts/restore.mjs:159-189` `readSendingDomains` (Setting + rows active or live < 60 days), `412-414` marker | same | if reply rows live in `SendingDomain`, they are read too (harmless) | `tests/unit/ops/restore-script.test.ts` |
| `src/core/sending/restore-report.ts:51-55` "not through every sending domain" | wording | — | — |
| `src/core/mailgun/catch-up-status.ts:57` `oldDomainLines`; `src/core/dashboard/attention.ts:112` | old domains | the reply domain must not appear as "old" | — |
| `src/server/services/sending/reconcile.ts` | §C | — | — |

Health (`src/server/services/sending/health-check.ts`) counts LIVE sends app-wide, not per domain: no change. Warm-up
(`src/server/services/sending/warmup-days.ts:107-168`, `usage.ts:87-110`) is keyed by `mailgun.domain`: keep it the
From domain. polygonparadise.com is old, but its sending through Mailgun is new, so the ramp still applies.

### G. Inbound replies: which sender a reply belongs to

- Stored by `storeInbound` (`src/server/services/mail-events/inbound-store.ts:84-136`): `toAddress` = the route's
  recipient; `senderAddressId` when it equals a SenderAddress (112). With Reply-To this is the person's reply address:
  no change.
- Linked by thread ids first (`src/server/services/replies/link.ts:99-128`, Message-ID / provider id / TestSend), then
  by bounce ids, named addresses, the sender's address, known contact (8-21). Never by the recipient address. So
  linking is unaffected by a shared From as long as Message-IDs stay ours.
- Assignee and notify set (`src/server/services/replies/effects.ts:177-218`): linked email → its `senderId`; plus the
  owner of the reached address (`senderAddressId`), plus the Owner for the catch-all (`senderAddressId === null`,
  204). Per-person Reply-To keeps this; a single shared reply address would lose "who owns this unlinked message".
- Internal senders (`src/server/services/mail-events/internal-senders.ts:42-80`): users' logins and reply inboxes, every
  SenderAddress, and anything whose domain equals a `SendingDomain` name (72, exact domain). With the From domain as a
  row, mail from any `@polygonparadise.com` is "internal" (team notes/forwards): fine; the reply domain must be a row
  too. Test: `tests/integration/inbound-store/internal-senders.test.ts:32-64`.
- `src/server/services/replies/input.ts:140-158` `ownDomains` (every SendingDomain) and
  `src/core/replies/hints.ts:72-88` (registrable domain too): already treat polygonparadise.com as ours.
- Classification (`src/core/replies/classify.ts`, `kind.ts`) doesn't use the domain.
- Bounce notices and challenge-response mail: human-readable bounces and auto-replies addressed to the **From** go to
  Zoho, never to the app. Where asynchronous DSNs go when the From domain's MX is not Mailgun depends on Mailgun's
  Return-Path for polygonparadise.com: UNVERIFIED, and the bounce events, health pause and suppressions depend on it.
- **Replies that ignore Reply-To** (typed to contact@, some reply-all, some auto-responders): no code path sees them.
  A possible fix (a Zoho rule copying contact@ mail to a store-only Mailgun address) must use a route **without**
  `forward()` back to contact@, or it loops (`senderRouteSpec` always forwards, `core/mailgun/routes.ts:54`).
- Test-list guard (`send-guard.ts:48-64`, launch, final check, `checkSendGuard`): about `to` only. Unchanged.
- Webhook inbound handler `webhook.ts:255-303`: unchanged except `isOurDomain`.

### H. Campaign wizard, campaign pages, labels, dashboard

| Where | Today | Change |
|---|---|---|
| `src/server/services/campaigns/draft.ts:333-381` sender list (`fromLine`, `placeholderAddress`, `address`, `routeOk`), `1286-1300` launch summary's sender address | the person's address is the From | show "Recipients see: Arslan from Polygon Paradise <contact@…>" and "Replies go to arslan@mail…" |
| `src/components/campaign-wizard/sender-step.tsx:110-124` ("Recipients see", "Sending address", "No sending address yet"), `144-168` ("replies go to X's inbox", placeholder note, "Sending addresses, display names and signatures are set in…") | per-person From | reply-address wording (`tests/unit/campaigns/ui.test.ts`) |
| `src/app/(app)/campaigns/[id]/page.tsx:122` "Sent by X as <fromName> <<fromAddress>>" | per-person From | shared From (+ Reply-To) |
| `src/components/campaigns/outbox-email.tsx:55` shows `email.fromAddress` | From line | add Reply-To |
| `src/server/services/campaigns/queries.ts:260-261,332-333,482-483,663,740,840-878` `fromName`/`fromAddress` | display | add Reply-To where shown |
| `src/app/(app)/settings/limits/page.tsx:47` `NO_SENDERS_TEXT` "Nobody has a sending address yet…", `106` addresses on the active domain, `131`; `src/components/settings/limits/sender-caps-form.tsx:19,75,88` "Sending address" column | active domain | reply domain; wording (`tests/playwright/settings.spec.ts:129` pins the empty text) |
| `src/app/(app)/settings/team/switch-off-text.ts:63` "Replies to X's sending address will come to your inbox" | — | "reply address" |
| `src/components/dashboard/get-started.tsx:45` "Add your sending domain and API key…" | — | wording |
| `src/app/(app)/dashboard/load.ts:66-74,171-173,231,278-284,314`; `src/server/services/dashboard/mailgun.ts:14-20` (`mailgunConfigured`: `mailgun.domain` + key); `src/core/dashboard/attention.ts:62-63,98,112-114,163-166,251-252,300-310` (domain change ended go-live) | `mailgun.domain` | stays the From domain; "configured" may also require the reply domain |
| `src/components/settings/types.ts:96-114` `GoLiveCardView.title` "Go live on send2.example.com" | From domain | unchanged |
| top bar / `src/core/sending/label.ts` | no domain | — |

### I. Practice copy, seeds, fake Mailgun, test helpers, Playwright

- **Practice copy** (`scripts/make-demo-data.ts:109-150`: users with `replyInbox = login`, `practice.copy = true`, no
  SendingDomain/SenderAddress): dry runs use the placeholder From (`addresses.ts:77-84`). Change the placeholder to the
  shared-From form; `scripts/lib/demo-dataset.ts` has no domain data.
- **`scripts/seed-m6-manual.ts`**: `DOMAIN = "send.example.com"`, `OLD_DOMAIN = "mail.example.com"` (279-280);
  `replyInboxOf` (412); `connectFakeMailgun` seeds Setting, one active SendingDomain, a SenderAddress per user on it with
  route ok (474-507); checklist rows for `DOMAIN` (465-467); reply test passed on `DOMAIN` (500-504); warm-up domain
  (510-518); catch-up summary domains (528); `lastLiveSendAt` (828, 978, 1103); old domain row (862); manifest
  `sendingDomain` (743, 937, 1013, 1164); address check (1169-1181: everything on example.com / *.example). Needs a
  From domain + reply domain pair (e.g. `example.com`-style From and `mail.<from>` reply, both allowed by 1169-1181),
  a shared From setting and Reply-To columns.
- **`scripts/seed-m5-manual.ts`**: `DOMAIN` 110; settings/rows/addresses 235-252; go-live 262-269.
- **Fake Mailgun** (`tests/fake-mailgun/`, launched by `scripts/fake-mailgun.mjs`, usage line 2 `--domain`):
  - `state.ts:70-103` options: ONE `domain`, `otherDomains` that share the main domain's world (74-78), ONE `region`
    (79-80); `196-241` ONE `FakeDomain` with one tracking/spam/ttl/webhooks/DNS/suppression set; `290-316` DNS records
    only for the main domain.
  - `server.ts:334-349` a domain path is known when it is the main domain or an `otherDomains` entry, and only in the
    fake's own region (`x-outreach-region` header, 335-336); `568-660` `receive()` stores the reply and its `stored`
    event on the MAIN domain (570-572, 635, 648) whatever the recipient's domain.
  - `handlers/messages.ts:16-18,57-59` generated ids `@<main domain>`; `handlers/routes.ts:31,123-126` `/match`;
    `handlers/domains.ts:11` records per region; `cli.ts:14-120` `--domain`, `--region`.
  - `inbound-presets.ts:55-62` **every preset replies to the sent message's From** (`to = ours = bareAddress(sentFrom)`):
    must use `h:Reply-To` when present.
  - Change: per-domain worlds (settings, DNS, suppressions, webhooks, stored events on the recipient's domain) and a
    region per domain; presets reply to Reply-To.
- **Test helpers**: `tests/integration/helpers/mailgun.ts:25-67` (`connectFakeMailgun`: one domain, deactivates
  others); `tests/integration/helpers/replies.ts:19` `DEFAULT_REPLY_ADDRESS = "ali@send.example.com"`, `59-69,85-97`
  `replyInput` sends to `bareAddress(email.fromAddress)`, `153-184` `vectorInput` `to`;
  `tests/integration/mailgun-setup/helpers.ts:34-36` `addSenderAddress` (`local@<domain row>`);
  `tests/integration/replies/world.ts:42,76,107-150,372-379` (`fromAddress = "Ali <ali@${DOMAIN}>"`, senderAddress by
  toAddress); `tests/integration/sending-m3/helpers.ts:85-131`; `tests/integration/campaigns/seed.ts:208`.
- **Playwright**: `tests/playwright/manifest.ts:79` `sendingDomain`; `go-live.spec.ts:108,117` "Live on <domain>
  since"; `settings.spec.ts:129` limits empty text. `playwright.config.ts` starts the fake per state (4010/4011/4012)
  with one domain.

---

## 3. Tests that pin today's behaviour (will need changing, not an exhaustive list of every fixture)

Sender identity and validation
- `tests/unit/setup-core/sender-address.test.ts:28-37` (reserved names), `:51-65` (`validateSendingDomain` refuses
  polygonparadise.com / www, 58-59; accepts mail.polygonparadise.com, 53).
- `tests/integration/sender-addresses/sender-addresses.test.ts:79-155` (`setSenderLocalPart`), `:157-168` (reply inbox
  on or under a sending domain refused; exact text 165-166), `:170-215` route syncs, `:218-247` profile action.
- `tests/unit/setup-core/ui.test.ts:112,123,192,279-323` (profile Sending address field, `@send.example.com`).

Routes and loop rule
- `tests/unit/setup-core/routes.test.ts:28-94` (specs; `isSafeForwardAddress`/`sendingDomainOf` 78-94).
- `tests/integration/mailgun-setup/routes.test.ts:54-280` (catch-all + dmarc@ per sending domain 55; loop refusal
  236-242; suppressed inbox 247).

Connection
- `tests/integration/mailgun-setup/connect.test.ts:41-107` (both regions), `:150-198` (domain change moves addresses,
  resets the reply test, re-pushes), `:200-238` (refusal while campaigns run).
- `tests/integration/foundations/context.test.ts:33-166` (context, `domainsToSync` 125-137, `loadSendGuard`,
  `suppressionListsFor` 168).
- `tests/integration/go-live/domain-change.test.ts:61-150` (G8).

Checklist, Apply, gates
- `tests/unit/checks/checklist.test.ts` (rows for one domain: MX 309-334, DMARC 376, reply routes 462, reply test 614).
- `tests/integration/checks/domain-check.test.ts:79-230`, `tests/integration/checks/fake-mode-dns.test.ts:32,54`.
- `tests/integration/mailgun-setup/apply.test.ts` (e.g. 158 DNS), `tests/integration/mailgun-setup/reply-test.test.ts:84-275`
  (owner address `arslan@${D}` 88; replies to `arslan@${D}` 132-139; test list refuses the sending domain 263-275).
- `tests/unit/sending-core/mode-gates.test.ts:49,113,160,276`; `tests/integration/sending-m3/launch-control.test.ts:106`.
- `tests/unit/sending/gates.test.ts:47,94,250-252` and `tests/integration/sending-m3/gates.test.ts:269` (route hold
  keyed by the From address).
- `tests/unit/setup-core/reply-test.test.ts:360`, `tests/integration/mailgun-setup/actions.test.ts:182` (test list
  "is on your sending domain").

Sending, ids, test sends
- `tests/unit/sending/addresses.test.ts:17-68` (snapshot, placeholder, ids), `tests/unit/sending/mailgun-transport.test.ts:48-67`.
- `tests/integration/mailgun-client/client.test.ts:98,104-113` (Reply-To only when asked).
- `tests/integration/test-send/test-send.test.ts:131-140,252,259,274,312` (From = `Name <ali@${D}>`, ids `@send.example.com`).
- `tests/integration/campaigns/launch.test.ts`, `tests/integration/campaign-wizard/launch.test.ts`,
  `tests/integration/sending/mark-sent.test.ts`, `tests/integration/sequences/threading.test.ts` (fromAddress/ids).

Replies, events
- Every reply test using `replyTo()`/`replyInput()` (reply goes to the From): `tests/integration/replies/*.test.ts`,
  `milestone4/5/6` end-to-end, `worker/m4-wiring.test.ts:130`, `webhooks/two-process.test.ts:219-226`,
  `go-live-rule/flip.test.ts:119`, `fake-inbound/helpers.test.ts:58-61`, `fake-inbound/fake-inbound.test.ts`.
- `tests/integration/replies/assignees.test.ts:51,60,70` (reply to another sender's address / an old address).
- `tests/integration/inbound-store/internal-senders.test.ts:32-64`, `tests/integration/webhooks/inbound-route.test.ts`
  (senderAddressId), `tests/integration/webhooks/events-route.test.ts`.
- `tests/integration/catch-up/catch-up.test.ts`, `catch-up/old-domains.test.ts:109-335`, `catch-up/outage-gaps.test.ts`.
- `tests/unit/ops/restore-script.test.ts`, `tests/integration/backups/restore-review.test.ts`.
- `tests/unit/replies-core/vectors.ts:10-11` (ids `@send.polygonparadise.com`: data only, harmless).

Dashboard, docs, screens
- `tests/integration/dashboard/load.test.ts`, `tests/integration/dashboard-data/mailgun.test.ts`.
- `tests/unit/docs/labels.test.ts:82-86` (go-live rows = guide 4 step 2 list), `:160` ("Reply route: Being set up…"
  in README), `:159` ("Save profile"); `tests/unit/docs/guide-refs.test.ts:23-28` (guide 2 has 19 steps, guide 4 has
  13: steps may only be added at the end; the app cites "Mailgun guide, step 9", "Going-live guide, step 3/4/5");
  `tests/unit/docs/readme-topics.test.ts` (README keeps SPEC headings).
- `tests/playwright/go-live.spec.ts:108,117`, `settings.spec.ts:129`.

---

## 4. Owner docs and specs that state the old rule

| Doc | Lines | Says today |
|---|---|---|
| `SPEC.md` | 21 | "contact@polygonparadise.com … must NOT be used for cold sending." |
| `SPEC.md` | 30 | "sent … from a separate sending domain, not polygonparadise.com." |
| `SPEC.md` | 58 | profile: "sender address on the sending domain (e.g. ali@<sending-domain>)" |
| `SPEC.md` | 161, 189-190 | one daily cap per sending domain; "Each sender's reply address is on the sending domain" (still true for the reply subdomain) |
| `PLAN.md` | 107-111 (Q8), 125-126 (Q11), 667, 989 (Setup C: `h:Reply-To: ali@reply.<sending-domain>`), 1244 | the separate-domain recommendation, Setup C, sender-address rules |
| `README.md` | 16 | guide 2 "the sending domain" |
| `README.md` | 22 | "a domain just for sending email (never polygonparadise.com)" |
| `README.md` | 26 | test mailboxes "none of them your reply inbox" |
| `README.md` | 44 | "Mailgun sends your emails from your own sending domain … (EU region) … MX …" |
| `README.md` | 82, 85 | wizard "whose sending address"; "Send me a test" |
| `README.md` | 155 | "**Sending address** (the part before the @ on the sending domain), **Reply inbox** (never on the sending domain)… Reply route: Being set up…" |
| `README.md` | 174 | changing the sending domain ends going live |
| `README.md` | 327, 354, 356 | costs (the sending domain), warm-up and reply-route glossary |
| `docs/setup/2-mailgun-and-dns.md` | 7, 17 ("Never polygonparadise.com itself: the app refuses it, so cold email can never harm your main domain and your contact@ mailbox"), 28-29, 36-48 (buy the domain), 62-63, 85-86 (Region EU), 91-97, 104-137 (DNS rows: MX `@` → mxa/mxb.eu.mailgun.org 112; DMARC 114, 123 `rua=mailto:dmarc@send.example.com`), 168, 173, 191-197 (step 12 "Everyone's sending address", reply inbox never on the sending domain), 206-226 (test list, reply test "sent from your sending address"), 263-268, 277-289 (routes: sender, catch-all, dmarc@), 319, 328-329 (MX region, Cloudflare Email Routing), 339-342 | the whole guide assumes one separate sending domain with Mailgun MX |
| `docs/setup/3-cloudflare.md` | 21-24 ("Never use the sending domain from the Mailgun guide"), 50-57 (moving polygonparadise.com to Cloudflare keeps Zoho MX) | the app's address; if the app's address is on polygonparadise.com, the From domain and the app share a zone (fine) |
| `docs/setup/4-going-live.md` | 9, 17 (domain age), 21 (Sending address), 23, 33-51 (go-live rows, pinned), 79, 210-217 (warm-up "new sending domain"), 254-264 (step 13 changing the sending domain) | step 2's row list is tied to `GO_LIVE_ROW_KEYS` by the label test |
| `docs/dev/CONVENTIONS.md` | 211-265 (M3 rules: `getMailgunContext`, one domain), 293-294 (`internalSenders`), 426-433 (G8) | developer rules to update with the design |
| `docs/dev/M3-DESIGN.md` | 121, 149 (Setup C deferred), §4.5.1-§4.5.7 (connect, Apply, webhooks, routes, sender addresses) | the design being changed |
| `docs/dev/research/mailgun-api-reference.md:157`, `mailgun-sending.md:34` | `h:Reply-To` "only in Setup C"; Reply-To documented by Mailgun (https://help.mailgun.com/hc/en-us/articles/4401814149147-Reply-To-Addresses) | — |

---

## 5. Open questions the design depends on (not verified here)

1. **Return-Path / asynchronous bounces.** Where Mailgun sends asynchronous bounces for a sending domain whose MX is not
   Mailgun (polygonparadise.com → Zoho), and whether Mailgun still records them as `failed` events. The health pause,
   suppressions and bounce stops (`apply.ts`, `health-check.ts`) depend on it. UNVERIFIED.
2. **Routes and region.** Whether routes (`/v3/routes`, `/routes/match`) and stored messages are per region, and whether
   the HTTP webhook signing key (`/v5/accounts/http_signing_key`) is the same in EU and US. If not, both domains should
   be in the same region (polygonparadise.com is US). UNVERIFIED.
3. **Which domain's settings govern replies.** Whether `spam_action`, `message_ttl` (stored replies) and the suppression
   lists that block `forward()` are the receiving (reply) domain's. UNVERIFIED; drives Apply, the checklist and
   `suppressionListsFor`.
4. **Does the reply domain need SPF/DKIM?** Mailgun's forward() sends from the reply domain's side; whether SPF/DKIM on
   mail.polygonparadise.com matter for forwarded replies reaching Zoho (the reply test's dkim/arc question). UNVERIFIED.
5. **Plan limits.** The account may still be on the free trial (Upgrade button, sandbox domain): custom-domain count
   (two domains needed), route count, https tracking certificate ("Foundation and higher", `checklist.ts:633`), log
   retention (the app assumes 5 days, `settings.ts:78`). UNVERIFIED for the owner's current plan.
6. **Replies that bypass Reply-To.** How often replies go to the From (reply-all, clients or auto-responders that use
   From or Return-Path): decides whether a contact@ → Mailgun copy (store-only, no forward) is needed.
7. **Receiver checks on From ≠ Reply-To domain.** Same organisational domain (polygonparadise.com), DKIM `d=` aligned
   with From; whether Gmail/Microsoft treat a Reply-To on a subdomain as a signal. UNVERIFIED.
8. **Mailing yourself.** "Send me a test" to `contact@` from `contact@` (and the reply test when the Owner's reply inbox
   is contact@): whether Zoho shows, threads or filters mail from its own address sent through Mailgun. UNVERIFIED.
9. **DMARC on the apex.** A `p=none` record on polygonparadise.com also covers Zoho mail; its `rua` should go to a
   routed reply-domain address or a Zoho mailbox, not `dmarc@polygonparadise.com` (which Zoho gets, not the app).
