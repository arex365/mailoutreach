# Own-mailbox guide

This guide sets the app up the way you decided: it sends through **polygonparadise.com** itself on Mailgun's **Free** plan, every email comes From **contact@polygonparadise.com** with the sender's own name, and replies go straight to contact@ in Zoho Mail, where you handle them by hand. Follow it **instead of** the [Mailgun and DNS guide](2-mailgun-and-dns.md), which describes the full setup (Mailgun Foundation, a sending subdomain, replies through the app); everything this setup needs from that guide is copied here.

Do the [Install guide](1-install.md) first. The [Cloudflare guide](3-cloudflare.md) is optional in this setup: without it the app works on this PC and your office network, and Mailgun's reports reach the app through its hourly check. The [Going-live guide](4-going-live.md) adds the PC, backups and your first weeks (step 11 says when).

It takes about an hour of clicking, spread over a day or two, because some steps involve waiting (a DNS record spreading, Mailgun's reports arriving). Do the steps in order. The app refers to some steps of this guide by number ("Own-mailbox guide, step 11"), so the numbers stay the same.

This guide uses your real names: **polygonparadise.com** is your domain (your website and your everyday email at Zoho Mail; its DNS records are at GoDaddy), **contact@polygonparadise.com** is the From address every email shows, and "Arslan from Polygon Paradise" is an example of a display name. The app shows your real values everywhere, with Copy buttons. Mailgun's, GoDaddy's and Zoho's own screens change from time to time: where a button or menu name couldn't be checked, this guide says "(it may be called …)".

> **Your setup, and what it gives up**
>
> The app sends through polygonparadise.com itself, and every email comes From contact@polygonparadise.com with each person's display name, for example "Arslan from Polygon Paradise <contact@polygonparadise.com>". Replies go straight to contact@ in Zoho Mail and never reach the app. What that means:
>
> - **The app can't see replies, so it can't stop follow-ups by itself.** When someone answers, you click **They replied** on their company. **Live follow-ups wait each day until someone has read contact@** (its inbox and its Spam folder) and clicked **I've read contact@polygonparadise.com** (step 12).
> - **Automatic replies (out of office), bounces that come later, and unsubscribe requests sent by email** go to Zoho too: into contact@ when Zoho catches them (its catch-all address, step 1), otherwise nowhere. The app never sees them. "Please remove me" and "couldn't be delivered" notices are handled with **Mark unsubscribed** (step 12).
> - **Mailgun's Free plan:** 100 emails a day (the app plans at most 90 campaign emails and keeps 10 for test emails), 1 day of logs, and unsubscribe links that use http instead of https (step 13).
> - **Your everyday email shares the reputation.** If people mark these emails as spam, your normal emails from polygonparadise.com (to clients, with quotes and invoices) can land in spam too, and that takes weeks to fix. That was your decision, made knowing this. The app pauses sending when Mailgun reports complaints (from Microsoft, Yahoo and others), but **Gmail and Google Workspace never report complaints**: only Google Postmaster Tools shows those (step 14). Keep **Settings › Deliverability** › **Thresholds** as they are, and once a week look at the dashboard's **Domain health** and at Postmaster Tools.
> - Moving to the full setup later (replies through the app, Mailgun Foundation) is step 15.

> **Quick path**
>
> 1. Close the window running `npm run dev` (click in it, press Ctrl+C), double-click **start.bat**, and turn on Zoho's catch-all address for contact@ (step 1).
> 2. Connect Mailgun: US, **From polygonparadise.com itself**, polygonparadise.com, the API key (steps 3–4).
> 3. Save **contact@polygonparadise.com** as the From address (step 5).
> 4. Add the `_dmarc` record at GoDaddy (step 6).
> 5. **Check again**, then **Apply recommended settings** (step 7).
> 6. Add the test list and switch to **Live (test list only)** (step 9).
> 7. Run the reply test (step 9).
> 8. Send the live test to the Test mailboxes companies (step 10).
> 9. Go live (step 11).
>
> After that, step 12 is part of every working day.

---

## 1. Before you start

You need:

- **Mailgun on the Free plan**, with polygonparadise.com in it (it already is). The Free plan sends 100 emails a day and keeps 1 day of logs. Nothing needs buying to set up and go live. Only address checks may cost money: they are an add-on on Free ("Email Validations: Available as add-on" on Mailgun's pricing page), and after going live, live campaigns only email checked addresses (step 10 tries one check).
- **A catch-all address in Zoho, turned on now.** In Zoho Mail's **Admin Console**, open **Domains** › polygonparadise.com › **Advanced Settings** › **Catch-all Address**, enter contact@polygonparadise.com and click **Update**. Mail to an address on polygonparadise.com that doesn't exist then reaches contact@: the unsubscribe emails some mail programs send (to an address like u+…@polygonparadise.com), bounces that come later and out-of-office replies. If that page isn't there (your Zoho plan doesn't have it), add `u@polygonparadise.com` and `bounce@polygonparadise.com` as email aliases of contact@ instead (**Admin Console** › **Users** › the user of contact@ › **Mailbox Settings** › **Email Alias** › **Add**): the reply test (step 9) shows whether that works. If neither works, the reply test has a last resort (step 9).
- **If Mailgun says free accounts only send to authorized recipients** (a banner in Mailgun, or the app's pause "Paused: Mailgun sends only to authorized recipients"), add a payment card in Mailgun (**Account › Billing**, it may be called **Plan**): the Free plan stays free. **Never add a prospect's address under Authorized recipients**: Mailgun would email them an invitation.
- **polygonparadise.com's DNS records, at GoDaddy.** You add one record (step 6) and change nothing else.
- **Your mail provider stays Zoho Mail.** contact@polygonparadise.com and your everyday email keep working as today, and nothing in this guide changes where mail for polygonparadise.com goes.
- **Two test mailboxes:** one Outlook.com (or Hotmail) mailbox and one Gmail mailbox. Never contact@polygonparadise.com: it's your From address, and the app refuses it on the test list.
- **Mailgun's rules on cold email:** Mailgun's usage policy asks for the recipient's consent for marketing email and bans scraped lists, so cold outreach can get an account limited or closed. The app keeps bounces and spam complaints low, which is the best protection.

**Always start the app with start.bat, never `npm run dev`.** If a window is running `npm run dev`, close it first: click in it and press Ctrl+C. (If start.bat says "Port 3000 is already in use", that window is still open.) Then double-click **start.bat**. The first start builds the app for a few minutes. Only start.bat runs the background sender: without it nothing is sent, nothing is checked and nothing is heard from Mailgun.

**What you should see:** the app opens in your browser, and the dashboard's **Needs your attention** list says nothing about the background sender.

## 2. Keep polygonparadise.com in Mailgun as it is

1. In Mailgun, open **Send › Domains** (it may be **Send › Sending › Domains**). polygonparadise.com is there, in the **US** region, with SPF and DKIM verified.
2. Its MX records show as "unverified". **That's correct, and it stays so for good.** Mailgun's page for the domain lists MX records (mxa.mailgun.org, mxb.mailgun.org): never add them to GoDaddy. They would send your everyday email and every reply to Mailgun, where nobody reads them.
3. **Never delete polygonparadise.com in Mailgun**: its signature key can't be recovered. **Leave the sandbox domain alone** (its name ends in `mailgun.org`): it's only for Mailgun's own tests.
4. If your website or another tool also sends email through Mailgun as polygonparadise.com, tell the person who set up the app before step 7: **Apply recommended settings** changes that domain's tracking settings in Mailgun, for every email sent through it.

**What you should see:** polygonparadise.com listed in the US region, and nothing changed.

## 3. The API key

The API key is the password that lets the app use Mailgun.

1. In Mailgun, open your profile menu (top right) and choose **API Security** (it may be called **API keys**).
2. Create a new key (the button may be called **Create API key** or **Add new key**):
   - **Role: Developer.** The role can't be changed later. Developer can do everything the app needs and nothing more.
   - **Name:** Outreach app.
3. Copy the key straight away and keep the page open until step 4: Mailgun may show it only once. Don't email it or save it in a document. It goes only into **Settings › Sending & Mailgun** (step 4), never into the `.env` file.

**What you should see:** the new key in the list, role Developer.

## 4. Connect Mailgun

1. In the app, open **Settings › Sending & Mailgun**.
2. Under **Mailgun connection**:
   - **Region**: US.
   - **How the app sends**: **From polygonparadise.com itself (replies come to your own inbox)**.
   - **Sending domain**: polygonparadise.com (without www.).
   - **API key**: paste the key from step 3.
   - Leave **Advanced** closed: the app sets **Your Mailgun plan** to Free by itself.
3. Click **Save and connect**. The app first tests the key and the domain with Mailgun, and saves them only if the test passes.

**What you should see:** "Connected to polygonparadise.com (US). Replies go to your own mailbox. Next: type your From address in the From address card below. The app keeps to Mailgun's Free plan (100 emails a day, 1 day of logs). If you upgrade, choose the plan under Advanced." The line at the top of the card then starts "Connected to polygonparadise.com (US) · replies go to your own mailbox", and under **Advanced**, **Your Mailgun plan** shows **Free (100 emails a day)**. The app also fetches Mailgun's webhook signing key by itself; you never type that one.

**If it goes wrong:**

- "Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here." Copy the key again (no spaces before or after), or make a new one (step 3).
- "Mailgun can't find polygonparadise.com in the EU region. If you created the domain in the US region, change Region to US." Choose **US**.
- "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. …" The other choice under **How the app sends** is still selected. Click **Use From polygonparadise.com itself** under the field, then **Save and connect**.
- "That's Mailgun's sandbox domain, for tests only. Type polygonparadise.com, the domain Mailgun lists under Send › Domains next to it." You pasted the sandbox domain: type polygonparadise.com.
- "Type your domain without www., for example polygonparadise.com."
- "Couldn't reach Mailgun. Check this PC's internet connection and try again."

## 5. Your From address

1. Right under the connection is the **From address** card. Type `contact@polygonparadise.com` in **From address** and click **Save From address**.
2. The hint under the field shows what people will see, with your own display name: "People see "Arslan from Polygon Paradise <contact@polygonparadise.com>": each person's display name with this address. Replies go straight to this mailbox, not through the app. It must end in @polygonparadise.com."

**What you should see:** "From now on, campaign emails show From contact@polygonparadise.com. Replies go straight to that mailbox (look in its Spam folder too): when someone answers, click They replied on their company. Run the reply test before live campaigns (Settings › Domain checklist)." The card then shows a note about your everyday email's reputation and a closed **Good to know** list: open it and read it once. Its last line is the rule that protects your everyday email: "Never add Mailgun's MX records to polygonparadise.com and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving."

**If it goes wrong:** "The From address must end in @polygonparadise.com, your sending domain." You typed another domain, or a name in front of polygonparadise.com: type `contact@polygonparadise.com`.

## 6. DNS at GoDaddy: one record

This is the only DNS change your setup needs.

1. Sign in at GoDaddy, open **My Products** and click **DNS** next to polygonparadise.com (it may be called **Manage DNS**, or sit under **Domain Portfolio**).
2. Click **Add New Record** (it may be called **Add**) and add **one** record:
   - **Type:** TXT.
   - **Name:** `_dmarc`. GoDaddy's form may fill Name with `@`: change it to `_dmarc` before you save.
   - **Value:** `v=DMARC1; p=none`
3. Save.

This DMARC record also covers your everyday email from polygonparadise.com; p=none changes nothing for it. Leave out DMARC reports (`rua`): they would arrive in contact@ as attachments.

**Change nothing else.** Never add or change an MX record, never edit the SPF record (the TXT record of `@` that starts with `v=spf1`) or the `dc-…._spfm` records (GoDaddy's helpers for it), and leave `mx._domainkey` (Mailgun's signature key), `zmail._domainkey` (Zoho's) and `email` (Mailgun's tracking link) as they are. This setup never asks you to change them.

**What you should see:** in GoDaddy's list, one new TXT record named `_dmarc`, and every record that was there before, unchanged.

## 7. Check and apply

The background sender must be running (step 1).

1. Open **Settings › Domain checklist** and click **Check again**. (After a check the button says "Checked just now" and rests for a minute.) Under its title the page says "Emails show From contact@polygonparadise.com and go out through polygonparadise.com itself. Replies go straight to that mailbox."
2. Click **Apply recommended settings**. It switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers and asks Mailgun for secure unsubscribe links. It changes nothing about receiving mail. Watch the steps appear, each with a word in front of it. On the Free plan these grey ones are expected and stay as they are (nothing is waiting, and clicking Apply again changes nothing):
   - **Not in your plan**: "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do." and "Unsubscribe links use http on your plan. They still work when clicked (see the HTTPS row)." The links use http on Free (step 13).
   - **Not needed**: "Not needed: replies go to your own mailbox." for the spam filter, stored replies and reply routes.
   - **Optional**, without the Cloudflare guide: "No public address yet: Mailgun's reports come through the app's hourly check instead. Remote access is optional in your setup (Cloudflare guide)." and "Mailgun's reports come through the app's hourly check instead. Webhooks need remote access, which is optional in your setup."
3. Click **Check again** once more.

**What you should see:** these rows green (**Done**):

- "Mailgun knows your domain": "Mailgun has your domain (US) and has confirmed your records."
- "Mailgun may send for polygonparadise.com (SPF)", for example "Mailgun may send for polygonparadise.com (through its SPF record's includes). The record is almost full: 9 of 10 DNS lookups. Before you add another email service to polygonparadise.com, ask the person who set up the app." That's fine: just don't add another email service without asking.
- "Your emails are signed (DKIM)": "Your emails carry polygonparadise.com's digital signature (1024-bit; it works, 2048-bit is stronger)." Nothing to do: every inbox provider accepts it.
- "Mail servers know your policy (DMARC)": "Policy found: monitor only. Right for now." once the `_dmarc` record has spread (usually minutes to an hour; amber "Still spreading. Check again in 30 minutes." until then). The reply test waits for this row.
- "Mail for polygonparadise.com stays with your mail provider (MX)": "Mail for polygonparadise.com goes to your mail provider (…), not to Mailgun, so replies reach your inbox. Keep it that way."
- "Unsubscribe links work (tracking CNAME)", "Open and click tracking are off", "Unsubscribe handling is on", "Webhook signing key saved" and "Mailgun lets you send".

Grey "For your information" rows you can leave as they are:

- **Unsubscribe links are secure (HTTPS)**: "Your Mailgun plan doesn't include secure (https) unsubscribe links, so they use http. They still work when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https, so it may not show. That is required only above 5,000 emails a day to Gmail."
- **Mailgun tells the app what happened** and **Remote access works**, without the Cloudflare guide: "No public address yet, so Mailgun can't tell the app at once. The app reads Mailgun's logs every hour instead, while the background sender runs." and "Remote access isn't set up: the app works on this PC and your office network only."
- **Monthly safety limit**: "Your Mailgun plan stops at 100 emails a day, so a monthly safety limit isn't needed."

"Reply test" stays amber until step 9. The checklist has no row about reply routes or about MX records for Mailgun: in your setup nothing is received through Mailgun.

## 8. Profiles

Each person who sends campaigns (you too) opens **Settings › My profile**:

1. **Sender display name:** the name prospects see next to contact@polygonparadise.com, for example "Arslan from Polygon Paradise".
2. **Signature:** if it shows an email address, use contact@polygonparadise.com (the hint under the field says so too).
3. **Inbox for your test emails:** where **Send me a test** sends your test emails. contact@polygonparadise.com is allowed; a Gmail address shows test emails more reliably, because Zoho may hide or filter an email from contact@ to contact@.
4. **Time zone**, then click **Save profile**.

There is no sending address or reply address to choose: the page says "Your emails show "Arslan from Polygon Paradise <contact@polygonparadise.com>". Replies go straight to contact@polygonparadise.com."

**What you should see:** "Profile saved."

## 9. The test list and the reply test (by hand)

Until you go live ([step 11](#11-going-live)), real email only ever reaches the addresses on your test list, and your own test inbox when you click **Send me a test**.

**The test list**

1. Open **Settings › Sending & Mailgun**, section **Test list**. For each test mailbox, type its address in **Add a test mailbox** and click **Add address**: one Outlook.com (or Hotmail) mailbox and one Gmail mailbox. Never contact@polygonparadise.com: the app refuses every address on polygonparadise.com.
2. Under **Sending mode**, choose **Live (test list only)** and click **Save mode**. The app asks "Real emails will go to your test-list addresses only: …, and to your inbox for test emails (My profile) when you click Send me a test. Everyone else is left out until you go live. Switch to live?" Click **Switch to live**. This is the only mode switch before going live: step 10 needs none.

**What you should see:** the top bar says **Test list only**.

**The reply test** (about 30 minutes of clicking, plus up to an hour of waiting for Mailgun's reports)

This test proves, on your own Mailgun account and before any live campaign can start, that emails From contact@polygonparadise.com arrive properly and pass DMARC, that replies reach contact@, and that both ways of unsubscribing reach someone: the link in the email, and an email to its unsubscribe address.

1. Open **Settings › Domain checklist** and scroll to **Reply test**. It starts once the DMARC row is done. Until then "Before you start" says "Add the DMARC record first (the DMARC row of the Domain checklist) and wait until it shows Done, so the test emails can pass DMARC."
2. Click **Send test emails to my test list**. The section says "Send the test emails: one to each mailbox on your test list, from contact@polygonparadise.com. Replies come straight to contact@polygonparadise.com, not to the app." and "The app hears from Mailgun about deliveries and unsubscribes within the hour while the background sender runs. To check sooner, click Check with Mailgun now in Settings › Sending & Mailgun." Test emails count toward today's limit and the Free plan's 100 a day.
3. In **each** test mailbox, find the email "Reply test from Polygon Paradise Outreach" and note, **before you move it out of spam**, whether it arrived in the inbox or in spam (junk). Gmail's Promotions and Updates tabs count as the inbox. Then move it to the inbox if it isn't there, open it and **reply** with a short message such as "Got it". The reply goes to contact@.
4. Back in the app, each test mailbox has its own box. **Test email** says "Delivered" once Mailgun has reported it. Answer its questions in this order:
   - "Did the test email arrive in this mailbox's inbox, not in spam or junk? (Gmail's Promotions or Updates tab counts as the inbox.)" Yes / No. A No doesn't fail the test, but going live then asks you to tick a box about it.
   - "Reply to the test email from this mailbox. Did your reply arrive in contact@polygonparadise.com? Look in its Spam folder too." Look in contact@ in Zoho Mail. Yes / No.
   - "Open the test email's original (Gmail: ⋮ › Show original. Outlook.com: ⋯ › View › View message source). Does it say DMARC: PASS (Gmail) or dmarc=pass?" Yes / No / **Not sure**. "Not sure" opens "Paste the test email's original here, and the app reads it for you." with the **Read the headers** button; the text is never stored.
5. **The test email's original** (below the mailboxes, once): open one test email in a test mailbox and show its original. In Gmail that's **⋮** › **Show original** › **Copy to clipboard**; in Outlook.com **⋯** › **View** › **View message source**, then select all and copy. Paste the whole text into the box and click **Read the original**. The app reads it, doesn't keep the text, and shows one line per check:
   - "From: contact@polygonparadise.com ✓"
   - "Return address: …@polygonparadise.com. Bounces that come later and automatic replies go to your own mailbox (or nowhere), not the app." That's expected in your setup.
   - "The original says DMARC: PASS."
   - "Signed by polygonparadise.com ✓"
   - "Unsubscribe link: http. It works when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https (Mailgun's Foundation plan)." That's expected on the Free plan. If Mailgun gave you the certificate after all, it says "Unsubscribe link: https ✓".
   - "Unsubscribe by email goes to u+…@polygonparadise.com. The question below checks that it reaches a mailbox you read." (The app shows the whole address; it may look a little different.)
6. **The unsubscribe headers:** the app asks "In one test mailbox, open the test email's original. Do you see a List-Unsubscribe: line with a link (http:// or https://)?" Its note: "On Mailgun's Free plan the link starts with http:// and there's no List-Unsubscribe-Post line: that's expected. An https link and List-Unsubscribe-Post (the one-click unsubscribe Gmail and Yahoo show) need Mailgun's Foundation plan. Answer No only if the original has no List-Unsubscribe: line at all." The line may also show a mailto: address: "It may also show a mailto: address: that's expected. The next question checks where emails to it arrive."
7. **Click the unsubscribe link** at the bottom of that test email. Within the hour (or sooner, if you click **Check with Mailgun now** in **Settings › Sending & Mailgun**) the section shows "Unsubscribe reached the app ✓". That test mailbox is now on the do-not-email list, so put it back before the next question: open **Settings › Deliverability**, find the address and click **Remove**.
8. **The unsubscribe-by-email question** (it shows when the original has a mailto: address): "From one of your test mailboxes, send an email to u+…@polygonparadise.com (any subject and text). Within the hour, did it arrive in contact@polygonparadise.com or another mailbox you read? Look in Spam too." Copy the address with the Copy button next to it, send one email to it from a test mailbox, wait up to an hour, then look in contact@ and its Spam folder. Under the question the app says: "Answer Yes only if you found that email in a mailbox you read. If the test mailbox got a "couldn't be delivered" notice back, or nothing arrived, answer No. Settings › Deliverability can't answer this: it lists the test mailbox because of the unsubscribe link you clicked."
   - **Yes** only when you found the email in contact@polygonparadise.com (or its Spam folder) or in another mailbox you read. Settings › Deliverability never counts as a Yes here.
   - **If it bounced back** to the test mailbox, or never arrived: turn on a catch-all address in Zoho that delivers to contact@ (step 1). In Zoho Mail's **Admin Console**, open **Domains** › polygonparadise.com › **Catch-all Address** (under **Advanced Settings**), enter contact@polygonparadise.com and click **Update**. If your Zoho plan doesn't offer it, add `u@polygonparadise.com` and `bounce@polygonparadise.com` as email aliases of contact@ (**Users** › the user of contact@ › **Mailbox Settings** › **Email Alias** › **Add**): Zoho may then deliver u+…@polygonparadise.com to u@. After each change, send the email again and change the answer. The catch-all also brings late bounces and out-of-office replies into contact@.
   - **If nothing works**, answer **No**. The test then fails, because people who unsubscribe that way would never be removed, and right under the failure line the section offers the last resort: click **Leave out unsubscribe by email**, then **Leave it out** in the box that opens. (The app refuses while a test or live campaign is scheduled, running or paused: finish or cancel it first.) From then on every email offers unsubscribing only by the link: the app sends its own List-Unsubscribe line with Mailgun's link and no email address. The proof starts again for this: click **Send test emails to my test list**, paste the original of one of the new test emails and click **Read the original**, then answer the List-Unsubscribe question again. The unsubscribe-by-email question isn't asked any more; the test passes only if that new original shows the link and no mailto: address. While it's left out, the section says "Unsubscribe by email is left out: your emails offer unsubscribing only by the link." with the button **Offer unsubscribe by email again** (then **Offer it again**): it brings back Mailgun's own line with its mailto: address, and the proof starts again.
9. Click **Save the result**.

**What you should see:** **Passed** ("The reply test passed on … with the From address contact@polygonparadise.com: test emails arrived, your replies reached contact@polygonparadise.com, unsubscribing works, and the test email passed DMARC."). It passes when at least one Outlook.com mailbox and one Gmail mailbox each had the email delivered and your reply arrived in contact@; when every mailbox answered the inbox question and its test email passed DMARC; when the pasted original shows a return address on polygonparadise.com; when the List-Unsubscribe answer is Yes and the email to the unsubscribe address reached a mailbox you read (or you left out unsubscribe by email and a new original shows the link and no mailto: address); and when the unsubscribe click reached the app. A test email that landed in spam shows as "…: the test email landed in spam." under the result and doesn't fail the test: going live asks you about it.

It counts only for polygonparadise.com, contact@polygonparadise.com and this way of sending: after a change of the From address or of **How the app sends**, run it again. Such a change also offers unsubscribe by email again if you had left it out: leave it out again in the new test if you still need to.

**Write down for the person who set up the app**, whether the test passes or not: where out-of-office replies landed (in contact@, or nowhere; the [Going-live guide, step 3](4-going-live.md#3-rehearse-with-your-test-mailboxes) tries one), and whether Gmail shows "via" next to the sender (open the test email in Gmail and click the small arrow under the sender's name: "mailed-by" and "signed-by" should both say polygonparadise.com).

**If it fails:** the section says which check failed: "The reply test didn't pass with the From address contact@polygonparadise.com. The lines above say which check failed." Fix that check (step 16 has the usual ones), change the answer, and click **Save the result** again.

## 10. Test companies and a live test

**Prepare the test companies** (once), so real companies are never touched:

1. Open **Contacts** and click **New list** (left side). Name it **Test mailboxes** and click **Create list**.
2. For each test mailbox, click **Add company**:
   - **Company name:** for example "Test – Gmail".
   - **Country:** Pakistan. Emails only go out inside the recipient's sending hours (normally Monday to Friday, 9:00–17:00 in the company's time zone), so this makes them follow your own day. A company without a country uses the default zone (Berlin).
   - **Add to list:** Test mailboxes.
   - **First person › Email:** the test mailbox's address.
   - Click **Add company**.

**Send the live test:**

1. In **Contacts**, open the **Test mailboxes** list, tick all its companies, and click **Email these companies** in the bar at the bottom.
2. Go through the steps. **Audience:** the Test mailboxes companies. **Sender:** you; "Recipients see" shows "Arslan from Polygon Paradise <contact@polygonparadise.com>", and there is no reply address. **Message:** any template. To practise the daily clicks below, keep one follow-up and set it to 1 day; otherwise switch the follow-ups off. **Verify:** test-list addresses count as checked. **Review:** optionally click **Send me a test**. **Schedule:** it shows today's limit and when the emails can go out.
3. Click **Launch campaign**. The sending mode stays **Live (test list only)**.

**What you should see:** the campaign page, with "Sent by Arslan as Arslan from Polygon Paradise <contact@polygonparadise.com>". The emails go out one at a time, a few minutes apart, inside sending hours. The results count them under **Sent**, then under **Delivered** within the hour, once the app's hourly check with Mailgun has seen them (or click **Check with Mailgun now** in Settings › Sending & Mailgun). While follow-ups are still to come, the page says "Replies come straight to contact@polygonparadise.com, not to the app. Each day, read contact@polygonparadise.com and its Spam folder, click They replied on every company that answered, then click I've read contact@polygonparadise.com on the Notifications page: live follow-ups wait for that." with the link **Open the inbox check**.

**Then practise the two daily clicks** (with a follow-up):

1. **Reply from one test mailbox** by pressing Reply. The answer arrives in contact@ (look in Spam too), not in the app.
2. **They replied:** on the campaign page, click that test mailbox's person (it opens **Person in this campaign**), click **They replied**, then **Mark as replied**. Its follow-up now shows **Stopped: they replied**. The company's status stays as it is: before going live, test emails don't count as emailed. (**They replied** is also on the company's own panel in Contacts; from there the follow-ups show **Stopped: someone at the company replied**.)
3. **The inbox check:** the next day, the other test mailbox's follow-up waits with "Waiting for today's inbox check (Notifications › Inbox check)." Open **Notifications**, read the card **Today's inbox check** and click **I've read contact@polygonparadise.com**. The follow-up then goes out.

This campaign also counts as the go-live "live test" once Mailgun reports it as delivered, as long as the sending domain, the From address and the test list stay the same.

**Try one address check** (once). After going live, live campaigns only email addresses the app has checked with Mailgun, and on the Free plan checks are an add-on. Going live doesn't need them, so find out now whether your account runs them:

1. In Mailgun, look for **Validations** in the left menu (it may be called **Email Validation** or sit under **Optimize**).
2. In the app, open **Settings › Deliverability**, scroll to **Test address checks**, type your own Gmail address and click the button. It costs about a cent. The answer says how long Mailgun took, for example "Checked in 1.4 s: can be emailed."
3. If Mailgun refuses the check (address checks pause, for example for a billing or plan reason), add Email Validations in Mailgun (**Account › Billing**) before your first real campaign, then click **Resume checks** on Settings › Deliverability. It costs about 1 cent per address.

## 11. Going live

Before you go live, do the [Going-live guide](4-going-live.md)'s steps 4 to 7 as well: the PC, backups and a practice restore, the settings to check once, and your test mailboxes after going live. Its step 2 lists the Domain checklist rows your setup needs.

1. When the live test says delivered, open **Settings › Sending & Mailgun** and scroll to the **Go live** card. If "Before going live:" still lists something, do that first. "Recommended first:" includes "Check in Mailgun that your account can email anyone: if it says free accounts only send to authorized recipients, add a payment card (Account › Billing). Otherwise the first live email to a prospect pauses sending." Do it: a live test to your own test mailboxes can't show this limit.
2. Click the **Go live** switch and read the dialog **Go live?**. Its third line is "Every email shows From contact@polygonparadise.com and goes out through polygonparadise.com itself. Replies come only to contact@polygonparadise.com: the app never sees them." On the Free plan the warm-up line ends at 90 a day: "Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 90 in about 4 weeks."
3. Tick the boxes:
   - "I read contact@polygonparadise.com every working day, its inbox and its Spam folder. When someone answers there, I click They replied on their company, I handle removal requests and "couldn't be delivered" notices with Mark unsubscribed, and then I click I've read contact@polygonparadise.com: live follow-ups wait for that each day."
   - On the Free plan: "I know unsubscribe links use http on my Mailgun plan, so Gmail's and Yahoo's one-click unsubscribe button may not show."
   - Only if the reply test's email landed in spam at one of your test mailboxes: "I know the reply test's email landed in spam at …" Tick it only if you accept that; start with small campaigns then.
   - **I understand that real prospects will get emails from now on.**
4. Click **Go live**. Without the first two ticks it says "Tick the box about replies in your own mailbox first." or "Tick the box about unsubscribe links first."

**What you should see:** "You're live. New campaigns now email everyone eligible, and warm-up has started." The top bar says **Sending live**. The card says "Live on polygonparadise.com since … (switched on by …). New live campaigns email everyone eligible.", then "Emails show From contact@polygonparadise.com; replies go straight to that mailbox."

What changes, the warm-up, your first real campaign and the first weeks are in the [Going-live guide](4-going-live.md#8-switch-on-go-live), from step 8 on. From now on, step 12 is part of every working day.

## 12. Every working day

1. Read contact@polygonparadise.com in Zoho Mail: its inbox **and its Spam folder**.
2. **A reply to a campaign:** open the company (search **Contacts** for the address it came from), click **They replied**, then **Mark as replied**. It stops every follow-up to that company, in every campaign. Once you're live, the company's status also becomes **Replied** and counts in the dashboard's reply rate.
3. **"Please remove me", an email to the unsubscribe address, or a "couldn't be delivered" notice about a campaign email:** in the company's panel, open that person's **⋯** menu and click **Mark unsubscribed** (or set the company's status to **Do not contact**). Nobody can email that address again.
4. **An out-of-office reply:** nothing to do.
5. Then open **Notifications** and, on the card **Today's inbox check**, click **I've read contact@polygonparadise.com**. Live follow-ups wait for that click each day ("Waiting for today's inbox check (Notifications › Inbox check).") and go once it's done. So do first emails to someone at a company that was already emailed before today (a colleague may have answered). First emails to companies nobody has emailed before don't wait.

Anyone who reads contact@ may click it; the **Activity** page shows who did. While follow-ups wait and nobody has clicked yet, the dashboard's **Needs your attention** list says so, and the Owner gets the bell notification "Live emails wait for today's inbox check". Emails the app sends are not in Zoho's Sent folder: the company's timeline has them.

## 13. The Free plan's limits

- **At most 90 campaign emails a day.** **Settings › Limits & warm-up** says "Your Mailgun plan sends at most 100 emails a day, so the app plans at most 90 campaign emails a day and keeps 10 for test emails." The warm-up rises from 50 to 90 a day instead of 1,000.
- **Never more than 100 emails in any 24 hours**, test emails included. When that many have gone out, test and live emails wait ("Waiting: your Mailgun plan's daily limit is used up. The next email can go at …"), and **Send me a test** says "Your Mailgun plan sends at most 100 emails in 24 hours, and that many have gone out. Try again later."
- **If Mailgun refuses an email because of its limit anyway**, sending pauses with "Paused: Mailgun's sending limit for your plan is reached". Click **Resume sending** in Settings › Sending & Mailgun the next day. Nothing is lost: the email goes back to the queue.
- **Logs are kept 1 day.** The app reads Mailgun's logs every hour while it runs. Keep the office PC on, with the app started by start.bat, on working days, and over the weekend if you can. If the PC was off for longer, the app can't read what Mailgun saw then; unsubscribes, complaints and bounces still come back through Mailgun's lists, and they still count toward the automatic pause.
- **Address checks** are an add-on on Free (step 10 tries one). Until a check was tried, the Go live card says: "Address checks are optional but paid: Mailgun's Free plan doesn't include them (the Email Validations add-on costs about 1 cent per address). Going live doesn't need them, but after going live, live campaigns only email checked addresses. Try one check in Settings › Deliverability › Test address checks; if Mailgun refuses it, add Email Validations in Mailgun (Account › Billing) before your first real campaign."

## 14. Optional: Google Postmaster Tools and your domain's age

- **Google Postmaster Tools** shows how Gmail rates polygonparadise.com, and it is the only place where Gmail's spam complaints about your emails show up, so it's recommended. Open [postmaster.google.com](https://postmaster.google.com), click **Add new domain** and type polygonparadise.com. If it asks you to verify the domain, add the TXT record it shows at GoDaddy as a new record (Name `@`), next to the others; never edit the record that starts with `v=spf1`. Postmaster shows data only once you send enough email, so don't worry if it stays empty at first. The checklist's **Gmail dashboard** row says "A Google verification record is on polygonparadise.com. Check at postmaster.google.com that polygonparadise.com is listed there." It may say this before you start, because polygonparadise.com already has a Google verification record for another Google service. So add polygonparadise.com in Postmaster Tools anyway, and check there that it's listed.
- **Domain age.** Inbox providers distrust brand-new domains; polygonparadise.com isn't new. On the checklist's **Domain age** row, enter the day you bought it ("When did you buy polygonparadise.com?"): 2024-08-22. It then says how old it is.

## 15. Switching to the full setup later

The full setup ([Mailgun and DNS guide](2-mailgun-and-dns.md)) sends through mail.polygonparadise.com on Mailgun's Foundation plan. What changes: replies come back through the app and stop follow-ups by themselves, so there is no daily inbox check; unsubscribe links use https; and Mailgun keeps 5 days of logs. contact@polygonparadise.com stays your From address. To move, in this order:

1. In Mailgun, upgrade to **Foundation** (**Account › Plan**, it may be called **Billing**).
2. Add mail.polygonparadise.com in Mailgun, in the **US** region, as the [Mailgun guide, step 4](2-mailgun-and-dns.md#4-add-mailpolygonparadisecom-in-mailgun) says.
3. Click **Pause all sending** (Settings › Sending & Mailgun).
4. Cancel every test or live campaign that is scheduled, running or paused: open it under **Campaigns** and click **Cancel campaign**. The way the app sends can't change while one of them is. To let a campaign finish instead, click **Resume sending** and wait until it has finished: nothing finishes while sending is paused.
5. In **Settings › Sending & Mailgun**, under **Mailgun connection**: **How the app sends**: **Through a sending subdomain (replies come through the app)**; **Sending domain**: mail.polygonparadise.com; then **Save and connect**. Going live ends. The From address contact@polygonparadise.com stays, and now works as the shared From address.
6. Open **Advanced**, choose **Your Mailgun plan**: **Foundation**, and click **Save these numbers**.
7. If sending is still paused, click **Resume sending**. The reply test can't send while sending is paused.
8. Everyone adds their **Reply address** in **Settings › My profile** (the [Mailgun guide, step 12](2-mailgun-and-dns.md#12-everyones-reply-address)).
9. Follow the Mailgun guide from [step 7](2-mailgun-and-dns.md#7-add-the-dns-records) on: the DNS records for `mail`, Apply recommended settings, the reply test with the pasted original and a live test to your test list. Then go live again ([Going-live guide, step 13](4-going-live.md#13-changing-the-sending-domain-or-the-from-address-later)).

## 16. Troubleshooting

**polygonparadise.com's mail and DNS:**

- **"Mail for polygonparadise.com stays with your mail provider (MX)" is red**, live emails say "Waiting: mail for your domain doesn't go to your mail provider (it points to Mailgun or Cloudflare Email Routing, or is missing), …", and the Owner gets the notification "Mail for polygonparadise.com goes to the wrong place". polygonparadise.com's MX records point to Mailgun, are gone, or go to Cloudflare Email Routing, so your everyday email and every reply are at risk. The row's fix names the records to keep or put back. At GoDaddy, delete the MX records of `@` that point to Mailgun (or, if you moved to Cloudflare, switch Email Routing off there), and put Zoho's back if they're missing: `mx.zoho.com` (priority 10), `mx2.zoho.com` (priority 20) and `mx3.zoho.com` (priority 50). Never add Mailgun's. Then click **Check again**. Live emails go again once the row is **Done**.
- **"Mailgun may send for polygonparadise.com (SPF)" is red.** Don't edit the SPF record yourself: your everyday Zoho mail depends on it too. Ask the person who set up the app. If polygonparadise.com's DNS moved to Cloudflare recently, the row may name a record that went missing in the move: add it back as the [Cloudflare guide, step 1](3-cloudflare.md#1-put-the-apps-domain-on-cloudflare) says.
- **"Mailgun may send for polygonparadise.com (SPF)" is amber: "Still spreading. Check again in 30 minutes."** The two DNS servers the app asks still see different records, often right after a DNS change or a move to Cloudflare. Change nothing: wait, then click **Check again**.
- **Mailgun shows polygonparadise.com's MX records as unverified.** That's expected and stays so (step 2).

**Sending:**

- **"Waiting for today's inbox check (Notifications › Inbox check)."** Read contact@ and click **I've read contact@polygonparadise.com** (step 12).
- **"Paused: Mailgun's sending limit for your plan is reached"**: the Free plan's 100 emails a day are used up. Click **Resume sending** the next day (step 13).
- **"Paused: Mailgun sends only to authorized recipients"**: add a payment card in Mailgun (step 1), then click **Resume sending**. Never authorize a prospect's address.
- **Nothing is sent, checked or heard from Mailgun**, or the dashboard says the background sender isn't running: the app runs in a `npm run dev` window instead of start.bat. Close that window and double-click **start.bat** (step 1).
- **start.bat says "Port 3000 is already in use"**: a window running `npm run dev` is still open. Close it (click in it, press Ctrl+C), then double-click start.bat again.
- **A reply doesn't stop the follow-ups**: in your setup the app never sees replies. Click **They replied** on the company (step 12).
- **Another "Paused: …" message**: the red card in **Settings › Sending & Mailgun** says why and what to do. The [Mailgun guide, step 18](2-mailgun-and-dns.md#18-troubleshooting) explains the common ones; its parts about reply addresses, reply routes and mail.polygonparadise.com don't apply to your setup.

**The reply test:**

- **It doesn't start**, and says "Add the DMARC record first …": add the `_dmarc` record (step 6) and wait until the DMARC row is **Done**.
- **"Emails to u+…@polygonparadise.com don't reach anyone"**: turn on the catch-all address in Zoho (or, without one, add the email aliases), then send the email to that address again and change the answer. If nothing works, click **Leave out unsubscribe by email** under the failure line (step 9).
- **"The test email's original still offers unsubscribe by email (mailto:). …"** after you left it out: the original you pasted is from a test email sent before. Click **Send test emails to my test list** and paste the original of a new one.
- **"The test email's List-Unsubscribe line has no working link, …"**: Mailgun didn't fill in its link in the app's own line, so leaving out unsubscribe by email doesn't work with your Mailgun account. Click **Offer unsubscribe by email again**, then turn on the catch-all address or tell the person who set up the app.
- **"…: Mailgun's report for this test email is no longer available, so the app can't see that it arrived. Send the test emails again."**: Mailgun keeps its reports for 1 day on Free, and the PC was off or the app wasn't running. Send the test emails again and keep start.bat running for the next hour.
- **"Your unsubscribe click happened while the app couldn't read Mailgun's reports, …"**: in Settings › Deliverability, click **Remove** next to that test mailbox, then click the unsubscribe link in the test email again.
- **"The test email's original offers unsubscribe by email, but the app can't read that address, …"**: paste the whole original again (select all, copy, paste). If it stays, click **Leave out unsubscribe by email**, or tell the person who set up the app.
- **"Mailgun's report for your live test email is no longer available (Mailgun keeps its reports only for a short time), …"** on the Go live card: send one more live campaign to your test list (step 10) and check that it arrives.
- **"…: your reply didn't arrive in contact@polygonparadise.com."**: look in contact@'s Spam folder and at Zoho's filters, then change the answer.
- **"The test email's return address is on …, not on polygonparadise.com."**: tell the person who set up the app.
- **"Send me a test" to contact@ didn't arrive**: it comes From contact@polygonparadise.com, so it's an email from yourself to yourself, which Zoho may hide or filter. Look in spam, or use a Gmail address as your inbox for test emails (step 8).

If something here doesn't match what you see, see "Getting help" in the [README](../../README.md#getting-help).

> **Tidy up (optional)**
>
> Open `.env` in the app folder with Notepad (right-click › **Open with** › **Notepad**). If a line starts with `MAILGUN_`, delete that line: the app never reads it, because your keys live encrypted in the app. Change nothing else in `.env`, save it, and copy the new `.env` to your USB stick or password manager again.
