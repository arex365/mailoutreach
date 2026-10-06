# Research (M4 prep, checked 2026-09-23): replies, auto-replies, bounce notices, threading and quoting

This is the implementation reference for M4's reply classification (PLAN B6.10, stop rules in B6.4). It covers which
headers mark automatic mail, what the common mail systems actually send, out-of-office and delivery-failure wording in
ten languages, challenge-response mail, replies from other addresses, quote stripping, and a recommended classifier
with 40 classification vectors and 15 quoting vectors. The classifier sketch in Appendix A was run against all 55
vectors with Node 24 (all pass). It is a reference, not the production code. Re-verify anything marked UNVERIFIED
before relying on it.

**Labels used below**

- **[V]**: confirmed on a primary source fetched on 2026-09-23 (RFC, IANA, vendor docs, or the vendor's own source
  code). The source is listed in §11.
- **[R]**: reported by a secondary source that is named. Not confirmed by the vendor.
- **UNVERIFIED**: not confirmed. It comes from common usage or general knowledge. Treat it as a heuristic, and make sure a
  wrong guess costs little (see §8.1).

Nothing in this document sends email. All examples use the fake Mailgun (`tests/fake-mailgun/**`), and §9 lists what
the fake needs for M4.

---

## Summary

1. **Headers.** `Auto-Submitted` other than `no` is the only standard marker. RFC 3834 defines `auto-generated` and
   `auto-replied`, and IANA also registers `auto-notified` (RFC 5436) [V]. A null envelope sender (`<>`) is just as
   strong: RFC 3834 responders, Sieve vacation, DSNs and MDNs use it, and Microsoft documents that OOF replies "have a
   blank (<>) return path" [V]. `X-Autoreply`/`X-Autorespond` are non-standard but reliable where present.
2. **Two headers in PLAN B6.10 are weaker than PLAN assumes.** `X-Auto-Response-Suppress` asks others not to
   auto-reply to the message carrying it. Microsoft's own auto-replies carry it, but so does Zendesk's outgoing mail
   [V] (agent replies too, by our reading). Senders also set it on ordinary mail [R]. `Precedence` "is not a standard header field"
   (RFC 3834) [V]. Both should be *supporting* evidence only (§8.2). `Precedence: auto_reply` stays strong.
3. **Help desks.** Zendesk lists `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: All` and
   `X-Mailer: Zendesk Mailer` as headers its outgoing email carries [V]. Applying that to agent replies too is our
   reading of the page (it doesn't separate notifications from agent replies). So a human agent's reply looks
   automatic by headers alone. Treat help-desk mail with acknowledgement
   wording ("Your request (N) has been received…") as an auto-reply, and all other help-desk mail as POSSIBLE_REPLY.
4. **Check bounces first.** Exim adds `Auto-Submitted: auto-generated` to its bounces [V], so bounce detection must run
   before auto-reply detection. The best signal is the top-level `Content-Type: multipart/report;
   report-type=delivery-status` (RFC 3464) in `message-headers` [V]. Delay notices (`Action: delayed`) are
   BOUNCE_NOTICE with `autoReason "delay"` and stop nothing.
5. **Subjects.** Outlook's OOF subject is "Automatic reply: <subject>". Its language follows the mailbox language [R],
   so a Norwegian company may send "Automatisk svar:" or the English form. Gmail, GMX, WEB.DE and T-Online let the user
   write their own subject, or copy the original. Subject lists alone therefore miss many OOFs, and headers plus body
   phrases are needed.
6. **How often each system replies.** Exchange: once per sender while the OOF is on [V]. Gmail: again after 4 days
   [V]. iCloud: once per 24 h [V]. GMX/WEB.DE: once per 30 days [V]. One follow-up can therefore produce another OOF.
7. **What M3 doesn't store.** It keeps a 300-character, whitespace-collapsed `snippet`, and throws away the envelope
   `sender` and the line structure of the body. M4 should store `envelopeSender`, `strippedText` and `bodyText`
   (newlines kept) (§0.3). For rows stored under M3, classify from the snippet: the phrase regexes still work, but
   quote cutting doesn't.
8. **Threading.** Gmail and Outlook replies set `In-Reply-To` to our Message-ID and include it in `References`
   (RFC 5322 §3.6.4 [V]; Exchange maps both headers to MAPI properties [V]). Outlook's `Thread-Index` is useless for
   linking, because our emails have none. Thunderbird forwards carry `References: <forwarded id>` and
   `X-Forwarded-Message-Id` [V]. So a colleague's reply to a forward can still carry our ID.
9. **Linking and message type are separate questions.** Classify the message first (reply / auto / bounce / possible),
   then link it. The UNLINKED kind is only for human mail that can't be linked. An auto-reply or bounce notice with no
   link keeps its own kind, with null links and no notification (backscatter is common).
10. **Quoting.** Use Mailgun's `stripped-text` when it is present (talon-based, "best effort", and absent when parsing
    fails [V]). Otherwise cut `body-plain` at the first attribution line, Outlook header block, "Original Message" or
    forward separator. The regexes in Appendix A handle en/de/nb/nn/sv/da/nl/fr/es/it/pl (15 quoting vectors).
11. **When unsure, ask the sender.** Mark a message AUTO_REPLY only on one strong signal or two medium ones. A single
    medium signal gives POSSIBLE_REPLY: the company's follow-ups stop and the sender is asked. This extends PLAN's
    POSSIBLE_REPLY (which PLAN uses only for recovered replies with no text) and needs an OK (§10).
12. **Other automatic mail.** Challenge-response ("confirm you are human"), read receipts (RFC 8098 MDN) and "no
    longer with the company" messages are AUTO_REPLY with their own `autoReason`. The first and last need a sender
    notification because the sender has to act. Never follow a challenge link automatically.

---

## 0. What the classifier has to work with

### 0.1 Mailgun inbound fields (from `mailgun-api-reference.md` §13.2, re-checked)

| Field | Use for classification | Notes |
|---|---|---|
| `sender` | **envelope MAIL FROM**: empty or `<>` means the null sender | "The sender of the message as reported by MAIL FROM during SMTP chat" [V]. How a null sender is shown (`""`, `"<>"` or a missing field) is UNVERIFIED, so accept all three. |
| `from`, `subject` | From header, decoded subject | Mailgun's `subject` field is assumed to be RFC 2047-decoded (UNVERIFIED). If it still contains `=?…?=`, decode it. |
| `message-headers` | every header, in order, including the top-level `Content-Type` | A JSON string of `[name, value]` pairs. Names repeat and case varies (`subject` vs `Subject`) [V]. |
| `stripped-text` | the reply's new text | "text version of the message without the quoted parts and signature block (if found)"; "If this process does fail: these fields are not present" [V] |
| `body-plain` | the full text | "always present"; Mailgun generates it when the email has only HTML [V] |
| `attachments` | content types of the parts | JSON metadata `[{url, content-type, name, size}]`. Whether a DSN's `message/delivery-status` part shows up here is UNVERIFIED. |
| header `X-Envelope-From` | second place to find the envelope sender | Mailgun's blog lists it among inbound headers, next to `X-Mailgun-Incoming` [V, Mailgun blog]. One published sample shows the value `""` [R, griddler issue #122]. |

Mailgun's own blog also lists `Content-Type`, `In-Reply-To`, `Message-Id` and `References` among the POSTed fields
for route forwards [V, Mailgun blog]. This supports the note in the API reference that raw headers also arrive as
top-level fields, but only for `forward()` POSTs. Keep reading them from `message-headers`.

### 0.2 What M3 stores (`InboundMessage`, `src/core/mailgun/inbound.ts`)

