# Research (implementation reference, verified 2026-09-23): Mailgun endpoints used by Milestone 3, with exact request and response shapes and the fake-server contract

Collected for Milestone 3 (PLAN.md A8 item 3, B6.7–B6.11, B9, B12). This file covers **wire formats only**: methods, paths, content types, field names, response JSON, errors, paging. For the reasoning behind each design choice, read the planning research first and don't repeat it here:

- [mailgun-sending.md](mailgun-sending.md): send parameters, Message-ID, the unsubscribe design, test mode, limits, the crash-safe state machine.
- [mailgun-events.md](mailgun-events.md): webhook semantics, retries, signature policy, reconciliation after downtime, suppression strategy.
- [mailgun-inbound-validation-domain.md](mailgun-inbound-validation-domain.md): route design, inbound payload semantics, retention, DNS checklist, address validation.
- [cloudflare.md](cloudflare.md): the public webhook paths.

**Sources, in order of trust:**

1. The OpenAPI bundle `https://documentation.mailgun.com/_bundle/docs/mailgun/api-reference/send/mailgun.yaml` (downloaded 2026-09-23: `info.version 3.0.0`, 855,857 bytes). Schema and example names are quoted as `#/components/schemas/...`.
2. The `.md` variants of the documentation.mailgun.com user-manual pages.
3. The official SDKs `mailgun.js` (master) and `mailgun-go` v5 (HEAD). These show how Mailgun's own code calls each endpoint.

help.mailgun.com returns 403 to automated fetches, so anything taken only from its search snippets is marked as such. **UNVERIFIED** means it is not stated in an official source, or official sources contradict each other. Section 16 lists read-only probes that settle most of these points once the owner's account exists.

> JSON marked *(spec example)* is copied from the OpenAPI examples. JSON marked *(ours)* is what our code sends or expects in our setup. Neither was captured from a live account.

---

## 0. Rules that apply to every call

### 0.1 Hosts

| Purpose | US | EU |
|---|---|---|
| REST API | `https://api.mailgun.net` | `https://api.eu.mailgun.net` |
| Message storage (stored mail, `storage.url`, `message-url`) | `https://storage-us-east4.api.mailgun.net`, `https://storage-us-west1.api.mailgun.net` | `https://storage-europe-west1.api.mailgun.net` |

- The storage hosts come from the official webhook-payload examples and the `DELETE /v3/{d}/envelopes` reference. The EU host is also named in mailgun-php issue #902.
- **Always GET the exact storage URL Mailgun hands you.** Never build the storage host yourself.
- Send the API key only to `https:` URLs whose hostname ends in `.mailgun.net` (plus the fake-server origin in tests; see section 15).
- The owner's default is EU, so production uses `api.eu.mailgun.net` and `storage-europe-west1.api.mailgun.net`.

### 0.2 Auth

- Header: `Authorization: Basic base64("api:" + key)`.
- The key is the Developer-role **account** key. A Domain Sending Key only works on `POST /v3/{d}/messages`.
- RBAC (official rbac-mgmt page):
  - Developer has Read/Write on Domains, Messages, Webhooks, Logs, Routes, the Bounces/Complaints/Unsubscribes suppression lists, Secure Tracking and Account Management.
  - Developer has **Read only on Custom Message Limit**, so the app cannot set that limit (see section 12).

### 0.3 Content types (what our fetch client must send)

| Endpoint | Request body |
|---|---|
| `POST /v3/{d}/messages` | `multipart/form-data`. Pass a `FormData`; **don't set Content-Type yourself**, because fetch adds the boundary. |
| `POST /v1/analytics/logs` | `application/json` |
| `POST /v3/{d}/unsubscribes` (bulk) | `application/json`, a top-level array |
| `POST/PUT /v4/domains/{d}/webhooks` | `application/x-www-form-urlencoded`. Build a `URLSearchParams` and `append()` the repeated `event_types`. |
| `DELETE /v4/domains/{d}/webhooks` | no body; `?url=` query, repeatable |
| `POST /v3/routes`, `PUT /v3/routes/{id}` | `application/x-www-form-urlencoded` per the spec (mailgun.js sends multipart, which also works). `action` is repeated. |
| `PUT /v4/domains/{d}` | `multipart/form-data` |
| `PUT /v3/domains/{d}/tracking/{open,click,unsubscribe}` | `multipart/form-data` |
| `PUT /v4/domains/{d}/verify`, `POST/PUT /v2/x509/{host}` | no body |
| `PUT /v5/accounts/limit/custom/monthly` | no body; `?limit=N` query |
| every GET | no body |

Booleans in form bodies are the strings `true` and `false`. mailgun.js sends `yes` and `no` for the tracking `active` fields, and both are accepted.

### 0.4 Error bodies are NOT uniform (surprise)

The spec shows five different error shapes:

| Shape | Where seen |
|---|---|
| `{"message": "..."}` | most endpoints (messages 400/429/500, domains 401/404, suppressions, routes, account) |
| plain text `Forbidden` | `POST /v3/{d}/messages` 401. The spec types it as a bare string; it is not valid JSON. |
| `{"Reason": "..."}` | v3/v4 webhooks 400, x509 400/402 |
| `{"Description": "..."}` | x509 404/409/429, v4 webhooks PUT 404 |
| `{"Field": "url"}` | v4 webhooks DELETE 400 |

**Client rule:**

1. Read the body as text.
2. Try `JSON.parse`.
3. Error text = `j.message ?? j.Reason ?? j.Description ?? (j.Field && 'invalid field ' + j.Field) ?? text`.
4. Keep the raw body, cut to 2 KB and passed through the redactor, for the log.

### 0.5 Status codes (official api-overview page)

| Code | Meaning (Mailgun) | Our handling |
|---|---|---|
| 200 / 202 | OK; 202 = x509 background job queued | success |
| 400 | Bad request; `message` explains | permanent for that request |
| 401 | "Invalid or missing API key" | global pause + Owner alert (B6.6) |
| 402 | x509 only: plan does not include the feature | red checklist row |
| 403 | "Valid credentials but access denied" | global pause + Owner alert |
| 404 | "Resource not found. **May be temporal due to eventually-consistent system**. Missing JSON response usually indicates incorrect endpoint" | see 0.8; retry once after 5 s before treating as real |
| 406 | never returned to us; it is what *we* return to Mailgun | — |
| 409 | x509 only: already initiated or still valid | treat as "go and poll" |
| 429 | rate limited ("Retry as defined in response headers"); **x509 PUT uses 429 for "job already in progress"** | back off, see 0.6 |
| 500 | "Retry with exponential backoff" | send → Unknown (B6.7); other calls → retry |

### 0.6 Rate limits

- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- The docs describe Reset as "Unix milliseconds (UTC) until the limit resets", which is ambiguous: it could be an absolute epoch time or a delay. **UNVERIFIED which.** Rule:
  - If the value is above 10^12, treat it as an absolute epoch in ms.
  - Otherwise treat it as a delay in ms.
  - Otherwise parse `try again after (\d+) seconds` from the message.
  - Otherwise wait 60 s.
  - Clamp the wait to 1 s–15 min.
- Windows "may vary by API". The only published number is the Metrics API (500 requests per 10 s). There are no published numbers for the endpoints below.

### 0.7 Date formats (all different)

| Where | Format | Example |
|---|---|---|
| Our request dates (Logs `start`/`end`, suppression `created_at`) | RFC 2822. Use a numeric offset or GMT/UTC, never EST/CET-style abbreviations (api-overview). mailgun.js formats it as `date.toUTCString().slice(0,25) + ' -0000'`. | `Wed, 23 Sep 2026 10:00:00 -0000` |
| Logs response `start`/`end` | RFC 2822 | `Mon, 08 Jul 2024 00:00:00 -0000` |
| Logs item `@timestamp` | ISO 8601 | `2024-07-08T16:30:18.530Z` |
| Webhook `event-data.timestamp` | float epoch seconds | `1770146431.6585283` |
| Webhook `signature.timestamp` | **string** of epoch seconds (the docs table says int) | `"1770920772"` |
| Inbound form `timestamp` | decimal string (a form field) | `1770920772` |
| Suppression `created_at` | RFC 822 with `UTC` | `Thu, 11 Dec 2025 01:49:40 UTC` |
| Domain/route `created_at` | RFC 1123 | `Wed, 15 Feb 2012 13:03:31 GMT` |

`Date.parse` in Node 24 handles every string form above. Still, reject `NaN` explicitly.

### 0.8 Wrong region, wrong key, business verification

