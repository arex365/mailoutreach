# Polygon Paradise Outreach

Polygon Paradise Outreach is the studio's outreach app: your companies and people, lists, who was emailed and when, campaigns with follow-ups, replies, address checks and AI personal lines. It runs on the office PC. Office staff open it at `http://<this-PC's-address>:3000`; remote staff use a secure https address through Cloudflare.

Three background programs start with Windows: the app itself, the background sender (it sends the emails, checks with Mailgun and makes the daily backup) and Cloudflare's tunnel (the secure address). Everything the app knows lives in one file, `data\app.db`.

The practice copy (`start-demo.bat`) is a separate copy with made-up companies, for trying things out. Nothing is ever sent from it, and it never touches your real data.

These files are easiest to read in a browser or VS Code; in Notepad they show as plain text, which still works.

## Start here

Set the app up with these guides, in this order:

- [ ] 1. [Install guide](docs/setup/1-install.md): the app on this PC, the Owner account, the background services and the office network (about 30 minutes).
- [ ] 2. Mailgun, with one of two guides:
  - **Your setup:** the [Own-mailbox guide](docs/setup/2-own-mailbox.md): the app sends through polygonparadise.com and replies come to contact@polygonparadise.com, on Mailgun's Free plan. It also takes you through the reply test (by hand), a first live campaign to your own test mailboxes and going live (about an hour of clicking, over a day or two).
  - The [Mailgun guide](docs/setup/2-mailgun-and-dns.md) is the full setup (Mailgun Foundation, replies through the app): the sending subdomain mail.polygonparadise.com, Mailgun, the DNS records, your From address contact@polygonparadise.com, the reply test and a first live campaign to your own test mailboxes (about an hour of clicking, over 1 to 2 days). Its step 10 sends you to guide 3 and back.
- [ ] 3. [Cloudflare guide](docs/setup/3-cloudflare.md): the app's secure public address, for remote staff and Mailgun (about 45 minutes, plus up to 24 hours of waiting; optional in the own-mailbox setup).
- [ ] 4. [Going-live guide](docs/setup/4-going-live.md): the rehearsal, a practice restore, the **Go live** switch, warm-up and your first real campaign.

**Have these ready:**

- nothing new to buy for sending: in your setup the app sends through polygonparadise.com itself, and your emails show From contact@polygonparadise.com (you may still want a cheap second domain for the app's address);
- your Mailgun account: the **Free** plan is enough for your setup; the full setup (the Mailgun guide) needs the **Foundation** plan (an existing Free or trial account must be upgraded), with Mailgun's business verification started early (it can take days);
- access to polygonparadise.com's DNS records at GoDaddy;
- a Cloudflare account, and a payment card for Cloudflare Access (it isn't charged), if you use the Cloudflare guide;
- an Anthropic account with some credit, if you want AI personal lines;
- 2 or 3 test mailboxes: at least one Outlook.com and one Gmail or Yahoo mailbox, none of them your reply inbox or contact@polygonparadise.com.

**Put the app folder in `C:\Outreach`**, never in Desktop, Documents, Pictures, OneDrive or Dropbox: a sync program or Windows' ransomware protection can take the database over there. The [Going-live guide, step 4](docs/setup/4-going-live.md#4-the-pc) says how to move it.

### Install and first run

1. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi). Only ever install Node.js from nodejs.org's 24.x folder, and never let winget or Windows move this PC to Node 26: the app refuses it. If Node.js changes anyway, the app says "Node was updated: run update.bat": if it's now Node 26, uninstall it and install Node.js 24 again ([Install guide, Troubleshooting](docs/setup/1-install.md#12-troubleshooting)), then double-click `update.bat`.
2. Double-click `setup.bat` and write down the setup code it prints.
3. Double-click `start.bat`, open `http://localhost:3000` and create the Owner account with that code. Close any window running `npm run dev` first; the first start builds for a few minutes.
4. Close the start.bat window, then double-click `install-services.bat`, so the app starts with Windows.
5. Double-click `setup-pc.bat` for the office network, the firewall and the power settings.

If Windows asks whether to allow Node.js through the firewall, tick only "Private networks" (untick "Public networks") and click Allow. If you clicked Cancel by mistake, run setup-pc.bat again: it removes the block rule that Cancel creates.

The details are in the [Install guide](docs/setup/1-install.md).

### Mailgun, DNS and reply routes

**Your setup** (the [Own-mailbox guide](docs/setup/2-own-mailbox.md)): Mailgun sends through one domain, **polygonparadise.com** itself (US region), on the Free plan. Every email shows From **contact@polygonparadise.com** with the sender's own name, and replies go straight to contact@ in Zoho Mail, never through the app. There are no reply routes and nobody has a sending or reply address. In **Settings › Sending & Mailgun**, **How the app sends** is **From polygonparadise.com itself (replies come to your own inbox)**. The only DNS record to add is `_dmarc`. **Never add Mailgun's MX records to polygonparadise.com and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving.** The checklist row "Mail for polygonparadise.com stays with your mail provider (MX)" watches it.

**The full setup:** every email shows From **contact@polygonparadise.com**, with the sender's own name, for example "Arslan from Polygon Paradise <contact@polygonparadise.com>". Mailgun sends it through **mail.polygonparadise.com**, a part of your own domain that only Mailgun handles. The [Mailgun guide](docs/setup/2-mailgun-and-dns.md), steps 3 to 8:

- moves your Mailgun account to the Foundation plan and adds mail.polygonparadise.com in Mailgun, in the **US** region. polygonparadise.com stays in Mailgun too: it signs your emails, so never delete it;
- creates the API key and connects it in **Settings › Sending & Mailgun** (the key goes there, never into `.env`), then sets contact@polygonparadise.com in the **From address** card on the same page;
- adds the DNS records that **Settings › Domain checklist** shows with Copy buttons: SPF, MX and the tracking CNAME for `mail`, and DMARC for polygonparadise.com.

**Never point polygonparadise.com's mail servers (MX) to Mailgun**: its mail stays with Zoho Mail, and the checklist row "Mail for polygonparadise.com stays with your mail provider (MX)" watches it. Each person has a **Reply address** on mail.polygonparadise.com (for example arslan@mail.polygonparadise.com): when a prospect presses Reply, the answer goes there. **Apply recommended settings** (step 11) creates the reply routes: Mailgun passes a copy of each reply to the app and forwards the reply to that person's reply inbox. Step 15 shows them in Mailgun: never edit or delete routes whose description starts with `outreach-app:`.

### Tracking off, unsubscribe on