`fromEmail`, `fromName`, `subject` (≤ 500), `snippet` (stripped-text, else body-plain, whitespace collapsed, ≤ 300
characters), `messageIdHeader`/`inReplyTo`/`references` (lowercase, without `<>`), `headers` (all pairs, capped at
200 pairs / 32 KB; a header that doesn't fit is skipped), `toAddress`, `senderAddressId`, `kind: null`,
`autoReason: null`, `source`, `processedAt: null`. Our own Message-IDs are `pp.<24 hex>@<sending domain>`, lowercase
(`src/server/services/sending/addresses.ts`).

### 0.3 Recommended additions for M4 (need an OK)

| Addition | Why |
|---|---|
| `InboundMessage.envelopeSender String?` (`""` = null sender; `null` = unknown), filled from `sender` / stored-message `sender` / Logs `envelope.sender` | The null sender is one of the two strongest auto/bounce signals, and M3 discards it. |
| `InboundMessage.strippedText String?` (≤ 8 KB, newlines kept) and `bodyText String?` (body-plain, ≤ 16 KB, newlines kept) | Quote cutting, body phrases in the first lines, DSN fields (`Final-Recipient`, `Status`), and our Message-ID inside NDRs all need line structure and more than 300 characters. |
| `InboundMessage.partTypes Json?` (content types from `attachments`) | Catches `message/delivery-status` and `message/disposition-notification` parts if Mailgun lists them there (UNVERIFIED). |
| The header cap keeps an allow-list of headers first | `Content-Type`, `Auto-Submitted`, `X-Auto*`, `Precedence`, `X-Precedence`, `List-*`, `X-Envelope-From`, `X-Mailer`, `X-Zendesk-*`, `X-Failed-Recipients`, `X-Loop`, `X-MS-Exchange-Inbox-Rules-Loop`, `Feedback-ID`, `Delivered-To`. A 32 KB budget is normally plenty, but DKIM/ARC blocks and long `Received` chains come first. |

M3 rows have none of these, so the classifier falls back to the `snippet` (§8.4).

---

## 1. Headers that mark automatic mail

Read every header case-insensitively. For structured values, drop `(comments)` and `;params`, then lowercase the
first token. `Auto-Submitted: auto-replied (vacation); owner-email="x@y"` becomes `auto-replied`.

| Header | Defined by | Values | What it means on a message we receive | Strength here |
|---|---|---|---|---|
| `Auto-Submitted` | RFC 3834 §5 [V]; IANA registry [V] | `no` (a human wrote it), `auto-generated` ("not direct responses to other messages", e.g. cron jobs), `auto-replied` ("sent in direct response to another message by an automatic process"; MAY be used on DSNs/MDNs), `auto-notified` (Sieve notifications, RFC 5436, IANA) [V], extension values | Automatic unless the value is `no`. RFC 3834 §2: "Automatic responses SHOULD NOT be issued in response to any message which contains an Auto-Submitted header field … where that field has any value other than 'no'." [V] Exchange Online OOFs carry `auto-generated` (confirmed by Microsoft staff on Microsoft Q&A) [V]. Exim bounces carry `auto-generated` [V]. Zendesk's outgoing mail carries `auto-generated` [V] (all of it, by our reading, agent replies included). | **Strong**, except on help-desk mail (§2.8) and bounce notices (checked earlier) |
| `X-Autoreply` | not standard | usually `yes` ("always seems to have a value of yes" [R, arp242]) | Automatic. Gmail vacation replies carry `X-Autoreply: yes` and `Auto-Submitted: auto-replied` [R, ladedu.com]. | **Strong** unless the value is `no`/`false`/`0` |
| `X-Autorespond`, `X-Autoresponder` | not standard | any | Automatic. FreeScout treats either header as auto-reply whatever its value [V, FreeScout source]. Jitbit calls `X-Autoreply`/`X-Autorespond`/`Auto-Submitted: auto-replied` "safe" [R]. | **Strong** |
| `X-Auto-Response-Suppress` | Microsoft [MS-OXCMAIL] 2.1.3.2.20 [V] | Comma-separated: `DR` (delivery reports), `NDR`, `RN` (read notifications), `NRN`, `OOF`, `AutoReply` ("auto-reply messages other than OOF"), or `All` / `None` | A **request** to *other* systems: "don't auto-reply to this message". It is written by clients and servers on outgoing mail. Exchange writes `All` on its automatic replies (archived Microsoft blog: `X-Auto-Response-Suppress: All` and `X-MS-Exchange-Inbox-Rules-Loop` "prevents the situation like storms and loops") [V]. Zendesk's outgoing mail carries `All` [V] (agent replies too, by our reading). Exchange 2003/2007 and Outlook 2003/2007 don't generate it, and Outlook 2010–2019 don't read it [V]. Jitbit warns that filtering on it lost them real mail [R]. `None` means nothing is suppressed. | **Medium**, and only when the value contains `All`, `OOF` or `AutoReply` |
| `Precedence` (also `X-Precedence`) | not standard. RFC 3834 §2: "Because Precedence is not a standard header field … no particular responder behavior in the presence of Precedence is recommended" [V] | `bulk`, `junk`, `list`, `auto_reply` (also seen: `auto-reply`, `first-class`) | Microsoft: to suppress all automatic replies, clients "MAY, instead, write a Precedence header with any value" [V]. Discourse treats `list\|junk\|bulk\|auto_reply` as auto-generated [V, source]. FreeScout does the same for `auto_reply, bulk, junk, list` [V, source]. Zammad uses `bulk\|list\|junk` [V, source]. | `auto_reply` = **strong**; `bulk`/`junk`/`list` = **medium** |
| `List-Id`, `List-Unsubscribe`, `List-Post`, `List-Help`, `List-Subscribe`, `List-Owner`, `List-Archive` | RFC 2919 / RFC 2369 (RFC numbers from memory, not re-fetched) | any | Sent by a list or bulk system. RFC 3834 §2: "a responder MAY ignore any subject message with a List-* field" [V]. Sieve vacation "should decline" to reply to them (RFC 5230 §4.6) [V]. On a reply to us, it points to a CRM autoresponder or a marketing tool. | **Medium** |
| `Feedback-ID` | Gmail's bulk-sender identifier | any | "Gmail uses this header to identify newsletters" [R, arp242] | **Medium** |
| `X-Loop`, `X-MS-Exchange-Inbox-Rules-Loop` | not standard; Exchange | an address, or `yes` | Loop protection that automatic systems add. Exchange stamps `X-MS-Exchange-Inbox-Rules-Loop` on inbox-rule auto-replies (and rule forwards) [V, archived MS blog]. Zammad treats `X-Loop: yes\|true` as automatic [V, source]. | **Medium** |
| `X-MS-Exchange-Generated-Message-Source: Mailbox Rules Agent` | Exchange | — | Search-result summaries of Microsoft Tech Community pages report it on inbox-rule auto-replies. The page itself could not be read, so UNVERIFIED. | **Medium** (optional) |
| `X-Autogenerated` (e.g. `Reply`), `X-AutoReply-From`, `X-Mail-Autoreply`, `X-FC-MachineGenerated: true`, `Delivered-To: Autoresponder` | various, not standard | — | Only `Delivered-To: Autoresponder` was confirmed, in FreeScout's check list [V, source]. The others are UNVERIFIED names seen in other filters. Don't rely on them. | `Delivered-To: Autoresponder` = strong; the others = medium |
| Null sender: envelope `MAIL FROM:<>` / `Return-Path: <>` | RFC 3834 §3.3 ("a MAIL FROM address of <> MAY be used") [V]; RFC 5230 §5.1 (vacation "SHOULD be set to <>") [V]; RFC 3464 (DSN `MAIL FROM:<>`) [V]; RFC 8098 §3 (MDN "MUST be null") [V]; Microsoft: "OOF rules have a blank (<>) return path" [V]. RFC 3834 §2 also says responders "MUST NOT generate any response" to a null sender [V]. | — | Human mail never has a null envelope sender. Read it from Mailgun `sender` or `X-Envelope-From`. `Return-Path` is added at final delivery and may not be in Mailgun's header list (UNVERIFIED). | **Strong** (auto, or bounce when bounce signals are also present) |
| `X-Mailer` | not standard | e.g. `Zendesk Mailer` [V] | Identifies help desks (§2.8). arp242 lists `Microsoft CDO for Windows 2000`, PHP and `MIME-tools` among mailers of mostly automatic mail [R]. Only useful to identify a help desk; no weight by itself. | Help-desk flag only |
| Message class `IPM.Note.Rules.OofTemplate.Microsoft` | Exchange (MAPI) | — | **Not visible to us**: pure-MIME messages don't copy `PidTagMessageClass`, and its value "is reflected in the structure of the MIME message" instead [V]. | — |

**Don't copy over-broad regexes.** Discourse flags a message when the *serialised header block* matches
`/auto[\-_]?(response|submitted|replied|reply|generated|respond)|holidayreply|machinegenerated/i`, with
`X-Auto-Response-Suppress` removed first [V, source]. That also matches `Auto-Submitted: no`. FreeScout's check treats
*any* `Auto-Submitted` value as automatic, including `no` [V, source]. Both are wrong under RFC 3834.

---

## 2. What real systems send

| System | How often | Subject | Headers / envelope | Status |
|---|---|---|---|---|
| **Gmail / Google Workspace vacation responder** | "only sent to people the first time they message you", then again when "the same person contacts you again after four days". No reply to mail in spam or "addressed to a mailing list you subscribe to". Can be limited to contacts or to your own domain. [V] | The user's text. The Gmail API says `responseSubject` is "Optional text to prepend to the subject line in vacation responses" [V]. Whether the original subject is actually appended is UNVERIFIED. | `X-Autoreply: yes`, `Auto-Submitted: auto-replied` [R, ladedu.com]. Envelope sender UNVERIFIED. `In-Reply-To`/`References` presumably set (it threads) — UNVERIFIED. | headers [R] |
| **Outlook.com / Microsoft 365 (Exchange Online) automatic replies** | "only one reply is sent to each sender" while replies are on. The OOF history resets when the OOF is switched or edited, and holds at most 10,000 entries [V]. Separate internal, external and "known senders" replies [V]. | "Automatic reply: <original subject>" (UNVERIFIED as an exact string; widely observed). The language follows the mailbox language: an admin can change it with `Set-Mailbox -Languages` [R, Slipstick]. So localised forms appear (§3). | `Auto-Submitted: auto-generated` [V, Microsoft staff on Q&A]; blank `<>` return path [V]; `X-Auto-Response-Suppress: All` on automatic replies [V, archived MS blog]; `Thread-Topic`/`Thread-Index` (Exchange adds these to all mail, UNVERIFIED for OOF). | mostly [V] |
| **Outlook inbox rule "have server reply using a specific message"** | "sends a response every time that a message is received" [V] | chosen by the user | `X-Auto-Response-Suppress: All`, `X-MS-Exchange-Inbox-Rules-Loop: <address>` [V, archived MS blog] | [V] |
| **Exchange Server on-premises** | same OOF engine; "much of this discussion also applies to an on-premises configuration" [V] | Older versions: "Out of Office AutoReply: …" / "Out of Office: …" (UNVERIFIED). Exchange 2010+: "Automatic reply: …" (UNVERIFIED). Slipstick reports "Autoreply: [subject]" for the first OOF message [R]. | Exchange 2003/2007 don't write `X-Auto-Response-Suppress` [V]. `Auto-Submitted` on older versions is UNVERIFIED. | partly |
| **Apple iCloud Mail auto-reply** | "Anyone who sends you multiple emails while you're away receives one autoreply in a 24-hour period" [V] | UNVERIFIED | UNVERIFIED (probably Sieve-style `Auto-Submitted: auto-replied`) | frequency [V] |
| **GMX / WEB.DE** "Abwesenheitsnotiz" / "Automatische Antwort" | "nur einmal innerhalb von 30 Tagen" per sender address. None is sent when forwarding is set up without keeping a copy. [V, both help pages] | Reported to reuse the original subject [R, search summary]. UNVERIFIED. | UNVERIFIED | frequency [V] |
| **T-Online (Telekom E-Mail Center)** "Abwesenheit" | UNVERIFIED | The user enters the subject [R, Telekom help via search summary] | UNVERIFIED | [R] |
| **Yahoo Mail** "Vacation response" | UNVERIFIED | UNVERIFIED | UNVERIFIED. A different response can be set for up to 2 specific domains [V]. | partly |
| **Sieve vacation** (Dovecot/Pigeonhole, many hosting providers; which providers use it is UNVERIFIED) | `:days` default "7 or the minimum value … whichever is greater" [V] | "Auto: " + original subject (RFC 5230 §5.3) [V] | `Auto-Submitted: auto-replied` SHOULD (§5.6); `In-Reply-To` MUST, `References` SHOULD (§5.8); MAIL FROM SHOULD be `<>` (§5.1) [V] | [V] |
| **Zendesk** | per trigger | The default "received request" subject is UNVERIFIED. Body of the default trigger "Notify requester and CCs of received request": "Your request ({{ticket.id}}) has been received and is being reviewed by our support staff. To add additional comments, reply to this email." [V] | "The below headers should persist throughout the outbound relay process": `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: All`, `X-Mailer: Zendesk Mailer`, `X-Zendesk-From-Account-Id`, `X-Zendesk-Email-Id` [V]. The page doesn't separate notifications from agent replies, so we assume all outgoing mail carries them. | [V]; "all mail" is our reading |
| **Freshdesk** | per notification: "New Ticket Created" is the requester acknowledgement [V] | Customisable. Ticket threading expects `[#{{ticket.id}}]` in the subject, e.g. "Ticket Received - {{ticket.subject}} - [#{{ticket.id}}]" [R, Freshdesk community] | UNVERIFIED (no documented `X-Freshdesk-*` names) | partly |

### 2.8 Help-desk rule (derived from the Zendesk facts)

- Mark mail as help-desk mail when `X-Mailer` matches `/zendesk|freshdesk|freshservice|help ?scout|zoho ?desk|kayako|osticket|otrs|znuny|zammad|servicenow|hubspot/i`
  or a header name starts with `X-Zendesk-` [V]. Other `X-<vendor>-` prefixes are UNVERIFIED.
- Help-desk mail **with** acknowledgement wording (§3.3) → AUTO_REPLY, `autoReason "helpdesk-ack"`.
- Help-desk mail **without** it → POSSIBLE_REPLY: it may be a human agent. Never treat its `Auto-Submitted` alone as
  proof.
- A ticket acknowledgement means a person may answer later from the ticket system. That later answer is a real reply,
  and it may come from `support@…` rather than from the person we emailed. Link it by headers (§6).

---

## 3. Wording: out-of-office, acknowledgements, challenge-response, "left the company"

The full lists are regex-ready in Appendix A (`AUTO_SUBJECT_PREFIX`, `ABSENCE`, `ABSENCE_COMPANION`, `AUTO_STATEMENT`,
`LEFT_COMPANY`, `ACK_*`, `CHALLENGE`). Matching is case-insensitive after NFC normalisation, with NBSP/U+202F turned
into spaces. French writes "Réponse automatique :" with a (narrow) no-break space before the colon.

**Evidence:** Discourse's production regex contains these real-world subject prefixes: `Auto:`, `Automatic reply`,
`Autosvar`, `Automatisk svar`, `Automatisch antwoord`, `Abwesenheitsnotiz`, `Risposta Non al computer`,
`Auto Response`, `Respuesta automática`, `Fuori sede`, `Out of Office`, `Frånvaro`, `Réponse automatique` [V, source].
"Auto: " is the RFC 5230/3834 prefix [V]. Everything else in this section is UNVERIFIED common usage. That is why
subject and body wording counts as a strong signal only in the narrow cases in §8.2.

### 3.1 Subject prefixes (strong only as a prefix, and only when the subject isn't our own subject with Re:)

| Language | Prefixes / whole subjects |
|---|---|
| English | Automatic reply, Auto reply, Auto-Reply, Autoreply, Auto Response, Automatic response, Automated response, Out of Office, Out of the office, OOO, Away from the office, Vacation reply, `Auto:` |
| German | Automatische Antwort, Autom. Antwort, Automatische Rückantwort, Abwesenheitsnotiz, Abwesenheitsmeldung, Abwesenheitsnachricht, Abwesenheit, Abwesend, Nicht im Büro, Außer Haus |
| Norwegian Bokmål | Automatisk svar, Autosvar, Fraværsmelding, Fravær, Ikke på kontoret |
| Norwegian Nynorsk | Automatisk svar, Fråværsmelding, Fråvær, Ikkje på kontoret |
| Swedish | Automatiskt svar, Autosvar, Frånvaro, Frånvaromeddelande, Inte på kontoret, Ej på kontoret |
| Danish | Automatisk svar, Autosvar, Fraværsbesked, Fravær, Ikke på kontoret |
| Dutch | Automatisch antwoord, Automatisch bericht, Afwezigheidsbericht, Afwezigheidsmelding, Afwezig, Niet op kantoor, Buiten kantoor |
| French | Réponse automatique, Réponse auto, Message d'absence, Absence du bureau, Absent(e) du bureau, Hors du bureau, Absence, Absent(e) |
| Spanish | Respuesta automática, Fuera de la oficina, Fuera de oficina, Ausencia, Ausente |
| Italian | Risposta automatica, Risposta Non al computer, Fuori sede, Fuori ufficio, Assenza, Assente |
| Polish | Automatyczna odpowiedź, Odpowiedź automatyczna, Autoodpowiedź, Poza biurem, Nieobecność, Nieobecny/Nieobecna |

**Medium subject words** count anywhere in a subject that isn't ours: vacation, holiday(s), annual leave, on leave,
Urlaub, Ferien, ferie, semester, vakantie, vacances, congé(s), vacaciones, urlop, permisjon, Elternzeit.

**Reply/forward prefixes** to strip before comparing a subject with ours (UNVERIFIED as a complete list): Re, RE, Aw,
AW, Antw, Antwort, SV, VS, Odp, R, RIF, Réf, Ref, Fw, Fwd, WG, TR, RV, Doorst, Enc. They can repeat and may carry
counters: `Re[2]:`.

### 3.2 First-line phrases (checked in the first 5 non-empty lines of the new text)

| Language | Absence statements ("I'm away") | Details that go with them (only counted together with an absence statement) | "This is an automatic reply" (strong) |
|---|---|---|---|
| English | I am / I'm (currently) out of the office · I will be out of the office · I am away · I'm on vacation / holiday / (annual/parental) leave · I am not in the office | limited access to email · for urgent matters · in urgent cases · upon my return · returning on · I'll be back · your email will not be forwarded | This is an automatic/automated reply/response/message · This message was automatically generated |
| German | Ich bin (derzeit/zurzeit/momentan) nicht im Büro · Ich bin im Urlaub · Ich bin abwesend · Ich bin nicht erreichbar · …bin ich nicht im Büro / im Urlaub / abwesend | In dringenden Fällen (wenden Sie sich bitte an) · nach meiner Rückkehr · bin ich wieder (erreichbar) · wieder im Büro · eingeschränkt erreichbar · Ihre E-Mail wird nicht weitergeleitet | Dies ist eine automatische Antwort · Dies ist eine automatisch generierte/erstellte Nachricht · Diese Nachricht wurde automatisch … |
| Norwegian Bokmål | Jeg er (for tiden / p.t.) ikke på kontoret · Jeg er på ferie · Jeg har ferie · Jeg er borte · Jeg er fraværende · …er jeg ikke på kontoret | i/ved hastesaker · når jeg er tilbake · tilbake på kontoret · begrenset tilgang til e-post | Dette er et automatisk svar · denne e-posten/meldingen er automatisk generert |
| Norwegian Nynorsk | Eg er ikkje på kontoret · Eg er på ferie · Eg har ferie · Eg er borte · Eg er fråverande | når eg er tilbake · avgrensa tilgang til e-post | Dette er eit automatisk svar |
| Swedish | Jag är inte på kontoret · Jag är på semester · Jag har semester · Jag är ledig · Jag är frånvarande | i/vid brådskande ärenden · när jag är tillbaka · begränsad tillgång till e-post | Detta är ett automatiskt svar |
| Danish | Jeg er ikke på kontoret · Jeg holder ferie · Jeg er på ferie · Jeg er fraværende · Jeg er ikke til stede | i hastende tilfælde · i presserende sager · når jeg er tilbage · begrænset adgang til e-mail | Dette er et automatisk svar · denne besked er automatisk genereret |
| Dutch | Ik ben (momenteel) niet op kantoor · Ik ben (momenteel) afwezig · Ik ben met/op vakantie · Ik ben niet aanwezig | voor dringende zaken · in dringende gevallen · na mijn terugkomst · weer aanwezig · beperkt bereikbaar | Dit is een automatisch antwoord · dit bericht is automatisch gegenereerd |
| French | Je suis (actuellement) absent(e) · Je serai absent(e) · Je suis en congé(s) · Je suis en vacances · Je ne suis pas au bureau | pour toute urgence · en cas d'urgence · à mon retour · de retour le · accès limité à mes e-mails | Ceci est une réponse automatique · Ceci est un message automatique · message généré automatiquement |
| Spanish | Estoy / Me encuentro fuera de la oficina · Estoy de vacaciones · Estaré ausente | para asuntos urgentes · en caso de urgencia · a mi regreso · volveré el · acceso limitado al correo | Esta es una respuesta automática · mensaje generado automáticamente |
| Italian | Sono fuori ufficio / fuori sede · Sarò assente · Sono in ferie · Non sono in ufficio | per urgenze · in caso di urgenza · al mio rientro · rientrerò il · accesso limitato alla posta | Questa è una risposta automatica · messaggio generato automaticamente |
| Polish | Jestem poza biurem · (Obecnie) przebywam poza biurem · Jestem na urlopie · Jestem nieobecny/nieobecna · Nie ma mnie w biurze | w pilnych sprawach · po (moim) powrocie · ograniczony dostęp do poczty | To jest automatyczna odpowiedź · wiadomość wygenerowana automatycznie |

### 3.3 Help-desk acknowledgements

- **Subject:** request/ticket/case received/created, Anfrage erhalten/eingegangen, henvendelse mottatt, ärende
  mottaget, demande reçue, solicitud recibida, richiesta ricevuta, zgłoszenie przyjęte… **together with** a ticket
  number (`[#5821]`, `(#5821)`, `#5821`, "Ticket 5821") or a `[bracketed]` tag.
- **Body:** "has been received and is being reviewed" (the Zendesk default [V]); "we have received your…", "a ticket
  has been created", "Wir haben Ihre Anfrage/Nachricht/E-Mail erhalten", "Vi har mottatt din henvendelse", "Nous
  avons bien reçu votre", "Hemos recibido su", "Abbiamo ricevuto la sua", "Otrzymaliśmy…" **together with** a
  ticket number.
- Acknowledgement wording without a ticket number counts only as a medium signal. A human may write "we have received
  your email and are interested".

### 3.4 Challenge-response ("please confirm you are human")

A challenge-response filter replies to unknown senders and asks them to "perform some action to assure delivery of the
original message": reply, click a link, or solve a CAPTCHA [V, Wikipedia]. Named systems: TMDA, and IBM FairUCE
(retired 2010). "Nowadays C/R systems are not used widely enough to make spammers bother" [V, Wikipedia]. Known
problems: backscatter to forged senders, and friction for strangers [V].

- **Wording:** confirm/verify (that) you are human, not a robot, sender verification, please confirm/verify your
  message, your message is being held, awaiting (your) verification/confirmation, challenge-response, approved senders
  list, Absenderbestätigung, Absenderverifizierung, "Bitte bestätigen Sie, dass Sie kein Roboter sind", "Ihre
  Nachricht wurde zurückgehalten", "bekreft at du er et menneske", avsenderverifisering, CAPTCHA (UNVERIFIED as a
  list).
- **Rule:** the wording in the subject, or in the first 10 lines of a body that contains a URL → AUTO_REPLY,
  `autoReason "challenge"`.
