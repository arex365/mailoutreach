# Build brief: Polygon Paradise Outreach

You are building a complete, production-quality outreach app for me (Arslan, owner of Polygon Paradise). Read this whole brief before writing any code. Everything under "Decisions already made" has been discussed and settled. Don't reopen those unless something is technically impossible; in that case tell me why and propose the closest alternative.

## How I want you to work

1. Read this file fully, then write `PLAN.md`: data model, screens, API routes, background jobs, folder structure, third-party APIs you'll call, and any open questions. Show me the plan and wait for my OK before building.
2. Build in the milestones listed near the end. After each milestone, run the type-check, linter and tests, start the app and check the new screens really work, then stop and tell me in plain language what to test. Wait for my OK before starting the next milestone.
3. Use current stable versions of every library. Check the official docs for Next.js, Prisma, Mailgun, Cloudflare Tunnel and the Anthropic API instead of relying on memory, because these APIs change.
4. I'm on Windows. Everything must install and run on Windows 10/11 with Node.js LTS: no Linux-only tools, no Docker requirement, no bash-only scripts.
5. Never send real email while building, except to my own test address when I ask. Build a "dry run" sending mode (logs emails instead of sending them) and use Mailgun's test mode where useful.
6. When something is ambiguous, ask me instead of guessing. Keep explanations simple; I'm a 3D artist, not a developer.

## Background

Polygon Paradise is a 3D studio. We make print-ready 3D models and custom files: character figurines, animals and creatures, busts and statues, delivered clean and watertight for printing. We do cold email outreach to companies that could use us: 3D printing services, large-format printing companies, figurine and collectible studios, and creators, mostly in Germany, Norway and worldwide.

Today I use a single-page tool (dark purple) with one tab per list, for example "German 3D Companies" (45), "Norway 3D Companies" (11), "Worldwide Directory" (195) and "Instagram Creators" (500). It has stat cards (Not contacted, Contacted, Replied, Hired), bulk "mark as" buttons, a template generator, and columns for priority, niche, members, est. revenue, platforms, status, last contact and notes. It works, but it's cluttered and hard to organise. The new app replaces it and must be much easier to use every day.