- **Unknown domain in the chosen region:**
  - Domain endpoints (`/v4/domains/{d}`, `/v3/domains/{d}/tracking`, `/v3/domains/{d}/webhooks`, `/sending_queues`, verify): 404 `{"message":"Domain not found"}` (spec).
  - Sends: third-party reports disagree. One gives `Domain not found: <domain>` (status not shown); others give 401 `Forbidden` (Ghost forum, Directus issue). **UNVERIFIED.**
  - "Test connection" rule:
    1. Call `GET /v4/domains/{d}` on the chosen region.
    2. On 404 or 401, call the same GET on the other region, read-only.
    3. If that succeeds, say "Your domain is in the US/EU region. Change the region setting."
    4. Otherwise say "Check the API key and domain name."
- **Wrong key:**
  - Sends: 401 plain `Forbidden` (spec).
  - Domain, tracking and webhook endpoints: 401 `{"message":"Invalid private key"}` (spec).
  - Keys restricted by IP allowlist or pasted with zero-width characters also give 401 (Ghost forum). Trim the key on save and strip `​-‍﻿`.
- **Business verification:** a help-centre article is titled *"Why did I receive the error 'Business verification is required'?"* and says the text arrives "through an API/SMTP error" while the account is disabled or on probation. Status and exact JSON are **UNVERIFIED** (probably 403 or 400 `{"message": "... business verification is required ..."}`). Rule: any 4xx body matching `/business verification/i` → global pause with that reason (B6.6).
- **Sandbox / free plan without card:** third-party reports give `Domain <d> is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.` (status **UNVERIFIED**, reported as 403, sometimes 421).
- Rule for sends: 4xx other than 400/429 whose text contains `is not allowed to send` → global pause. The same phrase also appears in the **429** rate-limit text, so check the status code first.

---

## 1. Send: `POST /v3/{domain}/messages`

The fields and their meaning are in [mailgun-sending.md](mailgun-sending.md) and B6.8. This section is the wire format only.

**Request** (`multipart/form-data`; the spec requires `from`, `to` and `subject`, plus one of `text`/`html`/`amp-html`/`template`):

| Field | Type | We send |
|---|---|---|
| `from` | string, may include a display name | `Ali Khan <ali@send.example.com>` |
| `to` | string (the spec types it as an array; repeat or comma-separate) | exactly one recipient, `Name <addr>` |
| `subject` | string | |
| `text` | string | always |
| `html` | string | always |
| `h:Message-Id` | string | `<pp.{random}@{sendingDomain}>` (B6.7) |
| `h:In-Reply-To`, `h:References` | string | follow-ups (M4) |
| `h:Reply-To` | string | only in Setup C (B6.8) |
| `o:tracking-opens` | `yes\|no\|true\|false` | `no` |
| `o:tracking-clicks` | `yes\|no\|true\|false\|htmlonly` | `no` |
| `o:tag` | string, repeatable, at most 3 | `outreach`, `step-N` |
| `v:send_id`, `v:campaign_id`, `v:step` | string | opaque ids |
| `o:testmode` | `yes` | only in "Mailgun test mode" |

All `o:`, `h:`, `v:` and `t:` fields together must stay **≤ 16 KB**.

**200** *(spec schema `SendMessageResponse`; the id example is from mailgun.js)*:
```json
{ "id": "<20151025002517.117282.79817@sandbox-123.mailgun.org>", "message": "Queued. Thank you." }
```
`id` carries angle brackets. With `h:Message-Id` set, `id` echoes our header value (Ghost PR, **UNVERIFIED** officially).

**Errors** (spec):

| Status | Body |
|---|---|
| 400 | `{"message":"to parameter is not a valid address. please check documentation."}`. Other documented texts: `Need at least one of 'text', 'html', 'amp-html' or 'template' parameters specified.`, `from parameter is missing.`, `Send options (parameters starting with o:, h:, or v:) are limited to 16KB total` |
| 401 | `Forbidden` (plain text) |
| 429 | `{"message":"Domain example.com is not allowed to send: account-requests-per-sec limit exceeded, try again after 120 seconds"}` plus `X-RateLimit-*` |
| 500 | `{"message":"Internal Server Error"}` |

**No idempotency.** A timeout, network error or 5xx is ambiguous (B6.7).

---

## 2. Logs: `POST /v1/analytics/logs`

Account-wide: always filter by domain. Use the base URL of the region.

### 2.1 Request (`application/json`, schema `LogsRequest`)

| Field | Type | Notes |
|---|---|---|
| `start` | string, RFC 2822 | default: `end` minus 1 day |
| `end` | string, RFC 2822 | default: now |
| `duration` | string such as `"1d"` or `"2h"` | **marked `required` in the schema**, yet the spec example and mailgun.js never send it. If present it "is calculated from the end date and overwrites the start date". |
| `events` | string[] | enum: `accepted, delivered, failed, opened, unique_opened, clicked, unique_clicked, unsubscribed, complained, rejected, stored, email_validation, list_uploaded, list_member_uploaded, list_member_upload_error, trapped` |
| `metric_events` | string[] | not used |
| `filter` | `{ "AND": [ {attribute, comparator, values:[{label, value}]} ] }` | AND only, no OR. `label` and `value` are both required strings (mailgun.js rejects empty ones), so send `label = value`. |
| `include_subaccounts` | bool | not used |
| `include_totals` | bool | adds `pagination.total` |
| `pagination` | `{ sort, token, limit }` | `sort`: `"timestamp:asc"` or `"timestamp:desc"`; `limit` **max 100**; `token`: an opaque page token from the previous response |

Filter `attribute` enum (schema `FilterAttribute`):

```
id, domain, ip, ip_pool, recipient_domain, recipient_provider, country, bot, device, subaccount, event, attachment_filename, from, message_id, subject, mailing_list_address, to, size, recipient, tag, severity, user_variables, delivered_at, delivery_status_code, delivery_status_bounce_type, delivery_status_message, is_routed, i_classification_rule_id, i_classification_group_id, recipients
```

Comparators:

- `=`, `!=`, `contains`, `not contains` (Metrics filter page).
- `<` and `>` for `size` and `delivered_at` (attribute descriptions).
- `recipients` accepts only `contains` or `not contains`.

The Logs page itself does not list comparators. What happens when one predicate has several entries in `values` (OR or AND) is **UNVERIFIED**, so always send one value per predicate.

Useful attribute notes from the schema:

- `message_id`: "ties together the accepted, delivered, and any failed events".
- `user_variables`: "stored as a flat JSON string and filters search against keys or values", so use `contains`.
- `severity`: `temporary` or `permanent`.

**Our queries** *(ours)*:

Reconcile one send:
```json
{
  "start": "Wed, 23 Sep 2026 09:50:00 -0000",
  "end": "Wed, 23 Sep 2026 11:00:00 -0000",
  "events": ["accepted", "delivered", "failed"],
  "filter": { "AND": [
    { "attribute": "domain", "comparator": "=", "values": [ { "label": "send.example.com", "value": "send.example.com" } ] },
    { "attribute": "message_id", "comparator": "=", "values": [ { "label": "pp.k3j9x2@send.example.com", "value": "pp.k3j9x2@send.example.com" } ] }
  ] },
  "pagination": { "sort": "timestamp:asc", "limit": 100 }
}
```

- `message_id` is sent **without** angle brackets, because events carry it without them.
- Whether the index also matches the bracketed form is **UNVERIFIED**.
- Fallback predicate: `{ "attribute": "user_variables", "comparator": "contains", "values": [ { "label": "<send_id>", "value": "<send_id>" } ] }`.

Catch-up (B6.11 step 3): same shape, `events: ["delivered","failed","complained","unsubscribed","accepted"]`, domain filter only. Replies (step 4): `events: ["stored"]`.

### 2.2 Response 200 (schema `LogsResponse`) *(spec example)*

```json
{
  "start": "Mon, 08 Jul 2024 00:00:00 -0000",
  "end": "Fri, 12 Jul 2024 00:00:00 -0000",
  "items": [ {
    "id": "JDhSWf9mT5OFxCkZfpDU5d",
    "event": "failed",
    "@timestamp": "2024-07-08T16:30:18.530Z",
    "account": { "id": "12345" },
    "delivery-status": { "message": "Turret client: server connection failed", "attempt-no": 5, "code": 680, "session-seconds": 15.026, "retry-seconds": 145 },
    "domain": { "name": "example.com" },
    "recipient": "example@gmail.com",
    "recipient-domain": "gmail.com",
    "recipient-provider": "Gmail",
    "envelope": { "sender": "bob@example.com", "transport": "smtp", "sending-ip": "198.52.100.1", "targets": "bob@example.com" }
  } ],
  "pagination": { "previous": "…", "next": "cjsijbijewbu78t678tVTYUYU76754fyuiksin98hh", "first": "…", "last": "…", "total": 100 },
  "aggregates": {}
}
```

- Required: `start`, `end`, `items`, `pagination`.
- Every `pagination` key is optional. mailgun.js types them `?` with the comment "not always returned".