- **Actions:** notify the sender ("Their spam filter is holding your email until you confirm. Open it in your own
  inbox if you want to."), and never open the link from the app. Clicking would be an action on the sender's behalf,
  and fetching unknown URLs from the server is an SSRF risk. Follow-ups continue unless the sender stops them.

### 3.5 "No longer with the company"

"no longer with", "has left the company", "this mailbox is no longer monitored", "nicht mehr im Unternehmen",
"nicht mehr bei uns tätig", "har sluttet", "jobber ikke lenger", "eg har slutta", "har slutat", "arbejder ikke
længere", "is niet meer werkzaam", "a quitté l'entreprise", "ya no trabaja", "non lavora più", "nie pracuje już"
(UNVERIFIED as a list).

- **On an automatic message** (a strong auto signal is present): AUTO_REPLY, `autoReason "left-company"`. Notify the
  sender, showing any address found in the text ("suggested contact: info@firma.de").
- **Without an automatic signal** it is only medium, which gives POSSIBLE_REPLY. A successor who writes "Anna is no
  longer with us, I took over and want a quote" is a real reply (vector V39).

---

## 4. Delivery-failure notices (BOUNCE_NOTICE)

### 4.1 The standard shape (RFC 3464 [V])

```
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>          (MAIL FROM:<>)
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="…"

  part 1  text/plain                 human explanation ("Address not found …")
  part 2  message/delivery-status    Reporting-MTA: dns; mx.google.com
                                     Final-Recipient: rfc822; anna@firma.de
                                     Action: failed            (failed | delayed | delivered | relayed | expanded)
                                     Status: 5.1.1
                                     Diagnostic-Code: smtp; 550 5.1.1 …
  part 3  message/rfc822 or text/rfc822-headers   (the original, or its headers)
```

The DSN envelope sender "SHOULD be chosen to ensure that no delivery status reports will be issued in response to
the DSN itself", which means `MAIL FROM:<>` [V]. Microsoft maps its `REPORT.IPM.Note.NDR` to exactly this
multipart/report structure [V].

### 4.2 Recognising it from Mailgun fields, without the MIME

In order of strength (all checks are in `classify()` step 1):

1. **Certain:** the top-level `Content-Type` in `message-headers` is `multipart/report` with
   `report-type=delivery-status`. `report-type=disposition-notification` is a read receipt instead (§4.5).
2. **Certain:** `attachments[].content-type` includes `message/delivery-status` or `message/global-delivery-status`.
   Whether Mailgun exposes these parts there is UNVERIFIED.
3. **High:** two of the following. (a) The subject starts with a bounce phrase and has no reply prefix. (b) From is
   `mailer-daemon`/`postmaster`/"Mail Delivery System/Subsystem". (c) Bounce prose appears in the body. (d) The
   envelope sender is null. Also high on its own: DSN fields in the text (`Final-Recipient:` **and** `Status:`).
4. **Medium:** a bounce subject alone.

`postmaster@` alone is not enough: at a small company it can be a person, so it only counts as a medium signal.

### 4.3 Subjects and first lines

| Source | Subject / From / first lines | Status |
|---|---|---|
| Gmail | From "Mail Delivery Subsystem" `mailer-daemon@googlemail.com`, subject "Delivery Status Notification (Failure)" | [V] |
| Gmail delay | "Delivery Status Notification (Delay)" | UNVERIFIED |
| Microsoft 365 / Exchange | Sent from `postmaster@outlook.com`, `postmaster@microsoft.com` or `service.microsoft.com` for consumer mail [V]. Body: "Delivery has failed to these recipients or groups:", then "Diagnostic information for administrators", "Generating server:", the enhanced status code, and "Original message headers" [V]. Subject "Undeliverable: <subject>", delay "Delivery delayed: <subject>" | body [V], subject UNVERIFIED |
| Exim | Subject "Mail delivery failed", with ": returning message to sender" when sender = bounce recipient; body starts "This message was created automatically by mail delivery software."; adds `Auto-Submitted: auto-generated`. Delay: "Warning: message $message_exim_id delayed $warn_message_delay" [V]. `X-Failed-Recipients:` header | [V]; `X-Failed-Recipients` UNVERIFIED |
| Postfix | From "MAILER-DAEMON (Mail Delivery System)", subject "Undelivered Mail Returned to Sender", body "This is the mail system at host $myhostname. I'm sorry to have to inform you that your message could not be delivered to one or more recipients." [V]. Delay "Delayed Mail (still being retried)" | failure [V], delay UNVERIFIED |
| sendmail / qmail / Yahoo | "Returned mail: see transcript for details", "Warning: could not send message for past 4 hours", "failure notice" | UNVERIFIED |
| Localised Exchange/Gmail | de "Unzustellbar:", "Nicht zustellbar", "Übermittlungsstatusbenachrichtigung (Fehler)"; nb/da "Kan ikke leveres:"; sv "Kan inte levereras:", "Ej levererbart"; nl "Onbestelbaar:"; fr "Non remis :"; es "No se puede entregar:"; it "Non recapitabile:"; pl "Niedostarczalne:" | UNVERIFIED |

### 4.4 Linking a bounce notice and what it should do (recommendation, needs an OK)

Why would a bounce reach our **reply** route at all? Our Return-Path is Mailgun's bounce address, and Mailgun reports
real bounces as events (B6.11). Notices that reach a reply address come from servers that bounce to the header From
(non-standard). They also come from backscatter: forged mail using our domain lands on the catch-all route. Both are
rare and noisy.

- **Link:** try, in order:
  1. `In-Reply-To`/`References` (§6).
  2. Our Message-ID inside the text. Exchange NDRs include "Original message headers" [V]. Use
     `/pp\.[0-9a-f]{24}@[a-z0-9.-]+/gi`, then lowercase and look it up.
  3. `X-Failed-Recipients`, `Final-Recipient: rfc822; <addr>`, or the address line after "Delivery has failed to
     these recipients or groups:". Match it against a Person emailed in the last 90 days.
- **Effect when linked and `Action: failed` / `5.x.x`:** stop follow-ups for **that person only** (a bounce, per B6.4),
  and notify the sender. Don't add a suppression from an inbound notice. Mailgun events remain the authority for
  suppressions and health counts.
- **Delay** (`Action: delayed`, `4.x.x`, or a delay subject): timeline only.
- **Unlinked:** no notification. List it under the Owner's "other messages", because backscatter is common.

### 4.5 Read receipts (MDN, RFC 8098 [V])

- **Shape:** `multipart/report; report-type=disposition-notification`, with a `message/disposition-notification` part
  whose `Disposition:` is `displayed`, `deleted`, `dispatched` or `processed`. Receipts are requested with
  `Disposition-Notification-To`, which we never send. The envelope sender "MUST be null (<>)" [V].
- **Classify** as AUTO_REPLY with `autoReason "read-receipt"`. With only a subject ("Read:", "Gelesen:", "Lest:",
  "Läst:", "Læst:", "Gelezen:", "Lu :", "Leído:", "Letto:", "Przeczytano:"; UNVERIFIED list), also require a null
  sender or a `Disposition:` line.

---

## 5. Order of checks (why bounces come first)

1. **Delivery reports** come first, because some carry `Auto-Submitted` (Exim [V], Gmail/Exchange UNVERIFIED) and would
   otherwise be filed as auto-replies. A delay is still BOUNCE_NOTICE.
2. **Read receipts.**
3. **Help-desk acknowledgements**, before strong headers, because help desks stamp strong headers on human replies.
4. **Challenge-response**, before OOF, because it needs a sender notification.
5. **Strong auto signals**, then **medium signals**, then the decision (§8.2).

---

## 6. Replies from other addresses, forwards and threading

### 6.1 What the standards and clients do

- **RFC 5322 §3.6.4 [V]:**
  - `In-Reply-To` = the parent's `Message-ID`.
  - `References` = the parent's `References` followed by the parent's `Message-ID`. If the parent has no
    `References`, use its single-id `In-Reply-To` followed by its `Message-ID`.
  - §3.6.5: the subject MAY start with "Re: ".
  - Our follow-ups already follow this rule (B6.4).
- **Exchange / Outlook [V]:**
  - `In-Reply-To` and `References` are read and written through `PidTagInReplyToId` and `PidTagInternetReferences`.
    References may be truncated at 64 KB.
  - `Thread-Index` carries `PidTagConversationIndex` in base64: a 22-byte header (reserved byte, 5-byte FILETIME,
    16-byte GUID made per new thread), then 5 bytes per reply level.
  - `Thread-Topic` is the normalised subject.
  - **Our emails have no Thread-Index, so an Outlook reply starts a new conversation index. Thread-Index can't link
    to us; ignore it.**
  - Whether Outlook keeps the *whole* References chain or only the parent is UNVERIFIED. Matching any known ID covers
    both.
  - Microsoft Graph gives a new `conversationId` when an outside party replies [R, Microsoft Q&A], which doesn't matter
    here.
- **Gmail:** replies follow RFC 5322 (UNVERIFIED as documented behaviour, universally observed). Forwards show up in
  the same Gmail conversation [R, the Mozilla bug discussion], so Gmail probably sets `References` on forwards
  (UNVERIFIED).
- **Thunderbird forwards [V]:** `References:` holds *only* the forwarded message's ID, to avoid leaking the chain,
  plus `X-Forwarded-Message-Id:`. This has been the case since TB 3.2a1.
- **Auto-replies:** RFC 3834 §3.1.6 says `In-Reply-To`/`References` SHOULD be set, and Sieve vacation MUST set
  `In-Reply-To` [V]. So OOFs usually link by headers too, and the from-address fallback covers the rest.

### 6.2 Matching (PLAN B6.10 order, with details)

1. **Headers.**
   - Collect IDs from `In-Reply-To` (first), then `References` from last to first (most recent first). Accept only
     `pp.<24 hex>@<one of our sending domains>`, lowercase.
   - The first ID that belongs to an email we actually sent (live or test mode; dry-run IDs end in `@dry-run.invalid`
     and never leave) links the message to that email, and so to its person, company and campaign.
   - **No time window.**
2. **From address.**
   - Compare `normalizeEmail(from)` with `Person.emailNorm` of people emailed live in the last 90 days, and take the
     latest email.
   - This also links OOFs that lack headers.
   - Skip this step for bounce notices, which come from mailer-daemon; use §4.4 instead.
3. **Otherwise unlinked.** Human mail becomes UNLINKED, with "Link to a company" in the UI.
   - **UI-only hints** (PLAN says "There is no matching by domain", so these must never link on their own):
     - "Same domain as C-1042 Firma GmbH". Never offer this for shared or free-mail domains (B6.13 list).
     - "Quoted text matches your email to Firma GmbH": at least 60 characters of our rendered first email (the
       personal line is nearly unique) found in the quoted part.

### 6.3 Scenarios

| Scenario | What arrives | Result |
|---|---|---|
| Anna replies normally | Our ID in `In-Reply-To` | REPLY, linked to the email; the company is stopped |
| Colleague Jonas replies to Anna's forward (V22) | `In-Reply-To` = the forward's ID; `References` holds ours, if the forwarding client kept it (Thunderbird does [V]) | REPLY linked through `References`. `fromEmail` ≠ person, so show "Reply from jonas@firma.de (not in your contacts). Add to Firma GmbH?". Never create the Person automatically. The company stop applies ("anyone at the company replies", B6.4). |
| Jonas writes a new email (V23) | no headers; unknown address | UNLINKED, with the same-domain hint |
| Anna writes a new email from the address we used (V24) | no headers; known address | REPLY via from-address |
| Anna replies from her private Gmail | our ID in headers | REPLY via headers. Offer "Add anna.private@gmail.com to Anna?" |
| The reply reaches the catch-all (retired or mistyped address) (V25) | recipient is not a `SenderAddress`, so `senderAddressId` is null | Linking is unchanged. Notify the linked email's sender and the Owner (the catch-all forwards to the Owner). |
| The reply reaches another sender's address (Anna replies to Sara about Ali's email) | our (Ali's) ID in headers, `toAddress` = Sara's | Link to Ali's email. Notify Ali (it's his email) **and** Sara (it arrived at her address). |
| Reply through the company's help desk (V11) | Zendesk headers, maybe our ID | POSSIBLE_REPLY, linked if the headers carry our ID |

---

## 7. Quoting: extracting the new text and the "first lines"

1. **Prefer Mailgun's `stripped-text`.**
   - Mailgun open-sourced talon, its library "to extract message quotations and signatures". It is ML-based and
     reports "92% success rate" [V, Mailgun blog, talon README].
   - Mailgun doesn't say that `stripped-text` *is* talon (UNVERIFIED).
   - The field is missing when parsing fails [V].
   - It can be wrong for bottom-posted and inline replies, and it can be empty for a forward with no comment.
