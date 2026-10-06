# Research (checked 2026-09-27): one shared From address (contact@polygonparadise.com) with per-person Reply-To — replies, auto-replies, bounces, reputation, inbox oddities

Written for the design that follows the Owner's decision of 2026-09-27: every outreach email arrives
`From: "Arslan from Polygon Paradise" <contact@polygonparadise.com>` (display name per teammate), with a per-person
`Reply-To` on a Mailgun reply subdomain (e.g. `arslan@mail.polygonparadise.com`). polygonparadise.com keeps its MX at the
Owner's normal mailbox provider, and that MX must never point to Mailgun. This file is about how the mail ecosystem
behaves with that shape. It changes no code and makes no decision. Nothing here called Mailgun, Anthropic or Cloudflare.
The only live look-ups were public DNS queries (8.8.8.8) and public documentation pages.

**Labels**

- **[C] confirmed**: stated by a primary source that was fetched on 2026-09-27 (RFC, vendor documentation, vendor
  source code). The quote and URL are given.
- **[L] likely**: follows from confirmed facts, or is widely observed, but no primary source says it in so many words.
- **[U] unknown**: could not be confirmed. The web-search budget of this session ran out before this file was written,
  so some pages could not be found. Every [U] item is listed again in §7 with how to settle it (usually a 10-minute test
  by the Owner after setup).
- **Observed**: a public DNS query made from this PC on 2026-09-27.

---

## Summary

1. **The Owner's contact@ mailbox is Zoho Mail, not Gmail or Microsoft 365** (Observed: MX `mx.zoho.com`,
   `mx2.zoho.com`, `mx3.zoho.com`). DNS is still at GoDaddy (`ns57/58.domaincontrol.com`). Points 4 and 5 are
   therefore mostly about Zoho.
2. **Which Mailgun domain sends matters more than the From line.** Mailgun's envelope sender (Return-Path) is on the
   Mailgun domain itself [C], and "Mailgun can track delayed bounces, but only if the domain that the email message was
   sent from has MX records pointing to Mailgun" [C]. If polygonparadise.com (the domain in the Owner's screenshots) is
   the Mailgun sending domain, asynchronous bounces, RFC 3834 auto-replies and probably `mailto:` unsubscribes go to
   Zoho, where they are rejected or lost, and the app's bounce counters under-count. **Improvement to the lead's shape:**
   make `mail.polygonparadise.com` (MX → Mailgun) the Mailgun sending domain, which sets the Return-Path, the tracking
   host and the reply routes, and put `contact@polygonparadise.com` only in the `From:` header. DMARC's relaxed alignment
   accepts this [C], Gmail and Yahoo accept relaxed alignment [C], and Outlook shows no "via" tag for a subdomain [C].
3. **Normal replies go to Reply-To.** RFC 5322 says so [C], Thunderbird's source code does it [C], and Gmail, Outlook,
   Apple Mail and Yahoo are widely observed to do it too [L]. Our emails have one recipient and no Cc, so Reply-all adds
   nobody. Thunderbird's Reply-all does not add the From address [C]. Apple Mail and the mobile apps are [U].
4. **Some real replies will reach contact@ only and never the app** [L]: a new email typed to contact@ (the only address
   the prospect sees in the From line), a colleague who got a forward and writes to the address shown in it, replies
   from clients that ignore Reply-To, and every later message in a conversation the teammate continued from Zoho. No
   public data says how often this happens [U]. These are the worst kind of miss (M4 research §8.1): follow-ups keep
   going to someone who answered.
5. **Automatic replies are split three ways.** RFC 3834 and Sieve vacation send to the Return-Path, never to Reply-To or
   From [C]. Postmark reports "some 'out of office' replies" at the Return-Path [C]. Where Gmail, Exchange/Outlook, Yahoo
   and Zoho send theirs is not documented in any page that could be reached [U]; they probably go to the Reply-To or From
   address. RFC-compliant Sieve responders "SHOULD NOT respond" at all to mail with `List-Unsubscribe` [C], and Mailgun
   adds that header to every email. Exchange sends no OOF for mail filed as junk [C].
6. **Delivery-failure notices (DSNs) go to the envelope sender with a null sender** [C, RFC 5321]. With
   `mail.polygonparadise.com` as the Mailgun domain they reach Mailgun, which turns them into events. With the root as
   the Mailgun domain they reach Zoho's `bounce+…@polygonparadise.com`, which is rejected (no such mailbox, and the null
   sender means nobody hears about it) or lands in a Zoho catch-all [L].
7. **DMARC: no record on polygonparadise.com today** (Observed). DKIM on the root is already published for Mailgun
   (`mx._domainkey`, 1024-bit) and for Zoho (`zmail._domainkey`, 1024-bit) (Observed). A root record
   `v=DMARC1; p=none; rua=mailto:dmarc@mail.polygonparadise.com` changes nothing for the Owner's daily mail ("none: The
   Domain Owner offers no expression of preference" [C]). It satisfies the Gmail/Yahoo "at least p=none" rule, and
   reports to a subdomain of the same organisation need no authorisation record [C].
8. **SPF is nearly full: 9 of 10 DNS look-ups** (Observed; GoDaddy's managed includes → `include:zohomail.com` and
   `include:mailgun.org`). One more `include:` of a typical service breaks SPF for everything on polygonparadise.com,
   including the Owner's Zoho mail. Zoho's own guide: "Do not exceed 10 DNS lookups" [C]. With the improved shape, the
   root no longer needs `include:mailgun.org` (4 look-ups left).
9. **Reply-To on a different subdomain is low risk for spam filters.** DMARC never looks at Reply-To [C, by definition].
   rspamd's `REPLYTO_DOM_NEQ_FROM_DOM` has score 0.0 [C], and SpamAssassin's Reply-To rules fire only for free-mail
   addresses [C]. Gmail, Yahoo and Microsoft publish nothing about Reply-To [C: absent from their pages]. What commercial
   gateways (Mimecast, Proofpoint …) do with a Reply-To mismatch is [U].
10. **The real cost is reputation, and it lands on the Owner's everyday email.** "Each IP and DKIM domain has a
    reputation" (Yahoo [C]). Gmail counts bulk status over "the same primary domain" [C] and refuses mitigation above 0.3%
    spam [C]. Spamhaus's DBL lists "domain names with poor reputation" and is checked against the MAIL FROM domain and
    against "domains appearing in the mail headers and body e.g., URLs or contact email addresses" [C]. Zoho signs the
    Owner's normal mail with the same `d=polygonparadise.com`. If complaints rise, client replies, quotes and invoices
    from contact@ go to spam too [L].
