# Research (owner decision, checked 2026-09-27): Mailgun mechanics for sending "From: contact@polygonparadise.com"

Why this file exists: on 2026-09-27 the owner decided that every outreach email must arrive **From
contact@polygonparadise.com** (their main business address), not from an address on a separate sending domain. This
reverses SPEC.md ("Main email: contact@polygonparadise.com. This must NOT be used for cold sending."; "Emails are sent
through Mailgun's HTTP API from a separate sending domain, not polygonparadise.com") and what the app enforces today
(`WEBSITE_DOMAINS` and `RESERVED_LOCAL_PARTS` in `src/core/sender-address.ts`). This file answers the Mailgun mechanics
questions for that shape. It changes no code.

The lead's proposed shape ("**Shape A**" below): send through the Mailgun domain `polygonparadise.com`, From
`"Arslan from Polygon Paradise" <contact@polygonparadise.com>`, with a per-person `Reply-To` on a Mailgun reply subdomain
(e.g. `arslan@mail.polygonparadise.com`) whose routes store the reply for the app and forward it to the person's inbox.
polygonparadise.com keeps its Zoho MX. Section 7 describes an alternative ("**Shape B**") that gives receivers the same
From address with fewer holes.

**Labels**

- **Confirmed**: an official page says it (quoted here with its URL), or it was observed in public DNS today.
- **Likely**: follows from several official statements, or is standard behaviour, but no page says it directly.
- **Unknown**: not found. Each one says how to settle it.

**Limits of this check.** `help.mailgun.com` answers 403 to automated fetches, and this session's web-search budget was
used up, so every page below was fetched directly by URL. Facts that only a help-centre article states are taken from
the earlier research files (with their check date) and marked so. The Mailgun OpenAPI bundle
(`https://documentation.mailgun.com/_bundle/docs/mailgun/api-reference/send/mailgun.yaml`, info.version 3.0.0, 855,857
bytes) was downloaded again today and searched locally. No Mailgun, Anthropic or Cloudflare API was called. DNS was read
through Google's public resolver (8.8.8.8); nothing was queried on Cloudflare.

---

## 0. What is live today (observed in public DNS, 8.8.8.8, 2026-09-27)

| Name | Type | Value | What it means |
|---|---|---|---|
| polygonparadise.com | MX | `10 mx.zoho.com`, `20 mx2.zoho.com`, `50 mx3.zoho.com` | Mail for the domain goes to Zoho. Mailgun's MX row is "unverified" by design. |
| polygonparadise.com | TXT (SPF) | `v=spf1 include:dc-8e814c8572._spfm.polygonparadise.com include:dc-f2ba48d2cc._spfm.polygonparadise.com ~all` | One SPF record (correct). The two wrappers resolve to `v=spf1 include:zohomail.com ~all` and `v=spf1 include:mailgun.org ~all`. |
| (SPF tree) | | 9 DNS-querying terms in total (2 wrappers, zohomail.com → spf.zohomail.com, mailgun.org → `_spf.mailgun.org` → `_spf1`/`_spf2`, `_spf.eu.mailgun.org`) | **9 of the 10 allowed lookups** (RFC 7208 §4.6.4). One more `include:` anywhere breaks SPF for Zoho and Mailgun together. |
| mx._domainkey.polygonparadise.com | TXT | `k=rsa; p=MIGfMA0…` | Mailgun's DKIM key (selector `mx`). Measured with `crypto.createPublicKey`: **1024-bit**. |
| zmail._domainkey.polygonparadise.com | TXT | `v=DKIM1; k=rsa; p=MIGfMA0…` | Zoho signs the owner's normal mail with its own selector. The two keys don't collide. |
| email.polygonparadise.com | CNAME | `mailgun.org` | The tracking host exists. `mailgun.org` is the **US** tracking target (the EU one is `eu.mailgun.org`, API overview table), so polygonparadise.com is a US-region Mailgun domain, as the screenshots show. |
| _dmarc.polygonparadise.com | TXT | NXDOMAIN | **No DMARC policy.** |
| mail.polygonparadise.com (MX, TXT, CNAME, A), email.mail.…, _dmarc.mail.… | | NXDOMAIN | Nothing is published for the subdomain yet. If the owner added it in Mailgun (in either region), none of its records exist, so deleting and re-adding it loses nothing. |
| polygonparadise.com | NS | `ns57/ns58.domaincontrol.com` | DNS is at GoDaddy (as in deliverability-dns.md). |

---

## 1. Summary

1. **Sending From contact@polygonparadise.com through Mailgun works and is already authenticated.** The domain is
   verified with SPF and DKIM while its MX points to Zoho. DKIM (`d=polygonparadise.com`) and SPF (Return-Path on
   polygonparadise.com) both align with the From domain. (Confirmed; §2.1.)
2. **Shape A has three mechanical holes**, all caused by the envelope sender (Return-Path) being on polygonparadise.com,
   whose MX is Zoho:
   - asynchronous bounces never reach Mailgun: no `failed` event, no bounce suppression, the email stays "delivered"
     (Confirmed; §2.3);
   - standard auto-replies (RFC 3834: vacation, out-of-office) go to the Return-Path, so to Zoho, not to the app
     (Confirmed as the standard; per-provider behaviour Unknown; §2.6);
   - the `mailto:` half of Mailgun's `List-Unsubscribe` header very likely points at `u+…@polygonparadise.com`, which
     also lands at Zoho. The https one-click half works (Likely; §4.2).
   It also needs a second Mailgun domain for replies (Foundation plan; Free and Basic allow one custom domain), both
   domains in one region, and the inbound half of every Mailgun flow moved to that second domain (§3, §5).
3. **Shape B closes those holes (§7).** Keep sending through a Mailgun **subdomain** (`mail.polygonparadise.com`, which
   the app's validator already accepts) and change only the **From header** to contact@polygonparadise.com, with
   Reply-To = the teammate's own address on the subdomain. Mailgun's documented DKIM authority lets the subdomain sign
   as `polygonparadise.com`. Receivers see From contact@polygonparadise.com, signed by polygonparadise.com; the
   Return-Path is on the subdomain, whose MX is Mailgun. So bounces, auto-replies, mailto unsubscribes, events,
   suppressions and stored replies all stay on one Mailgun domain, exactly as the app works today. The cost: Mailgun
   "highly recommends" that the From domain matches the sending domain and says Outlook/Hotmail is "especially finicky"
   about it. The reply test must therefore prove Outlook.com inbox placement.
4. **Mailgun has a `mailfrom_host` field** (`PUT /v4/domains/{name}`) that looks like a custom MAIL FROM feature, but
   nothing public documents what it does or what DNS it needs (Unknown; §2.4). Shape B gets the same effect with
   documented features.
5. **Plan:** keeping two Mailgun domains, one inbound route per teammate, HTTPS unsubscribe links and 5-day logs all
   point to **Foundation** ("Free for 1 month, then $35/mo") for either shape (§6).
6. **Reputation:** in both shapes, spam complaints count against polygonparadise.com (DKIM `d=` and From), and the
   owner's everyday Zoho mail uses that same domain. Mailgun's AUP rules on consent and scraped lists apply unchanged
   (§6.4). This is the risk the owner accepted.

---

## 2. Question 1: sending From a domain whose MX isn't Mailgun; envelope sender; bounces

### 2.1 Sending is supported with SPF + DKIM only. **Confirmed**

- Mailgun DNS best practices: "While it's not required to point mx records to the same domain as you are sending from,
  it is recommended. There are mailbox providers (albeit, a minority) that will check if mx records for the domain are
  valid before accepting email." (https://documentation.mailgun.com/docs/mailgun/email-best-practices/dns.md).
  polygonparadise.com has valid Zoho MX records, so that minority check passes.
- The owner's screenshots show the domain green with SPF and DKIM verified and the MX row unverified, which means
  sending works without the MX row.
- Verification page, MX row purpose: "Required for Mailgun to receive and route/store messages addressed to the
  domain." (https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-verify.md). MX is only for
  receiving. The page lists the benefits of verification as: "Verified domains are not subject to a sending limit of
  300 emails per day" … "No more 'sent via Mailgun.org' message in your emails" (same page).
- The From header is free: "You can technically set the from field to be whatever you like. The sender must always be
  one of your Mailgun domains." (https://documentation.mailgun.com/docs/mailgun/faq/sending.md).

### 2.2 Envelope sender / Return-Path. **Confirmed (domain) / Likely (local part)**

- FAQ, "What is the difference between the From and Sender?": "Simply put, the sender domain is what the receiving email
  server sees when initiating the session, and the from address is what your recipients will see. For better
  deliverability it is recommended to use the same from domain as the sender, but it is not required."
  (https://documentation.mailgun.com/docs/mailgun/faq/sending.md).
- The envelope host is the Mailgun domain the message is sent through. OpenAPI `POST /v4/domains`, field
  `force_root_dkim_host`: "This does not effect the smtp mail-from host for the domain being created. The mail-from
  host will remain the domain name being created, not the root domain." (OpenAPI bundle).
- So in Shape A the Return-Path is `…@polygonparadise.com`, and in Shape B it is `…@mail.polygonparadise.com`.
- **Likely, not documented:** the local part is a per-message bounce address of the form `bounce+<id>…@<domain>`
  (widely seen in raw headers). No official page shows the format, so the app must not depend on it. The app already
  reserves the local parts `bounce`, `bounces` and `u` (`RESERVED_LOCAL_PARTS`).
- RFC 5321 §3.6.3: a server that later finds mail undeliverable "MUST construct an 'undeliverable mail' notification
  message and send it to the originator of the undeliverable mail (as indicated by the reverse-path)."
  (https://www.rfc-editor.org/rfc/rfc5321.html).

### 2.3 Asynchronous bounces in Shape A. **Confirmed**

- Mailgun's tracking-failures page separates an "Immediate bounce" ("An email message is rejected by the recipient SMTP
  server during the SMTP session") from a "Delayed (asynchronous) bounce" ("The recipient SMTP server accepts an email
  message during the SMTP session. After some time, it will send a Non-Delivery Report email message to the message
  sender."). Then: "**Warning!** Mailgun can track delayed bounces, but only if the domain that the email message was
  sent from has MX records pointing to Mailgun; Otherwise, NDR email messages will not reach Mailgun."
  (https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-failures.md).
- **Where they go in Shape A:** to Zoho, addressed to a `bounce+…@polygonparadise.com` mailbox that doesn't exist.
  Whether Zoho refuses them (lost) or a Zoho catch-all puts them in a person's inbox depends on the Zoho settings.
  **Unknown**: check in Zoho Mail admin whether a catch-all address is set.
- **Recorded as `failed`? No.** They never reach Mailgun, so there is no `failed` event, no webhook and no entry on
  the Bounces suppression list. The email stays `delivered` in Mailgun and in the app, and the next campaign emails the
  dead address again. When delayed bounces **do** reach Mailgun (Shape B, or today's design), Mailgun counts them as
  permanent failures: the Stats schema lists `delayed-bounce` next to `bounce` under `permanent` (OpenAPI bundle), and
  Logs items carry `flags.is-delayed-bounce` (mailgun-api-reference.md §2.2). **Likely** they arrive as `failed`
  events with `severity: "permanent"`.
- The same page also says: "In case of a bounce, Mailgun will retry to deliver the message only if the bounce was both
  immediate and soft."

### 2.4 A custom MAIL FROM / return-path host? **Unknown (undocumented field exists)**

- The OpenAPI bundle has `mailfrom_host` on `PUT /v4/domains/{name}`, described only as "The hostname to update to.
  Must be in lower case". It is the bundle's only mention of "mailfrom".
- The official Go SDK sends it (`UpdateDomainOptions.MailFromHost` → `payload.addValue("mailfrom_host", …)`) and notes
  that the domain payload "will include dkim_host, mailfrom_host and pod"
  (https://raw.githubusercontent.com/mailgun/mailgun-go/master/domains.go).
- No user-manual page covers it. The Domains section has four pages (overview, sandbox, custom, verification) and none
  mentions MAIL FROM. No release note in `https://www.mailgun.com/releases-sitemap.xml` names it. The help centre could
  not be read.
- By analogy, Amazon SES's version of this feature needs "an MX record so that your domain can receive the bounce and
  complaint notifications" and "an SPF record for your custom MAIL FROM domain", and "The MAIL FROM domain has to be a
  subdomain of the parent domain of a verified identity" (https://docs.aws.amazon.com/ses/latest/dg/mail-from.html).
  Mailgun's field presumably needs the same (**Likely**, not stated by Mailgun).
- **Settle it:** ask Mailgun support (§9, question 1). The app must never probe it on the owner's account. It isn't
  needed for Shape B.

### 2.5 How many bounces are synchronous? **Confirmed qualitatively, Unknown as a number**

- Mailgun: "While most major MBPs (Mailbox Providers) give bounce replies "on the wire" during the SMTP session, there
  are some that send bounce messages via email. In order to receive these emailed bounce messages, you must have the
  appropriate return path header included with your email so that recipients know where to reply with bounce
  information." (https://documentation.mailgun.com/docs/mailgun/email-best-practices/bounce_esp.md).
- No official figure for the share was found. Shape A doesn't lose "most" bounces. It loses the ones from servers that
  accept first and bounce later, which are exactly the ones the app can't see any other way. Once live, Mailgun's
  Metrics `delayed_bounce_count` shows the share, but only for mail whose Return-Path reaches Mailgun (Shape B).

### 2.6 Auto-replies follow the Return-Path, not Reply-To. **Confirmed (standard)**

- RFC 3834 §4: "In general, automatic responses SHOULD be sent to the Return-Path field if generated after delivery."
  "The Reply-To field SHOULD NOT be used as the destination for automatic responses from Personal or Group
  Responders." "the From field SHOULD NOT be used as a destination for automatic responses."
  (https://www.rfc-editor.org/rfc/rfc3834.html).
- In Shape A, standard out-of-office and vacation replies therefore go to `…@polygonparadise.com` (Zoho), not through
  the Reply-To route to the app. Which real systems follow the RFC is **Unknown** per provider (replies-and-auto-replies.md
  §2 lists them as UNVERIFIED). In Shape B they go to Mailgun (the subdomain's MX), as they would today. Whether
  Mailgun passes non-bounce mail sent to its bounce addresses through routes is **Unknown**, the same as today.

---

## 3. Question 2: a second Mailgun domain only for receiving (Shape A)

### 3.1 It must be a Mailgun domain, or covered by the root's wildcard. **Confirmed**

- "Mailgun will allow you to receive emails sent to your Mailgun Domain using our inbound features."
  (https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-forward-store.md). Together
  with the MX row purpose in §2.1 ("messages addressed to the domain"), this means a reply subdomain must exist in
  Mailgun, with its MX pointing to Mailgun, before routes can see its mail.
- **Alternative:** the root's wildcard. `POST /v4/domains`, field `wildcard`: "Allows domain to accept inbound messages
  received on subdomains that have MX records pointed to Mailgun. Default is false." `PUT /v4/domains/{name}` can switch
  it later: "Updates the domain's wildcard status with the given boolean" (OpenAPI bundle). The Go SDK: "Wildcard
  parameter instructs Mailgun to treat all subdomains of this domain uniformly if true, and as different domains if
  false." (mailgun-go `domains.go`).
  - **Likely:** with the wildcard on, replies to `arslan@mail.polygonparadise.com` count as polygonparadise.com
    traffic: its stored events, retention, spam setting, and its tracking settings on forwards. That brings back the
    forwarding/DKIM conflict (§5.2).
  - Whether the wildcard works on every plan is **Unknown**.

### 3.2 DNS a receive-only domain needs. **Confirmed (MX) / Unknown (whether verification is needed)**

- Receiving records are MX only. `receiving_dns_records` is documented as "List of DNS records required for receiving
  emails", and the only record type it holds is MX (OpenAPI `UpdateDomainResp`; examples in mailgun-api-reference.md
  §8.1). US: `10 mxa.mailgun.org`, `10 mxb.mailgun.org`; EU: `mxa.eu.mailgun.org`, `mxb.eu.mailgun.org`
  (https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview.md).
- **Unknown:** whether a domain whose SPF/DKIM are unverified (`state: unverified`) still accepts inbound mail and runs
  routes. Nothing says either way. Cheap insurance is to publish SPF anyway (`v=spf1 include:mailgun.org ~all` on the
  subdomain; that name has its own 10-lookup budget).
- DKIM for the subdomain can come from the root. `force_dkim_authority`: "If set to false, the domain will have the same
  DKIM authority as the root domain registered on the same mailgun account. Default to false." (OpenAPI bundle). With
  the root already verified in the same account, the subdomain then needs no DKIM record of its own. **Likely**; whether
  this holds across regions is **Unknown**.

### 3.3 Routes work across domains, within one region. **Confirmed**

- Routes belong to the account: `GET /v3/routes` returns `total_count`, "Total number of routes in the account"
  (quoted in mailgun-inbound-validation-domain.md, checked 2026-09-22). `match_recipient` is a regex on the SMTP
  recipient, so one account's routes can match any of its domains.
- Routes are regional. API overview: "Domain Metadata (e.g., SMTP credentials), Messages, Event Logs, Suppressions,
  Mailing Lists, Tags, Statistics, Routes, IP Addresses" stay in their region, while "Account Information, User
  Accounts, Billing Details (invoices/plan information), API Keys, Domain Names" are global
  (https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview.md). A route created on
  `api.mailgun.net` only sees mail that arrived at the US MX servers.

### 3.4 Regions. **Confirmed / Likely**

- **One key, two base URLs.** API keys are global (above), so the saved key works on both `api.mailgun.net` and
  `api.eu.mailgun.net`. Every per-domain call (routes, logs, stored messages, suppressions, settings) must use the base
  URL of that domain's region. Account-level webhooks "are configured independently for US and EU regions" (OpenAPI tag
  "Account Webhooks").
- **Unknown:** whether the HTTP webhook signing key (which also signs route `store(notify)` POSTs) is the same in both
  regions. mailgun-api-reference.md §5 already marks this UNVERIFIED.
- **Recommendation:** keep every domain in one region. Mixing regions works in principle but doubles the regional
  state (routes, webhooks, custom message limit per region).
- **A domain's region can't be changed.** Earlier research quoted the help article
  https://help.mailgun.com/hc/en-us/articles/360007512013 ("Moving it means creating a new (sub)domain in the other
  region, or deleting it and re-creating it there"; mailgun-sending.md, checked 2026-09-22; the page returned 403
  today). **Confirmed** then. Domain names are global, so one name **Likely** can't exist in both regions at once.
- **Moving polygonparadise.com to EU would mean:**
  1. Deleting the US domain. Its regional data goes with it (suppressions, logs, stored messages, webhooks, tracking
     settings, tracking certificate).
  2. Re-adding it in EU with a **new DKIM key**. Keys are never exported: "Note that once private keys are created or
     imported they are never exported." (OpenAPI `POST /v1/dkim/keys`). So the TXT at `mx._domainkey` (or a new
     selector) must be replaced at GoDaddy.
  3. Re-pointing the tracking CNAME `email.polygonparadise.com` to `eu.mailgun.org`. SPF needs no change:
     `mailgun.org`'s own SPF already includes `_spf.eu.mailgun.org` (observed §0).
  4. Verifying again and running Apply recommended settings again.

  Nothing has been sent yet (data/app.db is empty), so only DNS edits and waiting are lost. **Likely.**
- If `mail.polygonparadise.com` was created in EU while the root is in US: it has no DNS yet (§0), so delete it and
  re-add it in US. Choose the US unless the owner wants EU data residency; in that case move both.

---

## 4. Question 3: Reply-To, tracking and unsubscribe on the root domain

### 4.1 `h:Reply-To` on another domain. **Confirmed (supported) / no Mailgun warning found**

- Mailgun documents `h:Reply-To` explicitly (help article "Reply-To Addresses",
  https://help.mailgun.com/hc/en-us/articles/4401814149147, quoted in mailgun-sending.md, checked 2026-09-22). Custom
  headers in general: "Adds custom headers to the email. Use 'h:' prefix followed by header name and value."
  (https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages.md).
  The app's client already sends `h:Reply-To` when `replyTo` is set (`src/server/mailgun/client.ts:592`,
  `src/server/services/sending/mailgun-transport.ts:96`).
- No Mailgun page limits the Reply-To domain or warns about it. The AUP asks that it be honest: "'From', 'To' and
  'Reply-To' fields must accurately and clearly identify the sender's domain name and email address."
  (https://www.mailgun.com/legal/aup/). A subdomain of the company's own domain meets that.
- What Reply-To does: "When the "Reply-To:" field is present, it indicates the address(es) to which the author of the
  message suggests that replies be sent." (RFC 5322 §3.6.3, https://www.rfc-editor.org/rfc/rfc5322.html). It's a
  suggestion. A person who types or copies contact@polygonparadise.com, or whose client ignores Reply-To, writes to
  Zoho, and the app never sees it. How often this happens is **Unknown**. Auto-replies ignore Reply-To by design (§2.6).

### 4.2 Tracking, HTTPS and List-Unsubscribe on the root domain. **Confirmed / Likely**

- The tracking host is `<web_prefix>.<domain>` (default `email`; mailgun-api-reference.md §9), here
  `email.polygonparadise.com`. Its CNAME to `mailgun.org` is live (§0) and verified in the screenshots. **Confirmed.**
- HTTPS: "To enable HTTPS, Mailgun uses Let's Encrypt with HTTP-01 challenges through your existing tracking CNAME record
  to issue a TLS certificate. This setup also includes support for HTTP Strict Transport Security (HSTS) for enhanced
  security." (OpenAPI tag "Domain Tracking"). Nothing excludes a root domain's tracking host, so `POST
  /v2/x509/email.polygonparadise.com` **Likely** works like any other host.
  - HSTS is set on the tracking host; it can't cover the parent `polygonparadise.com` website. Whether Mailgun adds
    `includeSubDomains` is **Unknown** and harmless here.
  - The plan requirement (402 "upgrade your account" below Foundation) comes from a help-centre snippet
    (mailgun-api-reference.md §9.1): **Likely**.
- Mailgun adds `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` itself (mailgun-sending.md,
  help article 203306610, checked 2026-09-22). That article describes "a mailto:u+...@<domain> and/or
  https://<tracking-host>/u/... URL".
  - The https URL is on the tracking host, so it reaches Mailgun in both shapes. **Confirmed.**
  - The `mailto:` address is **Likely** on the sending domain, which is why the app reserves the local part `u`. In
    Shape A that is `u+…@polygonparadise.com`, delivered to Zoho, so a mail client that unsubscribes by mailto instead
    of the one-click POST sends it into Zoho, where nobody processes it. In Shape B it is on the subdomain (Mailgun MX).
    **Settle:** in the first test email, "Show original" and read the `List-Unsubscribe` header.

### 4.3 Where one-click unsubscribes and complaints land. **Confirmed**

- **Unsubscribes:** the https one-click POST and the footer link go to the tracking host, which is Mailgun. Each
  produces an `unsubscribed` event and an entry on the **sending domain's** list. `%unsubscribe_url%` is the "Link to
  unsubscribe recipient from all messages sent by given domain"
  (https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-unsubscribes.md), and the list
  lives at `/v3/{domain}/unsubscribes`.
- **Complaints:** they depend on Mailgun's sending IPs, not on the domain's MX. "Mailgun registers all of our IPs for
  these feedback loops." "Most of the major MBPs (Mailbox Providers) other than Gmail provide feedback loops through
  which they give you information about spam complaints."
  (https://documentation.mailgun.com/docs/mailgun/email-best-practices/feedbackloops.md). "Mailgun automatically tracks
  all messages recipients report as spam." (tracking-spam-complaints.md, same docs site). They produce `complained`
  events and entries on `/v3/{domain}/complaints` of the sending domain.
  - Mailgun matches feedback-loop reports to messages through `X-Mailgun-Sid`, so never suppress that header
    (mailgun-sending.md).
  - Gmail has no feedback loop; its complaints show only in Postmaster Tools.

---

## 5. Question 4: which domain carries what, and what the app's flows need

### 5.1 Per-domain data. **Confirmed / Likely**

| Data | Lives on | Shape A | Shape B | Label |
|---|---|---|---|---|
| Send call `POST /v3/{d}/messages`, Message-ID domain (`pp.…@{d}`) | the sending domain | polygonparadise.com | mail.polygonparadise.com | Confirmed (path) |
| `accepted` / `delivered` / `failed` / `complained` / `unsubscribed` events and domain webhooks | the sending domain (events carry `domain.name`; webhooks are registered per domain at `/v4/domains/{d}/webhooks`) | polygonparadise.com | mail.polygonparadise.com | Confirmed |
| Bounces, complaints, unsubscribes lists | `/v3/{d}/…` of the sending domain | polygonparadise.com | mail.polygonparadise.com | Confirmed |
| Delayed bounces (NDRs) | the Return-Path domain's MX | lost at Zoho (§2.3) | Mailgun | Confirmed |
| Inbound `stored` events, storage URLs (`/v3/domains/{d}/messages/{key}`), spam filtering (`spam_action`) | the domain the reply was addressed to | the reply domain | mail.polygonparadise.com | Likely |
| Stored-message retention | per domain: `message_ttl` "Specifies the time-to-live (TTL) in seconds for retrieving both incoming and outgoing messages. The maximum TTL value is determined by your subscription plan." (OpenAPI) | reply domain for replies, sending domain for sent copies | one domain | Confirmed (field); Likely (which domain applies) |
| Content changes on forwarded replies | the receiving domain's tracking settings. The route docs only say "by editing your domain settings" (route-actions page, quoted in mailgun-inbound-validation-domain.md) | the reply domain: can keep all tracking **off**, giving clean forwards | the sending domain: unsubscribe tracking **on** (today's Setup A reply test) | Likely |
| Forward failures (reply inbox bounced) | **Likely** the receiving domain's Bounces list | the reply domain | mail.polygonparadise.com | Likely |
| Routes | the account, per region | US (or the reply domain's region) | US (or the subdomain's region) | Confirmed |
| Logs API | the whole account; the app filters by `domain` | two domains to walk | one | Confirmed |
| Address checks | the account (no domain) | unchanged | unchanged | Confirmed (CONVENTIONS M5) |

### 5.2 The app's existing Mailgun flows (read from the code; nothing changed)

| Flow | Where in the code | Shape A needs | Shape B needs |
|---|---|---|---|
| Apply recommended settings: open/click tracking off, unsubscribe on with blank footers, x509 + `web_scheme` https, webhooks, `webhooks_redact_pii` false | `src/server/services/mailgun/apply-settings.ts` | the sending domain (root) as now; **plus** the reply domain's open/click/unsubscribe **off**, so forwarded replies stay unmodified | unchanged (one domain) |
| Apply: `spam_action` tag, `message_ttl` | same | the **reply domain** (that is where replies are filtered and stored); the root's values only affect sent copies | unchanged |
| Apply: routes (per sender `^ali@<domain>$`, catch-all `^.*@<domain>$`, `dmarc@<domain>`) | `src/core/mailgun/routes.ts`, `src/server/services/mailgun/routes.ts` | every expression on the **reply domain**; no catch-all on the root (Zoho gets that mail anyway) | unchanged: the per-sender addresses become the Reply-To addresses |
| Catch-up steps 1–4 (sending queue, tracking drift, suppressions pull/push, Logs events) | `src/server/services/mailgun/catch-up.ts` | the sending domain | unchanged |
| Catch-up step 5 (`stored` replies, key `${domain}:stored`; storage fallback builds `/v3/domains/${r.domain}/messages/…`) | `catch-up.ts:446-471`, `:410` | the **reply domain** (filter and fallback URL), possibly on the other region's base URL | unchanged |
| Restore scan (own `accepted` sends, `pp.…@<domain>`) | M3 §4.3.7, M6 BACKUPS-7 | the sending domain only | unchanged |
| DNS checklist and mode gates: the `mx` row ("Replies reach the app (MX)") blocks TEST/LIVE (`src/core/sending/mode-gates.ts:68`) | `src/core/dns/checklist.ts:543-595` | red for the root **by design**. The row must move to the reply domain, and for the root become "MX must stay with your mail provider, never Mailgun" | unchanged (MX on the subdomain) |
| Reply inbox safety (`isSafeForwardAddress` refuses inboxes on or under a sending domain, against loops) | `src/core/mailgun/routes.ts:116` | refuses contact@polygonparadise.com (the root is the sending domain). The rule must change to "not on a domain whose MX is Mailgun" | allows contact@polygonparadise.com as a reply inbox; still refuses the subdomain |
| Deliverability "Remove" for reply inboxes (Mailgun's Bounces list) | M5 §12 `removableAddresses` | must also read the **reply domain's** Bounces list (forward failures land there) | unchanged |
| Address checks | `getVerifier()` | none | none |

---

## 6. Question 5: plan and account facts

### 6.1 Plans (https://www.mailgun.com/pricing/, fetched 2026-09-27). **Confirmed**

| | Free | Basic | Foundation | Scale |
|---|---|---|---|---|
| Custom domains | "1 custom sending domain" | "1 custom sending domain" | "1,000 custom sending domains" | "1,000 custom sending domains" |
| Inbound routes | "1 inbound route" | "5 inbound routes" | "Full access to inbound routing" | "Full access to inbound routing" |
| Volume | 100 emails/day | 10,000/mo | 50,000/mo | 100,000/mo |
| Price / trial | $0 | from $15/mo | "Free for 1 month, then $35/mo" | "Free for 1 month, then $90/mo" |
| Logs / stored messages | 1 day / 1 day | 1 day / not listed | 5 days / 1 day | 30 days / up to 7 days |

- **Foundation is needed** for:
  - **two domains**: Shape A always; Shape B while the root stays registered as the DKIM authority. That a
    receive-only domain counts toward "1 custom sending domain" is **Likely**, not stated;
  - **one route per teammate** plus the catch-all and dmarc@ (Free allows 1, Basic 5);
  - **HTTPS unsubscribe links** (Likely, §4.2);
  - **5-day logs** for the catch-up after the PC was off.
- The "free trial" in the screenshots is either the Free plan or Foundation's first free month. **Unknown**; the owner
  can see which under Account › Plan.

### 6.2 Trial and sandbox limits. **Confirmed / Confirmed earlier**

- "Sandbox domains can only send to authorized recipients." "Sending messages to lists with up to 5 authorized
  participants", "Receiving Messages (limited to one Route)"
  (https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-sandbox.md). The OpenAPI example of the
  rejection: "Sandbox subdomains are for test purposes only. Please add your own domain or add the address to authorized
  recipients in Account Settings."
- Earlier research also quoted that "The same restriction applies to Free-plan accounts without a card on file" (help
  article 217531258; mailgun-sending.md, checked 2026-09-22; 403 today). New or flagged accounts may be held to about
  100 messages an hour until business verification (help article 115001124753, same file).
- Unverified custom domains are held to 300 a day (§2.1 quote).

### 6.3 Custom message limit. **Confirmed earlier**

- Account-wide, monthly, **per region**, minimum 1,000. It disables the **whole account** when hit, and the
  Developer-role key can only read it (mailgun-sending.md; mailgun-api-reference.md §12). With both domains in one
  account, both stop together.
- Zoho mail is never affected by a Mailgun disablement.
- Whether route `forward()` copies of replies count toward it is **Unknown** (mailgun-inbound-validation-domain.md
  already lists that as undocumented).

### 6.4 Acceptable Use Policy and the main domain. **Confirmed**

- AUP (last updated January 16, 2023, https://www.mailgun.com/legal/aup/):
  - Consent: "Emails and SMS (unless transactional) can only be sent where permission has been expressly obtained in
    nature, and can only be sent to recipients who have granted clear, explicit and provable consent to receive
    communication."
  - Lists: "Acquiring or sending to a third-party mailing list is prohibited. Use of contact lists that are bought,
    rented or scraped from third-parties is prohibited by law in most countries, and is absolutely prohibited on Sinch
    Email servers."
  - Thresholds: bounces ≤ 5 %, unsubscribes ≤ 1.4 %, spam complaints ≤ 0.08 %, blocks < 20 %.
  - Consequence: "If you breach this AUP (in whole or in part), we may limit, suspend, or terminate your account".
  - The AUP draws no line between a company's main domain and a subdomain. The cold-email risk is the same in both
    shapes.
- Mailgun's own advice runs against the owner's decision: "We suggest that you use your top level domain for your
  corporate mail and using different domains or subdomains for your marketing and transactional mail."
  (https://documentation.mailgun.com/docs/mailgun/email-best-practices/dns.md).
- Gmail: "If messages from your domain are frequently reported as spam, future messages from you are more likely to be
  marked as spam." (https://support.google.com/a/answer/81126).
- In both shapes the From domain and the DKIM `d=` are polygonparadise.com, so complaints on outreach **Likely** weigh
  on the reputation that the owner's everyday Zoho mail also relies on. A Mailgun suspension would stop only outreach.

---

## 7. Shape B: send through the subdomain, show the root in From

**How it works.**

1. `mail.polygonparadise.com` is a Mailgun domain in the **same account and region** as `polygonparadise.com` (US
   today), with MX → Mailgun, SPF `v=spf1 include:mailgun.org ~all`, and the tracking CNAME
   `email.mail.polygonparadise.com`.
2. Its DKIM authority is the root. `force_dkim_authority` defaults to false ("the domain will have the same DKIM
   authority as the root domain registered on the same mailgun account"). For a domain already created differently:
   `PUT /v3/domains/{name}/dkim_authority` with `self=false` ("You can delegate the domain authority to an other
   domain."). **Likely** result: the signature is `d=polygonparadise.com` with the existing `mx` key, so there is
   nothing new to publish for DKIM.
3. The app sends `POST /v3/mail.polygonparadise.com/messages` with `from = "Arslan from Polygon Paradise"
   <contact@polygonparadise.com>` and `h:Reply-To = arslan@mail.polygonparadise.com`. Both are allowed: "You can
   technically set the from field to be whatever you like." (§2.1).
4. The Return-Path is on `mail.polygonparadise.com` (§2.2), so bounces and auto-replies reach Mailgun (§2.3, §2.6).
   The mailto unsubscribe is **Likely** on the subdomain too (§4.2).

**Authentication.**

- DKIM `d=polygonparadise.com` equals the From domain (strict alignment).
- SPF passes on `mail.polygonparadise.com`, which is relaxed-aligned with the From domain (DMARC default `aspf=r`).
- DMARC therefore passes. **Likely**, and the first test's "Show original" settles it ("signed-by", "mailed-by").
- A rua address on the subdomain needs no extra authorization record: RFC 9990 asks for one only when "the
  Organizational Domain at which that record was discovered is not identical to the Organizational Domain of the host
  part of the authority component of a URI specified in the 'rua' tag"
  (https://datatracker.ietf.org/doc/html/rfc9990). **Confirmed.**

**Costs and open points.**

- **Mailgun's recommendation.** "While it is not required to use the same domain in the From field of the message as
  the actual domain sending the message, it is highly recommended. Outlook/Hotmail is especially finicky about this
  requirement and has a higher propensity to filter your messages to junk if the two domains do not match."
  (https://documentation.mailgun.com/docs/mailgun/email-best-practices/dns.md).
  - Here the two domains differ but share one organizational domain, and DKIM matches exactly. Whether Outlook's
    filters treat that as "not matching" is **Unknown**.
  - The reply test already requires an Outlook.com/Hotmail mailbox that lands in the inbox (M3 §1.5 step 5), so it
    measures exactly this.
  - Separate MAIL FROM subdomains are the normal setup at other providers (SES, §2.4).
- **Gmail "via" and "mailed-by".** Gmail shows "via" "if the domain it was sent from doesn't match the domain in the
  'From:' address" (https://support.google.com/mail/answer/1311182). With `d=polygonparadise.com`, **Likely** no
  "via". Gmail's details panel **Likely** shows "mailed-by: mail.polygonparadise.com". Only people who open the
  details see it, and the owner should know about it before choosing.
- **Tracking host.** Unsubscribe links sit on `email.mail.polygonparadise.com`, not `email.polygonparadise.com`.
  Visible only on hover.
- **Forwarded replies.** Unsubscribe tracking on the one domain also touches forwarded replies. This is today's
  Setup A situation, which the reply test already covers.
- **Plan.** Two domains in the account (the root stays as DKIM authority), so Foundation, as in Shape A.
  `force_root_dkim_host` ("the root domain will be the DKIM Host for the domain being created even if the root domain
  itself is not registered with Mailgun") could allow a single domain. It can only be set when the domain is created,
  and it would need a new root key, because the current key can't be exported. **Unknown** whether that is worth it.

**Comparison.**

| | Shape A (lead) | Shape B |
|---|---|---|
| Recipient sees | From contact@polygonparadise.com | the same |
| Delayed bounces, RFC 3834 auto-replies, mailto unsubscribes | lost to Zoho | reach Mailgun |
| Mailgun domains the app handles | two (sending root + reply domain; maybe two regions) | one (as today) |
| From domain = Mailgun sending domain (Mailgun's recommendation) | yes | no (same organization) |
| Forwarded replies unmodified | yes, if the reply domain's tracking is off | only as far as today's Setup A |
| App change size | large (§5.2: every inbound flow and the checklist move) | small: From header + Reply-To + validators and wording |
| Plan | Foundation | Foundation (or one domain with `force_root_dkim_host`) |

---

## 8. What this invalidates in the existing research files

- **mailgun-sending.md**
  - "Plan implications": `from='Sender Name <sender@send-domain>'` and "h:Reply-To (only if it differs from From)":
    now From is always contact@polygonparadise.com with a per-person display name, and Reply-To is always set.
  - The AUP gotcha still stands, but the reputation at stake is now the main domain's (§6.4).
- **mailgun-events.md**
  - "Delayed bounces (NDRs) are tracked only if the sending domain's MX records point to Mailgun." In Shape A they
    won't be: the bounce auto-pause undercounts, and dead addresses never reach the Bounces list.
  - "Reconciliation step 1 … filter AND [domain = sendingDomain]": in Shape A the `stored` walk needs the reply domain.
- **mailgun-inbound-validation-domain.md**
  - Route expressions `^ali@<sending-domain>$` and "MX records on the sending domain itself": in Shape A they move to
    the reply domain, and the root must never get Mailgun MX.
  - "Mailgun domain settings: spam 'tag', retention": in Shape A they belong on the reply domain.
  - The forwarding/DKIM conflict can be solved in Shape A by keeping the reply domain's tracking off.
  - "polygonparadise.com has no DMARC today, so the subdomain needs its own record. Adding one at the root would also
    apply to the owner's Zoho mail": the root itself now sends outreach, so a root DMARC record is needed. `p=none` is
    monitor-only and safe for Zoho.
  - Mailgun's "use your top level domain for your corporate mail" advice is now knowingly overridden.
- **deliverability-dns.md**
  - The Q8a/Q8b "separate domain or subdomain", "buy the domain", "redirect" and "30 days old" steps don't apply to the
    root (registered 2024-08-22).
  - Checklist row 4 (MX) is red for the root by design in Shape A.
  - Row 2 (SPF) must read the merged Zoho + Mailgun record, now at **9/10 lookups**.
  - Row 3 (DKIM) would show amber: the live key is 1024-bit.
  - "Owner guide … EU" no longer matches: the verified root is US.
  - "From aligned … Mailgun does this automatically when From uses the sending domain" is true in Shape A; in Shape B,
    alignment comes from the DKIM authority.
- **mailgun-api-reference.md**
  - §0.1 "The owner's default is EU": the live domain is US.
  - §1 "`h:Reply-To` only in Setup C": now always.
  - §6.1 route example and §7/§8.3 (storage URL domain, `message_ttl`): in Shape A they belong to the reply domain.
  - §16 probes: add the §9 questions below.
- **replies-and-auto-replies.md**
  - §4.4 "Our Return-Path is Mailgun's bounce address, and Mailgun reports real bounces as events": false in Shape A
    (the Return-Path lands at Zoho).
  - §6.2 "Accept only `pp.<24 hex>@<one of our sending domains>`": still right. The Message-ID domain is the Mailgun
    sending domain in both shapes, never the From domain.
  - Standard auto-replies (RFC 3834) won't reach the app in Shape A, so fewer AUTO_REPLY rows. Harmless, but
    "left the company" and challenge notices go to Zoho.
- **notifications-and-threading.md**
  - B2's example `From: Ali from Polygon Paradise <ali@send.example.com>` becomes the shared From plus a per-person
    Reply-To. Threading headers are unaffected.
  - All teammates now share one From address, so Gmail's "same subject from the same sender" rule (B1) groups by
    subject and references across teammates. Our References headers keep each thread correct.

---

## 9. Questions only Mailgun support can answer (the owner can send them; the app never probes)

1. What does `mailfrom_host` (`PUT /v4/domains/{name}`) do, which plans have it, and what DNS does the host need?
2. Does a domain with only MX verified (SPF/DKIM unverified) accept inbound mail and run routes?
3. Does a subdomain share the root's DKIM authority when the two are in different regions?
4. When a route `forward()`s a message, whose tracking settings apply: the receiving domain's?
5. Is the `mailto:` in the automatic `List-Unsubscribe` header on the sending domain?
6. Does a receive-only domain count toward "1 custom sending domain" on Free/Basic, and is `wildcard` on every plan?

---

## 10. Implications for the app

- **Choose the shape before building.** Shape B keeps today's one-domain design (§7). Shape A moves every inbound flow
  to a second domain (§5.2).
- **New settings.** A fixed From address (contact@polygonparadise.com) separate from the Mailgun sending domain. Each
  teammate's display name (already `User.senderDisplayName`) and Reply-To address (the existing per-sender address in Shape B, a
  new reply-domain address in Shape A). SPEC.md lines 21 and 30 need the owner's new rule written down.
- **Validators.** The From address may be on the website domain only (contact@polygonparadise.com). `WEBSITE_DOMAINS`
  keeps refusing the root as the *sending* domain in Shape B. In Shape A the root becomes the sending domain, and that
  rule and the `contact` reservation must change.
- **Checklist rows for the root (both shapes):**
  - "MX stays with your mail provider, never Mailgun": red if a Mailgun MX appears, because that would break Zoho mail;
  - SPF at 9/10 lookups (amber: "one more service breaks SPF");
  - DKIM 1024-bit (amber);
  - DMARC missing: recommend `v=DMARC1; p=none; rua=mailto:dmarc@<Mailgun reply or sending domain>`, and say it also
    covers Zoho mail.
- **Replies that bypass Reply-To** (typed to contact@, forwarded by colleagues) reach Zoho, not the app.
  - Options: keep the manual "Mark as replied" fallback visible, or add a Zoho rule that sends a copy of contact@ mail
    to a **store-only** Mailgun address (no `forward()`, or it loops back to Zoho).
  - Either way, the reply-inbox loop check must be rewritten around "a domain whose MX is Mailgun" (§5.2).
- **Our own addresses** (`internalSenders()`) gain contact@polygonparadise.com and the Reply-To addresses. The
  per-sender cap and pacing must key on the user, not on the From address, since everyone now shares one.
- **Tests (Shape A only):** `mode-gates` can't keep "mx" as a blocker for the root.
- **Reply test and first real email:** check "Show original" for `dkim=pass` with `d=polygonparadise.com`,
  "mailed-by", `List-Unsubscribe` (https and mailto hosts) and no "via". It must include an Outlook.com mailbox that
  lands in the inbox, which is the deciding check for Shape B.
- **"Send me a test" to contact@ from contact@** goes Mailgun → Zoho with SPF/DKIM passing. Whether Zoho's spoofing
  checks flag mail "from itself" is **Unknown**; try it once.
- **Region:** keep every Mailgun domain in the US (the root is verified there). If the owner wants EU, move both before
  go-live (§3.4). The app's single `mailgun.region` then stays correct.