2. **Fallback on `body-plain`**, with `findCut()` and `extractNewText()` from Appendix A. Cut at the first line that
   starts one of these:
   - an **attribution** of 1–3 contiguous lines that ends with `wrote|schrieb|skrev|a écrit|escribió|ha scritto|schreef|napisał(a)`
     plus an optional name, then ":". It must contain a digit or "@", and start with a lead word
     (`On|Am|Den|Le|El|Il giorno|Op|W dniu|På`), a short weekday followed by a digit, or a digit.
     Talon's equivalents [V, source]: `RE_ON_DATE_SMB_WROTE` uses leads `On, Le, W dniu, Op, Am, Em, På, Den, Vào` and
     verbs `wrote, sent, a écrit, napisał, schreef, verzond, geschreven, schrieb, escreveu, skrev, đã viết`;
     `RE_ON_DATE_WROTE_SMB` covers `Op|Am … schreef|verzond|geschreven|schrieb … :`. Talon checks at most
     `SPLITTER_MAX_LINES = 6` lines.
   - an **"Original Message" separator** (`-----Original Message-----`, `-----Ursprüngliche Nachricht-----`,
     `-----Opprinnelig melding-----`, …). Talon's list: `Original Message, Reply Message, Message original,
     Ursprüngliche Nachricht, Antwort Nachricht, Oprindelig meddelelse` [V].
   - a **forward separator** (`---------- Forwarded message ---------` [V, talon `RE_FWD`], `Weitergeleitete
     Nachricht`, `Videresendt melding`, …) or Apple's "Begin forwarded message:" (localised forms UNVERIFIED).
   - an **Outlook header block**: a "From:"-type line (`From|Von|Fra|Från|Van|De|Da|Od`, with an optional `*` and an
     optional space before the colon for French) followed, within 4 lines, by at least two of Sent/Date, To and
     Subject in any of the 11 languages. An optional `____…` line may come just before it.
     Talon's version: `RE_FROM_COLON_OR_DATE_COLON` with `From, Van, De, Von, Fra, Från, Date, [S]ent, Datum, Envoyé,
     Skickat, Sendt, Gesendet, Subject, Betreff, Objet, Emne, Ämne, To, An, Til, À, Till`, needing two or more such
     lines [V].
3. Then drop every line that starts with `>`. If nothing is left above the cut, take the text **below** it
   (bottom-posting). Stop at a signature separator `-- ` (RFC 3676 §4.3; not re-fetched) or a mobile footer ("Sent
   from my iPhone", "Von meinem iPhone gesendet", "Sendt fra min iPhone", "Skickat från min iPhone", "Envoyé de mon
   iPhone", "Enviado desde mi iPhone", "Inviato da iPhone", "Wysłane z iPhone'a", "Get Outlook for iOS"; UNVERIFIED
   list).
4. **Timeline "first lines":** use `firstLines(newText)`. It takes up to 3 non-empty lines and ≤ 300 characters, and
   stops at a sign-off line after the first line ("Best, Anna", "Viele Grüße", "Med vennlig hilsen", …). If the
   result is empty, use the snippet, then the subject.

Quoting vectors Q01–Q15 in Appendix B cover Gmail fr/pl/es (wrapped)/it/nl, Thunderbird nb, Apple de, the Outlook fr
header block, classic Outlook en/de, Outlook web nb, bottom-posting, Gmail en/de forwards, the `-- ` signature, and a
human "wrote:" inside text that must be kept.

---

## 8. Recommended classification algorithm

### 8.1 Principle: which mistake costs more

- **A real reply filed as AUTO_REPLY** is the worst mistake: follow-ups keep going to someone who answered, and no one
  is told.
- **An auto-reply filed as REPLY or POSSIBLE_REPLY** costs one click: the sender presses "It was an auto-reply" and
  follow-ups resume (B6.10).

So AUTO_REPLY needs strong evidence. When unsure, the result is POSSIBLE_REPLY: the company's follow-ups stop, the
company status is **not** set to Replied, and the sender is asked "Real reply?".

### 8.2 Two questions: what the message is, then who it belongs to

`classify(message) → {nature: REPLY | AUTO | BOUNCE | POSSIBLE, confidence, autoReason, delay, signals[]}`. Then
`link(message)` (§6.2, §4.4). The stored `kind` combines the two:

| Nature | Linked | Unlinked |
|---|---|---|
| REPLY | **REPLY** | **UNLINKED** |
| POSSIBLE | **POSSIBLE_REPLY** | **UNLINKED** (the UI shows "may be automatic") |
| AUTO | **AUTO_REPLY** | **AUTO_REPLY** with null links, no notification ("other messages") |
| BOUNCE | **BOUNCE_NOTICE** | **BOUNCE_NOTICE** with null links, no notification |

`autoReason` values are `out-of-office`, `auto-reply`, `helpdesk-ack`, `challenge`, `left-company`, `read-receipt`,
`dsn` and `delay`. `signals[]` goes into the timeline's "why" tooltip.

**Order of checks** (Appendix A, `classify()`):

0. **Normalise.**
   - Subject: flatten whitespace. The unprefixed subject is compared with the thread's sent subjects, and a normal
     reply subject disables every subject rule.
   - Content-Type token and `report-type`.
   - Null sender: `sender` or `X-Envelope-From` is `""` or `<>`.
   - New text (§7), falling back to the snippet.
1. **Delivery report** (§4.2). Certain, high or medium. `delay` when `Action: delayed`, a delay subject, or delay
   wording without failure wording.
2. **Read receipt** (§4.5).
3. **Help desk** (§2.8). Acknowledgement → AUTO `helpdesk-ack`.
4. **Challenge-response** (§3.4) → AUTO `challenge`.
5. **Strong signals** (any one → AUTO; two or more → "certain"):
   - `Auto-Submitted` ≠ `no` (**ignored on help-desk mail**)
   - `X-Autoreply` / `X-Autorespond` / `X-Autoresponder` (value not no/false/0)
   - `Precedence` or `X-Precedence` = `auto_reply`
   - `Delivered-To: Autoresponder`
   - a null envelope sender
   - an auto subject prefix (§3.1) on a subject that isn't ours
   - an "automatic reply" statement in the first 10 lines (§3.2)
6. **Medium signals** (two or more → AUTO "medium"; exactly one → POSSIBLE "low"):
   - `Precedence` = bulk/junk/list
   - `X-Auto-Response-Suppress` containing All/OOF/AutoReply
   - any `List-*` header
   - `Feedback-ID`
   - `X-Loop` / `X-MS-Exchange-Inbox-Rules-Loop`
   - `X-Autogenerated` / `X-FC-MachineGenerated`
   - a noreply-style local part, or `postmaster`/`mailer-daemon` without a bounce subject
   - an absence word in a subject that isn't ours
   - an absence statement in the first 5 lines
   - absence details (counted only with an absence statement)
   - "left the company" wording
   - acknowledgement wording without a ticket number
7. **Help-desk mail** with no acknowledgement and no strong signal (after ignoring `Auto-Submitted`) → POSSIBLE.
8. **No text at all** (a Logs-only recovery) → always POSSIBLE, as PLAN says. The `autoReason` hint ("looks
   automatic") is kept when the subject or headers say so.
9. **Otherwise** → REPLY.

`autoReason` for AUTO or POSSIBLE: `left-company` if that wording fired, else `out-of-office` if an absence statement
or an auto subject prefix fired, else `auto-reply`.

### 8.3 What each kind does (PLAN B6.4/B6.10, plus the recommendations above)

| Kind | Follow-ups | Company status | Notification | "Waiting for an answer" |
|---|---|---|---|---|
| REPLY | whole company stopped (all campaigns) | Replied (compare-and-set, never over Client / Not interested / Do not contact) | sender | yes |
| POSSIBLE_REPLY | whole company stopped until the sender answers; "It was an auto-reply" resumes them | unchanged until "Real reply" | sender, "Real reply?" | after "Real reply" |
| AUTO_REPLY | unchanged | unchanged | none, except `challenge` / `left-company` (sender, low priority) | no |
| BOUNCE_NOTICE (failed, linked) | that person stopped | unchanged | sender | no |
| BOUNCE_NOTICE (delay / unlinked) | unchanged | unchanged | none | no |
| UNLINKED | none (nothing to stop) | — | sender of the address (or the Owner, for the catch-all), "Reply we couldn't link" | after linking |

### 8.4 Rows stored under M3 (only a snippet)

- The phrase lists aren't anchored to line starts, so they work on the collapsed 300-character snippet.
  `extractNewText` falls back to the snippet, where `findCut` finds nothing.
- DSN field checks need line starts, so they mostly fail. `Content-Type` in the stored headers still identifies
  multipart/report.
- For M3 rows older than a few days (M3-DESIGN §9.3), classify normally but send no notifications. Show them on the
  Notifications page as "arrived while replies weren't processed yet" (recommendation).

---

## 9. Fake Mailgun additions needed for M4 tests

`tests/fake-mailgun/server.ts` `receive()` currently sets `sender = from`, sets `stripped-text = body-plain = text`,
always appends `Content-Type: text/plain`, and adds no `X-Envelope-From`. M4 tests need these extra inputs:

| Input | Effect |
|---|---|
| `envelopeSender?: string` (`""` for a null sender) | posted as `sender`, plus the header `X-Envelope-From: <…>` (or `<>`) |
| `strippedText?: string \| null` and `bodyPlain?: string` | `null` omits `stripped-text` (a failed parse) |
| `contentType?: string` | replaces the default `Content-Type`, e.g. `multipart/report; report-type=delivery-status; boundary="b"` |
| `attachments?: Array<{contentType: string; name: string}>` | fills the `attachments` JSON (`message/delivery-status`, `message/rfc822`) |
| `messageId?: string` | fixed IDs for forward/colleague scenarios |

With these, every vector in Appendix B can be sent through the real inbound route (notify POST), through catch-up
(stored message), and as a Logs-only recovery (`bodyAvailable: false`).

---

## 10. Decisions needed (differences from PLAN B6.10)

1. **`X-Auto-Response-Suppress` and `Precedence: bulk|junk`** become medium signals, not proof on their own (§1).
   PLAN lists them as auto-reply headers.
2. **Help-desk mail:** `Auto-Submitted` is ignored when help-desk headers are present. Acknowledgements are
   AUTO_REPLY, and anything else from a help desk is POSSIBLE_REPLY (§2.8).
3. **POSSIBLE_REPLY also means "classifier unsure"** (exactly one medium signal), not only "recovered with no text".
4. **Schema:** add `envelopeSender`, `strippedText`, `bodyText` and optionally `partTypes` to `InboundMessage`, and
   keep an allow-list of headers in the header cap (§0.3).
5. **Kind mapping:** unlinked auto-replies and bounce notices keep their own kind with null links. UNLINKED is only
   for human mail (§8.2).
6. **Bounce notices** stop only the linked person, never add suppressions, and delays do nothing (§4.4).
7. **New `autoReason` values** `challenge` and `left-company` notify the sender. Challenge links are never opened by
   the app (§3.4, §3.5).
8. **UI-only link hints** (same domain, quoted-text match), consistent with "no matching by domain" (§6.2).

---

## 11. Sources (all fetched 2026-09-23 unless stated)

Primary:
- RFC 3834, Recommendations for Automatic Responses to Electronic Mail: https://www.rfc-editor.org/rfc/rfc3834.txt
- IANA Auto-Submitted header field keywords (`no`, `auto-generated`, `auto-replied`, `auto-notified`/RFC 5436): https://www.iana.org/assignments/auto-submitted-keywords/auto-submitted-keywords.xhtml
- RFC 5230, Sieve Vacation Extension: https://www.rfc-editor.org/rfc/rfc5230.txt
- RFC 3464, Delivery Status Notifications: https://www.rfc-editor.org/rfc/rfc3464.txt
- RFC 8098, Message Disposition Notification: https://www.rfc-editor.org/rfc/rfc8098.txt
- RFC 5322 §3.6.4–3.6.5: https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4
- RFC 2369, RFC 2919, RFC 3676 (List-* headers, List-Id, the "-- " signature separator): cited from memory, not re-fetched
- [MS-OXCMAIL] Auto Response Suppress: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/ced68690-498a-4567-9d14-5c01f974d8b1
- [MS-OXCMAIL] Suppression of Automatic Replies (Precedence "with any value"): https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/e489ffaf-19ed-4285-96d9-c31c42cab17f
- [MS-OXCMAIL] Appendix A, product behaviour notes 51, 116–118: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/9617e6c1-9267-41f6-98c9-3276d0e547cd
- [MS-OXCMAIL] Message Class (NDR = multipart/report; message class not copied to MIME): https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/d9e7eb99-e68d-4796-90d8-6e2fbc883a90
- [MS-OXCMAIL] Conversation Index / Thread-Index: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/1f362c6a-468b-4113-934f-9e18392c2299
- [MS-OXCMAIL] Conversation Topic / Thread-Topic: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/0c6ea518-0f18-414d-a8cb-38a0dd7e693a
- [MS-OXOMSG] PidTagConversationIndex format: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxomsg/9e994fbb-b839-495f-84e3-2c8c02c7dd9b
- Microsoft Learn, Understand and troubleshoot OOF replies (once per sender, `<>` return path, history of 10,000): https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/understand-troubleshoot-oof-replies
- Microsoft Learn, NDRs in Exchange Online (NDR layout and example): https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/non-delivery-reports-in-exchange-online
- Microsoft Support, failed delivery messages from the postmaster: https://support.microsoft.com/en-us/office/failed-delivery-messages-from-the-postmaster-at-outlook-com-microsoft-com-or-service-microsoft-com-eb34d15e-1251-4802-995d-78917ecb1de6
- Microsoft Q&A, Identify auto generated emails (Exchange Online OOF `Auto-Submitted: auto-generated`, confirmed by Microsoft staff): https://learn.microsoft.com/en-us/answers/questions/674860/identify-auto-generated-emails-from-headers
- Microsoft archived blog, auto reply on Exchange 2013 (`X-Auto-Response-Suppress: All`, `X-MS-Exchange-Inbox-Rules-Loop`): https://learn.microsoft.com/en-us/archive/blogs/msdn/aljackie/generate-auto-reply-for-incoming-email-to-an-account-which-is-on-exchange-2013-server
- Gmail Help, vacation responder: https://support.google.com/mail/answer/25922?hl=en · Gmail API VacationSettings: https://developers.google.com/workspace/gmail/api/reference/rest/v1/VacationSettings · Gmail Help, bounced emails: https://support.google.com/mail/answer/6596?hl=en
- Apple, iCloud auto-reply: https://support.apple.com/guide/icloud/set-up-an-automatic-reply-mm6b1a04d1/icloud
- GMX Hilfe: https://hilfe.gmx.net/email/kontakte-organisieren/abwesenheit.html · WEB.DE Hilfe: https://hilfe.web.de/email/kontakte-organisieren/abwesenheit.html
- Yahoo Help, vacation response: https://help.yahoo.com/kb/vacation-response-sln28068.html
- Zendesk, authenticated SMTP connector (headers that outgoing mail carries): https://support.zendesk.com/hc/en-us/articles/7189260823194-Setting-up-the-Authenticated-SMTP-Connector-for-two-way-email-relay · Zendesk, editing the automatic response (default body): https://support.zendesk.com/hc/en-us/articles/4408831473562 · Zendesk, standard triggers: https://support.zendesk.com/hc/en-us/articles/203662176-About-the-Support-default-triggers
- Freshdesk, configuring email notifications: https://support.freshdesk.com/support/solutions/articles/220676-configuring-email-notifications
- Exim spec, customising bounce and warning messages: https://www.exim.org/exim-html-current/doc/html/spec_html/ch-customizing_bounce_and_warning_messages.html
- Postfix bounce(5) (Debian manpage; postfix.org returned HTTP 402): https://manpages.debian.org/bookworm/postfix/bounce.5.en.html
- Mailgun, receive-http and storing-and-retrieving-messages: https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http · https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/storing-and-retrieving-messages
- Mailgun blog, inbound routing in PHP (field and header list including `X-Envelope-From`): https://www.mailgun.com/blog/email/inbound-email-routing-in-php/ · Mailgun blog, open-sourcing talon: https://www.mailgun.com/blog/product/open-sourcing-our-email-signature-parsing-library/
- mailgun/talon `quotations.py` (Apache-2.0): https://github.com/mailgun/talon (raw: https://raw.githubusercontent.com/mailgun/talon/master/talon/quotations.py)
- Mozilla bug 583587 (Thunderbird forward `References` + `X-Forwarded-Message-Id`): https://bugzilla.mozilla.org/show_bug.cgi?id=583587
- Source code of real classifiers: Discourse `lib/email/receiver.rb` (https://github.com/discourse/discourse), Zammad `app/models/channel/filter/auto_response_check.rb` (https://github.com/zammad/zammad), FreeScout `app/Misc/Mail.php` (https://github.com/freescout-helpdesk/freescout)

Secondary ([R]):
- arp242, "How to detect automatically generated emails" (2018): https://www.arp242.net/autoreply.html
- ladedu.com, Gmail vacation headers (updated May 2026): https://ladedu.com/how-to-set-up-an-out-of-office-vacation-responder-in-gmail/
- Jitbit, X-Auto-Response-Suppress warning (2020): https://www.jitbit.com/maxblog/18-detecting-outlook-autoreplyout-of-office-emails-and-x-auto-response-suppress-header/
- Slipstick, OOF subject language: https://www.slipstick.com/exchange/change-office-message-subject/
- Cornell IT, auto-reply exceptions: https://it.cornell.edu/outlook-web/technical-details-auto-reply-exceptions
- Wikipedia, Challenge–response spam filtering (last edited 2025-12-26): https://en.wikipedia.org/wiki/Challenge%E2%80%93response_spam_filtering
- thoughtbot/griddler issue #122 (Mailgun `message-headers` sample): https://github.com/thoughtbot/griddler/issues/122

Not reachable: the Microsoft Tech Community "Loop Prevention in Exchange Online Demystified" page (it returned only
its title). The session's web-search budget ran out before `X-Failed-Recipients` could be checked in the Exim spec.

---

## Appendix A: classifier and quoting sketch (TypeScript; runs with `node file.ts` on Node 24)

This is reference code. The production version belongs in `src/core/replies/` (pure, no I/O), with its own tests,
following CONVENTIONS.md.

```ts
export type HeaderPair = [string, string];
export type ClassifyInput = {
  subject: string;
  fromEmail: string;               // normalised bare address
  fromName?: string | null;
  envelopeSender?: string | null;  // Mailgun `sender` (SMTP MAIL FROM); "" or "<>" = null sender; undefined/null = unknown
  headers: HeaderPair[];
  strippedText?: string | null;    // Mailgun stripped-text, newlines kept (absent when Mailgun's parse failed)
  bodyPlain?: string | null;       // Mailgun body-plain, newlines kept
  snippet?: string;                // M3 snippet (whitespace collapsed, <= 300 chars) for rows stored before M4
  attachmentTypes?: string[];      // content-types from the `attachments` JSON (UNVERIFIED which parts Mailgun lists)
  bodyAvailable?: boolean;         // false for Logs-only recoveries (no text at all)
  sentSubjects?: string[];         // subjects of our emails in the linked thread, if already linked
};
export type Nature = "REPLY" | "AUTO" | "BOUNCE" | "POSSIBLE";
export type Verdict = {
  nature: Nature;
  confidence: "certain" | "high" | "medium" | "low";
  autoReason: string | null;       // stored in InboundMessage.autoReason
  delay: boolean;                  // BOUNCE only: a "still trying" notice, not a failure
  signals: string[];               // every signal that fired, for the UI "why" line and for tests
};

// ---------- small helpers ----------
const clean = (s: string) => s.normalize("NFC").replace(/[\u00A0\u202F\u2007]/g, " ");
const flat = (s: string) => clean(s).replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Phrase list -> one regex. Spaces match any whitespace; boundaries are Unicode-aware (JS \b is ASCII-only). */
export function phrases(list: string[], opts: { anchored?: boolean } = {}): RegExp {
  const alt = list.map((p) => esc(p).replace(/ /g, "\\s+")).join("|");
  const lead = opts.anchored ? "^\\s*(?:\\[\\s*)?" : "(?:^|[^\\p{L}\\p{N}])";
  return new RegExp(`${lead}(?:${alt})(?=$|[^\\p{L}\\p{N}])`, "iu");
}
export function headerValues(h: HeaderPair[], name: string): string[] {
  const n = name.toLowerCase();
  return h.filter(([k]) => k.toLowerCase() === n).map(([, v]) => flat(v));
}
const hasHeader = (h: HeaderPair[], name: string) => headerValues(h, name).length > 0;
/** First token of a structured value: comments "(...)" and ";params" removed, lowercased. */
export const token = (v: string) => v.replace(/\([^)]*\)/g, " ").split(";")[0].trim().toLowerCase();
const truthy = (v: string) => !/^(?:no|false|0|none)$/i.test(token(v));