Item (schema `LogEvent`). Required: `id`, `event`, `@timestamp`, `domain`. The fields we read:

| Path | Type | Note |
|---|---|---|
| `id` | string | event id ("unique within a day") |
| `event` | string | as in the enum above |
| `@timestamp` | string, ISO 8601 | |
| `domain.name` | string | |
| `recipient` | string | |
| `message.headers["message-id"]` | string | no angle brackets |
| `message.headers.from` / `.to` / `.subject` | string | |
| `user-variables` | **string** (a JSON-encoded object) | webhooks give an **object**. Parse defensively (see mailgun-events.md). |
| `tags` | string[] | |
| `severity`, `reason`, `log-level` | string | failed events |
| `delivery-status` | object: `code` int, `message`, `description`, `bounce-type`, `attempt-no`, `retry-seconds`, `enhanced-code`, `mx-host`, `last-code`, `last-message`, `session-seconds`, `tls`, `utf8`, `certificate-verified`, `first-delivery-attempt-seconds` | |
| `flags` | object: `is-test-mode`, `is-routed`, `is-delayed-bounce`, `is-authenticated`, `is-system-test`, `is-callback`, `is-webhook` (required), plus `is-encrypted`, `is-amp` | |
| `storage` | `{ region, env, key, url: string[] }` | **`url` is an array here**; in webhooks it is a string |
| `routes` | `{ id, priority, expression, description, actions: string, match: { recipient } }` | on inbound events; `actions` is a single string |
| `envelope` | `{ sender, transport, sending-ip, targets, i-ip-pool-id }` | |
| other | `account {id, parent-id}`, `campaigns[]`, `method`, `originating-ip`, `api-key-id`, `delivered-at` (string), `primary-dkim`, `ip`, `geolocation`, `client-info`, `template`, `mailing-list`, `url`, `recipient-domain`, `recipient-provider` | |

### 2.3 Paging

1. Send the request with `pagination.limit = 100` and no token.
2. Next page: send the **identical body** with `pagination.token = <previous response>.pagination.next`. Changing the filters mid-walk is **UNVERIFIED**, so don't.
3. Stop when any of these is true:
   - `items.length === 0`;
   - `pagination.next` is missing or empty;
   - `pagination.next` equals the token just sent;
   - the page guard is reached (1,000 pages).
   Don't stop on `items.length < limit`, and don't trust `total`.
4. Only after a complete walk may the cursor advance (B6.11).

### 2.4 Errors, limits and duration

- 400 → `{"message": "..."}`. The spec gives no texts.
- **`duration` rule:**
  1. Send `start` and `end` only, like the official SDK.
  2. If a 400 message mentions `duration`, retry once with `end` plus `duration: "<ceil hours>h"` and no `start`.
  3. Record which form worked in a setting, so the retry happens only once per install.
- Maximum time range per request and the rate limit: not documented. Treat a window older than plan retention as a gap; don't expect an error for it.
- Retention per plan: see mailgun-events.md. The Tracking Messages intro page still says "at least 30 days for paid accounts", which contradicts the pricing page (Foundation: 5 days). Plan with the pricing figure.

---

## 3. Suppression lists

### 3.1 `GET /v3/{domain}/bounces` · `/complaints` · `/unsubscribes`

Query parameters:

- `limit`: default 100, max 1000.
- `page`: `next`, `previous` or `last`; empty means the first page.
- `address`: the page divider.
- `term`: address prefix filter.

The spec marks `page`, `term` (and `address`) as "required", but the descriptions say optional. That is a generator bug: send only `limit=1000`.

**200** *(spec examples)*:
```json
{ "items": [ { "address": "foo@bar.com", "code": "550", "error": "No such mailbox", "created_at": "Thu, 11 Dec 2025 01:49:40 UTC" } ],
  "paging": { "previous": "<previous page url>", "first": "<first page url>", "next": "<next page url>", "last": "<last page url>" } }
```

| List | Item fields |
|---|---|
| bounces | `address`, `code` (**string** in the spec; accept a number too), `error`, `created_at` |
| complaints | `address`, `created_at` |
| unsubscribes | `address`, `tags` (string[]; `["*"]` = everything), `created_at` |

`paging` holds **absolute URLs** (schema `paging-PagingResponse`, all four keys required). The query shape `?page=next&address=<last address>&limit=N` comes from third-party reports; mailgun.js reads the `address` parameter out of it. Treat the URL as opaque. **UNVERIFIED** in detail.

**Paging algorithm** (same for all three lists):

1. `url = base + '/v3/' + d + '/<list>?limit=1000'`.
2. GET `url`.
3. If `items` is empty, **stop**. The official mailgun-go iterator's `Next()` returns false exactly when `len(items) == 0`, and `paging.next` is always present, so never stop on "no next".
4. Process the items.
5. `next = paging.next`. Abort if `new URL(next).origin !== new URL(base).origin` (never send the key elsewhere), if `next === url`, or at 1,000 pages.
6. Set `url = next` and go back to step 2.

Errors: 400 `{"message": ...}`.

### 3.2 `POST /v3/{domain}/unsubscribes` (JSON bulk form)

- Header `Content-Type: application/json`. The body is a top-level array of objects (schema `UnsubscribesList`):
```json
[ { "address": "anna@example.de", "tags": ["*"], "created_at": "Wed, 23 Sep 2026 10:00:00 -0000" } ]
```
- `address` is required.
- `tags`: always send `["*"]`. The JSON-form default is not documented; the single form-data record defaults to `*`.
- `created_at` is optional (RFC 2822; default now).
- The spec's JSON *example* spells the key `createdat`. That is a generator artefact: the schema and both SDKs use `created_at`.
- **Batch size: at most 999.** The description says "up to 1000", but the documented 400 is `{"message":"Batch size should be less than 1000"}`, and the official Ruby SDK splits at 999.
- **200:** `{"message":"4 addresses have been added to the unsubscribes table"}` (the count varies).
- Re-adding an existing address: assumed upsert, **UNVERIFIED**. Our code must not depend on it.
- There is also a single-record form-data variant (`address`, `tag` or `tags`, `created_at`). We don't use it.

---

## 4. Webhook registration

**There is no `GET /v4/domains/{d}/webhooks`.** The spec has only PUT, POST and DELETE on v4. Read the current state through v3, and correct B9, which lists "GET/POST/PUT /v4/…".

### 4.1 `GET /v3/domains/{domain}/webhooks`

**200** *(spec example, abridged)*:
```json
{ "webhooks": {
    "delivered":      { "urls": ["https://foo.com", "https://bar.com"] },
    "permanent_fail": { "urls": ["https://foo.com"] },
    "temporary_fail": { "urls": ["https://foo.com"] },
    "complained":     { "urls": ["https://foo.com"] },
    "unsubscribed":   { "urls": ["https://foo.com"] } } }
```

- Keys: `accepted`, `delivered`, `opened`, `clicked`, `unsubscribed`, `complained`, `temporary_fail`, `permanent_fail`.
- Each value is `{urls: string[]}` or `null` (schema `anyOf null`).
- Unconfigured types may be missing or null (**UNVERIFIED** which).
- Older entries may use `{"url": "..."}` instead of `urls`. The official Go SDK merges both, so do the same.
- 401 `{"message":"Invalid private key"}`, 404 `{"message":"Domain not found"}`.

### 4.2 `POST /v4/domains/{domain}/webhooks` (create one URL for several types)

- `application/x-www-form-urlencoded`: `url=https%3A%2F%2Foutreach.example.com%2Fapi%2Fwebhooks%2Fmailgun%2Fevents&event_types=delivered&event_types=permanent_fail&event_types=temporary_fail&event_types=complained&event_types=unsubscribed`.
- Both `url` and `event_types` are required.
- **200:** the **whole** mapping for the domain, same shape as 4.1.
- **400** `{"Reason":"Webhook for event type 'clicked' with URL 'https://example.com/webhooks' already exists"}`. So POST fails if the URL is already registered for any requested type; use PUT then.
- 404 `{"message":"Domain not found"}`.

### 4.3 `PUT /v4/domains/{domain}/webhooks` (replace one URL's types)

- Same body as POST. It "replaces the existing event type associations for the given URL".
- 200: the whole mapping.
- 400 `{"Reason":"invalid parameters: https://invalid is not a valid url: invalid URL scheme"}`.
- **404 `{"Description":"Webhook not found"}`** when the URL isn't registered.

### 4.4 `DELETE /v4/domains/{domain}/webhooks?url=<u1>&url=<u2>`

- Removes each URL from every type.
- 200: the whole mapping.
- 400 `{"Field":"url"}`.

### 4.5 Notes and our algorithm

- The v3 400 example `{"Reason":"https://example.com/ is not a valid url: host not found"}` shows that **Mailgun resolves the webhook host when you register it**. The tunnel hostname must exist in public DNS first.
- At most 3 URLs per event type. The error text for a fourth is **UNVERIFIED**.
- The URL must be https with a publicly trusted certificate (Cloudflare provides one).