- Main website: https://www.polygonparadise.com
- Main email: contact@polygonparadise.com. This must NOT be used for cold sending.
  - **Owner decision 2026-09-27:** every outreach email shows From contact@polygonparadise.com (each sender's display name), sent through the Mailgun subdomain mail.polygonparadise.com, with each sender's own address on that subdomain as Reply-To ([SHARED-FROM-DESIGN.md](docs/dev/SHARED-FROM-DESIGN.md)). polygonparadise.com's MX stays with its mail provider.
  - **Owner decision 2026-09-27 (final):** the app sends through polygonparadise.com itself on Mailgun's Free plan; every email From contact@polygonparadise.com with each sender's display name, no Reply-To; replies go straight to contact@ and are marked in the app by hand (They replied); live follow-ups wait each day until someone has read contact@ (the inbox check) ([MAIN-DOMAIN-DESIGN.md](docs/dev/MAIN-DOMAIN-DESIGN.md)). The setup of the note above stays available as the full setup.
- Brand: orange #E2571E with black. The logo is a low-poly palm tree with a blocky "POLYGON PARADISE" wordmark.
- Business address (default for the email footer): 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan
- I'm in Pakistan (PKT, UTC+5). Show times in each user's own time zone.

## Decisions already made

- A Next.js web app (App Router, TypeScript) running on my Windows PC.
- A small team: me plus a few people. Some are in my office on the same network, some work remotely. Remote access goes through Cloudflare Tunnel.
- Emails are sent through Mailgun's HTTP API from a separate sending domain, not polygonparadise.com. Target: 500–1000 cold emails per day once the domain is warmed up.
  - **Owner decision 2026-09-27:** every outreach email shows From contact@polygonparadise.com (each sender's display name), sent through the Mailgun subdomain mail.polygonparadise.com, with each sender's own address on that subdomain as Reply-To ([SHARED-FROM-DESIGN.md](docs/dev/SHARED-FROM-DESIGN.md)). polygonparadise.com's MX stays with its mail provider.
  - **Owner decision 2026-09-27 (final):** the app sends through polygonparadise.com itself on Mailgun's Free plan; every email From contact@polygonparadise.com with each sender's display name, no Reply-To; replies go straight to contact@ and are marked in the app by hand (They replied); live follow-ups wait each day until someone has read contact@ (the inbox check) ([MAIN-DOMAIN-DESIGN.md](docs/dev/MAIN-DOMAIN-DESIGN.md)). On the Free plan the app sends at most 100 emails a day (90 campaign emails).
- Every address is verified with a paid verification service before it is emailed.
- Each team member sends as themselves.
- Emails are in English only, as plain text.
- Replies are read and answered by the sender in their own normal inbox. The app detects replies and sends notifications, but has no inbox of its own.
- Companies can have several people. I choose which person or people to email each time.
- Follow-ups: up to 3 per campaign, with the number and timing set per campaign. They are sent in the same email thread.
- If anyone on the team has emailed a company in the last 30 days, nobody else can email that company. The app shows who emailed it and when.
- Personal lines can be drafted by Claude, but a person always reviews them before use.
- I find missing company emails myself using Claude, outside the app. The app should make that round trip easy.
- You choose the visual design, within the brand direction below.

## Architecture

- Next.js (App Router) + TypeScript + Tailwind CSS.
- Prisma + SQLite (WAL mode): a single database file in the project folder. Keep the schema portable to Postgres.
- A separate background worker process (Node, TypeScript) runs the sending queue, follow-ups, verification jobs, AI jobs, Mailgun reconciliation and backups. It uses a database-backed job table, not Redis. Sending must never depend on a browser tab being open.
- One script starts both the web app (production mode: `next build` + `next start`) and the worker. Provide a `start.bat` I can double-click, plus instructions to run both automatically when Windows starts (PM2 or NSSM, whichever is most reliable on Windows; explain it simply). The app must be reachable on the local network so office staff can open it at http://<my-pc-ip>:<port>.
- Cloudflare Tunnel (cloudflared) exposes the app at a public HTTPS hostname for remote staff and for Mailgun webhooks. Write step-by-step setup instructions for me. Recommend Cloudflare Access in front of the app pages, but the webhook routes must bypass it, because Mailgun can't log in.
- The app has its own login regardless of Cloudflare. Every page and API route requires a signed-in user, except the webhook endpoints (protected by Mailgun signature verification) and a health check. Hash passwords with argon2 or bcrypt, use secure httpOnly cookies, and rate-limit login attempts.
- Store secrets (Mailgun API key, webhook signing key, verification key, Anthropic API key) in the database, encrypted with a key from `.env`. Never send them back to the browser after they are saved.
- Everything must survive the PC being switched off. When the worker starts, it first catches up on anything missed (Mailgun events, suppressions, stored inbound messages), then resumes sending.

## Features

### 1. Team and accounts

- Two roles: Owner (me) and Member. The Owner manages settings, API keys, the sending domain, limits and users (invite, deactivate, reset password). Members can do everything else.
- Each user has a profile: name, sender display name, sender address on the sending domain (e.g. ali@<sending-domain>), the real inbox their replies are forwarded to, signature and time zone.
  - **Owner decision 2026-09-27:** every outreach email shows From contact@polygonparadise.com (each sender's display name), sent through the Mailgun subdomain mail.polygonparadise.com, with each sender's own address on that subdomain as Reply-To ([SHARED-FROM-DESIGN.md](docs/dev/SHARED-FROM-DESIGN.md)). polygonparadise.com's MX stays with its mail provider. The sender address above is that Reply-To, called "Reply address" on screen.
  - **Owner decision 2026-09-27 (final):** the app sends through polygonparadise.com itself on Mailgun's Free plan; every email From contact@polygonparadise.com with each sender's display name, no Reply-To; replies go straight to contact@ and are marked in the app by hand (They replied); live follow-ups wait each day until someone has read contact@ (the inbox check) ([MAIN-DOMAIN-DESIGN.md](docs/dev/MAIN-DOMAIN-DESIGN.md)). In that setup nobody has a sender address on the sending domain; the profile's inbox is the one for test emails.
- Every change (status, notes, emails sent) is recorded with who made it.

### 2. Companies, people and lists

- Company fields: name, website, domain, country, time zone (set from the country automatically, editable), niche, tags, priority (High / Normal / Low), status, notes, personal line, custom fields, the lists it belongs to, and "first contacted by" (set automatically).
- People (several per company): name, role/title, email, verification result and date, personal line override, unsubscribed/bounced/complained flags, notes. A generic address like info@ is simply a person called "General inbox".
- Company statuses: Not contacted, Contacted, Replied, Client, Not interested, Do not contact. Companies marked Client, Not interested or Do not contact are never included in campaigns. People who unsubscribed, bounced or complained are never emailed again.
- Lists replace my old tabs. A company can be in several lists. There is also an "All companies" view.
- The contacts screen needs:
  - a list sidebar and status tabs with counts,
  - search,
  - filters: list, status, tag, country, niche, priority, emailed / never emailed, has email / missing email, first contacted by,
  - sorting,
  - pagination or virtual scrolling that stays fast with 10,000+ companies.
- Bulk actions apply to selected rows only: set status, add to or remove from a list, tag, set priority, delete, and start a campaign with the selection.
- The company detail panel shows all fields, the people with their email status, the personal line, notes, and a full timeline: emails sent (with step and sender), replies, status changes and notes.
- Fields from my old tool (members/followers, est. revenue, platforms) are kept as custom fields and only shown when filled in.

### 3. Who has been emailed (important)

- Every company and person shows whether they've been emailed, and if so:
  - the last emailed date, who sent it, which campaign and which step,
  - the current sequence state, for example "waiting for follow-up 2 on 12 Oct", "finished" or "stopped because they replied".
- The 30-day team rule: if anyone emailed a company in the last 30 days, it can't be added to another campaign. The UI says "Emailed by Ali 12 days ago" rather than silently dropping it. The number of days is a setting.
- The same address is never emailed twice for the same step, even if it appears in two lists or campaigns.
- Imports flag rows that match companies or people who were already emailed.

### 4. Import and export

- Import CSV and XLSX/XLS files, or rows pasted from Excel or Google Sheets.
- Match columns automatically (company, name, email, website, instagram, country, niche, tags, notes, personal line, role, and so on) and let me correct the mapping. Show a preview of the first rows. Keep unmatched columns as custom fields that can be used as template variables.
- A file can have one row per person. Group people into companies by company name and/or website domain.
- Import options:
  - destination list (new or existing),
  - starting status,
  - a tag for the whole import,
  - duplicate handling: skip or update existing.
- Map status labels from my old tool: "Not Contacted" → Not contacted, "Contacted" → Contacted, "Replied" → Replied, "Hired" → Client, "Rejected" → Not interested. Keep the old last-contacted dates.
- Show a clear result summary: created, updated, skipped duplicates, invalid emails, empty rows.
- Any view can be exported to CSV.
- Missing-emails round trip:
  - A "Missing email" view has a button that exports those companies with a stable company ID, name, website and country.
  - The same button copies a ready-to-paste instruction for Claude, asking it to find the best contact email for each company and return a CSV with the same IDs.
  - Re-importing that CSV fills in the emails on the right companies without creating duplicates.

### 5. Templates and personalisation

- Templates are plain text: no HTML design, no images. One template is starred as the master, and new campaigns start from it. Templates can be created, duplicated, renamed and deleted (at least one must remain).
- Variables are inserted with one click: {{first_name}}, {{contact_name}}, {{company}}, {{website}}, {{country}}, {{niche}}, {{personal_line}}, {{sender_name}}, {{sender_signature}}, {{portfolio_url}}, plus any custom field from imports.
- Fallbacks: {{first_name|there}} uses "there" when the first name is empty. Variables that are empty and have no fallback trigger a warning before sending.
- Variations: {Hi|Hello|Hey} picks one option per recipient. The choice is stable for that recipient, so the preview matches what is sent.
- Live preview against real contacts, rendered for the chosen sender.
- Write a good default master template and default follow-up templates for our business: short, friendly and specific, no hype, ending with one clear question.

### 6. AI personal lines

- I select companies, or a whole list, and choose "Draft personal lines".
- The worker fetches each company's website: the homepage plus one relevant page such as About, Portfolio or Products, with timeouts and polite rate limits. It extracts the readable text.
- Claude is asked for one specific, genuine sentence (about 25 words at most) about their work that a 3D modelling studio would notice. No generic flattery and no invented facts. If there isn't enough information, it returns nothing rather than a vague line.
- Drafts go into a review queue where I can approve, edit then approve, reject or regenerate. Only approved lines are used in emails. Show progress, and an estimated cost before starting.
- The Anthropic API key is set in Settings (Owner only). The model is configurable there too: default `claude-haiku-4-5-20251001` for low cost, with `claude-sonnet-5` as a higher-quality option. Confirm the model IDs at https://docs.claude.com.
- Skip Instagram pages; they usually can't be read without logging in.

### 7. Campaigns

The campaign wizard has six steps:

1. **Audience.** Pick companies by list, tag, status, country or niche, or start from a selection made on the contacts screen. For each company, I choose which person or people get the email. Pre-select the first person with a verified email, and warn when more than one person at the same company is selected. Show clearly who is excluded and why: no email, invalid email, unsubscribed, Do not contact, emailed by a teammate in the last 30 days, and so on.
2. **Sender.** Which team member sends the campaign (default: the current user).
3. **Message and sequence.**
   - The first email starts from the master template (or another template). Edits apply to this campaign only, with an option to save them back to the template.
   - Add 0–3 follow-ups, each with its own text and a rule: "send N days after the previous step if there's no reply".
   - Follow-ups are sent as replies in the same thread: same sender, "Re: <original subject>", and correct In-Reply-To/References headers using the stored Message-ID of the previous email.
4. **Verify.** Unverified addresses, and those verified more than 90 days ago, are verified now. Show the count and estimated cost first. Invalid addresses are removed; risky and catch-all addresses follow the verification setting (see section 8).
5. **Review.** Step through every recipient's actual emails, all steps included. For each recipient I can:
   - edit the email for that person only,
   - edit their personal line (saved on the company),
   - include or exclude them,
   - see warnings about missing details.
   
   I can filter the list to "missing details" or "edited", and send a test of any recipient's email to my own address.
6. **Schedule.** Start now or on a chosen date. The engine sends within each recipient's working hours.

The campaign screen shows:
- progress per step,
- counts: sent, delivered, bounced, replied, unsubscribed, complained,
- a timeline for each recipient,
- pause and resume, skip or retry individual recipients, and edit any email that hasn't been sent yet.

Follow-ups stop automatically for a person when:
- they reply, unsubscribe, bounce or complain,
- the company is set to Replied, Client, Not interested or Do not contact,
- anyone else at that company replies.

### 8. Sending engine and deliverability safeguards

- **Sending.** All sending happens in the worker through Mailgun's HTTP API, with the region (EU or US) configurable.
- **Email format.**
  - Plain text plus a minimal HTML version (paragraphs and links only).
  - No attachments, no images, no tracking pixel, no link rewriting. Open and click tracking must stay off.
- **Footer.** Every email ends with a short line showing the company name and address, plus an unsubscribe line. Use Mailgun's own unsubscribe handling (unsubscribe link plus List-Unsubscribe and one-click headers) so it works even when my PC is off, and sync unsubscribes back into the app.
- **Sending window.** Monday to Friday, 9:00–17:00 in the recipient's time zone by default (configurable). Emails are spread evenly across the window with random gaps, never in bursts.
- **Caps.** One daily cap for the whole sending domain, shared by all senders, plus an optional cap per sender.
- **Warm-up.** The app enforces a warm-up ramp for a new domain:
  - it starts at about 50 emails a day and rises gradually over about 4 weeks towards the maximum I set (default 1000),
  - it only rises while bounce and complaint rates are healthy,
  - the Owner can see today's cap and the schedule; overriding it requires confirmation.
- **Verification policy.**
  - Never email addresses that verification marks as undeliverable or do-not-send.
  - Risky and catch-all addresses are controlled by a setting. Default: allow low-risk catch-all addresses, block high-risk ones.
  - Use Mailgun's validation API by default, behind an adapter so ZeroBounce or NeverBounce could be swapped in.
  - The price per verification is a setting, used for cost estimates.
- **Health auto-pause.** Track bounce and complaint rates over recent sends. Pause all sending if either:
  - bounces exceed 3% of the last 200 sends, or
  - complaints exceed 0.1% of the last 1,000 sends.
  
  When this happens, notify the Owner and show why. Only the Owner can resume. The thresholds are configurable.
- **Pause all sending.** A global switch for the Owner.
- **Hard rules.**
  - Never email the same address twice for the same campaign step.
  - Never email suppressed people.
  - A crash or restart must never cause duplicate sends: claim each send atomically, mark in-progress sends, and check them against Mailgun on restart.

### 9. Mailgun webhooks and reply detection

- **Owner decision 2026-09-27 (final):** the app sends through polygonparadise.com itself on Mailgun's Free plan; every email From contact@polygonparadise.com with each sender's display name, no Reply-To; replies go straight to contact@ and are marked in the app by hand (They replied); live follow-ups wait each day until someone has read contact@ (the inbox check). The reply detection of this chapter applies only when replies go through the app ([MAIN-DOMAIN-DESIGN.md](docs/dev/MAIN-DOMAIN-DESIGN.md)).
- **Event webhooks.** Handle delivered, permanent failure (bounce), temporary failure, complained and unsubscribed.
  - Verify every webhook signature: HMAC with the webhook signing key, a timestamp freshness check, and replay protection on the token.
  - Update person, company and campaign state, and the suppression lists.
- **Catch-up.** When the worker starts, and every hour after that, compare with Mailgun's events and suppression lists (bounces, complaints, unsubscribes), in case webhooks were missed while the PC was off.
- **Replies.**
  - Each sender's reply address is on the sending domain.
  - Set up, and document, a Mailgun inbound route per sender. It forwards each reply to that sender's real inbox and also notifies the app, storing the message so it can be fetched later if the PC was off.
  - Match each reply to the email it answers using In-Reply-To/References, falling back to the reply's from-address.
- **On a real reply:**
  - mark the person and the company as Replied,
  - stop follow-ups for the whole company,
  - add the reply (subject and first lines) to the timeline,
  - notify the sender.
- **Auto-replies.** Out-of-office messages and auto-responders are logged as auto-replies and don't count as replies. Detect them using headers such as Auto-Submitted and X-Autoreply, plus common subject lines.

### 10. Notifications

- An in-app notification bell with an unread count for each user. It covers:
  - a new reply (to the sender),
  - a campaign finished,
  - sending paused by the health check or the daily cap (to the Owner),
  - AI drafts ready to review,
  - verification finished.
- Optional browser desktop notifications for new replies.

### 11. Dashboard

- First, what needs attention: replies waiting for an answer (per user), AI lines waiting for review, paused campaigns, and companies missing emails.
- Then:
  - pipeline counts by status and the reply rate,
  - emails sent today versus today's cap, and warm-up progress,
  - domain health: bounce and complaint rates, with the thresholds shown,
  - active campaigns with progress,
  - recent team activity.

### 12. Settings

- **Owner only:**
  - sending domain, Mailgun region and API keys (write-only),
  - a DNS setup checklist showing SPF, DKIM, DMARC and MX status, read from Mailgun's domain verification,
  - daily cap, warm-up and sending window,
  - verification policy and price, and health thresholds,
  - the 30-day team rule length,
  - footer text and address, portfolio URL, AI model,
  - users.
- **Everyone:** their own sender profile, signature, time zone and notification preferences.

### 13. Backups

- Back up the database automatically every day to a backups folder, keeping the last 14. Add a manual "Back up now" button. Explain how to restore in the README.

## Deliberately left out (do not build)

- Open and click tracking.
- Attachments in outreach emails.
- Automated Instagram DMs (Instagram bans accounts for this). Instagram handles are stored as an ordinary field.
- A/B testing.
- An inbox inside the app.
- Global "apply to all pages" style actions. Bulk actions only affect selected rows.
- Numeric priority bars. Use High / Normal / Low.
- Designed HTML newsletters.

## Design direction

You choose the design, within these constraints:

- Use the brand: orange #E2571E with black, and a simple low-poly palm mark. Orange means "primary action" or "selected"; don't use it as decoration.
- Calm, organised and quick to scan. I'll use this for hours with thousands of rows. Not neon, not purple, no glowing gradients.
- Sentence case everywhere; no ALL CAPS labels.
- Plain, friendly wording from the user's point of view ("Email these companies", not "Create dispatch job"). Empty screens tell me what to do next. Error messages say what went wrong and how to fix it.
- Keyboard-friendly, with visible focus and good contrast. It must work well on a laptop screen and be usable on a phone for checking replies and stats.
- A dark theme by default is fine, as long as it's easy to read.

## Milestones

1. **Foundation:** project setup, login and users, companies/people/lists, the contacts screen, the company panel, import/export and start scripts. Seed a small demo dataset.
2. **Templates and campaigns:** the template editor with variables, fallbacks, variations and preview; the campaign wizard; the review screen; the worker with dry-run sending.
3. **Mailgun:**
   - real sending through the API, test emails,
   - sending window, daily cap, warm-up,
   - webhooks with signature checks, suppressions, catch-up, health auto-pause.
4. **Sequences and replies:**
   - follow-ups in the same thread, with the stop rules,
   - inbound reply detection and auto-reply handling,
   - the 30-day team rule, "who has been emailed" everywhere, notifications.
5. **Verification and AI:** the verification adapter and policy, cost estimates, AI personal lines with the review queue, and the missing-emails round trip.
6. **Finish:** dashboard, settings polish, backups, README and setup guides, final testing.

## Testing and definition of done

- Automated tests for:
  - template rendering: variables, fallbacks, stable variations, missing-detail detection,
  - import column matching and duplicate handling,
  - the 30-day rule,
  - follow-up scheduling and stop rules,
  - sending-window and cap calculations, the warm-up ramp, and health auto-pause,
  - webhook signature verification,
  - reply matching and auto-reply detection.
- Type-check, lint and tests all pass, and the app builds in production mode on Windows.
- An end-to-end check in dry-run mode:
  1. import a CSV,
  2. draft and approve personal lines (the AI call can be mocked),
  3. create a campaign with 2 follow-ups, review it and send it,
  4. simulate a bounce, an unsubscribe and a reply using signed test webhooks,
  5. confirm that statuses, stop rules, notifications and dashboard numbers are all correct.
- A README written for a non-developer, covering:
  - installing and the first run,
  - Mailgun domain and DNS setup (SPF, DKIM, DMARC, and MX for replies), and the inbound routes,
  - in Mailgun, turning off open and click tracking and turning on unsubscribe handling,
  - Cloudflare Tunnel setup, with optional Cloudflare Access,
  - adding team members,
  - keeping the PC awake during sending hours (European working hours are afternoon and evening in Pakistan),
  - backups and restoring from one.