11. **Inbox oddities in Zoho** [L/U]: mail sent through Mailgun never appears in Zoho's Sent folder. Forwarded replies
    arrive as lone "Re: …" messages "from the prospect". A teammate who answers from Zoho takes the conversation out of
    the app's sight. Whether Zoho hides or de-duplicates "Send me a test" (From contact@ to contact@ through another
    server) is [U]. The Gmail "same sender and recipient" hiding reported by Mailgun's help centre is [U] (403).
12. **Getting contact@-only mail into the app** needs forwarding at Zoho to a store-only Mailgun route. It needs a paid
    Zoho plan ("the Email Forwarding feature will not be available" for new Free-plan users [C]) and a verification email
    the app must show to the Owner. It also carries a privacy cost: all contact@ mail would pass through Mailgun and the
    app. Microsoft 365 blocks external auto-forwarding by default for new organisations (`5.7.520`) and stops OOF replies
    on a mailbox with SMTP forwarding [C]. The cheapest safety net is a quick "Mark as replied" path in the app and plain
    words to the Owner.

---

## 0. Starting facts

### 0.1 DNS today (Observed, 2026-09-27, resolver 8.8.8.8)

| Name | Type | Value |
|---|---|---|
| `polygonparadise.com` | NS | `ns57.domaincontrol.com`, `ns58.domaincontrol.com` (GoDaddy; not yet moved to Cloudflare) |
| `polygonparadise.com` | MX | `10 mx.zoho.com`, `20 mx2.zoho.com`, `50 mx3.zoho.com` |
| `polygonparadise.com` | TXT (SPF) | `v=spf1 include:dc-8e814c8572._spfm.polygonparadise.com include:dc-f2ba48d2cc._spfm.polygonparadise.com ~all` |
| `dc-8e814c8572._spfm.polygonparadise.com` | TXT | `v=spf1 include:zohomail.com ~all` |
| `dc-f2ba48d2cc._spfm.polygonparadise.com` | TXT | `v=spf1 include:mailgun.org ~all` |
| `_dmarc.polygonparadise.com` | TXT | **none** (NXDOMAIN) |
| `mx._domainkey.polygonparadise.com` | TXT | Mailgun's key, `k=rsa; p=MIGfMA0…` (216-character `p=`, so **1024-bit**) |
| `zmail._domainkey.polygonparadise.com` | TXT | Zoho's key, `v=DKIM1; k=rsa; p=MIGfMA0…` (**1024-bit**) |
| `email.polygonparadise.com` | CNAME | `mailgun.org` (the **US** tracking target; EU would be `eu.mailgun.org`) |
| `mail.polygonparadise.com` and every name under it (`MX`, `TXT`, `_dmarc`, `email.`, `mx._domainkey.`, `pdk1._domainkey.`) | — | **NXDOMAIN**: nothing is published yet |

- SPF look-up count (RFC 7208 §4.6.4 counts `include`, `a`, `mx`, `ptr`, `exists` and `redirect`; see
  deliverability-dns.md): `dc-8e…` (1) → `zohomail.com` (2) → `spf.zohomail.com` (3, ip4 only); `dc-f2…` (4) →
  `mailgun.org` (5) → `_spf.mailgun.org` (6) → `_spf1` (7) and `_spf2` (8); `_spf.eu.mailgun.org` (9). **Total 9 of 10.**
- So the screenshots match DNS: the root's SPF includes Mailgun, Mailgun's DKIM is published, the US tracking CNAME is
  in place, and the MX stays at Zoho (Mailgun shows it "unverified"). If `mail.polygonparadise.com` was added in Mailgun,
  none of its records exist in DNS yet.

### 0.2 Two ways to put contact@ in the From line

| | **Shape A**: Mailgun sending domain = `polygonparadise.com` | **Shape B** (recommended): Mailgun sending domain = `mail.polygonparadise.com`, `From:` header on the root |
|---|---|---|
| Envelope sender / Return-Path | on `polygonparadise.com` → MX Zoho | on `mail.polygonparadise.com` → MX Mailgun |
| DKIM `d=` | `polygonparadise.com` (strict alignment) | `polygonparadise.com` when the subdomain shares the root's DKIM authority (Mailgun's default when both are in one account), else `mail.polygonparadise.com` (relaxed alignment) |
| SPF alignment | strict (Return-Path = From domain) | relaxed (same organisational domain) |
| Async bounces reach Mailgun | **no** | yes |
| Reply routes (`arslan@mail…`) | need a second Mailgun domain anyway | same domain |
| Tracking / unsubscribe host | `email.polygonparadise.com` (exists) | `email.mail.polygonparadise.com` (new CNAME) |
| Region | root is US (screenshots, tracking CNAME) | whatever `mail.` was created in; routes, events and webhooks are region-bound |

Evidence for the rows:

- [C] Mailgun's mail-from host is the Mailgun domain itself: "This does not effect the smtp mail-from host for the domain
  being created. The mail-from host will remain the domain name being created, not the root domain." (OpenAPI
  `force_root_dkim_host`) —
  https://documentation.mailgun.com/_bundle/docs/mailgun/api-reference/send/mailgun.yaml
