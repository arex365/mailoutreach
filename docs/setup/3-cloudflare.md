# Cloudflare guide (remote access)

This guide gives the app a secure public address, for example **https://outreach.example.com**, so that:

- remote staff can open the app from anywhere, and the office can too, without the limits of the plain http office address;
- Mailgun can tell the app about deliveries, bounces, unsubscribes and replies.

**In the own-mailbox setup this guide is optional** ([Own-mailbox guide](2-own-mailbox.md)). Without it the app works on this PC and your office network, and Mailgun's reports reach the app through its hourly check instead of at once. Remote staff still need it.

It uses two free Cloudflare services:

- **Cloudflare Tunnel:** a secure connection from this PC out to Cloudflare. Nothing changes on your router, and no port is opened.
- **Cloudflare Access:** a login in front of the app. Staff type a code that Cloudflare emails them before they see the app's own sign-in page. It's free for up to 50 people, but Cloudflare asks for a payment card at sign-up (it isn't charged).

It takes about 45 minutes, plus waiting for Cloudflare to activate your domain (up to 24 hours) if it isn't on Cloudflare yet. Do the steps **in order**: the login (steps 2–6) must exist before the public address (step 10), or the app would be open to anyone for a while.

In this guide, **example.com** stands for the app's domain and **outreach.example.com** for the app's public address. Always type your own. Cloudflare's screens change from time to time; where a button name couldn't be checked against the live dashboard, this guide says "(it may be called …)".

**Before you start**

- **The app's domain.** One of:
  - **(a)** a domain that is already on Cloudflare;
  - **(b)** polygonparadise.com, moved to Cloudflare (step 1 has a checklist so your website, your contact@ email and your outreach emails keep working);
  - **(c)** a cheap separate domain just for the app, about $10 a year. *Recommended if unsure.*

  Never use mail.polygonparadise.com (the Mailgun guide's sending subdomain) for the app: keep outreach email and the app apart.
- **The staff email addresses** that may log in, and how often people should re-enter a code: daily, weekly or monthly.
- **Administrator rights on this PC** (steps 7 and 8).
- This PC must stay on and awake: remote access works only while it runs (the install guide's `setup-pc.bat` already set that up).

> **Skipping Cloudflare Access**
>
> Cloudflare Access (the login in steps 2 to 6) is optional, and recommended. Without it, anyone who finds the app's address sees the app's own sign-in page. Your data is still protected by everyone's password, and the app slows down wrong password tries. If you decide not to use Access:
>
> - Do step 1, skip steps 2 to 6, and do steps 7 to 16 as written. In step 14, test 3 then shows the app's own sign-in page straight away, without a Cloudflare code.
> - In the app, open **Settings › System** and, on the **Remote access** card, switch on **We don't use Cloudflare Access**. It asks first ("Turn off the Access check?"): click **Turn it off**. The **Remote access** card and, a minute later, the Domain checklist's "Remote access works" row then say "Remote access works. Cloudflare Access is off (Settings › System), so the app's own sign-in is the only login." instead of a problem, and going live doesn't wait for Access.
> - The **Go live** card keeps a reminder under "Recommended first:": "Cloudflare Access is off, so anyone who finds the address sees the app's sign-in page."
>
> To add Access later, do steps 2 to 6, then switch **We don't use Cloudflare Access** off again.

---

## 1. Put the app's domain on Cloudflare

1. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (skip if you have an account) and switch on **two-factor authentication** in your profile. Zero Trust (step 2) expects it.
2. Then, depending on your choice:

**(a) The domain is already on Cloudflare.** Check that its status is **Active** and go on to step 2.

**(c) Buy a separate domain.** The easiest place is **Cloudflare Registrar**: it sells domains at cost, with no markup. A .com costs about $10.44 a year (the checkout page shows the real price). It sells .com, .net, .org, .co, .io, .studio, .design, .agency, .me, .xyz and .uk, but **not** .de, .eu, .art or .pk. For those, use another registrar.

1. Your Cloudflare account's email address must be verified before you can buy a domain.
2. Open **Register domains** (it may be under **Domains** in the left menu).
3. Search for the name you want, click **Purchase** next to it, choose how many years under **Payment option** (automatic renewal is on by default, which is what you want), fill in your contact details (plain Latin letters only), pay, and click **Complete purchase**.
4. **Open the verification email from ICANN** (the organisation behind domain names) and click its link. If you don't, the domain is "parked" after a few days and the app goes offline.
5. Don't switch on Cloudflare "Email Routing" for this domain: the app doesn't need email there.

Nothing else to do: the domain uses Cloudflare automatically.

**(b) Move polygonparadise.com to Cloudflare.** Every outreach email depends on some of polygonparadise.com's records (the signature key, the From domain's DMARC and the records for `mail`), and your everyday Zoho mail on others, so take this step slowly.

1. Open **Domains** and click **Onboard a domain** (it may be called **Add a domain**). Type `polygonparadise.com`, let Cloudflare scan the existing records, click **Continue**, and choose the **Free** plan.
2. **Review DNS records.** The scan doesn't always find everything. Compare its list, record by record, with the one at your current DNS host (GoDaddy), and add anything missing, with exactly the same name and value:
   - the website's records (the domain itself and `www`);
   - the MX records of `@` (your Zoho mail);
   - the SPF TXT record of `@` **and every `dc-…._spfm` TXT record it includes** (GoDaddy's helpers for the SPF record). Without them the SPF record breaks for your everyday email too;
   - `mx._domainkey` (Mailgun's signature key: it signs every outreach email) and `zmail._domainkey` (Zoho's key);
   - `_dmarc`, the `google-site-verification` TXT and `email` (the old tracking CNAME);
   - the Mailgun guide's records: `mail` (two MX and one TXT) and `email.mail` (a CNAME). In the own-mailbox setup they don't exist: there, `_dmarc` is the one record you added.

   **Write down every record now, before you change the nameservers** (step 5): take screenshots of GoDaddy's DNS records page until every record's name and value is in a picture, and keep them. Once the nameservers point to Cloudflare, GoDaddy usually stops showing polygonparadise.com's records, so you can't look anything up there any more. The `dc-…._spfm` records matter most, because Cloudflare's scan can't guess their names. When the app was set up (September 2026) there were two: `dc-8e814c8572._spfm` with the value `v=spf1 include:zohomail.com ~all` (Zoho) and `dc-f2ba48d2cc._spfm` with the value `v=spf1 include:mailgun.org ~all` (Mailgun). If GoDaddy shows other ones, write those down instead. To see one record's value from this PC, type in PowerShell, with the record's full name: `nslookup -type=txt dc-8e814c8572._spfm.polygonparadise.com 1.1.1.1`.
3. Set the website's records (the domain itself and `www`) to **DNS only** (grey cloud). `email` and `email.mail` must be **DNS only** (grey cloud) too. Then the website and contact@ work exactly as before, and only the new app address goes through Cloudflare.

   **Never switch on Email Routing for polygonparadise.com**: it replaces Zoho's MX records. In the own-mailbox setup, never switch on Cloudflare Email Routing for polygonparadise.com: your mail would stop reaching Zoho.
4. Click **Continue**. Cloudflare shows **two nameservers**. Write them down exactly.
5. At GoDaddy: **switch DNSSEC off first** (changing nameservers while it's on can make the domain unreachable), then replace the nameservers with Cloudflare's two.
6. Wait. It can take up to 24 hours. The status goes from **Pending Nameserver Update** to **Active**, and Cloudflare emails you. To check from this PC, type in PowerShell: `nslookup -type=ns polygonparadise.com 1.1.1.1` (it should list Cloudflare's names). A domain that isn't activated within 28 days is removed from Cloudflare, so don't leave it half done.
7. Optional, once Active: switch DNSSEC on again, this time in Cloudflare.
8. Once Active, open Settings › Domain checklist in the app, click **Check again**, and check that "Your emails are signed (DKIM)", "Mail for polygonparadise.com stays with your mail provider (MX)" and "polygonparadise.com's SPF record (your everyday email)" (in the own-mailbox setup: "Mailgun may send for polygonparadise.com (SPF)") are still fine. The SPF row turns red when one of the records that polygonparadise.com's SPF record includes went missing in the move, and it names that record. Add it in Cloudflare (**DNS** › **Records** › **Add record**, type **TXT**; the names may differ) with the name and value you wrote down in step 2, then click **Check again**. Don't look for it at GoDaddy: after the move it usually isn't shown there any more. If you didn't write it down and it isn't one of the two records in step 2, ask the person who set up the app. The MX row warns when Email Routing took over the mail (in the own-mailbox setup it turns red, and live emails wait): switch Email Routing off and put Zoho's MX records back.

**What you should see:** the domain listed as **Active**. Cloudflare's free certificate (the "https" part) follows within 15 minutes to 24 hours. It covers addresses one level below the domain, like `outreach.example.com`, so don't use something like `outreach.app.example.com`.

## 2. Set up Zero Trust (Cloudflare's login service)

1. In the Cloudflare dashboard, click **Zero Trust** (it opens [one.dash.cloudflare.com](https://one.dash.cloudflare.com)).
2. Choose a **team name**, usually your business name, for example `polygonparadise`. It becomes the address of the login page staff see: `polygonparadise.cloudflareaccess.com`.
3. Choose the **Zero Trust Free** plan and enter a payment card. Cloudflare needs it even for the free plan, but doesn't charge it.

**What you should see:** the Zero Trust dashboard.

Good to know: every person who logs in takes one of the 50 free places until you remove them. A 51st person is blocked, never billed.

## 3. Add the one-time PIN login

New Cloudflare accounts only let people with their own Cloudflare account log in. Your staff log in with a code sent by email instead ("One-time PIN"), which you add here.

1. In Zero Trust, open **Integrations › Identity providers**.
2. Under **Your identity providers**, click **Add new identity provider** and choose **One-time PIN**. Save (the button name may differ).

**What you should see:** **One-time PIN** in the list of identity providers.

Tell your staff to allow emails from **noreply@notify.cloudflare.com**, so their mail filter doesn't block or "click" the codes.

## 4. Two policies: who may log in, and what is public

In Zero Trust, open **Access controls › Policies** and click **Add a policy**, twice.

**Policy 1: "Outreach staff"**

1. **Policy name:** Outreach staff.
2. **Action:** Allow.
3. **Session duration:** leave "Same as application session timeout".
4. **Rules:** **Include** | selector **Emails** | type each staff address, one per value, **including your own**.
5. **Save**.

**Policy 2: "Public webhook bypass"**

1. **Policy name:** Public webhook bypass.
2. **Action:** Bypass.
3. **Rules:** **Include** | selector **Everyone**.
4. **Save**.

**Never do these** (each one lets anyone in):

- an **Allow** policy with **Include | Everyone**;
- **Include | Login Methods | One-time PIN** on its own, without the list of emails: anyone with any email address could then get a code;
- the **Bypass** policy on the main "Outreach" app (step 5). A Bypass policy is checked before everything else, so it would open the whole app;
- the setting **Require Access protection**: it blocks every address of the domain that has no Access app, including your website.

**Staff joining or leaving.** Whenever someone joins the team or leaves it, edit the **Outreach staff** policy (**Access controls › Policies › Outreach staff**): add or remove their email address and click **Save**. Someone who isn't on the list gets no login code. In the app, invite or switch off the same person in **Settings › Team** (the README's "Your team"). To free the place of someone who left, see "People and codes" under Troubleshooting (step 16).

## 5. The main application "Outreach"

1. In Zero Trust, open **Access controls › Applications**, click **Create new application** and choose **Self-hosted and private**.
2. If it asks for a name: **Outreach**.
3. Click **Add public hostname**: **Subdomain** `outreach`, **Domain** your domain (from the list), **Path** left **empty** (empty means the whole app).
4. **Access policies:** add **Outreach staff**.
5. **Identity providers** (login methods): tick **One-time PIN** only and untick **Cloudflare**. Leave **Apply instant authentication** off.
6. **Session Duration:** how often staff re-enter a code. Daily = **24 hours** (the default), weekly = **1 week**, monthly = **1 month** (the entries may be worded slightly differently).
7. Leave **Additional settings** as they are (in particular, don't set SameSite to Strict).
8. Click **Create**.

**What you should see:** "Outreach" in the list of applications.

## 6. The second application "Outreach public endpoints"

Mailgun must reach two addresses of the app without a login: the webhooks and the health check. A second, more specific application lets exactly those through; the rest of the app stays behind the login.

1. **Create new application** › **Self-hosted and private** again. Name: **Outreach public endpoints**.
2. Click **Add public hostname** and add **two** entries, both with subdomain `outreach` and your domain:
   - **Path** `api/webhooks/*`
   - **Path** `api/health`

   Cloudflare's examples write paths without a "/" at the start; if the box insists on one, add it.
3. **Access policies:** add **Public webhook bypass**. The login methods don't matter here.
4. Click **Create**.

**What you should see:** two applications, "Outreach" and "Outreach public endpoints".

## 7. Install the connector (cloudflared) on this PC

**7a. Install the program.**

1. Open PowerShell as Administrator: click **Start**, type `PowerShell`, right-click **Windows PowerShell** and choose **Run as administrator**, then **Yes**.
2. Type this and press Enter:

   ```powershell
   winget install --id Cloudflare.cloudflared -e
   ```

   It installs Cloudflare's official connector into `C:\Program Files (x86)\cloudflared\` (that folder is normal, even on 64-bit Windows).
3. Close this window.

(If winget isn't available: download `cloudflared-windows-amd64.msi` from [github.com/cloudflare/cloudflared/releases/latest](https://github.com/cloudflare/cloudflared/releases/latest) and double-click it.)

**7b. Create the tunnel in Cloudflare.**

1. In the main Cloudflare dashboard (not Zero Trust), open **Networking › Tunnels** and click **Create Tunnel** (it may be called **Create a tunnel**).
2. **Name:** `outreach-pc`. Click **Create Tunnel**.
3. Under **Setup Environment**, choose **Windows** and **64-bit**.
4. Under **Install and Run**, Cloudflare shows a command ending in a very long code that starts with `eyJ`. That code is the **token**. Copy only the token. Ignore any other command on that page (for example one with `tunnel run`).

The token is a password for your tunnel: never email it or save it in a file.

**7c. Connect this PC.**

1. Open a **new** PowerShell as Administrator (as in 7a).
2. Type this, replacing `<TOKEN>` with the token (right-click pastes), and press Enter:

   ```powershell
   & "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install <TOKEN>
   ```

   The full path makes sure Windows runs the program you just installed, not a stray copy in another folder.

**What you should see:** a few lines ending without an error. Windows now has a service called **Cloudflared** that starts with the PC, even before anyone logs in, and restarts by itself after a problem.

## 8. Clear the token from PowerShell's history

PowerShell remembers every command you type, including the token. In the same Administrator window, type:

```powershell
Clear-History; Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue
```

This deletes PowerShell's saved history (nothing else). Close the window. The service keeps its own copy of the token in a file only administrators can read.

## 9. Check that the tunnel is "Healthy"

1. Back in Cloudflare, once the tunnel has connected, click **Continue**.
2. **Networking › Tunnels** shows `outreach-pc` as **Healthy** (four connections to Cloudflare).

Other states: **Inactive** means the command in step 7c never ran; **Down** means the Cloudflared service stopped (is the PC on?); **Degraded** means some of the four connections failed (see Troubleshooting).

## 10. Add the public address

Only now, with the login in place, connect the address to the app.

1. In **Networking › Tunnels**, click `outreach-pc`, open the **Routes** tab, click **Add route** and choose **Published application**.
2. **Hostname:** subdomain `outreach` (lowercase) and your domain from the list. Leave any path **empty**.
3. **Service URL:** `http://127.0.0.1:3000`. (Older screens split this into **Type** `HTTP` and **URL** `127.0.0.1:3000`.) Use `127.0.0.1`, not `localhost`.
4. **Don't open Additional application settings.** In particular:
   - leave **HTTP Host Header** empty (the app's buttons check it);
   - never set a **Connect timeout** (a known Cloudflare bug then makes every request fail);
   - leave **Protect with Access** off (the applications from steps 5 and 6 already protect the app, and this switch would block Mailgun).
5. Click **Add route** (on the separate Routes page the button is called **Save**).

**What you should see:** the route in the list. Cloudflare adds the DNS record `outreach` for you.

## 11. Three settings on the domain

Open the app's domain in the main Cloudflare dashboard (not Zero Trust).

1. **Email Address Obfuscation: Off.** Open **Security › Settings**, filter **Client-side abuse**, find **Email Address Obfuscation** and switch it **Off**. It's on by default and would scramble the email addresses the app shows.
2. **Bot fight mode: leave Off.** Same page, filter **Bot traffic**, **Bot fight mode**. Nothing can exempt Mailgun from it, so it must stay off.
3. **A rule so Cloudflare's security checks never block Mailgun.** Open **Security rules**, click **Create rule** and choose **Custom rules** (older menus: **Security › WAF › Custom rules**).
   - **Rule name:** Mailgun webhooks – skip
   - **When incoming requests match:** Field **Hostname**, operator **equals**, value `outreach.example.com`; **And** field **URI Path**, operator **starts with**, value `/api/webhooks/`.
     Or click **Edit expression** and paste (with your own address):

     ```
     (http.host eq "outreach.example.com" and starts_with(http.request.uri.path, "/api/webhooks/"))
     ```
   - **Then take action:** choose **Skip**, and tick **All managed rules**, **All rate limiting rules**, and in the list of products **Browser Integrity Check** and **Security Level** (they may be under **More components to skip**).
   - Leave **Log matching requests** on and click **Deploy**.

## 12. An email when the tunnel is down

Open **Notifications** (in the main dashboard), click **Add**, choose **Tunnel Health Alert**, click **Select**, give it a name, add your email, and click **Create**. It's free.

The app also tells you when remote access has been down for 15 minutes ("Remote access is down").

## 13. Give the app its public address

1. Double-click **`setup.bat`**. At **The app's public address**, type `https://outreach.example.com` (your own; it must start with https://, with nothing after the name) and press Enter.
2. If setup.bat says "The app is running as a background service. It wasn't rebuilt now. Double-click update.bat to rebuild and restart it.", double-click **`update.bat`** and let it run to the end.

**What you should see:** "Saved the public address: https://outreach.example.com". In the app, **Settings › Sending & Mailgun** now shows the two addresses for Mailgun under **For Mailgun**.

## 14. Test it

1. **The public addresses work without a login.** On your phone, switch Wi-Fi **off** (use mobile data) and open `https://outreach.example.com/api/health`.
   Expected: a short line of text starting `{"ok":true,"database":"ok"`, and **no** Cloudflare login page.
2. **Mailgun's address reaches the app.** On this PC, in a normal PowerShell window, type:

   ```powershell
   curl.exe -i -X POST https://outreach.example.com/api/webhooks/mailgun/events
   ```

   Expected: the first line ends in **406** (the app politely refusing an empty message, which is right), and the lines include `server: cloudflare`.
   Not expected: **302** with `cloudflareaccess.com` (step 6 isn't right), or a Cloudflare page about a challenge or a block (step 11).
3. **The app itself is behind the login.** On the phone, open `https://outreach.example.com/`.
   Expected: Cloudflare's login page. Type your email, tap **Send login code**, open the email from noreply@notify.cloudflare.com, type the code and tap **Sign in**. Then the app's own sign-in page appears.
   An address that isn't in "Outreach staff" still sees "A code has been emailed to you", but no email arrives: that's on purpose.
4. **The app agrees.** In the app, open **Settings › System**. The **Remote access** card says "Remote access works · checked … ago" and "Only your team gets past Cloudflare's login." Click **Check now** to check again.

From now on, anyone on the team can use `https://outreach.example.com`, in the office too. Then go back to step 11 of the Mailgun guide.

## 15. Keeping cloudflared up to date

cloudflared never updates itself on Windows, and Cloudflare supports versions for one year. **Settings › System** warns you when yours is too old or has a known problem ("cloudflared … has a known problem. Update it: …").

**To update** (every month or two is plenty): open PowerShell as Administrator and type:

```powershell
cloudflared update
net start cloudflared
```

Remote access drops for a few seconds while it restarts.

- **Never use version 2026.8.0 or 2026.8.1.** Cloudflare itself says "Do not use this version".
- **To choose an exact version** (for example to stay on one that works), use winget instead:

  ```powershell
  net stop cloudflared
  winget install --id Cloudflare.cloudflared -e --version 2026.9.1
  net start cloudflared
  cloudflared --version
  ```

  `winget upgrade --id Cloudflare.cloudflared -e` (between `net stop` and `net start`) moves to the newest version. To go back to an older version, `winget uninstall --id Cloudflare.cloudflared -e` first, then install the older one; the service and its token stay in place.
- Stick to one method. After `cloudflared update`, winget may keep offering an "upgrade"; that's harmless.

## 16. Troubleshooting

**Error 1033 (or 1016) instead of the app.** The tunnel isn't connected: the PC is off or asleep, or the Cloudflared service stopped. Check that the PC is on, run `status.bat`, and if the service is stopped, type `net start cloudflared` in PowerShell as Administrator. **Networking › Tunnels** should say **Healthy** again.

**502 Bad Gateway, "Unable to reach the origin service".** The tunnel works, but the app isn't answering on this PC. Run `status.bat`; double-click `start.bat` if the app is stopped.

**The webhook test gives 302 to …cloudflareaccess.com.** The "Outreach public endpoints" application doesn't match. Check that it has both paths (`api/webhooks/*` and `api/health`) on the same `outreach` address and uses the **Public webhook bypass** policy. The Domain checklist row "Remote access works" then says "The webhook address shows Cloudflare's login page. In Cloudflare, check that the 'Outreach public endpoints' app covers api/webhooks/* (Cloudflare guide, step 6)."

**"Anyone on the internet can reach your app's sign-in page."** The main "Outreach" application is missing, its Path isn't empty, or it has a Bypass or "Everyone" policy. Check step 5 (and step 4's "never" list).

**A Cloudflare challenge or "blocked" page for Mailgun's address.** Check the custom rule (step 11), that **Bot fight mode** is off, and that "Under Attack" mode isn't switched on.

**"This One-Time PIN has already been used."** A mail filter opened the code before the person did. Ask for a new code, and allowlist noreply@notify.cloudflare.com. Codes expire after 10 minutes, and asking for a new code cancels the previous one.

**No login code arrives.** The address isn't in the **Outreach staff** policy (step 4), or the email is in spam.

**Email addresses look scrambled in the app** (for example "[email protected]"). Email Address Obfuscation is on: step 11.

**The tunnel keeps showing Degraded or Down, while the PC's internet works.** Some networks block the connection type cloudflared prefers (QUIC) or have broken IPv6. Do this only if the tunnel keeps showing Degraded (not after a single blip), and if you're unsure, ask for help first ("Getting help" in the README): a wrong change in the Registry Editor can stop the service. Add an option to the service:

1. Open **Registry Editor** (Start, type `regedit`, run it as Administrator) and go to `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Cloudflared`.
2. Double-click **ImagePath**. It ends with `tunnel run --token-file C:\ProgramData\cloudflared\token`. Insert `--protocol http2` (for QUIC problems) or `--edge-ip-version 4` (for IPv6 problems) between `tunnel` and `run`, for example `… tunnel --protocol http2 run --token-file C:\ProgramData\cloudflared\token`. Keep `--token-file …` exactly as it is; never paste a `--token` example from the internet.
3. In PowerShell as Administrator: `net stop cloudflared`, then `net start cloudflared`.

Cloudflared's own messages are in **Event Viewer › Windows Logs › Application** (source "Cloudflared") and in the tunnel's **Live logs** tab in Cloudflare.

**People and codes.** To change who may log in, edit the **Outreach staff** policy. To sign everyone out: **Access controls › Applications › Outreach › Configure › Revoke existing tokens**. To sign yourself out: open `https://outreach.example.com/cdn-cgi/access/logout`. To free a place of someone who left: **Zero Trust › Team & Resources › Users** (the menu may be named slightly differently), select them and remove them.

**A new tunnel token.** In PowerShell as Administrator: `cloudflared service uninstall`, then step 7c with the new token. Cloudflare shows the command again under **Networking › Tunnels › outreach-pc › Overview › Add a replica**. Then step 8.

**Changing the public address later.** Run `setup.bat` again with the new address, then `update.bat`, then **Apply recommended settings** in the app (Mailgun's webhooks and reply routes use the address).