**"Register webhooks" algorithm:**

1. GET v3.
2. Collect the types whose `urls` (or `url`) include our URL.
3. If none: POST v4. If the set differs from the wanted five: PUT v4. Otherwise do nothing.
4. GET v3 again and check.

---

## 5. Signing key: `GET /v5/accounts/http_signing_key`

- **200** *(spec)*: `{"http_signing_key":"key-55c5c5c5c55f55ca5cd5f55d5c555c55"}`. The schema also allows `message`.
- 400 `{"message":"could not get HSK for account"}`.
- `POST` on the same path creates or **regenerates** the key: `{"message":"regenerated HTTP signing key for account","http_signing_key":"key-…"}`. **Never call POST from the app.** It would break verification of every in-flight retry.
- The HMAC key is the returned string exactly as given (the spec example starts with `key-`; don't strip it).
- Account-level. Whether US and EU have separate keys is **UNVERIFIED**, so call it on the region's base URL.

---

## 6. Routes (account-wide, not per domain)

### 6.1 Expression and action syntax (user-manual pages)

**Filters:**

- `match_recipient("<python regex>")` matches the SMTP RCPT TO. The docs show both unanchored examples (`".*@bar.com"`) and anchored ones (`"^chris\+(.*)@example.com$"`, with a **single** backslash escape).
- `match_header("<header>", "<regex>")`.
- Combine with lowercase ` and `: `match_recipient('^(.*)@example.com$') and match_header("Content-Language", "^(.*)en-US(.*)$")`.
- Captures `\1` and `\g<name>` can be used in actions.
- `catch_all()` "will create matches if no proceeding routes matched". The Routes overview table spells it `catchall()`; use `catch_all()`, which is the documented example.
- Single and double quotes both appear in the docs.
- Case sensitivity is not documented.

**Actions:**

- `forward("dest")`: dest is an email address or URL; several destinations go in one string, comma-separated: `forward("http://a/x, b@c.com")`.
- `store()` or `store(notify="https://…")`.
- `stop()`.

**Evaluation order:**

- `priority`: an integer, **smaller = earlier**, default 0.
- "By default, all Routes are evaluated (even if a higher priority Route is triggered)". `stop()` ends the waterfall.
- Equal priorities run "in chronological order". That wording is from a mailgun-go code comment, not the manual: **UNVERIFIED**.

**Limits:**

- The filter and the action field are each ≤ 4k characters.
- Plans: Free 1 route, Basic 5, Foundation "full access".

Our sender route *(ours, per B6.10)*:

- `priority=10`
- `description=outreach-app:user:<userId>`
- `expression=match_recipient("^ali@send\.example\.com$")`
- `action=forward("ali.real@gmail.com")`, then `action=store(notify="https://outreach.example.com/api/webhooks/mailgun/inbound")`, then `action=stop()`

The catch-all is `priority=100`, `expression=catch_all()` or an anchored domain regex. The domain regex is safer for `/match` checks, because `catch_all()` is account-wide.

### 6.2 Endpoints

**Route object** (schema `RouteResponse`):
```json
{ "id": "4f3bad2335335426750048c6", "priority": 0, "description": "Sample route",
  "expression": "match_recipient(\".*@samples.mailgun.org\")",
  "actions": ["forward(\"http://myhost.com/messages/\")", "stop()"],
  "created_at": "Wed, 15 Feb 2012 13:03:31 GMT" }
```

| Call | Request | 200 | Errors |
|---|---|---|---|
| `POST /v3/routes` | form: `priority` (int), `description`, `expression` (required), `action` (repeated, in order) | `{"message":"Route has been created","route":{…}}` | 400 `{"message":…}` |
| `GET /v3/routes?skip=0&limit=100` | `limit` ≤ 1000 | `{"total_count":1,"items":[{…}]}` | 400 `{"message":"The 'limit' parameter can't be larger than 1000"}` |
| `GET /v3/routes/{id}` | | `{"route":{…}}` | 404 `{"message":…}` |
| `PUT /v3/routes/{id}` | form, all fields optional; "only updates the specified fields" | spec: `{"message":"Route has been updated","route":{…}}`. **mailgun-go says the API "just returns a bare Route"**, so parse `body.route ?? body`. | 404 `{"message":"Route not found"}` |
| `DELETE /v3/routes/{id}` | | `{"message":"Route has been deleted","id":"4f3b…"}` | 404 `{"message":"Route not found"}` |
| `GET /v3/routes/match?address=<addr>` | `address` required | `{"route":{…}}`: **one route only** | 404 `{"message":"Route not found"}` |

- **Paging `GET /v3/routes`:** repeat with `skip += items.length` until `items` is empty or `skip >= total_count`.
- **PUT:** always send every field (`priority`, `description`, `expression` and all `action` values). Whether a partial `action` list replaces or appends is **UNVERIFIED**, so read the route back and compare.
- **`/match` returns a single route**, not every matching route. Which one it returns when several match is undocumented (presumably the first by priority). B6.10's check "`/match` must match only the intended address" should therefore be:
  - for each sender address, the returned `route.id` equals that sender's route id;
  - for a random non-sender address on the domain, it equals the catch-all's id (or 404 if there is no catch-all);
  - for `dmarc@…`, it equals the DMARC route.
- Whether `/match` evaluates `catch_all()` is **UNVERIFIED**.

---

## 7. Stored messages: `GET <storage URL>` / `GET /v3/domains/{domain}/messages/{storage_key}`

- Use `message-url` (inbound notify), `storage.url[0]` (Logs) or `storage.url` (webhooks) as given. Example from the docs: `https://storage-us-east4.api.mailgun.net/v3/domains/sample.mailgun.com/messages/BAABAAdzYub9ZBnyVMlI_YnQHR1rCYY1Yg`.
- The key is the last path segment.
- The API-host form `{base}/v3/domains/{d}/messages/{key}` is also documented; the view-stored-messages sample uses `api.mailgun.net`. Use it only as a fallback.
- Keys live as long as the domain's `message_ttl` (section 8).
- Basic auth.

**Default Accept (JSON)** *(spec example `GetMessageResponseBasicExample`)*: the raw MIME headers come back as **top-level keys in their original case**, next to the parsed fields.
```json
{ "Content-Type": "multipart/form-data; boundary=----SomeFormBoundaryABC123",
  "From": "foo.bar@my-domain.com", "Message-Id": "<xxxxxxxxxxxxx.111111111111111@my-domain.com>",
  "Mime-Version": "1.0", "Subject": "\"Mailgun is awesome\"", "To": "Cool Bar <cool.barr@cool.com>, bar.baz@gmail.com",
  "sender": "foo.bar@my-domain.com", "recipients": "cool.barr@cool.com, bar.baz@gmail.com",
  "body-html": "<html>This is some html</html>", "body-plain": "This is some html",
  "stripped-html": "<html>This is some html</html>", "stripped-text": "This is some html",
  "stripped-signature": "the signature block stripped from the plain text message (if found)",
  "message-headers": [ ["Mime-Version","1.0"], ["Subject","\"Mailgun is awesome\""], ["From","foo.bar@my-domain.com"],
                       ["Message-Id","<xxxxxxxxxxxxx.111111111111111@my-domain.com>"], ["Content-Type","text/html; charset=ascii"] ] }
```

- The official Go SDK's `StoredMessage` also reads lowercase `from`, `subject`, `attachments` (array of `{size, url, name, content-type}`), `message-url` and `content-id-map`. So the key case varies: **look keys up case-insensitively**.
- **Read `Message-Id`, `In-Reply-To` and `References` from `message-headers`.** Here it is a real JSON array of `[name, value]` pairs; in the notify POST it is a JSON-encoded *string*. Names can repeat.

**`Accept: message/rfc2822`:** still returns **JSON**: `{recipients, sender, from, subject, "body-mime"}`. Use this only if the parsed fields are not enough.

**Errors:**

- 404 `{"message":"Message not found"}`: the message expired or was deleted, or the host or region is wrong. mailgun-php #902 reports this from the EU storage host; cause unclear.
- 400 `{"message":…}`.

**Fallback on 404 from the storage host:**

1. Try `storage.url[1]` if the array has one.
2. Then the API-host form.
3. Then give up and mark the reply "Recovered reply with no text" (B6.10).

---

## 8. Domain

### 8.1 `GET /v4/domains/{domain}`

**200** *(spec example)*:
```json
{
  "domain": {
    "created_at": "Thu, 13 Oct 2011 18:02:00 GMT", "id": "123456789012345678901234", "name": "example.com",
    "require_tls": true, "smtp_login": "postmaster@example.com", "spam_action": "disabled", "state": "active",
    "type": "sandbox", "use_automatic_sender_security": true, "web_prefix": "email", "web_scheme": "http"
  },
  "receiving_dns_records": [
    { "is_active": true, "cached": ["10 mxa.mailgun.org", "10 mxb.mailgun.org"], "priority": "10", "record_type": "MX", "valid": "valid", "value": "mxa.mailgun.org" },
    { "is_active": true, "cached": ["10 mxa.mailgun.org", "10 mxb.mailgun.org"], "priority": "10", "record_type": "MX", "valid": "valid", "value": "mxb.mailgun.org" }
  ],
  "sending_dns_records": [
    { "is_active": true, "cached": ["v=spf1 include:mailgun.org ~all"], "name": "mg.example.com", "record_type": "TXT", "valid": "valid", "value": "v=spf1 include:mailgun.org ~all" },
    { "is_active": true, "cached": ["k=rsa; p=M......"], "name": "mx._domainkey.mg.example.com", "record_type": "TXT", "valid": "valid", "value": "k=rsa; p=M......" },
    { "is_active": true, "cached": ["mailgun.org"], "name": "email.mg.example.com", "record_type": "CNAME", "valid": "valid", "value": "mailgun.org" }
  ]
}
```

Domain object (schema `domains-client-golang-Domain`). The schema marks every field "required" except `archive_to`, `subaccount_id`, `tracking_host`, `webhooks_redact_pii`, `disabled` and `smtp_password`, but the example above omits several required ones. **Parse everything as optional.**

| Field | Type | Values / meaning |
|---|---|---|
| `name`, `id` | string | |
| `state` | string | `active` / `unverified` in the spec examples; `disabled` from older docs (**enum UNVERIFIED**) |
| `is_disabled` | bool | |
| `disabled` | object or null | `{code, note, permanently: bool, reason, until?}` (`until` is RFC 1123). Spec example: `{"code":"blacklisted","note":"for debugging","permanently":true,"reason":"bad customer"}` |
| `type` | string | `custom` or `sandbox` |
| `spam_action` | string | `disabled`, `tag` or `block` (we want `tag`) |
| `wildcard` | bool | receive on subdomains |
| `web_prefix` | string | tracking host prefix, default `email` |
| `web_scheme` | string | `http` or `https` |
| `tracking_host` | string | "Custom tracking host … if configured" |
| `message_ttl` | int, **seconds** | **this is message retention** (stored inbound and outbound) |
| `use_automatic_sender_security` | bool | CNAME DKIM |
| `require_tls`, `skip_verification`, `encrypt_incoming_message` | bool | |
| `webhooks_redact_pii` | bool | if true, webhook `recipient`, `to` and `targets` become `[REDACTED]`. **Checklist: must be false.** |
| `smtp_login`, `created_at`, `archive_to`, `subaccount_id` | string | |

DNS record (schema `domains-client-golang-Record`):

| Field | Type | Values / meaning |
|---|---|---|
| `record_type` | string | `TXT`, `CNAME`, `MX` (spec examples also show `A`) |
| `name` | string, **optional** | missing on the MX rows in the example; the MX host is the domain itself |
| `value` | string | the expected value |
| `valid` | string | `valid`, `invalid` or `unknown` |
| `priority` | **string** | MX only |
| `is_active` | bool | |
| `cached` | string[] | what Mailgun last saw in DNS (`[]` if nothing) |

The spec requires `is_active`, `cached`, `record_type`, `valid` and `value`.

Errors: 401 `{"message":"Invalid private key"}`, 404 `{"message":"Domain not found"}`.

### 8.2 `PUT /v4/domains/{domain}/verify` (no body)

- **200** *(spec)*: `{"message":"Domain DNS records have been updated","domain":{…},"sending_dns_records":[…],"receiving_dns_records":[…]}`. All four keys are required.
- **429:** body shape `{"message":…}`, text not given. Throttle it to once a minute (B6.10/inbound research).
- 401 and 404 as above.

### 8.3 `PUT /v4/domains/{domain}` (`multipart/form-data`, every field optional)

| Field | Type | Notes |
|---|---|---|
| `web_scheme` | `http` \| `https` | https "must have a valid cert" (section 9) |
| `web_prefix` | atom | the tracking CNAME must match `<prefix>.<domain>` |
| `spam_action` | `disabled` \| `tag` \| `block` | |
| `message_ttl` | int seconds | "The maximum TTL value is determined by your subscription plan". **Retention is set here.** Foundation (1 day on the pricing page) = `86400`. The error when you exceed the plan maximum is **UNVERIFIED** (probably 400). |
| `wildcard`, `require_tls`, `skip_verification`, `use_automatic_sender_security`, `webhooks_redact_pii` | bool | |
| `archive_to`, `mailfrom_host`, `smtp_password` | string | not used |

- **200** *(spec)*: `{"message": "<text not given>", "domain": {…}, "receiving_dns_records": […], "sending_dns_records": […]}`. `message` and `domain` are required.
- 401 and 404 as above.
- Send one field per call when the checklist fixes one row, so an error names the field.

---

## 9. Tracking certificate (HTTPS unsubscribe links)

`{host}` = `web_prefix + '.' + domain`, e.g. `email.send.example.com` (spec: "formatted as `web_prefix.domain_name`").

Setting the tracking protocol to HTTPS **in the Control Panel** auto-generates the certificate (Tracking Messages intro page). Setting `web_scheme=https` by API does not (mailgun.js issue #389). So the app calls POST first.

### 9.1 `POST /v2/x509/{host}` (no body): start generation

| Status | Body | Meaning |
|---|---|---|
| 202 | `{"message":"Initiated x509 key pair generation","location":"/v2/x509/example.com/status"}` | poll `location` |
| 400 | `{"Reason":"invalid CNAME record"}` | tracking CNAME missing or wrong; fix DNS first |
| 402 | `{"Reason":"upgrade your account to enable this feature"}` | plan. The help centre (search snippet) says one-click HTTPS tracking is on **Foundation, Scale, Contract, Enterprise**, so Free and Basic get 402. |
| 404 | `{"Description":"x509 cert not found"}` | listed for POST; meaning unclear |
| 409 | `{"Description":"x509 key pair generation has already been initiated for example.com"}` | treat as success and poll |

### 9.2 `GET /v2/x509/{host}/status`

- **200** *(spec examples)*. The schema types `status` as "object", which is a bug: it is a string.
  - `{"status":"processing","error":"Waiting for x509 key pair generation"}`
  - `{"status":"active","certificate":"<PEM>"}` (`error` null)
  - `{"status":"expired","error":"x509 certificate has expired","certificate":"<PEM>"}`
  - `{"status":"error","error":"TLS x509 key pair generation failed, please contact support","certificate":"<PEM>"}`
- **404** `{"Description":"Please initiate x509 key pair generation at POST /v2/x509/{domain}"}`: not started yet.
- Generation time is not documented (Let's Encrypt HTTP-01 through the tracking CNAME).
- Poll every 30 s for up to 30 min, as a background job, then show "still processing, re-check later".

### 9.3 `PUT /v2/x509/{host}` (no body): regenerate an EXPIRED certificate

| Status | Body | Meaning |
|---|---|---|
| 202 | same as POST | |
| 409 | `{"Description":"x509 certificate is still valid until 2009-11-10 23:00:00 +0000 UTC"}` | nothing to do |
| **429** | `{"Description":"x509 key pair generation job is already in progress for example.com"}` | **not a rate limit**; just poll |
| 400 / 402 / 404 | as for POST | |

### 9.4 Sequence (B6.8)

1. The CNAME row in `GET /v4/domains/{d}` is `valid`.
2. `POST /v2/x509/{host}`.
3. Poll status until `active`.
4. `PUT /v4/domains/{d}` with `web_scheme=https`.
5. `GET /v3/domains/{d}/tracking` shows `web_scheme: "https"`.

Also watch for `expired` on the six-hourly DNS check, then PUT to regenerate.

---

## 10. Tracking settings

### 10.1 `GET /v3/domains/{domain}/tracking`

**200** (schema `GetDomainTrackingResp`; the target state is shown) *(ours)*:
```json
{ "tracking": {
    "open":        { "active": false, "place_at_the_top": false },
    "click":       { "active": false },
    "unsubscribe": { "active": true, "html_footer": "", "text_footer": "" },
    "web_scheme":  "https" } }
```

- All of `open`, `click`, `unsubscribe` and `web_scheme` are required.
- The spec example omits `place_at_the_top` and shows the nonsense footers `"off"`/`"on"`.
- `click.active` is typed bool, but PUT accepts `htmlonly`. What GET returns in that state is **UNVERIFIED**. Rule: click tracking counts as off only when `active` is `false`, `"false"` or `"no"`.
- 401 and 404 as in 0.8.

### 10.2 PUTs (`multipart/form-data`)

| Call | Fields | 200 *(spec)* |
|---|---|---|
| `PUT …/tracking/open` | `active` (bool; "omit to keep current"), `place_at_the_top` (bool, optional) | `{"message":"Domain tracking settings have been updated","open":{"active":false,"place_at_the_top":false}}` |
| `PUT …/tracking/click` | `active`: `htmlonly`, `true` or `false` ("omit … no change") | `{"message":"Domain tracking settings have been updated","click":{"active":false}}` |
| `PUT …/tracking/unsubscribe` | `active` (bool), `html_footer` (string), `text_footer` (string) | `{"message":"Domain tracking settings have been updated","unsubscribe":{"active":true,"html_footer":"…","text_footer":"…"}}` |

Default footers (from the spec's unsubscribe example):

- `html_footer`: `"\n<br>\n<p><a href=\"%unsubscribe_url%\">unsubscribe</a></p>\n"`
- `text_footer`: `"\n\nTo unsubscribe click: <%unsubscribe_url%>\n\n"`

**Can the footers be set to empty?**

- **UNVERIFIED.** No official source says either way. The unsubscribe guide only says "Remove text in the HTML and text footer so they won't be appended automatically".
- Procedure:
  1. Send both fields present with value `''` (`fd.append('html_footer','')`).
  2. Read back with GET.
  3. If either footer is non-empty, the checklist row turns red, with Control Panel instructions (Domain settings → Tracking → unsubscribe templates).
  4. Only as a last resort, with the owner's OK, use a harmless single `\n` text footer and an empty `<span></span>` HTML footer.

---

## 11. `GET /v3/domains/{domain}/sending_queues`

**200** (schema `GetDomainSendingQueuesResp`; `regular` and `scheduled` are required, `is_disabled` is required in each):
```json
{ "regular":   { "is_disabled": true, "disabled": { "until": "Mon, 02 Jan 2006 15:04:05 MST", "reason": "You have too many messages in queue" } },
  "scheduled": { "is_disabled": false } }
```

- `disabled` is present only when disabled. `until` is RFC 822, `reason` is free text.
- `regular.is_disabled === true` → global pause (B6.6).
- 401 and 404 as in 0.8.

---

## 12. Custom message limit: `/v5/accounts/limit/custom/monthly`

| Call | 200 | Errors |
|---|---|---|
| `GET` | `{"limit":10000,"current":0,"period":"1m"}` (`period`: m = months, d = days, h = hours) | **404 `{"message":"No threshold for account"}`** = none set |
| `PUT ?limit=N` (query parameter, no body) | `{"success":true}` | **400 `{"message":"The limit parameter minumum is 1000"}`** (sic): **minimum 1000** |
| `DELETE` | `{"success":true}` | 400 `{"message":"Could not delete threshold for account"}` |
| `PUT /v5/accounts/limit/custom/enable` | `{"success":true}` | 400 `{"message":"Unable to re-enable account with current account disablement"}` |

- **The Developer role is Read only here.** The app can only GET and show the value (with a warning if it is missing). The owner sets it in the Control Panel.
- Per region (sending research).
- The error sends receive after the cap is hit is **UNVERIFIED**. It is covered by the generic "not allowed to send" → pause rule (0.8).

---

## 13. What Mailgun POSTs to us

### 13.1 Event webhooks → `POST /api/webhooks/mailgun/events`

- `Content-Type: application/json`. Top level (official Go SDK `WebhookPayload`, securing-webhooks page):
```json
{ "signature": { "timestamp": "1770920772", "token": "e0b5477167110d68991efc6b9f89f0a11066af27834600e123", "signature": "<64 hex chars>" },
  "event-data": { … } }
```
- A subaccount event adds `signature["parent-signature"]`. Ignore it.
- `timestamp` is a string in the example and in the Go SDK type, while the docs table says int. Accept both and run the HMAC over `String(timestamp)`.

`event-data` for a permanent failure, with *our* `user-variables` filled in (field set and values from the official payload page; only `user-variables` is ours):
```json
{ "event": "failed", "id": "2kFItcrLQuKTdp-Ia2Xr7w", "timestamp": 1770918175.5923693,
  "severity": "permanent", "reason": "bounce", "log-level": "error",
  "recipient": "badrecipient@sample.mailgun.com", "recipient-domain": "sample.mailgun.com",
  "domain": { "name": "sample.mailgun.com" }, "account": { "id": "1234567890303a4bd1f33898" },
  "message": { "headers": { "message-id": "20260212174255.58bbb7ce85a423e5@mailgun.com", "from": "Sample Sender <sender@sample.mailgun.com>", "to": "badrecipient@sample.mailgun.com", "subject": "Sample webhook payload" }, "attachments": [], "size": 384 },
  "flags": { "is-authenticated": true, "is-routed": false, "is-big": false, "is-system-test": false, "is-test-mode": false },
  "delivery-status": { "attempt-no": 1, "code": 550, "message": "5.5.0 Requested action not taken: mailbox unavailable …", "description": null, "enhanced-code": "5.5.0", "mx-host": "802679870.pamx1.hotmail.com", "bounce-type": "hard", "session-seconds": 0.208, "certificate-verified": true, "tls": true, "utf8": true, "first-delivery-attempt-seconds": 0.066 },
  "envelope": { "sender": "sender@sample.mailgun.com", "targets": "badrecipient@sample.mailgun.com", "transport": "smtp", "sending-ip": "161.38.194.10" },
  "storage": { "key": "XXXXAQVV4uE1s5YYj9ZJq7Ge6flueUXXXX", "url": "https://storage-us-east4.api.mailgun.net/v3/domains/sample.mailgun.com/messages/BAABAAfjqLGlFIjZf6pPUoM8bTIKzkQ5Zg" },
  "tags": ["outreach", "step-1"], "campaigns": [], "recipient-provider": "Other", "primary-dkim": "new._domainkey.sample.mailgun.com",
  "user-variables": { "send_id": "8f0c…", "campaign_id": "c_12", "step": "1" } }
```

Quirks from the official examples:

- `user-variables` is `[]` when empty.
- **The `unsubscribed` example has `"storage": []`**, an empty *array*, where other events have an object.
- `unsubscribed` has `tags: ["*"]` for domain-level unsubscribes.
- `delivery-status.description` and `enhanced-code` can be `null`.
- `delivered-at` is an int epoch on opened and clicked events.
- The page warns that new fields are added over time. Use a lenient zod schema (`.passthrough()`), and require only `event`, `id`, `timestamp` and `message.headers.message-id`.

More:

- The domain setting `webhooks_redact_pii` would replace `recipient`, `to` and `targets` with `[REDACTED]`. `message-id` stays.
- Mailgun also presents a TLS client certificate (CN `webhooks.mgsend.net`). It is useless to us, because TLS ends at Cloudflare.
- Response codes and retries: see mailgun-events.md. The retry schedules differ between pages (webhook-retries: 5m/10m/15m/1h/2h/4h; receive-http: 10m/15m/30m/1h/2h/4h). Both total about 8 h and skip the delivery notification.

### 13.2 Inbound replies → `POST /api/webhooks/mailgun/inbound` (from `store(notify=…)`)

- **Content type:** `application/x-www-form-urlencoded`, or `multipart/form-data` "if at least one attachment is written". Use `await request.formData()`, which handles both.
- **The signature fields are flat form fields** (`timestamp`, `token`, `signature`), not a nested object.

Fields (official storing-and-retrieving page):

| Field | Form value | Notes |
|---|---|---|
| `domain` | string | the receiving domain |
| `recipient` | string | SMTP RCPT TO, e.g. `ali@send.example.com` |
| `sender` | string | SMTP MAIL FROM (may differ from `from`) |
| `from` | string | From header, e.g. `Anna Berg <anna@firma.de>` |
| `subject` | string | |
| `body-plain` | string | always present |
| `stripped-text` | string | only if parsing succeeded |
| `stripped-signature` | string | only if parsing succeeded |
| `body-html` | string | "if message was multipart"; other MIME parts arrive as `body-<type>` |
| `stripped-html` | string | only if parsing succeeded |
| `attachments` | **JSON string** | metadata list `[{"url","content-type","name","size"}]` (Go SDK `StoredAttachment`) |
| `message-url` | string | the storage URL (section 7). "Only present in the payload posted to the notification URL". |
| `message-headers` | **JSON string** of `[[name, value], …]` | header order preserved, duplicates possible (`subject` vs `Subject`) |
| `content-id-map` | JSON string | the table spells it `Content-id-map`, so read form keys case-insensitively |
| `timestamp`, `token`, `signature` | strings | HMAC as in 13.3 |

- `Message-Id`, `In-Reply-To` and `References` are **not documented as top-level fields**. Others report that raw headers are also posted as top-level fields (**UNVERIFIED**; don't rely on it). Parse them from `message-headers`.
- Response codes and retries: 200 = done; 406 = rejected, no retry; anything else = retried at 10m, 15m, 30m, 1h, 2h, 4h (receive-http page).

### 13.3 The HMAC rule (both endpoints)

Per the securing-webhooks page:

1. Concatenate `timestamp` and `token` with no separator.
2. HMAC-SHA256 that string, keyed with the **HTTP webhook signing key** (section 5).
3. Compare the lowercase hex digest with `signature`.

The HMAC covers `timestamp + token` only, **not the body**. Token replay protection is therefore what protects the body (B6.11).

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyMailgunSignature(signingKey: string, timestamp: string, token: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature) || token.length < 20 || !/^\d{9,11}$/.test(timestamp)) return false;
  const expected = createHmac('sha256', signingKey).update(timestamp + token).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

**Test vector** (computed with Node 24.18, `node:crypto`):

- key `key-0123456789abcdef0123456789abcdef`
- timestamp `1770920772`
- token `e0b5477167110d68991efc6b9f89f0a11066af27834600e123` (50 characters)
- → signature `6ae8ba140d2536fd21c45a0db161e962a424ed6ca953c96a63182621e118ee13`

---

## 14. Error catalogue (known texts → our action)

| Situation | Status | Body (as documented) | Action |
|---|---|---|---|
| Bad recipient address on send | 400 | `{"message":"to parameter is not a valid address. please check documentation."}` | row → Failed (permanent) |
| Send options over 16 KB | 400 | `{"message":"Send options (parameters starting with o:, h:, or v:) are limited to 16KB total"}` | bug → Failed + Owner log |
| Wrong key (send) | 401 | `Forbidden` | release to Queued, global pause |
| Wrong key (other endpoints) | 401 | `{"message":"Invalid private key"}` | global pause / red checklist |
| Domain not in this region | 404 | `{"message":"Domain not found"}` (sends: **UNVERIFIED**, maybe 401) | "Test connection" region probe (0.8) |
| Send rate limited | 429 | `{"message":"Domain … is not allowed to send: account-requests-per-sec limit exceeded, try again after 120 seconds"}` | back to Queued, `dueAt` = reset |
| Business verification | 4xx (**UNVERIFIED**) | text contains `business verification is required` | global pause "Finish Mailgun business verification" |
| Sandbox / unauthorised recipient | 4xx (**UNVERIFIED**) | `Domain … is not allowed to send: Free accounts are for test purposes only…` | global pause |
| Mailgun internal error | 500 | `{"message":"Internal Server Error"}` | send → Unknown; other calls retry |
| Webhook URL already registered | 400 | `{"Reason":"Webhook for event type '…' with URL '…' already exists"}` | switch to PUT |
| Webhook host not resolvable | 400 | `{"Reason":"https://… is not a valid url: host not found"}` | "tunnel hostname not in DNS yet" |
| Webhook URL unknown on PUT | 404 | `{"Description":"Webhook not found"}` | switch to POST |
| Suppression batch too big | 400 | `{"message":"Batch size should be less than 1000"}` | bug: our batches are ≤ 999 |
| Routes list limit too big | 400 | `{"message":"The 'limit' parameter can't be larger than 1000"}` | bug |
| Route id gone | 404 | `{"message":"Route not found"}` | re-create the route, update the stored id |
| Stored message expired | 404 | `{"message":"Message not found"}` | "Recovered reply with no text" path |
| Signing key missing | 400 | `{"message":"could not get HSK for account"}` | Owner: create it in the Control Panel |
| x509 CNAME not ready | 400 | `{"Reason":"invalid CNAME record"}` | checklist: fix the CNAME first |
| x509 not in plan | 402 | `{"Reason":"upgrade your account to enable this feature"}` | checklist: plan needs Foundation or higher |
| x509 not started | 404 | `{"Description":"Please initiate x509 key pair generation at POST /v2/x509/{domain}"}` | POST |
| x509 in progress | 409 / 429 | `{"Description":"… already been initiated …"}` / `{"Description":"… job is already in progress …"}` | poll |
| No custom limit | 404 | `{"message":"No threshold for account"}` | amber checklist row |
| Custom limit below minimum | 400 | `{"message":"The limit parameter minumum is 1000"}` | (Owner-side only) |

---

## 15. Fake server contract (`tests/fakes/mailgun`, used by Vitest, the E2E test and my own checks)

The fake is a plain `node:http` server started per test file. Rules:

- It binds **127.0.0.1 on port 0**, and the test hands its origin to the client as `baseUrl`.
- It never proxies to Mailgun, and has no code path that could.
- **Client guard:** when `NODE_ENV === 'test'`, `MailgunClient` throws unless the `baseUrl` hostname is `127.0.0.1` or `localhost`. In production, `baseUrl` comes only from the region setting.
- The storage-host allowlist (0.1) accepts the fake origin only in test mode.

**Global behaviour:**

- **Auth:** require `Authorization: Basic base64("api:<key>")` with the configured key. Otherwise return 401: plain `Forbidden` on `/messages`, `{"message":"Invalid private key"}` elsewhere.
- **Domains:** only the configured domain exists. Any `{domain}` path parameter for another domain → 404 `{"message":"Domain not found"}`. A `region: 'US' | 'EU'` option; a request for the other region's domain behaves like "unknown domain".
- **Every response** carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.
- **Request log:** every request (method, path, query, parsed body, headers minus Authorization) goes into an array the test can assert on.
- **Clock:** an injected `now()`, shared with the app's controllable clock.
- **Fault injection:** a queue per route key, e.g. `fake.failNext('POST /v3/:d/messages', {…})`, with these kinds:
  - `status` + `body` (any status and any of the error shapes in 0.4);
  - `429` with headers;
  - `hang` (never respond, so the client's `AbortSignal.timeout` fires);
  - `acceptThenDrop`: record the message and the accepted event, then `socket.destroy()` before responding. This is the ambiguous outcome the reconciler must handle.
  - `businessVerification`: 403 `{"message":"Domain … is not allowed to send: business verification is required"}`. The exact text is **our assumption** (see 0.8); tests match `/business verification/i` only.
- **State reset** between tests; everything in memory.

**Per endpoint:**

| Endpoint | Minimal behaviour the fake must emulate |
|---|---|
| `POST /v3/:d/messages` | Parse multipart (`request.formData()` equivalent). 400 `{"message":"from parameter is missing. "}` and similar when `from`/`to`/`subject` are missing or none of `text`/`html` is present; 400 if `o:`/`h:`/`v:` total > 16384 bytes. Store the message. Reply 200 `{"id": h:Message-Id ?? "<generated@domain>", "message":"Queued. Thank you."}`. **Does not dedupe.** Append an `accepted` log event (with `user-variables` as a JSON string, `flags.is-test-mode` from `o:testmode`) that only becomes visible after the configurable `indexLagMs` (default 0). `fake.deliver(id)`, `fake.bounce(id, {severity, reason, code})`, `fake.complain(id)`, `fake.unsubscribe(id)` add the matching log events, suppression entries (permanent bounce → bounces, complaint → complaints, unsubscribe → unsubscribes with `tags:["*"]`), and optionally POST a signed webhook to the app (below). |
| `POST /v1/analytics/logs` | JSON body. 400 if `pagination.limit > 100`. Accept `start`+`end` or `end`+`duration`; a `strictDuration` switch returns 400 `{"message":"duration is required"}` when it's absent, to test the fallback. Filter by time window, `events`, and `AND` predicates: `domain =`, `message_id =` (compare without `<>`), `user_variables contains` (substring of the JSON string), `event =`, `severity =`. Drop events older than `retentionDays`. Sort by `timestamp:asc` or `desc`. Page with opaque base64 tokens that encode the offset **and** a hash of the body (400 if the body changed). `pagination.next` is present while more items remain; after the last page, return `items: []` with **no** `next`. A `nextOnLastPage` switch makes the last page still carry a `next` token, testing the empty-page stop rule. Items use the section 2.2 shape (`@timestamp` ISO; `storage.url` as an **array**). |
| `GET /v3/:d/{bounces,complaints,unsubscribes}` | `limit` 1–1000 (400 above). Sort items by address. `paging.{first,next,previous,last}` = absolute URLs on the **fake origin**: `?page=next&address=<last>&limit=N`. `next` is present **even on the last page**, whose follow-up returns `items: []`. Items per section 3.1 (bounce `code` as a string). A `crossOriginNext` switch puts a foreign host in `paging.next`, to test the origin guard. |
| `POST /v3/:d/unsubscribes` | Require `Content-Type: application/json` and a top-level array; ≥ 1000 entries → 400 `{"message":"Batch size should be less than 1000"}`. Upsert by lowercased address. Reply `{"message":"<n> addresses have been added to the unsubscribes table"}`. Every send to a suppressed address produces a `failed` event with `severity: "permanent"` and `reason: "suppress-unsubscribe"` (or `suppress-bounce`, `suppress-complaint`) instead of `delivered`. |
| `GET /v3/domains/:d/webhooks` | The current mapping `{"webhooks":{type:{"urls":[…]}}}` for configured types only. A `legacyUrlField` switch returns `{"url": "…"}` entries instead. |
| `POST /v4/domains/:d/webhooks` | Urlencoded; 400 `{"Reason":"Webhook for event type '<t>' with URL '<u>' already exists"}` if any pair exists; a 4th URL for a type → 400 `{"Reason":"too many urls"}` (**our** text); otherwise add and return the full mapping. |
| `PUT /v4/domains/:d/webhooks` | 404 `{"Description":"Webhook not found"}` if the URL is unknown; otherwise replace that URL's types and return the full mapping. |
| `DELETE /v4/domains/:d/webhooks` | 400 `{"Field":"url"}` without `url`; otherwise remove it and return the mapping. |
| `GET /v5/accounts/http_signing_key` | `{"http_signing_key": <configured>}`, or 400 `{"message":"could not get HSK for account"}` when none is set. `POST` exists only so a test can assert **the app never calls it**. |
| `/v3/routes` (+ `/{id}`, `/match`) | Account-wide store. Create returns `{"message":"Route has been created","route":{…}}` with a 24-hex id and an RFC 1123 `created_at`. List with `skip`/`limit` (400 if > 1000) returns `{total_count, items}`. GET/PUT/DELETE by id with 404 `{"message":"Route not found"}`. PUT returns the spec shape by default; a `putBareRoute` switch returns the Go-SDK-reported bare route, so the client's `body.route ?? body` is tested. `/match`: evaluate `match_recipient("…")` by translating the Python regex to a JS `RegExp` (only `^ $ . \ + * ? [] () |` needed), plus `catch_all()` when nothing else matched. Order by priority, then creation time. Return the **first** match `{"route":…}` or 404. Store `expression` and `actions` verbatim, so tests can assert the exact strings. |
| Storage `GET /v3/domains/:d/messages/:key` | Serve stored inbound messages created by `fake.receive(...)`. The default Accept returns the section 7 JSON (headers as top-level keys, `message-headers` as a real array). `Accept: message/rfc2822` returns `{recipients, sender, from, subject, "body-mime"}`. After `message_ttl` seconds (fake clock) → 404 `{"message":"Message not found"}`. `message-url` and Logs `storage.url` point here, on the fake origin. |
| `GET /v4/domains/:d` | A configurable domain object and records (defaults: `state:"unverified"`, all records `valid:"unknown"`, `web_scheme:"http"`, `spam_action:"disabled"`, `message_ttl:86400`, `webhooks_redact_pii:false`). `fake.setDns({...})` flips records to `valid`. |
| `PUT /v4/domains/:d/verify` | Returns the section 8.2 shape; recomputes `state` (`active` when every sending record is valid). A `verifyRateLimited` switch returns 429 `{"message":"Too many requests"}` (**our** text). |
| `PUT /v4/domains/:d` | Multipart; update `web_scheme` (400 `{"message":"…certificate…"}` (**our** text) if `https` without an active cert), `web_prefix`, `spam_action` (only the three enum values, else 400), `message_ttl` (400 above `maxMessageTtl`), `wildcard`. Return `{"message":"Domain has been updated","domain":{…},…}` (**our** message text). |
| `POST/PUT /v2/x509/:host`, `GET …/status` | State machine per host: none → (POST) processing → active after `certPolls` status calls (default 2). 400 `{"Reason":"invalid CNAME record"}` unless the tracking CNAME record is valid; 402 when `plan: 'basic'`; 409 on a second POST; status 404 `{"Description":"Please initiate …"}` before POST; PUT on an active cert → 409; PUT while processing → 429 `{"Description":"… already in progress …"}`. A `certFails` switch ends in `status:"error"`. |
| `GET /v3/domains/:d/tracking` + `PUT …/open\|click\|unsubscribe` | Persist and return exactly the section 10 shapes. Defaults: open/click `active: true`, unsubscribe `active: false` with the default footers, `web_scheme` mirrored from the domain. An `ignoreEmptyFooters` switch keeps the old footers when `''` is sent, testing the red-row fallback. |
| `GET /v3/domains/:d/sending_queues` | `{"regular":{"is_disabled":false},"scheduled":{"is_disabled":false}}`; `fake.disableQueue(reason, until)` flips it. |
| `GET /v5/accounts/limit/custom/monthly` | 404 `{"message":"No threshold for account"}` by default, or `{limit, current, period:"1m"}` when configured. `PUT` → 403 `{"message":"Forbidden"}` (**our** assumption for the Developer role), so tests prove the app never relies on it. |

**Helpers that call *our* app** (they live beside the fake and sign with the configured signing key):

- `postEventWebhook(appUrl, eventData, {timestamp?, token?, tamper?})` → JSON `{signature:{timestamp: String(ts), token, signature}, "event-data": …}`. Mode `numericTimestamp` sends `timestamp` as a number, to test the String() normalisation.
- `postInbound(appUrl, fields, {multipart?: boolean})` → urlencoded or multipart form with every field in 13.2. `message-headers` and `attachments` are JSON strings; `message-url` points at the fake storage. It also records a matching `stored` log event (`storage.url` array, `storage.key`, `message.headers.message-id`, `flags.is-routed: true`) so catch-up can find replies whose POST was "lost" (`fake.dropInboundPost = true`).
- Canned `event-data` builders: delivered, failed (temporary and permanent, including `suppress-*` reasons), complained, unsubscribed (with `storage: []` and `tags: ["*"]`), test-mode delivered (code 650, `is-test-mode: true`). All carry `message.headers.message-id` without brackets and `user-variables` as an object (or `[]`).

---

## 16. Probes to run once the owner's account exists (read-only unless noted; my own check, not the app's)

Each settles an UNVERIFIED point above. Record the results in this file.

1. `GET /v4/domains/{d}` on the right and the wrong region: the exact 401/404 bodies; which fields are really present; the `state` value.
2. `POST /v3/{d}/messages` with a deliberately wrong key against the **sandbox** domain: is the body `Forbidden` or JSON? (No mail is sent: auth fails first.)
3. After the owner's first "Send me a test": a Logs query by `message_id` without brackets, then with brackets (which one matches?); `user_variables contains <send_id>`; whether `duration` is really required; whether the last page carries a `next` token.
4. `GET /v3/{d}/unsubscribes?limit=1000` on the empty list: the exact `paging.next` URL form.
5. `PUT /v3/domains/{d}/tracking/unsubscribe` with empty footers, then GET: does empty stick? (Setting change, part of "Apply recommended settings".)
6. `GET /v3/routes/match?address=random@{d}` with and without a `catch_all()` route present.
7. `PUT /v3/routes/{id}` response shape (bare route or `{message, route}`).
8. `GET /v5/accounts/limit/custom/monthly` with the Developer key: 200/404, or 403?
9. `POST /v2/x509/{host}` on Foundation (expect 202) and how long it stays `processing`.

---

## Sources

- OpenAPI bundle (all shapes and examples): https://documentation.mailgun.com/_bundle/docs/mailgun/api-reference/send/mailgun.yaml
- API overview (status codes, rate-limit headers, date formats): https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview.md
- Logs: https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/logs/post-v1-analytics-logs.md · filter comparators: https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/mailgun/metrics/filters
- Webhook payloads: https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads.md · securing: https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks.md · retries: https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-retries.md · configuring: https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks.md
- Inbound: https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http.md · https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/storing-and-retrieving-messages.md · https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/view-stored-messages.md
- Routes: https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/routes.md · route-filters.md · route-actions.md (same folder)
- Tracking and HTTPS: https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-messages.md · tracking-unsubscribes.md · help-centre "HTTPS Tracking & Links" (search snippet only: Foundation, Scale, Contract, Enterprise; EU CNAME target eu.mailgun.org) · mailgun.js issue #389
- Domain verification: https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-verify.md
- RBAC: https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt.md
- Official SDK code: mailgun.js `lib/Classes/Logs/LogsClient.ts`, `Suppressions/SuppressionsClient.ts`, `Domains/domainsTracking.ts`, `Routes.ts`, `common/NavigationThruPages.ts` · mailgun-go `bounces.go`, `routes.go`, `webhooks.go`, `stored_messages.go`, `mtypes/*.go` · mailgun-ruby `lib/mailgun/suppressions.rb` (999 split)
- Third-party (for UNVERIFIED items only): Ghost forum thread 34186 (401 causes), timonweb "Domain not found" (anymail), directus #6787, mailgun-php #902 (EU storage host), help-centre search snippets for "business verification" and the sandbox error text.