**Apply recommended settings** on **Settings › Domain checklist** ([Mailgun guide, step 11](docs/setup/2-mailgun-and-dns.md#11-apply-recommended-settings)) switches off open and click tracking, switches on Mailgun's unsubscribe handling with Mailgun's own footers left blank, and sets up secure (https) unsubscribe links. Every email then carries a personal unsubscribe link in your footer. The checklist rows "Open and click tracking are off" and "Unsubscribe handling is on" confirm it. If Mailgun keeps its own footer, step 11 shows how to set it by hand. On Mailgun's Free plan (your setup, [Own-mailbox guide, step 7](docs/setup/2-own-mailbox.md#7-check-and-apply)) the unsubscribe links use http: they work when clicked, but Gmail's and Yahoo's one-click unsubscribe button may not show.

### Cloudflare Tunnel and optional Access

The [Cloudflare guide](docs/setup/3-cloudflare.md) gives the app a secure https address through a Cloudflare Tunnel (nothing changes on your router), and puts Cloudflare Access in front of it: a login with a code sent by email, before the app's own sign-in page. Access is optional and recommended. The guide's box "Skipping Cloudflare Access" says what happens without it, and the switch **We don't use Cloudflare Access** in **Settings › System** tells the app. Update cloudflared every month or two ([Cloudflare guide, step 15](docs/setup/3-cloudflare.md#15-keeping-cloudflared-up-to-date)), but never use version 2026.8.0 or 2026.8.1. In the own-mailbox setup the whole Cloudflare guide is optional: without it the app works on this PC and the office network, and Mailgun's reports reach the app through its hourly check.

## Everyday use

### The dashboard

After signing in, everyone lands on the **Dashboard**:

- **Get started** (for the Owner until you go live, and for everyone while there are no companies yet): the steps to the first real campaign: import companies, invite your team, connect Mailgun, protect your data (a second backup folder and a copy of `.env`), and go live.
- **Needs your attention**: what stops or holds sending comes first (sending paused, the background sender not running, a check after a restore, a nearly full disk), then replies waiting per person ("Replies waiting for an answer: You 3 · Ali 1"), in the own-mailbox setup live follow-ups waiting for today's inbox check, AI lines to review, paused campaigns, emails the app isn't sure were sent, companies without an email address, and backup, Mailgun or remote-access problems. Each line says what to do. Where only the Owner can fix something, Members see "Ask the Owner to fix this." When nothing needs you: "Nothing needs your attention right now."
- **Replies waiting for an answer**: your own, oldest first. The app can't see your inbox: answer in your email program, then click **Answered** (or **No answer needed**). In the own-mailbox setup replies never reach the app, so this stays empty and says "Replies go straight to contact@polygonparadise.com, not to the app. When someone answers, click They replied on their company."
- **The numbers**: **Companies** (how many in each status, and the reply rate), **Today** (emails sent today against today's limit, and the warm-up), **Active campaigns** with their progress, **Domain health** (bounces and spam complaints), **Recent team activity**, and **Dry runs and test mode** (only when there are any; they never count in the other numbers).

The **reply rate** is: of the companies the app has emailed, how many replied, for example "Reply rate: 20% (1 of 5 companies you emailed replied)". The second line counts only companies first emailed in the last 30 days. Dry runs never count.

The dashboard refreshes itself every minute.

### Contacts, lists and statuses

- **Contacts** lists every company with its people, in lists (left column). Click a company to open its panel: people, notes, history and campaigns.
- **Import** reads a spreadsheet, or rows pasted from Excel or Google Sheets, and finds duplicates for you.
- Every company has a status: **Not contacted**, **Contacted**, **Replied**, **Client**, **Not interested** or **Do not contact**. The app sets Contacted and Replied by itself; the others are yours to set. "Do not contact" companies are never emailed.
- **Last emailed** says when the app last emailed the company. Test emails to your own test mailboxes before going live don't count: there it says "Never", with the tooltip "Test emails before going live don't count as emailed."
- The **Missing email view** lists companies without an email address.

### A campaign in six steps

In **Contacts**, tick companies and click **Email these companies** (or **Campaigns** › **New campaign**). Then:

1. **Audience**: who gets it. People who can't be emailed are left out, with the reason.
2. **Sender**: whose name, reply address and signature it goes out with (in the own-mailbox setup: whose name and signature; every email comes from contact@polygonparadise.com).
3. **Message**: the template, and its follow-ups (sent in the same email thread after their wait, unless someone at the company replies).
4. **Verify**: address checks with Mailgun, with the cost shown first.
5. **Review**: every email as it will go out. **Send me a test** sends one to your own reply inbox.
6. **Schedule**: when it starts. Then **Launch campaign**.

A campaign keeps the mode it was launched with (dry run, test mode or live), whatever the setting says later.

### Replies

- **In your setup replies don't reach the app at all.** They land in contact@polygonparadise.com (look in its Spam folder too). When someone answers, open the company and click **They replied**: it stops every follow-up. For "please remove me" or a "couldn't be delivered" notice, click ⋯ › **Mark unsubscribed** on that person. Then click **I've read contact@polygonparadise.com** on the Notifications page: live follow-ups wait for that each day. ([Own-mailbox guide, step 12](docs/setup/2-own-mailbox.md#12-every-working-day).) The rest of this section is about the full setup, where replies come back through the app.
- **The app can't see your inbox.** When a prospect presses Reply, the answer goes to the sender's reply address; Mailgun forwards it straight to the sender's reply inbox, and you answer it there as usual. Mailgun also passes a copy to the app, which uses it to stop the follow-ups.
- **Replies sent straight to contact@polygonparadise.com don't reach the app.** Most people press Reply, which goes to the sender's reply address and through the app. When someone writes a new email to contact@ instead (or a colleague of theirs does), click **They replied** on that company (or set its status to **Replied**) so the follow-ups stop. If someone asks there to be removed, or contact@ gets a "couldn't be delivered" notice about a campaign email, set the company to **Do not contact** (the Owner can also put just that address on the do-not-email list: Settings › Deliverability › Add an address). Forwarding such an email from contact@ to a reply address doesn't help: the app treats mail from contact@ as your team's own.
- **When someone at a company replies, that company's follow-ups stop**, in every campaign. Out-of-office and other automatic replies are logged, and the follow-ups continue. When the app isn't sure whether a message is a real reply, the company's follow-ups wait until someone chooses **Real reply** or **It was an auto-reply** on the Notifications page.
- **Replies waiting for an answer** are on your dashboard (your own) and on the Notifications page (everyone's). After answering in your email program, click **Answered** (or **No answer needed**) so the reply leaves the list. Everyone on the team can see and mark any reply; the timeline records who did what.
- **Reply texts are kept for 30 days**, then only their first lines stay: the app is not a second inbox.
- To practise, use the practice copy: in the dry-run outbox, **Simulate** has Reply, Out-of-office and Unclear reply buttons. In the practice copy (start-demo.bat) simulated replies stop follow-ups by themselves; in your real setup they don't: practise They replied there too.

### Notifications

The bell at the top shows what's new for you: replies, finished campaigns, finished address checks, AI lines to review, and problems the Owner should know about. The **Notifications** page lists them all. In **Settings › Notifications** each person can switch on desktop pop-ups for this computer (they need the https address; browsers don't allow them on the office http address).

### AI personal lines

Claude can draft one specific sentence per company from its website, which then appears in the first email where the template has `{{personal_line|}}`. Nothing is used until someone approves it.

- **Start:** tick companies in Contacts and click **Draft personal lines**, use a list's **⋯** menu, or **Draft with AI** in the company panel. The dialog says how many companies it will read, which are skipped (no website, only Instagram or a marketplace link, already has a line) and what it costs: about $1.69 per 300 companies with Claude Haiku 4.5, at most $3.15.
- **Review** on the **AI lines** page (the sidebar shows how many wait): each card shows the line, the words from the website it's based on, and a link to that page. **Approve**, **Edit then approve**, **Reject** or **Regenerate**. Only approved lines are used, also in emails of running campaigns that haven't gone out yet.
- **No line:** websites that are parked, "coming soon", need JavaScript, block robots or are only Instagram get "No line" without paying for Claude. **Write one yourself** opens the company panel.
- **Settings › AI** (Owner): the Anthropic API key, the model (Claude Haiku 4.5, or Claude Sonnet 5 for higher quality), and the **monthly limit ($20 by default, counted in Pakistan time; drafting starts again on the 1st)**. Set a spending limit in the Anthropic Console too.
- The app reads websites as "PolygonParadiseBot": the homepage and one more page, following each site's robots.txt and waiting between requests.
- In the practice copy, drafting writes made-up practice lines for free and reads no website.

### Address checks

Before a campaign emails anyone, the app can ask Mailgun whether each address really exists. It never emails an address that doesn't exist or that Mailgun says not to email. After going live, live campaigns only email checked addresses.

- **Where checks start:** the campaign's **Verify** step, Contacts (tick companies, then **Check emails**), a list's **⋯** menu › **Check emails**, and the **Check** button next to a person in the company panel. Each one shows how many addresses need a check and what it costs before anything happens.
- **What's checked:** addresses never checked, or checked more than 90 days ago. Dry runs never need checks.
- **Your rules** (**Settings › Deliverability** › **Address checks**): "can't confirm, low risk" is emailed, medium and high risk ones are skipped, throwaway addresses are skipped, and "no answer" is checked again once after 24 hours. You can change each rule.
- **Addresses that don't exist, or that the check says not to email, go on the do-not-email list** as "Invalid" (source "Address check"). They aren't sent to Mailgun's unsubscribe list. They stay on the list for good: Settings › Deliverability offers **Remove** only for your test-list addresses and your team's reply inboxes. If the address itself was wrong, change it on the person (the company panel's **Did you mean** suggests one when the check spots a typo); the new address can be checked again.
- **What it costs:** about $0.012 per check (see "What it costs"). The app has its own **monthly check limit, $100 by default** (Settings › Deliverability): checks stop there until the 1st or until you raise it.
- In the practice copy, checks use a free test checker that never talks to Mailgun.

### Missing emails with Claude

On Contacts › **Missing email**, **Export** › **Export for Claude** downloads the companies without an email address and gives you the instruction to paste into Claude. Import the file Claude sends back on the **Import** page: the app recognises the `company_id` column, adds the people only to those companies, skips addresses it already has, and puts Claude's source link and note on the person's notes. It never creates or changes companies. A Contacts export also has a `company_id` column, so to update companies from a re-imported Contacts export, set **company_id** to **Ignore this column** on the Match columns step.

### The top-bar label

The label at the top of every page says what sending does right now. The Owner can click it to open Settings › Sending & Mailgun.

| Label | Meaning |
|---|---|
| **Dry run** | Nothing leaves this PC. Campaigns fill the dry-run outbox so you can read every email. |
| **Test list only** | Emails go through Mailgun, but only to the addresses on your test list: Live mode before going live (real emails, test list only), and Test mode (Mailgun's test mode: accepted, never delivered), which only ever emails your test list, also after going live. It also shows while an earlier test campaign, or a live one launched before going live (it only ever emails your test list), is still sending, even when the setting is back to dry run or Test mode, so the label never says less than what is going out. |
| **Sending live** | After going live: Live mode, or a live campaign launched after going live that is still sending. Real emails to everyone eligible. |
| **Paused: …** | Nothing is sent, not even dry runs, until the Owner clicks **Resume sending**. The words after "Paused:" say why, for example "7 of the last 200 emails bounced". Settings › Sending & Mailgun says what to do. |
| **Status unavailable** | The label couldn't be loaded. Refresh the page. |

## Your team

Everyone who works in the app has their own account. There is always exactly one **Owner**, who can change settings, keys, limits and the team. Everyone else is a **Member** and can do everything else.

**Invite someone** (Owner):

1. Open **Settings › Team** and click **Invite a teammate**.
2. Type their **Name** and **Email** and click **Create invite link**.
3. Send them the link yourself (WhatsApp or email): the app never emails it. It works once, for 3 days (72 hours). There is a link for the office network and, once Cloudflare is set up, a link that works anywhere.
4. They open it and choose their own password.

If the link expired or got lost, open the person's **⋯** menu in the team list and click **New invite link**.

**Remote staff** also need to be on Cloudflare's **Outreach staff** list, or Cloudflare doesn't let them reach the app ([Cloudflare guide, step 4](docs/setup/3-cloudflare.md#4-two-policies-who-may-log-in-and-what-is-public)). Remove people there when they leave.

**Each person**, once signed in, opens **Settings › My profile** and fills in their **Reply address** (the part before the @ on mail.polygonparadise.com), their **Sender display name** (for example "Arslan from Polygon Paradise"), their **Reply inbox** (a normal mailbox, never on mail.polygonparadise.com; contact@polygonparadise.com is fine), their **Signature** and **Time zone**, then clicks **Save profile**. Under the reply address it says "Reply route: Being set up…", then "Reply route: working" within a minute or two. Until then they can't send live campaigns. Prospects see the display name with contact@polygonparadise.com, and their replies go to the reply address, then on to the reply inbox.

The practice copy has no From address, so it still says **Sending address** and shows a placeholder From; the real app says Reply address.

In the own-mailbox setup nobody has a reply address or a reply route: **Settings › My profile** shows "Your emails show "Arslan from Polygon Paradise <contact@polygonparadise.com>". Replies go straight to contact@polygonparadise.com.", and the inbox field is called **Inbox for your test emails** (where **Send me a test** sends your test emails). Everyone fills in their **Sender display name**, that inbox, their **Signature** and **Time zone**, then clicks **Save profile** ([Own-mailbox guide, step 8](docs/setup/2-own-mailbox.md#8-profiles)).

**In the team list's ⋯ menu** (Owner):

- **Switch off**: the person is signed out everywhere and can't sign in; their history stays. You choose whether their campaigns pause or finish, and their replies waiting for an answer move to you. **Switch back on** undoes it.
- **Make Owner**: hands the Owner role to someone else. You become a Member.
- **Reset password link**: a link for someone who forgot their password (works once, for 24 hours). It isn't offered for yourself: the Owner uses `reset-password.bat` on the office PC.

**Per-sender limits:** **Settings › Limits & warm-up** › **Per-sender limits** gives one person a daily limit of their own. Empty means no limit of their own; the domain's daily limit always applies to everyone together.

After 5 wrong passwords in 15 minutes, the next tries from that computer wait a minute each.

## Sending safely

- **Sending hours.** Emails go out only inside each company's sending hours: Monday to Friday, 9:00 to 17:00 in the company's own time zone by default (a company without a country uses Berlin time). **Settings › Limits & warm-up** › **Sending hours and limits**.
- **The daily limit and warm-up.** At most 1,000 emails a day, counted from midnight to midnight Pakistan time. Sending starts lower: on the day you go live the warm-up starts at 50 a day and goes up one step ("Warm-up step 3 of 20: 69 a day") after each weekday with at least half the limit used and healthy numbers; otherwise the step holds. That's about 4 weeks to 1,000 at the earliest. When today's limit is reached, the rest go out on the next sending day. See the [Going-live guide, step 9](docs/setup/4-going-live.md#9-warm-up).
- **Mailgun's Free plan** (the own-mailbox setup): at most 90 campaign emails a day (10 are kept for test emails), so the warm-up rises from 50 to 90 instead of 1,000, and never more than 100 emails in any 24 hours: the rest wait ("Waiting: your Mailgun plan's daily limit is used up. The next email can go at …"). Mailgun keeps logs for 1 day: keep the office PC on, with start.bat running, on working days, and over the weekend if you can. If it was off for longer, unsubscribes, complaints and bounces still come back through Mailgun's lists and still count toward the automatic pause ([Own-mailbox guide, step 13](docs/setup/2-own-mailbox.md#13-the-free-plans-limits)).
- **Always start the app with start.bat**, never `npm run dev`: only start.bat runs the background sender, which sends, checks and hears from Mailgun. Close any window running `npm run dev` first.
- **The automatic pause.** If too many emails bounce (by default more than 6 of the last 200) or are marked as spam (more than 1 of the last 1,000), sending pauses by itself, for example "Paused: 7 of the last 200 emails bounced". **Settings › Deliverability** lists each bounce and complaint with its campaign and lists: fix or remove that list, then click **Resume sending** in Settings › Sending & Mailgun. Resuming starts a fresh count. After going live, the numbers count from the day you went live on mail.polygonparadise.com. Going live again after a From address change doesn't start a fresh count: the emails still go through the same sending domain, so the bounces and complaints from before the change keep counting. The limits are in **Settings › Deliverability** › **Thresholds**.
- **Pause all sending.** **Settings › Sending & Mailgun** › **Pause all sending** stops every campaign at once, dry runs included, until you click **Resume sending**.
- **The 30-day rule.** When someone on the team emailed a company, nobody else can add it to a campaign for 30 days; it's checked at launch and before every email. The length is a setting: **Settings › Limits & warm-up** › **The 30-day rule**, together with how long a paused campaign keeps its companies (14 days) and your own list of shared email domains (like gmail.com, which many unrelated companies use). The rule keeps its name "30-day rule" whatever its length. Saving asks you to confirm when it would change running campaigns. Companies the app already grouped stay as they are when you add a shared domain.
- **Your main address's reputation.** Every email shows From contact@polygonparadise.com, so your everyday email from polygonparadise.com shares its reputation: if people mark these emails as spam, your normal emails can land in spam too, and that takes weeks to fix. That was your decision, made knowing this. The app pauses sending when Mailgun reports complaints (from Microsoft, Yahoo and others), but Gmail and Google Workspace never report complaints: only Google Postmaster Tools shows those. So keep **Settings › Deliverability** › **Thresholds** as they are, and once a week look at the dashboard's **Domain health**, at Settings › Deliverability and at Google Postmaster Tools for polygonparadise.com ([Mailgun guide, step 16](docs/setup/2-mailgun-and-dns.md#16-optional-gmails-dashboard-and-your-domains-age)). **The way back**, if you want emails to come from each person's own address again, in this order:
  1. Click **Pause all sending** (Settings › Sending & Mailgun). Nothing more goes out while you make the change.
  2. Cancel every test or live campaign that is scheduled, running or paused: open it under **Campaigns** and click **Cancel campaign**. The From address can't change while one of them is, and nothing finishes while sending is paused. To let a campaign finish instead, click **Resume sending** and wait until it has finished: until then it keeps sending From contact@polygonparadise.com, because each campaign keeps the From it started with.
  3. Empty the From address and click **Save From address** (after going live the app asks first: click **Change it**). Emails then come from each person's own address on mail.polygonparadise.com.
  4. If sending is still paused, click **Resume sending** (Settings › Sending & Mailgun). The reply test can't send while sending is paused.
  5. Run the reply test again ([Mailgun guide, step 13](docs/setup/2-mailgun-and-dns.md#13-the-test-list-and-the-reply-test)) and send a live campaign to your test list ([Going-live guide, step 3](docs/setup/4-going-live.md#3-rehearse-with-your-test-mailboxes)). Then click **Check again** on the Domain checklist and go live again ([Going-live guide, step 8](docs/setup/4-going-live.md#8-switch-on-go-live)).

  In the own-mailbox setup an empty From address stops test and live campaigns altogether, because every email needs contact@polygonparadise.com: there, move to the full setup first ([Own-mailbox guide, step 15](docs/setup/2-own-mailbox.md#15-switching-to-the-full-setup-later)), then follow the order above. Watch Google Postmaster Tools as that guide's step 14 says.
- **Going live.** Until you switch on **Go live**, real email only ever reaches your test list. The [Going-live guide](docs/setup/4-going-live.md) says what going live changes. It can't be switched off. If you change the sending domain, **How the app sends** or the From address later, going live ends and you go live again after the checklist, the reply test and a live campaign to your test list ([Going-live guide, step 13](docs/setup/4-going-live.md#13-changing-the-sending-domain-or-the-from-address-later)).

## When the PC is off, and keeping it awake

The app only sends while the office PC is on and awake.

- **Bounces, unsubscribes and complaints are never missed.** Mailgun keeps these lists, and the app reads them again when it starts and every hour.
- **Replies always reach the sender's inbox straight away**, whether the PC is on or off: Mailgun forwards them itself.
- **The app can notice a reply** that arrived while the PC was off for up to about 5 days (what Mailgun's Foundation plan keeps). It can show the reply's first lines only if the PC is back within 1 day; replies recovered without their text wait on Notifications as possible replies.
- **If the PC was off for more than 5 days**, the app can't be sure it saw every reply, so it **puts the follow-ups on hold**: follow-ups of people emailed before the gap, and first emails to anyone else at those companies. Each sender gets a notification with the dates, checks their inbox for replies from those days, then clicks **I've checked my inbox** on the Notifications page. The Owner can click **Continue follow-ups** in Settings › Sending & Mailgun for anyone.
- **Emails simply wait** while the PC is off. After the PC starts, emails through Mailgun wait until the app has checked with Mailgun, which normally takes a minute. Follow-ups always wait for that check; first emails carry on anyway if Mailgun can't be reached for 15 minutes because of a network problem, and the app tells you if it hasn't been able to check for 3 hours.
- **In the own-mailbox setup** replies never pass through Mailgun, so the two points above about noticing replies and putting follow-ups on hold don't apply: live follow-ups wait for the daily inbox check instead, which covers the days the PC was off too. After such a gap, Settings › Sending & Mailgun only says that Mailgun's reports of those days couldn't be read; anyone who bounced, complained or unsubscribed then is still stopped, through Mailgun's lists. Mailgun's Free plan keeps logs for 1 day, so keep the PC on over weekends if you can ([Own-mailbox guide, step 13](docs/setup/2-own-mailbox.md#13-the-free-plans-limits)).

**Keeping it awake.** Your prospects' working hours in Europe are the afternoon and evening in Pakistan (about 11:00 to 23:00), so the PC must be on then.

- `setup-pc.bat` sets the PC to never sleep or hibernate while plugged in, and closing the lid does nothing ([Install guide, step 6](docs/setup/1-install.md#6-prepare-the-pc-setup-pcbat)). **On battery the laptop still goes to sleep**, so keep it plugged in.
- Set Windows Update's active hours to 8:00 AM to 2:00 AM, so Windows restarts for updates at night ([Install guide, step 7](docs/setup/1-install.md#7-windows-update-active-hours)).
- After a restart the services start by themselves, about 1 to 2 minutes after Windows, even before anyone logs in.

## Backups and restore

### What is saved, and for how long

- **Daily backup.** The background sender makes a copy of all your data every day, at a quiet moment when no emails are due, and by 22:00 (Pakistan time) at the latest when no quiet moment came. If the PC was off, a backup follows soon after it starts again.
- **Back up now.** Anyone can click **Back up now** in **Settings › Backups** to make one straight away, for example before a big change.
- **Every backup is checked by SQLite** before it counts. A damaged one is thrown away, and the older ones are kept.
- **What is kept:** the newest **14 daily** backups and the newest **5 Back up now** backups, so clicking Back up now never pushes out a daily one.
- **Backups the scripts make:** `update.bat`, `restore.bat` and database upgrades save your data first, as **Before an update**, **Before a restore** and **Before a database upgrade**. Settings › Backups lists them too. The newest 3 of each kind are kept, and none younger than 14 days is ever deleted. They aren't copied to the second folder (the daily ones are, and they're at most a day older).
- **The kinds**, as Settings › Backups and `restore.bat` show them: **Daily backup**, **Back up now**, **Backup** (one the app has no record of, for example made after the backup you restored, or copied from another PC), **Before an update**, **Before a restore**, **Before a database upgrade**.

### The second copy

A backup on the same disk doesn't help if that disk fails. The Owner can have every daily and Back up now backup copied to a second folder:

1. Open **Settings › Backups**, type a folder under **Second folder** and click **Save folder**. Use a folder of its own on a USB stick, a second disk or in OneDrive, for example `D:\Backups` or `C:\Users\<you>\OneDrive\Outreach backups`. A network folder or a mapped network drive doesn't work (the background services can't write there). The app also refuses a whole drive like `E:\`, a folder inside the app folder, a Windows or program folder, and your whole user folder or its Documents, Desktop, Pictures, Downloads or OneDrive folder itself (also the Documents, Desktop or Pictures folder inside OneDrive): make a new folder inside it instead.
2. **Then double-click `install-services.bat`** on the office PC, so the background sender may write there.
3. **Then click Back up now** in Settings › Backups and wait until the new backup is listed. Check that this new backup says **Copied** under **Second copy** (on a laptop: a phone hides that column). The copy the app tried when you saved may say **Not copied**, because it ran before `install-services.bat` gave the permission. A small file `outreach-backups.json` in that folder marks it as this app's.

The newest 14 daily and 5 Back up now backups are kept there too. Saving may add a warning: a OneDrive folder keeps an online copy only while OneDrive is signed in and syncing; copies to a USB stick fail while it's unplugged (the dashboard tells you); a folder on the same drive as the app doesn't help if that drive fails. **Stop copying** switches it off. The practice copy never copies to a second folder.

### Warnings

- **The last backup is more than 36 hours old**, or **No backup has been made yet**: the dashboard and Settings › Backups say so. Check that the office PC and the background sender are on (`status.bat`), or click **Back up now**.
- **The last backup couldn't be copied to the second folder**: check that the drive is plugged in. For a folder on this PC (in OneDrive, for example), double-click `install-services.bat` on the office PC, then click **Back up now**. The Owner also gets the notification "Couldn't copy the backup to the second folder", which says why.
- **The office PC's disk is almost full**: backups and sending stop when it's full. Empty the recycle bin and move big files elsewhere.

### Restoring a backup

1. On the office PC, double-click `restore.bat`. If Windows asks for permission, click **Yes**.
2. Type the number of the backup you want (the newest is at the top, with its date and kind), then type `yes`.
3. Wait while it stops the app, saves your current data as "Before a restore", puts the backup in place and starts the app again.
4. Open the app: sending stays paused while it checks Mailgun for emails sent after the backup (about 35 minutes). Read the report in **Settings › Sending & Mailgun**, then click **Resume sending**.
5. **In the own-mailbox setup**, also read contact@polygonparadise.com again. The restore undid every **They replied** click made after the backup (the app never sees replies, so nothing brings them back) and forgot the day's inbox check. The red card and the **Last restore** card in Settings › Backups say: "They replied clicks made after the backup were undone by the restore. Read contact@polygonparadise.com again from that time on: click They replied on every company that answered and Mark unsubscribed for removal requests, then click I've read contact@polygonparadise.com. Live follow-ups wait until then." Until that click, live follow-ups wait.

**Why it pauses:** the app asks Mailgun which emails went out after the backup was made, and records them as sent, so nobody gets the same email twice. That check runs twice: right after the start, and again about 35 minutes after the restore. Emails through Mailgun wait for the second check even if you resume earlier; dry runs carry on as soon as you resume. If the app couldn't reach Mailgun, **Resume sending** asks you to confirm that emails sent after the backup may go out a second time. Afterwards **Settings › Backups** keeps a **Last restore** card with the report and who resumed sending.

**What `restore.bat` refuses**, before it changes anything: a backup made by a newer version of the app ("Update the app first, then restore it."), a backup of the practice copy into the real app or the other way round, a damaged backup, and a restore when there isn't enough free disk space. For a backup of another database it asks a second time ("This backup comes from another database (expected when moving to a new PC). Type yes to go on:"). If anything fails on the way, your data stays as it was and the app starts again.

**Changed your mind?** Run `restore.bat` again and pick the backup marked **Before a restore**.

**A backup in the second folder:** type `restore.bat` followed by the file's full path in quotes, for example `restore.bat "D:\Backups\app-2026-09-27-221405-k3x9.db"`. `restore.bat` lists only the backups folder of the app.

**A practice restore** before going live shows you that a backup really brings your data back: [Going-live guide, step 5](docs/setup/4-going-live.md#5-backups-and-a-practice-restore).

### Moving to a new PC

Two PCs running the app would send the same emails twice, so the old PC is made safe first, before anything starts on the new one.

1. **On the old PC**, in this order:
   1. Click **Back up now** in Settings › Backups and wait until the new backup is listed.
   2. Double-click `stop.bat`.
   3. Double-click `uninstall-services.bat` (click **Yes** when Windows asks for permission), so the app and the background sender no longer start with Windows. `stop.bat` alone isn't enough: they would start again the next time this PC starts.
   4. Remote access: open PowerShell as Administrator (click **Start**, type `PowerShell`, right-click **Windows PowerShell**, **Run as administrator**, then **Yes**) and run `& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service uninstall`, so the secure address no longer connects to this PC either.
   5. Copy the `.env` file and the backup you just made to a USB stick. Its name starts with `app-` and today's date, for example `app-2026-09-27-221405-k3x9.db`: the **File** column of Settings › Backups shows it next to the new **Back up now** row (on a laptop: a phone hides that column). Or, in File Explorer, sort `backups\` by **Date modified**, newest first, and take the newest file whose name starts with `app-` followed by a date (never one starting with `app-pre`). Don't just take the top file: File Explorer sorts by name, which puts the oldest backup first.

   From then on the old PC can be switched on safely, for example to take other files off it: nothing of the app starts there by itself. Never double-click `start.bat` on it again.
2. **On the new PC:** install Node.js 24 ([Install guide, step 1](docs/setup/1-install.md#1-install-nodejs-24)). Put the app's files in `C:\Outreach`: the files of the version you use, without the `data`, `backups`, `logs`, `run`, `node_modules` and `.next` folders. Put your saved `.env` in `C:\Outreach`.
3. Double-click `setup.bat`. It keeps your encryption key ("The encryption key is kept") and makes an empty database. You don't need the setup code it prints.
4. Copy the backup into `C:\Outreach\backups\`, double-click `restore.bat` and pick it. Before you type `yes`, check what it shows: the file name is the one you copied, and **From:** is today's date, at about the time you clicked **Back up now**. If it says the backup comes from another database, type `yes` again: that's expected when moving.
5. Double-click `install-services.bat`, then `setup-pc.bat` ([Install guide, steps 5 and 6](docs/setup/1-install.md#5-make-the-app-start-with-windows)).
6. Remote access: install cloudflared on the new PC and connect it with your tunnel's token ([Cloudflare guide, steps 7 and 8](docs/setup/3-cloudflare.md#7-install-the-connector-cloudflared-on-this-pc)).
7. Open the app and sign in as usual. Read the restore report in **Settings › Sending & Mailgun** and click **Resume sending** once.
8. In **Settings › Backups**, save the second folder again (the drive letter may differ on this PC), then run `install-services.bat` once more, click **Back up now** and check that the new backup says **Copied**.

### Keeping `.env` safe

The `.env` file holds the key that unlocks your saved Mailgun and Claude keys. **Keep a copy on a USB stick or in a password manager**, away from this PC, and never send it to anyone. Without it a restored app still has all your data, but you have to type the Mailgun key (Settings › Sending & Mailgun) and the Anthropic key (Settings › AI) again. Copy it again whenever `setup.bat` changes it (for example the public address).

## Updating

**A new version** arrives as a zip file. To install it:

1. Double-click `stop.bat`.
2. Right-click the zip › **Properties**, tick **Unblock** (if it's there) and click **OK**. Otherwise Windows may warn about every file.
3. Right-click the zip › **Extract All…** and extract it to a new folder. Never run anything from inside the zip.
4. In the app folder, delete the folders `src`, `worker`, `scripts`, `prisma`, `tests`, `docs` and `public`, so files the new version no longer has can't break it. Never delete `data`, `backups`, `logs`, `run`, `tools` or the `.env` file.
5. Copy everything from the extracted folder into the app folder, except `.env`, `data\`, `backups\`, `logs\`, `run\` and `tools\nssm.exe` (the zip normally doesn't have them). When Windows asks, choose **Replace the files in the destination**.
6. Double-click `update.bat`. It saves your data first (as "Before an update", so a mistake in step 4 can be undone with `restore.bat`), installs the new parts, upgrades the database, builds and starts the app again. This takes a few minutes. Keep the extracted folder until it says the update finished.

If `update.bat` stops with an error, read the message: it says which step failed and the exact `restore.bat` command if you need your data back. Nothing half-built is started, so no emails go out.

**Node.js updates:** only version 24. Double-click `stop.bat`, install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi), then double-click `update.bat`. If Node.js was installed into a different folder, run `install-services.bat` again (the services remember where node.exe is).

**cloudflared:** update it every month or two ([Cloudflare guide, step 15](docs/setup/3-cloudflare.md#15-keeping-cloudflared-up-to-date)); never version 2026.8.0 or 2026.8.1.

**Windows Update** restarts the PC outside its active hours (8:00 AM to 2:00 AM, see "When the PC is off"). The services start again by themselves.

## The double-click scripts

| Double-click | What it does | When |
|---|---|---|
| `setup.bat` | First-time setup: installs the app's parts, creates `.env` and the database, builds the app and prints the setup code. Run it again to add or change the public https address. It never replaces your key or your data. | Once, and after the Cloudflare guide |
| `start.bat` | Starts the app and opens it. With the services installed it starts them (and asks for permission); without them it runs the app in its own window. | Whenever the app isn't running |
| `stop.bat` | Stops the app and the background sender. No emails go out until you start it again or Windows restarts (the services start with Windows). | Before updates and before working on the app's files |
| `update.bat` | Stops the app, saves your data ("Before an update"), installs the new version, upgrades the database, builds, starts the app and checks it answers. If a step fails, it stops, says which step, and shows the command to get your data back. | After copying in a new version, and after a Node.js update |
| `restore.bat` | Puts your data back from a backup (see "Backups and restore"). | Only when something went wrong, or for a practice restore |
| `status.bat` | Shows whether the app and the background sender run, when the sender last checked in, whether remote access (the Cloudflared service) runs, the newest backup, the addresses and any firewall problems. Changes nothing. | When something seems wrong |
| `reset-password.bat` | Makes a password reset link for any account (works once, for 24 hours) and signs that person out everywhere. Works only on this PC; the app must be running (`status.bat` shows it). | When someone, the Owner too, forgot their password |
| `start-demo.bat` | The practice copy with made-up companies at `http://localhost:3001` (demo@example.com / practice-only-password). Nothing is ever sent. | To try things out |
| `install-services.bat` | Makes the app and the background sender start with Windows, even before anyone logs in, and gives them access to the second backup folder. | Once, after moving the app folder or Node.js, and after saving a second backup folder |
| `uninstall-services.bat` | Stops the app starting with Windows. Your data and settings stay. | Before moving the app folder, and on an old PC you're replacing ("Moving to a new PC") |
| `setup-pc.bat` | Office network, firewall and power settings. Asks before every change. | Once, and if the office can't reach the app |

## Troubleshooting

**Where to look first:**

| Symptom | Where |
|---|---|
| The app or the services don't start, Node.js messages, the setup code, the office can't reach the app | [Install guide, Troubleshooting](docs/setup/1-install.md#12-troubleshooting) |
| Your own-mailbox setup: the MX or SPF row, the inbox check, the Free plan's pauses, the reply test | [Own-mailbox guide, Troubleshooting](docs/setup/2-own-mailbox.md#16-troubleshooting) |
| "Paused: …", Mailgun messages, DNS rows, unsubscribe links, replies | [Mailgun guide, Troubleshooting](docs/setup/2-mailgun-and-dns.md#18-troubleshooting) |
| Error 1033 or 502, login codes, the tunnel | [Cloudflare guide, Troubleshooting](docs/setup/3-cloudflare.md#16-troubleshooting) |
| Anything after going live | [Going-live guide, step 12](docs/setup/4-going-live.md#12-if-something-goes-wrong) |

**More:**

- **The dashboard says "No backup has been made yet" and that the background sender isn't running.** The background services aren't running on this data yet. Double-click `install-services.bat` ([Install guide, step 5](docs/setup/1-install.md#5-make-the-app-start-with-windows)), wait a minute, then click **Back up now** in Settings › Backups.
- **The disk is full.** Backups and sending stop, and the Owner gets a notification that the backup failed. Free some space (empty the recycle bin, move big files), then click **Back up now**.
- **The second folder's drive is unplugged.** Copies there fail and the dashboard says so; the backups on this PC are still made. Plug the drive in; the next backup copies again.
- **"The office PC's clock looks wrong".** In Windows' own Settings app, open **Time & language**, then **Date & time**, and switch on **Set time automatically**.
- **The `.env` file is lost.** Put back your saved copy. If you have none, `setup.bat` makes a new one with a new key: type the public address again when it asks, then type the Mailgun key (Settings › Sending & Mailgun) and the Anthropic key (Settings › AI) again in the app.
- **Your antivirus quarantined `tools\nssm.exe` or a part of the database engine** (a `.node` or `.dll` file under `node_modules\`, or "A part of the app (better-sqlite3) doesn't work"): restore it from the antivirus quarantine, add the app folder as an exclusion in the antivirus, then double-click `update.bat`.
- **The Domain checklist row "Mail for polygonparadise.com stays with your mail provider (MX)" is red**, live emails say "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost." and the Owner gets the notification "Mail for polygonparadise.com goes to the wrong place". polygonparadise.com's MX records point to Mailgun or are gone, so your everyday email is at risk. In GoDaddy's DNS records for polygonparadise.com, delete the MX records named `@` whose value ends in `mailgun.org`, put Zoho's back if they're missing (the row says what to keep), then click **Check again** on Settings › Domain checklist. Live emails go again once the row is **Done** ([Mailgun guide, Troubleshooting](docs/setup/2-mailgun-and-dns.md#18-troubleshooting); in the own-mailbox setup, where the row also turns red for Cloudflare Email Routing and live emails say "Waiting: mail for your domain doesn't go to your mail provider …": [Own-mailbox guide, Troubleshooting](docs/setup/2-own-mailbox.md#16-troubleshooting)).
- **"Send me a test" didn't arrive in contact@polygonparadise.com.** It comes From contact@polygonparadise.com, so it's an email from yourself to yourself, which some mailboxes hide or filter. Look in spam, or try it with another reply inbox (in the own-mailbox setup: another inbox for test emails, for example a Gmail address).
- **"Waiting for today's inbox check (Notifications › Inbox check)."** (own-mailbox setup): read contact@ (inbox and Spam), then click **I've read contact@polygonparadise.com** on the Notifications page ([Own-mailbox guide, step 12](docs/setup/2-own-mailbox.md#12-every-working-day)).
- **A reply in contact@ didn't stop the follow-ups** (own-mailbox setup): the app never sees replies there. Click **They replied** on the company ([Own-mailbox guide, step 12](docs/setup/2-own-mailbox.md#12-every-working-day)).
- **"Paused: Mailgun's sending limit for your plan is reached"**: the Free plan's 100 emails a day are used up. Click **Resume sending** in Settings › Sending & Mailgun the next day ([Own-mailbox guide, step 13](docs/setup/2-own-mailbox.md#13-the-free-plans-limits)).
- **"Paused: Mailgun sends only to authorized recipients"**: add a payment card in Mailgun (the Free plan stays free), then click **Resume sending**. Never authorize a prospect's address ([Own-mailbox guide, step 1](docs/setup/2-own-mailbox.md#1-before-you-start)).
- **Nothing is sent, checked or heard from Mailgun, or start.bat says "Port 3000 is already in use".** A window running `npm run dev` is still open: close it (click in it, press Ctrl+C), then double-click `start.bat` ([Own-mailbox guide, step 1](docs/setup/2-own-mailbox.md#1-before-you-start)).
- **The reply test says "Emails to u+…@polygonparadise.com don't reach anyone"** (own-mailbox setup): turn on a catch-all address in Zoho that delivers to contact@, or without one add `u@` and `bounce@` as aliases of contact@; if nothing works, click **Leave out unsubscribe by email** under the failure line ([Own-mailbox guide, step 9](docs/setup/2-own-mailbox.md#9-the-test-list-and-the-reply-test-by-hand)).
- **The reply test says the test email's return address is on polygonparadise.com, not on mail.polygonparadise.com** (full setup only: in the own-mailbox setup a return address on polygonparadise.com is expected). Bounces and automatic replies would then miss the app, so the shared From address isn't safe on your Mailgun account. Clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on mail.polygonparadise.com) and ask the person who set up the app.
- **A reply was taken as real, but it was automatic.** Its company's follow-ups stopped and the status may say **Replied**. Set the company's status back by hand in its panel, then put the person in a new campaign.
- **"Last emailed: Never" for your test mailboxes.** That's right: test emails before going live don't count as emailed.
- **After a restore, your test mailboxes are blocked by the 30-day rule** for up to 30 days. Sends the app found in Mailgun's logs after a restore always count, because the app can't tell a test from a real send there. It passes by itself.
- **"Paused: this database last ran on another computer" after renaming the PC.** The app notices the new PC name once. If only the name changed, click **Resume sending** in Settings › Sending & Mailgun.
- **"Paused: this database was copied or moved" after moving the app folder.** If you moved it on purpose, click **Resume sending** once. If it's a copy of the real database, don't: the copy would send the same emails again.
- **Windows says "Windows protected your PC" or shows a security warning on a `.bat` file.** The files came from a zip that wasn't unblocked. Delete the extracted files, right-click the zip › **Properties** › tick **Unblock** › **OK**, and extract it again.

## What it costs

| What | About | Notes |
|---|---|---|
| Mailgun Free plan | $0 | Your setup (the own-mailbox guide): 100 emails a day, 1 day of logs, unsubscribe links over http. Address checks are an add-on. |
| Mailgun Foundation plan | $35 a month | The full setup (the Mailgun guide). 50,000 emails a month. It includes no address checks. A Free or trial Mailgun account must be upgraded to it. |
| Address checks | $0.012 each | About $4.80 for 400 addresses, billed by Mailgun on top of the plan. The Scale plan ($90 a month) includes 5,000 checks a month and is cheaper above about 4,580 checks a month. The app's own limit: $100 a month (Settings › Deliverability). |
| Domains | about $10 a year | No domain to buy for sending (mail.polygonparadise.com is part of polygonparadise.com); maybe one for the app's address. A .com at Cloudflare costs about $10.44 a year. |
| Cloudflare Tunnel and Access | $0 | Access is free for up to 50 people. Cloudflare asks for a payment card but doesn't charge it. |
| Claude (AI lines) | about $1.69 per 300 lines | With Claude Haiku 4.5, at most $3.15 per 300; Claude Sonnet 5 costs about 3.5 times as much. The app's own limit: $20 a month (Settings › AI). Set a limit in the Anthropic Console too. |

## Where things live

| Where | What |
|---|---|
| `data\app.db` | All your data, in one file. Don't copy it while the app runs; use the backups. |
| `.env` | The settings file, including the encryption key for your saved API keys. Keep a copy somewhere safe and never share it. |
| `backups\` | The backups: daily ones, Back up now, and the ones `update.bat`, `restore.bat` and database upgrades make. `backups\demo\` holds the practice copy's. |
| your second folder | Copies of the daily and Back up now backups, and `outreach-backups.json`. |
| `logs\` | Messages from the app, the background sender and the scripts, for troubleshooting. The newest file is the one to look at. |
| `run\` | The scripts' working files. Don't touch them. |
| `tools\` | `nssm.exe`, the helper that runs the app as a Windows service. |
| `data\demo.db` | The practice copy's made-up data. |
| `docs\setup\` | The guides: install, own-mailbox (your setup), Mailgun and DNS (the full setup), Cloudflare, going live. |

## Words used here, getting help, for developers

### Words used here

- **Dry run:** the app does everything except send, and shows you what it would have sent in the dry-run outbox.
- **Test mode:** Mailgun's test mode: emails to your test list are accepted but never delivered. Only for checking the connection.
- **Live:** real emails through Mailgun. Before going live, only to your test list.
- **Go live:** the one-way switch in Settings › Sending & Mailgun after which new live campaigns email everyone eligible.
- **Test list:** your own test mailboxes (Settings › Sending & Mailgun), for the reply test, Test mode and rehearsals.
- **Warm-up:** sending slowly at first after you go live (50 emails on the first day), so inbox providers learn to trust your emails.
- **The 30-day rule:** a company a teammate emailed recently stays with them; the length is a setting.
- **From address:** the address every email shows, contact@polygonparadise.com, with the sender's own name; set by the Owner (Settings › Sending & Mailgun).
- **Reply address:** in the full setup, each person's own address on mail.polygonparadise.com; replies go there, the app records them and Mailgun forwards them to that person's reply inbox. The own-mailbox setup has none.
- **Reply route:** in the full setup, Mailgun's rule that forwards replies to a sender's own reply inbox and passes a copy to the app. The own-mailbox setup has none.
- **How the app sends:** the choice in Settings › Sending & Mailgun (Mailgun connection): **From polygonparadise.com itself** (your setup: replies come to contact@, on Mailgun's Free plan) or **Through a sending subdomain** (the full setup: replies come through the app, on Mailgun's Foundation plan).
- **Your Mailgun plan:** under **Advanced** in Settings › Sending & Mailgun: the plan the app keeps to (its daily limit and how long Mailgun keeps logs). Connecting in the own-mailbox setup sets Free by itself.
- **They replied:** the button on a company's panel (and on a person in a campaign) that stops every follow-up to that company, for replies the app can't see: every reply in the own-mailbox setup, and replies written straight to contact@ in the full setup. Once you're live it also sets the company to Replied.
- **Inbox check:** in the own-mailbox setup, the daily click **I've read contact@polygonparadise.com** (Notifications, card "Today's inbox check") after reading contact@, its inbox and its Spam folder. Live follow-ups wait for it each day, and so do first emails to a company that was already emailed before today.
- **Practice copy:** the copy with made-up companies (`start-demo.bat`) where nothing is ever sent.
- **Background sender:** the part of the app that sends emails, checks with Mailgun and makes backups, even when no browser is open.
- **Owner / Member:** the Owner (exactly one) can change settings, keys, limits and the team; Members can do everything else.

### Getting help

If something here doesn't match what you see, or a message says to ask for help, contact the person who set up the app for you. Send the exact message (a screenshot is fine) and, for a sending problem, what the top bar says. Never send the `.env` file or an API key.

### For developers

Developers: see [docs/dev/README.md](docs/dev/README.md).
