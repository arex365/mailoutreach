# Polygon Paradise Outreach: build plan

Build plan, kept for reference. The README is the manual; where they differ, the README and the M3–M6 design files win.

**Note, 2026-09-27 (owner decision):** every outreach email now shows From contact@polygonparadise.com (with each sender's display name), sent through the Mailgun subdomain mail.polygonparadise.com, with each sender's own address on that subdomain as Reply-To. This replaces the separate sending domain this plan recommends below. The design is [docs/dev/SHARED-FROM-DESIGN.md](docs/dev/SHARED-FROM-DESIGN.md).

**Note, 2026-09-28 (owner decision of 2026-09-27, final):** the app sends through polygonparadise.com itself on Mailgun's Free plan; every email shows From contact@polygonparadise.com with each sender's display name, with no Reply-To; replies go straight to contact@ and are marked in the app by hand (They replied); live follow-ups wait each day until someone has read contact@ (the inbox check). The setup of the note above stays available as the full setup. The design is [docs/dev/MAIN-DOMAIN-DESIGN.md](docs/dev/MAIN-DOMAIN-DESIGN.md).

Version 2, 23 September 2026. Nothing has been built yet. I start Milestone 1 when you say OK.

**How to read this.** Part A (A1–A10) is written for you; please read all of it. Part B is the technical appendix I build from; you don't need to read it.

**How to reply.** Answer the questions in A3. Something like this is a perfectly good answer: "Q1, Q4, Q5, Q7, Q9, Q13, Q14: your recommendations are fine. Q2: (a), and yes to a fixed address. Q3: the files are in the folder. Q6: … Q8: (a), name … Q10: addresses … Q11: (c), these emails, weekly. Q12: …"

**How this plan was checked.** First, every service it relies on was checked against its official documentation as of this week: Next.js, Prisma, Mailgun, Cloudflare, the Claude API, Windows and the libraries. Then five independent reviewers compared the plan with your brief line by line, looking for gaps, wrong facts, design flaws, security holes and unclear wording. Their findings have been worked in.

---

# Part A: for you

## A1. The short version

**What you get**

- **A web app on your PC** that replaces the old purple tool.
  - Office staff open `http://<your-PC-address>:3000`.
  - Remote staff and phones open a secure address such as `https://outreach.<your-domain>`, which reaches your PC through Cloudflare.
- **Three programs that run in the background on your PC.** Windows starts them by itself when the PC boots, even before anyone logs in, and restarts them if they crash.
  - **The app:** the screens.
  - **The background sender:** sends emails and follow-ups, checks addresses, drafts AI lines, notices replies, catches up after the PC was off, and makes backups. It never needs a browser tab to be open.
  - **Cloudflare's connector:** lets remote staff and Mailgun reach the app safely, without opening anything on your router.
- **One data file.** All data lives in `data\app.db` and is backed up every day.
- **A practice copy** (`start-demo.bat`) filled with made-up companies. You can try everything there, including replies and bounces, without touching your real data or sending anything.

**What a normal day looks like**

1. **Contacts.** Your lists sit on the left, with status tabs, search and filters. Every row shows whether the company was emailed, when, by whom, and what happens next, for example "Waiting for follow-up 2 on 12 Oct".
2. **Starting a campaign.** Tick some companies and click **Email these companies**. A 6-step wizard picks the people, the sender and the message with follow-ups. It checks the addresses, lets you read every single email, and schedules it.
3. **Sending.** The background sender sends slowly: only in each recipient's working hours, with random gaps, and within the daily limit.
4. **Replies.** Replies arrive in the sender's normal inbox as usual. The app notices each one, marks the company as Replied, stops its follow-ups and rings the notification bell.

**What it costs to run** (my estimates; please check the prices when you sign up)

| Item | Recommended | Rough cost |
|---|---|---|
| Mailgun (sends the emails) | Foundation plan: 50,000 emails/month, 5,000 address checks/month included (wrong: Foundation includes none; see the README's costs) | about $35/month |
| Extra address checks | Beyond the included 5,000 (wrong: Foundation includes none; see the README's costs) | about $1.20 per 100 |
| Sending domain | A new domain (Q8) | about $10–15/year |
| Cloudflare (remote access) | Free plan | $0 (Access asks for a card but doesn't charge for up to 50 people) |
| Claude (AI personal lines) | Haiku 4.5 | about $1.60 per 300 companies (Sonnet 5: about $4–5 at its low-effort setting) |

## A2. Start these this week (they take days, not minutes)

Items 1 and 2 are needed before Milestone 1. Items 3–5 are only needed for Milestone 3 (real sending), but please start them now, because they involve waiting for approvals or DNS changes (up to 48 hours).

1. **Update Node.js** to version 24.21.0: nodejs.org → Windows installer, "LTS". It takes 5 minutes and includes security fixes.
2. **Export your old tool's tabs** (Q3).
3. **Decide the sending domain** (Q8), and buy it if it's a new one.
4. **Open a Mailgun account** on the Foundation plan (Q9) and fill in their business verification form. New accounts are held to low limits until it's approved. You choose the region (EU) later, when you add the sending domain with the Milestone 3 guide.
5. **Decide the app's web address** (Q11). If your domain isn't on Cloudflare yet, moving it takes a day or two.

You'll get full step-by-step guides for Mailgun, DNS and Cloudflare with Milestone 3.

## A3. Decisions I need from you

Most questions have my recommendation. Q3, Q6, Q10 and Q12 need facts only you have, and Q2, Q8 and Q11 each end with a small factual question.

### Before I start

**Q1. Mailgun and cold email.**
- Mailgun's rules say marketing email needs the recipient's prior consent, and they forbid scraped lists. Cold outreach can therefore get a Mailgun account limited or closed (see A4, point 1).
- Your brief already chose Mailgun, and I'm not reopening that. I only need you to confirm you know the risk.
- *My recommendation: go ahead with Mailgun.* The sending code sits behind an "adapter", so another provider could be added later. Replies, unsubscribes and bounce handling are Mailgun-specific, though, and would need several days of rework. The app also keeps bounces and complaints low, which is the best protection.

**Q2. Office access without encryption.**
- Your brief asks for `http://<PC-address>:3000` in the office. That works, but on plain http:
  - passwords travel unencrypted over the office Wi-Fi;
  - browsers block desktop notifications and one-click copying;
  - the login cookie can't carry the "secure" flag your brief asks for (on the https address it always does).
- Your options: (a) keep the office address as briefed; (b) office staff also use the secure https address.
- *My recommendation: (a).* Anyone can still use the https address when they want notifications.
- Also: can your router give this PC a fixed local address (a "DHCP reservation")? Otherwise the office address may change after a router restart.

**Q3. Your old data.**
- Please export each tab (German 3D Companies, Norway 3D Companies, Worldwide Directory, Instagram Creators) as CSV or Excel and put the files in this folder.
- I'll tune the import to your real columns and test with them. Nothing is sent anywhere.

**Q4. Old "last contacted" dates.**
- Should the dates from your old tool count toward the 30-day rule? If yes, "Contacted in the old tool 12 days ago" blocks the company exactly as an email from the app would.
- *My recommendation: yes.*

### Before Milestone 2

**Q5. The same person in a later campaign.**
- Your brief says an address is never emailed twice "for the same step" (the same email in the sequence: the first email, follow-up 1, and so on), even if it appears in two lists or campaigns. It also has the 30-day rule.
- I read the two together like this: within one campaign, nobody ever gets the same email twice. Once 30 days have passed since anyone emailed the company, it can join a new campaign and get a new first email.
- The strict reading would be: nobody ever gets a second first email, even a year later.
- *My recommendation: my reading.*

**Q6. The default emails (A7).** Please read them and tell me what to change. Also:
- Which link should `{{portfolio_url}}` use: the homepage, or a specific portfolio page?
- Please confirm these are true before they go out: clients can start with a single model; you'll send examples and prices on request.
- What do you offer creators (the Instagram list)? I've drafted a separate, shorter sequence for them.

**Q7. Replies waiting for an answer.**
- The app can't see your inbox. So a reply stays on the "waiting for an answer" list until its sender clicks **Answered** or **No answer needed**. The list is on the Notifications page from Milestone 4, and on the dashboard from Milestone 6. Is that OK?
- *My recommendation: yes.*

### Before Milestone 3 (see A2: start early)

**Q8. The sending domain.** Two options:
- **(a) a separate new domain**, for example a variant of your name (about $10–15/year). If cold emails ever draw complaints, polygonparadise.com and contact@ stay untouched.
- **(b) a subdomain** such as `mail.polygonparadise.com`. Mailgun recommends this and it costs nothing, but its reputation is tied to your main domain.

The app will refuse `polygonparadise.com` itself. *My recommendation: (a)*, because your brief asks for a separate domain and cold outreach is riskier than normal email. Which name would you like?

**Q9. The Mailgun account.**
- Plan: Foundation (about $35/month; fits 1,000 emails a day; 5,000 address checks included) or Scale (about $90/month; keeps a month of history instead of 5 days).
- Region: EU or US. You choose it when you add the sending domain, and it can't be changed for that domain later.
- *My recommendation: Foundation, EU.*

**Q10. Your test addresses.**
1. **Your reply inbox:** where replies to your emails and "Send me a test" should arrive. It goes into your profile.
2. **Two or three mailboxes that are not your reply inbox**, ideally one Gmail and one Outlook.com. They receive the test campaigns in Milestones 3 and 4, so you can reply from them. Gmail hides emails sent to and from the same address, which is why they must be different.
- Until you switch on "Go live" in Milestone 6, the app will only ever send real email to the addresses on this test list.

**Q11. The app's web address.** Three options:
- (a) your domain is already on Cloudflare;
- (b) move polygonparadise.com's DNS to Cloudflare. I'll give you a checklist to compare the records first, so your website and contact@ email keep working;
- (c) buy a cheap separate domain just for the app (about $10/year). Don't use the sending domain from Q8 for this: keep cold email and the app apart.

*My recommendation: whichever is easiest for you; (c) if unsure.*

Also, **Cloudflare Access**: staff type a code that Cloudflare emails them before they see the app's own login. *My recommendation: yes.* It's free for up to 50 people and keeps strangers away from the login page. If yes: whose email addresses should be allowed, and how often should people re-enter a code (daily, weekly or monthly)?

**Q12. Keeping the PC on.** Emails only go out while the PC is on:
- European recipients need it on from about 11:00 to 23:00 Pakistan time on weekdays.
- US East Coast recipients: about 18:00 to 03:00.
- Australian recipients: about 03:00 to 12:00.

Emails for any region simply wait while the PC is off.
- Can the PC stay on and plugged in 24/7? If not, which regions can wait?
- May the setup script change these laptop settings? Each step asks first:
  - never sleep or hibernate while plugged in;
  - closing the lid does nothing;
  - the office Wi-Fi is marked "Private". Is "HOME-Ground 2" the office network?

### Before Milestone 5

**Q13. Which checked addresses to email.**
- Some mail servers accept every address, so the checker can't tell whether the person really exists. These are called "catch-all" addresses, and Mailgun rates each one low, medium or high risk.
- Sometimes the checker gets no answer at all ("unknown").
- *My recommendation:*
  - email catch-all addresses only when they're low risk;
  - skip medium-risk catch-all addresses. Your brief only covers low risk (allow) and high risk (block), so this one is my choice;
  - skip addresses the checker calls deliverable but high risk;
  - hold "unknown" addresses and re-check them the next day. If they pass, they're emailed in the same campaign;
  - never email addresses marked undeliverable.
- In the app, catch-all addresses show as "Can't confirm".

**Q14. AI lines.**
1. Default model: **Claude Haiku 4.5** (about $1.60 per 300 companies) or **Claude Sonnet 5** (about $4–5; better at spotting a genuinely specific detail). Anthropic hasn't announced a retirement date for Haiku 4.5. The earliest it could happen is late November 2026, and switching models in the app takes one click.
2. A monthly spending limit for AI drafting, for example $20.
3. Should lines only describe the company's own work, or also hint at the link to your studio?

*My recommendation: Haiku 4.5; $20 a month; describe their work only and let the email make the link.*

## A4. What I found that affects you

1. **Mailgun's usage policy (Q1).**
   - It asks for prior consent for marketing email and bans scraped lists, so cold outreach carries a risk of account suspension.
   - Mailgun's own complaint limit is 0.08%, slightly stricter than your 0.1% default. The app shows Mailgun's limits next to yours.
2. **You need Mailgun's Foundation plan or higher.** 500–1,000 emails a day comes to 11,000–22,000 a month, more than the Basic plan's 10,000.
3. **How long Mailgun remembers things, and what happens if the PC is off.**
   - **Bounces, unsubscribes and complaints are never missed.** Mailgun keeps these lists permanently, and the app re-reads them.
   - **Replies always reach the sender's inbox straight away**, whether the PC is on or off.
   - **The app can notice a reply** that arrived while the PC was off for up to about 5 days (on Foundation). It can only show the reply's first lines if the PC is back within 1 day.
   - **If the PC was off for more than 5 days**, the app can't be sure it saw every reply. It then holds every follow-up that came due and asks each sender to check their inbox first ("I've checked my inbox: continue my follow-ups"). First emails carry on normally.
4. **Mailgun can't guard against sending the same email twice** (for example after a crash). The app does this itself.
5. **Unsubscribe links and forwarded replies may clash.**
   - Your brief asks for Mailgun's own unsubscribe handling, and for replies to be forwarded to each sender's inbox.
   - Mailgun's docs warn that its unsubscribe feature can alter forwarded replies in a way that makes Gmail or Outlook treat them as spam.
   - In Milestone 3 we test real replies before live sending can be switched on.
   - If the standard setup fails, the likely fix is a slightly different reply address, such as `ali@reply.<sending-domain>`. That needs your OK, and I'll ask if it comes to that.
6. **Mailgun charges for its "test mode"**, so almost all testing uses the app's own dry run and the practice copy.
7. **Claude.** Both model names in your brief are valid. Haiku 4.5 has no announced retirement date; the earliest possible is late November 2026 (Q14).
8. **Cloudflare's free plan** needs your domain's DNS to be managed by Cloudflare (Q11). Cloudflare Access is free for up to 50 people but asks for a payment card at sign-up.
9. **Your PC is a laptop and needs a few settings changed (Q12):**
   - it hibernates after 3 hours on power;
   - closing the lid sends it to sleep;
   - its Wi-Fi is marked "Public", which blocks office access;
   - two old Windows firewall rules let Node.js programs accept connections even on public Wi-Fi. The setup script switches those off.
10. **Background services.** Windows' own password-free service accounts run the programs. You never need to type your Microsoft password, and changing that password later can't stop sending.
11. **Node.js 24.21.0.** Please update (A2).

## A5. How I read your brief

Please tell me if any of these is wrong.

1. **"Emailed"** means a real email of any step went out. Dry-run and test emails don't count.
2. **The 30-day rule:**
   - it counts emails by anyone, including yourself;
   - it matches by company, by the company's own website domain, and by email address;
   - shared domains such as gmail.com or instagram.com are never used for matching;
   - a company in another active campaign counts as taken until that campaign is done with it;
   - draft campaigns don't hold companies;
   - there's no override.
3. **Old dates count (Q4). Re-contacting after 30 days is allowed (Q5).**
4. **Follow-up delays** are calendar days, then moved into the recipient's next weekday working hours. Public holidays aren't taken into account.
5. **Statuses the app changes by itself.**
   - Sending a first email changes Not contacted → Contacted.
   - A real reply changes Not contacted or Contacted → Replied.
   - Client, Not interested and Do not contact are never changed automatically. A reply from such a company is still logged and you're notified.
6. **Companies marked Replied** are left out of new campaigns by default, with the reason shown. You can put them back in by hand.
7. **Bounces, unsubscribes and complaints** apply to that one person, as your brief says.
   - The company shows a warning.
   - A complaint also notifies the Owner.
   - An unsubscribe blocks that address for every sender, forever.
8. **Missing details** (an empty variable with no fallback) are warnings, not errors. The Review step lists them, and launching asks you to confirm.
9. **Deleting a company** hides it everywhere but keeps its email history, so re-importing can't get round the 30-day rule or an unsubscribe. The import offers to restore the old record instead.
10. **A template is a sequence**: the first email plus its follow-ups. The master template starts every new campaign.
11. **Follow-ups don't quote the earlier email** underneath. They're short replies in the same thread.
12. **The daily limit** counts from midnight to midnight Pakistan time.
13. **Warm-up.**
    - The daily limit starts at 50.
    - It rises about 17% after each weekday on which the team used at least half of it.
    - It only rises while at most 3 of the last 200 emails bounced and none of the last 1,000 drew a complaint. One complaint stops the rise until 1,000 more emails have gone out.
    - With steady sending it reaches your maximum (1,000) in about 4 weeks.
    - You can override today's limit, up or down, after a confirmation.
14. **Time zones.**
    - Countries with several time zones use their main business zone: USA → New York, Canada → Toronto, Australia → Sydney, Brazil → São Paulo, Russia → Moscow.
    - Companies with no country use a default zone (a setting, Berlin to start) and show a warning.
    - You can change the zone for any company.
15. **Choosing the sender.** Anyone can pick any active teammate as a campaign's sender, as your brief's wizard says. That teammate is notified, and all replies go to them.
16. **The app sends no emails of its own.** Invites and password resets are links you pass on yourself.
17. **Only the Owner** (you) can change settings, keys, the sending domain, limits and users. "Back up now" is available to everyone. There is always exactly one Owner, and ownership can be transferred.
18. **Exports** offer both CSV and Excel (.xlsx), because German and Norwegian Excel often misreads plain CSV files.
19. **"Draft personal lines"** for a whole list is allowed from that list's menu.
20. **The app lives in this folder**, and the background services run from it.

## A6. The screens

**Layout on a laptop**

- **Left sidebar:** Dashboard, Contacts, Campaigns, Templates, AI lines (with a count), Import and Activity, with Settings and your name at the bottom. It shrinks to icons on smaller laptop screens.
- **Top bar:**
  - search (Ctrl+K jumps to any company or campaign);
  - the notification bell;
  - a **sending status label that is always visible**: `Dry run` (grey), `Test list only` (grey), `Sending live` (green), or `Paused: 7 of the last 200 emails bounced` (red).
- **On a phone**, the sidebar becomes a bottom bar (Dashboard, Contacts, Campaigns, Notifications), tables turn into cards, and the company panel opens full-screen.

**The screens**

| Screen | What's on it |
|---|---|
| **First-run setup** | Create the Owner account. Only shown while there are no users, and only works with the one-time code `setup.bat` prints on your PC. |
| **Login, invite, reset** | Email and password. Invite and reset links let a person choose their own password. |
| **Dashboard** (Milestone 6) | First, what needs attention: replies waiting for an answer per person ("You 3 · Ali 1"), AI lines to review, paused campaigns and why, companies missing emails, and any problem such as "The background sender hasn't checked in since 14:02". Then: companies per status and the reply rate; emails sent today against today's limit, and warm-up progress ("day 9 of 20, tomorrow's limit 207"); bounce and complaint rates next to their limits; active campaigns with progress; recent team activity. Until Milestone 6, you land on Contacts with a short "Get started" checklist. |
| **Contacts** | See **Contacts in detail** below. |
| **Company panel** | See **Company panel in detail** below. |
| **Import** | 1. Upload a file or paste rows from Excel or Google Sheets. 2. Match the columns: matched automatically, you can correct them, a preview shows the first rows, and unmatched columns become custom fields. 3. Options: which list (new or existing), starting status, a tag for the whole import, and whether duplicates are skipped or updated. 4. Check: rows flagged "already emailed by Ali 12 days ago", "invalid email", "possible duplicate: choose" or "empty row". 5. Result: created, updated, skipped duplicates, invalid emails, empty rows; problem rows can be downloaded. |
| **Templates** | The list of sequences, with the master starred. The editor has tabs "First email / Follow-up 1 / 2 / 3 / + Add", one-click variable buttons, a short cheat-sheet for fallbacks and variations, live warnings, and a **live preview** for any real contact and any sender. Create, duplicate, rename, delete (the last one can't be deleted), star as master. |
| **Campaigns** | Tabs Drafts / Scheduled / Running / Paused / Finished, each campaign with progress. "New campaign" opens the wizard (see A1; details in B6.4). Drafts save automatically. |
| **Campaign page** | Progress per step ("First email 120 of 150 sent · Follow-up 1: 40 waiting, next on 14 Oct"); sent, delivered, bounced, replied, unsubscribed and complained counts; pause and resume. The recipient list shows each person's timeline, with **skip**, **retry**, **edit this email** (for emails not sent yet) and the emails already sent. |
| **AI lines** | A review queue (Waiting, Approved, Rejected, No line, Failed). Each card shows the draft line, the **sentence on their website it's based on**, highlighted in context with a link, and any warnings. Buttons: **Approve**, **Edit then approve**, **Reject**, **Regenerate**. After Approve or Reject, "Undo" is shown for 10 seconds. |
| **Notifications, Activity** | The full notification list; a log of who changed what, with filters. |
| **Settings** | Everyone: *My profile* (name, sender display name and address, reply inbox, signature, time zone, password) and *Notifications*. Owner only: *Sending & Mailgun*, *Domain checklist*, *Limits & warm-up*, *Deliverability*, *Email footer*, *AI*, *Team*, *System*. Everyone can see *Backups* and use "Back up now". |

**Contacts in detail**

- **List sidebar** (can be hidden): All companies, Missing email, then your lists with counts. Each list's menu has Draft personal lines, Export, Rename and Delete.
- **Status tabs with counts** above the table.
- **Search** across company name, website, and people's names and emails.
- **Filters:** list, status, tag, country, niche, priority, emailed or never emailed, has email or missing email, first contacted by.
- **Sorting** on any column.
- **Pages** of 50, 100 or 200 rows, so it stays quick with 10,000+ companies.
- **Columns that always show:** Company, Status, People, Last emailed ("Ali · 12 days ago") and Sequence ("Waiting for follow-up 2 on 12 Oct"). Country, Niche, Priority and Tags hide first on a narrow screen; a "Columns" button brings them back. Custom columns (members, est. revenue, platforms) only appear when some row has them filled in.
- **Bulk actions on the ticked rows only**, and ticks can span several pages ("37 selected · clear"): set status, add to or remove from a list, tag, set priority, delete, **Email these companies**, **Draft personal lines**, **Check emails**, and export.
- **Export** (CSV or Excel) covers everything matching the current filters, or only the ticked rows.

**Company panel in detail**

It slides over the table from the right. Its web address can be shared.

- **Header:** name, website, country, their local time now, and the status and priority pickers.
- **"Emailed" banner:** for example "Emailed by Ali 12 days ago · Germany Q4 · follow-up 1 · waiting for follow-up 2 on 12 Oct", or "Never emailed".
- **People:** name, role, email, check result and date, flags (Unsubscribed / Bounced / Complained / Replied), who last emailed them (and which campaign and step), their sequence state, their personal line override, notes, and "Mark unsubscribed".
- **Personal line:** the approved line and where it came from, editable, with "Draft with AI".
- **Details:** niche, tags, lists, time zone, Instagram, first contacted by, and custom fields (only the filled ones).
- **Notes.**
- **Timeline:** emails sent (step and sender), deliveries, bounces, replies (subject and first lines), auto-replies, status changes and notes, each with who and when.

**Look and colours**

The look is calm and dark: a near-black background, slightly lighter panels, and high-contrast text. A low-poly palm mark sits next to "Polygon Paradise" in the sidebar and on the login page. Everything uses sentence case, with no ALL-CAPS labels.

| Element | Colour | Why |
|---|---|---|
| Primary button (one per screen) | Orange #E2571E with near-black text | Your brand's orange with black. Black on this orange is easy to read (5.6:1); white text isn't (3.7:1). |
| Selected item (active tab, selected list, current wizard step, ticked checkbox) | An orange bar or fill, with white text next to it | Orange means "selected" |
| Keyboard focus | A clear near-white ring with a small gap | Visible, and never confused with "selected" |
| Progress bars, badges, switches, links, charts | Greys and white | Orange is never decoration |
| Statuses | Always shown as a word, with a muted colour: Not contacted grey, Contacted blue, Replied teal, Client green, Not interested muted red, **Do not contact** red plus a "blocked" icon | Readable at a glance, not only by colour |

An automatic contrast check runs on every screen at every milestone.

**Wording.** Labels are written from your point of view, never the computer's:

| Instead of | You'll see |
|---|---|
| Worker | Background sender |
| Tunnel | Remote access |
| Job queue | Tasks in progress |
| Queued / Sending / Sent / Failed / Unknown | Waiting to send / Sending / Sent / Didn't send / Not sure it was sent |
| Unmatched reply | Reply we couldn't link to a company |
| Catch-all | Can't confirm (with a one-line explanation when you point at it) |

**Empty screens tell you what to do next.**

| Screen | Message and button |
|---|---|
| Contacts, no companies | "No companies yet. Import a spreadsheet or paste rows from Excel to get started." [Import companies] [Add a company] |
| Filters match nothing | "No companies match these filters." [Clear filters] |
| Empty list | "This list is empty. Tick companies in All companies and choose Add to list, or import a file into this list." |
| Missing email view | "Every company has an email address." |
| Campaigns | "No campaigns yet. Go to Contacts, tick the companies you want to email and click Email these companies." [Go to Contacts] |
| AI lines | "Nothing to review. On Contacts, select companies and choose Draft personal lines." |
| Notifications | "You're all caught up." |
| Activity | "Nothing yet. Changes you and your team make will show here." |
| Company with no people | "No contacts yet. Add a person, or use Export for Claude on the Missing email view." |
| Dry-run outbox | "Nothing here yet. Launch a campaign in dry run to see the emails it would send." |
| Review, "missing details" filter | "No emails are missing details. You can go on to Schedule." |

**Error messages say what went wrong and how to fix it.** Technical codes are hidden behind a "Details" link. Examples:

- "Sending paused: 7 of the last 200 emails bounced (your limit is 6). Open the bounced list, remove or re-check the list they came from, then click Resume."
- "Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here."
- "Mailgun can't find mail.example.com in the EU region. If you created the domain in the US region, change Region to US."
- "Mailgun is holding your account until business verification is finished. Complete the form in the banner at the top of Mailgun, then click Resume."
- "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November."
- "Row 14: 'anna@@studio.de' isn't a valid email address. Fix it in the file and import again, or skip this row."
- "This file is 12 MB; the limit is 8 MB. Split it into two files."
- "Too many tries. Wait 30 seconds and try again."
- "The background sender hasn't checked in since 14:02, so no emails are going out. Restart the PC or double-click start.bat."

**Keyboard.**

- `/` search, `j`/`k` move, `x` tick, `Enter` open, `Esc` close, `?` lists every shortcut.
- Single-key shortcuts never fire while you're typing in a field.
- There's a "skip to main content" link.

## A7. The default emails

These are short, friendly and specific, with no hype and one clear question at the end. They only use facts from your brief, except the two marked ⚠ for you to confirm (Q6).

**Master sequence: printing companies and studios**

First email. Subject: `{Print-ready 3D models|3D models} for {{company}}`

```
{Hi|Hello} {{first_name|there}},

{{personal_line|}}

I'm {{sender_name}} from Polygon Paradise. We make print-ready 3D models: character figurines, animals and creatures, busts and statues. Every file is clean and watertight, so there's no repair work before printing.

If you need new designs for your range, or a custom model for a client, we can do the modelling for you.

Would it help if I sent two or three examples close to what you make?

{{sender_signature}}
```

Follow-up 1: 3 days later if there's no reply, in the same thread ("Re: …").

```
Hi {{first_name|there}},

Here are a few of our recent models, in case they're useful: {{portfolio_url}}

Is any of this close to what you make?

{{sender_signature}}
```

Follow-up 2: 4 days after follow-up 1. ⚠ Please confirm clients can start with a single model.

```
Hi {{first_name|there}},

One idea: you could start with a single model, like one figurine or one bust, and see how the file prints on your machines before ordering more.

Is there a design you've been wanting to add to your range?

{{sender_signature}}
```

Follow-up 3: optional and off by default; 7 days after follow-up 2. ⚠ Please confirm you send examples and prices on request.

```
Hi {{first_name|there}},

I'll leave it here so I don't crowd your inbox. If print-ready models become useful for you later, just reply to this email and I'll send examples and prices.

Would it be alright to check back in a few months?

{{sender_signature}}
```

**Creators sequence** (a draft until you answer Q6). Subject: `Print-ready 3D models`. Creators' names are often handles, so the subject doesn't use them.

```
{Hi|Hello} {{first_name|there}},

{{personal_line|}}

I'm {{sender_name}} from Polygon Paradise. We turn characters and creatures into print-ready 3D models, clean and watertight, ready to print as figurines, busts or statues.

If you'd ever like one of your designs as a printable model, we can do the modelling for you.

Would you like to see a couple of examples?

{{sender_signature}}
```

Follow-up 1: 4 days later.

```
Hi {{first_name|there}},

Here are some recent models, so you can see the style and detail: {{portfolio_url}}

Is there a character of yours you'd like to see as a figurine?

{{sender_signature}}
```

**Signature example.** Each person sets their own in their profile.

```
Ali Khan
Polygon Paradise · print-ready 3D models
https://www.polygonparadise.com
```

**Footer.** It is added automatically to every email and can't be forgotten. You set the text in Settings.

```
--
Polygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan
If you'd rather not hear from us, unsubscribe here: %unsubscribe_url%
```

Mailgun turns `%unsubscribe_url%` into a personal link that works even while your PC is off. Previews show it as `[unsubscribe link]`.

**How the special markers work**

- `{{first_name|there}}` uses "there" when there's no first name, for example for a "General inbox" address.
- `{{personal_line|}}` means "fine if empty". If the line would be empty, it disappears completely, so the email has no gap.
- `{Hi|Hello}` picks one option per person. The pick stays the same every time that person's email is shown, in the template preview, in Review and in the email itself, as long as the options aren't edited. So the preview is exactly what gets sent.

## A8. Milestones and what you'll test

After each milestone I run all the checks, open every new screen in a real browser myself, and then tell you in plain words what to try. I wait for your OK before starting the next one.

Until you switch on "Go live" in Milestone 6, the app can only send real email to the addresses on your test list.

**1. Foundation**
- Login and first-run Owner setup. Users: invite, deactivate, reset password, transfer ownership. Profiles.
- Companies, people, lists and tags.
- The Contacts screen and the company panel with its timeline.
- Import (file or paste, column matching, options, check, result, old statuses) and export (CSV or Excel).
- The practice copy with made-up companies (`start-demo.bat`).
- Double-click scripts: start, stop, update, restore, and a password reset that works on the PC itself. Also the background-services installer and the PC setup script (firewall, Private network, power settings).
- Automatic daily backups (the last 14 kept), plus a backup before every update, so your real data is protected from day one.
- **Install guide.**
- *You'll test:* log in on the PC and from another office computer; invite a teammate; import your old tool's exports; search, filter, bulk-edit and export; open the company panel; install the services and restart the PC to see everything come back by itself.

**2. Templates and campaigns**
- The template editor with variables, fallbacks, variations, warnings and live preview, plus the default sequences from A7.
- The 6-step campaign wizard and the Review screen. The Verify step says "address checks arrive in Milestone 5".
- The campaign page.
- Dry-run sending of first emails, and the dry-run outbox.
- The 30-day rule, with the reasons shown when companies are left out.
- *You'll test:* in the practice copy and on your real data, build a campaign from a selection, review and edit emails, launch it in dry run, and read the "sent" emails in the outbox.

**3. Mailgun**
- **Guides:** Mailgun and DNS; Cloudflare Tunnel and Access.
- Connecting Mailgun, "Apply recommended settings" and the domain checklist.
- Sending hours, pacing, the daily limit and warm-up (with your view and override).
- "Send me a test" and the test-list guard.
- Bounce, unsubscribe and complaint handling; catch-up after the PC was off; crash-safe sending.
- Automatic pause on health problems, and "Pause all sending".
- **Reply routes.** The app creates one per sender, plus a catch-all, when you click "Apply recommended settings". The guide shows how to check them in Mailgun.
- **The real-reply test that decides the unsubscribe setup** (A4, point 5).
- Test-list addresses count as checked, so test campaigns can run before address checks arrive in Milestone 5. Every other address still needs a real check.
- *You'll test:*
  - open the app from your phone through Cloudflare;
  - connect Mailgun and see the green ticks;
  - launch a small live campaign to your test-list mailboxes (Q10), then reply from them: each reply must arrive normally in your reply inbox;
  - simulate a bounce and an unsubscribe with the test tools.

**4. Sequences and replies**
- Follow-ups in the same thread, with the stop rules.
- Reply detection, matching replies to emails, and auto-reply handling.
- Holding follow-ups after a long time off.
- "Who has been emailed" shown everywhere.
- Notifications (bell, page, optional desktop pop-ups) and "Replies waiting for an answer" (on the Notifications page until the dashboard arrives in Milestone 6).
- *You'll test:*
  - a practice-copy campaign with fast follow-ups;
  - a small live campaign to your test-list mailboxes with a 1-day follow-up: reply from one mailbox, and the reply shows up in the app and cancels that follow-up;
  - an out-of-office reply from another mailbox doesn't cancel it.

**5. Address checks and AI**
- Address checks with your policy, cost estimates and re-checks.
- AI personal lines: reading websites, Claude drafting, automatic checks, the review queue, costs.
- The missing-emails round trip with Claude.
- *You'll test:* check a list's addresses; draft lines for 20 companies and review them; the Claude CSV round trip.

**6. Finish and go live**
- The dashboard; settings polish.
- Backups: "Back up now", a second folder, the dashboard's old-backup warning, and a tested restore.
- The final README and guides.
- The full automated end-to-end test.
- **Go-live checklist.** Switch on "Go live" (with confirmation), switch new campaigns to live, and warm-up starts.
- *You'll test:* the dashboard numbers; a backup and a restore; a PC restart; then the first real, small campaign together.

## A9. What you'll set up

Each guide arrives with the milestone that needs it.

1. **Milestone 1: install.**
   - Install Node.js 24.21.0.
   - Double-click `setup.bat`. It installs everything, creates the settings file and the database, and prints your setup code. It also asks for the app's public address; press Enter to skip until Milestone 3.
   - Double-click `start.bat` and open `http://localhost:3000` to create the Owner account.
   - Close the start.bat window. Then `install-services.bat` makes the app start with Windows, and `setup-pc.bat` changes the settings from Q12 (each step asks first).
   - Also set Windows Update's "active hours" so the monthly restart happens at night, outside European working hours.
2. **Milestone 3: Mailgun and Cloudflare.**
   - Mailgun: add the sending domain (choose the EU region), add the DNS records shown in the app's checklist, and set Mailgun's monthly safety limit.
   - Cloudflare:
     1. Install its connector.
     2. **Before** adding the public address, set up Access: add the "One-time PIN" login method (new accounts don't have it), allow only a list of staff email addresses, and add a second Access app that lets `/api/webhooks/*` and `/api/health` through.
     3. Then add the public address, leaving "Protect with Access" off and "HTTP Host Header" empty.
   - Re-run `setup.bat` to enter the public address, then click "Apply recommended settings" in the app. It also creates the reply routes.
3. **Milestone 4:** nothing new to set up.
4. **Anytime:** invite your team (Settings › Team). Each person fills in their profile.
5. **Milestone 6:** choose a second backup folder (OneDrive or a USB drive), and store a copy of the settings file (`.env`) somewhere safe. Without it, the saved keys can't be read and you'd have to type them in again.

## A10. Words used in this plan

- **Mailgun:** the service that actually sends the emails.
- **Sending domain:** the web domain the emails come from (e.g. `ali@<sending-domain>`), kept separate from polygonparadise.com.
- **DNS:** your domain's address book. It is managed where you bought the domain, or at Cloudflare.
- **Cloudflare Tunnel:** a secure connection from your PC to Cloudflare, so remote staff and Mailgun can reach the app without opening your router.
- **Cloudflare Access:** an optional extra login in front of the app (a code sent by email).
- **Webhook:** an automatic message from Mailgun to the app, such as "this email bounced".
- **API key:** a password that lets the app use Mailgun or Claude.
- **Bounce:** an email that couldn't be delivered.
- **Complaint:** someone clicked "This is spam".
- **Catch-all:** a mail server that accepts every address, so nobody can confirm the person exists.
- **Dry run:** the app does everything except actually send, and shows you what it would have sent.
- **Warm-up:** starting a new sending domain slowly, so email providers learn to trust it.

---

# Part B: technical appendix

## B1. Architecture and processes

- **Three Windows services.** Two are managed by NSSM (2.24-101). The third, cloudflared, installs its own service.
  - `OutreachWeb`: `node node_modules\next\dist\bin\next start -H 0.0.0.0 -p 3000 --keepAliveTimeout 100000` (production build). The keep-alive time is longer than cloudflared's 90 s idle pool.
  - `OutreachWorker`: `node dist\worker.mjs`, which is the worker bundled by esbuild.
  - `Cloudflared`: its route points to `http://127.0.0.1:3000`, never to `localhost`, to avoid the `::1` problem on Windows.
- **One database.** `data/app.db`, SQLite in WAL mode (B5).
- **The worker is a single instance.** It holds a lease row with a 60 s TTL and a 15 s heartbeat. A second worker waits and retries every 15 s instead of exiting, and takes over only when the heartbeat is older than 60 s. Before every claim, the sending loop checks it still owns the lease.
- **Worker start-up:**
  1. Take the lease.
  2. Check the database migration version.
  3. Reset orphaned Running jobs to Queued.
  4. Handle the restore marker, if one exists (B6.7).
  5. Catch up (B6.11).
  6. Evaluate closed days (warm-up).
  7. Start the loops.
- **Shutdown.** Ctrl+C from NSSM (with `AppStopMethodConsole=4000`) stops new claims and finishes the current step in under 4 s. Every step is crash-safe, so a power cut is also fine.
- **Public address.** `APP_PUBLIC_URL` (e.g. `https://outreach.<domain>`) in `.env` is the only source for absolute URLs:
  - the webhook and route-notify URLs;
  - invite and reset links (the LAN form is also offered);
  - `serverActions.allowedOrigins`.

  Nothing is ever built from `request.url`, because Next reports its own host there.
- **Setting the public address.** `setup.bat` asks for it; you can skip until Milestone 3, and re-running `setup.bat` changes it and rebuilds. Settings › System shows it read-only, together with the exact webhook and inbound URLs. While it's empty, invite and reset links use the LAN form only.
- **Guard.** "Apply recommended settings" refuses to register any webhook or route unless `APP_PUBLIC_URL` starts with `https://` and `GET <APP_PUBLIC_URL>/api/health` returns the app's JSON, which proves the tunnel and the Access bypass both work. Changing the address means re-running "Apply recommended settings".

## B2. Technology and versions

Everything is pinned exactly (`.npmrc save-exact=true`) except typescript (`~6.0.3`, patch updates only). `package-lock.json` fixes every installed version.

| Package | Version | Notes |
|---|---|---|
| Node.js | 24.21.0 (`engines: 24.x`, ≥24.18.1) | The start-up guard refuses to run if `process.versions.modules` differs from the one recorded at install (B11) |
| next / eslint-config-next | 16.3.6 | `proxy.ts` replaces middleware; `next lint` has been removed |
| react / react-dom | 19.3.0 | |
| typescript | ~6.0.3 | TS 7 has no JS API; typescript-eslint needs <6.1 |
| eslint | 9.39.5 | eslint-plugin-react crashes on ESLint 10 |
| @types/node | 24.13.6 | vitest 5 needs ≥22; create-next-app's ^20 conflicts |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | CSS-first; dark tokens |
| shadcn CLI (`init -b radix`) / radix-ui / lucide-react / sonner / cmdk / tw-animate-css / cn | 4.21.0 / 1.6.7 / 1.47.0 / 2.0.8 / 1.1.1 / 1.4.0 / 0.4.0 | Radix, not Base UI. Lucide has no brand icons, so Instagram uses an inline SVG |
| @tanstack/react-table | 9.2.4 | v9 API (`useTable`, `tableFeatures`), manual (server-side) mode |
| prisma / @prisma/client / @prisma/adapter-better-sqlite3 | 7.10.0 | Never `npm i prisma` bare: it installs the 8.0 RC |
| better-sqlite3 | 12.11.1 (hoisted, from the adapter's ^12.6) | node-v137 win32-x64 prebuild; don't add 13.x |
| @types/better-sqlite3, dotenv | 9.6.0, 18.0.3 | `prisma.config.ts` starts with `import 'dotenv/config'`, because Prisma 7 no longer loads `.env` |
| @node-rs/argon2 | 2.2.1 | Argon2id; prebuilt, no install scripts |
| zod | 4.6.5 | Every rule has a hand-written plain message |
| SheetJS CE (`xlsx`) | 0.20.3 from `vendor/xlsx-0.20.3.tgz` | Never the stale npm 0.18.5. Reads xlsx/xls; writes the xlsx exports |
| papaparse (+ @types) | 5.7.0 (5.5.2) | Parsing and CSV writing |
| i18n-iso-countries | 7.14.0 | Plus our own country→zone table (not countries-and-timezones) |
| temporal-polyfill | 1.0.5 | Wrapped in `core/time`; Luxon 3.7.2 is the fallback |
| tldts, ipaddr.js | 7.4.14, 2.5.0 | Registrable domains and shared-domain detection; SSRF guard |
| @anthropic-ai/sdk | 0.128.0 | |
| undici, cheerio, robots-parser | 8.11.0, 1.2.0, 3.0.1 | Website reading |
| esbuild / tsx | 0.28.2 / 4.23.15 | Worker bundle with `--packages=external`; tsx for development |
| vitest / vite / @playwright/test (+ @axe-core/playwright) | 5.0.1 / 8.3.0 / 1.63.0 | Chromium only |
| NSSM / cloudflared | 2.24-101 / 2026.9.1 | |

**Build notes**

- `next.config.ts`: `serverExternalPackages: ['@prisma/adapter-better-sqlite3']` (better-sqlite3 and @prisma/client are external by default), plus `experimental.serverActions.allowedOrigins`.
- `tsconfig.worker.json` extends the root config with `"types": ["node"]` (TS 6 defaults `types` to `[]`).
- There is one Prisma config file, `prisma.config.ts`. The database path is made absolute, with forward slashes, in `db.ts`, so the CLI, web and worker all open the same file.
- **Milestone 1 spike:** bundle the worker with esbuild and run one Prisma query through the adapter. If that fails, the worker service runs `node --import tsx worker/index.ts`.
- If Turbopack hits Windows symlink errors, the fallback is the `build:webpack` script (`next build --webpack`).
- Code uses string-literal unions (not TS enums); Prisma enums are fine.
- `package.json` has an `allowScripts` policy (prisma, @prisma/engines, better-sqlite3), so npm 12 can't break installs.
- Scaffolding: create-next-app refuses a folder that contains SPEC.md, so the project is generated in a temporary folder and moved in.

## B3. Folder structure

```
outreach/
├─ SPEC.md  PLAN.md  README.md
├─ docs/setup/            1-install, 2-mailgun-dns, 3-cloudflare, 4-reply-routes, 5-backups-restore, troubleshooting
├─ setup.bat start.bat stop.bat update.bat restore.bat status.bat reset-password.bat start-demo.bat
├─ install-services.bat uninstall-services.bat setup-pc.bat        (CRLF line endings)
├─ scripts/               run-prod.mjs, stop.mjs, install-services.ps1, setup-pc.ps1, simulate-webhook.ts, make-demo-data.ts, …
├─ tools/nssm.exe         shipped, SHA-256 recorded and re-checked by the installer
├─ vendor/xlsx-0.20.3.tgz
├─ prisma/ schema.prisma migrations/ seed-demo.ts      prisma.config.ts
├─ data/  app.db (+ -wal, -shm), demo.db               backups/  logs/
├─ src/
│  ├─ app/               screens and route handlers
│  ├─ proxy.ts           optimistic "signed in?" redirect for pages only
│  ├─ components/
│  ├─ core/              pure logic, no I/O, fully unit-tested; shared with the worker (never imports server-only)
│  │  ├─ templates/ rules/ sending/ mail/ import/ verification/ ai/ geo/ time/
│  │  └─ email-address.ts shared-domains.ts csv.ts
│  ├─ server/            db.ts (+ write lock, retry), secrets, settings, state, activity, notifications,
│  │                     mailgun/, verification/, ai/ (claude, fetcher + fixture fetcher), services/
│  ├─ lib/auth/          sessions, throttling, requireUser()/requireOwner() (web only, server-only)
│  └─ generated/prisma/
├─ worker/               index.ts, loops/, jobs/  → dist/worker.mjs
└─ tests/                unit/ integration/ e2e/ playwright/ fixtures/ (csv, xlsx, xls, html sites, webhook payloads)
```

## B4. Data model

Integer IDs throughout. A company is shown as `C-1042`, and that number never changes. Times are stored in UTC. Enums are Prisma enums (TEXT on SQLite, native on Postgres). JSON is used only for opaque blobs, and there are no scalar lists. Search uses lowercase normalised columns, so SQLite and Postgres behave the same. Moving to Postgres later means a new baseline migration plus a data copy.

**Users and access**

- `User`: login email; name; role (OWNER/MEMBER, exactly one OWNER); passwordHash; active; senderDisplayName; replyInbox; signature; timeZone; dailyCap?; notifyPrefs; lastLoginAt.
- `SenderAddress`: userId; domainId; localPart (unique per domain, validated, reserved names blocked); address; mailgunRouteId; routeStatus; retiredAt. Routes for retired addresses are kept, because replies to old emails must still arrive.
- `SendingDomain`: name; region; active; lastLiveSendAt; the domain's own Mailgun cursors. Old domains stay synced for 60 days after their last send.
- `AccessLink`: invite (72 h) or reset (24 h) link; tokenHash; single use; revocable.
- `Session`: tokenHash; expiresAt; lastSeenAt; source; userAgent.
- `LoginAttempt`: emailNorm; sourceKey; success; at.

**Settings and state**

- `Setting`: Owner-edited configuration, as key → JSON.
- `SystemState`: worker-owned, versioned rows updated with compare-and-set. It holds:
  - the pause state and reason;
  - the health baseline;
  - the warm-up step and `lastEvaluatedCapDay`;
  - the outage record;
  - the restore marker;
  - each periodic task's `lastSuccessAt`.

  Keeping this apart from `Setting` means an Owner saving thresholds can't overwrite an auto-pause.
- `Secret`: key; AES-GCM ciphertext; last4; updatedBy/At. It holds the Mailgun key, the webhook signing key, the verification key and the Anthropic key.

**Contacts**

- `Company`:
  - name, nameNorm, website;
  - `domain` (the registrable domain, or null for shared hosts);
  - `profileKey` (for shared hosts: the account in the link, read per platform by `parseWebsite`, e.g. `etsy.com/shop/<shop>` or `facebook.com/profile.php?id=<id>`; null for generic pages and platforms without a rule, so they never match; used only for exact matching);
  - country, timeZone, niche, priority, status, notes, personalLine (approved), instagram, customFields, searchText;
  - firstContactedBy/At, lastEmailedAt/By/CampaignId/Step, importedLastContactAt;
  - `lastContactAt` = the newer of lastEmailedAt and importedLastContactAt, derived on every write of either (`lastContactAt()` in companies/filters); "Last emailed" shows, sorts and filters by it;
  - repliedAt, deletedAt, createdBy/At, updatedAt.
- `Person`:
  - companyId, name, firstName, role, email;
  - `emailNorm` (unique, including soft-deleted rows);
  - isGeneric;
  - check result, risk, date and provider (the fake provider counts as "not checked" for sending; editing the email clears the result);
  - personalLineOverride;
  - unsubscribedAt, bouncedAt, complainedAt, repliedAt;
  - lastEmailedAt/By/CampaignId/Step;
  - notes, customFields, deletedAt.
- `List`, `CompanyList`, `Tag`, `CompanyTag`, `CustomField` (key, label, entity).
- `Suppression`: emailNorm (unique); reason; source; detail; createdAt; pushedToMailgunAt. It is never removed automatically.
- `VerificationCheck`: history of every address check (provider, result, risk, reasons, raw, cost, jobId).

**Templates and campaigns**

- `Template`: name, isMaster. `TemplateStep`: step 0–3, enabled (default true; the master's follow-up 3 starts false), subject (step 0 only), body, delayDays.
- `Campaign`:
  - name; status (DRAFT/SCHEDULED/RUNNING/PAUSED/FINISHED/CANCELLED); wizardStep;
  - **mode** (DRY_RUN / TEST / LIVE), fixed at launch;
  - sender snapshot (userId, fromName, fromAddress, domainId), fixed at launch;
  - practice helpers (ignoreWindow, daysAsMinutes; dry-run campaigns only);
  - sourceTemplateId, startAt, launchedAt, finishedAt, pausedAt, pauseReason.
- `CampaignStep`: this campaign's copy of the texts.
- `CampaignRecipient`: companyId; personId; emailNorm; included; exclusionReason; state; stopReason; currentStep; nextDueAt; hasEdits; warnings. Unique on (campaignId, personId) and on (campaignId, emailNorm).
- `RecipientEdit`: (recipientId, step), subject, body, editedBy/At.
- `CompanyReservation`: companyId; campaignId; reservedAt; releasedAt; expiresAt. At most one active reservation per company, enforced by a partial unique index or a conditional insert.
- `OutboundEmail` (one row per email per step):
  - campaignId, recipientId, personId, companyId, senderId, step, mode;
  - `toEmail`, `toNorm`;
  - snapshots of `companyDomain`, `companyName` and `fromAddress`;
  - subject, text, html;
  - `messageId` (unique, ours) and `sendId` (random, sent as `v:send_id`);
  - inReplyTo, references;
  - dueAt, status, claimedAt, attempts, lastError, sentAt, providerId;
  - **monotonic** deliveredAt, tempFailedAt, bouncedAt, complainedAt, unsubscribedAt.

  Unique on (campaignId, step, toNorm).
- `TestSend`: "Send me a test" emails, kept apart so they never count as emailed or touch the unique index. Fields: userId, to, subject, sentAt, providerId, mode.
- `ExternalSend`: live sends found in Mailgun's logs that have no matching row, for example after restoring an older backup. Fields: toNorm, companyDomain, companyId?, sentAt, providerMessageId, source (RESTORE). The 30-day rule counts these too.

**Mail events and replies**

- `MailEvent`: dedupeKey (unique = provider event id + UTC date); type; severity; reason; occurredAt; messageId; recipient; outboundEmailId; isTestMode; source (WEBHOOK/LOGS/SIMULATED); raw; stopAppliedAt; processedAt.
- `WebhookToken`: token (unique); receivedAt; kept 48 h.
- `InboundMessage`:
  - storageKey (unique); messageIdHeader; receivedAt; toAddress; senderAddressId;
  - from, subject, snippet, inReplyTo, references, headers;
  - kind (REPLY, AUTO_REPLY, BOUNCE_NOTICE, POSSIBLE_REPLY, UNLINKED);
  - matched outbound, person, company and campaign;
  - answeredAt/By, confirmedAt/By, source (NOTIFY/CATCHUP/SIMULATED), processedAt.

**Activity and notifications**

- `ActivityLog`: at; actorId (null = system); companyId; personId; campaignId; type; summary; data; mode (dry-run entries are labelled).
- `Notification`: userId; type; title; body; link; createdAt; readAt.

**Background work**

- `Job`:
  - type, payload (never secrets), status, runAt, priority, attempts, maxAttempts, lockedAt, lockedBy;
  - `activeDedupeKey`, which is unique and nullable: set while Queued or Running, cleared when done;
  - progressDone/Total, result (only whitelisted fields reach the browser), error (redacted);
  - createdBy, timestamps.
- `WorkerLease`, `SyncCursor` (per sending domain: logs, stored replies, suppressions), `Backup` (fileName, createdAt, size, kind, copiedTo).
- `AiDraft`, `WebsiteSnapshot`, `RobotsCache`.
- `ImportSession`; `ImportRow` (per-row status, so a stopped import resumes where it left off).

**Indexes**

- Company: (status), (domain), (lastEmailedAt), (country), (nameNorm), (deletedAt).
- CompanyList (listId, companyId).
- Person: (companyId).
- OutboundEmail: (status, dueAt), (companyId, sentAt), (toNorm, sentAt), (companyDomain, sentAt), (campaignId, step, status).
- CampaignRecipient: (companyId, state).
- CompanyReservation (companyId, releasedAt).
- MailEvent (processedAt), InboundMessage (processedAt).
- Job (status, runAt, priority).
- Notification (userId, readAt).
- ActivityLog (companyId, at).

## B5. Database rules (two processes, one SQLite file)

1. **One module.** `server/db.ts` builds `new PrismaBetterSqlite3({ url: 'file:' + absPath, timeout })` with a busy timeout of 2 s in the web process and 10 s in the worker. At start-up it runs `PRAGMA journal_mode=WAL`, `foreign_keys=ON` and `synchronous=NORMAL` through `$queryRawUnsafe`.
2. **A per-process write lock.** Every write and every interactive transaction goes through `db.write(fn)`, which holds a process-wide async mutex. Prisma shares one connection per process, so without the lock, statements from another request could run inside someone else's open transaction and be rolled back with it.
3. **Retries.** `withDbRetry` retries P1008 (SQLITE_BUSY), P2028 and P2034 with jittered back-off, up to 5 attempts. The adapter begins DEFERRED transactions, so a read-then-write transaction can fail immediately.
4. **Short transactions.** Transactions stay under about 50 ms, write early, and never contain network I/O. Mailgun, Claude and website calls happen outside any transaction.
5. **Compare-and-set.** Claims and automatic status changes are conditional `updateMany` calls that must affect exactly one row:
   - claim: `where {id, status:'QUEUED'}`;
   - `where {id, status:'NOT_CONTACTED'}` → Contacted;
   - `where {firstContactedById: null}`.
6. **Heavy work runs in the worker, in chunks.** Imports, bulk actions over 500 rows, and verification and AI writes are processed in chunks of at most 500, one transaction per chunk.
7. **Webhook routes** return 500 on P1008, so Mailgun retries.
8. **Test:** an integration test hammers the database with writes from both processes at once.

## B6. Rules in detail

### B6.1 Who has been emailed, the 30-day rule and reservations

- **Email history** is the `OutboundEmail` rows with a live Sent status, plus `ExternalSend` rows and the old-tool dates (`importedLastContactAt`). History survives deletion, because deletes are soft and the rows carry snapshots.
- **`markSent()`** is the single function used by both the sending loop and the reconciler. In one transaction it sets Sent, updates the Company and Person `lastEmailed*` fields and `firstContacted*` (compare-and-set), moves Not contacted → Contacted, and creates the next step's row.
- **`teamRuleCheck(company, people, now, campaignId)`** blocks a company when any of these is true:
  - a live send or an `ExternalSend` in the last N days (a setting, default 30) matching:
    - companyId, or
    - `companyDomain = company.domain`, when that domain is usable (not a shared host), or
    - `toNorm` equal to any of the company's people's addresses;
  - the old-tool date is within N days;
  - another campaign holds an active reservation for the company.

  The reason is shown in words, for example "Emailed by Ali 12 days ago (Germany Q4, follow-up 1)" or "Waiting in Sara's campaign 'Norway prints'".
- **Reservations.**
  - Taken at launch, inside the launch transaction, with a conditional insert. Companies lost to a simultaneous launch are listed on the confirmation screen.
  - Drafts and dry-run or test campaigns never reserve.
  - Released when all of that company's recipients have finished or stopped, or when the campaign finishes or is cancelled.
  - A reservation held by a campaign that has been paused for more than 14 days (a setting) expires. The person who launched the campaign and the Owner are notified.
- **Send-time check.**
  - The recipient's live campaign must hold the reservation.
  - No other campaign may have sent a live email to that company, domain or address within N days.
  - All steps and all people inside the same campaign are exempt.
- **Same step twice.** The database has a unique index on (campaign, step, `toNorm`). The eligibility check also refuses "already received step k from campaign X" within N days (the 30-day rule's length), or forever if Q5 is answered strictly.

### B6.2 Eligibility and exclusion reasons

One function, `eligibility()`, is used by the wizard, at launch and just before each send. Each exclusion has a reason in words:

- no email address;
- invalid format;
- **not checked yet, last checked more than 90 days ago (a setting), or only checked by the test checker** (live and test campaigns). Exception: until go-live, addresses on the Owner's test list count as checked (reason shown: "On test list");
- the check said undeliverable or do-not-send;
- the verification policy blocks it;
- on the suppression list, or unsubscribed, bounced or complained;
- company status Client, Not interested or Do not contact;
- company status Replied (excluded by default; can be included by hand);
- the 30-day rule or a reservation;
- a duplicate address in this campaign;
- excluded by hand;
- the company has been deleted;
- the sender has no working reply route (live campaigns only).

A company with no country or time zone uses the default zone (a setting) and gets a warning.

### B6.3 Templates

- **Variables.** `first_name`, `contact_name`, `company`, `website`, `country`, `niche`, `personal_line`, `sender_name`, `sender_signature` and `portfolio_url`, plus every custom field.
  - `first_name` is the first word of the name; it is empty for General inbox addresses.
  - `personal_line` is the person's override if there is one, otherwise the company's approved line.
- **Fallbacks.** `{{x|fallback}}` uses the fallback when x is empty. `{{x|}}` means empty is fine. A line that contains only an empty optional variable is removed together with the blank line after it, so no double gap is left.
- **Variations.** `{a|b|c}` picks one option using a deterministic hash of (personId, step, the option text, the occurrence index). There is no campaign or template ID in the hash, so the Templates preview, Review and the sent email all agree unless the options are edited. `\{` writes a literal brace.
- **Warnings.** These are shown and counted, but don't block:
  - empty variables that have no fallback;
  - unknown variable names;
  - unbalanced braces.

  Launch shows "12 emails have missing details: fix, exclude or send anyway".
- **Output.** Text is rendered to plain text plus a minimal HTML version: HTML-escaped, `<p>` per paragraph, `<br>` for line breaks, and `<a>` for URLs, with no styles. The footer is appended after the signature.

### B6.4 Wizard, sequences and stop rules

**The six wizard steps**

1. **Audience.**
   - Choose companies by list, tag, status, country or niche, or start from a selection.
   - Tick which people get the email. The first person with a valid checked address is pre-selected; if none is checked yet, it's the first named person with an email, then General inbox.
   - A warning shows when more than one person at a company is ticked.
   - An "Excluded (n)" section lists the reasons (B6.2).
2. **Sender.** Pick the sender, with their daily limit and reply-route status shown.
3. **Message and sequence.**
   - Copies the template's enabled steps into `CampaignStep`. Steps that are switched off can be turned on for this campaign.
   - Edits stay in this campaign; "Save back to template" is optional.
   - Choose 0–3 follow-ups, each "N days after the previous step if there's no reply".
4. **Verify.**
   - Shows the count and cost of addresses that are unchecked or were checked more than 90 days ago.
   - If you confirm, the checks run as a job with progress.
   - If you decline, those recipients become "Excluded: not checked".
   - Invalid addresses are removed; the policy decides risky and catch-all ones.
   - Recipients whose result is Unknown stay in the campaign as "Waiting for re-check". If the 24 h re-check (B6.9) now allows them, they're sent normally; otherwise they become "Excluded: couldn't be checked".
5. **Review.**
   - Every recipient, every step, rendered exactly as it will be sent.
   - For each recipient: edit this person's email (`RecipientEdit`), edit the personal line (saved on the company), include or exclude, see warnings.
   - Filters: missing details, edited.
   - "Send me a test" sends to the user's own reply inbox, recorded as a `TestSend`.
6. **Schedule.**
   - Start now or at a date and time, shown in the user's time zone and in recipients' local time.
   - The confirmation shows how many emails fit today's limit.
   - Launch: fix the mode and the sender snapshot, re-check eligibility, take reservations, and create the step-0 rows.

**Follow-ups**

- `markSent()` creates step N+1 with `dueAt` = the accepted time + delayDays (calendar days). The sending window then moves it to the next open slot.
- Every follow-up uses the campaign's sender snapshot, the subject `Re: <the first subject exactly as that person received it>`, `In-Reply-To` = the previous Message-ID, and `References` = all earlier IDs.
- A sweeper runs every 5 minutes. It finds recipients whose last step was sent, who aren't stopped, and who have no next step, and repairs them.

**Stop rules.** Follow-ups stop for a person when:

- they reply, unsubscribe, bounce or complain;
- the company status becomes Replied, Client, Not interested or Do not contact;
- anyone at the company replies, which stops every recipient at that company in all campaigns.

**How stops are applied**

- **Instantly:** the webhook route applies the stop (recipient stopped, person flag, suppression) inside the same short transaction in which it stores the event. Notifications and timeline entries follow through the worker's fast event loop.
- **Before every send:** the sending loop refuses if unprocessed events or inbound messages exist for the same address or company. After claiming, it re-runs `eligibility()` on fresh data; if the recipient is no longer eligible, the row becomes Skipped.
- **After a long outage:** if catch-up finds the worker was offline longer than the plan's log retention (a setting, 5 days on Foundation), every follow-up whose previous step went out before the gap is held. The state reads "On hold: replies may have been missed while the PC was off". Each sender and the Owner are notified, and the sender continues their follow-ups with "I've checked my inbox". First emails are unaffected.

### B6.5 Sending modes

The global setting chooses the mode for **newly launched** campaigns only. Each campaign keeps its launch mode for its whole life, so a dry-run campaign can never send real email, even if live mode is switched on later.

On top of this, **the test list guard** applies until go-live. In test and live mode, the worker refuses any address not on the Owner's test list, and the label reads "Test list only". Go-live is an explicit Owner switch ("Go live", with confirmation) in Settings › Sending. Until it's on, the guard applies, and an empty test list blocks all real sending.

| Effect | Dry run (your real data) | Practice copy and automated tests | Mailgun test mode | Live |
|---|---|---|---|---|
| Email handed to Mailgun | No (goes to the outbox) | No | Yes (not delivered, billed) | Yes |
| Campaign progress, sequence states, follow-ups, stop rules inside the campaign | Yes | Yes | Yes | Yes |
| Notifications and timeline entries | Yes, labelled "Dry run" | Yes | Yes, labelled "Test" | Yes |
| Company status, first contacted, emailed fields | No | Yes | No | Yes |
| Recipients are checked against the 30-day rule and other campaigns' reservations | Yes | Yes | Yes | Yes |
| Its own sends count toward the 30-day rule and take reservations | No | Yes | No | Yes |
| Simulated bounce/unsubscribe/reply changes the person or company | Only that campaign's recipients | Yes | Only that campaign | Real events: yes |
| Daily limit, warm-up, health | No | Yes | No | Yes |
| Dashboard | Shown separately as "Dry run" | Yes | Separately | Yes |

- **Practice copy.** `start-demo.bat` runs a second, manual instance on port 3001 with `data/demo.db` and the setting "dry run behaves like live". The automated end-to-end test uses the same configuration on its own database.
- **Dry-run helpers** (per campaign, dry-run campaigns only):
  - "ignore sending hours";
  - "treat follow-up days as minutes".

### B6.6 Sending hours, pacing, limits, warm-up and health

- **Sending hours.** Monday–Friday, 09:00–17:00 in the company's time zone (settings). DST is handled by Temporal with `compatible` disambiguation.
- **Pacing.** Every 5 s the sending loop computes:
  - `capacityLeft` = today's cap minus today's count, where the count includes Sent, Sending, Unknown, Unconfirmed and test sends;
  - `openSecondsLeft` = the time left today during which at least one due recipient's window is open.

  The target gap is `openSecondsLeft / min(capacityLeft, dueCount)`, with ±50% random jitter and a minimum of 20 s.
- **Order.** Follow-ups first, then High priority, then the oldest due.
- **Limits.** The domain cap is `min(Owner override, maximum)` when the Owner has confirmed an override for today, otherwise `min(warm-up cap, maximum)`. An override above the warm-up cap shows "Above the warm-up schedule" and is logged. The optional per-sender cap is checked too. The cap day uses a fixed "cap day time zone" setting (default Asia/Karachi), separate from anyone's profile. When the cap is reached, the Owner gets one notification that day.
- **Warm-up.**
  - Steps: 50, 59, 69, 80, 94, 110, 129, 151, 177, 207, 242, 283, 332, 389, 455, 533, 624, 730, 855, 1000 (a geometric curve up to the maximum).
  - At start-up and daily, the worker evaluates every closed cap day since `lastEvaluatedCapDay` exactly once.
  - It advances one step after a weekday on which at least 50% of that day's cap was used, and only while the domain is healthy (bounces <2% and complaints <0.05% over the health windows; settings).
  - Otherwise it holds. The Owner's override requires confirmation and is logged.
- **Health auto-pause.**
  - **Bounce rule:** look at the most recent 200 live emails sent since the last resume (or since the start). Pause if more than 3% of 200, meaning more than 6 of them, hard-bounced.
  - **Complaint rule:** the most recent 1,000 live emails since the last resume. Pause if more than 0.1% of 1,000, meaning more than 1, drew a complaint.
  - The denominators are fixed. A few bounces on day one therefore don't pause everything, and after a resume only new problems count.
  - Only severity `permanent` counts, excluding `suppress-*` reasons, and test-mode events never count.
  - The check runs when a new bounce or complaint is applied, and at start-up. A warning notification goes out at half the limit.
  - Only the Owner can resume. The resume is logged: "Resumed by Arslan with 7 of 200 acknowledged".
  - Thresholds and window sizes are settings, shown next to Mailgun's own limits (bounces ≤5%, complaints ≤0.08%).
- **Other automatic pauses:** 401/403 from Mailgun, "business verification is required", or `sending_queues.regular.is_disabled`.
- **Pause all sending** is an Owner switch.

### B6.7 Crash safety, reconciliation and restore

- **States.** Queued → Sending (claimed) → Sent | Failed | Unknown | Unconfirmed | Skipped | Cancelled.
- **The Message-ID** `<pp.{random}@{domain}>` and `sendId` are created together with the row.
- **Claim.** The loop confirms it still owns the lease, then runs an autocommit conditional update (`status QUEUED→SENDING`) under the write lock. The claim is **committed before the POST**, and never inside `$transaction`.
- **POST to Mailgun** (30 s timeout). The outcomes:
  - 200 → `markSent()`;
  - 400 → Failed (with the reason);
  - 429 → back to Queued, `dueAt` = the reset time (nothing was accepted);
  - 401/403 → release to Queued, then the global pause and a notification to the Owner;
  - timeout, network error or 5xx → Unknown.
- **Reconciler.** It runs at start-up and every 10 minutes, and handles Unknown rows and Sending rows claimed more than 2 minutes ago.
  - It queries the Logs API by `message_id`, then by `user_variables` send_id, looking for accepted, delivered and failed events. Found → `markSent()`.
  - "Not sent" requires `claimedAt` older than 45 minutes, a successful query covering the whole window, and a window within log retention. The row then goes back to Queued with the **same** Message-ID.
  - Otherwise the row becomes **Unconfirmed**, and the campaign page asks "Retry or Skip?". It is never retried automatically.
  - Dry-run rows stuck in Sending are simply reset without calling Mailgun.
- **Web edits and actions** (edit, skip, pause a recipient) use `updateMany where status='QUEUED'`. A count of 0 means "This email is being sent right now".
- **Restore.**
  - `restore.bat <file>`: stop the services → copy the file over → delete the -wal and -shm files → write the marker `restoredFrom=<backup time>` → start.
  - On start, the worker sees the marker and sets the pause ("Restored from a backup").
  - It runs the catch-up, then pulls every `accepted` event tagged `outreach` since backup time minus 1 hour, and matches each one by Message-ID, send_id, or (campaign_id, step, recipient).
    - If the match is by (campaign_id, step, recipient), it creates that step's row if it's missing and stores the event's message-id as the row's `messageId`, so later follow-ups thread to the email that was actually sent. Then `markSent()`.
    - Unmatched events are recorded as `ExternalSend` rows, so the 30-day rule still sees them.
  - Queued rows that were due are kept only if the backup falls within log retention; otherwise they become Unconfirmed.
  - The Owner then sees a restore report and resumes.

### B6.8 Email format and the unsubscribe setup

- **Transport.** All sends go through an `EmailTransport` interface (send, look up a send, list suppressions). Mailgun is the only implementation, plus a dry-run transport and a fake for tests.
- **Each message sets:** from (the sender snapshot), to, subject, text, html, `h:Message-Id`, `h:In-Reply-To` and `h:References` (follow-ups), `o:tracking-opens=no`, `o:tracking-clicks=no`, `o:tag=outreach` and `o:tag=step-N`, and `v:send_id`, `v:campaign_id`, `v:step`.
- **Never set:** `o:deliverytime`, our own `List-Unsubscribe`, or `o:suppress-headers`.
- **Domain settings:** open and click tracking off; the tracking CNAME valid.
- **HTTPS unsubscribe links.**
  1. Wait until the tracking CNAME shows valid.
  2. Run `POST /v2/x509/{tracking-host}` and poll until the certificate is ready.
  3. Run `PUT /v4/domains/{d}` with `web_scheme=https`.
  4. Read the settings back with `GET /v3/domains/{d}/tracking`. Any wrong value is a red checklist row.
- **Unsubscribe setup.** One of these three is chosen in Milestone 3 by testing real replies from Outlook.com and Yahoo/Gmail and checking that the copy forwarded to the sender's inbox isn't flagged, with DKIM/ARC passing.
  - **Setup A (tried first):** domain unsubscribe tracking **on**, with Mailgun's footers blank. Our footer carries `%unsubscribe_url%`, and Mailgun adds `List-Unsubscribe` and `List-Unsubscribe-Post`.
  - **Setup B:** domain unsubscribe tracking **off**, with our footer still carrying `%unsubscribe_url%`. Mailgun's docs say the unsubscribe variables need tracking enabled, so B is expected to fail. It's tried only to confirm that: we check whether the link gets filled in and the headers are present.
  - **Setup C (needs your OK):** `h:Reply-To: ali@reply.<sending-domain>`. The reply subdomain is its own Mailgun domain with all tracking off, and the routes live there.

  Live campaigns stay locked until one setup passes; the result is recorded in the checklist.
- **Other Mailgun domain settings:**
  - spam filter set to "mark with headers" (`spam_action=tag`), never "block";
  - message retention at the plan's maximum;
  - DMARC `v=DMARC1; p=none`, with an optional `rua=mailto:dmarc@<sending-domain>`. That address gets its own route (priority 50: `match_recipient("^dmarc@<escaped-domain>$")` → forward to the Owner, `stop()`, no store), so DMARC reports never show up as unlinked replies;
  - a monthly custom message limit as a safety net.

### B6.9 Address checks

- **Adapter:** `check(email) → {status: valid|invalid|risky|catch_all|unknown|do_not_send, risk, isRole, isDisposable, didYouMean, reasons, raw}`.
- **Providers:** Mailgun (built), plus a fake provider for tests. ZeroBounce and NeverBounce mappings are already written down (research) and can be added later.
- **Settings:** the provider, a verification key (write-only; defaults to the Mailgun key) and the price per check.
- **The worker** runs 2–4 checks at a time, backs off on 429, and pauses with a notification on auth or credit errors. Each check is committed on its own, so a resumed job never pays twice.

| Result | Default policy |
|---|---|
| Deliverable, low or medium risk | Send |
| Deliverable, high risk | Blocked (risky) |
| Catch-all, low risk | Send |
| Catch-all, medium or high risk | Blocked |
| Unknown | Blocked; re-checked once after 24 h |
| Undeliverable, do not send | Never (added to suppressions as "invalid") |

Role addresses (info@, kontakt@, post@) are allowed; they are your "General inbox" people.

### B6.10 Replies, routes and auto-replies

- **Routes.** They are created and synced by the app, with a manual fallback documented.
  - One route per `SenderAddress`, priority 10: `match_recipient("^ali@send\.example\.com$")` → `forward("<inbox>")`, `store(notify="<APP_PUBLIC_URL>/api/webhooks/mailgun/inbound")`, `stop()`.
  - A domain **catch-all** route, priority 100, forwards to the Owner's inbox and stores the message, so replies to unknown or retired addresses are never lost.
  - The regex is escaped and anchored. Inboxes are validated (no quotes, brackets, commas or whitespace).
  - After every change, `GET /v3/routes/match` must match only the intended address.
- **Matching a reply.**
  1. `In-Reply-To` and `References`, compared against our Message-IDs.
  2. The from-address against people we emailed live in the last 90 days (the latest email).
  3. Otherwise: "Reply we couldn't link to a company", shown to the sender or Owner with "Link to a company".

  There is **no matching by domain.**
- **Auto-replies** are detected by headers (`Auto-Submitted` other than "no", `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress`, `Precedence: auto_reply|bulk|junk`) and by subject lines in English, German and Norwegian ("Out of office", "Automatic reply", "Abwesenheitsnotiz", "Automatische Antwort", "Fraværsmelding", "Automatisk svar", "Autosvar" …). Delivery-failure notices are marked BOUNCE_NOTICE.
- **On a real reply:**
  - the person is marked replied and the company becomes Replied (compare-and-set, never overwriting Client, Not interested or Do not contact);
  - the whole company is stopped;
  - the timeline gets the subject and first lines;
  - the sender is notified;
  - the reply goes on the "waiting for an answer" list until Answered or No answer needed.
- **Recovered replies with no text** (the message had already left Mailgun's storage and only the Logs entry remains): the company's follow-ups stop, the reply is filed as POSSIBLE_REPLY, and the sender is asked "Real reply?" or "It was an auto-reply" (which lets follow-ups continue).
- **Deactivating a user** revokes their sessions and links, asks the Owner what to do with their active campaigns (pause, or let the follow-ups finish), and repoints their routes' forward to the Owner (the store is kept). Their address stays reserved.

### B6.11 Webhooks and catch-up

- **Endpoints.** `POST /api/webhooks/mailgun/events` (registered with the v4 webhooks API for delivered, permanent_fail, temporary_fail, complained and unsubscribed) and `POST /api/webhooks/mailgun/inbound`.
- **Checks, in order:**
  1. HMAC-SHA256(signing key, timestamp + token), compared with `timingSafeEqual`.
  2. Freshness: within 12 h for events and 24 h for inbound. Retries may resend the original timestamp; this is reported by others, not documented.
  3. The token must be new. It is stored in the same transaction as the event, together with the instant stop (B6.4).
- **Responses:**

| Case | Response |
|---|---|
| Saved, or a duplicate | 200 |
| Bad signature | 401 (retried by Mailgun for about 8 h; logged loudly) |
| Stale or unreadable | 406 |
| Database busy | 500 |
- **Applying events.** One function handles events from any source, keyed by the dedupe key. Dates are monotonic, and the displayed status follows a precedence (complained > unsubscribed > bounced > delivered > sent), so order and duplicates don't matter.
- **Catch-up** runs at start-up and hourly, per sending domain:
  1. `sending_queues` and the tracking settings;
  2. the full suppression lists (bounces, complaints, unsubscribes; limit 1000, paged until empty). Local unsubscribes are pushed to Mailgun as `tags:['*']`;
  3. the Logs API from the cursor minus 1 h. The cursor never goes past now − 30 min, and the window is capped at retention; a gap beyond retention is recorded;
  4. stored replies ("stored" events → fetch `storage.url`);
  5. the reconciler;
  6. resume.

### B6.12 AI personal lines

- **Start.** "Draft personal lines" skips companies that have only an Instagram or social link, no website, or an already approved line (re-drafting is optional).
- **Cost estimate.** `countTokens` is run once per model and prompt version, plus the average page size, plus an output allowance per model profile. It is shown as "about $X, at most $Y". A run stops at 125% of the maximum or at the monthly limit.
- **Fetcher.** It sits behind an interface, and the tests use a fixture fetcher with saved German, Norwegian, shop, JavaScript-only and parked sites.
  - It uses undici with a public-only DNS lookup (ipaddr.js range must be `unicast`, checked on every redirect hop), http/https on ports 80/443 only, at most 5 redirects, a 15 s timeout, a 2 MB cap, and text/html only.
  - It reads robots.txt (RFC 9309 rules, cached 24 h), waits 2 s per host, handles at most 4 hosts in parallel, and fetches at most 3 requests per company.
  - Extraction uses cheerio (never `fromURL`). The second page is picked by a keyword score in English, German and Norwegian.
  - Thin or parked sites get "no line" without calling Claude.
- **Claude.** It runs only in the worker, with structured JSON via `output_config.format`: `{line|null, evidence_quote|null, evidence_source, reason_if_null}`. The website text is marked as untrusted, and an avoid-list is used on regeneration. **Model profiles:**
  - Haiku 4.5: `max_tokens 600`, no thinking, no effort;
  - Sonnet 5: `max_tokens 2000`, `output_config.effort:'low'`, thinking omitted;
  - custom IDs: neutral (no thinking or effort), checked for free with `models.retrieve`;
  - never temperature, top_p, top_k, prefill or forced tool_choice.
- **Checks before a line reaches you:**
  - the quote exists in the normalised page text;
  - every capitalised word and number in the line is found in the source;
  - at most 25 words, one sentence, no `?`, `!` or banned flattery phrases.

  A failing line is regenerated once, then shown with a warning.
- **Errors:**
  - a rejected key, the spend limit (a 429 with `enforced_spend_limit_reached`, or a 400 "usage limits") or a model not found → pause the AI queue and notify the Owner;
  - 5xx or 529 → back-off at 1, 5 and 15 minutes.

  The request ID, tokens and cost are stored on every draft.

### B6.13 Import, export and the missing-emails round trip

- **Upload** goes through a route handler (8 MB). The type is detected from magic bytes.
  - SheetJS reads spreadsheets (`cellDates`, `raw`, with a sheet picker).
  - Text is decoded as UTF-8, falling back to windows-1252, then parsed with papaparse (auto-detected delimiter; pasted text containing tabs uses tab).
  - Rows go into `ImportRow` first.
- **Column matching** uses a dictionary of English, German and Norwegian header names plus the old tool's columns. Unmatched columns become `CustomField`.
- **Shared domains.** A built-in list, editable in Settings:
  - free-mail providers: gmail, outlook, hotmail, yahoo, icloud, gmx, web.de, t-online, online.no …;
  - social and marketplace hosts: instagram, facebook, tiktok, linktr.ee, patreon, etsy, cults3d, myminifactory, printables, thingiverse, artstation, youtube, linkedin, x …;
  - hosted-subdomain suffixes (resolved with tldts, so `user.wixsite.com` stays distinct).

  Shared hosts never give a company a `domain`.
- **Grouping.** Rows are joined into companies (union-find) when they share a usable domain, the same normalised name and country, or the same non-free-mail email domain.
- **Matching existing companies:**
  - a usable domain → a match;
  - name and country → a match;
  - name only, in another country or with no country → "possible duplicate: choose";
  - a soft-deleted match → "Restore C-1042 (emailed by Ali 12 days ago)?";
  - an email that already belongs to another company → a row problem ("already belongs to C-1042"), never an error.
- **Commit** happens in the worker, in chunks of 500, with per-row status, so it can resume.
- **Old statuses:** Not Contacted, Contacted, Replied, Hired → Client, Rejected → Not interested. Old dates go into `importedLastContactAt`.
- **CSV writer.** Every CSV the app produces (views, selections, missing emails, problem rows) goes through one writer: `Papa.unparse({escapeFormulae:true})`, a UTF-8 BOM and CRLF. The importer strips one leading `'` before `= + - @`, tab or CR. The .xlsx export is written by SheetJS.
- **Missing emails.** "Export for Claude" downloads `company_id, company, website, country, email, contact_name, role, source_url, note` and shows or copies this instruction (on http it offers a select-all box instead of automatic copying):

  > I've attached a CSV of companies. For each row, find the best email address for contacting this company about 3D modelling work (print-ready 3D models such as figurines, creatures, busts and statues). Prefer, in this order: a named person responsible for products, design or purchasing; then the company's general address (info@, hello@, kontakt@, post@). Use only addresses published on the company's own website, its official social profiles or a business directory. Never guess or construct an address. Return a CSV with exactly these columns: company_id, company, email, contact_name, role, source_url, note. Keep company_id exactly as given. If you find two good contacts, add a second row with the same company_id. If you find nothing, leave email empty and say why in note.

  The re-import recognises `company_id` and adds people to those companies only. Existing emails are skipped, no companies are created, and unknown IDs are listed as problems.

### B6.14 Notifications, backups, dashboard, settings

- **Notifications.**
  - The bell polls `GET /api/notifications/summary` every 20 s, and pauses while the tab is hidden. Progress screens poll `/api/jobs/:id` every 2–3 s while a job runs. There is no SSE, which avoids Cloudflare buffering, the 125 s timeout and the six-connection limit.
  - Desktop notifications are offered only when `window.isSecureContext`.
  - Types:
    - reply (to the sender);
    - campaign finished;
    - health pause or warning, and daily cap reached (to the Owner);
    - complaint (to the Owner);
    - AI drafts ready;
    - checks finished;
    - outage hold;
    - lockout;
    - a sender address or inbox was changed (to the Owner);
    - worker, tunnel or Mailgun problems.
- **Backups.**
  - Periodic tasks run when their `lastSuccessAt` is older than their interval. They are checked at start-up and every 10 minutes. The daily backup prefers a quiet moment (outside every open sending window), but runs anyway if it's more than 24 h overdue.
  - `VACUUM INTO` writes a unique temporary name (seconds + random), which is renamed on success. A lock stops two backups running at once.
  - The worker keeps 14, optionally copies to a second folder, and records a `Backup` row.
  - The dashboard warns when the last backup is more than 36 h old.
  - `update.bat` always backs up first.
- **The dashboard and the Settings pages** are as described in A6. Settings also hold:
  - the test list;
  - the shared-domain list;
  - the cap-day time zone and the default time zone;
  - Mailgun retention (log and message days, for the catch-up windows);
  - the paused-reservation expiry;
  - the verification provider and key;
  - AI profiles and prices.

## B7. Routes and server actions

| Route | Access | Purpose |
|---|---|---|
| `POST /api/webhooks/mailgun/events` | Mailgun (HMAC) | Delivery events |
| `POST /api/webhooks/mailgun/inbound` | Mailgun (HMAC) | Reply notifications |
| `GET /api/health` | Public | `{ok, database, workerLastSeen}` only |
| `POST /api/imports` | Signed in | Upload (8 MB) |
| `GET /api/export/companies`, `/api/export/missing-emails` | Signed in | CSV or XLSX of the current view or the selection |
| `GET /api/notifications/summary` | Signed in | Bell |
| `GET /api/jobs/:id` | Signed in (Owner-only job types need Owner) | Whitelisted progress fields only |
| `GET /api/campaigns/:id/progress` | Signed in | Live numbers: not built (pages refresh with router.refresh) |

**Server actions**, grouped:

- auth: login, logout, setup, accept invite, reset;
- users and ownership;
- profile and sender address;
- companies (including bulk);
- people;
- lists and tags;
- import;
- templates;
- the wizard steps, review edits, launch, pause, resume, skip, retry, edit unsent;
- AI;
- checks;
- replies: answered, link, confirm;
- notifications;
- settings;
- Mailgun setup;
- backups;
- sending mode, pause, test list;
- test tools (dry run and practice only).

**Rules**

- Every action starts with `requireUser()` or `requireOwner()` and a zod parse.
- `proxy.ts` only redirects signed-out page requests. Its matcher excludes `/api`, `_next/static`, `_next/image` and `favicon.ico`.
- A **build-failing test** parses every route file and every `'use server'` module, and checks that each exported function starts with an auth call. The only exceptions are an explicit allowlist: the webhooks, health, login, setup, accept invite and reset.
- An **integration test** calls every Owner-only action with a Member session and expects a refusal.

## B8. The worker

| Loop | Interval | Work |
|---|---|---|
| Heartbeat | 15 s | Lease |
| Event lane | 1 s | Processes `MailEvent` and `InboundMessage` rows (notifications, timeline, health, auto-reply follow-up). Never blocked by long jobs |
| Sending loop | 5 s | Picks the next email (hours, pacing, caps, health, pause, lease), eligibility, claim, POST, `markSent` |
| Job runner | 2 s | Queued jobs; long jobs are split into per-item sub-steps that yield |
| Reconciler | 10 min + start-up | B6.7 |
| Follow-up sweeper | 5 min | B6.4 |
| Periodic tasks | Checked every 10 min | Catch-up (hourly), DNS check (6 h), backup (daily), clean-up (daily: sessions, links, attempts, tokens >48 h, jobs >30 days, logs >14 days), warm-up day evaluation, tunnel check (5 min; `127.0.0.1:20241–20245/ready`) |

**Job types**

- `import.commit`
- `verify.addresses`
- `ai.draftLines`
- `mailgun.catchUp`
- `mailgun.syncSuppressions`
- `mailgun.applySettings`
- `mailgun.syncRoutes`
- `send.testEmail`
- `campaign.finishCheck`
- `backup.run`
- `system.cleanup`

Jobs have maxAttempts; a job that reaches the limit becomes Failed and the Owner is notified. Payloads never contain secrets, and errors pass through a redactor.

## B9. External calls

| Service | Calls |
|---|---|
| Mailgun (`api.eu.mailgun.net` or `api.mailgun.net`, Basic `api:<key>`, a Developer-role key) | `POST /v3/{d}/messages` · `POST /v1/analytics/logs` · `GET /v3/{d}/bounces`, `/complaints`, `/unsubscribes`, `POST /v3/{d}/unsubscribes` · `GET/POST/PUT /v4/domains/{d}/webhooks` · `GET /v5/accounts/http_signing_key` · `GET/POST/PUT/DELETE /v3/routes`, `GET /v3/routes/match` · `GET /v3/domains/{d}/messages/{key}` · `GET/POST /v4/address/validate` · `GET /v4/domains/{d}`, `PUT /v4/domains/{d}/verify`, `PUT /v4/domains/{d}` · `POST /v2/x509/{tracking-host}` (+ status) · `GET /v3/domains/{d}/tracking`, `PUT …/tracking/open`, `/click`, `/unsubscribe` · `GET /v3/domains/{d}/sending_queues` |
| Claude API | `messages.create` · `messages.countTokens` · `models.retrieve` |
| Company websites | `robots.txt`, homepage, one more page |
| DNS (`node:dns` Resolver via 1.1.1.1 and 8.8.8.8) | DMARC (with parent-domain fallback), SPF and MX |
| cloudflared (local only) | `/ready` on 127.0.0.1:20241–20245 |

Tests never call real services. They use a local fake Mailgun server, a fake verifier, a mocked Claude and the fixture fetcher. My own checks after each milestone use a separate test database and the fake Mailgun, never your database or keys.

## B10. Security

- **Sessions.** Stored in the database (hash of a 32-byte token). The cookie is `httpOnly` and `SameSite=Lax`, and `Secure` whenever `x-forwarded-proto=https` (the tunnel). It can't be Secure on the http LAN address, because browsers would refuse it there. Sessions last 30 days, sliding: the database expiry is the one that counts, and about once a day the proxy re-issues the cookie with a fresh 30-day expiry so the browser's copy slides too. The practice copy uses its own cookie name (`pp_session_demo`), so signing in there never signs you out of the real app. A password change or reset revokes the user's other sessions, and deactivation revokes all of them.
- **Passwords.** Argon2id, at least 10 characters.
- **Login throttling.**
  - The source key is best-effort: `tunnel:` + CF-Connecting-IP when that header is present, otherwise `lan:` + x-forwarded-for. Next fills that header from the socket only when the client sent none, so both can be faked from the office network.
  - After 5 failures from one source in 15 minutes, that source also waits a minute after its last failure. It is only ever a wait, never a lock, and other sources are unaffected.
  - **The real protection** is the growing per-account wait across all sources (1–30 s). No header can avoid it, and because it isn't a hard lock, an internet attacker can't lock the Owner out.
  - Waits are enforced by refusing ("Too many tries. Wait N seconds and try again."), never by sleeping. Every password check (sign-in and Settings → change password) goes through one gate: one check per account at a time, and the try is recorded before the password is checked, so parallel guesses can't slip through together.
  - An unknown email, a wrong password and a switched-off account all get the same generic message and the same Argon2 work. The first time one source reaches 5 wrong passwords for a real account, it is logged and the Owner is notified.
  - `reset-password.bat` (on the PC only) resets any user, clears failed tries and revokes sessions.
- **First-run setup.** A 128-bit code, whose SHA-256 is stored in `.env`, compared in constant time, 10 wrong codes an hour per source (setup.bat clears them whenever it prints a new code). It is refused through the tunnel (any request carrying CF-Connecting-IP). Owner creation runs in one transaction that re-checks "no users".
- **`setup.bat` is idempotent.** It never overwrites the encryption key or the database, and only runs `migrate deploy`. While no user exists, re-running it replaces only `SETUP_CODE_HASH`, prints a new code and waits for a key press so the window stays open. Once an Owner exists, it prints "Setup is already done".
- **Owner safety.** There is always exactly one active Owner: the last one can't be deactivated, and ownership is transferred with confirmation.
- **Sender addresses.** Validated, unique and reserved-name checked. Changes are logged and notified, and blocked while that user has active campaigns (because of the sender snapshot). "Send me a test" goes only to the user's own inbox, is limited to 20 per day, counts toward the domain cap, and is refused for suppressed addresses.
- **Secrets.** AES-256-GCM (`v1:iv:tag:ct`, with the setting name as AAD, `authTagLength:16`), using `APP_ENCRYPTION_KEY` from `.env`. Secrets are never sent to the browser or written to logs, and job payloads and results never contain them.
- **Webhooks.** B6.11.
- **Cloudflare Access**, in this order, before the tunnel route is added:
  1. Add the One-time PIN identity provider (new Zero Trust organisations don't have it).
  2. Create the main app for the hostname, with an Allow policy whose Include is an **Emails list**. Never "Login Methods: One-time PIN" on its own, which lets anyone in.
  3. Create a **separate** app for `/api/webhooks/*` and `/api/health` with Bypass/Everyone. Never put a bypass policy on the main app.
  4. Add the tunnel route, leaving "Protect with Access" off and HTTP Host Header empty.
- **Forms.** Server actions use Next's Origin check. Our routes use `assertSameOrigin` for state changes, and nothing changes on GET.
- **Website reading.** SSRF-safe (B6.12); page text is treated as untrusted.
- **Uploads and exports.** Files are capped at 8 MB. All CSV output is formula-escaped (B6.13).
- **Cloudflare zone.** Email obfuscation off, Bot Fight Mode off, and a WAF Skip rule for `/api/webhooks/*`.
- **Firewall.** B11.

## B11. Windows operations

**Services (`install-services.bat` → `install-services.ps1`, elevated)**

- NSSM comes from `tools/`, with its SHA-256 re-checked.
- Two services, run as **`NT SERVICE\OutreachWeb`** and **`NT SERVICE\OutreachWorker`**, the password-free virtual accounts. The script (`node scripts\service-acl.mjs grant`) gives both accounts read and execute on the project folder, and Modify (`(OI)(CI)M`) only on `data`, `backups`, `logs`, `run` and `.next`, plus the database's own folder when `.env` points elsewhere and the second backup folder when it's on a local drive (never a whole drive, a network share or a folder that contains the project). The folders it granted are listed in `run\service-acl.txt`, which `uninstall-services.bat` reads to remove the grants.
- Service settings: `Start SERVICE_DELAYED_AUTO_START`, `AppDirectory <project>`, `AppExit Default Restart`, `AppRestartDelay 5000`, `AppStopMethodConsole 4000`, `AppStdout/AppStderr logs\*.log`, `AppRotateFiles 1`, `AppRotateOnline 1`, `AppRotateBytes 10485760`, `AppEnvironmentExtra NODE_ENV=production`.
- The script refuses to continue while port 3000 is in use or `run\supervisor.pid` points to a running process (that means start.bat is still open). It checks for SERVICE_RUNNING and a healthy `/api/health` before reporting success.
- WinSW 2.12 is the documented fallback.
- Controlled folder access is currently off on this PC. If it's ever turned on, node.exe must be allowed.

**Scripts** (all CRLF, all using `call npm …` or node directly; PowerShell runs as `-NoProfile -ExecutionPolicy Bypass -File`)

- `setup.bat`: check Node → `npm ci` → native-module smoke test and ABI record → create `.env` if missing (asking for the public address, which can be skipped) → `migrate deploy` → build → print the setup code (B10).
- `start.bat`:
  - **with services installed:** elevate, start both services, wait for `/api/health`, open the browser. It never builds or migrates in this mode;
  - **without services:** `run-prod.mjs` checks Node, migrates, builds when the build is missing or stale, starts web and worker with IPC, and prints the LAN and https addresses.
- `stop.bat`: elevate; stop the worker, then web; wait until they report STOPPED.
- `update.bat`: elevate → stop both → backup → `npm ci` → native smoke test → `migrate deploy` → `next build` and the worker bundle → start → health check. If any step fails, it stops with a plain message and the restore command.
- `restore.bat` (B6.7), `reset-password.bat`, `start-demo.bat` (port 3001, `data/demo.db`).
- `status.bat`: services and health. It also warns about any enabled Public-profile rule that allows node.exe or port 3000, and about any enabled inbound Block rule for node.exe or port 3000.

**PC setup (`setup-pc.bat`, elevated, each step confirmed)**

1. `Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private`, for the confirmed office network only.
2. `Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' | Disable-NetFirewallRule`, and remove any inbound Block rules for node.exe.
3. `New-NetFirewallRule -Name Outreach-Web-In -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet`.
4. Verify that no enabled Public-profile rule allows node.exe or port 3000.
5. `powercfg /change standby-timeout-ac 0`, `powercfg /change hibernate-timeout-ac 0`, `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0`, `powercfg /setactive SCHEME_CURRENT`. Battery settings are left alone, and hibernation is never disabled.

The README adds: "If Windows asks whether to allow Node.js through the firewall, tick only 'Private networks' (untick 'Public networks') and click Allow. If you clicked Cancel by mistake, run setup-pc.bat again: it removes the block rule that Cancel creates."

- **Windows Update:** active hours 08:00–02:00 if Windows accepts a window that crosses midnight (checked in Milestone 1). Otherwise, the widest window that covers 11:00–23:00 Pakistan time.
- **cloudflared:** install the MSI or winget package first, then run `cloudflared service install <token>` from an elevated PowerShell in its program folder, then clear the token from the PowerShell history. Update monthly (`cloudflared update`, then `net start cloudflared`), and never use 2026.8.0 or 2026.8.1.
- **Node ABI guard:** web and worker compare `process.versions.modules` with the value recorded at install, and refuse to start with "Node was updated: run update.bat". The README says: install Node only from nodejs.org, and don't let winget move the PC to Node 26 without running `update.bat`.
- **Antivirus:** the README's troubleshooting section covers nssm.exe or the Prisma engine being quarantined.
- **My own builds:** I stop the services before building in the project folder.

## B12. Testing

- **Unit tests (Vitest)**
  - template rendering: variables, fallbacks, line removal, stable variations, warnings, escaping, HTML, footer;
  - import: header matching in English, German and Norwegian; grouping with union-find; shared domains, including 500 Instagram-URL rows; duplicates; old statuses; semicolon and windows-1252 CSV; xls and xlsx fixtures; pasted rows; round-trip re-import; formula-escape round trip;
  - the 30-day rule and reservations: two campaigns with the same company; soft-deleted and re-imported companies; gmail.com and instagram.com never matched;
  - follow-up scheduling across weekends and DST, threading headers, every stop rule, and the outage hold;
  - sending hours, pacing, caps (including the cap-day boundary), the warm-up table and its evaluation, and health: small samples, and **no re-trip after resume** without new events;
  - webhook signatures: valid, tampered (401), stale (406), replayed;
  - reply matching (headers, from-address, unlinked), auto-replies in three languages, possible replies;
  - verification mapping and policy;
  - AI checks and the link picker (fixture sites);
  - encryption, throttling, SSRF targets (127.0.0.1, localhost, [::1], ::ffff:127.0.0.1, 169.254.169.254, 100.64.0.1, 192.168.x.x, and a redirect to one of them).
- **Integration tests** (temporary databases, fake Mailgun)
  - the crash-safe state machine, including a transaction rollback running beside a claim;
  - reconciliation and Unconfirmed;
  - the restore scenario (no second send);
  - events applied in reverse order give the same result;
  - two processes writing at once;
  - a dry-run campaign is never sent after switching to live;
  - Owner-only actions refused for Members;
  - the auth-coverage test.
- **End-to-end (spec definition of done)**, in the practice configuration with a controllable clock and mocked Claude and fetcher:
  1. import a CSV;
  2. draft and approve lines;
  3. create a campaign with 2 follow-ups, review it and launch it;
  4. advance the clock;
  5. post signed bounce, unsubscribe and reply webhooks;
  6. assert the exact numbers: company and person statuses, recipient states (bounced stopped, unsubscribed stopped, the replier's whole company stopped), follow-ups sent only to the others, the notifications each user received, and the dashboard tiles (pipeline counts, reply rate, sent today, bounce and complaint rates).
- **Screen checks (Playwright + axe).** Every new screen: screenshots, the main actions, empty states, error messages, and contrast and keyboard checks.
- **Every milestone ends with** `npm run check` (tsc, eslint, vitest), `next build` on Windows, starting the app and worker, and the screen checks.