// ---------- subjects ----------
/** Reply/forward prefixes, repeated ("Re: AW: Fwd:"), optional counters ("Re[2]:"). */
export const REPLY_PREFIX = /^(?:\s*(?:re|aw|antw|antwort|sv|vs|odp|r|rif|réf|ref|fw|fwd|wg|tr|rv|doorst|enc)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*)+/iu;
export const stripReplyPrefixes = (s: string) => flat(s).replace(REPLY_PREFIX, "").trim();
const sameSubject = (a: string, b: string) =>
  stripReplyPrefixes(a).toLocaleLowerCase("und") === stripReplyPrefixes(b).toLocaleLowerCase("und");

export const AUTO_SUBJECT_PREFIX = phrases([
  // en
  "automatic reply", "auto reply", "auto-reply", "autoreply", "auto response", "auto-response", "automatic response",
  "automated response", "automated reply", "out of office", "out of the office", "out-of-office", "ooo",
  "away from the office", "away from office", "vacation reply", "vacation response",
  // de
  "automatische antwort", "autom. antwort", "automatische rückantwort", "abwesenheitsnotiz", "abwesenheitsmeldung",
  "abwesenheitsnachricht", "abwesenheit", "abwesend", "nicht im büro", "außer haus", "ausser haus",
  // no (bokmål, nynorsk), sv, da
  "automatisk svar", "automatiskt svar", "autosvar", "fraværsmelding", "fråværsmelding", "fravær", "fråvær",
  "fraværsbesked", "frånvaro", "frånvaromeddelande", "ikke på kontoret", "ikkje på kontoret", "inte på kontoret",
  "ej på kontoret",
  // nl
  "automatisch antwoord", "automatisch bericht", "afwezigheidsbericht", "afwezigheidsmelding", "afwezig",
  "niet op kantoor", "buiten kantoor",
  // fr
  "réponse automatique", "reponse automatique", "réponse auto", "message d'absence", "absence du bureau",
  "absent du bureau", "absente du bureau", "hors du bureau", "absence", "absent", "absente",
  // es
  "respuesta automática", "respuesta automatica", "fuera de la oficina", "fuera de oficina", "ausencia", "ausente",
  // it
  "risposta automatica", "risposta non al computer", "fuori sede", "fuori ufficio", "assenza", "assente",
  // pl
  "automatyczna odpowiedź", "odpowiedź automatyczna", "autoodpowiedź", "poza biurem", "nieobecność", "nieobecny", "nieobecna",
], { anchored: true });
export const AUTO_COLON_PREFIX = /^\s*auto\s*:/i;                       // RFC 5230 §5.3 / RFC 3834 §3.1.5 "Auto: "
export const OOF_SUBJECT_WORD = phrases([                                // medium: word anywhere in a subject that isn't ours
  "vacation", "holiday", "holidays", "annual leave", "on leave", "urlaub", "ferien", "ferie", "semester", "vakantie",
  "vacances", "congé", "congés", "vacaciones", "urlop", "permisjon", "elternzeit",
]);
export const READ_RECEIPT_SUBJECT = phrases([
  "read:", "not read:", "gelesen:", "nicht gelesen:", "lest:", "ikke lest:", "läst:", "læst:", "gelezen:", "lu :", "lu:",
  "leído:", "letto:", "przeczytano:", "przeczytana:",
], { anchored: true });

// ---------- delivery failures ----------
export const DELAY_SUBJECT = new RegExp(
  "^\\s*(?:delivery status notification \\(delay\\)|delivery delayed|delayed mail|warning: message \\S+ delayed|" +
    "warning: could not send message|zustellung verzögert|übermittlung verzögert|levering forsinket|leverans försenad|" +
    "vertraagde bezorging|remise différée|entrega retrasada|recapito ritardato|opóźnione doręczenie)", "iu");
export const BOUNCE_SUBJECT = phrases([
  "undeliverable", "undelivered mail returned to sender", "undelivered mail", "undelivered message",
  "delivery status notification (failure)", "delivery status notification", "mail delivery failed",
  "mail delivery failure", "delivery failure", "delivery failed", "delivery has failed", "returned mail",
  "failure notice", "message not delivered", "nondeliverable", "non-deliverable", "non-delivery",
  // localised (UNVERIFIED)
  "unzustellbar", "nicht zustellbar", "unzustellbare nachricht", "zustellung fehlgeschlagen",
  "übermittlungsstatusbenachrichtigung (fehler)", "kan ikke leveres", "kunne ikke leveres", "ikke levert",
  "levering mislyktes", "kan inte levereras", "ej levererbart", "olevererbart", "ikke leveret", "levering mislykkedes",
  "onbestelbaar", "niet bezorgd", "bezorging mislukt", "non remis", "message non remis", "échec de la remise",
  "impossible de remettre", "no se puede entregar", "no entregado", "error de entrega", "non recapitabile",
  "mancato recapito", "recapito non riuscito", "niedostarczalne", "nie można dostarczyć", "niedostarczona",
], { anchored: true });
export const BOUNCE_LOCALPART = /^(?:mailer[-_.]?daemon|postmaster|mail[-_.]?daemon|mdaemon|double[-_]?bounce)$/i;
export const BOUNCE_DISPLAY = /^(?:mail delivery (?:system|subsystem|service)|mail administrator|mailer[- ]daemon|postmaster)$/i;
export const DSN_FIELD = /^\s*(final-recipient|original-recipient|reporting-mta|remote-mta|diagnostic-code|action|status|arrival-date|last-attempt-date)\s*:/gimu;
export const DSN_ACTION_DELAYED = /^\s*action\s*:\s*delayed\b/imu;
export const BOUNCE_PROSE = phrases([
  "delivery has failed to these recipients or groups", "your message wasn't delivered", "your message was not delivered",
  "your message couldn't be delivered", "your message could not be delivered",
  "this message was created automatically by mail delivery software",
  "i'm sorry to have to inform you that your message could not be delivered",
  "could not be delivered to one or more recipients", "delivery to the following recipient failed",
  "delivery to the following recipients failed", "address not found", "unrouteable address",
  "recipient address rejected", "user unknown", "mailbox unavailable", "no such user",
  // localised (UNVERIFIED)
  "die nachricht konnte nicht zugestellt werden", "ihre nachricht konnte nicht zugestellt werden",
  "die zustellung an folgende empfänger oder gruppen ist fehlgeschlagen", "meldingen kunne ikke leveres",
  "meldingen din kunne ikke leveres",
]);
export const DELAY_PROSE = phrases([
  "will continue to try", "still being retried", "delivery is delayed", "delivery has been delayed",
  "has not yet been delivered", "no action is required on your part", "zustellung verzögert",
]);

// ---------- automatic-reply bodies ----------
export const AUTO_STATEMENT = phrases([
  "this is an automatic reply", "this is an automatic response", "this is an automated reply", "this is an automated response",
  "this is an automated message", "this is an auto-reply", "this is an autoreply", "this message was automatically generated",
  "this is an automatically generated",
  "dies ist eine automatische antwort", "dies ist eine automatisch generierte", "dies ist eine automatisch erstellte",
  "diese nachricht wurde automatisch", "automatisch generierte nachricht", "automatisch erzeugte nachricht",
  "dette er et automatisk svar", "dette er eit automatisk svar", "dette er en automatisk generert",
  "denne e-posten er automatisk generert", "denne meldingen er automatisk generert",
  "detta är ett automatiskt svar", "detta är ett automatiskt genererat", "detta meddelande är automatiskt genererat",
  "denne besked er automatisk genereret", "dette er en automatisk genereret",
  "dit is een automatisch antwoord", "dit is een automatisch gegenereerd", "dit bericht is automatisch gegenereerd",
  "ceci est une réponse automatique", "ceci est un message automatique", "ce message a été généré automatiquement",
  "message généré automatiquement",
  "esta es una respuesta automática", "este es un mensaje automático", "este mensaje ha sido generado automáticamente",
  "mensaje generado automáticamente",
  "questa è una risposta automatica", "questo è un messaggio automatico", "messaggio generato automaticamente",
  "questo messaggio è stato generato automaticamente",
  "to jest automatyczna odpowiedź", "to jest wiadomość automatyczna", "ta wiadomość została wygenerowana automatycznie",
  "wiadomość wygenerowana automatycznie",
]);
export const ABSENCE = phrases([
  // en
  "i am out of the office", "i'm out of the office", "i am currently out of the office", "i'm currently out of the office",
  "i will be out of the office", "i'll be out of the office", "i am out of office", "i'm out of office", "i am away",
  "i'm away", "i am currently away", "i'm currently away", "i will be away", "i am on vacation", "i'm on vacation",
  "i am on holiday", "i'm on holiday", "i am on annual leave", "i'm on annual leave", "i am on leave", "i'm on leave",
  "i am on parental leave", "i am on maternity leave", "i am currently travelling", "i am currently traveling",
  "i am not in the office", "i'm not in the office", "i am away from the office", "i'm away from the office",
  // de
  "ich bin nicht im büro", "ich bin derzeit nicht im büro", "ich bin zurzeit nicht im büro", "ich bin momentan nicht im büro",
  "ich bin aktuell nicht im büro", "ich bin im urlaub", "ich befinde mich im urlaub", "ich bin abwesend",
  "ich bin derzeit abwesend", "ich bin nicht erreichbar", "ich bin derzeit nicht erreichbar", "ich bin außer haus",
  "ich bin ausser haus", "bin ich nicht im büro", "bin ich nicht erreichbar", "bin ich abwesend", "bin ich im urlaub",
  // no bokmål
  "jeg er ikke på kontoret", "jeg er for tiden ikke på kontoret", "jeg er p.t. ikke på kontoret", "jeg er på ferie",
  "jeg har ferie", "jeg er borte", "jeg er fraværende", "jeg er ute av kontoret", "er jeg ikke på kontoret",
  "er jeg på ferie", "er jeg borte", "er jeg fraværende",
  // no nynorsk
  "eg er ikkje på kontoret", "eg er på ferie", "eg har ferie", "eg er borte", "eg er fråverande",
  "er eg ikkje på kontoret", "er eg på ferie", "er eg borte",
  // sv
  "jag är inte på kontoret", "jag är på semester", "jag har semester", "jag är borta", "jag är ledig",
  "jag är frånvarande", "är jag inte på kontoret", "är jag på semester", "är jag ledig",
  // da
  "jeg holder ferie", "jeg er ikke til stede", "holder jeg ferie",
  // nl
  "ik ben niet op kantoor", "ik ben momenteel niet op kantoor", "ik ben afwezig", "ik ben momenteel afwezig",
  "ik ben met vakantie", "ik ben op vakantie", "ik ben niet aanwezig", "ben ik afwezig", "ben ik niet aanwezig",
  "ben ik met vakantie", "ben ik niet op kantoor",
  // fr
  "je suis absent", "je suis absente", "je suis actuellement absent", "je suis actuellement absente", "je serai absent",
  "je serai absente", "je suis en congé", "je suis en congés", "je suis en vacances", "je suis hors du bureau",
  "je ne suis pas au bureau", "je suis en déplacement",
  // es
  "estoy fuera de la oficina", "me encuentro fuera de la oficina", "estaré fuera de la oficina", "estoy de vacaciones",
  "estaré ausente", "estoy ausente", "me encuentro de vacaciones", "no estoy en la oficina",
  // it
  "sono fuori ufficio", "sono fuori sede", "sono attualmente fuori ufficio", "sarò fuori ufficio", "sarò assente",
  "sono assente", "sono in ferie", "sono in vacanza", "non sono in ufficio",
  // pl
  "jestem poza biurem", "obecnie przebywam poza biurem", "przebywam poza biurem", "jestem na urlopie",
  "przebywam na urlopie", "jestem nieobecny", "jestem nieobecna", "będę nieobecny", "będę nieobecna",
  "nie ma mnie w biurze",
]);
export const ABSENCE_COMPANION = phrases([
  "limited access to email", "limited access to e-mail", "limited access to my email", "for urgent matters",
  "for urgent enquiries", "for urgent inquiries", "in urgent cases", "if your matter is urgent", "upon my return",
  "on my return", "when i return", "returning on", "i will be back", "i'll be back", "back in the office",
  "your email will not be forwarded", "your message will not be forwarded",
  "in dringenden fällen", "bei dringenden anliegen", "in dringenden angelegenheiten", "nach meiner rückkehr",
  "bin ich wieder", "wieder im büro", "wieder erreichbar", "eingeschränkt erreichbar",
  "ihre e-mail wird nicht weitergeleitet", "ihre nachricht wird nicht weitergeleitet",
  "i hastesaker", "ved hastesaker", "når jeg er tilbake", "når eg er tilbake", "tilbake på kontoret",
  "begrenset tilgang til e-post", "avgrensa tilgang til e-post",
  "i brådskande ärenden", "vid brådskande ärenden", "när jag är tillbaka", "tillbaka på kontoret",
  "begränsad tillgång till e-post", "i hastende tilfælde", "i presserende sager", "når jeg er tilbage",
  "tilbage på kontoret", "begrænset adgang til e-mail",
  "voor dringende zaken", "in dringende gevallen", "na mijn terugkomst", "weer aanwezig", "weer op kantoor",
  "beperkt bereikbaar", "uw e-mail wordt niet doorgestuurd",
  "pour toute urgence", "en cas d'urgence", "à mon retour", "de retour le", "je serai de retour",
  "accès limité à mes e-mails", "accès limité à ma messagerie",
  "para asuntos urgentes", "en caso de urgencia", "a mi regreso", "a mi vuelta", "volveré el", "estaré de vuelta",
  "acceso limitado al correo",
  "per urgenze", "in caso di urgenza", "al mio rientro", "rientrerò il", "accesso limitato alla posta",
  "w pilnych sprawach", "w sprawach pilnych", "po moim powrocie", "po powrocie", "ograniczony dostęp do poczty",
]);
export const LEFT_COMPANY = phrases([
  "no longer with", "no longer works", "no longer employed", "has left the company", "has left the organisation",
  "has left the organization", "this mailbox is no longer monitored", "this email address is no longer in use",
  "this address is no longer monitored",
  "nicht mehr im unternehmen", "nicht mehr bei uns tätig", "nicht mehr für uns tätig", "hat das unternehmen verlassen",
  "dieses postfach wird nicht mehr", "diese e-mail-adresse wird nicht mehr", "diese adresse ist nicht mehr aktiv",
  "har sluttet", "jobber ikke lenger", "er ikke lenger ansatt", "denne e-postadressen er ikke lenger i bruk",
  "eg har slutta", "jobbar ikkje lenger", "har slutat", "arbetar inte längre", "arbejder ikke længere", "er fratrådt",
  "is niet meer werkzaam", "werkt niet meer bij", "is uit dienst", "ne fait plus partie", "a quitté l'entreprise",
  "ya no trabaja", "ha dejado la empresa", "non lavora più", "non fa più parte", "nie pracuje już",
  "nie jest już pracownikiem",
]);

