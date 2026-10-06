# Research (implementation reference, verified 2026-09-26): Mailgun address validation for Milestone 5 (B6.9): wire format, errors, costs, re-check rules, the adapter mapping and the fake-server contract

Collected for Milestone 5 (PLAN.md A8 item 5, A3 Q13, B6.2, B6.4 step 4, B6.9, B8 `verify.addresses`, B12). This file covers **wire formats and the rules the code needs**. It doesn't repeat the planning research or the M3 reference. Read those first:

- [mailgun-inbound-validation-domain.md](mailgun-inbound-validation-domain.md) (planning, 2026-09-22): why Mailgun, first mappings, the adapter idea. **Sections 0 and 8 below correct parts of it.**
- [mailgun-api-reference.md](mailgun-api-reference.md) (M3): hosts and region (§0.1), Basic auth and key roles (§0.2), the five error-body shapes and `errorText` (§0.4), status codes (§0.5), rate-limit headers (§0.6), and the fake server's global rules (§15). Everything there also applies to the validation endpoint unless this file says otherwise.

**Sources, in order of trust:**

1. The Validate OpenAPI bundle `https://documentation.mailgun.com/_bundle/docs/validate/oas/openapi-validate-final.yaml`, downloaded 2026-09-26 (`info.version 1.0.0`, 48,600 bytes). Quoted as *OAS*.
2. The `.md` pages under `documentation.mailgun.com/docs/validate/` (single-valid-ir, bulk-valid-ir, bulk_valid_preview, validate_engagement, email-valid-ir, api-overview) and the Send bundle `…/send/mailgun.yaml` for usage metrics.
3. The pricing page `https://www.mailgun.com/pricing/`, read from its raw HTML, including the comparison-table JSON embedded in the page (fetched 2026-09-26).
4. Mailgun's help centre, read through its Zendesk JSON API because the HTML pages return 403. Articles 6749887012891 (overages), 360010523074 (Email Validations), 26016288026907 (API Key Roles) and 360020598373 (Bulk).
5. The official SDKs: mailgun.js (master, npm 14.0.1), mailgun-go v5 (HEAD, including `mocks/mock_validation.go`) and mailgun-php (HEAD). They show how Mailgun's own code calls the endpoint.

**UNVERIFIED** means no official source states it, or official sources contradict each other. §12 lists the paid probes (about $0.12 in total) that settle most of them.

> JSON marked *(spec example)* is copied from the OAS or docs. JSON marked *(ours)* is what we expect or what the fake returns. None of it was captured from a live account.

---

## 0. Read this first: findings that change the plan

1. **CONFLICT: the Foundation plan does NOT include 5,000 validations. Only Scale does.** PLAN.md lines 40, 41 and 112 and the planning research (line 28) say Foundation includes them. The pricing page's comparison JSON reads `{"title":"Email Validations","cols":[false,"Available as add-on","Available as add-on","5,000 email validations included"]}` for Free / Basic / Foundation / Scale. The planning read-through missed that the Free column is an icon, not text. Two more sources agree:
   - The Foundation tooltip says "Additional validations … First 5k $1.20", while Scale's says "First 5k included".
   - The help-centre overage article gives Foundation's "First 5,000" as "$1.20" per 100 and Scale's as "$0.00".

   **What it costs:** every check on Foundation is paid, at $0.012 each for the first 5,000 in a month and $0.008 each up to 50,000.
   - 300 companies × about 1.3 people ≈ 400 checks ≈ **$4.80**.
   - 5,000 checks ≈ **$60**.
   - Break-even with Scale ($90, which includes 5,000 checks): 35 + 0.012·n = 90, so **n ≈ 4,580 checks a month**. Above that Scale is cheaper, by exactly $5 a month once past 5,000 checks, and it also has 30-day logs and up to 7 days of message retention (see M3 catch-up).
   - At 500–1,000 emails a day with 1–3 follow-ups, new recipients come to roughly 3,000–5,500 a month, which sits right at the break-even. **Q9 (plan choice) should be revisited with the owner.** The owner-facing wording in PLAN A1 needs correcting either way.
2. **Going over "included" never fails a call.** The help centre says "Extra usage cannot be deactivated" and overages are "automatically billed when your plan renews". So no 402 or "out of credits" answer protects the owner. The app's own cost display and confirmation (B6.4 step 4) are the only guard. Consider a monthly verification budget setting, like the $20 AI limit (suggestion, not in the plan).
3. **Keys:** only the **Admin** and **Developer** roles can validate. The M3 Developer key works; a Domain Sending Key does not. See §1.3.
4. **Use GET.** The OAS documents only `GET /v4/address/validate`, and mailgun.js, mailgun-go, mailgun-php and mailgun-ruby all use GET. POST appears only in the guide page.
5. **Never call the v3 or "public" validation endpoints.** The help centre says the "Public Verification Limit" is a hard limit: "Once your validations job exceeds this limit, your account will be disabled", which would stop sending too.
6. **The 24-hour re-check of "unknown" may be wasted money.** Mailgun answers from "our own cached data" first. The engagement page implies it remembers provider lookups for 30 days. A re-check could return the same cached `unknown` and still be billed (**UNVERIFIED**, probe P4).
7. **Correction to the planning mapping:** planning mapped "deliverable + medium" to `risky`, but B6.9 says Send. §8 maps it to `valid`/`medium` so that the status and the policy agree.
8. **Small M3 client change:** `errorText()` in `src/server/mailgun/errors.ts` doesn't read an `Error` key, but mailgun-php parses 403 bodies as `{"Error": "…"}`. Add `Error` to its key list.

---

## 1. Request: single validation

### 1.1 Endpoint