- [C] DKIM authority sharing: `force_dkim_authority`: "If set to false, the domain will have the same DKIM authority as
  the root domain registered on the same mailgun account. Default to false." Also `PUT /v3/domains/{name}/dkim_authority`:
  "You can delegate the domain authority to an other domain. Domain's authority is set to itself by default." — same
  OpenAPI bundle. `o:secondary-dkim` ("Specify a second domain key to sign the email with … formatted as
  `signing_domain/selector`") can add a second signature per message.
- [U] Whether DKIM authority sharing works when the root is in the US region and `mail.` in the EU region. Whether
  Mailgun adds a `Sender:` header when `From:` is outside the sending domain (Outlook would then show "on behalf of").
  Whether `mailfrom_host` (`PUT /v4/domains`, "The hostname to update to. Must be in lower case") lets Shape A move its
  Return-Path to a subdomain, and which DNS records that needs. Nothing more is documented.
- [C] Mailgun's advice on mismatched domains: "While it is not required to use the same domain in the From field of the
  message as the actual domain sending the message, it is highly recommended. Outlook/Hotmail is especially finicky
  about this requirement and has a higher propensity to filter your messages to junk if the two domains do not match."
  — https://documentation.mailgun.com/docs/mailgun/email-best-practices/dns.md . [L] Microsoft's own rule (§3.5) treats
  a subdomain as matching, so Shape B should not trip this. Shape B keeps both domains inside polygonparadise.com.
- [C] The same Mailgun page: "We suggest that you use your top level domain for your corporate mail and using different
  domains or subdomains for your marketing and transactional mail." The Owner's decision goes against this, knowingly.

---

## 1. Where human replies go when From ≠ Reply-To

### 1.1 The standard

- [C] RFC 5322 §3.6.2: "When the "Reply-To:" field is present, it indicates the address(es) to which the author of the
  message suggests that replies be sent." And: "In the absence of the "Reply-To:" field, replies SHOULD by default be
  sent to the mailbox(es) specified in the "From:" field unless otherwise specified by the person composing the reply."
- [C] RFC 5322 §3.6.3: "the mailboxes of the authors of the original message (the mailboxes in the "From:" field) or
  mailboxes specified in the "Reply-To:" field (if it exists) MAY appear in the "To:" field of the reply". For
  reply-all: "addresses in the "To:" and "Cc:" fields of the original message MAY appear in the "Cc:" field of the
  reply". — https://www.rfc-editor.org/rfc/rfc5322.html
- So the standard lets Reply-To *replace* From. It never asks a client to add From as well.

### 1.2 Clients

| Client | Reply | Reply-all | Label and evidence |
|---|---|---|---|
| **Thunderbird** | Reply-To (`compFields->SetTo(replyTo)`; From only when there is no Reply-To) | Reply-To plus the original To (the prospect, removed as self). **From is added only** when Reply-To looks like a list address that munged the reply (`overrideReplyTo && … replyTo.Find(listPost)`), which never applies to us | [C] source: https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/compose/src/nsMsgCompose.cpp (`QuotingOutputStreamListener::OnStopRequest`) |
| **Gmail (web, Android, iOS)** | Reply-To | Reply-To, plus other To/Cc | [L] universally observed. Google documents only the sending side: "If you only change the 'From' address, replies will go to your original Gmail address by default" (https://support.google.com/mail/answer/22370), which shows the ecosystem honours Reply-To. No page on how Gmail builds a reply-all was found [U] |
| **Outlook (Windows, Mac, web, mobile), Outlook.com, Microsoft 365** | Reply-To | Reply-To, plus others | [L] widely observed; Outlook has its own "Have replies sent to" option. No Microsoft page states the reply-all rule [U] |
| **Apple Mail (macOS, iOS)** | Reply-To | [U]: some users report that Reply-all also adds the From address | [L] for Reply, [U] for Reply-all |
| **Yahoo Mail, AOL** | Reply-To | [U] | [L] |
| **Zoho Mail** (a prospect using Zoho) | [U] | [U] | — |
| **Samsung Email, other Android apps** | [U] | [U] | — |

**What this means for us.** Our emails have one `To` (the prospect) and no `Cc` (one recipient per request,
mailgun-sending.md). So Reply-all normally reaches the same Reply-To address. If a client does add the From address,
contact@ gets a second copy. The app still gets its copy through the route, and if contact@ also forwards to the app
(§5), the twin rule (same Message-ID, same sender: `findTwinSource`, `src/server/services/replies/link.ts`) keeps it from
counting twice.

### 1.3 New emails typed to the From address

- [U] No public study measures how often recipients start a *new* email to the address shown in the From line instead
  of pressing Reply. Nobody publishes this for cold email.
- [L] Ways it will still happen:
  - The prospect copies the address from the From line or from a contact card. Contact cards are keyed by the From
    address, and all teammates now share contact@, so a prospect's address book holds one "contact@polygonparadise.com"
    entry with whichever display name it saw last.
  - They reply days later from a different device by typing "Polygon" into the To box. Autocomplete may offer contact@
    (seen in the From line) or the Reply-To address (if they replied before and their client saved it). Which one is [U].
  - The website and the email footer or signature show contact@. The M3 footer carries the business address; if a
    signature template shows an email address, it should be the Reply-To address or none.
- Where it lands: contact@ in Zoho only. The app never sees it unless §5 is built.

### 1.4 Forwarded emails

- [L] A forward shows the original's From line in the quoted header block ("From: Arslan from Polygon Paradise
  <contact@polygonparadise.com>", then Date/Sent, To, Subject). Reply-To is not part of the usual forward header block.
  Talon's forward and header patterns (quoted in replies-and-auto-replies.md §7) list From, Date/Sent, To and Subject
  only.
- So a colleague who got the forward and writes to "the sender" writes to **contact@ → Zoho only**.
- A colleague who presses Reply on the forward writes to the *forwarder*, not to us (unchanged from today).
- If the forwarder Replies-all to our original with the colleague in Cc, it goes to the Reply-To address plus the
  colleague, and the app sees it (unchanged).

### 1.5 After the first reply

- [L] A teammate answers the prospect from Zoho as contact@ (the forwarded copy's Reply goes to the prospect). That
  answer has no Reply-To, so every later message in that conversation goes to **contact@ only**. The app sees the first
  reply of a conversation and nothing after it.
- This matches today's design, where each person answers from their own reply inbox, but the addresses now look
  identical to the prospect. That is good for the prospect and bad for anyone who assumes the app has the whole thread.

---

## 2. Automatic replies and delivery-failure notices

### 2.1 What the standards say

- [C] RFC 3834 §4 (https://www.rfc-editor.org/rfc/rfc3834.html):
  - "In general, automatic responses SHOULD be sent to the Return-Path field if generated after delivery."
  - "A Personal or Group responder SHOULD NOT deliver a response to any address other than that in the Return-Path
    field."
  - "The Reply-To field SHOULD NOT be used as the destination for automatic responses from Personal or Group
    Responders."
  - "Use of the From field as the destination for automatic responses has some of the same problems as use of
    Reply-To." "The Return-Path address is really the only one from the message header that can be expected, as a matter
    of protocol, to be suitable."
- [C] RFC 5230 (Sieve vacation, https://www.rfc-editor.org/rfc/rfc5230.txt):
  - §4.2: "Vacation's messages are always addressed to the Return-Path address (that is, the envelope from address) of
    the message being responded to."
  - §4.6: "Implementations SHOULD NOT respond to any message that contains a 'List-Id' [RFC2919], 'List-Help',
    'List-Subscribe', 'List-Unsubscribe', 'List-Post', 'List-Owner', or 'List-Archive' [RFC2369] header field."
  - §5.1: "The SMTP MAIL FROM address of the message envelope SHOULD be set to <>."
- [C] Mailgun adds `List-Unsubscribe` and `List-Unsubscribe-Post` to every email of ours (mailgun-sending.md, from
  Mailgun's help article). **So an RFC 5230-compliant vacation responder should not answer our emails at all.**
- [C] RFC 5321, for bounces after acceptance: the server "MUST construct an 'undeliverable mail' notification message and
  send it to the originator of the undeliverable mail (as indicated by the reverse-path)", and "When such a message is
  transmitted, the reverse-path MUST be set to null". — https://www.rfc-editor.org/rfc/rfc5321.html

### 2.2 What real systems document

| System | Where its auto-reply goes | Other facts that matter here |
|---|---|---|
| Sieve vacation (Dovecot/Pigeonhole, many hosts) | Return-Path [C, RFC 5230 §4.2] | skips mail with `List-Unsubscribe` [C, §4.6] |
| Microsoft 365 / Exchange OOF | **[U]**: Microsoft's troubleshooting page doesn't say which address OOFs go to | "only one reply is sent to each sender"; "Because OOF rules have a blank (<>) return path…"; "If the email message is marked as spam and sent to Junk, an automatic reply isn't generated at all"; "If the affected user mailbox has SMTP forwarding enabled, OOF replies won't be generated" [C] — https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/understand-troubleshoot-oof-replies |
| Gmail / Google Workspace vacation responder | **[U]**: "The help page does not specify whether replies go to the sender's address or a reply-to address" | "In most cases, your reply is only sent to people the first time they message you"; again after four days; "Emails sent to your spam folder or addressed to a mailing list you subscribe to don't get your reply" [C] — https://support.google.com/mail/answer/25922 |
| Zoho Mail vacation reply | [U]: Zoho's help page couldn't be found (two guessed URLs gave 404) | — |
| Yahoo, iCloud, GMX/WEB.DE | [U] | frequencies in replies-and-auto-replies.md §2 |
| What ESPs see | [C] Postmark's bounce type "AutoResponder": "Autoresponder is an automatic email responder including nondescript NDRs and some 'out of office' replies." — https://postmarkapp.com/developer/api/bounce-api . So at least some OOFs reach the Return-Path (an ESP's bounce address). | — |

[L] Taken together: RFC-style responders go to the Return-Path, and the big webmail systems probably reply like a person,
to Reply-To (else From). That is widely reported, but no vendor page confirms it [U]. The Owner's first real test should
settle it (§7).

### 2.3 Where each kind of message lands

"App" means the message reaches a Mailgun route on the reply subdomain and is stored by the app. "Mailgun only" means
Mailgun receives it at its bounce address. For DSNs that becomes a `failed` event the app already reads. For non-DSN
mail there, what Mailgun does is [U]; it is probably dropped, as it is in today's separate-domain design.

| Message | Shape A (Mailgun domain = root) | Shape B (Mailgun domain = `mail.`) |
|---|---|---|
| Reply from a client that honours Reply-To (the usual case) | App (+ forwarded to the reply inbox) | App (+ forwarded) |
| Reply from a client that ignores Reply-To; Reply-all in a client that adds From | contact@ only (the Reply-all copy: both) | same |
| New email typed to contact@; a forwarded colleague writing "to the sender"; later messages after a teammate answered from Zoho | **contact@ only** | **contact@ only** |
| Auto-reply sent to the Return-Path (RFC 3834, Sieve, "some" OOFs) | `bounce…@polygonparadise.com` at Zoho: rejected as an unknown mailbox (null sender, so nobody is told), or a Zoho catch-all mailbox if one is set [L] | Mailgun only [L] |
| Auto-reply sent to Reply-To (probably Gmail/Outlook-style responders) [U] | App (classified AUTO_REPLY, M4) | App |
| Auto-reply sent to From | contact@ only | contact@ only |
| Asynchronous DSN (accepted, then bounced later; Return-Path, null sender) | **lost**, or a Zoho catch-all [L]; Mailgun can't count it: "Mailgun can track delayed bounces, but only if the domain that the email message was sent from has MX records pointing to Mailgun" [C] | Mailgun → `failed` event → app [C] |
| Non-standard bounce sent to the header From (rare; M4 research §4.4) | contact@ only | contact@ only |
| Challenge-response ("confirm you are human") | [U]: depends on the product; Return-Path or From | same |
| `mailto:` one-click unsubscribe in `List-Unsubscribe` (Mailgun's `mailto:u+…@<domain>`, mailgun-sending.md) | `u+…@polygonparadise.com` at Zoho: **unsubscribe lost** [L]; the https link still works | Mailgun [L] |
| DMARC aggregate reports (`rua=` on the root) | where the record points, e.g. `dmarc@mail.polygonparadise.com` (existing dmarc@ route) | same |

Sources: https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-failures.md (the delayed
bounce quote and "The recipient SMTP server accepts an email message during the SMTP session. After some time, it will
send a Non-Delivery Report email message to the message sender."); mailgun-sending.md (the `mailto:u+…@<domain>` form of
Mailgun's List-Unsubscribe, from help.mailgun.com article 203306610).

**Answer to the question "which replies and auto-replies land only in contact@ and never reach the app":**
- In both shapes: new emails typed to contact@, colleagues writing from a forward, replies from clients that ignore
  Reply-To, every message after a teammate continues the thread from Zoho, auto-replies addressed to the From line, and
  non-standard bounces to the From line.
- Shape A adds a worse class: async DSNs, RFC 3834 auto-replies and `mailto:` unsubscribes go to polygonparadise.com's
  MX. Zoho most likely rejects them (they are addressed to `bounce…@`/`u+…@` mailboxes that don't exist), so they reach
  neither the app nor a person, and Mailgun's bounce and unsubscribe records miss them.
- What is lost matters unevenly. Missed auto-replies mostly cost information ("left the company", "new contact"). Missed
  human replies cost follow-ups to someone who answered. Missed DSNs and unsubscribes cost health numbers and legal
  standing.

---

## 3. Deliverability and reputation of cold email From the main domain

### 3.1 DMARC alignment

- [C] RFC 9989 (DMARC; https://www.rfc-editor.org/rfc/rfc9989.html):
  - §3.2.10.1: "When the Author Domain has the same Organizational Domain as an Authenticated Identifier, the two are
    said to be in relaxed alignment."
  - §3.2.10.2: "When the Author Domain is identical to an Authenticated Identifier, the two are said to be in strict
    alignment."
  - §4.4.2: "DMARC relies solely on SPF validation of the MAIL FROM identity."
  - §4.7: `adkim` and `aspf`: "default is 'r'" (relaxed).
- [C] Google: "the organizational domain in the sender From: header must be aligned with either the SPF organizational
  domain or the DKIM organizational domain." — https://support.google.com/a/answer/14229414 . Also "For direct email,
  the domain in the sender's From: header must be aligned with either the SPF domain or the DKIM domain." —
  https://support.google.com/a/answer/81126
- [C] Yahoo: "Ensure the domain in the From: header is aligned with either the SPF domain or the DKIM domain" and
  "Relaxed alignment is acceptable". — https://senders.yahooinc.com/best-practices/
- What passes:
  - Shape A: DKIM `d=polygonparadise.com` (strict) and SPF on `polygonparadise.com` (strict).
  - Shape B: DKIM `d=polygonparadise.com` (strict, with the root's DKIM authority) or `d=mail.polygonparadise.com`
    (relaxed), and SPF on `mail.polygonparadise.com` (relaxed, once that name has `v=spf1 include:mailgun.org ~all`).
  - Either one aligned pass is enough.
- [L] Both Mailgun and Zoho DKIM keys on the root are 1024-bit (Observed). That is accepted everywhere today. A 2048-bit
  key (deliverability-dns.md) is stronger. Changing the root's Mailgun key is optional and doesn't touch Zoho's.

### 3.2 A DMARC record on the root

- Today there is none (Observed), so polygonparadise.com mail has "no DMARC". Gmail and Yahoo require at least `p=none`
  for bulk senders [C], and Microsoft does too above 5,000 a day (deliverability-dns.md).
- Suggested first record, at `_dmarc.polygonparadise.com`:
  `v=DMARC1; p=none; rua=mailto:dmarc@mail.polygonparadise.com`
  - [C] "none: The Domain Owner offers no expression of preference" (RFC 9989 §4.7). Receivers change nothing for mail
    that fails, so it is safe for the Owner's everyday Zoho mail, the website's forms and any other tool that sends as
    polygonparadise.com.
  - [C] Reports to another organisation need an authorisation record only when "the Organizational Domain at which that
    record was discovered is not identical to the Organizational Domain of the host part of the authority component"
    (RFC 9990 §4, https://www.rfc-editor.org/rfc/rfc9990.html). `mail.polygonparadise.com` is the same organisation, so
    no extra record is needed. The existing dmarc@ route (M3) receives them.
  - [C] The subdomain inherits it: "If both the sp tag is absent and the np tag is either absent or not applicable, the
    policy specified by the p tag MUST be applied for subdomains" (RFC 9989 §4.7). `mail.polygonparadise.com` may keep
    its own `_dmarc` record; the checklist already walks the tree (deliverability-dns.md row 7).
- Later tightening (`quarantine`/`reject`) affects *every* service that sends as polygonparadise.com: Zoho (DKIM
  `zmail`, fine), Mailgun (fine), and possibly the website host, invoicing or form tools (unknown). Only tighten after
  reading the reports. The app should never suggest tightening the root automatically.

### 3.3 SPF

- One record per name; more than one is a permerror (RFC 7208 §4.5, deliverability-dns.md). The root has one record,
  managed by GoDaddy as two `_spfm` includes (Observed).
- **9 of 10 look-ups used** (Observed, §0.1). [C] Zoho: "Do not exceed 10 DNS lookups, as this will cause the SPF check
  to fail." — https://www.zoho.com/mail/help/adminconsole/spf-configuration.html . An SPF permerror would hit the
  Owner's everyday Zoho mail first.
- Shape A needs the root's `include:mailgun.org` (the Return-Path is on the root).
- Shape B does not: the Return-Path is on `mail.polygonparadise.com`, which gets its own `v=spf1 include:mailgun.org
  ~all`. The root's Mailgun include can then be removed (4 look-ups left) or kept (harmless, still 9).
- Any new service that sends as polygonparadise.com (a CRM, a newsletter tool) must not add another include without
  someone counting first.

### 3.4 Google, Yahoo and Mailgun rules

- [C] Google (https://support.google.com/a/answer/81126 and /14229414):
  - "Keep spam rates reported in Postmaster Tools below 0.10% and avoid ever reaching a spam rate of 0.30% or higher."
  - "Beginning June 2024, bulk senders with a user-reported spam rate greater than 0.3% will be ineligible for
    mitigation."
  - "When we calculate the 5,000-message limit, we count all messages sent from the same primary domain."
  - "One-click unsubscribe is required only for marketing and promotional messages." Cold outreach is best treated as
    promotional; the app already relies on Mailgun's `List-Unsubscribe` + `List-Unsubscribe-Post`.
  - "Don't send messages to people who didn't sign up to get messages from you." "Make sure recipients opt in to get
    messages from you." Cold email is outside Google's guidelines whatever the From address. The From address only
    decides whose reputation pays.
- [C] Yahoo: "Keep your spam rate below 0.3%"; one-click list-unsubscribe "for marketing and subscribed messages";
  "Publish a valid DMARC policy with at least p=none - DMARC must pass". — https://senders.yahooinc.com/best-practices/
- Mailgun's AUP complaint limit of 0.08% (mailgun-inbound-validation-domain.md) is the tightest and is already the app's
  auto-pause default. At 500–1,000 a day, one complaint in 1,000 is 0.1%.

### 3.5 Reply-To on a different (sub)domain, and "via" labels

- [C] DMARC evaluates the Author Domain, i.e. the `From:` header (RFC 9989), never Reply-To.
- [C] rspamd: `REPLYTO_DOM_NEQ_FROM_DOM`, "Reply-To domain does not match the From domain", `score = 0.0`. It compares
  full domains (`util.strequal_caseless(from[1].domain, rt[1].domain)`), so `mail.polygonparadise.com` ≠
  `polygonparadise.com` fires it, with no score. — https://raw.githubusercontent.com/rspamd/rspamd/master/rules/headers_checks.lua
- [C] SpamAssassin: `FREEMAIL_REPLYTO` ("Reply-To/From or Reply-To/body contain different freemails"),
  `FREEMAIL_FORGED_REPLYTO` ("Freemail in Reply-To, but not From") and `FREEMAIL_REPLYTO_END_DIGIT` all require a
  free-mail Reply-To. — https://raw.githubusercontent.com/apache/spamassassin/trunk/rules/20_freemail.cf
- [C] Gmail's sender guidelines and FAQ contain nothing about Reply-To; neither does Yahoo's page.
- [U] Commercial gateways and Microsoft Defender custom rules may flag "Reply-To differs from From" as a BEC sign. None
  documented publicly. A same-organisation Reply-To is the mildest form.
- [C] Outlook's "via" tag appears "if the domain in the From address … is different from the domain in the DKIM
  signature or the MAIL FROM address", and the fix is to "confirm the domain in the DKIM signature or the MAIL FROM
  address matches (or is a subdomain of) the domain in the From address." — https://learn.microsoft.com/en-us/defender-office-365/anti-phishing-policies-about .
  Shape B's `mail.polygonparadise.com` is a subdomain, so no "via" [C].
- [C] Gmail: "You'll find 'via' and a website name next to the sender's name if: The domain it was sent from doesn't
  match the domain in the 'From:' address." — https://support.google.com/mail/answer/1311182 . Whether Gmail treats a
  subdomain as matching is [U]. With the root's DKIM authority (`d=polygonparadise.com`), there is nothing to mismatch
  [L].

### 3.6 The concrete risk to everyday contact@ email

- [C] "Each IP and DKIM domain has a reputation, which can impact the delivery of your email." "By segregating your email
  according to function, you help ensure that your mail receives the best delivery possible." (Yahoo)
- [C] Microsoft on partners that send through marketing services: the long-term fix is to "Use a subdomain for service
  messages (for example, `marketing.fabrikam.com`) with proper SPF and DKIM alignment." —
  https://learn.microsoft.com/en-us/defender-office-365/anti-phishing-protection-spoofing-about
- [C] Spamhaus DBL: "a list of domain names with poor reputation"; it "includes domains which are used in unsolicited bulk
  email"; it is checked against "the Mail From domain" and "domains appearing in the mail headers and body e.g., URLs or
  contact email addresses". — https://www.spamhaus.org/blocklists/domain-blocklist/
- [L] What happens if complaints rise:
  - Gmail's spam rate and Yahoo's DKIM-domain reputation are judged on polygonparadise.com, the same `d=` that Zoho
    signs the Owner's normal mail with. Replies to clients, quotes, invoices and website-form answers from contact@ start
    landing in spam, first at Gmail/Yahoo, then elsewhere.
  - Above 0.3% at Gmail, no mitigation until 7 clean days (deliverability-dns.md).
  - A DBL listing would hit every email that mentions polygonparadise.com, including links to the website, and some
    filters block the web links too.
  - A Mailgun suspension (AUP) stops outreach only; Zoho keeps working.
  - Recovery takes weeks, and the Owner's business email is the hostage.
  - Note for balance: with a separate sending domain the root was already exposed a little through website links in the
    body. The new shape moves the full signing reputation onto the root.
- Mitigations (recommendations, need the design's OK):
  1. Shape B, so bounces and unsubscribes are counted and honoured (§2.3). Otherwise the health auto-pause flies blind.
  2. Keep or tighten the health auto-pause: complaints ≥ 0.08% and bounces 3% (existing). Consider a slower warm-up and
     a lower first daily cap for the root's first weeks. The root has a history of low-volume personal mail, not
     500–1,000 a day.
  3. Add `polygonparadise.com` to Google Postmaster Tools (the TXT `google-site-verification` exists; which property it
     verifies is [U]) and watch spam rate and domain reputation. Postmaster shows data only at higher volumes, so the
     app's own counters remain the main signal.
  4. DMARC `p=none` with reports on the root (§3.2).
  5. Only verified addresses, the 30-day rule and one-click unsubscribe (already in the app).
  6. A written fallback: if the root's reputation drops, switch the From address back to a separate domain
     (`validateSendingDomain` still supports one) and stop using the root for outreach.

---

## 4. Oddities in the contact@ inbox

### 4.1 Zoho Mail (the actual mailbox)

- [L] Nothing sent through Mailgun appears in Zoho's Sent folder. Zoho only files what Zoho sent.
- [C] Zoho: "The conversation settings do not apply to the sent folder. The emails in the sent folder will be displayed
  as separate entities." Zoho doesn't document how it groups a conversation ("The emails that are a part of the same
  conversation are grouped together") [U: by subject or by References]. —
  https://www.zoho.com/mail/help/conversation-view.html
- So a forwarded reply arrives as a lone "Re: <subject>" message, quoting our text, with the prospect as the sender
  (Mailgun's route forward keeps the original `From:` [L]). This is the same as notifications-and-threading.md B3.6
  today.
- [L] A teammate who answers from Zoho replies to the prospect directly, as contact@. The app sees neither the answer nor
  anything after it (§1.5). Every teammate's replies land in one shared mailbox, so the team needs a habit (Zoho
  folders or tags per person) to tell whose conversation it is. The Reply-To route adds nothing to the forwarded copy
  that says which teammate it was for, except the `To:`/`Delivered-To:` headers [L].
- [U] "Send me a test" (From contact@, To contact@, through Mailgun):
  - It passes DKIM (root key) and SPF (Mailgun is in the root's SPF), so Zoho should accept it [L].
  - Whether Zoho shows it as "from me", files it oddly, or puts it in spam is [U]. The Zoho spam-control pages found
    don't describe own-domain spoof handling in detail.
  - If it doesn't appear, the Owner should use another address for the test (the M3 design already suggests a
    different mailbox for route tests).
- [U] Whether Zoho applies ARC (Mailgun adds ARC to routed mail) when a forwarded reply from a `p=reject` domain fails
  DMARC after Mailgun's forward. Observed policies: yahoo.com and aol.com `p=reject`; icloud.com, gmx.de and web.de
  `p=quarantine`; gmail.com, outlook.com and hotmail.com `p=none`. The M3 reply test checks this per mailbox and should
  keep doing so with contact@ as the reply inbox.

### 4.2 Gmail / Google Workspace (if any teammate's reply inbox is Gmail)

- [U] Mailgun's help centre article "Why do I not receive an email sent to my route when the sending and receiving email
  addresses match" (https://help.mailgun.com/hc/en-us/articles/203306560…, 403 to our fetcher; already quoted as
  UNVERIFIED in mailgun-inbound-validation-domain.md) says Gmail hides such messages. Our forwarded replies are *from the
  prospect*, so this bites only when From = the Gmail inbox itself, e.g. "Send me a test" to a Gmail reply inbox that
  has contact@ configured as a "Send mail as" alias.
- [L] Gmail's de-duplication of your own sent messages (mailing-list copies) works by Message-ID. A Mailgun-sent message
  has a new Message-ID that isn't in that Gmail account's Sent folder, so it isn't de-duplicated.

### 4.3 Microsoft 365 (if any reply inbox or test-list mailbox is M365)

- [C] Microsoft calls it "Intra-org spoofing … Also known as self-to-self spoofing" when "The sender and recipient are in
  the same domain". A failure shows `compauth=fail reason=6xx`. "Composite authentication passes > Message is delivered
  normally." — https://learn.microsoft.com/en-us/defender-office-365/anti-phishing-protection-spoofing-about
- [L] Aligned DKIM makes composite authentication pass, so "Send me a test" to an M365 mailbox on polygonparadise.com
  would be delivered. This matters only if contact@ ever moves to M365.

### 4.4 The reply test and the test list

- The M3 reply test (§1.5 of M3-DESIGN) still works: test-list mailboxes get an email From contact@ with the Reply-To,
  reply, and the app sees the reply. It then reaches contact@ in Zoho, the reply inbox.
- A test-list mailbox must not auto-forward to contact@ (it would muddy "Reply reached the app" vs "arrived in your
  inbox").
- Add to the Owner's checks: whether Gmail shows "via", whether Outlook.com shows "on behalf of" or "via", and where an
  out-of-office reply lands (§7).

---

## 5. Getting mail that lands only in contact@ into the app

| Option | How | Gains | Costs and risks |
|---|---|---|---|
| **a. Zoho mailbox forwarding, keep a copy** | Zoho › Settings › Mail Accounts › forwarding to a *store-only* route address, e.g. `copy@mail.polygonparadise.com` (route: `store(notify=…)` + `stop()`, **no forward**) | Every contact@ message reaches the app, including new emails, forwarded colleagues and From-addressed auto-replies | [C] "For the new users who signed up under the Free plan, the Email Forwarding feature will not be available." [C] "A confirmation email will be sent to the added email address. Email forwarding will be enabled only after you verify the account." That email lands in the app, which must show it to the Owner. [C] Keep "Delete original email copy after forwarding" unchecked; at most "3 destination accounts" per user. [U] Envelope rewriting (SRS) and DMARC of forwarded copies. **Privacy:** all contact@ mail, including clients, invoices and personal mail, passes through Mailgun and the app. **Noise:** the app must drop everything that doesn't link (see implications). Uses a Mailgun route (Free plan: 1 route, Basic: 5). — https://www.zoho.com/mail/help/email-forwarding.html |
| **b. Zoho filter → "Forward to"** | a filter with conditions, action "Forward to" the store-only route | Less private mail leaves Zoho | [C] Filter forwarding exists ("In the Action, select Forward to and specify the email address"). [U] Whether a filter can match a header such as `In-Reply-To`/`References` (ideal: contains `pp.`) or only sender, subject, To/Cc and priority. A subject rule ("Re:") leaks and misses. Same plan and verification limits as (a) [L] |
| **c. Gmail / Google Workspace forwarding** (only if a reply inbox is Gmail) | Gmail forwarding or a filter's "Forward to" | Same as (a)/(b) | [C] "After you add a forwarding email address, we send a verification link to the address." [C] "We forward all new messages to the account, except for spam." [C] Filters can forward selected mail. [U] Gmail's envelope rewriting on forwards, and Workspace admin routing (dual delivery) details. — https://support.google.com/mail/answer/10957 |
| **d. Microsoft 365 forwarding** (only if a mailbox is M365) | mailbox (SMTP) forwarding or an Inbox rule | Same | [C] External auto-forwarding was changed to "**Off - Forwarding is disabled** for new organizations" and is blocked with "5.7.520 Access denied, Your organization does not allow external forwarding." [C] SRS "rewrites the MAIL FROM address" and "doesn't affect the From address"; "SRS rewriting doesn't resolve the issue of forwarded messages not passing DMARC checks." [C] "If the affected user mailbox has SMTP forwarding enabled, OOF replies won't be generated." — https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding · https://learn.microsoft.com/en-us/exchange/reference/sender-rewriting-scheme · the OOF page above |
| **e. People in the loop** | In the app: "Mark as replied" / link a reply to a company (M4 already has linking for unlinked replies) | No plumbing, no privacy cost | Relies on teammates remembering. The app should make it one click from the company panel and remind in the reply notice ("Did they answer at contact@ instead?") |
| **f. Fewer leaks at the source** | Signatures show the teammate's Reply-To address (or none), never contact@. Keep one recipient per email | Cheap | Doesn't catch forwards or typed addresses |
| ~~g. Root MX to Mailgun~~ | — | — | Forbidden by the Owner's rule |

Things to watch with (a)–(d):

- **Loops.** The per-person route forwards to contact@. If contact@ forwards back to that *same* route, mail circulates.
  The target must be a separate store-only address whose route never forwards.
- **Duplicates.** A reply that came through the Reply-To route also reaches contact@ and is forwarded back. The copy has
  the same Message-ID and sender, so the app's twin rule handles it (`findTwinSource`). `storeInbound` de-duplicates
  only by storage key, or by the same Message-ID *and the same `toAddress`*, so the copy is stored as a second row and
  then becomes a twin [C, `src/server/services/mail-events/inbound-store.ts`].
- **The app's own mail.** "Send me a test", the Owner's own messages and replies from teammates will also be forwarded.
  `internalSenders()` treats team addresses and reply inboxes as internal.
- **Retention.** The app clears reply texts 30 days after processing (M4). A forward-everything copy route would still
  hold every contact@ message's first lines (`snippet`) for good, unless the design drops unlinked copies at once.

---

## 6. Implications for the app

**What the app must do** (inputs for the design; none of this is built or approved):

1. **Separate "the From address" from "the sending domain".**
   - Keep the Mailgun sending domain a subdomain whose MX points to Mailgun, e.g. `mail.polygonparadise.com`
     (Shape B). It carries the Return-Path, the tracking and unsubscribe host, the Message-IDs and the reply routes.
     `validateSendingDomain` keeps refusing the root.
   - Add a shared From address (`contact@polygonparadise.com`), allowed only on the sending domain's organisational
     domain (the root or one of its subdomains).
   - The `RESERVED_LOCAL_PARTS` rule ("contact") keeps applying to per-person *reply* addresses, not to this From
     address.
   - Refuse Shape A, or warn loudly. With the root as the Mailgun domain, async bounces and `mailto:` unsubscribes are
     lost (§2.3).
2. **Set `h:Reply-To` on every send** to the person's reply address, with the display name "<First name> from Polygon
   Paradise" in `From:`. M3 left the hook (`OutgoingMessage.replyTo`, "Setup C"). Test mode, reply tests, "Send me a
   test" and follow-ups all need it. Threading headers are unchanged.
3. **Domain checklist rows for the From domain, not only the sending domain:**
   - DMARC on the root (missing today; suggest `p=none` with `rua` to the dmarc@ route).
   - Alignment: a DKIM `d=` or Return-Path domain whose organisational domain equals the From domain.
   - The root's SPF look-up count (9 of 10 today; warn at 9, red above 10).
   - Never suggest tightening the root's DMARC automatically, because it governs the Owner's everyday mail.
4. **`internalSenders()` must include the shared From address** even when it is nobody's reply inbox, so mail from
   contact@ (the Owner answering, forwarded copies, tests) never holds or links a company as a prospect.
5. **If a contact@ copy route is built (§5 a/b):**
   - Make it a distinct route kind: store-only, never forwards, excluded from "reply reached the app" on the reply test.
   - Keep and process only messages that link by thread headers or by the From address of a recently emailed person.
     Drop the rest at once (no UNLINKED rows or notifications for ordinary customer mail), and show the Zoho
     verification email to the Owner.
   - Twins are already handled.
6. **Make "They replied at contact@" easy.** A one-click "Mark as replied" on the company panel, and a line in the reply
   and follow-up UI: "Replies sent to contact@ don't reach the app."
7. **Health and warm-up:** keep the complaint auto-pause at ≤ 0.08%. Consider a lower starting cap for the root's first
   weeks, and a notice when the complaint rate passes half the limit ("Your everyday contact@ email is at risk").
8. **Reply test additions** (manual answers, like M3's): Gmail "via" shown? Outlook "on behalf of" or "via"? Where did
   an out-of-office reply from a test mailbox land (the app, contact@, nowhere)? Did a Reply-all from Apple Mail also go
   to contact@?

**What the Owner must be told** (plain words, for the guide):

1. "Most replies come back through the app. But if someone writes a new email to contact@, or a colleague they
   forwarded your email to writes to contact@, the app doesn't see it and keeps sending follow-ups. When you spot one,
   click **Mark as replied** on that company."
2. "When you answer a prospect from your contact@ inbox, the rest of that conversation stays in your inbox. The app only
   knows about the first reply."
3. "Emails sent by the app don't appear in your contact@ Sent folder. The app's timeline has them."
4. "Your everyday contact@ email now shares its reputation with the outreach. If too many people press 'spam', your
   normal emails to clients can start landing in spam too, and it takes weeks to recover. The app pauses sending early
   to protect it. Please don't raise the limits."
5. "Keep your Zoho mail servers (MX) exactly as they are. Never point polygonparadise.com's MX to Mailgun."
6. "Your SPF record is almost full (9 of 10). Before adding any other email service to polygonparadise.com, ask first,
   or your normal email can fail checks."
7. DNS to-do list (GoDaddy): add `_dmarc.polygonparadise.com` = `v=DMARC1; p=none; rua=mailto:dmarc@mail.polygonparadise.com`.
   Add the `mail.polygonparadise.com` records from the app's checklist (MX → Mailgun, SPF, DKIM if not shared, the
   tracking CNAME `email.mail`). Create `mail.polygonparadise.com` in Mailgun in the **same region as the account's other
   domain**. The root looks US today; the region can't be changed later.
8. "If you want the app to also see emails people send straight to contact@, Zoho can forward a copy. That needs a paid
   Zoho plan, a one-time verification code, and means all contact@ email passes through Mailgun and the app."
9. "Cold email to people who never signed up is against Gmail's guidelines and Mailgun's rules whatever address it
   comes from. Using contact@ doesn't change that. It only changes whose name is on the line."

---

## 7. Could not be confirmed (and how to settle each)

| Item | How to settle |
|---|---|
| Which address Gmail's vacation responder, Exchange/Outlook OOF, Zoho, Yahoo and Apple auto-replies use (Return-Path vs Reply-To vs From) | Owner's first real test: turn on an out-of-office in one test-list Gmail and one Outlook.com mailbox, send a test email, and see where the auto-reply lands (app timeline, contact@, or neither) |
| Whether Gmail, Outlook, Apple Mail and Yahoo add the From address on Reply-all when Reply-To is set | Same test: Reply-all from each test mailbox (and an iPhone if available) |
| How often prospects write a new email to the From address | No public data; count "Mark as replied" clicks and contact@-only replies after go-live |
| Mailgun: Return-Path format, whether non-DSN mail at the bounce address reaches routes, `Sender:` header when From ≠ sending domain, `mailfrom_host` semantics, DKIM authority across regions, route-forward envelope (SRS) | Show original of a test email (Return-Path, DKIM `d=`, any `Sender:`); ask Mailgun support; never probe from tests |
| Gmail "via" for a subdomain DKIM/Return-Path | Show original / look at the sender line in the Gmail test mailbox |
| Zoho: vacation-reply target, own-address mail from an external server, filter header conditions, forwarding envelope rewriting, ARC | Zoho admin console and one test each; Zoho help pages for these weren't found |
| Which property the root's `google-site-verification` TXT verifies | Postmaster Tools › domains |
| Gmail hiding mail "from and to the same address" (Mailgun help centre, 403) | Use a different mailbox for "Send me a test" if it doesn't arrive |
| Commercial gateways' Reply-To-mismatch rules | Not testable by us; low impact |

## Sources (fetched 2026-09-27 unless marked)

- RFCs: https://www.rfc-editor.org/rfc/rfc5322.html · https://www.rfc-editor.org/rfc/rfc5321.html ·
  https://www.rfc-editor.org/rfc/rfc3834.html · https://www.rfc-editor.org/rfc/rfc5230.txt ·
  https://www.rfc-editor.org/rfc/rfc9989.html · https://www.rfc-editor.org/rfc/rfc9990.html · RFC 7208 via
  deliverability-dns.md
- Mailgun: https://documentation.mailgun.com/docs/mailgun/email-best-practices/dns.md ·
  https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-failures.md ·
  https://documentation.mailgun.com/docs/mailgun/email-best-practices/bounce_esp.md ·
  https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-verify.md ·
  https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/route-actions.md ·
  https://documentation.mailgun.com/_bundle/docs/mailgun/api-reference/send/mailgun.yaml (`force_dkim_authority`,
  `force_root_dkim_host`, `dkim_host_name`, `o:secondary-dkim`, `mailfrom_host`, `/v3/domains/{name}/dkim_authority`) ·
  https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domains/put-v4-domains--name- ·
  help.mailgun.com 203306560 (403, UNVERIFIED) · earlier: mailgun-sending.md, mailgun-inbound-validation-domain.md
- Google: https://support.google.com/a/answer/81126 · https://support.google.com/a/answer/14229414 ·
  https://support.google.com/mail/answer/25922 · https://support.google.com/mail/answer/1311182 ·
  https://support.google.com/mail/answer/22370 · https://support.google.com/mail/answer/10957
- Yahoo: https://senders.yahooinc.com/best-practices/
- Microsoft: https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/understand-troubleshoot-oof-replies ·
  https://learn.microsoft.com/en-us/exchange/reference/sender-rewriting-scheme ·
  https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding ·
  https://learn.microsoft.com/en-us/defender-office-365/anti-phishing-protection-spoofing-about ·
  https://learn.microsoft.com/en-us/defender-office-365/anti-phishing-policies-about
- Zoho: https://www.zoho.com/mail/help/email-forwarding.html · https://www.zoho.com/mail/help/filters.html ·
  https://www.zoho.com/mail/help/conversation-view.html · https://www.zoho.com/mail/help/adminconsole/spf-configuration.html ·
  https://www.zoho.com/mail/help/adminconsole/organization-spam-control.html (no detail on own-domain spoofing)
- Others: https://postmarkapp.com/developer/api/bounce-api ·
  https://raw.githubusercontent.com/rspamd/rspamd/master/rules/headers_checks.lua ·
  https://raw.githubusercontent.com/apache/spamassassin/trunk/rules/20_freemail.cf ·
  https://www.spamhaus.org/blocklists/domain-blocklist/ ·
  https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/compose/src/nsMsgCompose.cpp
- Local: `src/core/sender-address.ts` (`WEBSITE_DOMAINS`, `RESERVED_LOCAL_PARTS`),
  `src/server/services/mail-events/inbound-store.ts` (`storeInbound` de-duplication),
  `src/server/services/replies/link.ts` (`findTwinSource`),
  `src/server/services/mail-events/internal-senders.ts`, M3-DESIGN §1.5 (reply test), replies-and-auto-replies.md,
  notifications-and-threading.md, deliverability-dns.md
- DNS (Observed): public queries to 8.8.8.8 for the names in §0.1, the SPF includes of zoho/mailgun, and `_dmarc` of
  gmail.com, yahoo.com, outlook.com, hotmail.com, icloud.com, aol.com, gmx.de, web.de, zoho.com