// ---------- help desks, challenge-response ----------
export const HELPDESK_XMAILER = /zendesk|freshdesk|freshservice|help ?scout|zoho ?desk|kayako|osticket|otrs|znuny|zammad|servicenow|hubspot/i;
export const HELPDESK_HEADER_NAME = /^x-(?:zendesk|freshdesk|helpscout|zammad|otrs|kayako)-/i; // only x-zendesk-* is documented
export const TICKET_ID = /(?:\[#?\s?\d{3,}\]|\(#\d{3,}\)|#\d{3,}\b|\b(?:ticket|case|request|anfrage|sak|ärende|sag|zgłoszenie)\s*(?:#|nr\.?|no\.?|number|nummer|numero)?\s*[:#]?\s*\d{3,}\b)/iu;
export const ACK_SUBJECT = phrases([
  "request received", "ticket received", "ticket created", "request created", "case created", "we received your",
  "anfrage erhalten", "anfrage eingegangen", "ticket erstellt", "henvendelse mottatt", "sak opprettet",
  "ärende mottaget", "ärende skapat", "henvendelse modtaget", "verzoek ontvangen", "demande reçue",
  "solicitud recibida", "richiesta ricevuta", "zgłoszenie przyjęte",
]);
export const ACK_BODY = phrases([
  "has been received and is being reviewed", "your request has been received", "we have received your",
  "we've received your", "a ticket has been created", "ticket has been created", "your ticket number",
  "wir haben ihre anfrage erhalten", "wir haben ihre nachricht erhalten", "wir haben ihre e-mail erhalten",
  "ihre anfrage ist bei uns eingegangen", "vi har mottatt din henvendelse", "vi har mottatt henvendelsen",
  "vi har mottagit ditt", "vi har modtaget din", "we hebben uw bericht ontvangen", "we hebben je bericht ontvangen",
  "nous avons bien reçu votre", "hemos recibido su", "abbiamo ricevuto la sua", "otrzymaliśmy twoją wiadomość",
  "otrzymaliśmy państwa",
]);
export const CHALLENGE = phrases([
  "confirm you are human", "confirm that you are human", "confirm you're human", "verify you are human",
  "verify that you are human", "prove you are human", "not a robot", "sender verification",
  "please verify your message", "please confirm your message", "your message is being held",
  "your message has been held", "awaiting your confirmation", "awaiting verification", "challenge-response",
  "challenge response", "approved senders list",
  "absenderbestätigung", "absenderverifizierung", "bestätigen sie, dass sie ein mensch sind",
  "bestätigen sie, dass sie kein roboter sind", "bitte bestätigen sie ihre nachricht", "bitte bestätigen sie ihre e-mail",
  "ihre nachricht wurde zurückgehalten", "bekreft at du er et menneske", "avsenderverifisering", "captcha",
]);
export const NOREPLY_LOCALPART = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|autoresponder|auto[-_.]?reply|mailer)$/i;
const URL = /https?:\/\/\S+/i;

// ---------- quoting ----------
const WROTE = "(?:wrote|schrieb|skrev|a écrit|escribió|escribio|ha scritto|schreef|napisał\\(a\\)|napisała|napisał|escreveu)";
/** Attribution line ("On … wrote:", "Am … schrieb …:", "Den … skrev …:", "… napisał(a):"); test on 1–3 joined lines. */
export const RE_ATTRIBUTION = new RegExp(`^(?!\\s*>)(?=.*[\\d@]).{0,300}?(?:^|[\\s,])${WROTE}(?:\\s.{0,160})?\\s?:\\s*$`, "iu");
/** An attribution starts with a lead word ("On", "Am", "Den", "Le", "El", "Il giorno", "Op", "W dniu", "På"),
 *  a short weekday ("man.", "pon.,") followed by a digit, or a digit (Apple Mail nb: "21. sep. 2026 kl. 10:15 skrev …"). */
export const RE_ATTRIBUTION_START = /^\s*(?:(?:on|am|den|le|el|il giorno|il|op|w dniu|dnia|på|em)\s|\p{L}{2,5}\.?,?\s+\d|\d)/iu;
export const RE_ORIGINAL = /^\s*-{2,}\s*(?:original message|ursprüngliche nachricht|originalnachricht|opprinnelig melding|opprinneleg melding|originalmelding|ursprungligt meddelande|oprindelig meddelelse|oorspronkelijk bericht|message d'origine|message original|mensaje original|messaggio originale|oryginalna wiadomość|wiadomość oryginalna)\s*-{2,}\s*$/iu;
export const RE_FORWARD = /^\s*-{2,}\s*(?:forwarded message|weitergeleitete nachricht|videresendt melding|vidaresendt melding|vidarebefordrat meddelande|videresendt meddelelse|doorgestuurd bericht|message transféré|mensaje reenviado|messaggio inoltrato|wiadomość przekazana dalej|przekazana wiadomość)\s*-{2,}\s*$/iu;
export const RE_APPLE_FORWARD = /^\s*(?:begin forwarded message|anfang der weitergeleiteten nachricht|start på videresendt melding|början på vidarebefordrat meddelande|start på videresendt besked|begin doorgestuurd bericht|début du message réexpédié|inicio del mensaje reenviado|inizio messaggio inoltrato|początek przekazanej wiadomości)\s*:\s*$/iu;
const HDR = (words: string) => new RegExp(`^\\s*\\*?(?:${words})\\*?\\s?:\\s?\\*?`, "iu");
export const RE_HDR_FROM = HDR("from|von|fra|från|van|de|da|od");
export const RE_HDR_SENT = HDR("sent|date|gesendet|datum|sendt|dato|skickat|verzonden|envoyé|enviado|fecha|inviato|data|wysłano|wysłane");
export const RE_HDR_TO = HDR("to|an|til|till|aan|à|a|para|do|cc|kopie|kopi|kopia");
export const RE_HDR_SUBJECT = HDR("subject|betreff|emne|ämne|onderwerp|objet|asunto|oggetto|temat");
export const RE_UNDERSCORES = /^\s*_{10,}\s*$/;
export const RE_SIG = /^-- ?$/;                                          // RFC 3676 §4.3 "-- "
export const RE_MOBILE = /^\s*(?:sent from my (?:iphone|ipad|android|mobile|phone|samsung\b.*)|sent from outlook for (?:ios|android)|get outlook for (?:ios|android)|von meinem (?:iphone|ipad|smartphone|samsung\b.*) gesendet|gesendet von (?:meinem )?(?:iphone|ipad|outlook für (?:ios|android))|sendt fra (?:min |mi )?(?:iphone|ipad|samsung\b.*|outlook for (?:ios|android))|skickat från min (?:iphone|ipad)|verzonden vanaf mijn (?:iphone|ipad)|envoyé de mon (?:iphone|ipad)|enviado desde mi (?:iphone|ipad)|inviato da (?:iphone|ipad|il mio iphone)|wysłane z (?:iphone'?a|mojego iphone'?a))\s*$/iu;

/** Returns the index of the first line that starts quoted/forwarded material, or -1. */
export function findCut(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (RE_ORIGINAL.test(l) || RE_FORWARD.test(l) || RE_APPLE_FORWARD.test(l)) return i;
    if (RE_ATTRIBUTION_START.test(l)) {
      for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
        const win = lines.slice(i, i + span);
        if (win.some((w) => !w.trim())) break;                        // wrapped attributions are contiguous lines
        if (RE_ATTRIBUTION.test(win.join(" "))) return i;
      }
    }
    const from = RE_HDR_FROM.test(l) ? i : RE_UNDERSCORES.test(l) && RE_HDR_FROM.test(lines[i + 1] ?? "") ? i + 1 : -1;
    if (from >= 0) {
      const next = lines.slice(from + 1, from + 5);
      const hits = [RE_HDR_SENT, RE_HDR_TO, RE_HDR_SUBJECT].filter((re) => next.some((n) => re.test(n))).length;
      if (hits >= 2) return i;
    }
  }
  return -1;
}
/** The new text of a reply: Mailgun's stripped-text when present, else our own cut of body-plain. */
export function extractNewText(strippedText: string | null | undefined, bodyPlain: string | null | undefined): string {
  const src = strippedText && strippedText.trim() ? strippedText : bodyPlain ?? "";
  let lines = clean(src).replace(/\r\n?/g, "\n").split("\n");
  const cut = findCut(lines);
  const quoted = (l: string) => /^\s*>/.test(l);
  let head = cut >= 0 ? lines.slice(0, cut) : lines;
  if (!head.some((l) => l.trim() && !quoted(l)) && cut >= 0) head = lines.slice(cut + 1); // bottom-posting
  lines = head.filter((l) => !quoted(l));
  const end = lines.findIndex((l) => RE_SIG.test(l) || RE_MOBILE.test(l));
  if (end >= 0) lines = lines.slice(0, end);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** A sign-off line, optionally followed by one name ("Best, Anna"). Never applied to the first line. */
export const RE_SIGNOFF = /^(?:best|best regards|kind regards|regards|many thanks|thanks|thank you|cheers|br|mvh|med vennlig hilsen|vennlig hilsen|venleg helsing|hilsen|viele grüße|beste grüße|liebe grüße|mit freundlichen grüßen|freundliche grüße|lg|vg|mfg|med venlig hilsen|venlig hilsen|med vänliga hälsningar|vänliga hälsningar|hälsningar|mvh|met vriendelijke groet|vriendelijke groet|groeten|cordialement|bien à vous|bien cordialement|saludos|un saludo|atentamente|cordiali saluti|saluti|pozdrawiam|z poważaniem)[\s,.!]*(?:\p{L}+[.!]?)?\s*$/iu;
export function firstLines(newText: string, maxLines = 3, maxChars = 300): string {
  const lines = newText.split("\n").map((l) => l.trim()).filter(Boolean);
  const stop = lines.findIndex((l, i) => i > 0 && RE_SIGNOFF.test(l));
  const out = (stop > 0 ? lines.slice(0, stop) : lines).slice(0, maxLines).join(" ");
  return out.length > maxChars ? out.slice(0, maxChars - 1).trimEnd() + "…" : out;
}

// ---------- the classifier ----------
export function classify(m: ClassifyInput): Verdict {
  const h = m.headers;
  const signals: string[] = [];
  const subject = flat(m.subject ?? "");
  const subjectNoPrefix = stripReplyPrefixes(subject);
  const replyShaped = REPLY_PREFIX.test(subject);
  const isOurSubject = (m.sentSubjects ?? []).some((s) => sameSubject(s, subject));
  const ct = headerValues(h, "content-type")[0] ?? "";
  const ctType = token(ct);
  const reportType = (/report-type\s*=\s*"?([\w-]+)/i.exec(ct)?.[1] ?? "").toLowerCase();
  const env = m.envelopeSender;
  const xenv = headerValues(h, "x-envelope-from")[0];
  const nullSender = (env != null && /^\s*<?\s*>?\s*$/.test(env)) || (xenv != null && /^\s*<?\s*>?\s*$/.test(xenv));
  const [local = ""] = m.fromEmail.toLowerCase().split("@");
  const text = extractNewText(m.strippedText, m.bodyPlain) || flat(m.snippet ?? "");
  const head5 = text.split("\n").filter((l) => l.trim()).slice(0, 5).join(" ");
  const head10 = text.split("\n").filter((l) => l.trim()).slice(0, 10).join(" ").slice(0, 800);
  const fullBody = clean(m.bodyPlain ?? m.strippedText ?? m.snippet ?? "");
  const verdict = (nature: Nature, confidence: Verdict["confidence"], autoReason: string | null, delay = false): Verdict =>
    ({ nature, confidence, autoReason, delay, signals });

  // 1. Delivery reports (before auto-replies: Exim bounces carry Auto-Submitted: auto-generated).
  const dsnFields = new Set([...fullBody.matchAll(DSN_FIELD)].map((x) => x[1].toLowerCase()));
  const isDelay = DELAY_SUBJECT.test(subject) || DSN_ACTION_DELAYED.test(fullBody) || (DELAY_PROSE.test(fullBody) && !BOUNCE_PROSE.test(fullBody));
  if (ctType === "multipart/report" && reportType === "delivery-status") signals.push("content-type:delivery-status");
  if ((m.attachmentTypes ?? []).some((t) => /^message\/(?:delivery-status|global-delivery-status)/i.test(t))) signals.push("part:delivery-status");
  if (signals.length) return verdict("BOUNCE", "certain", isDelay ? "delay" : "dsn", isDelay);
  const bSubject = !replyShaped && (BOUNCE_SUBJECT.test(subject) || DELAY_SUBJECT.test(subject));
  const bFrom = BOUNCE_LOCALPART.test(local) || BOUNCE_DISPLAY.test(m.fromName ?? "");
  const bBody = dsnFields.has("final-recipient") && dsnFields.has("status") ? 2 : BOUNCE_PROSE.test(fullBody) ? 1 : 0;
  if (bSubject) signals.push("subject:bounce");
  if (bFrom) signals.push("from:mailer-daemon");
  if (bBody === 2) signals.push("body:dsn-fields"); else if (bBody === 1) signals.push("body:bounce-text");
  if (bSubject || bBody === 2 || (bFrom && bBody)) {
    const strong = (bSubject ? 1 : 0) + (bFrom ? 1 : 0) + (bBody ? 1 : 0) + (nullSender ? 1 : 0);
    if (strong >= 2 || bBody === 2) return verdict("BOUNCE", "high", isDelay ? "delay" : "dsn", isDelay);
    if (bSubject) return verdict("BOUNCE", "medium", isDelay ? "delay" : "dsn", isDelay);
  }

  // 2. Read receipts (RFC 8098 MDN).
  if (ctType === "multipart/report" && reportType === "disposition-notification")
    return (signals.push("content-type:disposition-notification"), verdict("AUTO", "certain", "read-receipt"));
  if (READ_RECEIPT_SUBJECT.test(subject) && (nullSender || /^\s*disposition\s*:/im.test(fullBody)))
    return (signals.push("subject:read-receipt"), verdict("AUTO", "high", "read-receipt"));

  // 3. Help desks: they stamp Auto-Submitted/X-Auto-Response-Suppress on EVERY email, agent replies included.
  const xMailer = headerValues(h, "x-mailer").join(" ");
  const helpdesk = HELPDESK_XMAILER.test(xMailer) || h.some(([k]) => HELPDESK_HEADER_NAME.test(k));
  const ack = (ACK_SUBJECT.test(subject) && (TICKET_ID.test(subject) || /\[.*\]/.test(subject))) ||
    /has been received and is being reviewed/i.test(head10) || (ACK_BODY.test(head10) && TICKET_ID.test(subject + " " + head10));
  if (helpdesk) signals.push("helpdesk");
  if (ack) return (signals.push("ack"), verdict("AUTO", helpdesk ? "certain" : "high", "helpdesk-ack"));

  // 4. Challenge-response ("please confirm you are human").
  if (CHALLENGE.test(subject) || (CHALLENGE.test(head10) && URL.test(fullBody)))
    return (signals.push("challenge"), verdict("AUTO", "high", "challenge"));

  // 5. Strong automatic signals.
  const strong: string[] = [];
  const as = headerValues(h, "auto-submitted").map(token);
  if (as.some((v) => v && v !== "no")) strong.push(`auto-submitted:${as.find((v) => v !== "no")}`);
  for (const name of ["x-autoreply", "x-autorespond", "x-autoresponder", "x-autoreply-from", "x-mail-autoreply"])
    if (headerValues(h, name).some(truthy)) strong.push(name);
  const prec = [...headerValues(h, "precedence"), ...headerValues(h, "x-precedence")].map(token);
  if (prec.some((p) => p === "auto_reply" || p === "auto-reply")) strong.push("precedence:auto_reply");
  if (headerValues(h, "delivered-to").some((v) => /^autoresponder$/i.test(v))) strong.push("delivered-to:autoresponder");
  if (nullSender) strong.push("null-sender");
  if (!isOurSubject && (AUTO_SUBJECT_PREFIX.test(subject) || AUTO_COLON_PREFIX.test(subject))) strong.push("subject:auto-prefix");
  if (AUTO_STATEMENT.test(head10)) strong.push("body:auto-statement");

  // 6. Medium signals.
  const medium: string[] = [];
  if (prec.some((p) => p === "bulk" || p === "junk" || p === "list")) medium.push(`precedence:${prec[0]}`);
  const xars = headerValues(h, "x-auto-response-suppress").flatMap((v) => v.toLowerCase().split(/[\s,]+/));
  if (xars.some((t) => t === "all" || t === "oof" || t === "autoreply")) medium.push("x-auto-response-suppress");
  if (["list-id", "list-unsubscribe", "list-post", "list-help", "list-subscribe", "list-owner", "list-archive"].some((n) => hasHeader(h, n))) medium.push("list-headers");
  if (hasHeader(h, "feedback-id")) medium.push("feedback-id");
  if (hasHeader(h, "x-loop") || hasHeader(h, "x-ms-exchange-inbox-rules-loop")) medium.push("loop-header");
  if (hasHeader(h, "x-autogenerated") || headerValues(h, "x-fc-machinegenerated").some(truthy)) medium.push("x-autogenerated");
  if (NOREPLY_LOCALPART.test(local) || (bFrom && !bSubject)) medium.push("from:no-reply");
  if (!isOurSubject && !AUTO_SUBJECT_PREFIX.test(subject) && OOF_SUBJECT_WORD.test(subjectNoPrefix)) medium.push("subject:absence-word");
  const absent = ABSENCE.test(head5);
  if (absent) medium.push("body:absence");
  if (absent && ABSENCE_COMPANION.test(text.slice(0, 1500))) medium.push("body:absence-details");
  const left = LEFT_COMPANY.test(head5);
  if (left) medium.push("body:left-company");
  if (helpdesk) medium.push("helpdesk-mailer");
  if (ACK_BODY.test(head10)) medium.push("body:ack");

  signals.push(...strong, ...medium);
  const reason = left ? "left-company" : absent || strong.includes("subject:auto-prefix") ? "out-of-office" : "auto-reply";
  // Help-desk mail with no acknowledgement wording may be a human agent: never trust its Auto-Submitted alone.
  const strongForReal = helpdesk ? strong.filter((s) => !s.startsWith("auto-submitted")) : strong;
  if (m.bodyAvailable === false) return verdict("POSSIBLE", "low", strongForReal.length ? reason : null);
  if (strongForReal.length >= 1) return verdict("AUTO", strongForReal.length >= 2 ? "certain" : "high", reason);
  const mediumScore = medium.filter((s) => s !== "helpdesk-mailer").length;
  if (mediumScore >= 2) return verdict("AUTO", "medium", reason);
  if (mediumScore === 1 || helpdesk) return verdict("POSSIBLE", "low", reason);
  return verdict("REPLY", "high", null);
}
```

Linking sketch (not run; it needs the database):

```ts
const OUR_ID = /pp\.[0-9a-f]{24}@[a-z0-9.-]+/gi;
/** Candidate ids, most specific first: In-Reply-To, then References newest→oldest, then ids found in the text (bounces). */
export function candidateIds(m: { inReplyTo: string | null; references: string[]; bodyText?: string | null }, ourDomains: string[]): string[] {
  const ours = (id: string) => /^pp\.[0-9a-f]{24}@/.test(id) && ourDomains.some((d) => id.endsWith(`@${d}`));
  const ids = [m.inReplyTo, ...[...m.references].reverse(), ...(m.bodyText?.match(OUR_ID) ?? [])]
    .filter((x): x is string => !!x).map((x) => x.toLowerCase().replace(/^<|>$/g, ""));
  return [...new Set(ids)].filter(ours);
}
// link(): 1) first candidate id with an OutboundEmail row that really left (live/test, not dry-run) → that email;
//         2) not BOUNCE and fromEmail = Person.emailNorm emailed live ≤ 90 days → their latest email;
//         3) BOUNCE: X-Failed-Recipients / Final-Recipient / "Delivery has failed…" address → Person emailed ≤ 90 days;
//         4) else null. Hints for the UI only: same non-shared domain; quoted-text match against our rendered first email.
```

---

## Appendix B: test vectors

**Context for every vector:**
- Ali (`ali@send.polygonparadise.com`) emailed `anna@firma.de` (Person, company C-1042 Firma GmbH). The email's
  Message-ID is `pp.4f1c9a0b7e2d4c6a8b0e1f23@send.polygonparadise.com` and its subject is "3D models for your shop".
- Ali also emailed `ole@butikk.no` (C-2001), Message-ID `pp.9a8b7c6d5e4f3a2b1c0d9e8f@send.polygonparadise.com`,
  subject "3D-modeller til butikken deres".
- `info@shop-beispiel.de`, `claire@boutique.fr`, `luis@tienda.es`, `jan@sklep.pl`, `pieter@winkel.nl` and
  `erik@butik.se` are also People emailed live within 90 days.
- `jonas@firma.de`, `kari@butikk.no`, `support@firma.de`, `help@firma.de` and `noreply@firma.de` are **not** People.
- "Kind" is the stored kind after linking (§8.2). All 40 classification vectors and 15 quoting vectors pass against
  Appendix A.

### B.1 Classification vectors

| # | Scenario | Key inputs (subject · headers · envelope · text) | Nature | autoReason | Kind after linking |
|---|---|---|---|---|---|
| V01 | Gmail human reply | "Re: 3D models…" · In-Reply-To/References = ours · env anna@ · wrapped "On … <\nali@…> wrote:" quote | REPLY | — | REPLY (headers). First lines: "Hi Ali, sounds interesting. Could you send prices for 10 busts?" |
| V02 | Outlook human reply (de) | "AW: …" · ours + Thread-Index/Thread-Topic · "Von:/Gesendet:/An:/Betreff:" block | REPLY | — | REPLY. First lines: "Hallo Ali, ja, gerne. Schicken Sie mir bitte ein Angebot." |
| V03 | Microsoft 365 OOF (en) | "Automatic reply: …" · `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: All` · env "" · "I am out of the office until 5 October with limited access to email." | AUTO (certain) | out-of-office | AUTO_REPLY (headers) |
| V04 | Outlook OOF (de) | "Automatische Antwort: …" · auto-generated, XARS All · env "" | AUTO | out-of-office | AUTO_REPLY (from) |
| V05 | Outlook OOF (nb) | "Automatisk svar: 3D-modeller…" · auto-generated · env "" · "Jeg er på ferie til og med 12. oktober…" | AUTO | out-of-office | AUTO_REPLY (from) |
| V06 | Gmail vacation with its own subject (nb) | "Ferie" · `Auto-Submitted: auto-replied`, `X-Autoreply: yes` · env ole@ | AUTO | out-of-office | AUTO_REPLY (headers) |
| V07 | Sieve vacation | "Auto: 3D models…" · auto-replied · env "<>" | AUTO | out-of-office | AUTO_REPLY |
| V08 | German webmail OOF, no auto headers | "Re: <ours>" · none · "Vom 20.09. bis 04.10. bin ich im Urlaub. Ihre E-Mail wird nicht weitergeleitet…" | AUTO (medium) | out-of-office | AUTO_REPLY (from) |
| V09 | Human who mentions being away | "Re: <ours>" · ours · "I'm out of the office this week, but yes, we're interested…" | POSSIBLE | out-of-office | POSSIBLE_REPLY |
| V10 | Zendesk acknowledgement | "[Firma Support] 3D models…" · Zendesk headers (§2) · "Your request (48213) has been received and is being reviewed…" | AUTO (certain) | helpdesk-ack | AUTO_REPLY, unlinked (support@ unknown, no thread headers) |
| V11 | Zendesk agent (human) reply | "Re: <ours>" · ours + Zendesk headers · "Our product lead Jonas would like to see samples…" | POSSIBLE | auto-reply | POSSIBLE_REPLY (headers) |
| V12 | Freshdesk-style acknowledgement | "Ticket Received - … - [#5821]" · none · "A ticket has been created (#5821)…" | AUTO | helpdesk-ack | AUTO_REPLY, unlinked |
| V13 | Gmail DSN | "Delivery Status Notification (Failure)" · `Content-Type: multipart/report; report-type=delivery-status` · From mailer-daemon@googlemail.com · env "" | BOUNCE (certain) | dsn | BOUNCE_NOTICE → Anna (address in text) |
| V14 | Exchange Online NDR | "Undeliverable: …" · multipart/report · "Delivery has failed to these recipients or groups:" + our Message-ID in "Original message headers" | BOUNCE | dsn | BOUNCE_NOTICE → the exact email (id in text) |
| V15 | Exim bounce carrying Auto-Submitted (tests the order) | "Mail delivery failed: returning message to sender" · `Auto-Submitted: auto-generated`, `X-Failed-Recipients` · text/plain | BOUNCE (high) | dsn | BOUNCE_NOTICE → Anna |
| V16 | Postfix bounce | "Undelivered Mail Returned to Sender" · multipart/report | BOUNCE | dsn | BOUNCE_NOTICE, unlinked if no address/id in text |
| V17 | German NDR, text only | "Unzustellbar: …" · From postmaster@ · env "" · "Ihre Nachricht konnte nicht zugestellt werden…" | BOUNCE (high) | dsn | BOUNCE_NOTICE → Anna |
| V18 | Delay DSN | "Delivery Status Notification (Delay)" · multipart/report · `Action: delayed` | BOUNCE | delay | BOUNCE_NOTICE (no stop) |
| V19 | Read receipt | "Gelesen: …" · `multipart/report; report-type=disposition-notification` · env "" | AUTO (certain) | read-receipt | AUTO_REPLY (from) |
| V20 | Challenge-response (en) | "Please confirm your message to anna@firma.de" · auto-replied · "To confirm you are human, click…" + URL | AUTO | challenge | AUTO_REPLY → Anna (address named), sender notified |
| V21 | Challenge-response (de), no headers | "Bitte bestätigen Sie Ihre E-Mail an info@firma.de" · "…kein Roboter…" + URL | AUTO | challenge | AUTO_REPLY (address named) |
| V22 | Colleague replies to a forward | "Re: <ours>" · In-Reply-To = forward id, References = ours + forward id · from jonas@ | REPLY | — | REPLY → C-1042 (References); offer "Add Jonas to Firma GmbH" |
| V23 | Colleague writes a new email | "Your 3D offer" · none · from jonas@ | REPLY | — | UNLINKED (hint: same domain as C-1042) |
| V24 | Known person writes a new email | "Question" · none · from anna@ | REPLY | — | REPLY (from-address) |
| V25 | Reply to the catch-all or a retired address (nb) | "SV: <ours>" · ours · "Den man. 21. sep. 2026 kl. 10:15 skrev …:" | REPLY | — | REPLY (headers); notify Ali and the Owner |
| V26 | Recovered from Logs, no text | "Re: <ours>" · bodyAvailable false | POSSIBLE | — | POSSIBLE_REPLY (PLAN) |
| V27 | Recovered from Logs, auto subject | "Automatic reply: <ours>" · bodyAvailable false | POSSIBLE | out-of-office (hint) | POSSIBLE_REPLY, "looks automatic" |
| V28 | Human reply with `Auto-Submitted: no` | ours · `Auto-Submitted: no` | REPLY | — | REPLY |
| V29 | Outlook human reply with `X-Auto-Response-Suppress: RN, NRN` | ours · XARS RN, NRN | REPLY | — | REPLY |
| V30 | Human text with only `X-Auto-Response-Suppress: All` | ours · XARS All | POSSIBLE | auto-reply | POSSIBLE_REPLY |
| V31 | CRM autoresponder | "Thanks for contacting Firma!" · `Precedence: bulk`, `List-Unsubscribe` · from noreply@ | AUTO (medium) | auto-reply | AUTO_REPLY, unlinked |
| V32 | French OOF with X-Autoreply | "Réponse automatique : …" · `X-Autoreply: yes` | AUTO | out-of-office | AUTO_REPLY (from) |
| V33 | Spanish OOF, subject only | "Fuera de la oficina" · none | AUTO | out-of-office | AUTO_REPLY (from) |
| V34 | Polish OOF | "Automatyczna odpowiedź: …" · auto-generated · env "" | AUTO | out-of-office | AUTO_REPLY (from) |
| V35 | Dutch human reply | "Re: <ours>" · ours · "Op ma 21 sep 2026 om 10:15 schreef Ali Khan <…>:" | REPLY | — | REPLY. First lines: "Ja graag, stuur de prijzen." |
| V36 | Nynorsk OOF with its own subject, no headers | "Fråværsmelding" · none · from kari@ (unknown) | AUTO | out-of-office | AUTO_REPLY, unlinked, no notification |
| V37 | Human subject that mentions a holiday | "Before our holiday - yes, interested!" · ours | POSSIBLE | auto-reply | POSSIBLE_REPLY |
| V38 | "Left the company" OOF | "Automatic reply: …" · auto-generated · env "" · "Anna Berg is no longer with Firma GmbH. Please contact info@firma.de." | AUTO | left-company | AUTO_REPLY; sender notified with info@ as the suggested contact |
| V39 | Successor writes back | "Re: <ours>" · ours · from jonas@ · "Anna is no longer with us - I took over purchasing and would like a quote." | POSSIBLE | left-company | POSSIBLE_REPLY (headers) |
| V40 | Swedish human reply with an Outlook block | "SV: <ours>" · ours · "Skickat från min iPhone" + "Från:/Skickat:/Till:/Ämne:" | REPLY | — | REPLY. First lines: "Hej Ali! Låter bra, skicka gärna en offert." |

### B.2 Runnable vectors (put this next to Appendix A as `classify.ts`, then run `node vectors.ts`)

```ts
import { classify, extractNewText, firstLines, type ClassifyInput, type Nature } from "./classify.ts";

const A = "pp.4f1c9a0b7e2d4c6a8b0e1f23@send.polygonparadise.com";
const O = "pp.9a8b7c6d5e4f3a2b1c0d9e8f@send.polygonparadise.com";
const SA = "3D models for your shop";
const SO = "3D-modeller til butikken deres";
type V = { id: string; in: ClassifyInput; nature: Nature; reason?: string | null; first?: string };
const thread = (id: string): [string, string][] => [["In-Reply-To", `<${id}>`], ["References", `<${id}>`]];

export const vectors: V[] = [
  { id: "V01 Gmail human reply", nature: "REPLY", first: "Hi Ali, sounds interesting. Could you send prices for 10 busts?",
    in: { subject: `Re: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [["From", "Anna Berg <anna@firma.de>"], ...thread(A), ["Content-Type", "multipart/alternative; boundary=\"000000000000abc\""]],
      strippedText: null,
      bodyPlain: "Hi Ali,\nsounds interesting. Could you send prices for 10 busts?\n\nBest, Anna\n\nOn Mon, Sep 21, 2026 at 10:15 AM Ali Khan <\nali@send.polygonparadise.com> wrote:\n\n> Hi Anna,\n> I make print-ready 3D models...\n" } },
  { id: "V02 Outlook human reply (de)", nature: "REPLY", first: "Hallo Ali, ja, gerne. Schicken Sie mir bitte ein Angebot.",
    in: { subject: `AW: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["Thread-Topic", SA], ["Thread-Index", "AQHbK3r1abcdEFGH"], ["Content-Language", "de-DE"]],
      bodyPlain: "Hallo Ali,\n\nja, gerne. Schicken Sie mir bitte ein Angebot.\n\nViele Grüße\nAnna Berg\n\nVon: Ali Khan <ali@send.polygonparadise.com>\nGesendet: Montag, 21. September 2026 10:15\nAn: Anna Berg <anna@firma.de>\nBetreff: 3D models for your shop\n\nHi Anna, ..." } },
  { id: "V03 Microsoft 365 OOF (en)", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Automatic reply: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["Thread-Topic", SA]],
      strippedText: "I am out of the office until 5 October with limited access to email." } },
  { id: "V04 Outlook OOF (de)", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Automatische Antwort: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"]],
      strippedText: "Vielen Dank für Ihre Nachricht. Ich bin bis einschließlich 2. Oktober nicht im Büro. In dringenden Fällen wenden Sie sich bitte an info@firma.de." } },
  { id: "V05 Outlook OOF (nb)", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Automatisk svar: ${SO}`, fromEmail: "ole@butikk.no", envelopeSender: "", sentSubjects: [SO],
      headers: [["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"]],
      strippedText: "Takk for e-posten. Jeg er på ferie til og med 12. oktober og har begrenset tilgang til e-post." } },
  { id: "V06 Gmail vacation, own subject (nb)", nature: "AUTO", reason: "out-of-office",
    in: { subject: "Ferie", fromEmail: "ole@butikk.no", envelopeSender: "ole@butikk.no", sentSubjects: [SO],
      headers: [...thread(O), ["Auto-Submitted", "auto-replied"], ["X-Autoreply", "yes"]],
      strippedText: "Hei! Jeg er på ferie til 12. oktober. Når jeg er tilbake svarer jeg deg." } },
  { id: "V07 Sieve vacation (RFC 5230)", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Auto: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "<>", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "auto-replied"]], strippedText: "I'm away until Monday." } },
  { id: "V08 German webmail OOF, no headers", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Re: ${SA}`, fromEmail: "info@shop-beispiel.de", envelopeSender: "info@shop-beispiel.de", sentSubjects: [SA],
      headers: [], strippedText: "Vielen Dank für Ihre Nachricht.\nVom 20.09. bis 04.10. bin ich im Urlaub. Ihre E-Mail wird nicht weitergeleitet. Ab dem 05.10. bin ich wieder erreichbar." } },
  { id: "V09 Human mentions absence", nature: "POSSIBLE", reason: "out-of-office",
    in: { subject: `Re: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: thread(A), strippedText: "Hi Ali, I'm out of the office this week, but yes, we're interested. Please call me on Monday." } },
  { id: "V10 Zendesk acknowledgement", nature: "AUTO", reason: "helpdesk-ack",
    in: { subject: `[Firma Support] ${SA}`, fromEmail: "support@firma.de", envelopeSender: "bounce@zendesk.example", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["X-Mailer", "Zendesk Mailer"], ["X-Zendesk-Email-Id", "01J8ZK0000000000"]],
      strippedText: "Your request (48213) has been received and is being reviewed by our support staff.\n\nTo add additional comments, reply to this email." } },
  { id: "V11 Zendesk agent (human) reply", nature: "POSSIBLE", reason: "auto-reply",
    in: { subject: `Re: ${SA}`, fromEmail: "support@firma.de", envelopeSender: "bounce@zendesk.example", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["X-Mailer", "Zendesk Mailer"]],
      strippedText: "Hi Ali, thanks. Our product lead Jonas would like to see samples of your busts." } },
  { id: "V12 Freshdesk-style acknowledgement", nature: "AUTO", reason: "helpdesk-ack",
    in: { subject: `Ticket Received - ${SA} - [#5821]`, fromEmail: "help@firma.de", envelopeSender: "help@firma.de", sentSubjects: [SA],
      headers: [], strippedText: "Thank you for contacting us. A ticket has been created (#5821) and we will get back to you shortly." } },
  { id: "V13 Gmail DSN (multipart/report)", nature: "BOUNCE", reason: "dsn",
    in: { subject: "Delivery Status Notification (Failure)", fromEmail: "mailer-daemon@googlemail.com", fromName: "Mail Delivery Subsystem", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"000000000000f00\""], ["Auto-Submitted", "auto-replied"]],
      bodyPlain: "** Address not found **\n\nYour message wasn't delivered to anna@firma.de because the address couldn't be found, or is unable to receive mail." } },
  { id: "V14 Exchange Online NDR", nature: "BOUNCE", reason: "dsn",
    in: { subject: `Undeliverable: ${SA}`, fromEmail: "postmaster@firma.onmicrosoft.com", fromName: "Microsoft Outlook", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"_000_\""], ["Auto-Submitted", "auto-replied"]],
      bodyPlain: "Delivery has failed to these recipients or groups:\n\nanna@firma.de\nThe email address you entered couldn't be found.\n\nDiagnostic information for administrators:\n\nGenerating server: AM0PR01MB0000.eurprd01.prod.outlook.com\n\nanna@firma.de\nRemote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'\n\nOriginal message headers:\n\nMessage-ID: <" + A + ">" } },
  { id: "V15 Exim bounce with Auto-Submitted (order test)", nature: "BOUNCE", reason: "dsn",
    in: { subject: "Mail delivery failed: returning message to sender", fromEmail: "mailer-daemon@mx.hoster.de", fromName: "Mail Delivery System", envelopeSender: "",
      headers: [["Auto-Submitted", "auto-generated"], ["X-Failed-Recipients", "anna@firma.de"], ["Content-Type", "text/plain; charset=utf-8"]],
      bodyPlain: "This message was created automatically by mail delivery software.\n\nA message that you sent could not be delivered to one or more of its recipients. This is a permanent error. The following address(es) failed:\n\n  anna@firma.de\n    Unrouteable address" } },
  { id: "V16 Postfix bounce", nature: "BOUNCE", reason: "dsn",
    in: { subject: "Undelivered Mail Returned to Sender", fromEmail: "mailer-daemon@mail.firma.de", fromName: "Mail Delivery System", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"8E1F2\""]],
      bodyPlain: "This is the mail system at host mail.firma.de.\n\nI'm sorry to have to inform you that your message could not\nbe delivered to one or more recipients." } },
  { id: "V17 German NDR, text only, no report", nature: "BOUNCE", reason: "dsn",
    in: { subject: `Unzustellbar: ${SA}`, fromEmail: "postmaster@firma.de", envelopeSender: "",
      headers: [["Content-Type", "text/plain; charset=iso-8859-1"]],
      bodyPlain: "Ihre Nachricht konnte nicht zugestellt werden an:\n\nanna@firma.de\nDas Postfach existiert nicht." } },
  { id: "V18 Delay DSN", nature: "BOUNCE", reason: "delay",
    in: { subject: "Delivery Status Notification (Delay)", fromEmail: "mailer-daemon@googlemail.com", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"b1\""]],
      bodyPlain: "** Message not delivered yet **\n\nFinal-Recipient: rfc822; anna@firma.de\nAction: delayed\nStatus: 4.4.1\nWill continue to try." } },
  { id: "V19 Read receipt (MDN)", nature: "AUTO", reason: "read-receipt",
    in: { subject: `Gelesen: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=disposition-notification; boundary=\"mdn\""]],
      bodyPlain: "Ihre Nachricht wurde am 22.09.2026 09:02 gelesen." } },
  { id: "V20 Challenge-response (en)", nature: "AUTO", reason: "challenge",
    in: { subject: "Please confirm your message to anna@firma.de", fromEmail: "verify@mailguard.example", envelopeSender: "",
      headers: [["Auto-Submitted", "auto-replied"]],
      strippedText: "I use a challenge-response system to block spam. To confirm you are human, click the link below:\nhttps://mailguard.example/c/8f2" } },
  { id: "V21 Challenge-response (de), no headers", nature: "AUTO", reason: "challenge",
    in: { subject: "Bitte bestätigen Sie Ihre E-Mail an info@firma.de", fromEmail: "noreply@spamschutz.example", envelopeSender: "noreply@spamschutz.example",
      headers: [], strippedText: "Ihre Nachricht wurde zurückgehalten. Bitte bestätigen Sie, dass Sie kein Roboter sind: https://spamschutz.example/v/1" } },
  { id: "V22 Colleague reply (different address, headers)", nature: "REPLY",
    in: { subject: `Re: ${SA}`, fromEmail: "jonas@firma.de", envelopeSender: "jonas@firma.de", sentSubjects: [SA],
      headers: [["In-Reply-To", "<CAFwd123@mail.gmail.com>"], ["References", `<${A}> <CAFwd123@mail.gmail.com>`]],
      strippedText: "Hi Ali, Anna forwarded me your email. We're interested in a set of dragon busts." } },
  { id: "V23 Colleague new email, no headers", nature: "REPLY",
    in: { subject: "Your 3D offer", fromEmail: "jonas@firma.de", envelopeSender: "jonas@firma.de",
      headers: [], strippedText: "Hi, my colleague Anna showed me your email. Do you also do busts?" } },
  { id: "V24 Known person, new email, no headers", nature: "REPLY",
    in: { subject: "Question", fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", headers: [], strippedText: "Do you also make figurines?" } },
  { id: "V25 Reply to catch-all / retired address", nature: "REPLY",
    in: { subject: `SV: ${SO}`, fromEmail: "ole@butikk.no", envelopeSender: "ole@butikk.no", sentSubjects: [SO],
      headers: thread(O), bodyPlain: "Hei Ali,\nja takk, send gjerne priser.\n\nDen man. 21. sep. 2026 kl. 10:15 skrev Ali Khan <ali@send.polygonparadise.com>:\n> Hei Ole," } },
  { id: "V26 Recovered from Logs, no text", nature: "POSSIBLE", reason: null,
    in: { subject: `Re: ${SA}`, fromEmail: "anna@firma.de", headers: [["Message-Id", "<x@firma.de>"]], bodyAvailable: false, sentSubjects: [SA] } },
  { id: "V27 Recovered from Logs, auto subject", nature: "POSSIBLE", reason: "out-of-office",
    in: { subject: `Automatic reply: ${SA}`, fromEmail: "anna@firma.de", headers: [], bodyAvailable: false, sentSubjects: [SA] } },
  { id: "V28 Human reply with Auto-Submitted: no", nature: "REPLY",
    in: { subject: `Re: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "no"]], strippedText: "Yes please, send the catalogue." } },
  { id: "V29 Outlook human reply with XARS RN, NRN", nature: "REPLY",
    in: { subject: `RE: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["X-Auto-Response-Suppress", "RN, NRN"]], strippedText: "Thanks Ali, what are your rates?" } },
  { id: "V30 Human text with only XARS All", nature: "POSSIBLE", reason: "auto-reply",
    in: { subject: `RE: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["X-Auto-Response-Suppress", "All"]], strippedText: "Thanks Ali, what are your rates?" } },
  { id: "V31 CRM autoresponder (bulk + list + noreply)", nature: "AUTO", reason: "auto-reply",
    in: { subject: "Thanks for contacting Firma!", fromEmail: "noreply@firma.de", envelopeSender: "bounces@crm.example",
      headers: [["Precedence", "bulk"], ["List-Unsubscribe", "<https://crm.example/u/1>"]],
      strippedText: "We received your message and will get back to you within 48 hours." } },
  { id: "V32 French OOF with X-Autoreply", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Réponse automatique : ${SA}`, fromEmail: "claire@boutique.fr", envelopeSender: "claire@boutique.fr", sentSubjects: [SA],
      headers: [["X-Autoreply", "yes"]], strippedText: "Je suis absente du bureau jusqu'au 5 octobre. Pour toute urgence, contactez contact@boutique.fr." } },
  { id: "V33 Spanish OOF, subject only", nature: "AUTO", reason: "out-of-office",
    in: { subject: "Fuera de la oficina", fromEmail: "luis@tienda.es", envelopeSender: "luis@tienda.es", sentSubjects: [SA],
      headers: [], strippedText: "Estoy fuera de la oficina hasta el 10 de octubre. Para asuntos urgentes, contacte con info@tienda.es." } },
  { id: "V34 Polish OOF", nature: "AUTO", reason: "out-of-office",
    in: { subject: `Automatyczna odpowiedź: ${SA}`, fromEmail: "jan@sklep.pl", envelopeSender: "", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"]], strippedText: "Jestem na urlopie do 3 października. W pilnych sprawach proszę pisać na biuro@sklep.pl." } },
  { id: "V35 Dutch human reply (Gmail nl)", nature: "REPLY", first: "Ja graag, stuur de prijzen.",
    in: { subject: `Re: ${SA}`, fromEmail: "pieter@winkel.nl", envelopeSender: "pieter@winkel.nl", sentSubjects: [SA],
      headers: thread(A), bodyPlain: "Ja graag, stuur de prijzen.\n\nOp ma 21 sep 2026 om 10:15 schreef Ali Khan <ali@send.polygonparadise.com>:\n\n> Hoi Pieter," } },
  { id: "V36 Nynorsk OOF, own subject, no headers", nature: "AUTO", reason: "out-of-office",
    in: { subject: "Fråværsmelding", fromEmail: "kari@butikk.no", envelopeSender: "kari@butikk.no", sentSubjects: [SO],
      headers: [], strippedText: "Eg er ikkje på kontoret før 14. oktober." } },
  { id: "V37 Human subject mentions holiday", nature: "POSSIBLE", reason: "auto-reply",
    in: { subject: "Before our holiday - yes, interested!", fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: thread(A), strippedText: "Yes please send details before Friday." } },
  { id: "V38 Left the company (auto)", nature: "AUTO", reason: "left-company",
    in: { subject: `Automatic reply: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"]], strippedText: "Anna Berg is no longer with Firma GmbH. Please contact info@firma.de." } },
  { id: "V39 Successor writes (human, left-company words)", nature: "POSSIBLE", reason: "left-company",
    in: { subject: `Re: ${SA}`, fromEmail: "jonas@firma.de", envelopeSender: "jonas@firma.de", sentSubjects: [SA],
      headers: thread(A), strippedText: "Hi Ali, Anna is no longer with us - I took over purchasing and would like a quote." } },
  { id: "V40 Swedish human reply, Outlook header block", nature: "REPLY", first: "Hej Ali! Låter bra, skicka gärna en offert.",
    in: { subject: `SV: ${SA}`, fromEmail: "erik@butik.se", envelopeSender: "erik@butik.se", sentSubjects: [SA],
      headers: thread(A), bodyPlain: "Hej Ali!\nLåter bra, skicka gärna en offert.\n\nSkickat från min iPhone\n\nFrån: Ali Khan <ali@send.polygonparadise.com>\nSkickat: den 21 september 2026 10:15\nTill: Erik <erik@butik.se>\nÄmne: 3D models for your shop" } },
];