| | Value |
|---|---|
| Method and path | `GET /v4/address/validate` (OAS `operationId: GET-v4-address-validate`) |
| EU host (owner's default) | `https://api.eu.mailgun.net`. The docs say "Our Single and Bulk Email Validation service is available via the EU API". |
| US host | `https://api.mailgun.net` |
| Query `address` | Required. "An email address to verify. (Maximum: 512 characters)". |
| Query `provider_lookup` | Optional boolean, default `true`. `true`: "A provider lookup will be performed if Mailgun's internal analysis is insufficient". `false`: no lookup, and an address Mailgun knows nothing about comes back `result: unknown`, `reason: ["no_data"]`. **Always send `provider_lookup=true`**, as mailgun-go does, so the fake can assert it. |
| Headers | `Authorization: Basic base64("api:" + key)`, `Accept: application/json`. No body and no Content-Type. |
| Response | `200 application/json`. The mailgun-ruby cassette also shows `Cache-Control: no-store` and `Www-Authenticate: Basic realm="MG API"`. |

POST also exists (docs only): `POST /v4/address/validate` with form field `address`, and `?provider_lookup=true` in the query string. Don't use it; see §0.4.

### 1.2 Building the URL

- Use `new URLSearchParams({ address, provider_lookup: "true" })`. It encodes `+` as `%2B`. Concatenating strings by hand would turn `anna+cv@x.no` into `anna cv@x.no`; NeverBounce warns about the same thing.
- Send the stored address exactly as it is (after the import's `domainToASCII` domain conversion; see libraries.md). **UNVERIFIED** how Mailgun treats Unicode local parts; the probes don't cover them.
- Syntax-check locally first with the existing `src/core/email-address.ts`. A malformed address is never sent, which saves $0.012 each.
- The endpoint label for logs and errors is `GET /v4/address/validate` **without the query**, so addresses don't end up in error texts. Addresses are personal data even in our own logs.

### 1.3 Which keys can call it

| Key | Can validate? | Source |
|---|---|---|
| Account API key, role **Admin** | Yes | Help centre: "Only users with admin and developer roles can perform email validations". The RBAC table lists Validations as Read/Write. |
| Account API key, role **Developer** (the M3 key) | **Yes** | same |
| Role Analyst or Support | Treat as **no**. The RBAC table gives Validations "Read" (GET), but the help centre says "Cannot perform validations". **UNVERIFIED** for API keys. | rbac-mgmt.md; help 26016288026907 |
| Billing (account-user role only) | No | help 26016288026907 |
| Domain Sending Key | **No**: it only works on `/messages` and `/messages.mime` | rbac-mgmt.md |
| "Verifications Public Key" (`pubkey-…`) on the API Security page | Don't use. It is for the v3 public endpoint, which has the account-disabling limit (§0.5). | help 360010523074 |

- Keys are global across regions ("API Keys" are listed as Global data in api-overview), so the EU key works.
- RBAC keys exist on Foundation, Scale, Contract and Enterprise. Free and Basic get Admin keys only.
- PLAN B6.9's "verification key, defaults to the Mailgun key" therefore works with no extra key. A separate key only matters for ZeroBounce or NeverBounce.

### 1.4 Timeouts and retries

- Keep the M3 client's 30 s `AbortSignal.timeout`.
- Mailgun's own mailbox probe times out internally and answers `unknown` + `smtp_timeout`, so a 30 s client timeout should rarely fire (**UNVERIFIED** latency; probe P1 measures it).
- A validation is safe to repeat, but it may be **billed on every attempt**. Retry a timeout or 5xx **once** inside the call, then leave the address pending for the next pass (§4).

---

## 2. Response 200

### 2.1 Examples

*(spec example, OAS GET 200. Note that `did_you_mean` sits next to a `deliverable` result.)*
```json
{ "address": "john_snow@yaho.com", "did_you_mean": "john_snow@yahoo.com", "engagement": {},
  "reason": [], "result": "deliverable", "risk": "low" }
```
*(spec example, single-valid-ir)*
```json
{ "address": "nonexistentemail@realdomain.com", "is_disposable_address": false, "is_role_address": false,
  "reason": ["mailbox_does_not_exist"], "result": "undeliverable", "risk": "high" }
```
```json
{ "address": "address@domain.com", "is_disposable_address": false, "is_role_address": false,
  "reason": ["no_data"], "result": "unknown", "risk": "unknown" }
```
The last one appears only with `provider_lookup=false`.

*(ours: the full shape the parser must accept, with every optional field present)*
```json
{
  "address": "post+web@example.no",
  "did_you_mean": null,
  "engagement": { "engaging": false, "is_bot": false },
  "is_disposable_address": false,
  "is_role_address": true,
  "reason": ["catch_all"],
  "result": "catch_all",
  "risk": "medium",
  "root_address": "post@example.no",
  "last_seen": 1790000000
}
```

### 2.2 Fields

The OAS schema `…-steps-base-ValidationResponse` requires `address`, `is_disposable_address`, `is_role_address`, `reason`, `result` and `risk`.

| Field | Type | Present | Meaning (docs) | Our use |
|---|---|---|---|---|
| `address` | string | always | "Email address being verified" | Log only. Never overwrite our stored address with it. |
| `result` | string | always | `deliverable`, `undeliverable`, `do_not_send`, `catch_all` or `unknown`. The OAS has **no enum**, just `type: string`. | → `status` (§8) |
| `risk` | string | always | `high`, `medium`, `low` or `unknown` | → `risk` |
| `reason` | string[] | always (OAS) | "List of potential reasons why a specific validation may be unsuccessful". Often `[]`. | → `reasons`. Accept `null` (seen in SDK fixtures) and a bare string (the old v3 form), and turn both into an array. |
| `is_disposable_address` | bool | always | the domain is a known disposable provider | → `isDisposable` |
| `is_role_address` | bool | always | the local part is a role ("admin", "sales", "webmaster"…) | → `isRole`. A **flag only**, never a block (B6.9: General inbox people). |
| `did_you_mean` | string or null | optional | "Null if nothing, however if a potential typo is made to the domain, the closest suggestion is provided" | → `didYouMean` (null when absent, empty or equal to the address) |
| `engagement` | object, `{}` or null | optional | OAS: `{engaging: bool, is_bot: bool, behavior?: string}`. The field table says "is_bot and engaged". Self-serve accounts get booleans only; contract accounts also get `behavior`. | `raw` only |
| `root_address` | string | optional | "If the address is an alias; this will contain the root email address with alias parts removed" | `raw` only |
| `last_seen` | int32 | optional | **undocumented** (probably an epoch in seconds) | `raw` only |

**Unexpected shapes.** mailgun-ruby's recorded cassette for `GET /v4/address/validate` (2025-02-24) holds a **v3-shaped** body (`is_valid`, `mailbox_verification`, `parts`, no `result`). It looks hand-edited: Content-Length 39 on a longer body. Still, the parser must not assume `result` exists. A 200 whose `result` is not a string is an "unreadable answer" (§3, first row).

### 2.3 `result` values (docs, verbatim)

| result | Docs |
|---|---|
| `deliverable` | "The recipient address is considered to be valid and should accept email." |
| `undeliverable` | "…considered to be invalid and will result in a bounce if sent to." |
| `do_not_send` | "…considered to be highly risky and will negatively impact sending reputation if sent to." |
| `catch_all` | "The validity of the recipient address cannot be determined as the provider accepts any and all email…" |
| `unknown` | "The validity … cannot be determined for a variety of potential reasons. Please refer to the associated 'reason' array…" |

### 2.4 `reason` codes (docs) and suggested owner-facing words

| Code | Docs meaning | Words in the app (suggested; PLAN "Wording" rules) |
|---|---|---|
| `mailbox_does_not_exist` | undeliverable or doesn't exist | "This mailbox doesn't exist." |
| `no_mx`, also the text `No MX host found` | no valid MX host ("will be consolidated to only 'no_mx'") | "This domain can't receive email." |
| `malformed_address` | improperly formatted | "This isn't a valid email address." |
| `invalid_tld` | TLD not recognised | "The domain ending isn't real." |
| `catch_all` | provider accepts all mail | "Their mail server accepts every address, so nobody can confirm this person exists." (PLAN: shown as **Can't confirm**) |
| `accept_all` | server accepts all; "Invalid addresses may generate delayed bounce notifications" | same as `catch_all` |
| `mailbox_is_role_address` | role based (support@…, marketing@…) | "A shared inbox." |
| `mailbox_is_disposable_address` | temporary, one-time | "A throwaway address." |
| `long_term_disposable` | disposable, doesn't expire by itself | "A throwaway address." |
| `high_risk_domain` | domain info says high risk | "The domain looks risky." |
| `subdomain_mailer` | subdomain not on Mailgun's exception list | "The domain looks risky." |
| `immature_domain` | newly created (WHOIS) | "The domain is very new." |
| `tld_risk` | high-risk TLD | "The domain ending is often used for spam." |
| `unknown_provider` | MX provider unknown | "Unknown mail provider." |
| `smtp_error` | error while validating | "Their mail server didn't answer the check." |
| `smtp_timeout` | MX didn't respond in time | "Their mail server didn't answer the check." |
| `mailbox_quota_exceeded` | mailbox full | "The mailbox is full." |
| `failed custom grammar check` (**with spaces**) | fails the provider's local-part rules | "The address breaks the provider's rules." |
| `no_data` | only with `provider_lookup=false` | "No data." |

Show any unlisted code verbatim, never as an error. The list isn't closed.

---

## 3. Errors

No validation-specific error bodies are documented. Only api-overview's generic table exists: 400 "JSON 'message' key", 401 "Invalid or missing API key", 403 "Valid credentials but access denied", 404 "May be temporal…", 429 "Retry as defined in response headers", 500 "Retry with exponential backoff". The `kind` column is what `classifyStatus()` (M3) already returns.

| Answer | Body we expect | kind | Worker action (B6.9: "pauses with a notification on auth or credit errors") |
|---|---|---|---|
| 200 but `result` missing or not a string | anything (see §2.2) | — (parsed as "unreadable") | **Commit** a check `unknown` with reason `app:unreadable_response`, keep `raw`, and charge the price, because Mailgun probably billed it. It then follows the unknown rules. Log it for the developer. |
| 400 | `{"message":"…"}`. For example, mailgun-go's mock answers `'address' parameter is required` for a missing address, and >512 characters is presumably also a 400 (**UNVERIFIED**). | `rejected` | Nothing is committed and the price isn't charged. The item becomes "Excluded: couldn't be checked" with the text behind Details. No retry, and the job continues. |
| 401 | `{"message":"Invalid private key"}` (seen on other endpoints; **UNVERIFIED** here) | `auth` | Pause every verify job and notify the Owner with M3's `AUTH_TEXT` ("…create a key with the Developer role…"). |
| 402 | **Not documented for validation.** Mailgun documents 402 only for x509 (`{"Reason":"upgrade your account to enable this feature"}`). mailgun-php maps any 402 to "Parameters were valid but request failed." | `payment` | Pause + notify: "Mailgun refused address checks for a billing or plan reason. Check Billing in Mailgun, then click Resume." |
| 403 | `{"message":"…"}` or `{"Error":"…"}` (mailgun-php reads `Error` on 403). Possible causes: the key role, validations not enabled on the plan, an account on probation or disabled (**all UNVERIFIED**). | `auth`, `not-allowed` or `business-verification` (by text) | Pause + notify with the matching M3 sentence and Mailgun's text behind Details. |
| 404 | `{"message":"…"}`, or plain `404 page not found` | `not-found` | Our bug (wrong path or host). Pause and notify. Never retry per address. |
| 429 | **UNVERIFIED** body; our fake uses `{"message":"Too many requests"}`. `X-RateLimit-*` headers may or may not be present. | `rate-limited` | Back off and lower concurrency (§4). Assumed not billed. |
| 5xx | `{"message":"Internal Server Error"}` | `server` | One retry after 2 s. Then leave the item **pending** (not "unknown") for the next pass. |
| timeout, network error | — | `timeout` / `network` | Same as 5xx. A timeout may have been billed (**UNVERIFIED**). |

**"Running out" of included validations or credit.** There is no such error. Extra use is billed at the next renewal and "cannot be deactivated" (§0.2). A failed card or unpaid invoice most likely shows up as the account being disabled, meaning 401/403 with "disabled" or "suspended" in the text. `classifyStatus` already maps that text to `not-allowed` (**UNVERIFIED** for validation). Whether the owner's Foundation account can validate at all before anything is enabled ("Available as add-on"; help: "If your account has it, the Validations option will be on the left-hand navigation") is **UNVERIFIED**; probe P1 answers it.

**Transport failure vs verdict (important).** `unknown` is Mailgun's *verdict* and is stored. A failed *call* (400/5xx/timeout/network) is **not** a verdict: nothing is stored on the Person, and the address stays "not checked". Mixing them up would trigger a pointless 24-hour re-check and hide outages.

---

## 4. Rate limits and concurrency

- **Documented:** "The Validation feature is rate limited to a set number of active requests at a time. If you receive a 429 error, please wait and try again." It limits **concurrent requests** and publishes no number. The api-overview headers `X-RateLimit-Limit/-Remaining/-Reset` are "per API" and **UNVERIFIED** on this endpoint. M3's `retryAfterMs()` parses them when present.
- **Recommended worker behaviour** (B6.9 says "2–4 checks at a time"):
  - Start with **2 in flight** (setting 1–4, default 2), with one `verify.addresses` job running at a time.
  - On a 429:
    - Stop starting new checks for `wait` and drop to **1 in flight**.
    - `wait` = `retryAfterMs(headers)` when the header is present. Otherwise use **2 s × 2^attempt with ±20 % jitter, capped at 60 s**. Don't use M3's 60 s default: it suits a per-window limit, not a concurrency limit.
    - After 25 successes in a row, add one back up to the setting.
  - A single address gets at most 5 × 429 retries per pass. After that it stays pending, and the job reschedules itself 10 minutes later.
  - Never have the same `emailNorm` in flight twice.
  - **Commit every check in its own transaction** as soon as it returns (B6.9: "a resumed job never pays twice"). Before calling, re-read the Person: if another pass already stored a fresh result, skip it.
- **Duration:** unknown until probe P1 measures latency. At about 1 s per check with 2 in flight, 5,000 addresses take about 42 min; at 3 s, about 2 h. Show progress as a count ("1,240 of 5,000 checked"), with no time estimate until measured.

---

## 5. Pricing, included checks and reading usage

### 5.1 Prices (pricing page and help 6749887012891, 2026-09-26; per 100 validations, graduated tiers counted per month)

| Monthly validations | Free | Basic | Foundation | Scale |
|---|---|---|---|---|
| Included | none (feature absent) | 0 ("add-on") | **0 ("add-on")** | **5,000** |
| First 5k | — | $1.20 | **$1.20** | $0.00 |
| Next 45k | — | $0.80 | $0.80 | $0.80 |
| Next 50k / 150k / 250k | — | $0.50 / $0.35 / $0.25 | same | same |

- The EUR tiers are €1.10 / €0.75 / €0.50 / €0.35 / €0.25.
- The help centre says: "Your Mailgun Control Panel on the Billing and Upgrade pages are the final source of all pricing details."

### 5.2 How usage is counted

- **Tier position:** "how many validations your account has performed so far during the month". The whole account counts, so other tools using the same Mailgun account share the tiers.
- **Billing:** "billed when your plan renews" (the billing cycle). **UNVERIFIED** whether "month" means calendar month or billing cycle.
- **Not documented, assumed for estimates:**
  - Every 200 answer is billed, `unknown` included. Unlike ZeroBounce, Mailgun doesn't say unknowns are free.
  - Repeating the same address is billed again.
  - 4xx and 429 answers are not billed.
  - Single and bulk checks cost the same (the pricing page has one "validations" line).
- **Upgrading mid-cycle:** "If … you upgrade your plan to cover the excess validations before the end of the billing cycle, those additional validations performed will not be billed, but will be deducted from your newly updated subscription's validations allocation."

### 5.3 Can the app read usage or what's left?

- **Usage: yes, probably.** Use `POST /v1/analytics/usage/metrics` (Send OAS, tag *Metrics*; Developer keys have Metrics Read/Write). Our request (JSON body):
  ```json
  { "start": "Tue, 01 Sep 2026 00:00:00 +0000", "end": "Sat, 26 Sep 2026 12:00:00 +0000",
    "resolution": "month", "dimensions": ["time"],
    "metrics": ["email_validation_count", "email_validation_single_count", "email_validation_bulk_count"],
    "include_aggregates": true }
  ```
  - The response is `{start, end, resolution, pagination:{…}, items:[{dimensions:[{dimension:"time", value, display_value}], metrics:{email_validation_count: 50, …}}], aggregates:{metrics:{…}}}` *(spec example shape)*.
  - `email_validation_count` is "Total number of email validations performed".
  - Dates are RFC 2822 (see the M3 reference §0.7). The Metrics API allows 500 requests per 10 s.
  - **UNVERIFIED:** that it works on Foundation, and that the month buckets are calendar months in UTC (the example buckets start `Wed, 01 Nov 2023 00:00:00 +0000`). Probe P5.
- **What's left of the allowance: no.** No endpoint reports an allowance or a remaining count. Compute `freeLeft = max(0, includedPerMonth − usedThisMonth)` with `includedPerMonth` as a setting (0 on Foundation, 5,000 on Scale).
- **Our own count is the primary number:** `VerificationCheck` rows with `costUsd` in the current month. The Mailgun figure is an optional "Mailgun counted N this month (all tools on this account)" line in Settings, refreshed at most hourly.
- `GET /v3/address/public/threshold` (`{threshold, current, triggered}`) and `/v1/thresholds/limits` (subaccount limits for pre-send features) exist, but they cover the public v3 endpoint and subaccounts. Don't use them.

### 5.4 Defaults and the Verify-step estimate

- **Setting defaults:**
  - provider `mailgun`
  - `pricePerCheckUsd` **0.012**
  - `includedPerMonth` **0**
  - `maxAgeDays` **90**
  - `recheckUnknownAfterHours` **24**
  - concurrency **2**
- **What to count:** `n` = the distinct addresses among the wizard's *otherwise eligible* recipients that are unchecked, older than `maxAgeDays`, or checked only by the fake provider. Run the free exclusions first (suppressed, company status, 30-day rule, duplicates, excluded by hand) so nobody pays to check an address that would be excluded anyway.
- **Estimate:** `cost ≈ max(0, n − freeLeft) × price`. Also show "up to $X more if some need a re-check tomorrow" (= unknown share × n × price). Use a 5 % unknown share until real data exists.
- **Store** `costUsd` on each `VerificationCheck`: the price at the time, or 0 while `freeLeft > 0`.

---

## 6. Bulk validation (documented here; not built in M5)

### 6.1 Endpoints (v4)

| Call | Details |
|---|---|
| `POST /v4/address/validate/bulk/{list_id}` | `multipart/form-data`, field **`file`**, raw CSV or gzip, UTF-8 or ASCII, ≤ 25 MB, header column `email` or `email_address`. `list_id` is our unique name and must not contain `@`. → `202 {"id":"myemails","message":"The validation job was submitted."}`. Over the parallel-job limit → 400. |
| `GET /v4/address/validate/bulk/{list_id}` | Status (below). Poll it: there is no callback. |
| `GET /v4/address/validate/bulk?limit=500` | List jobs, newest first, with `paging.{first,next,previous,last}`. |
| `DELETE /v4/address/validate/bulk/{list_id}` | Cancels a running job, or deletes the result files of an `uploaded` job (status becomes `deleted`). → `{"message":"Validation job canceled."}`. 404 `No validation job processing for list`; 409 `The job state is '[bad_state]' and is no longer cancellable`. |

*(spec example, docs)*
```json
{ "created_at": "Tue, 26 Feb 2019 21:30:03 GMT",
  "download_url": { "csv": "<download_link>", "json": "<download_link>" },
  "id": "bulk_validations_sandbox_mailgun_org", "quantity": 207665, "records_processed": 207665,
  "status": "uploaded",
  "summary": { "result": { "deliverable": 181854, "do_not_send": 5647, "undeliverable": 12116, "catch_all": 2345, "unknown": 5613 },
               "risk": { "high": 17763, "low": 142547, "medium": 41652, "unknown": 5613 } } }
```

- **Status values:** `created`, `processing`, `completed`, `uploading`, `uploaded`, `failed`, and `deleted`. Results are ready at `uploaded`: the OAS and docs examples show `download_url` only then (**UNVERIFIED** whether `completed` ever carries them).
- **`records_processed`** is the "de-duplicated total".

### 6.2 Gotchas

- **`created_at`:** the docs show an RFC 1123 string, but the OAS, mailgun.js and mailgun-php treat it as epoch seconds. Parse both.
- **Summary keys:** the docs use `catch_all` and `do_not_send`; the OAS examples use `catchall` and `donotsend`; the OAS schema adds `accept_all` and an `engagement` block. Read all of them.
- **Result files:**
  - The OAS example URLs are `https://some-aws-or-gcp-host/file.csv.zip` and `.json.zip`, which points to **third-party signed URLs**. Never attach the Mailgun key: the M3 rule allows it only on `*.mailgun.net`.
  - The files are **zip archives**. Node has no built-in zip reader (zlib handles gzip/deflate only), so bulk would need a dependency such as fflate 0.8.3 (MIT).
  - The columns inside the files are **undocumented** (**UNVERIFIED**).
- **Parallel jobs:** "max number of validation jobs … in parallel is 5" (v4 docs). The help centre's mailing-list flow (`/v3/lists/{list}/validate`) says "Only one job can be processed per account at any given time".
- **`X-Mailgun-Account-Id`:** the OAS marks this header "required" on the bulk GET and DELETE, but no SDK sends it. Treat it as a gateway artefact and ignore it.

### 6.3 List Health Preview (free sampling)

`POST/GET/PUT/DELETE /v4/address/validate/preview/{list_id}`, with the same upload rules and up to 10 in parallel. Status is `preview_processing` or `preview_complete`; the summary gives **percentages**. PUT promotes a preview to a full bulk job. The docs call it "a free analysis … based on a statistical sampling". It could later power an optional "How clean is this import?" button. Not in the plan.

### 6.4 When bulk beats single for 500–5,000 addresses: it doesn't

- **Price:** the same per validation as far as documented.
- **Speed:** 5,000 single checks at 2 in flight take roughly 40 min to 2 h in a background job, which is fine for the Verify step.
- **Complexity bulk adds:**
  - CSV building and multipart upload
  - polling
  - zip download from a foreign host
  - an undocumented file format
  - mapping rows back to people
  - all-or-nothing failure: a crash or a `failed` job loses the whole batch, while single checks commit one at a time, which is what makes "never pays twice" hold.

**Consider bulk only if** one run regularly exceeds about 10,000 addresses, **or** probe P6 shows single checks can't sustain about 1 per second. Planning already said "later option for 10k+ imports"; this confirms it.

---

## 7. How long a result stays meaningful (caching and re-check rules)

- **Mailgun:** "about 25% of your email database goes bad every year. We recommend running a full email verification on your email list annually" (Validate product page). That works out to about 2.4 % a month; after 90 days, about **7 %** of "deliverable" results would no longer hold. The plan's 90 days (SPEC §7, B6.2) is stricter than Mailgun's own advice. Keep it.
- **Mailgun caches:** "we check email addresses against our own cached data and directly with mailbox providers", and the engagement page mentions validation "via 'provider lookup' in the last 30 days". Re-checking an address within about 30 days may return the same answer, and is still billed (**UNVERIFIED**).

| Last stored result | Counts as checked for eligibility | When it's checked again | Notes |
|---|---|---|---|
| `valid`, `risky`, `catch_all` | `maxAgeDays` (90) from `checkedAt` | In a later campaign's Verify step, once older than 90 days | **Judge freshness when the recipient is reserved at launch**, not before each follow-up, or a result that ages out mid-sequence would block follow-ups (suggestion; B6.2 says eligibility runs "just before each send"). |
| `invalid`, `do_not_send` | never passes; added to `Suppression` (reason `INVALID`, source `"verification"`, detail e.g. `Mailgun: undeliverable (mailbox_does_not_exist)`) | Never automatically. Only after the Owner edits the address (which clears the result, PLAN §Person) or removes the suppression by hand. | B6.9 "Never" |
| `unknown` | never passes | **Once**, at `checkedAt + 24 h`, inside the same campaign (B6.4: "Waiting for re-check" → sent, or "Excluded: couldn't be checked"). A later campaign may re-check it if it's more than 24 h old. | Suggested caps: stop automatic re-checks after 3 unknowns within 90 days. Optionally re-check only when `reasons` contains `smtp_timeout` or `smtp_error` or is empty (the transient causes), since Mailgun may repeat a cached unknown (§0.6). |
| fake provider | never, for live or test campaigns (B6.2) | always | see §11.5 |
| hard bounce after `valid` | suppressed (M3) | — | The bounce always wins over the check. |

Every check, including re-checks, gets its own `VerificationCheck` row. The Person keeps the **latest** result (`verificationStatus`, `verificationRisk`, `verifiedAt`, `verificationProvider`).

---

## 8. Mapping to the adapter, and the default policy

### 8.1 Adapter output (PLAN B6.9)

`check(email) → { status: 'valid'|'invalid'|'risky'|'catch_all'|'unknown'|'do_not_send', risk: 'low'|'medium'|'high'|'unknown', isRole, isDisposable, didYouMean, reasons, raw }`

- The Prisma enums are the upper-case forms: `VerificationStatus` VALID…DO_NOT_SEND and `Risk` LOW…UNKNOWN.
- **Principle:** `status` restates the provider's verdict. The only judgement is splitting "deliverable" by risk, so that `risky` means exactly B6.9's "Deliverable, high risk". The policy then decides from `(status, risk, isDisposable)`.

### 8.2 Mailgun → adapter → policy

| Mailgun `result` | `risk` | → status | → risk | Default policy (B6.9 / Q13) | Person shows |
|---|---|---|---|---|---|
| `deliverable` | `low` | `valid` | low | **Send** | Checked |
| `deliverable` | `medium` | `valid` | medium | **Send** | Checked |
| `deliverable` | `high` | `risky` | high | **Blocked** (risky) | Risky |
| `deliverable` | `unknown` or missing | `valid` | unknown | **Send**. Not covered by B6.9; my choice, because the verdict is deliverable. **UNVERIFIED** that it ever occurs. | Checked |
| `catch_all` | `low` | `catch_all` | low | **Send** | Can't confirm |
| `catch_all` | `medium`, `high`, `unknown` | `catch_all` | as given | **Blocked** | Can't confirm |
| `unknown` | any | `unknown` | as given | **Hold**, then re-check once after 24 h (§7) | Couldn't check |
| `undeliverable` | any (usually high) | `invalid` | as given | **Never** + suppression `INVALID` | Doesn't exist |
| `do_not_send` | any (usually high) | `do_not_send` | as given | **Never** + suppression `INVALID` | Don't email |
| any other string | — | `unknown` | `unknown` | Hold (as unknown); keep `raw`; log once per new value | Couldn't check |
| (not a string) | — | see §3 row 1 | | | |

**Flags:**

- `isRole = is_role_address === true`. **Never blocks** (B6.9: info@, kontakt@ and post@ are General inbox people).
- `isDisposable = is_disposable_address === true`. **Suggested extra rule, not in B6.9:** when `isDisposable` is true, block even a `valid` or low-risk `catch_all`. There's no point writing cold B2B email to a throwaway inbox, and Mailgun usually answers `do_not_send` for these anyway.
- `didYouMean`: a non-empty string that differs from the address, otherwise null. Show "Did you mean …? [Use this address]". **Never apply it automatically.** Using it edits the email, which clears the result and needs a new check.
- `reasons`: the strings as received, including codes with spaces. The result wins over the reasons: a `deliverable` with an `accept_all` reason stays `valid` (my choice; keeps the mapping predictable).
- `raw`: the whole parsed body, which holds nothing secret. `root_address`, `engagement` and `last_seen` live only here.

**Setting (SPEC §8: "Risky and catch-all addresses are controlled by a setting").** Suggested keys:

- `allowRisky` (default **false**), for deliverable-high;
- `catchAllMaxRisk`: `none` | **`low`** | `medium` | `high`.

`invalid` and `do_not_send` are never configurable (SPEC §8).

### 8.3 Code shape (load-bearing rules only)

```ts
const RISKS = ["low", "medium", "high", "unknown"] as const;
export function fromMailgun(body: unknown): CheckResult | "unreadable" {
  if (!body || typeof body !== "object" || typeof (body as any).result !== "string") return "unreadable";
  const b = body as Record<string, unknown>;
  const risk = (RISKS as readonly unknown[]).includes(b.risk) ? (b.risk as Risk) : "unknown";
  const status: Status =
    b.result === "deliverable" ? (risk === "high" ? "risky" : "valid")
    : b.result === "undeliverable" ? "invalid"
    : b.result === "do_not_send" ? "do_not_send"
    : b.result === "catch_all" ? "catch_all"
    : "unknown";
  const reasons = Array.isArray(b.reason) ? b.reason.filter((r): r is string => typeof r === "string")
    : typeof b.reason === "string" && b.reason ? [b.reason] : [];
  const dym = typeof b.did_you_mean === "string" && b.did_you_mean.trim() && b.did_you_mean !== b.address ? b.did_you_mean.trim() : null;
  return { status, risk, isRole: b.is_role_address === true, isDisposable: b.is_disposable_address === true,
           didYouMean: dym, reasons, raw: b };
}
```

The policy is a pure function in `src/core/verification/` (PLAN folder layout) returning `"send" | "blocked" | "never" | "hold"`, and it is unit-tested row by row against the table in §8.2 (B12 "verification mapping and policy").

---

## 9. ZeroBounce (for later; short)

| | |
|---|---|
| Call | `GET https://api.zerobounce.net/v2/validate?api_key=…&email=…&timeout=20`. EU host `api-eu.zerobounce.net`. POST (form-urlencoded) has been accepted since 2026-09-03. `timeout` is 3–60 s (default 30); set the client timeout to about 35 s. |
| Balance | `GET /v2/getcredits?api_key=…` → `{"Credits":2375323}`. `-1` means the key is invalid. |
| Errors | `{"error":"Invalid API Key or your account ran out of credits"}`. The HTTP status is **UNVERIFIED**, so check for an `error` key even on 200, then call `getcredits` to tell a bad key from no credit. |
| Limits | 80,000 requests / 10 s (a 1-minute block when exceeded). 200 bad-key requests per hour → a 1-hour block. |
| Billing | "will never consume a credit for any unknown result" |
| Shape | `address, status, sub_status, free_email, catchall_domain, did_you_mean, domain_age_days, smtp_provider, mx_found, …, processed_at` |

| ZeroBounce status / sub_status | → status / risk | Flags |
|---|---|---|
| `valid` (any other sub_status: alias_address, alternate, gold, leading_period_removed, ai_agent_mailbox) | valid / low | |
| `valid` + `accept_all` ("exceptionally low bounce rates") | catch_all / low | |
| `valid` + `role_based_accept_all` | catch_all / low | isRole |
| `catch-all` (hyphen!) | catch_all / unknown, which is **blocked** under the default policy because ZeroBounce gives no risk grade | |
| `unknown` (greylisted, timeout_exceeded, …) | unknown / unknown | |
| `invalid` (mailbox_not_found, no_dns_entries, failed_syntax_check, possible_typo, …) | invalid / high | |
| `do_not_mail` + `role_based` | **valid / medium** (changed from planning's risky/medium, so role addresses aren't blocked) | isRole |
| `do_not_mail` + `role_based_catch_all` | catch_all / unknown | isRole |
| `do_not_mail` + `disposable` | do_not_send / high | isDisposable |
| `do_not_mail` + `mx_forward` | risky / high (blocked but not suppressed) | |
| `do_not_mail` + `toxic`, `global_suppression`, `possible_trap`; `spamtrap`; `abuse` | do_not_send / high | |

`didYouMean` = `did_you_mean`; `reasons` = `[sub_status]` when non-empty.

---

## 10. NeverBounce (for later; short)

| | |
|---|---|
| Call | `GET https://api.neverbounce.com/v4.2/single/check?key=…&email=…&timeout=10&credits_info=1`. The API reference uses **v4.2**; the "verifying an email" guide still shows `POST …/v4/single/check?key=…&email=…`. Use v4.2. The key goes in the query or body, not a header. |
| Timeout | The guide recommends about a 10 s client timeout and "treat timeouts as unknown". **We don't:** a timeout leaves the address unchecked (§3). |
| Errors | Returned **inside HTTP 200**, with `status` ≠ `success`: `general_failure`, `auth_failure`, `temp_unavail`, `throttle_triggered`, `bad_referrer`, plus a `message`. `auth_failure` → pause + notify. `throttle_triggered` / `temp_unavail` → back off (§4). |
| Credits | `credits_info=1` adds `{paid_credits_used, free_credits_used, paid_credits_remaining, free_credits_remaining}`. |
| Shape | `{status, result, flags[], suggested_correction, execution_time}` |

| NeverBounce result | → status / risk | Flags |
|---|---|---|
| `valid` | valid / low | isRole if `flags` has `role_account` |
| `invalid` | invalid / high | |
| `disposable` | do_not_send / high | isDisposable |
| `catchall` | catch_all / unknown, **blocked** by default (no risk grade) | isRole from flags |
| `unknown` | unknown / unknown | |

`didYouMean` = `suggested_correction || null`; `reasons` = `flags`.

**Provider label trap:** Mailgun says `catch_all`, ZeroBounce `catch-all`, NeverBounce `catchall`.

---

## 11. Fake server contract (`tests/fake-mailgun/**`)

This extends the M3 contract (mailgun-api-reference.md §15). The same global rules apply:

- binds 127.0.0.1 on port 0;
- never proxies;
- the client guard allows only loopback `baseUrl` under `NODE_ENV=test`;
- request log, injected clock, `failNext` fault queues, reset between tests.

### 11.1 Endpoint

- Add `{ method: "GET", pattern: "/v4/address/validate", handler: validation.validate, auth: "api" }` to `handlers/index.ts`.
- Optionally add `POST` on the same pattern with the same handler, reading `address` from the form or the query, so a POST client would also work. The app uses GET.
- **Auth "api":** a Domain Sending Key or a wrong key → 401 `{"message":"Invalid private key"}` (the M3 text; **our** assumption for this endpoint).
- **No domain parameter:** validation is account-level, so the handler accepts either region (header `x-outreach-region`).
- **Bulk, preview and every `/v3/address/*` path stay unrouted**, so they get the fake's existing plain `404 page not found`. Any accidental use fails loudly. A test asserts the app never calls them.

### 11.2 Outcomes per address (deterministic; the same rules module is shared with the in-process fake provider)

Rules are checked in this order:

1. an explicit override;
2. the domain rules;
3. the local-part rules;
4. otherwise `deliverable` / `low`.

Matching is case-insensitive. `reason` defaults to `[]`, `is_role_address` and `is_disposable_address` to `false`. `did_you_mean` is **absent** by default.

| Address pattern | 200 body (*ours*) |
|---|---|
| domain `nomx.test` | `undeliverable` / `high`, reason `["no_mx"]` |
| domain `yaho.test` | `undeliverable` / `high`, reason `["no_mx"]`, `did_you_mean: "<local>@yahoo.test"` |
| domain `catchall-low.test` / `catchall-medium.test` / `catchall-high.test` | `catch_all` / `low` / `medium` / `high`, reason `["catch_all"]` |
| domain `disposable.test` | `do_not_send` / `high`, `is_disposable_address: true`, reason `["mailbox_is_disposable_address"]` |
| domain `greylist.test` | **first** call for that address: `unknown` / `unknown`, reason `["smtp_timeout"]`; every later call: `deliverable` / `low`. Tests the 24 h re-check that passes. |
| domain `timeout.test` | always `unknown` / `unknown`, reason `["smtp_timeout"]`. Tests the re-check that fails → "Excluded: couldn't be checked". |
| local part starts `bad` | `undeliverable` / `high`, reason `["mailbox_does_not_exist"]` |
| local part starts `dns` | `do_not_send` / `high`, reason `["high_risk_domain"]` |
| local part starts `risky` | `deliverable` / `high`, reason `["immature_domain"]` |
| local part starts `medium` | `deliverable` / `medium` |
| local part starts `weird` | `result: "maybe"`, `risk: "odd"`. Tests the unexpected-value path → unknown/unknown. |
| local part starts `v3shape` | the v3 body from §2.2 (no `result`). Tests "unreadable". |
| local part starts `slow` | `deliverable` / `low` after `validateSlowMs` (default 1,500 ms) |
| local part starts `boom` | 500 `{"message":"Internal Server Error"}` |
| local part is a role (`info`, `post`, `kontakt`, `firmapost`, `sales`, `support`, `admin`, `contact`, `hello`, `office`) | normal outcome for the domain, plus `is_role_address: true`. Proves roles are never blocked. |
| local part contains `+` | normal outcome, plus `root_address` without the `+tag` |
| no `@` in the address | 200 `undeliverable` / `high`, reason `["malformed_address"]` (**our** guess of Mailgun's behaviour) |
| `address` missing or empty | 400 `{"message":"'address' parameter is required"}` (mailgun-go mock text) |
| `address` longer than 512 characters | 400 `{"message":"address exceeds 512 characters"}` (**our** text) |
| `provider_lookup=false` | `unknown` / `unknown`, reason `["no_data"]` for every address. Lets a test assert that the app never sends `false`. |

- Every 200 also carries `engagement: {"engaging": false, "is_bot": false}` by default.
- The switch `validateEngagement: "object" | "empty" | "null" | "absent"` covers the three documented shapes.
- The switch `validateDidYouMeanNull: true` sends `"did_you_mean": null` instead of omitting it.

**Overrides:**

- `fake.setValidation(address, { status?: number; body?: object; times?: number })` answers the next `times` calls (default: every call) for that address with the given 200 body or status.
- The admin mirror is `POST /__fake/validation {address, body?, status?, times?}`.

### 11.3 Faults and switches

| Need | How |
|---|---|
| 429 with headers | `failNext("GET /v4/address/validate", {kind:"status", status:429, body:{message:"Too many requests"}, headers:{"x-ratelimit-reset": String(now+2000)}}, n)` |
| 429 **without** headers | the same, with `headers: {}` and the switch `validateNoRateHeaders: true`. Today every response gets `X-RateLimit-*` from `#rateHeaders()`, so the switch must suppress them for this route. Tests the 2 s × 2^n fallback. |
| Concurrency limit (the real mechanism) | switch `validateMaxActive: number \| null` (default null). When more than N validate requests are in flight (counting delayed ones), the extra request gets 429 `{"message":"Too many requests"}` with no reset header. Combine with `validateSlowMs` so overlap is deterministic. |
| 402 | `failNext(…, {kind:"status", status:402, body:{message:"Payment required"}})` (**our** text) → the verify job pauses and one Owner notification is sent |
| 401 | `failNext(…, {kind:"status", status:401, body:{message:"Invalid private key"}})`, or just use the sending key |
| 403, both shapes | `{message:"Validations are not enabled for this account"}` and `{Error:"Forbidden"}` (**our** texts). Tests that `errorText` reads `Error`. |
| 403 business verification | the existing `{kind:"businessVerification"}` fault, whose text matches `/business verification/i` |
| 500 | `{kind:"status", status:500, body:{message:"Internal Server Error"}}` → one retry, then the item stays pending |
| Slow answer | new fault `{kind:"delay", ms, then?: Fault}`: wait `ms` on real timers, then answer normally (or with `then`). Handled in `server.ts` next to `hang`, because handlers are synchronous (`Handler = (ctx) => HandlerResult`). Tests pass `ms` above the client's lowered `timeoutMs` to get a timeout without hanging forever. |
| Never answers | the existing `{kind:"hang"}` |

### 11.4 Counters the tests assert on

- `fake.validations`: an array of `{address, at, status, billable}`, where `billable` = a 200 answer. `GET /__fake/state` gains `validations: {billableThisMonth, byAddress: {addr: count}}`, with the month taken from the fake clock.
- **Key assertions:**
  - (a) Each address is billed once per pass, even with 429s, restarts and two workers. Kill the job midway, resume, and check `byAddress` ≤ 1.
  - (b) A `greylist.test` address is called exactly twice, 24 h apart (fake clock).
  - (c) `timeout.test` gets one re-check, then no more in that campaign.
  - (d) Concurrency never exceeds the setting (the fake records the peak in-flight count).
  - (e) The app never calls validate for suppressed, excluded or fresh addresses.
  - (f) Request logs, notifications and `MailgunError` texts never contain the key (M3 redaction). Addresses appear only in the fake's query log, never in app logs.
- **Optional:** `POST /v1/analytics/usage/metrics`, only if the app implements §5.3. Answer with the section 5.3 shape, where `email_validation_count` and `email_validation_single_count` = `billableThisMonth`, and return 400 `{"message":"…"}` when `metrics` holds an unknown name.

### 11.5 Fake-provider hygiene

- The **in-process fake provider** (PLAN "fake verifier", used by unit tests) stores provider `fake`.
- **Suggested:** when `MailgunVerifier` talks to a loopback `baseUrl`, it stores provider `mailgun-fake`, and eligibility treats every provider other than `mailgun`, `zerobounce` and `neverbounce` as "only checked by the test checker" (B6.2). Then results from the lead's manual runs against the fake can never make a real address count as checked.
- E2E tests that need eligible recipients use the existing "On test list" exception.

---

## 12. Probes to run once the owner's account exists (each check costs about $0.012; the total is under $0.15)

Record the results in this file.

| # | Probe | Settles |
|---|---|---|
| P1 | Settings "Test connection" on one owner address (their own Gmail): `GET /v4/address/validate` on the EU host with the Developer key. Time it. | Validations enabled on Foundation? The exact field set (`did_you_mean` null or absent, `engagement` shape, `last_seen`, `root_address`), `X-RateLimit-*` headers, latency. |
| P2 | The same call with the Domain Sending Key, then with a wrong key (no charge expected) | The exact 401 and 403 bodies |
| P3 | The owner's `name+probe@…` address | Is `root_address` present, and does `+` survive? |
| P4 | P1's address again 1 minute later, and again the next day | Same answer? Faster (cache)? Billed twice? (Check P5 or the Control Panel usage.) |
| P5 | `POST /v1/analytics/usage/metrics` for this month | Works on Foundation with the Developer key? Do the counts match P1–P4? Calendar-month buckets? |
| P6 | 4 checks of the owner's own addresses in parallel, then 6 | Any 429? At what concurrency? Its body and headers. |
| P7 | An address at a domain known to be catch-all (ask the owner; many small-business hosts are) | The real `risk` values for `catch_all` |

---

## Sources

- Validate OAS bundle: https://documentation.mailgun.com/_bundle/docs/validate/oas/openapi-validate-final.yaml · index https://documentation.mailgun.com/docs/validate/oas/openapi-validate-final.md
- Single validation: https://documentation.mailgun.com/docs/validate/single-valid-ir.md · Email Validation API (EU note): https://documentation.mailgun.com/docs/validate/email-valid-ir.md · Validate API overview (hosts, auth): https://documentation.mailgun.com/docs/validate/api-overview.md
- Bulk: https://documentation.mailgun.com/docs/validate/bulk-valid-ir.md · List Health Preview: https://documentation.mailgun.com/docs/validate/bulk_valid_preview.md · Engagement: https://documentation.mailgun.com/docs/validate/validate_engagement.md
- API overview (status codes, rate-limit headers, regions): https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview.md · RBAC: https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt.md
- Usage metrics (`POST /v1/analytics/usage/metrics`, `UsageMetric` enum): Send OAS https://documentation.mailgun.com/_bundle/docs/mailgun/api-reference/send/mailgun.yaml
- Pricing (comparison JSON and tier tooltips): https://www.mailgun.com/pricing/ · Validate product page (25 %/year decay, annual re-validation, cache): https://www.mailgun.com/products/validate/
- Help centre (read via `https://help.mailgun.com/api/v2/help_center/en-us/articles/<id>.json`): 6749887012891 "What happens if I perform more validations than my monthly plan provides?" (updated 2024-12-17) · 360010523074 "Email Validations" (roles, public limit; 2026-05-17) · 26016288026907 "API Key Roles" (2026-05-18) · 360020598373 "Bulk Email Validations" (2025-11-21)
- SDKs: mailgun.js `lib/Classes/Validations/validate.ts`, `multipleValidation.ts`, `lib/Types/Validations/*.ts` (npm 14.0.1, modified 2026-09-04) · mailgun-go `validation.go`, `mtypes/validation.go`, `mocks/mock_validation.go` · mailgun-php `src/Api/EmailValidationV4.php`, `src/Exception/HttpClientException.php`, `src/Model/EmailValidationV4/*.php` · mailgun-ruby `vcr_cassettes/email_validation.yml`
- ZeroBounce: https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails · https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-status-codes · https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-credit-balance
- NeverBounce: https://developers.neverbounce.com/reference/single-check · https://developers.neverbounce.com/docs/verifying-an-email · error handling (planning research): https://developers.neverbounce.com/reference/error-handling
- npm (read-only): `npm view mailgun.js` → 14.0.1 · `npm view fflate` → 0.8.3 MIT
