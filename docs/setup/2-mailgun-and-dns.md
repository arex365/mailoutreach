# Mailgun and DNS guide

> Using polygonparadise.com itself on Mailgun's Free plan, with replies in contact@? Follow the [Own-mailbox guide](2-own-mailbox.md) instead.

This guide sets up Mailgun, the service that sends your emails, so that every email arrives From **contact@polygonparadise.com** with the sender's own name, sent through the subdomain **mail.polygonparadise.com**, which Mailgun handles. Inbox providers can then trust your emails, replies come back through the app, and your everyday email at polygonparadise.com stays with Zoho Mail. At the end you send a small live campaign to your own test mailboxes and reply to it, and set up address checks and the Anthropic key for AI personal lines (step 19). The full rehearsal before going live (follow-ups, replies, address checks and AI lines) is in the [Going-live guide, step 3](4-going-live.md#3-rehearse-with-your-test-mailboxes).

It takes about an hour of clicking, spread over a day or two, because some steps involve waiting (DNS changes, Mailgun's business verification). Do the steps in order. Step 10 sends you to the Cloudflare guide ([3-cloudflare.md](3-cloudflare.md)) and back.

This guide uses your real names: **polygonparadise.com** is your main domain (your website and your everyday email at Zoho Mail; its DNS records are at GoDaddy), **mail.polygonparadise.com** is the sending subdomain Mailgun handles, **contact@polygonparadise.com** is the From address every email shows, and **arslan@mail.polygonparadise.com** is an example of one person's reply address. Only **outreach.example.com** is a stand-in: type the app's own public address from the Cloudflare guide instead. The app shows your real values everywhere, with Copy buttons.

Mailgun's, GoDaddy's and Cloudflare's own screens change from time to time. Where a button or menu name couldn't be checked against the live dashboard, this guide says "(it may be called …)". If a label differs, look for the closest match; the meaning stays the same.

> **Your decision, and what to watch**
>
> Every email shows From contact@polygonparadise.com, so your everyday email from polygonparadise.com shares its reputation. If people mark these emails as spam, your normal emails (to clients, with quotes and invoices) can land in spam too, and that takes weeks to fix. That was your decision, made knowing this. What the app can and can't see:
>
> - The app pauses sending when Mailgun reports complaints (from Microsoft, Yahoo and others). **Gmail and Google Workspace never report complaints**: only Google Postmaster Tools shows those (step 16).
> - Keep **Settings › Deliverability** › **Thresholds** as they are, and once a week look at the dashboard's **Domain health** and at Google Postmaster Tools for polygonparadise.com.
> - Replies written straight to contact@polygonparadise.com, instead of pressing Reply, don't reach the app (step 14 says what to do).
> - The way back, if polygonparadise.com's reputation suffers, is in the README's "Sending safely" ("Your main address's reputation"), in the order to do it.

---

## 1. Before you start

You need:

- **Mailgun on the Foundation plan.** You already have a Mailgun account with polygonparadise.com in it. The app needs Foundation (about $35 a month for 50,000 emails): it allows a second domain, a reply route for each teammate, secure unsubscribe links and 5 days of logs, and your 500–1,000 emails a day need it anyway (the cheaper Basic plan stops at 10,000 a month). A Free or trial account (Mailgun shows an **Upgrade** button and a sandbox domain) must be upgraded first: step 3.
- **Start Mailgun's business verification first** (step 3). It can take days, and until it's done Mailgun holds new accounts to very low limits.
- **polygonparadise.com's DNS records, at GoDaddy.** You add a few records for `mail` and one for `_dmarc`. Everything that is already there stays exactly as it is.
- **Your mail provider stays Zoho Mail.** contact@polygonparadise.com and your everyday email keep working as today. Nothing in this guide changes polygonparadise.com's mail servers (MX).
- **DNS changes can take up to 24–48 hours** to be seen everywhere. Usually it's much quicker.
- **Your reply inbox and 2–3 test mailboxes:** one Outlook.com (or Hotmail) mailbox and one Gmail or Yahoo mailbox, none of them your reply inbox, and never contact@polygonparadise.com.
- **Mailgun's rules on cold email:** Mailgun's usage policy asks for the recipient's consent for marketing email and bans scraped lists, so cold outreach can get an account limited or closed. The app keeps bounces and spam complaints low, which is the best protection.

What you'll set up:

| Where | What | Step |
|---|---|---|
| Mailgun | The Foundation plan and business verification | 3 |
| Mailgun | mail.polygonparadise.com (US region), an API key, a monthly safety limit | 4–5, 9 |
| The app | The connection to Mailgun, and the From address contact@polygonparadise.com | 6 |
| polygonparadise.com's DNS (GoDaddy) | The records the app lists for you: for `mail`, `email.mail` and `_dmarc` | 7–8 |
| Cloudflare | The app's public address (separate guide) | 10 |
| The app | Recommended settings, reply addresses, test list, the reply test, a first live campaign | 11–14 |
| Mailgun, the Anthropic Console and the app | Address checks, and the Anthropic key for AI lines | 19 |

## 2. Your sending subdomain (nothing to buy)

The app sends through **mail.polygonparadise.com**. It's part of polygonparadise.com, so there is nothing to buy: you add it in Mailgun (step 4) and give it a few DNS records (step 7). Mailgun handles mail for mail.polygonparadise.com only; mail for polygonparadise.com itself stays with Zoho Mail.

Before you go on, check that the name `mail` is still free:

1. Sign in at GoDaddy, open **My Products** and click **DNS** next to polygonparadise.com (it may be called **Manage DNS**, or sit under **Domain Portfolio**).
2. Look through the list for a record whose **Name** is exactly `mail`. If there is a **CNAME** named `mail`, stop here and tell the person who set up the app: it would block the records of step 7.
3. Change nothing on this page yet.

**Never switch on email forwarding for `mail`** (at GoDaddy or, later, Cloudflare Email Routing): it replaces the mail records that send replies to Mailgun, so replies would never reach the app.

**What you should see:** no record named `mail` in the list yet. Zoho's and Mailgun's existing records for polygonparadise.com stay as they are.

## 3. The Mailgun account

1. You already have a Mailgun account. Open **Account › Plan** (it may be called **Billing**). If it doesn't say **Foundation**, click **Upgrade** and choose Foundation.
2. A banner at the top of Mailgun asks for **business verification**. Fill in the form straight away: your studio's name, website and what you send. Approval can take a few days.

**What you should see:** the plan says Foundation, and the banner disappears once Mailgun has approved you. You can carry on with the next steps while you wait.

## 4. Add mail.polygonparadise.com in Mailgun

1. In Mailgun, open **Send › Domains** (it may be **Send › Sending › Domains**).
   - **polygonparadise.com is already there: keep it. Never delete it**: it signs your emails, and its signature key can't be moved or recovered. Mailgun shows its MX records as unverified: that's correct. **Never add Mailgun's MX records to polygonparadise.com**: its mail stays with Zoho.
   - **Leave the sandbox domain alone** (its name ends in `mailgun.org`). It's only for Mailgun's own tests.
2. Check polygonparadise.com's region: open it and look at its DNS records. MX values ending in `eu.mailgun.org` mean EU; values ending in just `mailgun.org` mean US. polygonparadise.com is in the **US** region.
3. Click **Add new domain**. **Domain name:** `mail.polygonparadise.com`. It can't be renamed later.
4. **Region: US**, the same as polygonparadise.com. The region can never be changed for this domain later.
5. **DKIM (the email signature):** leave the DKIM authority on polygonparadise.com, Mailgun's default for a subdomain (it may be called **DKIM authority** or sit under advanced settings), and leave **Automatic Sender Security** off (it may be under advanced settings). If Mailgun switches Automatic Sender Security on by itself, that's fine too: the DKIM row in step 7 then shows two records to add under `mail`. Leave the other options as they are.
6. Click **Add domain**.

**If Mailgun says you've reached your domain limit**, upgrade first (step 3). Never delete polygonparadise.com to make room.

**If mail.polygonparadise.com is already there in the EU region** (its MX values end in `eu.mailgun.org`): delete **that one**, only mail.polygonparadise.com and never polygonparadise.com, and add it again in the US region as above. Nothing is lost: nothing was published or sent for it yet. If Mailgun won't take the name again straight away, wait a day or ask Mailgun's support. Never choose EU in the app instead. If the app was already connected to it in the EU region, change **Region** to US in **Settings › Sending & Mailgun** and click **Save and connect** once the name is in the US region: the app then says that emails sent through the EU region no longer count for the reply test or the live test, so run both again (steps 13 and 14).

**What you should see:** a page listing DNS records for mail.polygonparadise.com. You don't need to copy them from here: the app shows the ones you need with Copy buttons in step 7. The DKIM record's name usually ends in `._domainkey.polygonparadise.com` and is already verified (it's polygonparadise.com's own key). If it ends in `._domainkey.mail.polygonparadise.com` instead, you add it in step 7.

## 5. Create the API key

The API key is the password that lets the app use Mailgun.

1. In Mailgun, open your profile menu (top right) and choose **API Security** (it may be called **API keys**).
2. Create a new key (the button may be called **Create API key** or **Add new key**):
   - **Role: Developer.** The role can't be changed later. Developer can do everything the app needs and nothing more.
   - **Name:** Outreach app.
3. Copy the key straight away and keep the page open until step 6. Mailgun may show it only once. Don't email it or save it in a document; the app stores it encrypted. It goes only into **Settings › Sending & Mailgun** (step 6), never into the `.env` file.

**What you should see:** the new key in the list, role Developer.

## 6. Connect Mailgun and set the From address

1. In the app, open **Settings › Sending & Mailgun**.
2. Under **Mailgun connection**:
   - **Region:** US.
   - **How the app sends:** **Through a sending subdomain (replies come through the app)** (it's already chosen). The other choice, From polygonparadise.com itself, is the [Own-mailbox guide](2-own-mailbox.md)'s setup.
   - **Sending domain:** mail.polygonparadise.com.
   - **API key:** paste the key from step 5.
   - **Leave the Domain sending key empty** (under **Advanced**). The API key sends your emails. Only if a sending key was saved earlier: open **Advanced** and click **Remove the sending key** (step 18 says why).
3. Click **Save and connect**. The app first tests the key and the domain with Mailgun, and saves them only if the test passes.
4. Open **Advanced**. Under **Your Mailgun plan** choose **Foundation**: the numbers below it change to 5 days of event logs and 1 day of stored replies. Click **Save these numbers**.
5. Right under it is the **From address** card. Type `contact@polygonparadise.com` in **From address (optional)** and click **Save From address**. The hint under the field shows what people will see: "People see "Arslan from Polygon Paradise <contact@polygonparadise.com>": each person's display name with this address. Replies go to each person's own address on mail.polygonparadise.com, and from there to their reply inbox. It must end in @polygonparadise.com."

**What you should see:** "Connected to mail.polygonparadise.com (US) · key ending …1a2b · checked just now". The app also fetches Mailgun's webhook signing key by itself; you never type that one. After **Save From address**, the message "From now on, campaign emails show From contact@polygonparadise.com, and replies go to each person's address on mail.polygonparadise.com. Run the reply test before live campaigns (Settings › Domain checklist)." The card then shows a note about your everyday email's reputation and a closed **Good to know** list: read both once.

**If it goes wrong:**

- "Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here." Copy the key again (no spaces before or after), or make a new one.
- "Mailgun can't find mail.polygonparadise.com in the US region, only in EU. If your main domain is in the US region in Mailgun, delete mail.polygonparadise.com there and add it again in the US region (Mailgun guide, step 4). Otherwise change Region to EU." **Don't** change Region to EU: polygonparadise.com is in the US region. Go back to step 4 and add mail.polygonparadise.com in the US region.
- "Mailgun has no domain called mail.polygonparadise.com in either region. Check the spelling, or add it in Mailgun first (Send › Domains › Add new domain)."
- "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4)." You typed polygonparadise.com as the sending domain: type mail.polygonparadise.com, or choose From polygonparadise.com itself and follow the Own-mailbox guide.
- "That's Mailgun's sandbox domain, for tests only. Type mail.polygonparadise.com (add it in Mailgun first: Send › Domains › Add new domain)."
- "Couldn't reach Mailgun. Check this PC's internet connection and try again."
- Under the From address: "The From address must end in @polygonparadise.com, the main domain of your sending domain mail.polygonparadise.com." (you typed another domain), or "Leave this empty to send from each person's own address on mail.polygonparadise.com. A shared From address goes on your main domain, for example contact@polygonparadise.com." (you typed an address on mail.polygonparadise.com). Type `contact@polygonparadise.com`.

## 7. Add the DNS records

The DNS records tell mail servers that Mailgun may send for mail.polygonparadise.com, that replies to it go to Mailgun, and what your policy for polygonparadise.com is.

1. In the app, open **Settings › Domain checklist**. Each row that still needs a record shows it in a box: the **Type** (and the **Priority** for MX), then the **Name** and the **Value**, each with a **Copy** button. The names are already written the way GoDaddy's form wants them, for example `mail`.
2. Open polygonparadise.com's DNS records at GoDaddy (**My Products**, then **DNS** next to polygonparadise.com; labels may differ slightly), or at Cloudflare if you moved polygonparadise.com there (**DNS › Records**).
3. For each record the checklist shows, click **Add New Record** (it may be called **Add**), choose the **Type**, fill in the **Name**, the **Value** and, for MX, the **Priority**, copying each from the app, and save.

**GoDaddy's form may fill Name with `@`: change it to `mail` (or `email.mail`, `_dmarc`) before you save.** A record saved with the Name `@` belongs to polygonparadise.com itself.

| Row in the app | Type | Name | Value (always copy from the app) |
|---|---|---|---|
| Mailgun may send for mail.polygonparadise.com (SPF) | TXT | `mail` | usually `v=spf1 include:mailgun.org ~all` |
| Replies reach the app (MX) | MX (two records) | `mail` | `mxa.mailgun.org` and `mxb.mailgun.org`, **priority 10** |
| Unsubscribe links work (tracking CNAME) | CNAME | `email.mail` | `mailgun.org` |
| Mail servers know your policy (DMARC) | TXT | `_dmarc` | `v=DMARC1; p=none` (this one is for polygonparadise.com) |
| Your emails are signed (DKIM) | usually nothing to add | | The row turns green by itself: polygonparadise.com's signature key (`mx._domainkey`) is already there. Add a record only if the row shows a box. |

Rules that matter:

- **Never add, delete or change the MX records or the SPF record of `@` (polygonparadise.com itself), and leave every record that is already there alone**, including `dc-…._spfm` (GoDaddy's helpers for the SPF record), `mx._domainkey` (Mailgun's signature key) and `zmail._domainkey` (Zoho's). They carry your everyday Zoho mail and sign your emails.
- **Always copy the values from the app, never from this guide.** Mailgun's values can differ between accounts.
- **Type only the first part in the Name box:** `mail`, `email.mail`, `_dmarc`. GoDaddy adds `.polygonparadise.com` itself, so typing the full name gives `mail.polygonparadise.com.polygonparadise.com`.
- **Only ever one SPF record for `mail`** (one TXT record named `mail` that starts with `v=spf1`). This rule is about `mail`: polygonparadise.com's own SPF record (Name `@`) stays exactly as it is.
- The DMARC record `v=DMARC1; p=none` also covers your everyday email from polygonparadise.com; p=none changes nothing for it.
- **Optional DMARC reports:** leave them out. The daily reports would arrive as attachments in contact@. If you do want them, use `v=DMARC1; p=none; rua=mailto:dmarc@mail.polygonparadise.com`, never dmarc@polygonparadise.com: the app forwards dmarc@mail.polygonparadise.com to your inbox (step 15).
- If the DKIM row does show a box, paste its long value in one piece.
- **At Cloudflare** (only if you moved polygonparadise.com there): every CNAME must be "DNS only" (grey cloud), not "Proxied" (orange cloud). A proxied CNAME hides the record, and Mailgun can't check it.
- **Mailgun's automatic DNS setup** (it may be called "Authorize" or "Automatic setup"): if you use it instead of typing the records, check afterwards that the row "Mail for polygonparadise.com stays with your mail provider (MX)" on the Domain checklist is **Done**.

**What you should see:** in GoDaddy's list, the new records: three named `mail` (one TXT, two MX), one named `email.mail` and one named `_dmarc`, and every record that was there before, unchanged.

## 8. Wait, then check

1. Wait a few minutes, then click **Check again** on **Settings › Domain checklist**. (After a check the button says "Checked just now" and rests for a minute.) Under its title the page says "Emails show From contact@polygonparadise.com and go out through mail.polygonparadise.com."
2. Each row turns green (**Done**), amber, red or grey:
   - **Green:** done.
   - **Amber "Still spreading. Check again in 30 minutes.":** one of the two public address books the app asks already sees the record, the other doesn't yet.
   - **Red:** missing or wrong. The row says what to do.
   - **Grey "Couldn't check right now.":** a lookup timed out. Try again later.
   - **Grey "For your information":** nothing to do; the row only tells you something.
3. Records usually spread within minutes to an hour. But if the app (or anyone) looked before you saved a record, the answer "missing" can stick for up to 30 minutes. Mailgun itself says changes can take up to 48 hours.

**What you should see** under **DNS records**:

- Green: "Mailgun may send for mail.polygonparadise.com (SPF)", "Replies reach the app (MX)", "Unsubscribe links work (tracking CNAME)" and "Mail servers know your policy (DMARC)" ("polygonparadise.com's policy: monitor only. Right for now.").
- "Your emails are signed (DKIM)" green, for example "Your emails carry polygonparadise.com's digital signature (1024-bit; it works, 2048-bit is stronger), which matches your From address." It may also say "Mailgun didn't list a DKIM record for mail.polygonparadise.com. With a From address, polygonparadise.com usually signs your emails." until you paste a test email's original in the reply test (step 13) and click **Check again**: that's expected.
- "Mail for polygonparadise.com stays with your mail provider (MX)" green: "Mail for polygonparadise.com goes to your mail provider (…), not to Mailgun. Keep it that way."
- "polygonparadise.com's SPF record (your everyday email)" grey, for example "polygonparadise.com's SPF record is almost full (9 of 10 DNS lookups). Before you add another email service to polygonparadise.com, ask the person who set up the app." Nothing to do: just don't add another email service to polygonparadise.com without asking.
- **Unsubscribe links are secure (HTTPS)** stays red ("Unsubscribe links use http.") until step 11, where Apply recommended settings asks Mailgun for the certificate; that's expected.

And "Mailgun knows your domain" says "Mailgun has your domain (US) and has confirmed your records."

## 9. Set Mailgun's monthly safety limit

The monthly safety limit is an emergency brake in Mailgun itself: if something ever went badly wrong, Mailgun stops after this many emails in a month. The app's key isn't allowed to set it, so you set it by hand.

1. In Mailgun, find the account's custom message limit. It's in the account settings (it may be called **Custom message limit**, **Sending limit** or **Message limit**; the exact place couldn't be checked).
2. Set it to about **30,000** a month (the smallest allowed is 1,000). That's comfortably above 1,000 emails a day.

Mailgun emails you at 50% and 75% of the limit. When it's reached, the **whole account** stops sending until the next month or until you raise it.

**What you should see:** after the next check, the app's row **Monthly safety limit** says "Mailgun stops everything after 30,000 emails this month (… used)." Until then it's amber. The app's key may not be allowed to read this limit; if the row stays amber after you've set the limit in Mailgun, you can ignore it. It never blocks sending.

## 10. Now do the Cloudflare guide

The next steps need the app's public https address, because Mailgun must be able to reach the app from the internet. Follow [3-cloudflare.md](3-cloudflare.md) to the end (including its tests), then come back here.

**What you should see:** Settings › System shows "Remote access works".

## 11. Apply recommended settings

1. Open **Settings › Domain checklist** and click **Apply recommended settings** (the orange button). It switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers, marks spam instead of deleting it, keeps stored replies for your plan's time, sets up secure unsubscribe links, the webhooks and the reply routes. It only ever changes mail.polygonparadise.com in Mailgun, never polygonparadise.com.
2. Watch the steps appear. Each one says what it did, for example:
   - "The public address answers: https://outreach.example.com."
   - "Open tracking is off." and "Click tracking is off."
   - "Mailgun's unsubscribe handling is on, with its own footers blank."
   - "Suspicious replies are marked, never deleted."
   - "Mailgun keeps stored replies for 1 day."
   - "Mailgun is preparing the certificate for secure unsubscribe links." (See below.)
   - "Webhook signing key saved."
   - "Mailgun tells the app about deliveries, bounces, complaints and unsubscribes."
   - "Reply routes are set up for 2 senders, plus a catch-all." The number counts the reply addresses people have chosen so far. Before step 12 it can be 0, which is fine: each address gets its route as soon as it's saved.
3. **Secure unsubscribe links take a while.** Mailgun needs to make a certificate for email.mail.polygonparadise.com. The app checks every minute for up to half an hour and tells you ("Secure unsubscribe links are ready"); the steps then say "The certificate for secure unsubscribe links is ready." and "Unsubscribe links use https." If it takes longer: "Mailgun is still preparing the certificate. Check again later."

**What you should see:** the rows under **Mailgun settings** turn green (click **Check again** if one still shows the old state), with two exceptions that are expected at this point:

- **Replies reach each sender** stays red ("Nobody has a reply address yet. Everyone adds theirs in Settings › My profile › Reply address.") until people add their reply addresses in step 12.
- **Monthly safety limit** may stay amber (see step 9).

Under **DNS records**, **Unsubscribe links are secure (HTTPS)** turns green once the certificate is ready. "Reply test" stays amber until step 13.

**If Apply can't do something** (a red step), it says why. The most likely ones:

- **Mailgun kept its own unsubscribe footer.** Do it by hand in Mailgun, for mail.polygonparadise.com: open **Send › Domain settings › Tracking** (it may be under the domain's **Settings** tab):
  1. Switch **Open tracking** off and **Click tracking** off.
  2. Switch **Unsubscribes** on (it may be called **Unsubscribe tracking**), then open its footer text (it may be called **Customize unsubscribe templates**) and clear **both** boxes (HTML and text) so they are completely empty.
  3. Save, then click **Apply recommended settings** in the app again, so the app checks it.
- "Mailgun hasn't made a webhook signing key for your account yet. In Mailgun, open API Security and create the HTTP webhook signing key, then click Apply recommended settings again."
- "The app's public address doesn't answer yet (…/api/health). Finish the Cloudflare guide, check it on your phone, then try again."
- "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do."
- "Mailgun can't check email.mail.polygonparadise.com yet. Fix the 'Unsubscribe links work' row first." (Step 7: the `email.mail` CNAME.)
- "Your Mailgun plan keeps stored replies for less time. Set 'stored replies' in Settings › Sending & Mailgun to what your plan allows." (Under **Advanced**.)
- "Couldn't confirm the reply route for … yet. The app checks again in a few minutes." Nothing to do: Mailgun sometimes needs a moment to find a new route, and the app asks again by itself.

## 12. Everyone's reply address

Each person who sends campaigns needs a reply address on mail.polygonparadise.com, for example arslan@mail.polygonparadise.com. Prospects see that person's display name with contact@polygonparadise.com, for example "Arslan from Polygon Paradise <contact@polygonparadise.com>". When they press Reply, their answer goes to the person's reply address: the app records it and stops the follow-ups, and Mailgun forwards it to the person's reply inbox.

1. Each person (you too) opens **Settings › My profile**.
2. **Sender display name:** the name prospects see next to contact@polygonparadise.com, for example "Arslan from Polygon Paradise".
3. **Reply address:** type the part before the @, for example `arslan`. The field shows `@mail.polygonparadise.com` after it, and says "People see contact@polygonparadise.com as the sender, with your display name. When they press Reply, their answer goes to this address: the app records it, and Mailgun forwards it to your reply inbox."
4. **Reply inbox:** where the replies are forwarded: a normal mailbox, such as contact@polygonparadise.com, Gmail or Outlook.com. It must never be an address on mail.polygonparadise.com ("Your reply inbox can't be on the sending domain mail.polygonparadise.com: replies would go round in circles.").
5. **Signature:** "If your signature shows an email address, use your reply address (arslan@mail.polygonparadise.com), so answers reach the app."
6. Click **Save profile**. The app sets up that person's reply route in Mailgun by itself.

**Never point polygonparadise.com's mail servers (MX) to Mailgun, and never forward contact@polygonparadise.com to an address on mail.polygonparadise.com.** Mail from contact@ reaching the app counts as your team's own, never as a prospect's reply.

**What you should see:** "Profile saved. Your reply address is now arslan@mail.polygonparadise.com; its reply route is being set up." Under the field, "Reply route: Being set up…", then within a minute or two "Reply route: working (checked … ago)".

**If it goes wrong:** "… is kept for mail servers and can't be a sender address. Pick another name, for example your first name." Names like postmaster, info, contact or noreply can't be a reply address (contact@polygonparadise.com, your From address, is a different address and stays with Zoho). "Reply route: Not working: …" means the reply route has a problem; the text says what, and **Apply recommended settings** (Owner) usually fixes it.

## 13. The test list and the reply test

Until you go live ([Going-live guide](4-going-live.md)), real email only ever reaches the addresses on your test list, and your own reply inbox when you click "Send me a test".

**The test list**

1. Open **Settings › Sending & Mailgun**, section **Test list**. For each test mailbox, type its address in **Add a test mailbox** and click **Add address**: 2 or 3 mailboxes, at least **one Outlook.com** (or Hotmail/Live) and **one Gmail or Yahoo**. Never your reply inbox (Gmail hides emails sent to and from the same address), and never contact@polygonparadise.com: it's your From address, and the app refuses it.
2. Under **Sending mode**, choose **Live (test list only)** and click **Save mode**. The app asks "Real emails will go to your test-list addresses only: …, and to your own reply inbox when you click Send me a test. Everyone else is left out until you go live. Switch to live?" Click **Switch to live**.

**What you should see:** the top bar says **Test list only**.

After you go live, the choice is called just **Live**, and it emails everyone eligible. **Test mode** always stays on the test list.

**The reply test** (about 20 minutes)

This test proves, on your own Mailgun account and before any live campaign can start, that emails From contact@polygonparadise.com arrive properly, that replies still reach the app cleanly (Mailgun warns that its unsubscribe handling can change forwarded replies so that inbox providers distrust them), and that bounces, automatic replies and unsubscribes come back to mail.polygonparadise.com and so to the app.

1. Open **Settings › Domain checklist** and scroll to **Reply test**. If a "Before you start" list shows, fix each item first (for example "Your reply route isn't working yet. Click Apply recommended settings.").
2. Click **Send test emails to my test list**. Each test mailbox gets an email "Reply test from Polygon Paradise Outreach", sent From contact@polygonparadise.com, with replies going to your reply address. The section says "Send the test emails: one to each mailbox on your test list, from contact@polygonparadise.com (replies go to arslan@mail.polygonparadise.com)." Test emails count toward today's limit.
3. In **each** test mailbox, find the email and note, **before you move it out of spam**, whether it arrived in the inbox or in spam (junk). Gmail's Promotions and Updates tabs count as the inbox. Then move it to the inbox if it isn't there, open it and **reply** with a short message such as "Got it".
4. Back in the app, each test mailbox has its own box showing what the app can see itself: **Test email** ("Delivered" once Mailgun has delivered it) and **Reply reached the app** ("Yes" once your reply is in). Then answer the questions in each box, in this order:
   - "Did the test email arrive in this mailbox's inbox, not in spam or junk? (Gmail's Promotions or Updates tab counts as the inbox.)" Yes / No. A No doesn't fail the test, but going live then asks you to tick a box about it ([Going-live guide, step 8](4-going-live.md#8-switch-on-go-live)).
   - **"Did the reply arrive in your reply inbox, not in spam?"** Look in your own reply inbox. Yes / No.
   - **"Does it say dkim=pass or arc=pass?"** Open the reply in your reply inbox and show its original:
     - **Gmail:** open the email, click **⋮** (three dots, top right) › **Show original**.
     - **Outlook.com:** open the email, click **⋯** › **View** › **View message source**.
     - "Zoho Mail: open the email, click ⋯ (More actions) › Show original (it may be called View original)."

     Look for `dkim=pass` or `arc=pass`. Yes / No / **Not sure**. "Not sure" opens a box "Paste the email's original headers here, and the app reads them for you." Paste the whole original and click **Read the headers**; the app fills in the answer and doesn't keep the text.
   - "Open the test email's original (Gmail: ⋮ › Show original. Outlook.com: ⋯ › View › View message source). Does it say DMARC: PASS (Gmail) or dmarc=pass?" This one is about the **test email** in the test mailbox, not your reply. Yes / No / **Not sure**. "Not sure" opens "Paste the test email's original here, and the app reads it for you." with the **Read the headers** button; the text is never stored.
5. **The test email's original** (below the mailboxes, once): open one test email in a test mailbox and show its original. In Gmail that's **⋮** › **Show original** › **Copy to clipboard**; in Outlook.com **⋯** › **View** › **View message source**, then select all and copy. Paste the whole text into the box and click **Read the original**. The app reads who sent it, its return address, DMARC and the signature, and doesn't keep the text. It then shows one line per check:
   - "From: contact@polygonparadise.com ✓"
   - "Return address: …@mail.polygonparadise.com ✓ (bounces and automatic replies reach the app)". **The return address must end in mail.polygonparadise.com.** This line proves that bounces and automatic replies come back to Mailgun and the app instead of your everyday inbox.
   - "The original says DMARC: PASS."
   - "Signed by polygonparadise.com ✓"
   - "Unsubscribe by email: …@mail.polygonparadise.com ✓", or "Unsubscribe by email: not offered (the link works) ✓".

   If it says "This isn't one of the current test emails. Paste the original of a test email sent with the From address contact@polygonparadise.com.", you pasted an older email: use one of the test emails from step 2.
6. **Check the unsubscribe headers once:** in the same original, the app asks "Do you see `List-Unsubscribe: <https://…>` and `List-Unsubscribe-Post`?" Answer Yes or No. Its note: "If it also shows a mailto: address, the part after the @ must end in mail.polygonparadise.com (for example u+…@mail.polygonparadise.com or …@email.mail.polygonparadise.com). If it is …@polygonparadise.com, answer No."
7. Then **click the unsubscribe link** at the bottom of that test email. The app shows "Unsubscribe reached the app ✓". That mailbox is now on the do-not-email list, so put it back: follow the link to **Settings › Deliverability**, find the address and click **Remove**.
8. Click **Save the result**.

**What you should see:** **Passed** ("Setup A passed on … with the From address contact@polygonparadise.com: replies arrive in your inbox, unsubscribe links work, and the test email passed DMARC."). It passes when at least one Outlook.com mailbox and at least one Gmail or Yahoo mailbox each had the email delivered, the reply reached the app, the reply was in your inbox and not spam, and DKIM or ARC passed; when every mailbox answered the inbox question and its test email passed DMARC; when the pasted original shows a return address on mail.polygonparadise.com; plus the unsubscribe headers and the unsubscribe click. A test email that landed in spam shows as "…: the test email landed in spam." under the result and doesn't fail the test: going live asks you about it.

The test runs with **Setup A** (the normal setup: Mailgun's unsubscribe handling on), which live campaigns need. It counts only for mail.polygonparadise.com and contact@polygonparadise.com: after a change of the From address, run it again (emails sent before the change show "Not sent yet with this From address").

**Write down for the person who set up the app**, whether the test passes or not: where out-of-office replies landed (step 3 of the Going-live guide tries one), whether Gmail shows "via" next to the sender (open the test email in Gmail and click the small arrow under the sender's name: "mailed-by" should say mail.polygonparadise.com and "signed-by" polygonparadise.com), and whether Outlook.com shows "on behalf of".

**If it fails:** the section says which check failed: "The reply test didn't pass with the From address contact@polygonparadise.com. The lines above say which check failed. If it was the return address or DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on mail.polygonparadise.com) and ask the person who set up the app." Write down the answers you gave and see "Getting help" in the [README](../../README.md#getting-help). **Try Setup B (check only)** runs the test once more with Mailgun's unsubscribe handling off; it's only a check and is never used for campaigns. **Back to Setup A** returns to normal. Live campaigns stay locked until the test passes with Setup A.

## 14. Your first live campaign to the test mailboxes

**Prepare the test companies** (once), so real companies are never touched:

1. Open **Contacts** and click **New list** (left side). Name it **Test mailboxes** and click **Create list**.
2. For each test mailbox, click **Add company**:
   - **Company name:** for example "Test – Gmail".
   - **Country:** Pakistan. Emails only go out inside the recipient's sending hours (normally Monday to Friday, 9:00–17:00 in the company's time zone), so this makes them follow your own day. A company without a country uses the default zone (Berlin).
   - **Add to list:** Test mailboxes.
   - **First person › Email:** the test mailbox's address.
   - Click **Add company**.

**Send the campaign:**

1. In **Contacts**, open the **Test mailboxes** list, tick all its companies, and click **Email these companies** in the bar at the bottom.
2. Go through the steps: **Audience:** the Test mailboxes companies. **Sender:** you; it shows "Recipients see" with "Arslan from Polygon Paradise <contact@polygonparadise.com>" and your **Reply address**. **Message:** any template. If it has follow-ups, they go out too, in the same email thread after their wait, to each test mailbox that hasn't replied; switch them off on this step if you only want the first email. **Verify:** test-list addresses count as checked. **Review:** optionally click **Send me a test** to get one email in your own reply inbox first. It comes From contact@polygonparadise.com; if your reply inbox is contact@polygonparadise.com itself, the app adds "It comes from contact@polygonparadise.com, your own address: if it isn't in your inbox within a few minutes, look in spam." **Schedule:** it shows today's limit and when the emails can go out.
3. Click **Launch campaign**.

**What you should see:** the campaign page, with "Sent by Arslan as Arslan from Polygon Paradise <contact@polygonparadise.com>, replies to arslan@mail.polygonparadise.com". The emails go out one at a time, a few minutes apart, inside sending hours. The results count them under **Sent**, then under **Delivered** once Mailgun reports back. If nothing goes out, the page says what it's waiting for (for example "Waiting for sending hours"). While follow-ups are still to come, the page also says "Replies written straight to contact@polygonparadise.com don't reach the app. If someone answered there, set their company to Replied so the follow-ups stop."

**Then:**

1. **Reply from each test mailbox** by pressing Reply: the answer goes to your reply address. Each reply must arrive normally in your reply inbox (not in spam). The app also lists each reply on **Notifications** under **Replies waiting for an answer**, and the bell shows it. On the campaign page, each test mailbox that replied says **Stopped: they replied**, so it gets no follow-ups. The app can't see your inbox, so once you've read a reply, click **Answered** (or **No answer needed**) on it to take it off the list.
2. Emails from campaigns launched before you go live never count as "emailed", so you can repeat this test at any time until then. Each time, the new replies are listed on **Replies waiting for an answer** again.
3. **Try the test tools:** open **Campaigns › Dry-run outbox**, open an email and use the **Simulate** buttons: **Bounce**, **Unsubscribe**, **Reply**, **Out-of-office** and **Unclear reply**. "In a dry run this only changes this campaign." If the outbox is empty, set **Sending mode** to **Dry run**, launch a small campaign to the Test mailboxes list, and set the mode back to **Live (test list only)** afterwards.
4. **Optional, a real bounce:** add a made-up address at a real provider (for example a long random name @gmail.com) to the test list and to the Test mailboxes list, email it, and watch it show as **Bounced** within a few minutes. Remove it from both lists afterwards. One bounce doesn't pause anything.

This campaign also counts as the go-live "live test" once Mailgun reports it as delivered, as long as the sending domain, the From address and the test list stay the same.

**Next:** the [Going-live guide, step 3](4-going-live.md#3-rehearse-with-your-test-mailboxes) rehearses follow-ups and replies with the same test mailboxes.

## 15. Check the reply routes in Mailgun

"Apply recommended settings" made the routes that forward replies. To look at them:

1. In Mailgun, open **Receiving › Routes** (it may be **Send › Receiving › Routes**).
2. You should see routes whose description starts with `outreach-app:`: one per sender (`outreach-app:sender:…`), a catch-all for mail.polygonparadise.com (`outreach-app:catchall:…`) and one for dmarc@ (`outreach-app:dmarc:…`). **Don't edit or delete them**: the app keeps them up to date. No route ever names polygonparadise.com itself: mail to contact@ goes to Zoho, never through Mailgun.

**Only if the app can't create them** (the row "Replies reach each sender" stays red and Apply doesn't fix it), make them by hand. The row shows each sender's exact values with Copy buttons; copy from there.

1. Click **Create route** (the button name may differ).
2. For each sender:
   - **Expression type:** Custom (it may be called **Custom** or **Match recipient**).
   - **Expression:** `match_recipient("^arslan@mail\.polygonparadise\.com$")` (copied from the app).
   - **Actions:** **Forward** to the sender's reply inbox; **Store and notify** with the **Address for stored replies** from **Settings › Sending & Mailgun › For Mailgun** (it ends in `/api/webhooks/mailgun/inbound`); **Stop**.
   - **Priority:** 10.
   - **Description:** `outreach-app:sender:<number shown in the app>`.
3. One catch-all: expression `match_recipient("^.*@mail\.polygonparadise\.com$")`, the same three actions but forwarding to **your** inbox, priority **100**, description `outreach-app:catchall:mail.polygonparadise.com`.
4. One for DMARC reports: expression `match_recipient("^dmarc@mail\.polygonparadise\.com$")`, actions **Forward** to you and **Stop** (no store), priority **50**, description `outreach-app:dmarc:mail.polygonparadise.com`.
5. Click **Check again** in the app.

## 16. Optional: Gmail's dashboard, and your domain's age

- **Google Postmaster Tools** shows how Gmail rates polygonparadise.com, and it is the only place where Gmail's spam complaints about your emails show up, so it's recommended now. Open [postmaster.google.com](https://postmaster.google.com), click **Add new domain** and type polygonparadise.com. **Add a new TXT record** (Name `@`) with the value Postmaster shows. Don't edit the TXT record that starts with v=spf1. Postmaster shows data only once you send enough email, so don't worry if it stays empty at first. The app's row **Gmail dashboard** then says "A Google verification record is on polygonparadise.com. Check at postmaster.google.com that polygonparadise.com is listed there." It stays grey, and it may say this before you start, because polygonparadise.com already has a Google verification record for another Google service and the app can't tell which one. So add polygonparadise.com in Postmaster Tools anyway, and check there that it's listed.
- **Domain age.** Inbox providers distrust brand-new domains; polygonparadise.com isn't new. On the checklist's **Domain age** row, enter the day you bought it ("When did you buy polygonparadise.com?"; GoDaddy lists the date with the domain); it then says how old it is. The warm-up (Settings › Limits & warm-up) does the rest: from the day you go live, the daily limit starts at 50 and rises slowly ([Going-live guide, step 9](4-going-live.md#9-warm-up)).
- **The signature key.** The DKIM row may say "(1024-bit; it works, 2048-bit is stronger)". Nothing to do: every inbox provider accepts it. A longer key for polygonparadise.com can be made later in Mailgun; ask the person who set up the app first, because it changes the `mx._domainkey` record.

## 17. What happens when the PC is off

Bounces, unsubscribes and complaints are never missed, replies always reach the sender's inbox, and emails simply wait while the PC is off; after more than 5 days off, follow-ups are put on hold until each sender has checked their inbox. The details are in the README: [When the PC is off, and keeping it awake](../../README.md#when-the-pc-is-off-and-keeping-it-awake). You can ask for a check with Mailgun at any time: **Settings › Sending & Mailgun › Check with Mailgun now**.

## 18. Troubleshooting

**"Paused: …" in the top bar.** Sending has stopped for everyone, including dry runs. Open **Settings › Sending & Mailgun**: the red card says why and what to do. Fix it, then click **Resume sending**. If the cause is still there, sending simply pauses again with the same message. Common ones:

- "… of the last 200 emails bounced" or "… were marked as spam": the app's safety limits. **Settings › Deliverability** lists each bounce and complaint with its campaign and lists. Remove or re-check the list they came from before you resume. Resuming starts a fresh count.
- "Mailgun didn't accept the API key": make a new Developer key (step 5), paste it in **Settings › Sending & Mailgun**, click **Save and connect**, then **Resume sending**. If it started right after you set the From address and a domain sending key is saved, the card adds: "If this started after the From address was set, remove the domain sending key (Settings › Sending & Mailgun › Advanced › Remove the sending key) and click Resume: the API key sends then." Then Mailgun refuses the sending key, not the API key, so a new API key doesn't help: open **Settings › Sending & Mailgun**, open **Advanced**, click **Remove the sending key** ("The domain sending key is removed. Emails now go out with the API key. If sending is paused, click Resume sending."), then click **Resume sending**. The API key and everything else stay as they are.
- "an email's From or reply address doesn't fit the sending domain": "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then click Resume." The **From address** card says what doesn't fit; it must be contact@polygonparadise.com with mail.polygonparadise.com as the sending domain.
- "Mailgun business verification": "Mailgun is holding your account until business verification is finished. Complete the form in the banner at the top of Mailgun, then click Resume."
- "Mailgun won't send from mail.polygonparadise.com right now. Check the banner in Mailgun, then click Resume." Mailgun's own text is under **Details**.
- "Mailgun stopped accepting emails": "Mailgun has stopped accepting emails from mail.polygonparadise.com: … Check Mailgun's dashboard, then click Resume."
- "tracking is on in Mailgun" or "unsubscribe links are off": someone changed the settings in Mailgun. Click **Apply recommended settings** (Settings › Domain checklist), then **Resume sending**.
- "Mailgun refused 3 emails in a row": "Check the banner in Mailgun, then click Resume."
- "restored from a backup": read the restore report on the same page, then click **Resume sending**.

**Other messages you may see:**

- "Mailgun asked us to slow down; trying again at 14:05." Nothing to do: the app waits and carries on.
- "Mailgun didn't answer in time." The app checks with Mailgun whether the email went out, and never sends it twice by itself. After up to 2 hours it may ask you to choose **Retry** or **Skip**.
- "Stopped by the test-list guard: … isn't on your test list." Before you go live, in Test mode, and in live campaigns launched before you went live, real email only reaches your test list. Add the address to the test list if it's one of your own mailboxes.
- "Mailgun can't find mail.polygonparadise.com in the US region, only in EU. …": don't change Region to EU. Add mail.polygonparadise.com in the US region (step 4).
- "Mailgun's messages to the app are being rejected": the webhook signing key doesn't match. Click **Apply recommended settings** to fetch it again.
- "The app can't check with Mailgun": check the PC's internet connection, then click **Check with Mailgun now** in Settings › Sending & Mailgun.

**polygonparadise.com, your main domain:**

- **"Mail for polygonparadise.com stays with your mail provider (MX)" is red**, live emails say "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost. The Owner can see how to fix it in Settings › Domain checklist.", and the Owner gets the notification "Mail for polygonparadise.com goes to the wrong place". polygonparadise.com's MX records point to Mailgun (easily done when GoDaddy's form fills Name with `@`) or are gone. In GoDaddy's DNS records, delete the MX records named `@` whose value ends in `mailgun.org`, and put Zoho's back if they're missing (the row names what to keep; Zoho's help pages list its records). Then click **Check again**. Live emails go again once the row is **Done**.
- **Mailgun shows polygonparadise.com's MX records as unverified.** That's expected and stays so: never add them.
- **"polygonparadise.com's SPF record (your everyday email)" is red.** The row says what's broken (two SPF records, an included name without a record, or too many lookups), and the Owner gets a notification. If polygonparadise.com's DNS moved to Cloudflare recently, put the missing record back as the [Cloudflare guide, step 1](3-cloudflare.md#1-put-the-apps-domain-on-cloudflare) says (option (b), step 8). Otherwise ask the person who set up the app. Never remove `include:mailgun.org` from it: Mailgun needs it to keep polygonparadise.com verified, and polygonparadise.com signs your emails.
- **The DKIM row says "Mailgun didn't list a DKIM record for mail.polygonparadise.com. …"** Run the reply test and paste one test email's original (step 13), then click **Check again**: the row reads the signature from it.

**Mail that lands in contact@polygonparadise.com:**

- **A prospect's reply went to contact@ instead of the app** (they wrote a new email, or their email program ignored the reply address). The app doesn't see it, so the follow-ups continue: set that company's status to **Replied**.
- **Someone asked at contact@ to be removed, or contact@ got a "couldn't be delivered" notice about a campaign email.** Set the company to **Do not contact**, or put just that address on the do-not-email list (Settings › Deliverability › Add an address). Forwarding the email from contact@ to a reply address doesn't help: the app treats mail from contact@ as your team's own.

**Changing the From address.** It can't change while a test or live campaign is scheduled, running or paused ("Finish or cancel “Germany Q4” first: it sends with the current From address."), and campaigns don't finish while sending is paused. After going live a change ends going live. Do it in the order of the README's "Sending safely" ("Your main address's reputation"): **Pause all sending**, cancel those campaigns, empty the From address, click **Resume sending**, then run the reply test (step 13), send a live campaign to your test list and go live again ([Going-live guide, step 13](4-going-live.md#13-changing-the-sending-domain-or-the-from-address-later)).

**A DNS row stays red or amber:**

- **"email.mail.polygonparadise.com is proxied (orange cloud)"** (only if polygonparadise.com's DNS is at Cloudflare): in Cloudflare, click the record and switch **Proxy status** to **DNS only** (grey cloud).
- **Doubled names** (the record exists as `mail.polygonparadise.com.polygonparadise.com`): edit the record and type only `mail` (or `email.mail`) in the Name box.
- **"You have 2 SPF records; mail servers ignore all of them."** (the row for mail.polygonparadise.com): there are two TXT records named `mail` that start with `v=spf1`. Keep one, `v=spf1 include:mailgun.org ~all` (merge in anything else the other one had), and delete the other. Never touch the SPF record named `@`.
- **"These are Mailgun's mail servers for the other region (…); your domain is in the US region."** Change the MX records named `mail` to `mxa.mailgun.org` and `mxb.mailgun.org`.
- **"Other mail servers are also listed"** or the MX records named `mail` keep changing back: email forwarding (GoDaddy's, or Cloudflare Email Routing) is switched on for `mail`. Switch it off, delete its MX records named `mail`, and add Mailgun's again.
- **Amber "Still spreading":** wait 30 minutes and click **Check again**.

**Unsubscribe links:**

- "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do." Check your plan in Mailgun (it must be Foundation or higher), then click **Apply recommended settings** again.
- "Mailgun kept its own unsubscribe footer": step 11, "If Apply can't do something".

**Replies:**

- **"Mailgun won't forward replies to … : it's on Mailgun's … list."** The reply inbox once bounced or unsubscribed, so Mailgun blocks it. On the "Replies reach each sender" row, click **Remove it**. That opens Settings › Deliverability, where you click **Remove** next to the address.
- "Replies to … would loop: its reply inbox is on the sending domain. Change the reply inbox in Settings › My profile."
- "Another Mailgun route catches … first. In Mailgun, open Receiving › Routes and delete routes you don't recognise for this domain."
- A test reply doesn't arrive: check it wasn't sent from the reply inbox itself (Gmail hides those), and check your spam folder.

## 19. Address checks and the Anthropic key

The app can ask Mailgun whether an address really exists before a campaign emails it (an "address check"), and Claude can draft one personal line per company from its website for you to approve. This step sets both up. It takes about 15 minutes and costs about a cent. The [Going-live guide, step 3](4-going-live.md#3-rehearse-with-your-test-mailboxes) then tries both with real data.

**What checks cost, and your plan.** Mailgun's Foundation plan includes no free address checks, so every check costs about **$0.012** (about $4.80 for 400 addresses). The Scale plan ($90 a month) includes 5,000 checks a month; **above about 4,580 checks a month Scale is cheaper** than Foundation plus checks. Mailgun bills extra checks automatically and never stops them, so the app has its own monthly check limit ($100 by default, in Settings › Deliverability › **Address checks**). If you move to Scale, set **Checks included in your plan each month** on the same card to 5,000 so the cost lines say "free" for those.

1. **See whether address checks are switched on for your Mailgun account.** In Mailgun, look for **Validations** in the left menu (it may be called **Email Validation** or sit under **Optimize**). If it isn't there, checks aren't enabled on your plan yet: the app's checks will pause with "Mailgun refused address checks for a billing or plan reason" or "Mailgun won't run address checks on this account right now". Ask Mailgun's support to enable email validations for your account, or look at the Scale plan. The API key from step 5 (role **Developer**) is allowed to run checks; the app uses it unless you save a separate one under Settings › Deliverability › **Address check key**.
2. **Test one check.** In the app, open **Settings › Deliverability**, scroll to **Test address checks**, type your own Gmail address and click the button. It costs about $0.01. The answer says how long Mailgun took, for example "Checked in 1.4 s: can be emailed." The result isn't saved on anybody and never puts the address on the do-not-email list.
3. **Optional: does Mailgun bill a repeated check?** Test the same address again the next day, then look at Mailgun's usage page (it may be under **Account › Usage** or **Billing**) for how many validations it counted. If a repeat counts twice, the app's one re-check of "no answer" a day later also costs a second check (it's only one per campaign, and the Verify step's cost line already says "Up to $… more if some need a second check tomorrow").
4. **Create the Anthropic API key** (only if you want AI personal lines). Sign in at [console.anthropic.com](https://console.anthropic.com) (it may send you on to platform.claude.com) and create an account for your studio if you don't have one. Add some credit under **Billing** (it may be called **Plans & Billing**); $5 drafts about 900 lines with Claude Haiku 4.5. Open **API keys**, click **Create key**, name it "Polygon Paradise Outreach" and copy the key (it starts with `sk-ant-`; it's shown only once).
5. **Set a spending limit in the Console too** (it may be under **Limits** or **Spend limits** in the Console's settings), for example $25 a month. The app has its own AI limit ($20 a month by default, counted in Pakistan time); the Console's limit is a second safety net. When the Console's limit is reached, drafting pauses and says so.
6. **Paste the key in the app:** **Settings › AI**, **Anthropic API key**, paste, **Save key**. The app checks it with Anthropic first (free) and says "Key saved. It works with Claude Haiku 4.5." Leave the model on **Claude Haiku 4.5** unless you want **Claude Sonnet 5**'s higher quality (about 3.5 times the cost). Like the Mailgun key, it lives only in the app, never in `.env`.

**What you should see:** the test check's answer on Settings › Deliverability, and "Key saved. It works with Claude Haiku 4.5." on Settings › AI.

**If something differs:**

- "Address checks paused: …" on the Verify step or Settings › Deliverability: the sentence says what to do (a key Mailgun didn't accept, checks not enabled on the plan, business verification). Fix it, then click **Resume checks** on Settings › Deliverability.
- "Address checks stopped: this month's check limit of $100 is reached.": raise the limit in Settings › Deliverability, or wait until the 1st.
- "AI drafting paused: …" on AI lines or Settings › AI: the sentence says why (the key wasn't accepted, the model isn't available, a spending limit). Fix it in Settings › AI (saving a new key or model resumes drafting), or click **Resume drafting**.
