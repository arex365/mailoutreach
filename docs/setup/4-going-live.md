# Going-live guide

This guide takes you from "everything is set up" to your first real campaign. Until you switch on **Go live**, real email only ever reaches the addresses on your test list. After it, new live campaigns email every eligible prospect.

Do the guides in order first: the [Install guide](1-install.md), the [Mailgun and DNS guide](2-mailgun-and-dns.md) and the [Cloudflare guide](3-cloudflare.md). In the own-mailbox setup (sending through polygonparadise.com itself, replies in contact@), the [Own-mailbox guide](2-own-mailbox.md) replaces the Mailgun and DNS guide and the Cloudflare guide is optional; the steps below say where your setup differs. This one takes a few evenings: the rehearsal in step 3 waits a day for a follow-up, and the practice restore in step 5 pauses sending for about 35 minutes.

The app refers to some steps of this guide by number ("Going-live guide, step 3"), so the numbers stay the same.

This guide uses your real names: **polygonparadise.com** is your main domain (your website and your everyday email), **mail.polygonparadise.com** the sending subdomain Mailgun handles, and **contact@polygonparadise.com** the From address every email shows. The app shows your real values everywhere.

---

## 1. Before you start

Check these a few days ahead:

- **polygonparadise.com is at least 30 days old.** Inbox providers distrust brand-new domains. On **Settings › Domain checklist**, the **Domain age** row says how old polygonparadise.com is once you've entered the day you bought it.
- **Mailgun has approved your business verification** (the banner at the top of Mailgun is gone), you're on the **Foundation** plan, and **Mailgun's monthly safety limit** is set ([Mailgun guide, step 9](2-mailgun-and-dns.md#9-set-mailguns-monthly-safety-limit)).
- **In the own-mailbox setup** ([Own-mailbox guide](2-own-mailbox.md)): **How the app sends** = **From polygonparadise.com itself (replies come to your own inbox)**, **Your Mailgun plan** = **Free (100 emails a day)**, both in **Settings › Sending & Mailgun**. Mailgun's Free plan replaces Foundation and needs no monthly safety limit, and nobody has a reply address or a reply route. Where this guide differs for your setup, it says so.
- **Settings › Sending & Mailgun › From address** shows contact@polygonparadise.com. Every email then shows From contact@polygonparadise.com with the sender's own name ([Mailgun guide, step 6](2-mailgun-and-dns.md#6-connect-mailgun-and-set-the-from-address)).
- **Address checks are switched on in Mailgun** (Validations), and one **Test address checks** worked ([Mailgun guide, step 19](2-mailgun-and-dns.md#19-address-checks-and-the-anthropic-key)).
- **The Anthropic key is saved** in **Settings › AI**, if you want AI personal lines. This is optional.
- **Everyone who sends has a profile**: in **Settings › My profile**, a **Reply address**, a **Reply inbox**, a signature and their time zone, and "Reply route: working" under the reply address.
- **Your own decisions are in the app**, each in its place:
  - the sending domain (mail.polygonparadise.com) and the From address (contact@polygonparadise.com): **Settings › Sending & Mailgun** (Mailgun connection and From address);
  - the Mailgun plan and region: in Mailgun itself (Foundation, US);
  - your test mailboxes: **Settings › Sending & Mailgun › Test list**;
  - the app's address, and whether you use Cloudflare Access: the [Cloudflare guide](3-cloudflare.md);
  - the hours the PC must be on: the [Install guide](1-install.md), steps 6 and 7.
- **The Mailgun key lives in the app, never in `.env`.** Open `.env` in the app folder with Notepad (right-click › **Open with** › **Notepad**). If it has lines starting with `MAILGUN_`, delete those lines, change nothing else, and save. The app never reads them, and a copy of `.env` on a USB stick shouldn't carry a key. Then copy the new `.env` to your USB stick or password manager again.
- **Go through the earlier change lists once more** with the person who set up the app for you (see "Getting help" in the [README](../../README.md#getting-help)): the answers the app assumed for your open questions while it was built, and what changed with the sending, follow-up and address-check updates and with the From address contact@polygonparadise.com. Say what you want different before real prospects get email.

## 2. The Domain checklist is all green

Open **Settings › Domain checklist**. Going live needs these rows to be green (**Done**). The screen shows your own domain where this list says "your domain":

1. Mailgun knows your domain
2. Mailgun may send for your domain (SPF)
3. Your emails are signed (DKIM)
4. Replies reach the app (MX)
5. Unsubscribe links work (tracking CNAME)
6. Unsubscribe links are secure (HTTPS)
7. Mail servers know your policy (DMARC)
8. Open and click tracking are off
9. Unsubscribe handling is on
10. Spam filter marks, never deletes
11. Stored replies are kept
12. Webhook signing key saved
13. Mailgun tells the app what happened
14. Replies reach each sender
15. Mailgun lets you send
16. Remote access works

With a From address (contact@polygonparadise.com), going live also needs **Mail for polygonparadise.com stays with your mail provider (MX)**: polygonparadise.com's mail stays with Zoho, never Mailgun. The row "polygonparadise.com's SPF record (your everyday email)" never blocks anything. "Your emails are signed (DKIM)" turns green once the reply test's pasted original has shown the signature and you click **Check again**, if Mailgun lists no DKIM record for mail.polygonparadise.com.

In the own-mailbox setup the list is shorter: "Mailgun knows your domain", "Mailgun may send for polygonparadise.com (SPF)", "Your emails are signed (DKIM)", "Unsubscribe links work (tracking CNAME)", "Mail servers know your policy (DMARC)", "Mail for polygonparadise.com stays with your mail provider (MX)", "Open and click tracking are off", "Unsubscribe handling is on", "Webhook signing key saved" and "Mailgun lets you send". With remote access set up (the Cloudflare guide), going live also needs "Mailgun tells the app what happened" and "Remote access works". The grey rows about secure unsubscribe links and the monthly safety limit never block anything there: the Go live dialog asks you to tick a box about the http links instead (step 8).

A row that isn't red but still needs a look (for example DNS "Still spreading") counts as not done yet as well: the Go live card names it with what to do, for example "…: needs attention: Still spreading. Check again in 30 minutes (Domain checklist)."

Going live also needs:

- **A fresh check.** Click **Check again** on the Domain checklist within the hour before you go live. An older check isn't enough, because DNS and Mailgun settings can change. The check must also be newer than your last change of the From address or the sending domain; otherwise the card says "The Domain checklist was checked before the From address or the sending domain changed. Click Check again on the Domain checklist, then come back."
- **The reply test passed with Setup A** (the normal setup, with Mailgun's unsubscribe handling on) and with the current From address, including the pasted original ([Mailgun guide, step 13](2-mailgun-and-dns.md#13-the-test-list-and-the-reply-test)). **Setup B (check only)** is only a check and never counts.
- **Sending isn't paused.**
- **Every sender has a working reply route** (the "Replies reach each sender" row).
- **One live campaign to your test list was delivered** (step 3), sent with the current From address.
- **The background sender is running** (step 4).
- **In the own-mailbox setup:** the reply test passed by hand, with the current From address ([Own-mailbox guide, step 9](2-own-mailbox.md#9-the-test-list-and-the-reply-test-by-hand)), instead of Setup A's test; there are no reply routes to check. The live test is in the [Own-mailbox guide, step 10](2-own-mailbox.md#10-test-companies-and-a-live-test).

**What you should see:** on **Settings › Sending & Mailgun**, the **Go live** card has no "Before going live:" list any more, and its switch can be clicked. If something is still missing, "Before going live:" lists exactly what, one line each.

## 3. Rehearse with your test mailboxes

This is the dress rehearsal: everything a real campaign does, but only with your own test mailboxes. It takes two days (a follow-up after one day) and about an hour of clicking. It costs well under a dollar in address checks and Claude.

**Before you start:** open **Notifications** and look under **Replies waiting for an answer**. Click **No answer needed** on older test replies (on one marked **Real reply?**, click **Real reply** first), so only this rehearsal's replies will be listed.

**Tip:** you can practise the same steps in the practice copy first (`start-demo.bat`). There, on the **Schedule** step under **Dry-run helpers**, switch on both **Ignore sending hours** and **Treat follow-up days as minutes (for testing)** to watch a whole sequence in minutes, then use **Simulate › Reply**, **Out-of-office** and **Unclear reply** in the dry-run outbox. Cancel old practice campaigns first (open each one and click **Cancel campaign**), or their follow-ups use up the practice copy's daily limit.

**A live campaign to your test list, with one follow-up**

1. In **Settings › Sending & Mailgun**, check that **Sending mode** is **Live (test list only)**.
2. **Switch on an automatic reply in the Outlook.com test mailbox.** Sign in at [outlook.com](https://outlook.com), open **Settings** (the gear), then **Mail**, then **Automatic replies** (it may be called "Out of office"), switch it on, type a short message such as "I'm out of the office until Monday." and click **Save**. Gmail's own vacation responder may skip emails like these, so use Outlook.com for this.
3. In **Contacts**, open the **Test mailboxes** list (the [Mailgun guide, step 14](2-mailgun-and-dns.md#14-your-first-live-campaign-to-the-test-mailboxes) made it), tick all its companies and click **Email these companies**.
4. Go through the steps. On **Message**, keep the first email and one follow-up, and set the follow-up to **Send 1 day after the previous step if there's no reply**; switch the other follow-ups off. **Verify**: test-list addresses count as checked. On **Schedule**, check the sentence "Its follow-up goes out in the same email thread after its wait, unless someone at the company replies.", then click **Launch campaign**.
5. **Wait until the email is confirmed as delivered.** Open **Settings › Sending & Mailgun** a few minutes after the first emails went out. While the **Go live** card says "The live test email hasn't been confirmed as delivered yet. Wait a few minutes, then open this page again.", Mailgun hasn't reported the delivery yet. Once that line is gone, the live test is done. (A live campaign from the Mailgun guide's step 14 on the same sending domain and with the same From address, to an address still on your test list, counts too.)

**Replies**

6. **When the first emails arrive, reply from the Gmail mailbox** ("Thanks, send me your prices" is enough) by pressing Reply: the answer goes to your reply address, through the app, to your reply inbox. The Outlook.com mailbox answers by itself with its out-of-office message.
7. **In the app, a minute later:**
   - **Notifications** and the dashboard list the Gmail reply under **Replies waiting for an answer**, and the bell rings for it.
   - On the campaign page, the Gmail company's person says **Stopped: they replied**.
   - The Outlook.com company's person still says **Waiting for follow-up 1 on …**: the out-of-office didn't stop anything. Its timeline shows "Automatic reply from … (out of office)".
   - The out-of-office may go to contact@polygonparadise.com instead of your reply address. Note where it arrived: in the app (the timeline says "Automatic reply …"), in contact@, or nowhere. Tell the person who set up the app; either is fine, and the follow-up goes out either way.
   - Replies to campaigns launched before you go live don't change the test companies' status, so you can repeat this rehearsal.
8. **The next day** (inside sending hours), the follow-up reaches the Outlook.com mailbox and your other test mailboxes, never the Gmail one. It arrives with the subject "Re: …" of the first email.
9. **Check the thread.** In Gmail and in Outlook.com, the follow-up should sit in the same conversation as the first email. To be sure, open the follow-up's original (Gmail: **⋮** › **Show original**; Outlook.com: **⋯** › **View** › **View message source**) and look for the line `In-Reply-To:`. It must show the same id as the first email's `Message-ID:` line.
10. **Tidy up.** On **Notifications**, click **Answered** on the Gmail reply (you answer real replies in your own email program; this only takes it off the list). In Outlook.com, switch the automatic reply off again.

**In the own-mailbox setup** replies never reach the app, so steps 6, 7, 8 and 10 go like this instead ([Own-mailbox guide, step 12](2-own-mailbox.md#12-every-working-day)):

- Reply from the Gmail mailbox and see the reply arrive in contact@polygonparadise.com (look in its Spam folder too). Nothing appears under **Replies waiting for an answer**.
- On the campaign page, click the Gmail company's person (it opens **Person in this campaign**), click **They replied**, then **Mark as replied**. Check that its follow-up now shows **Stopped: they replied**. The company's status stays as it is before going live.
- The next day, the Outlook.com mailbox's follow-up waits for today's inbox check ("Waiting for today's inbox check (Notifications › Inbox check).") until you open **Notifications** and click **I've read contact@polygonparadise.com**. Then it goes out.
- The out-of-office goes to Zoho, not the app: note whether it arrived in contact@ or nowhere, and tell the person who set up the app. There is no reply to mark as answered.

**If something differs:**

- The Outlook.com follow-up says **Stopped: they replied**: the app took the automatic reply for a real one. Write down the automatic-reply text you used and see "Getting help" in the README.
- A message is listed as **Real reply?**: the app wasn't sure whether a person wrote it. Choose **Real reply** or **It was an auto-reply**; until then that company's follow-ups wait.
- The follow-up starts a new conversation in Gmail or Outlook.com: keep the follow-up's original (step 9) and see "Getting help" in the README.
- Follow-ups wait with "Waiting for the check with Mailgun": after the PC starts, follow-ups always wait until the app has checked with Mailgun. Click **Check with Mailgun now** in **Settings › Sending & Mailgun** if it takes long.

**One address check, 20 AI lines and the Claude round trip**

11. **Check a list's addresses.** In **Contacts**, hover over a list in the left column, click its **⋯** menu and choose **Check emails**. The dialog says how many addresses need a check and what it costs ("Cost: about $0.48 (40 checks × $0.012)."). Click **Check N addresses**; you can close the window, the checks go on. When they're done you get the notification "Address checks finished" with what was found. Open a company: next to each person is the result and the day it was checked. Addresses that don't exist are now on the do-not-email list (**Settings › Deliverability**, reason "Invalid", source "Address check").
12. **Draft lines for 20 companies and review them.** In **Contacts**, tick 20 companies that have a website and click **Draft personal lines**. The dialog shows how many will be read, which are skipped and the cost (about $0.11 with Claude Haiku 4.5). Click **Draft 20 lines**. A few minutes later you get "AI lines ready to review". Open **AI lines**: read each line and the highlighted words from the website it's based on (**Open the page** shows them in place), then **Approve**, **Edit then approve** or **Reject**. This also tests the AI model. If drafting stops with "model not found", pick **Claude Sonnet 5** under **Model** in **Settings › AI** and click **Save model**.
13. **The Claude round trip for missing emails.** In **Contacts**, open **Missing email**, then **Export** › **Export for Claude**. Download the file (step 1 in the dialog) and copy the instruction (step 2). In Claude, attach the file, paste the instruction and send it; save the CSV Claude gives back. Open **Import**, upload that CSV: the Match columns step says "This file has a company_id column, so it adds people to companies that already exist." Continue to **Check**, then click **Add N people**. The Missing email count goes down.

**What you should see:** the Go live card no longer lists the live test; one test reply waited for an answer until you clicked **Answered**; the follow-up went only to the mailboxes that didn't reply, in the same conversation; the checked people have results; approved AI lines show in the company panel as "AI, approved by …"; the round trip added people to existing companies and created none.

**If the checks or AI lines differ:**

- "Address checks paused: …" or "AI drafting paused: …": the sentence says what to do; see the [Mailgun guide, step 19](2-mailgun-and-dns.md#19-address-checks-and-the-anthropic-key).
- Many addresses "got no answer": Mailgun couldn't reach those mail servers. In a campaign they're checked once more a day later automatically; in Contacts, check them again later yourself.
- Many "No line" cards: those websites are parked, "coming soon", need JavaScript, block robots or are only Instagram. That's expected; write those lines yourself (**Write one yourself**), or leave them empty.
- The round-trip import says "… isn't a company ID like C-1042": the file's company_id was changed. Use the file Claude made from the export, and keep its company_id column as it is.

## 4. The PC

**Move the app out of Pictures, Documents, Desktop or OneDrive.** OneDrive, another sync program or Windows' ransomware protection can take over files in those folders, including the database. The Go live card and `status.bat` warn when the app folder is inside one of them ("The app folder is inside Pictures, …"). Put it in `C:\Outreach` instead:

1. Double-click `stop.bat` and wait until it says the app is stopped.
2. Double-click `uninstall-services.bat` (click **Yes** when Windows asks for permission).
3. Move the whole app folder to `C:\` and name it `Outreach` (in File Explorer: select the folder, **Cut**, open `C:\`, **Paste**, then rename it). Close any window that still shows the old folder.
4. In `C:\Outreach`, double-click `install-services.bat`.
5. Open the app. The top bar says "Paused: this database was copied or moved", because the database now opens from a new place. You moved it on purpose, so open **Settings › Sending & Mailgun** and click **Resume sending** once.

If `install-services.bat` stops with a message about the build, do what it says (usually double-click `update.bat`, which rebuilds the app in its new place), then run `install-services.bat` again.

**Check the rest:**

- The background services are installed (`install-services.bat`, [Install guide, step 5](1-install.md#5-make-the-app-start-with-windows)).
- `setup-pc.bat` has run: the office network is Private, the PC never sleeps while plugged in ([Install guide, step 6](1-install.md#6-prepare-the-pc-setup-pcbat)).
- Windows Update's active hours are set ([Install guide, step 7](1-install.md#7-windows-update-active-hours)).
- The PC stays plugged in. On battery it still goes to sleep, and nothing is sent while it sleeps.

**The restart test** (what the app does after a Windows Update restart):

1. Restart the PC and don't log in.
2. Wait two minutes: the services start about 1 to 2 minutes after Windows.
3. Log in and double-click `status.bat`. No line should start with `[x]` (red) or `[!]` (yellow): the app and the background sender are running, remote access is running, "The app answers", and the background sender checked in a few seconds ago.
4. Open the app. The dashboard's **Needs your attention** list has no line about the background sender.

## 5. Backups and a practice restore

**A second copy of your backups**, on a USB stick, a second disk or a OneDrive folder, so a copy survives if this PC's disk fails:

1. Open **Settings › Backups**, type the folder under **Second folder** (for example `D:\Backups`, or a new folder in OneDrive such as `C:\Users\<you>\OneDrive\Outreach backups`) and click **Save folder**. Network folders and mapped network drives don't work: the background services can't write there. The app also refuses a Windows or program folder, and your whole user folder or its Documents, Desktop, Pictures, Downloads or OneDrive folder itself (also the Documents, Desktop or Pictures folder inside OneDrive): make a new folder inside it.
2. **Then** double-click `install-services.bat` on the office PC. It gives the background sender permission to write to that folder.
3. Back on **Settings › Backups**, click **Back up now** and wait until the new backup is listed. Check that this new backup says **Copied** under **Second copy** (on a laptop: a phone hides that column). The copy the app tried when you saved may say **Not copied**: it ran before `install-services.bat` gave the permission.

**A copy of `.env`**, on a USB stick or in a password manager. It holds the key that unlocks your saved Mailgun and Claude keys. Keep it apart from the second backup folder, and never send it to anyone.

**A practice restore on your real data.** This is the only way to be sure a backup really brings your data back. Do it right after **Back up now**, when nobody is working. Anything changed in between is lost, and sending pauses for about 35 minutes.

1. Open **Settings › Backups** and click **Back up now**. Wait until the new backup is listed.
2. On the office PC, double-click `restore.bat`. If Windows asks for permission, click **Yes**.
3. It lists the backups, newest first, with their date and kind. The newest one says **Back up now**. Type its number and press Enter.
4. Check the date and kind it shows, type `yes` and press Enter.
5. Wait. It stops the app, saves your current data as "Before a restore", puts the backup in place, checks it and starts the app again. At the end it says "Restored your data from …" and that sending stays paused.
6. Open the app. The top bar says "Paused: restored from a backup". Open **Settings › Sending & Mailgun**: the red card shows the restore report. The app first asks Mailgun which emails went out after the backup and records them as sent, so nobody gets the same email twice. That check runs twice: right after the start, and again about 35 minutes after the restore.
7. Read the report, then click **Resume sending**. Emails through Mailgun still wait for the second check; dry runs carry on at once.
8. Open **Settings › Backups**. The **Last restore** card shows what you'll see after any restore: "Restored on … from the backup of …". While the second check still runs, it also says "Checking Mailgun for emails sent after the backup. This finishes about 35 minutes after the restore." and "Sending was resumed while the check is still running; emails through Mailgun wait until it finishes." About 35 minutes after the restore, open the page again: now it shows the report ("Checked Mailgun for sends after the backup …") and "Sending was resumed by <your name> on …".

**In the own-mailbox setup** a restore also undoes every **They replied** click made after the backup (the app never sees replies, so nothing brings them back), and it forgets the day's inbox check. The **Last restore** card says so (and the red card on Settings › Sending & Mailgun, with the backup's time): "They replied clicks made after the backup were undone by the restore. Read contact@polygonparadise.com again from that time on: click They replied on every company that answered and Mark unsubscribed for removal requests, then click I've read contact@polygonparadise.com. Live follow-ups wait until then." After this practice restore, right after **Back up now**, nothing was undone: just click **I've read contact@polygonparadise.com** on **Notifications** once you've read contact@ today.

If anything goes wrong, run `restore.bat` again and pick the backup marked **Before a restore**: that is your data from just before.

## 6. Settings to check once

From now on your templates go to real prospects. Look through these once:

- **Settings › Email footer**: the company name, the address and the unsubscribe line, and the **Portfolio link** (used by `{{portfolio_url}}`).
- **Templates**: your master template and its follow-ups, word by word.
- **Settings › Limits & warm-up**: the sending days and hours, the maximum daily limit (1,000), the **Per-sender limits**, and **The 30-day rule** (how long a company stays with whoever emailed it).
- **Settings › Deliverability**: the health **Thresholds** (when sending pauses by itself), and the **Address checks** rules and monthly limit.
- **Settings › AI**: the monthly limit and the model. Anthropic may retire Claude Haiku 4.5 from late November 2026: if drafting stops with "model not found", pick **Claude Sonnet 5** and click **Save model**.

## 7. Your test mailboxes after going live

- Nothing changes in the data when you go live. What you sent your test mailboxes before stays "test emails": it never counts as emailed, and their companies stay **Not contacted**. In Contacts, **Last emailed** says "Never", with the tooltip "Test emails before going live don't count as emailed."
- The test list stays. **Test mode**, the reply test, and the rule that replies from your test mailboxes never put anyone's follow-ups on hold still use it.
- After going live the test mailboxes are ordinary companies: a live campaign that includes them counts like any other (**Contacted**, and the 30-day rule).
- So keep the **Test mailboxes** list out of real campaigns: don't tick it when you choose an audience.

## 8. Switch on Go live

1. Open **Settings › Sending & Mailgun** and scroll to the **Go live** card (after **Test list**). Only the Owner sees this page.
2. If "Before going live:" still lists something, do that first (steps 2 to 4). "Recommended first:" lists things worth doing that never block, such as a practice restore or a second backup folder.
3. Click the **Go live** switch. A dialog **Go live?** opens. It says:
   - "New campaigns send real email to everyone eligible, not only your test list. Sending mode switches to Live."
   - "Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 1,000 in about 4 weeks."
   - "Every email shows From contact@polygonparadise.com. Complaints about them count against polygonparadise.com, the domain your everyday email uses."
   - "Bounces and complaints are counted from now on; your test emails don't count."
   - If you changed today's limit by hand: "Today's limit you set by hand (400) is removed: today sends at most 50."
   - If some drafts were made before now: "These drafts will send real email when launched: "Germany Q4" (412 people), … Check them before launching."
   - "Campaigns already running keep the mode they were launched with."
   - "Your test mailboxes become normal companies: emailing them in a live campaign from now on counts as emailed."
   - "This can't be switched off. To stop sending at any time, use Pause all sending."
4. If the reply test's email landed in spam at one of your test mailboxes (Mailgun guide, step 13), the dialog has a second box: "I know the reply test's email landed in spam at Outlook.com (…). Go live anyway: fewer people there may see our emails at first." Tick it only if you accept that: new sending often lands in Microsoft's junk folder at first, so start with small campaigns and watch the replies. Without the tick, going live says "Tick the box about the spam folder first."
5. Tick **I understand that real prospects will get emails from now on.** and click **Go live**. (**Not yet** closes the dialog and changes nothing.)

**In the own-mailbox setup** ([Own-mailbox guide, step 11](2-own-mailbox.md#11-going-live)) the dialog's From line is "Every email shows From contact@polygonparadise.com and goes out through polygonparadise.com itself. Replies come only to contact@polygonparadise.com: the app never sees them." On Mailgun's Free plan the warm-up line in the dialog ends at 90 a day instead of 1,000: "Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 90 in about 4 weeks." And two more boxes must be ticked:

- "I read contact@polygonparadise.com every working day, its inbox and its Spam folder. When someone answers there, I click They replied on their company, I handle removal requests and "couldn't be delivered" notices with Mark unsubscribed, and then I click I've read contact@polygonparadise.com: live follow-ups wait for that each day." Without it: "Tick the box about replies in your own mailbox first."
- While unsubscribe links use http (the Free plan): "I know unsubscribe links use http on my Mailgun plan, so Gmail's and Yahoo's one-click unsubscribe button may not show." Without it: "Tick the box about unsubscribe links first."

**What you should see:** "You're live. New campaigns now email everyone eligible, and warm-up has started." The top bar says **Sending live**. The card says "Live on mail.polygonparadise.com since … (switched on by …). New live campaigns email everyone eligible.", then "Emails show From contact@polygonparadise.com; replies go to each sender's own address.", with the warm-up line under it. Everyone on the team gets the notification "The app is live". In the own-mailbox setup it says "Live on polygonparadise.com since …" and "Emails show From contact@polygonparadise.com; replies go straight to that mailbox."

**What changes:**

- **Sending mode is Live**, and the choice is called **Live** (no longer "Live (test list only)"). New live campaigns email everyone eligible, inside sending hours and under the daily limit.
- **Campaigns keep the mode they were launched with.** A live campaign launched before today keeps emailing only your test list, and never counts as emailed. Dry runs stay dry runs.
- **Test mode stays test-list only**, for good: it only checks the connection.
- **Live campaigns only email checked addresses**: the **Verify** step checks them with Mailgun first.
- **A draft made before you went live asks for a tick** on the **Schedule** step before it can launch in Live: "This draft was made before you went live. It now sends real email to 412 people."
- **Bounces and complaints count from now on**, so rehearsal bounces don't count toward the automatic pause. When you go live again after changing the From address, they keep counting from your first go-live on mail.polygonparadise.com (step 13).
- **It can't be switched off.** To stop sending at any time, use **Pause all sending** (Settings › Sending & Mailgun): it stops every campaign at once, including dry runs, until you click **Resume sending**. You can also pause one campaign on its page, or set Sending mode back to **Dry run** for new campaigns.

## 9. Warm-up

Your outreach emails have to earn the trust of inbox providers (mail.polygonparadise.com is new to them, and contact@polygonparadise.com has never sent outreach), so the daily limit starts low and rises step by step. The steps (with the standard settings) are:

50, 59, 69, 80, 94, 110, 129, 151, 177, 207, 242, 283, 332, 389, 455, 533, 624, 730, 855, 1,000.

- **Day one is step 1: 50 emails.** The ramp starts on the day you go live; what you sent before doesn't count.
- **It goes up one step after a weekday on which at least half of that day's limit was used and bounces and complaints stayed low.** On other days (a weekend, a quiet day, too many bounces) the step holds. So it takes about 4 weeks at the earliest to reach 1,000, often longer. That's fine.
- **Where to see it:** the dashboard's **Today** tile and **Settings › Limits & warm-up**, for example "Warm-up step 9 of 20: 177 a day. It goes up to 207 after a weekday with at least half the limit used and healthy numbers." Once today already qualifies, the dashboard says "Tomorrow 207, if today's numbers stay healthy.": it rises tomorrow unless bounces or complaints come in before the day ends. These sentences are for the standard settings: if you change **Rises after using (%)** or the sending days in Settings › Limits & warm-up, they follow your settings, for example "after a sending day with at least 80% of the limit used".
- **Changing today's limit by hand:** **Settings › Limits & warm-up › Change today's limit**. It asks you to confirm and warns when the number is above the warm-up schedule, because sending more than the schedule can hurt how inbox providers see your new domain. It is for today only.

## 10. Your first real campaign

Start small, so a problem shows with 20 people, not 400:

1. Pick **20 to 30 companies from one list** whose people you'd really like to reach.
2. In **Contacts**, tick them and click **Email these companies**.
3. **Verify**: the app checks each address with Mailgun first and shows what it costs. Live campaigns only email addresses that were checked and can be emailed.
4. **Review**: read every email (the personal lines too), and click **Send me a test** to get one in your own inbox.
5. **Schedule**: check the time and the sentence about who gets real email, then **Launch campaign**.

**The next day**, look at the dashboard: **Today** (how many went out and the warm-up step), **Domain health** (bounces and spam complaints, counted since you went live) and **Replies waiting for an answer**. Answer replies in your own email program, then click **Answered** in the app.

## 11. The first weeks

**Every day (5 minutes):** the dashboard's **Needs your attention** list, your **Replies waiting for an answer** (click **Answered** once you've replied), and new **AI lines** to review. In the own-mailbox setup, instead of replies waiting: read contact@polygonparadise.com (its inbox and its Spam folder), click **They replied** on every company that answered, then click **I've read contact@polygonparadise.com** on **Notifications** ([Own-mailbox guide, step 12](2-own-mailbox.md#12-every-working-day)).

**Every week:** the newest backup is less than a day old (the dashboard warns after 36 hours), the Domain checklist is still green, `status.bat` shows no line starting with `[x]` or `[!]`, and Google Postmaster Tools shows no trouble for polygonparadise.com (below).

**Every month:** update cloudflared ([Cloudflare guide, step 15](3-cloudflare.md#15-keeping-cloudflared-up-to-date)); install the newest Node.js 24 security update if there is one ([README, "Updating"](../../README.md#updating)); compare Mailgun's and Anthropic's invoices with the app's own monthly limits (address checks in **Settings › Deliverability**, AI in **Settings › AI**).

**Watching your main domain (polygonparadise.com).** Every email shows From contact@polygonparadise.com, so complaints about your outreach count against the domain your everyday email uses.

- **Complaints.** The app pauses sending by itself when Mailgun reports complaints (from Microsoft, Yahoo and others). Gmail and Google Workspace never report complaints: only Google Postmaster Tools shows those. So once a week, open [postmaster.google.com](https://postmaster.google.com) and look at polygonparadise.com's spam rate ([Mailgun guide, step 16](2-mailgun-and-dns.md#16-optional-gmails-dashboard-and-your-domains-age); in the own-mailbox setup [Own-mailbox guide, step 14](2-own-mailbox.md#14-optional-google-postmaster-tools-and-your-domains-age)), and keep **Settings › Deliverability** › **Thresholds** as they are. When complaints reach half the limit, the Owner's warning adds: "Your emails come from contact@polygonparadise.com, so these complaints also count against your everyday email. Gmail's complaints aren't in this count: check Google Postmaster Tools."
- **Mail that lands in contact@.** A prospect who writes a new email to contact@polygonparadise.com (or whose colleague does) isn't seen by the app, and the follow-ups continue: click **They replied** on that company (or set its status to **Replied**). In the own-mailbox setup every reply lands there. When someone asks at contact@ to be removed, or contact@ gets a "couldn't be delivered" notice about a campaign email, set the company to **Do not contact** or put that address on the do-not-email list (Settings › Deliverability › Add an address). Forwarding such an email to a reply address doesn't help: the app treats mail from contact@ as your team's own.
- **The way back**, if polygonparadise.com's reputation suffers: **Pause all sending**, cancel every test or live campaign that is scheduled, running or paused, empty the From address, click **Resume sending**, then run the reply test, send a live campaign to your test list and go live again. Step 13 has the full order, including how to let a campaign finish instead of cancelling it (and "Sending safely" in the [README](../../README.md#sending-safely)). **In the own-mailbox setup, don't empty the From address**: every email there needs contact@polygonparadise.com, so nothing could be sent at all. Move to the full setup first (Mailgun's Foundation plan and mail.polygonparadise.com, [Own-mailbox guide, step 15](2-own-mailbox.md#15-switching-to-the-full-setup-later)), then follow this order.

**The dashboard's numbers:**

- **Reply rate:** of the companies the app has emailed, how many replied, for example "Reply rate: 20% (1 of 5 companies you emailed replied)". The second line counts only companies first emailed in the last 30 days.
- **Today:** emails that went out today against today's limit, with the warm-up line.
- **Domain health:** bounces and spam complaints against your own limits and Mailgun's.
- **Dry runs and test mode** are shown in their own box: they never count as emailed and aren't in the other numbers.

## 12. If something goes wrong

- **"Paused: 7 of the last 200 emails bounced" (or "… were marked as spam").** The app stopped sending by itself, because too many emails bounced (with the standard thresholds: more than 6 of the last 200) or were marked as spam (more than 1 of the last 1,000). Open **Settings › Deliverability**: it lists each bounce and complaint with its campaign and lists. Remove or re-check the list they came from, then click **Resume sending** in **Settings › Sending & Mailgun**. Resuming starts a fresh count. Mailgun's own limits are 5% bounces and 0.08% complaints, so the app stops well before Mailgun would.
- **You want everything to stop now:** **Pause all sending** in **Settings › Sending & Mailgun**. Nothing is sent, not even dry runs, until you click **Resume sending**.
- **A spam complaint:** that address goes on the do-not-email list for good and gets nothing more. With the standard thresholds one complaint doesn't pause anything, but look at who it was and whether that list is right for cold email.
- **Remote access is down** (the dashboard says so, and the Owner gets a notification after 15 minutes): remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run `status.bat` ([Cloudflare guide, step 16](3-cloudflare.md#16-troubleshooting)). Nothing is lost: Mailgun retries, and the app catches up when it's back.
- **The PC was off for more than 5 days:** the app can't be sure it saw every reply, so it puts the follow-ups on hold. Each sender gets a notification, checks their inbox for replies from those days, then clicks **I've checked my inbox** on **Notifications**. The Owner can click **Continue follow-ups** in **Settings › Sending & Mailgun**. See "When the PC is off" in the [README](../../README.md#when-the-pc-is-off-and-keeping-it-awake). In the own-mailbox setup there is no such hold: the daily inbox check covers those days.
- **Live emails say "Waiting: mail for your main domain points to Mailgun or is missing, …"**, and the Owner gets "Mail for polygonparadise.com goes to the wrong place": polygonparadise.com's MX records point to Mailgun or are gone, so your everyday email is at risk too. Fix them at GoDaddy and click **Check again** on the Domain checklist ([Mailgun guide, step 18](2-mailgun-and-dns.md#18-troubleshooting)). Live emails go again once the row "Mail for polygonparadise.com stays with your mail provider (MX)" is **Done**. In the own-mailbox setup the line reads "Waiting: mail for your domain doesn't go to your mail provider (it points to Mailgun or Cloudflare Email Routing, or is missing), …" ([Own-mailbox guide, step 16](2-own-mailbox.md#16-troubleshooting)).
- **A reply, a removal request or a "couldn't be delivered" notice landed in contact@polygonparadise.com:** the app didn't see it. Click **They replied** on the company (a reply), or **Mark unsubscribed** on that person or set the company to **Do not contact** (the others), as in step 11.

## 13. Changing the sending domain or the From address later

Changing the sending domain in **Settings › Sending & Mailgun** after going live **ends going live**:

- Live campaigns only reach your test list again, until you go live on the new domain.
- Going live on it needs the whole checklist again: its DNS records, **Check again** within the hour, the reply test, and a delivered live test on the new domain (step 3). The **Go live** card is then called "Go live on <new domain>".
- The new domain starts its own warm-up at 50, and again on the day you go live on it.
- For 60 days the app keeps checking Mailgun's logs for the old domain, so late replies and bounces to its last emails are still noticed. If it can't, the dashboard says so ("Mailgun's logs for the old domain … haven't been checked since …").
- Campaigns you launched earlier keep counting as they did.
- A new sending domain must fit the From address: mail.polygonparadise.com does, another name may not ("Your From address contact@polygonparadise.com doesn't fit <new domain>. Clear or change it in the From address card first."). Moving mail.polygonparadise.com to another Mailgun region counts as a domain change too.
- Changing **How the app sends** (between **From polygonparadise.com itself** and **Through a sending subdomain**) counts as a change of the sending domain too, with everything above, even when the domain name stays the same. The [Own-mailbox guide, step 15](2-own-mailbox.md#15-switching-to-the-full-setup-later) gives the order for moving from your setup to the full setup.

Changing the **From address** in **Settings › Sending & Mailgun** (another address, or empty so that emails come from each person's own address on mail.polygonparadise.com) after going live **ends going live** too. The app asks first: **Change the From address?** "Going live ends: live campaigns only reach your test list until the reply test passes again and you go live again." Click **Change it** (or **Keep it** to leave everything as it was). Then:

- Live campaigns only reach your test list again. The **Go live** card says, for example, "You were live with contact@polygonparadise.com as the From address. After the change to each person's own address, live campaigns only reach your test list until you run the reply test and go live again.", and the dashboard's **Needs your attention** says "You changed the From address. Live campaigns only reach your test list until you run the reply test and go live again."
- Going live again needs a new **Check again** on the Domain checklist, the reply test again with the new From address (its answers and the pasted original were cleared; the Setup stays), and a delivered live test sent with the new From address (step 3). Test emails and live campaigns from before the change don't count.
- Going live again starts the warm-up again at 50 a day.
- Bounces and complaints keep counting: going live again doesn't start a fresh count, because the emails still go through mail.polygonparadise.com. Those from before the change still count toward the automatic pause and on the dashboard's **Domain health**. (A new sending domain starts its own count on the day you go live on it.)
- Campaigns launched earlier keep the From address they started with.

The domain and the From address can't be changed while a test or live campaign is scheduled, running or paused: the app says "Finish or cancel … first" (for the From address: "Finish or cancel “Germany Q4” first: it sends with the current From address."). Let those campaigns finish, or cancel them, then make the change. Campaigns don't finish while sending is paused.

To go back to each person's own address, in this order:

1. Click **Pause all sending** (Settings › Sending & Mailgun). Nothing more goes out while you make the change.
2. Cancel every test or live campaign that is scheduled, running or paused: open it under **Campaigns** and click **Cancel campaign**. To let a campaign finish instead, click **Resume sending** and wait until it has finished; until then it keeps sending From contact@polygonparadise.com.
3. Empty the From address and click **Save From address** (after going live the app asks first: click **Change it**).
4. If sending is still paused, click **Resume sending**. The reply test can't send while sending is paused.
5. Run the reply test again ([Mailgun guide, step 13](2-mailgun-and-dns.md#13-the-test-list-and-the-reply-test)) and send a live campaign to your test list (step 3). Then click **Check again** on the Domain checklist and go live again (step 8).

In the own-mailbox setup an empty From address stops every test and live campaign, because every email there needs contact@polygonparadise.com. Move to the full setup first (Mailgun's Foundation plan and mail.polygonparadise.com, [Own-mailbox guide, step 15](2-own-mailbox.md#15-switching-to-the-full-setup-later)), then follow this order.
