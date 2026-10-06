# Milestone 5 code map: what already exists

Written 2026-09-26 from reading the code, not the plan. Paths are relative to the repo root. "M5" means Milestone 5
"Address checks and AI" (PLAN.md A8 item 5, SPEC.md milestone 5). This file only describes existing code: where M5
plugs in, what it must not break, and gaps found along the way. For WHAT to build, see SPEC §2, §4, §6, §7, §8 and
PLAN A3 Q13/Q14, A6, B6.2, B6.4, B6.9, B6.12, B6.13, B7–B10, B12. Format follows `m4-code-map.md`.

---

## 0. The integration points that matter most

1. **The schema is already there; no code uses it.** `VerificationCheck`, `AiDraft`, `WebsiteSnapshot`, `RobotsCache`,
   `AiDraftStatus`, `RecipientState.RECHECK` and `SuppressionReason.INVALID` exist since the init migration, but nothing
   in `src/`, `worker/` or `scripts/` reads or writes the four models (grep: zero hits outside `src/generated`). Nothing
   writes `Person.verification*` except the demo data (provider `"fake"`); code only reads them and clears them when an
   address changes (§2.7). Gaps that may need a migration: §6.
2. **Unchecked people can't even be ticked in TEST/LIVE campaigns.** `personReasons()` (`src/core/rules/eligibility.ts:235-251`)
   makes `not-checked` / `test-checker` / `check-too-old` ordinary blocking reasons. The audience then gives them
   `eligible: false` and `canTick: false` (`audience.ts:274-288`), leaves them out of the default pick
   (`eligibility.ts:454-468`, `addCompaniesToAudience` `:568`), refuses to tick them (`setPersonTicked` `:837-840`), and launch
   excludes them (`launch.ts:314-340`, `:580-590`). So a Verify step has nobody ticked to check. M5 must make the three
   "needs a check" codes tickable in the draft and block only at launch and send, or resolve them in the Verify step.
   Before go-live (nothing writes `sending.goLive` yet; that's M6), TEST/LIVE reach only test-list addresses, and those
   count as checked. A DRY_RUN never needs checks but respects existing results. So with today's settings the Verify
   count is 0 for every mode; M5 tests need `sending.goLive = true`.
3. **"Unknown" excludes or stops a person today; there is no re-check path.** `checkDecision()` returns `"recheck"` →
   reason `check-unknown` (blocking, not overridable). At launch this means EXCLUDED (`writeChunk`, `launch.ts:580-590`).
   At send time, `recheckRecipient()` → `skipClaimed()` (`loop.ts:626-630`, `:299`) means STOPPED, with the sentence as
   `stopReason`, because `stopReasonFor()` falls through to `r.text` (`core/rules/eligibility.ts:353-354`). Nothing
   writes `RECHECK`. It is already treated as "open, waiting": skipped by the gates and the loop, still open for
   finishCheck, stoppable. Holds ignore it (§2.5).
4. **Mapping trap.** `checkDecision()` sends VALID with LOW/MEDIUM risk. It blocks VALID+HIGH and every `RISKY` (whatever
   the risk) through `policy.deliverableHighRisk` (`:182-185`). The research mapping
   (`docs/dev/research/mailgun-inbound-validation-domain.md:107`) turns "deliverable + medium|high" into `risky/<risk>`,
   which would **block deliverable medium-risk addresses**, against B6.9 and `tests/unit/rules/eligibility.test.ts:162`.
   Map deliverable+low|medium to VALID and deliverable+high to RISKY (or VALID/HIGH).
5. **There is no validation client.** `MailgunClient` has no `validateAddress`; M3-DESIGN §1 names it as the place.
   - `#call` already retries 429 (Retry-After, capped at 60 s) and 5xx/timeouts when a call is idempotent.
   - `getMailgunContext()` only reads `mailgun.apiKey`. `mailgunSecrets()` doesn't include `verification.apiKey`, so
     that key is never redacted.
   - The practice copy never connects to Mailgun, so the only checker it can use is the test checker (`"fake"`).
   - The fake Mailgun has no `/v4/address/validate` (it answers `404 page not found`).
6. **The job runner has one lane.** `JobRunner.tick()` runs at most one job at a time (`worker/runner.ts:347-389`), with
   nothing that pre-empts or yields.
   - A long `verify.addresses` or `ai.draftLines` run delays `mailgun.catchUp` (hourly), `send.testEmail` (a person
     waiting) and backups. B8's "per-item sub-steps that yield" doesn't exist.
   - A handler can't queue its own continuation under its own dedupe key: `enqueueJob` returns the running job while its
     `activeDedupeKey` is set.
   - The runner calls `describeJobError(err)` **without secrets** (`runner.ts:234`), so handlers must redact their own
     errors. `redactText` has no pattern for bare `sk-ant-…` keys.
7. **Nothing writes an AI personal line yet.** `setCompanyPersonalLine()` always writes `personalLineSource "manual"`
   (`companies/mutations.ts:486-518`). `personalLineSourceText("ai", …)` already says "AI, approved by X on 3 Mar".
   Render reads the **current** `Company.personalLine` at send time (`render.ts:59-107`), so an approval after launch
   changes emails that haven't gone out yet.
8. **Only half of the missing-emails round trip exists.**
   - The export works, but the ready-to-paste instruction for Claude (SPEC §4 "copies a ready-to-paste instruction") is
     missing.
   - There is no import by `company_id`: `company_id` maps to **ignore** (`core/import/column-matching.ts:233-237`).
   - A normal import of Claude's CSV today maps `source_url` to Website and `note` to Notes, then matches by domain or by
     name. A domain match is skipped by default ("skip" duplicates, so no people are added). A name-only match with no
     country becomes "possible duplicate" and defaults to **new**, which creates duplicates (§4.3).
9. **`Suppression` reason `INVALID` is read everywhere and written nowhere.** Eligibility words it as "On the do-not-email
   list (the address doesn't exist)". Deliverability has an "Invalid" filter, and its label for source `"verification"`
   is "Address check". But nothing writes it.
   - `stopRecipients()` has no `invalid` reason. Only the send-time skip writes `"invalid"`, through `stopReasonFor`.
   - `pushLocalSuppressions()` pushes **every** unpushed row, INVALID ones included, to Mailgun's unsubscribes.
10. **Settings are keys only.** `verification.provider/pricePerCheck/maxAgeDays/policy`, `ai.model` and `ai.monthlyLimitUsd`
    exist. There are no prices per model, no AI pause state, no page for them and no Settings › AI (the Owner nav list is
    pinned by a test).
11. **None of the five planned packages are direct dependencies.** `undici` 7.29.1 and `ipaddr.js` 1.9.1 are in
    `node_modules` only because shadcn pulls them in. Never import them from there (§7).
12. **Text that announces M5:** 9 user-facing strings in 5 files (the Verify page, the AI lines page, the bulk bar, the
    list menu, the panel's "Draft with AI"), plus 6 code comments (§1).

---

## 1. Every M5 placeholder in `src/`

| file:line | What it is / says |
|---|---|
| `src/app/(app)/campaigns/[id]/setup/verify/page.tsx:10-14, 27-33` | Wizard step 4. The header comment says checks "arrive in Milestone 5". The card reads "Address checks arrive in Milestone 5. This campaign is a dry run, so nothing is sent." (or "…Until you go live, only your test-list addresses get email, and they count as checked.") plus "From Milestone 5 this step shows how many addresses need checking and what it costs… For now, click Continue." Only `StepFooter`. `continueAction` (`setup/actions.ts:129-158`) checks nothing for `from: "verify"`. |
| `src/app/(app)/ai-lines/page.tsx:7-15` | `<ComingLater title="AI lines" milestone={5} what="Claude drafts one specific sentence per company from its website, and you approve, edit or reject each one here." />` (so the heading is "AI lines arrive in Milestone 5" and there's a "Go to Contacts" button). |
| `src/components/page-header.tsx:57-85` | `ComingLater({title, milestone, what, next?})`. Still used by `dashboard/page.tsx` (M6), so keep it. |
| `src/components/contacts/bulk-bar.tsx:273-274` | Disabled "Draft personal lines" (Sparkles) and "Check emails" (MailCheck), with the tip "Arrives in Milestone 5". |
| `src/components/contacts/bulk-bar.tsx:341-363` | A local `ComingLaterButton({icon, label, tip})` used only by those two. |
| `src/components/campaign-wizard/coming-later-button.tsx:11` | An exported `ComingLaterButton({icon, label, when, size})`. **Unused anywhere** (dead code). |
| `src/components/contacts/list-sidebar.tsx:190-195` | List menu (`ListMenu`): a disabled `DropdownMenuItem` "Draft personal lines" with "Arrives in Milestone 5". |
| `src/components/company-panel/personal-line.tsx:12-33, 43` | `DraftWithAiButton`: `aria-disabled`, an sr-only " (arrives in Milestone 5)" and the tooltip "Arrives in Milestone 5". Shown in the Personal line section's actions when `!view.readOnly`. |
| `src/server/settings.ts:32, 64` | Comments "Address checks (Milestone 5)" and "AI (Milestone 5)". |
| `src/server/notifications.ts:31` | Doc list: "ai.draftsReady, verify.finished (Milestone 5)". |
| `src/server/services/export.ts:240-244` | Comment: the re-import that reads company_id back "arrives with the rest of the missing-emails round trip (Milestone 5)". |
| `src/core/import/column-matching.ts:10-11` | Comment: to add `company_id` later, "add it to TARGET_FIELDS and to the dictionary below". |

Related, with no milestone number:
- `src/components/contacts/toolbar.tsx:270-282`: the Export menu's "Export for Claude" (Missing email view only).
- `company-panel/people-section.tsx:361-365`: the empty-people text "…use Export for Claude on the Missing email view".
- `app/(app)/dashboard/page.tsx:13`: M6's dashboard promises "AI lines to review … companies missing emails".
- `components/shell/nav-items.ts:27`: "AI lines" in `MAIN_NAV`, with **no count** (A6 wants one). `Sidebar` takes no props.
- Outside src: the `JobType` members `verify.addresses` and `ai.draftLines` (`src/server/jobs.ts:14-15`) have no handler;
  tests use them as "unknown type" examples (§8).

---

## 2. Address checks

### 2.1 Data (`prisma/schema.prisma`)
- `enum VerificationStatus` (`:38-45`): VALID, INVALID, RISKY, CATCH_ALL, UNKNOWN, DO_NOT_SEND.
- `enum Risk` (`:47-52`): LOW, MEDIUM, HIGH, UNKNOWN.
- `Person` (`:368-371`): `verificationStatus?`, `verificationRisk?`, `verifiedAt?`, `verificationProvider?` ("fake" = the
  test checker). There is no role/disposable/did-you-mean field, no pointer to the last `VerificationCheck` and no re-check
  counter.
- `VerificationCheck` (`:455-469`): `personId?` (no FK/relation), `emailNorm`, `provider`, `status`, `risk`,
  `reasons Json?`, `raw Json?`, `costUsd Float?`, `jobId?` (no FK), `checkedAt`; index `(emailNorm, checkedAt)` only.
- `CampaignRecipient.state` can be `RECHECK`. It has **no field for when the re-check is due**. `nextDueAt` is the
  sweeper's, and `heldAt`/`holdReason` belong to HELD only (M4 rule 7).
- `Suppression` (`:445-453`): `reason` has INVALID, `source` is a free string (the comment lists "verification").

### 2.2 Pure rules: `src/core/rules/eligibility.ts` (re-exported by `core/rules/index.ts`)
| Export | Meaning |
|---|---|
| `ELIGIBILITY_CODES` (`:14-39`) | order = what's shown first: …`not-on-test-list`, `not-checked`, `test-checker`, `check-too-old`, `check-undeliverable`, `check-do-not-send`, `policy-blocked`, `check-unknown`, `unsubscribed`… |
| `OVERRIDABLE_CODES = ["company-replied"]` (`:44`) | no check code can be overridden |
| `VerificationStatusValue`, `RiskValue`, `SuppressionReasonValue` (`:88-90`) | string unions mirroring Prisma |
| `VerificationPolicy {deliverableHighRisk, catchAllLow, catchAllMedium, catchAllHigh, unknown}` (`:93-99`) | values "send"\|"block" (+"recheck" for unknown) |
| `DEFAULT_VERIFICATION_POLICY` (`:101-107`) | block, send, block, block, recheck (= Q13 defaults) |
| `PersonFacts` (`:109-125`) | includes the four check fields and `suppression` |
| `EligibilityContext {mode, now, maxCheckAgeDays, policy, testList, goLive, senderHasReplyRoute?, senderName?}` (`:145-159`) | |
| `CheckDecision = "send"\|"block"\|"recheck"\|"undeliverable"\|"do-not-send"`, `checkDecision(status, risk, policy)` (`:163-195`) | INVALID→undeliverable, DO_NOT_SEND→do-not-send, VALID→send unless HIGH, RISKY→deliverableHighRisk, CATCH_ALL LOW/HIGH/other(medium, unknown)→the matching key, UNKNOWN→unknown. Unknown setting values block |
| `personReasons(person, ctx)` (`:219-278`) | See the rules below |
| `policyBlockedText` (`:280-284`) | "Can't confirm this address (medium risk); your check settings skip these" / "The address check rated this address high risk; your check settings skip these" |
| `evaluateEligibility({company, person, teamRule, recipient?, ctx})` (`:311-327`) | `{eligible, reasons, blocking, reason, notes}` |
| `stopReasonFor(r)` (`:336-356`) | check-undeliverable / check-do-not-send → `"invalid"`; check-unknown / policy-blocked / not-checked → the sentence |

The rules in `personReasons`:
- **TEST/LIVE only**: before go-live, a test-list address gets the note "On test list"; any other address gets
  `not-on-test-list`. Unless the address is a test-list one before go-live (`countsAsChecked`, `:241`):
  - `not-checked` when status or `verifiedAt` is missing;
  - else `test-checker` when the provider is `"fake"`;
  - else `check-too-old` when older than `maxCheckAgeDays × DAY_MS` (plain ms arithmetic).
- **Every mode** (dry runs too): an existing result goes through `checkDecision`. Its reasons are "The address check
  said this address doesn't exist" / "…said not to email this address" / "The address check got no answer; it's checked
  again after 24 hours" / the policy text.
- A suppression with reason INVALID adds `suppressed` "On the do-not-email list (the address doesn't exist)" (`:271`).

`core/rules/default-people.ts:25-33` `pickDefaultPerson`: the first eligible person with `verificationStatus === "VALID"`,
then named, then General inbox. It never looks at risk, date or provider.

### 2.3 Server side: `src/server/services/eligibility.ts`
| Export | Meaning |
|---|---|
| `EligibilitySettings` (`:47-60`), `loadEligibilitySettings()` (`:62-92`) | reads `verification.maxAgeDays` (fallback 90), `verification.policy` merged over `DEFAULT_VERIFICATION_POLICY`, `sending.testList`, `sending.goLive`, … |
| `PersonEligibility` (`:96-112`) | carries `verificationStatus` (not risk/date) |
| `CompanyEligibility` (`:114-132`) | `defaultPersonIds` |
| `evaluateCompanies(companyIds, {mode, campaignId?, now?, settings?, recipients?, personIds?, senderHasReplyRoute?, senderName?})` (`:245-484`) | loads the four check fields (`personSelect :271-287`) plus suppressions. The default pick (`:454-468`) only uses people whose own reasons are all company-level, so an unchecked person is never the default in TEST/LIVE |
| `recheckRecipient(recipientId, {now?, toNorm?, settings?})` (`:514-560`) | the send-time re-check (loop). Same rules, so a result that became UNKNOWN or too old since launch **stops** the recipient |

### 2.4 What each mode does with checks today
| Where | DRY_RUN | TEST / LIVE before go-live | LIVE after go-live |
|---|---|---|---|
| Audience (`campaigns/audience.ts` `buildView :258-336`, `canTick :288`) | only existing results block | only test-list addresses tickable; they count as checked | unchecked / fake-checked / >90 days: not tickable, company in "Excluded" with "Nobody here can be emailed" |
| Launch (`launch.ts:314-340`, `writeChunk :541-596`) | ineligible ⇒ `included false, state EXCLUDED, exclusionReason = text`, rows CANCELLED | same | same, so check-unknown ⇒ EXCLUDED, never RECHECK |
| Send (`loop.ts:602-679`) | `recheckRecipient` ⇒ `skipClaimed` ⇒ STOPPED | same | same, so UNKNOWN ⇒ STOPPED with the sentence |

- The draft is evaluated with the mode it **would** launch with: `draftSendingMode()` (`audience.ts:180-183`) = Setting
  `sending.mode`.
- `syncExclusionReasons` (`audience.ts:972-999`), run just before launch, writes an unticked person's first reason
  (e.g. "Address not checked yet") as their `exclusionReason`.

### 2.5 RECHECK today (M4 behaviour M5 inherits)
- Written by **nobody**.
- `gates.ts:90` `WAITING_RECIPIENT_STATES = ["HELD","RECHECK","PENDING"]`. The candidate queries (Prisma and the raw
  SQL `:344`) never pick their emails; the emails stay QUEUED.
- `loop.ts:224` `HOLDING_RECIPIENT_STATES`: a claimed email of a RECHECK recipient is released, not counted as a try.
- `control.ts:43` `OPEN_RECIPIENT_STATES` includes RECHECK. `finishCheck` (`:123`) keeps the campaign RUNNING while
  any recipient is RECHECK.
- `mail-events/stops.ts:32` `STOPPABLE_STATES` includes RECHECK (a bounce/reply stops it).
- `sequences/holds.ts:33-35` `OPEN_STATES`/`UNHELD_STATES` **exclude RECHECK**: an outage or possible-reply hold skips
  RECHECK people. After a release from RECHECK, M5 must apply pending holds, like launch does with
  `applyPendingPossibleReplyHolds`.
- To copy for the release: `releaseRows()` (`holds.ts:122-149`) puts `currentStep > 0` back to WAITING, else SCHEDULED,
  with compare-and-set in chunks of 500.
- Wording already exists: "Waiting for the address to be checked again" (`components/campaigns/format.ts:668-669`),
  "waiting for the address to be checked again" (`company-panel/emailed-text.ts:210-211`).
- Stop code `invalid` is worded "address check failed" / "the address check failed" (`format.ts:602`,
  `emailed-text.ts:134`). `stopRank("invalid")` is −1 (never replaced).
- M4 rule 7 (M4-DESIGN §0.2): recipients are stopped only through `stopRecipients` / `stopCompany` /
  `stopCompaniesForStatus`. "Excluded: couldn't be checked" **after** launch has no function yet.

### 2.6 Settings and secrets for checks
- `src/server/settings.ts:33-42`:
  - `verification.provider` "mailgun";
  - `verification.pricePerCheck` 0.012;
  - `verification.maxAgeDays` 90;
  - `verification.policy` (the 5 keys).
- `SettingValue<K>` widens these (the policy becomes `{…: string}`). `setSetting` neither validates nor logs.
- `src/server/secrets.ts:12-17`: `SecretKey` includes `"verification.apiKey"` (B6.9: defaults to the Mailgun key). No
  page reads or writes it.

### 2.7 Who writes or clears the check fields
- `people.ts:193-273` `updatePerson`: an address change clears all four fields and `bouncedAt`. It returns
  `checkCleared`, and the activity summary adds "…and cleared the address check". The action says "Saved. The new
  address needs checking again." (`company-panel/actions.ts:384`).
- `imports/commit.ts:502-515`: "fill" (an address given to an existing person without one) clears the four fields.
  Created people start null.
- `people.ts:118-188` `addPerson`: bringing back a removed person keeps their old result (same address).
- `scripts/make-demo-data.ts:255-258`: demo people get `verificationProvider: "fake"` (test checker) and no
  `VerificationCheck` rows.
- **No writer of real results. No activity type for a check** (`server/activity.ts:8-34` lists none).

### 2.8 Suppression INVALID
- `SuppressionReason.INVALID` appears in:
  - `core/rules/eligibility.ts:90, 271`;
  - `mail-events/deliverability.ts:251-259` (`SUPPRESSION_FILTERS`, label "Invalid") and `:283` (`source "verification"`
    → "Address check");
  - `components/settings/deliverability/suppression-list.tsx:13, 36`;
  - `mailgun/suppressions.ts:214` (`RANK` MANUAL 0 < INVALID 1 < BOUNCED 2 < UNSUBSCRIBED 3 < COMPLAINED 4);
  - `core/mailgun/events.ts:364` `SUPPRESSION_PRECEDENCE`.
- Writers: none. The model to copy is `addManualSuppression()` (`mailgun/suppressions.ts:221-270`): suppression row,
  `stopRecipients(tx, {emailNorm, reason: "suppressed", scope: "real", now})`, activity `suppression.added`, then
  `enqueueSuppressionPush`.
- `StopReason` (`stops.ts:26`) = bounced | complained | unsubscribed | suppressed | replied | company_replied. There is no
  `invalid`.
- `pushLocalSuppressions` (`:172-204`) pushes any reason to the active domain's unsubscribes list.

### 2.9 Where check results are shown
- `components/badges.tsx:56-72` `VerificationBadge({status})`: "Not checked" when null. The CATCH_ALL tooltip is "The mail
  server accepts every address, so nobody can confirm this person exists."
- `core/labels.ts:40-47` `VERIFICATION_LABELS`: CATCH_ALL → "Can't confirm".
- Company panel: `companies/detail.ts:58-61, 333-336` carry the four fields. `company-panel.tsx:202-203` builds
  `checkedText(verifiedAt, provider, tz, now)` (`emailed-text.ts:407-416`: "checked 3 Mar", "+ by the test checker").
  `people-section.tsx:285-286` shows the badge and the text. There is no per-person "Check" action.
- Wizard audience: `audience.ts:195, 284` → `audience-step.tsx:501` badge.
- Export: column `verification` (`export.ts:35, 195`, label). Contacts rows show no check state.

---

## 3. AI personal lines

### 3.1 Data (`prisma/schema.prisma`)
- `enum AiDraftStatus` (`:134-143`): QUEUED, FETCHING, DRAFTING, READY, NO_LINE, FAILED, APPROVED, REJECTED. The A6
  queue tabs Waiting/Approved/Rejected/No line/Failed map to READY/APPROVED/REJECTED/NO_LINE/FAILED.
- `AiDraft` (`:880-906`): `companyId` (no FK), `jobId?`, `model`, `promptVersion`, `status`, `line?`, `evidenceQuote?`,
  `evidenceSource?`, `evidenceUrl?`, `flags Json?` (warnings), `reasonIfNull?`, `inputTokens?`, `outputTokens?`,
  `costUsd?`, `requestId?`, `reviewedById?`, `reviewedAt?`, `finalLine?`, `error?`, `createdAt`, `updatedAt`. Indexes
  `(status)` and `(companyId)`.
- `WebsiteSnapshot` (`:908-922`): `companyId`, `url`, `finalUrl?`, `pageKind` ("homepage" | "second_page"),
  `httpStatus?`, `text`, `chars`, `lang?`, `fetchedAt`, `skipReason?`; index `(companyId, fetchedAt)`. The research also
  lists `contentType`/`bytes` (`anthropic-ai.md:115`); they aren't there.
- `RobotsCache` (`:924-929`): `host` PK, `status`, `body`, `fetchedAt`.
- `Company` (`:316-319`): `personalLine?` ("approved text only"), `personalLineSource?` ("manual" | "ai" | "import"),
  `personalLineUpdatedAt?`, `personalLineUpdatedById?`. `website`, `domain` (null for shared hosts), `profileKey`,
  `instagram`.
- `Person.personalLineOverride?` (`:372`).

### 3.2 Writing and reading the line
| Where | What |
|---|---|
| `companies/mutations.ts:73` | `LIMITS.personalLine = 300` |
| `companies/mutations.ts:475-484` | `cleanPersonalLine(input)` (collapses whitespace to one line) and `personalLineProblem(line)` ("Keep the personal line under 300 characters…") |
| `companies/mutations.ts:486-518` | `setCompanyPersonalLine(actor, companyId, input) → {changed, line}`: one dbTx, `personalLineSource: line ? "manual" : null`, activity `company.personalLine` "X wrote/removed the personal line", `data {line}` |
| `people.ts:365-395` | `setPersonPersonalLine(actor, personId, input)`: writes `personalLineOverride`, activity `data {field:"personalLineOverride", line}` |
| `company-panel/actions.ts:244, 418` | `setCompanyPersonalLineAction`, `setPersonPersonalLineAction` |
| `campaigns/[id]/setup/actions.ts:400-423` | `setCompanyLineAction`, `setPersonLineAction` (Review step, `review-step.tsx:1045-1086`) |
| `imports/commit.ts:232-235, 299-304` | import writes `personalLineSource "import"` |
| `company-panel/emailed-text.ts:385-425` | `personalLineSourceText(source, byName, at, tz, now)` ("Written by Ali on 3 Mar" / "Imported" / "AI, approved by Ali on 3 Mar"), `wordCount`, `PERSONAL_LINE_MAX_CHARS 300`, `PERSONAL_LINE_GOOD_WORDS 25` |
| `company-panel/company-panel.tsx:213-220` | `personalLineView()` → `PersonalLineView {companyId, readOnly, line, sourceText}` (`company-panel/types.ts:72-77`) |
| `company-panel/timeline.tsx:93` | icon for `company.personalLine`. `timeline-view.ts:63-70` shows `data.line` as the detail line |

There is no "previous line" anywhere. An Undo within 10 s after Approve (A6) needs the old line and source stored
(`AiDraft` has no field for them) or read back from the activity's `data`.

### 3.3 The `personal_line` variable
- `core/templates/variables.ts:36-38`: a standard variable, "The approved personal line (the person's own line when they
  have one). Use {{personal_line|}} so it can be empty."
- `core/templates/context.ts:119` `buildTemplateValues`: `personal_line = person.personalLineOverride.trim() ||
  company.personalLine.trim()`. `TemplateCompany.personalLine` is "the approved personal line only".
- `server/services/render.ts:59-107`: `PERSON_SELECT` reads `personalLineOverride` and `company.personalLine` fresh on
  every render (preview, Review, send).
- Empty-line removal and `{{personal_line|}}` are pinned in `tests/unit/templates/engine.test.ts`. The default templates
  use it (`core/templates/defaults.ts:29, 100`).

### 3.4 Settings, secret and model
- `settings.ts:65-66`: `ai.model` "claude-haiku-4-5-20251001" and `ai.monthlyLimitUsd` 20. There are no price settings,
  model profiles (max_tokens / effort), prompt version or AI pause flag. The pause would fit SystemState, like
  `sending.pause`; `STATE_KEYS` are in `core/system-state.ts:7-22`.
- `SecretKey` includes `"anthropic.apiKey"`.
- Heads-up from the research (`docs/dev/research/anthropic-ai.md:28`): Haiku 4.5's tentative retirement is "Not sooner
  than October 15, 2026". PLAN A3 Q14 says "late November 2026".

### 3.5 Website reading: nothing exists
- There are no SSRF helpers (no `ipaddr`, `net.isIP`, public-only lookup). The only outgoing fetches are the Mailgun
  client and the remote-access check (`services/checks/tunnel.ts:94, 175`: cloudflared's loopback `/ready` and the app's
  own public address). There is no robots handling or HTML extraction.
- Reusable pieces:
  - `services/checks/dns-lookup.ts:33` `createDnsLookup("1.1.1.1"|"8.8.8.8", {timeoutMs?, tries?})` (node:dns Resolver);
  - `core/shared-domains.ts:368` `parseWebsite(input, extra?)`;
  - `core/rules/team-rule.ts:92` `usableCompanyDomain(domain, extraShared)`. Use this for "has its own website": the
    stored `Company.domain` isn't recomputed when `sharedDomains.extra` changes.
- The Mailgun pattern to copy for "no real host in tests": `tests/unit/mailgun-client/no-real-hosts.test.ts` (greps
  `src/**` and `worker/**` for the host) plus `isTestRun()` (`server/mailgun/base-url.ts:30`).

### 3.6 Screens that exist
- `/ai-lines`: placeholder (§1). Settings › AI: missing.
- The company panel section is in `personal-line.tsx`.
- The Contacts bulk bar and the list menu buttons are disabled (§1).
- `Company.personalLine` is shown in the Contacts export (`export.ts:38, 184-197`).

---

## 4. The missing-emails round trip

### 4.1 The "Missing email" view (M1)
- The filter is `view=missing-email`, or `hasEmail=no` (`companies/filters.ts:24, 66, 104-106, 122`): companies with no
  live person with an `emailNorm`. Companies whose only address is on a removed person count as missing.
- Sidebar count: `getContactsSidebar()` → `missingEmailCount` (`companies/query.ts:177-192`). Links:
  `list-sidebar.tsx:80-84, 364-367`, `components/contacts/url.ts:72-79` `viewHref`, and the command menu
  (`shell/command-menu.tsx:35`).
- Heading "Missing email" (`app/(app)/contacts/page.tsx:72`). The empty state `no-missing` (`url.ts:112`) shows "Every
  company has an email address."

### 4.2 Export for Claude
- `GET /api/export/missing-emails` (`src/app/api/export/missing-emails/route.ts`): `getUserOrNull` (a signed-out person
  gets a 303 to login with `next`), `?format=csv|xlsx`, `?delimiter=semicolon`, plus the Contacts filters. It is
  read-only, and an error shows `downloadErrorPage`.
- `services/export.ts:245-255`: `MISSING_EMAIL_COLUMNS = company_id, company, website, country, email, contact_name,
  role, source_url, note`.
- `exportMissingEmails({filters, format, delimiter?, timeZone, now?}) → ExportFile` (`:258-301`):
  - forces `view: "missing-email"`;
  - `company_id = "C-<id>"`, `website = website ?? instagramUrl(instagram)`, `country = countryName`, the rest empty;
  - capped at `MAX_EXPORT_COMPANIES` (`ExportTooBigError`);
  - file `missing-emails-YYYY-MM-DD.csv|xlsx`.
- UI: `toolbar.tsx:270-282` shows a plain `<a href={missingEmailsExportHref(filters)}>` (`url.ts:136-141`) with the note
  "A CSV to ask Claude to find missing emails".
- **Missing:** the instruction text (B6.13 gives it word for word) and the copy / select-all box (`components/copy-text.tsx`
  `copyText` / `CopyField` already handle the http fallback). The `.xlsx` variant exists, but the plan only asks for CSV.

### 4.3 Re-import by `company_id`: does not exist
- The import pipeline:
  - `POST /api/imports` (upload);
  - `import/actions.ts`: `saveImportMappingAction`, `saveImportOptionsAction`, `checkImportAction`,
    `setImportChoiceAction`, `setImportDefaultsAction`, `startImportAction` (`:186-213`, enqueues `import.commit` with
    dedupe `import:<sessionId>`), `importJobAction`;
  - `imports/check.ts:626` `analyzeImport(sessionId, mapping, options, {fresh?, excludeCompanyIds?, now?})`;
  - `imports/commit.ts:750` `runImportCommitJob` (250 rows per chunk, resumable per `ImportRow.status`).
- Mapping: `core/import/column-matching.ts:14-32` `TARGET_FIELDS` has no `company_id`. The dictionary maps
  `company_id`/`company id`/`id`/`#` to **ignore** (`:233-237`). With Claude's columns: `company`→company,
  `email`→email, `contact_name`→name (`:165`), `role`→role, `source_url`→**website** (contains-rule token `url`, when
  the samples look like URLs, `:271-273`), `note`→**notes** (`:284`, appended to company notes).
- Matching (`check.ts:298-324` `matchOne`), in this order: domain/profile/Instagram exact → name + same country (the
  file has no country, so it only matches companies without one) → the owner of the person's email → name only =
  "possible duplicate" (`options.possibleDuplicates` default **"new"**, `core/import/types.ts:34-43`).
  `duplicates` default "skip" (`planPeople :396-449`): a skipped group adds **no people**.
- There is **no parser for "C-1042"**. Formatters are `companyCode()` in `imports/sessions.ts:26`,
  `companies/detail.ts:127` and `components/contacts/format.ts:14`. The only parsing is inline in
  `searchCompaniesQuick` (`companies/query.ts:284`, `/^c?-?\s*(\d{1,9})$/i`).
- Wanted (B6.13): recognise `company_id`, add people to those companies only, skip existing emails, never create
  companies, list unknown ids as problems. The existing per-row problem path ("already belongs to C-…",
  `check.ts:405-411`), `ImportRow.status` PROBLEM and the problems CSV (`imports/problems.ts`) can carry "unknown id".

---

## 5. Platform pieces M5 will use

### 5.1 Jobs: `src/server/jobs.ts`
| Export | Meaning |
|---|---|
| `JobType` (`:10-24`) | already includes `"verify.addresses"` and `"ai.draftLines"` |
| `EnqueueInput {type, payload?, runAt?, priority?, maxAttempts? = 3, dedupeKey?, createdById?}`, `enqueueJob(input, tx?)` (`:26-56`) | While a job with the same dedupe key is QUEUED/RUNNING, returns that job. `runAt` in the future = a delayed job (usable for "re-check after 24 h") |
| `PublicJob` / `toPublicJob(job)` (`:59-89`) | only `id, type, status, progressDone, progressTotal, summary (result.summary), error, errorDetail, createdAt, finishedAt` reach the browser. Per-result counts (valid / invalid / cost) need new whitelisted fields or their own query |
| `getJob`, `cancelJob(id)` (QUEUED only) | |
| `JobContext {jobId, createdById, signal, progress(done,total)}`, `JobHandler = (payload, ctx) => Promise<Json & {summary?}>` (`:107-117`) | |
| `setJobProgress`, `redactText(text, secrets)`, `redactError`, `PlainJobError(message, detail?)`, `isUserFacingError`, `describeJobError(err, secrets)` (`:119-198`) | |

### 5.2 `GET /api/jobs/:id` (`src/app/api/jobs/[id]/route.ts`)
- `getUserOrNull` (401 if signed out), the id must match `^\d{1,10}$`, 404 when missing.
- **Owner-only = `job.type.startsWith("mailgun.")`** (`:21`), so `verify.*` and `ai.*` are visible to Members.
- Answers with `toPublicJob` and `no-store`.
- Client helper: `components/settings/domain/use-job-poll.ts` `useJobPoll(jobId, {onProgress?, onDone})` (every 2 s,
  gives up after 15 network failures), `PolledJob`, `JOB_POLL_MS`.

### 5.3 Worker runner and registry
- `worker/jobs/types.ts:12-25`: `JobDefinition {handler, label, whatToDo, link?, failureNotice?(payload, error) →
  {title, body, link?, type?}}`, `JobRegistry`.
- `worker/jobs/index.ts`:
  - `JOB_PRIORITIES` (`:26-35`): send.testEmail 60, catchUp 50, restoreScan 40, applySettings/syncRoutes 30,
    checkDomain/warmup 20, syncSuppressions 10. Nothing for M5.
  - `JobRegistryDeps {mailgun?, now?, logger?}` (`:37-44`). **No injection point for a Claude client, a fetcher or a
    verifier yet.**
  - `createJobRegistry(deps)` (`:83-121`), `JOB_REGISTRY`.
  - Small handlers to copy: `worker/jobs/backup.ts` (payload parsing plus `failureNotice`),
    `mailgun-sync-suppressions.ts`.
- `worker/runner.ts`:
  - `RUNNER_INTERVAL_MS 2000`, `PROGRESS_MIN_INTERVAL_MS 1000`;
  - `claimNextJob`: priority desc, then runAt, then id;
  - `runClaimedJob`: an unknown type fails and notifies "Run update.bat…"; a retry waits 1/5/15 min
    (`worker/backoff.ts`); an abort puts the job back in the queue without counting the try;
  - `resetOrphanedJobs` at start-up re-queues RUNNING jobs, so **handlers must be resumable and idempotent per item**
    (B6.9 "never pays twice");
  - `JobRunner`: one job at a time (§0.6).
- `worker/main.ts:139-153` `WorkerOptions {workerId?, registry?, logger?, transportFor?, mailgun?, now?, random?,
  fetchImpl?}`. The registry is built at `:193-195`. `runOnce()`/`tickOnce()` exist for tests (`:279, :291`).
- `worker/jobs/cleanup.ts:22-32`:
  - finished jobs are deleted after **30 days**, so `VerificationCheck.jobId` and `AiDraft.jobId` go stale. Monthly AI
    spend must come from `AiDraft.costUsd`, never from `Job.result`;
  - there's no clean-up rule for `WebsiteSnapshot.text` or `RobotsCache`.

### 5.4 Periodic tasks (`worker/periodic.ts`)
- `PeriodicTask {name, intervalMs, retryAfterMs, due?, enabled?, enqueue}`.
- `PERIODIC_TASKS` (`:79-127`): backup, cleanup, catch-up hourly, domain check every 6 h, warm-up hourly.
- `recordTaskSuccess(name)`; state lives in SystemState `task.<name>`; checked every 10 min.
- A "re-check unknowns after 24 h" sweep could be one task here, or a delayed `enqueueJob({runAt})`.

### 5.5 Notifications
- `src/server/notifications.ts`:
  - `createNotification(input, tx?)` (`:109`): type ≤100, title ≤200, body ≤1000; links through `safeAppPath`;
  - `activeOwnerId`, `notifyOwner(input, tx?)` (`:126`);
  - `notifyUsers(userIds, input, tx?)` (`:137`: active users only, deduped).
- `ai.draftsReady` and `verify.finished` are only named in the doc comment (`:31`). M4-DESIGN §5.1 row: "M5 —".
- `core/notification-types.ts`:
  - `POPUP_GROUP_TYPES` (`:20-25`): no ai/verify group;
  - `notificationFilterOf(type)` (`:61-65`) files anything not `reply.`/`campaign.`/outage/`email.unconfirmed` under
    "Sending and system".
- Throttled Owner notices: `shouldSendNotice(key, now, everyMs = 24 h)` (`server/state-typed.ts:61`), SystemState
  `notices`. Use it for "AI key refused / spend limit / verification credits" so they don't repeat.
- Don't use `worker/notify.ts` (a duplicate `notifyOwner` without link sanitising, used by the runner for task
  failures).

### 5.6 Activity, timeline, Activity page
- `server/activity.ts:8-34`: the list of types has no check or AI types. `logActivity(a, tx?)`, `logActivities(items, tx?)`.
- `components/activity/activity-filters.ts:25-32` `ACTIVITY_KIND_PREFIXES`:
  - companies = `company.`, `person.`, `list.`;
  - emails = `email.`, `reply.`, `campaign.`, `followups.`.
  - A new `ai.`/`verify.` prefix would show only under "Everything"; `person.checked` / `company.personalLine` fit
    "Companies & people".
- `company-panel/timeline-view.ts:21-25` `timelineCategory` (email./reply./else "change"), `detailFrom` (`:63-70`,
  data.snippet | text | line).

### 5.7 Mailgun client and errors (where `validateAddress` goes)
- `src/server/mailgun/client.ts`: `class MailgunClient` (`:331`), with plumbing `#once` / `#statusError` / `#call`
  (`:385-532`):
  - `CallSpec {method, path, query, body, endpoint, idempotent, retryNotFound?, allow?, signal?}`;
  - `redirect: "error"`; the key is checked against the target (`assertKeyMatchesTarget`);
  - MAX_RETRIES 3 and BACKOFF 1/4/15 s; 429 waits Retry-After (≤60 s).
  - A new `async validateAddress(address, {signal?})` = `this.#call({method:"GET", path:"/v4/address/validate",
    query:[["address", a]], endpoint:"GET /v4/address/validate", idempotent:true})`. It isn't domain-scoped, and the
    region host comes from the client.
  - Neighbours for style: `getMonthlyLimit()` (`:1088`) and `getSuppression()` (`:809`).
- `server/mailgun/types.ts`: add the response type there.
- `server/mailgun/errors.ts`:
  - `classifyStatus` (`:127-134`): 429 rate-limited, not-allowed, 401/403 auth, 402 **payment** (credits);
  - `MailgunError {kind, status, mailgunMessage, retryAfterMs, requestStarted}`;
  - `plainMailgunError` (`:183`).
- `server/mailgun/context.ts`: `getMailgunContext(opts)` (`:66-108`) → `{connected, domain, region, domainId, client,
  sendClient, fakeMode}`, or `{connected:false, reason: "practice-copy"|"no-domain"|"no-key"}`. It uses only
  `mailgun.apiKey`. `mailgunSecrets()` (`:127-136`) is the list for redaction.
- `server/mailgun/base-url.ts`:
  - `MAILGUN_HOSTS` (`:19`, the only file allowed to name them);
  - `isTestRun()`, `isFakeMode()`, `mailgunApiBase(region)`;
  - `assertKeyMatchesTarget` (a `key-fake-` key goes only to loopback).

### 5.8 Fake Mailgun (`tests/fake-mailgun/**`): where a validate handler goes
- `handlers/index.ts:20-72`:
  - `FakeRouteDef {method, pattern, handler, auth: "messages"|"api", domain?}` and the `ROUTES` table (match order).
    Add `{GET|POST, "/v4/address/validate", handlers/validate.ts, auth: "api"}` (no `domain`);
  - the pattern string is also the fault key: `fake.failNext("GET /v4/address/validate", {kind:"status", status: 429,
    …})`.
- `handlers/context.ts:38-59`: `FakeContext {world, switches, opts, now(), origin, region, req: ParsedRequest{query,
  form, json, …}}`, `Handler = (ctx) => HandlerResult`, and the helpers `json`, `field`, `formBool`.
- `state.ts`:
  - `FakeWorld` (`:187-205`) has no validation data. Add e.g. `validations: Map<address, result>` plus a default rule;
  - reset in `createWorld` (`:207`) and show it in `snapshot` (`:335`);
  - `FakeSwitches` (`:12-37`), `FakeMailgunOptions` (`:54-87`).
- `server.ts:49-77`: the `FakeMailgun` interface (`failNext`, `setSwitches`, `addSuppression`, …). Add
  `setValidation(address, result)`.
- `admin.ts:122-197`: CLI cases for manual checks.
- Test helper `tests/integration/helpers/mailgun.ts:25` `connectFakeMailgun({domain?, region?, fake?})` saves
  `mailgun.apiKey` only.

### 5.9 Usage and cost patterns
- There is no money code anywhere (no `costUsd` writer, no formatter).
- The closest pattern: `services/sending/usage.ts:13-17` "Nothing here is stored: the counters are counted from rows
  every time" (`getTodayCap`).
- Month boundaries in the office zone: `core/sending/capday.ts` `capDayOf(at, zone)`, `capDayBounds(day, zone)`,
  `FALLBACK_CAP_ZONE "Asia/Karachi"`, and Setting `sending.capDayTimeZone`.
- A "spent this month" sum over `AiDraft.costUsd` (and `VerificationCheck.costUsd`) would follow this. There's no index
  on `AiDraft.createdAt`, which is fine at this size.

### 5.10 Secret encryption (`src/server/secrets.ts`)
- `encryptSecret(name, plaintext)` / `decryptSecret(name, stored)`: `v1:iv:tag:ct`, AES-256-GCM, AAD = name.
- `setSecret(name, value, userId)` (trims, stores last4), `deleteSecret`, `getSecret` (throws on a bad key; see
  `readSecret` in `mailgun/context.ts:46-52` for the "unreadable" handling), `secretInfo` (UI-safe).
- Keys saved inside a transaction: `upsertSecret(tx, …)` in `services/mailgun/connect.ts:151-155`.
- There's no activity logging inside `setSecret`: callers log.

### 5.11 Owner-only settings pages and navigation
- `components/settings/settings-nav.tsx:22-37`: `EVERYONE` (profile, notifications, backups) and `OWNER_SETTINGS`
  (sending, domain, limits, deliverability, footer, team, system). **No AI entry.** The order is pinned by
  `tests/unit/setup-core/ui.test.ts:48-59`.
- `app/(app)/settings/layout.tsx` renders `SettingsNav isOwner`. Each page calls `requireOwner()` itself.
- Pattern: `settings/deliverability/page.tsx` (server component, `requireOwner`, `SettingsTitle`, Cards) and
  `settings/deliverability/actions.ts` (`"use server"`, `runAction`, `requireOwnerAction`, zod `parseInput`,
  `revalidatePath`).
- Key forms: `components/settings/sending/connection-form.tsx`, with `connectMailgunAction` / `forgetMailgunKeysAction`
  (`settings/sending/actions.ts:55, 78`) and `load.ts:336-355` (`secretInfo`, "key ending …last4").
- `tests/unit/security/auth-coverage.test.ts` fails the build when an exported action or route doesn't start with an
  auth call.

### 5.12 Bulk selection and starting work from Contacts
- `services/companies/bulk.ts`: `BULK_LIMIT 10_000`, `BULK_CHUNK 500`, `cleanIds(ids)`, `BulkLimitError`, `chunk()`.
- `app/(app)/contacts/actions.ts`: the bulk actions take `{ids: number[]}`. `selectAllMatchingAction` ticks a whole view.
- Starting something from the bar: `campaign-wizard/email-these-companies.tsx` (action → `router.push(res.data.href)`,
  with offline wording). Server Action bodies are limited to 2 MB (`next.config.ts:22`).

---

## 6. Schema (`prisma/schema.prisma`; migrations: init, last_contact_at, outbound_recipient_index, m3_mailgun, m4_sequences_replies)

| Model / enum | Exists | Obviously missing for M5 (schema change = STOP and report, CONVENTIONS) |
|---|---|---|
| `Person` | 4 check fields, `personalLineOverride` | a role/disposable flag or did-you-mean (could live in `VerificationCheck.raw/reasons`); the re-check bookkeeping (derivable from `VerificationCheck` history) |
| `VerificationCheck` | see §2.1 | FK/relation to Person; index on `jobId` or `personId` if the Verify step reads results by job; `isRole`/`isDisposable`/`didYouMean` columns (else JSON) |
| `CampaignRecipient` | `state RECHECK`, `exclusionReason`, `nextDueAt`, `holdReason`/`heldAt` (HELD only) | when the re-check is due (`recheckAt`), unless the sweep reads it from `VerificationCheck.checkedAt` |
| `Suppression` | `reason INVALID`, `source` string | nothing |
| `AiDraft` | see §3.1 | `createdById` / requester (the Job has it, but jobs are deleted after 30 days); the previous line for Undo; a link to the `WebsiteSnapshot`s used; an index for the queue list (`status, createdAt`) and for monthly spend (`createdAt`) |
| `WebsiteSnapshot` | see §3.1 | `contentType`, `bytes` (research); a clean-up rule |
| `RobotsCache` | host PK, status, body, fetchedAt | nothing obvious (a crawl-delay can be parsed from `body`) |
| `Company` | `personalLine*`, `website`, `domain`, `profileKey`, `instagram` | nothing for M5 basics |
| `Job` | `progressDone/Total`, `result`, `createdById` | nothing; results for the UI need `toPublicJob` changes, not schema |
| `Setting` / `SystemState` / `Secret` | JSON / CAS / encrypted | new keys only (prices, AI pause), no migration |
| `ImportSession/ImportRow` | per-row status and message | an import "kind" (round trip vs normal) can live in `options` JSON; no migration |
| Enums | `VerificationStatus`, `Risk`, `AiDraftStatus`, `SuppressionReason.INVALID`, `RecipientState.RECHECK` | nothing |

---

## 7. Packages (`package.json`, `.npmrc`)

| Package (PLAN B2) | Status |
|---|---|
| `@anthropic-ai/sdk` 0.128.0 | **not installed** |
| `undici` 8.11.0 | not a dependency. `node_modules/undici` 7.29.1 comes only through `shadcn` (`shadcn` → `@dotenvx/dotenvx` → undici). Node 24.18's global `fetch` bundles its own undici (7.28, research) |
| `cheerio` 1.2.0 | **not installed** |
| `robots-parser` 3.0.1 | **not installed** |
| `ipaddr.js` 2.5.0 | not a dependency. `node_modules/ipaddr.js` 1.9.1 comes only through `shadcn` → `@modelcontextprotocol/sdk` → express → proxy-addr. PLAN B2 lists it next to tldts, but it was never added |

- `.npmrc`: `save-exact=true`, `fund=false`, `audit=false`. npm on this PC is 11.16.0; Node is v24.18.0.
- `package.json` `allowScripts` (`:77-83`) allows install scripts only for better-sqlite3@12.11.1, esbuild@0.28.2,
  prisma@7.10.0, unrs-resolver@1.12.2 and @prisma/engines@7.10.0. A new package with an install script needs an entry.
- CONVENTIONS "Environment": never install or upgrade packages or edit package files unless the work package owns
  them; otherwise STOP and report.
- `zod` 4.6.5 is present. The SDK's optional peer is `zod ^3.25 || ^4`.
- The worker bundle keeps packages external (`scripts/build-worker.mjs:50`, `packages: "external"`), so new packages
  must be real dependencies.
- `next.config.ts` has no `serverExternalPackages` entry for them. Claude runs only in the worker (B6.12), but a web-side
  `countTokens` for the estimate would import the SDK into Next.

---

## 8. Tests that pin current behaviour M5 will change

| Test | What it pins | M5 change |
|---|---|---|
| `tests/integration/worker/m3-wiring.test.ts:91-107` | `JOB_REGISTRY` keys = every `JobType` except finishCheck, **verify.addresses, ai.draftLines** | remove them from the `Exclude<>` and add them to `expected` once registered |
| `tests/integration/worker/runner.test.ts:200-209, 299-307` | uses `verify.addresses` as the "unknown task type" (custom registry, so it keeps passing) | switch to a made-up type for clarity |
| `tests/unit/setup-core/ui.test.ts:48-59` | `OWNER_SETTINGS` exact list and order | add "AI" (A6: after Email footer, before Team) |
| `tests/unit/import/column-matching.test.ts:218-226` | `company_id` → "ignore" | becomes the `company_id` target (or stays ignore in a normal import) |
| `tests/integration/import/missing-emails-export.test.ts:55-63, 98-108` | `MISSING_EMAIL_COLUMNS` header and the empty fill columns | update if columns or the instruction change |
| `tests/integration/import/export-and-routes.test.ts:103, 253` | the Contacts export's first column `company_id` = `C-<id>` | keep (the re-import may rely on it) |
| `tests/unit/rules/eligibility.test.ts:110-156` | check rules: `not-checked`/`test-checker`/`check-too-old` in LIVE, none in DRY_RUN, test-list counts as checked before go-live, `check-unknown` **blocks** (`:152`), policy texts | update if the draft treats "needs a check" as tickable, or unknown as RECHECK instead of excluded |
| `tests/unit/rules/eligibility.test.ts:159-…, 254` | `checkDecision` table (VALID+MEDIUM → send), `stopReasonFor(check-undeliverable) = "invalid"` | keep; the mapper must fit it (§0.4) |
| `tests/unit/rules/default-people.test.ts:15`, `tests/integration/rules/eligibility.test.ts:40-58` | default pick = first VALID person | keep |
| `tests/integration/milestone4/end-to-end.test.ts:437-…`, `tests/integration/milestone3/end-to-end.test.ts` | live campaign to unchecked test-list mailboxes with go-live off | keep: the "counts as checked until go-live" exception must stay |
| `tests/integration/sequences/sending.test.ts:130-141` | RECHECK recipients' emails are never picked or counted as due | keep |
| `tests/unit/sequences-core/hold-reasons.test.ts:54` | RECHECK is not a held state | keep, or change if RECHECK joins the holds |
| `tests/unit/campaigns/format.test.ts:263`, `format-m4.test.ts:46`, `company-panel/emailed-text.test.ts:144` | RECHECK wording | keep |
| `tests/unit/company-panel/emailed-text.test.ts:471-474` | `personalLineSourceText` incl. "AI, approved by Sara on 3 Mar" | keep |
| `tests/integration/company-panel/company-panel.test.ts:185-204, 268-303` | a personal line from the panel is `source "manual"`; an address change clears the check ("…and cleared the address check") | keep |
| `tests/unit/core/app-screens.test.ts:56-60` | `ComingLater` for the Dashboard (M6) | keeps passing (don't delete `ComingLater`) |
| `tests/unit/mailgun-client/no-real-hosts.test.ts` | only `base-url.ts` names `mailgun.net` | keep; `validateAddress` must use the client. Copy the idea for `anthropic.com` |
| `tests/integration/mailgun-client/fake.test.ts:99-103` | unknown fake paths answer `404 page not found` | still true for other paths |

No test pins the Verify page text, the AI lines placeholder or the disabled bulk-bar and list-menu buttons.

---

## 9. Bugs and gaps noticed (existing code)
1. Unchecked people are untickable in TEST/LIVE after go-live, so the Verify step would have nothing to check (§0.2).
2. `check-unknown` excludes at launch and **stops** at send. Nothing ever writes RECHECK (§0.3, §2.5).
3. A research mapping that turns deliverable+medium into RISKY would block sendable addresses (§0.4).
4. `mailgunSecrets()` omits `verification.apiKey`. The runner passes no secrets to `describeJobError`, and `redactText`
   doesn't know Anthropic's key format (§0.5, §0.6).
5. The single-lane job runner means long M5 jobs delay the hourly catch-up, "Send me a test" and backups. A job can't
   queue its own continuation under its own dedupe key (§0.6).
6. `setCompanyPersonalLine` hard-codes source `"manual"`. There is no "ai" writer and no stored previous line for Undo
   (§3.2).
7. "Export for Claude" has no instruction or copy box. `company_id` is ignored on import, and a generic re-import can
   create duplicates or skip matched companies without adding people (§4).
8. `Suppression.INVALID` is never written. `stopRecipients` has no invalid reason. INVALID rows would be pushed to
   Mailgun's unsubscribes like any other (§2.8).
9. Jobs are deleted after 30 days while `VerificationCheck.jobId` and `AiDraft.jobId` point at them.
   `WebsiteSnapshot.text` has no clean-up (§5.3).
10. `components/campaign-wizard/coming-later-button.tsx` is unused. `bulk-bar.tsx` has its own copy (§1).
11. The sidebar's "AI lines" has no count (A6), and `Sidebar` takes no props (§1).
12. `/api/jobs/:id` treats only `mailgun.*` as Owner-only. Decide whether AI or verify tasks started by Members are fine
    to show (they should be).
13. `undici` and `ipaddr.js` in `node_modules` are shadcn's transitive copies (7.29.1, 1.9.1), not the planned versions
    (§7).
14. Haiku 4.5 retirement: the research says "not sooner than 2026-10-15", while PLAN A3 Q14 says late November (§3.4).