// Quote-stripping vectors: body-plain in, expected firstLines(extractNewText(null, body)) out.
export const quoteVectors: Array<[string, string, string]> = [
  ["Q01 Gmail fr", "Oui, merci !\n\nLe lun. 21 sept. 2026 à 10:15, Ali Khan <ali@send.polygonparadise.com> a écrit :\n> Bonjour Claire,", "Oui, merci !"],
  ["Q02 Gmail pl", "Tak, proszę o cennik.\n\npon., 21 wrz 2026 o 10:15 Ali Khan <ali@send.polygonparadise.com> napisał(a):\n> Dzień dobry,", "Tak, proszę o cennik."],
  ["Q03 Gmail es wrapped", "Sí, envíeme precios.\n\nEl lun, 21 sept 2026 a las 10:15, Ali Khan (<\nali@send.polygonparadise.com>) escribió:\n> Hola Luis,", "Sí, envíeme precios."],
  ["Q04 Gmail it", "Sì, grazie.\n\nIl giorno lun 21 set 2026 alle ore 10:15 Ali Khan <ali@send.polygonparadise.com> ha scritto:\n> Buongiorno,", "Sì, grazie."],
  ["Q05 Thunderbird nb", "Ja takk.\n\nDen 21.09.2026 10:15, skrev Ali Khan:\n> Hei Ole,", "Ja takk."],
  ["Q06 Apple Mail de", "Gerne!\n\nVon meinem iPhone gesendet\n\n> Am 21.09.2026 um 10:15 schrieb Ali Khan <ali@send.polygonparadise.com>:\n>\n> Hallo Anna,", "Gerne!"],
  ["Q07 Outlook fr block", "Bonjour Ali,\nMerci, envoyez le catalogue.\n\nDe : Ali Khan <ali@send.polygonparadise.com>\nEnvoyé : lundi 21 septembre 2026 10:15\nÀ : Claire <claire@boutique.fr>\nObjet : 3D models for your shop", "Bonjour Ali, Merci, envoyez le catalogue."],
  ["Q08 Outlook classic en", "Please call me.\n\n-----Original Message-----\nFrom: Ali Khan [mailto:ali@send.polygonparadise.com]\nSent: Monday, September 21, 2026 10:15 AM", "Please call me."],
  ["Q09 Outlook classic de", "Bitte anrufen.\n\n-----Ursprüngliche Nachricht-----\nVon: Ali Khan\nGesendet: Montag, 21. September 2026 10:15", "Bitte anrufen."],
  ["Q10 Outlook web underscores (nb)", "Hei, send gjerne priser.\n\n________________________________\nFra: Ali Khan <ali@send.polygonparadise.com>\nSendt: mandag 21. september 2026 10:15\nTil: Ole <ole@butikk.no>\nEmne: 3D-modeller til butikken deres", "Hei, send gjerne priser."],
  ["Q11 Bottom-posted", "On Mon, Sep 21, 2026 at 10:15 AM Ali Khan <ali@send.polygonparadise.com> wrote:\n> Hi Anna,\n> would you like samples?\n\nYes, please send two.", "Yes, please send two."],
  ["Q12 Gmail forward with comment", "Jonas, see below - interesting?\n\n---------- Forwarded message ---------\nFrom: Ali Khan <ali@send.polygonparadise.com>\nDate: Mon, Sep 21, 2026 at 10:15 AM", "Jonas, see below - interesting?"],
  ["Q13 Gmail de forward", "Schau mal.\n\n---------- Weitergeleitete Nachricht ---------\nVon: Ali Khan <ali@send.polygonparadise.com>\nDate: Mo., 21. Sept. 2026 um 10:15 Uhr", "Schau mal."],
  ["Q14 Signature dash-dash", "Sounds good.\n-- \nAnna Berg | Firma GmbH | +49 30 1234567", "Sounds good."],
  ["Q15 Human 'wrote' in text is kept", "My colleague wrote: we need 20 pieces.\nCan you do that?", "My colleague wrote: we need 20 pieces. Can you do that?"],
];

let fail = 0;
for (const [id, body, want] of quoteVectors) {
  const got = firstLines(extractNewText(null, body));
  if (got !== want) { fail++; console.log(`FAIL ${id}: got "${got}" want "${want}"`); }
}
for (const v of vectors) {
  const r = classify(v.in);
  const okFirst = !v.first || firstLines(extractNewText(v.in.strippedText, v.in.bodyPlain)) === v.first;
  if (r.nature !== v.nature || (v.reason !== undefined && r.autoReason !== v.reason) || !okFirst) {
    fail++;
    console.log(`FAIL ${v.id}: got ${r.nature}/${r.autoReason} want ${v.nature}/${v.reason} [${r.signals.join(", ")}]`);
  }
}
console.log(`${vectors.length + quoteVectors.length - fail}/${vectors.length + quoteVectors.length} passed`);
```
