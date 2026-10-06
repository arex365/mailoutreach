# Research (Milestone 3 prep, verified 2026-09-23): Cloudflare Tunnel and Access, click by click, for the owner guide

This file adds to `cloudflare.md` (planning research, 2026-09-22) and corrects it where needed. It does not repeat that file. Facts come from Cloudflare's own docs, fetched as raw Markdown (`<page>/index.md`) on 2026-09-23, and from the cloudflared source and releases on GitHub at tag 2026.9.1. Anything marked UNVERIFIED could not be confirmed against an official source or the live dashboard. Nobody logged in to a real Cloudflare dashboard for this research, so button labels come from the docs. Re-check them with the owner's first real run-through.

## Summary

- **Domain.** On the Free plan the domain has to use Cloudflare's nameservers.
  - Path: Domains > Onboard a domain > choose the Free plan > review DNS > change nameservers at the registrar (turn DNSSEC off first).
  - Activation takes "up to 24 hours". A Free zone that is not activated within 28 days is deleted.
  - After activation, the free certificate takes 15 minutes to 24 hours.
  - Buying a new domain through Cloudflare Registrar skips all of this. It is at cost (.com is about US$10.44–10.46 now, UNVERIFIED), uses Cloudflare nameservers automatically, and the owner must click ICANN's email-verification link, or the domain gets parked.
- **Tunnel.** Two dashboards manage tunnels:
  - the main dashboard, at Networking > Tunnels. Docs use it since 2026-02-20, and so does our guide;
  - the Cloudflare One dashboard (one.dash.cloudflare.com), at Zero Trust > Networks > Connectors.

  In the main dashboard: Create Tunnel > name > Create Tunnel > Setup Environment (Windows, 64-bit) > run the "Install and Run" command (`cloudflared.exe service install <TOKEN>`, as Administrator) > Continue > status **Healthy**.
- **Route.** Routes tab > Add route > Published application > Hostname (subdomain plus a domain from the dropdown, no path) > Service URL `http://127.0.0.1:3000` > Add route. Leave "Additional application settings" at their defaults: HTTP Host Header empty, and no Connect timeout (open bug #1702).
- **Access.**
  - Everything Access-related is in Zero Trust:
    - Access controls: Applications, Policies, Access settings;
    - Integrations > Identity providers;
    - Reusable components > Lists.
  - New organisations (since 2026-06-18) default to the "Cloudflare" identity provider with "Restrict to account members" on. One-time PIN must be added by hand.
  - Rule selectors are "Emails" and "Emails ending in", or a Zero Trust list used with "in list".
  - Session range: application session immediate to 1 month (default 24 hours); global session 15 minutes to 1 month (default 24 hours).
  - The more specific path wins and nothing is inherited. `/alpha/*` does not cover `/alpha`.
- **Zone.** All three settings are verified:
  - Security > Settings, filter "Client-side abuse": Email Address Obfuscation Off (it is on by default).
  - Security > Settings, filter "Bot traffic": Bot fight mode stays off. It is opt-in and can't be skipped.
  - Security rules > Create rule > Custom rules: a Skip rule for `starts_with(http.request.uri.path, "/api/webhooks/")`. On Free the useful skips are All managed rules, All rate limiting rules, Browser Integrity Check (on by default) and Security Level (this is Under Attack mode now).
- **Metrics.** Verified in source: with no `--metrics` flag, which is how the Windows service runs, cloudflared binds the first free port of 127.0.0.1:20241–20245.
  - `/ready` returns 200 `{"status":200,"readyConnections":N,"connectorId":"<uuid>"}` when N>0, otherwise 503.
  - `/metrics` includes `build_info{...,version="2026.9.1"}` and `cloudflared_tunnel_ha_connections`.
- **Updates and installer.**
  - Official method: `cloudflared update`, then `net start cloudflared`, as Administrator.
  - Alternative: winget, with the service stopped first. It is the only way to pin a version.
  - Never use 2026.8.0 or 2026.8.1 (official warnings). 2026.9.1 is current.
  - The amd64 MSI is still a 32-bit ("Intel") package, so it installs to `C:\Program Files (x86)\cloudflared\cloudflared.exe`. Checked in the MSI itself.

## 1. The domain on Cloudflare (Q11 a/b/c)

### Click path: existing domain (Q11 b, polygonparadise.com)

1. Sign up at https://dash.cloudflare.com/sign-up and turn on two-factor authentication. The Zero Trust docs list 2FA as a prerequisite.
2. Go to Domains (https://dash.cloudflare.com/?to=/:account/domains/overview) > **Onboard a domain** > enter the apex domain (`polygonparadise.com`) > choose how to add DNS records (quick scan) > **Continue** > choose the **Free** plan.
3. **Review DNS records**. The quick scan "is not guaranteed to find all existing DNS records". Compare them with the old DNS provider's list, especially the apex A/AAAA/CNAME, `www`, and every MX, SPF (TXT), DKIM (`*._domainkey`) and `_dmarc` record. Proxy status toggle: **Proxied** (orange cloud) or **DNS only** (grey cloud). Select **Continue**.
4. Cloudflare shows two assigned nameservers. They can't be changed ("Cloudflare automatically assigns nameservers ... these assignments cannot be changed").
5. At the registrar: **turn DNSSEC off first** ("Changing nameservers while DNSSEC is active can cause your domain to become unreachable"). Then replace the nameservers with Cloudflare's two, spelled exactly.
6. Wait. "Wait up to 24 hours while your registrar updates your nameservers."
   - Status goes from **Pending Nameserver Update** to **Active**, and Cloudflare sends an email.
   - Cloudflare's first check is after 60 seconds, then at growing intervals. The zone Overview page has a button to request an earlier re-check; its exact label is UNVERIFIED. Activation after a re-check "can take a few minutes to a few hours".
   - Check from Windows: `nslookup -type=ns polygonparadise.com 1.1.1.1`.
7. Optional: re-enable DNSSEC in Cloudflare once Active.
8. The free Universal SSL certificate arrives "within 15 minutes to 24 hours of domain activation". It covers the apex and one level of subdomain (`outreach.polygonparadise.com`).

Sources:
- https://developers.cloudflare.com/fundamentals/manage-domains/add-site/
- https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/
- https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/
- https://developers.cloudflare.com/dns/zone-setups/troubleshooting/pending-nameservers/
- https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/

Facts:
- A Free zone that stays Pending, or "Finish setup" (Initializing), for 28 days is deleted automatically. A deleted zone that is re-added gets a **new nameserver pair**. A deleted zone is purged after a further 7 days. — https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/
- Pending zones already answer DNS on Cloudflare's nameservers but cannot proxy. Cloudflare says: "Do not use pending zones in production". — same page.
- Published tunnel hostnames inherit the zone's settings, such as WAF and cache rules. — https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/

Advice for Q11 (b): keep the existing website and mail records exactly as they were, and set the website's A/CNAME records to **DNS only** (grey cloud) at first. Then the website and contact@ email behave exactly as before, and only the new tunnel hostname goes through Cloudflare's proxy. The zone-wide settings in section 5 then affect only proxied hostnames. This is my own inference, not a Cloudflare recommendation.

### Click path: buy a cheap separate domain (Q11 c, recommended if unsure)

1. Verify the Cloudflare account email first ("You must have a verified account email address, to transfer or register domains").
2. Go to **Register domains** (https://dash.cloudflare.com/?to=/:account/registrar/register). The sidebar label is UNVERIFIED: it is probably under Domains.
3. Search > **Purchase** on a result > choose the term in **Payment option** (auto-renew is on by default) > contact details (ASCII only; first and last name at least 2 letters) > **Payment** > accept the agreements > **Complete purchase**. It takes up to 30 seconds.
4. Nothing else to do: "All domains acquired via Cloudflare Registrar use Cloudflare nameservers". The onboarding docs say, "We will complete the rest of this setup for you." WHOIS details are redacted where the registry allows.
5. **Click the ICANN verification email.** "If your email is unverified or if the verification has expired, ICANN places a hold on the domain and replaces your nameservers with parking server nameservers". The app would go offline.

Sources:
- https://developers.cloudflare.com/registrar/get-started/register-domain/
- https://developers.cloudflare.com/registrar/faq/

Facts:
- Price: "Cloudflare Registrar sells domains at cost: you pay the registry and ICANN list price with no markup." Fees are non-refundable. — https://developers.cloudflare.com/registrar/faq/
- A .com costs about US$10.44–10.46 a year now, and a Verisign increase to about US$11.15 is reported from 1 Nov 2026. UNVERIFIED: third-party sites only. The checkout page shows the real price.
- Auto-renew is attempted about 30 days before expiry and retried three times. A failed renewal is "almost always a payment problem". — registrar FAQ.
- Registrar domains cannot move to other nameservers while at Cloudflare. That is irrelevant for an app-only domain.

## 2. Zero Trust (Cloudflare One) onboarding and creating the tunnel

### Zero Trust organisation

1. In https://dash.cloudflare.com/ select **Zero Trust**. The Cloudflare One dashboard lives at https://one.dash.cloudflare.com.
2. Choose a **team name**. This is "a unique, internal identifier for your Zero Trust organization ... Your business name is the typical entry". It becomes the team domain `<team>.cloudflareaccess.com`, which is where the Access login page is served. It can be looked up later at Zero Trust > **Settings**.
3. "Complete your onboarding by selecting a subscription plan and entering your payment details. If you chose the **Zero Trust Free plan**, this step is still needed but you will not be charged."
4. Cloudflare automatically adds the **Cloudflare identity provider** as the default login method. For new organisations **Restrict to account members** is on, so staff without a Cloudflare account can't use it.

Sources:
- https://developers.cloudflare.com/cloudflare-one/setup/
- https://developers.cloudflare.com/cloudflare-one/glossary/
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/
- Access changelog 2026-06-18 and 2026-05-19: https://developers.cloudflare.com/cloudflare-one/changelog/access/

UNVERIFIED:
- which payment methods are accepted (a card for sure; PayPal according to community posts only);
- the naming rules for the team name;
- whether the team name can be changed later.

### Tunnel (main dashboard, the path our guide uses)

The docs moved on 2026-02-20: "Cloudflare Tunnel is now available in the main Cloudflare Dashboard at Networking > Tunnels". The same tunnels are also listed in the Cloudflare One dashboard under Zero Trust > Networks > Connectors, and "Both dashboards provide complete Tunnel management capabilities". Source: https://developers.cloudflare.com/tunnel/platform/changelog/ (entry 2026-02-20). The Tunnel itself needs no Zero Trust organisation ("You do not need a paid Cloudflare Access plan to publish an application via Cloudflare Tunnel"). Access does.

1. Networking > **Tunnels** (https://dash.cloudflare.com/?to=/:account/tunnels) > **Create Tunnel**. The Zero Trust copy of the doc says **Create a tunnel**.
2. Enter a name, for example `outreach-pc` > **Create Tunnel**.
3. Under **Setup Environment**, pick the operating system and architecture: Windows, 64-bit.
4. Copy the command under **Install and Run** and run it on the PC. The Windows form in the docs is: "Open Command Prompt as administrator", then `cloudflared.exe service install <TUNNEL_TOKEN>`.
5. "Once the tunnel connects, select **Continue**." On the Tunnels page the tunnel should show `Healthy`.

Sources:
- https://developers.cloudflare.com/tunnel/get-started/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/

Only the Cloudflare One dashboard flow asks for a connector type first ("Cloudflared" rather than WARP Connector / Mesh) and has "Choose your environment" wording. That flow is UNVERIFIED because the docs now describe only the main-dashboard flow. Tell the owner to use Networking > Tunnels.

The exact text the dashboard shows is UNVERIFIED:
- whether the Windows panel also offers an MSI download link;
- whether it shows a second command, `cloudflared.exe tunnel run --token ...`, for a one-off run. Tell the owner to use **only** the `service install` line.

Our guide's install sequence changes the docs' order slightly, for the reasons listed below the steps:
1. Admin PowerShell: `winget install --id Cloudflare.cloudflared -e`. winget currently offers 2026.9.1; the installer is the official `cloudflared-windows-amd64.msi`, SHA-256 6F85717310DB514C0DB658C3B7BBDFF36C1D613C4EDEAFB4981B3160CC7B836F, checked with `winget show` and by downloading it on 2026-09-23. Alternatively, download that MSI from https://github.com/cloudflare/cloudflared/releases/latest and double-click it.
2. Open a **new** Admin PowerShell. Run `& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install <TOKEN>`, pasting the token part of the dashboard command. Also works: `cloudflared.exe service install <TOKEN>` typed in PowerShell, not cmd.

Why this order:
- The service is registered with whatever cloudflared.exe was run (`os.Executable()` in windows_service.go).
- PowerShell never runs an exe from the current folder without `.\`, so it takes the PATH copy.
- cmd.exe, as the docs suggest, would prefer a stray `cloudflared.exe` sitting in the current folder, for example Downloads.
- The explicit path also avoids the PATH not being refreshed in the old window.

Verified 2026-09-23 by inspecting the 2026.9.1 amd64 MSI's summary information and string table, without installing:
- **Install folder.** The MSI's platform template is `Intel;1033` and its directory is `ProgramFilesFolder\cloudflared`, so on 64-bit Windows the exe lands in `C:\Program Files (x86)\cloudflared\cloudflared.exe`. GitHub issue #992 about this is still open.
- **PATH.** The installer appends `[INSTALLDIR]` to the system PATH (cloudflared.wxs at tag 2026.9.1).
- **No service.** The MSI source (cloudflared.wxs) defines no Windows service. Only `cloudflared service install` creates the "Cloudflared" service.

Clearing the token from PowerShell history is standard PowerShell, not from Cloudflare's docs. Windows PowerShell 5.1 ships PSReadLine 2.0, which saves every command line. Run `Clear-History; Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue`. This deletes the whole saved history.

Since 2026.7.3, the token is not visible elsewhere either:
- the service stores it in `C:\ProgramData\cloudflared\token`;
- the Event Log line "service arguments" shows only `--token-file`;
- `/debug/pprof/cmdline` on the metrics port is blocked.

Source: cloudflared source at 2026.9.1, `cmd/cloudflared/windows_service.go` and `metrics/metrics.go`.

### Tunnel status meanings (for the guide)

| Status | Meaning (quoted from the docs) |
| --- | --- |
| Healthy | "active and serving traffic through four connections to the Cloudflare global network" |
| Inactive | created but "the cloudflared connector has never been run". The install command is in the tunnel's **Overview** tab > **Add a replica** |
| Down | "previously connected but is currently disconnected because the cloudflared process has stopped" |
| Degraded | running, but "at least one individual connection has failed" |

"The tunnel status only reflects the connection between cloudflared and the Cloudflare network ... A tunnel can appear **Healthy** while users are unable to connect to an application." — https://developers.cloudflare.com/tunnel/observability/

Free e-mail alert: Notifications (https://dash.cloudflare.com/?to=/:account/notifications) > **Add** > **Tunnel Health Alert** > **Select** > name, email > **Create**. It is "Included with All Cloudflare Zero Trust plans". — https://developers.cloudflare.com/tunnel/observability/ and https://developers.cloudflare.com/notifications/get-started/

Recommended for the owner. Whether it appears before a Zero Trust organisation exists is UNVERIFIED.

## 3. The public hostname ("published application route")

1. Networking > Tunnels > select the tunnel > **Routes** tab > **Add route** > **Published application**.
2. **Hostname**: type the subdomain `outreach` and pick the domain in the dropdown. Use lowercase (see below). Leave any path empty.
3. **Service URL**: `http://127.0.0.1:3000`. This is one combined field in the main dashboard. The older Cloudflare One form split it into "Type: HTTP" and "URL: 127.0.0.1:3000". That older layout is UNVERIFIED for 2026, but either way the result is the same.
4. Do **not** open **Additional application settings**. That panel has three groups since 2026-08-18: HTTP (Host header, chunked encoding), TLS, and Connection (timeouts, keep-alive, Happy Eyeballs). Leave **HTTP Host Header** empty (default `""`), so Next.js sees the public Host for its Server Actions origin check.
5. Select **Add route**. The Networking > Routes page calls this button **Save**.
6. In a full-setup zone Cloudflare creates the proxied DNS record for the hostname automatically.

Sources:
- https://developers.cloudflare.com/tunnel/get-started/
- https://developers.cloudflare.com/cloudflare-one/networks/routes/add-routes/
- https://developers.cloudflare.com/tunnel/reference/origin-parameters/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ ("In a full DNS setup, Cloudflare automatically creates DNS records when you add a published application route")

Right after this step: "Anyone on the Internet can now access the application at the specified hostname" unless an Access application already covers it. That is why section 4 comes **before** this step.

localhost vs 127.0.0.1:
- Cloudflare's own troubleshooting example of a dead origin is `dial tcp [::1]:8080: connect: connection refused`, which is `localhost` resolving to IPv6 (https://developers.cloudflare.com/tunnel/troubleshooting/).
- Next is bound to IPv4 (PLAN B11 uses `-H 0.0.0.0`, which also answers on 127.0.0.1).
- So use `127.0.0.1`. Details are in cloudflare.md.

Open cloudflared bugs relevant to this route (GitHub, 2026-09-23):
- **#1702 (open).** Setting any explicit `connectTimeout` in a remotely-managed route makes "every dial to that origin fail instantly". Never touch Connection > Connect timeout.
- **#1715 (open).** Ingress host matching is case-sensitive. Type the hostname in lowercase; browsers send it lowercase anyway.

## 4. Cloudflare Access (in this order, before section 3's route)

All paths below are in the Cloudflare dashboard under **Zero Trust**. The docs write them as "Zero Trust > Access controls > ...".

### 4a. Add One-time PIN

Zero Trust > **Integrations** > **Identity providers** > under **Your identity providers** select **Add new identity provider** > **One-time PIN**. The final save button is not named in the docs (UNVERIFIED). — https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/

- "New Zero Trust organizations use the Cloudflare identity provider as their default login method. OTP is no longer added automatically."
- PIN behaviour: it "expires 10 minutes after the initial request", each PIN is single-use, "Requesting a new PIN invalidates the previous PIN", and "Cloudflare only sends the email if the user is allowed by an Access policy".
- Staff mail filters must allowlist `noreply@notify.cloudflare.com` (domain `notify.cloudflare.com`, IPs 104.30.16.2–104.30.16.7). Link scanners cause "This One-Time PIN has already been used".

### 4b. Reusable policies

Zero Trust > **Access controls** > **Policies** > **Add a policy** > **Policy name** > **Action** > **Session duration** > **Rules** > **Save**. — https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/

- **"Outreach staff"**: Action **Allow**. Rule: **Include** | Selector **Emails** | the staff addresses (one value each). Session duration: leave as "Same as application session timeout".
  - Alternative, easier to edit later: first create a list at Zero Trust > **Reusable components** > **Lists** > **Create manual list**, List type "User email addresses" (the docs name the data type "User email addresses"; the exact dropdown label is UNVERIFIED), then use it in the rule with the "in list" operator (https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/).
  - Whether the Access rule builder shows the operator as "in list" or as a separate "Email list" selector is UNVERIFIED. For up to 50 people, typing addresses into the **Emails** selector is simplest.
- **"Public webhook bypass"**: Action **Bypass**. Rule: **Include** | **Everyone**. Official pattern: "Some applications have endpoints that must be publicly reachable, such as OAuth callback URLs, webhook receivers, or health check paths ... create a separate Access application ... and apply the following Bypass policy: Bypass | Include | Everyone." — https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/

Warnings quoted from the docs:
- Two misconfigurations let anyone in when used in an Allow policy (https://developers.cloudflare.com/cloudflare-one/access-controls/policies/):
  - "Include | Everyone";
  - "Include | Login Methods | One-time PIN".
- "Adding `Login Methods: One-time PIN` as an Include rule without restricting email domains allows anyone with any email address to receive a code and access the application. Always pair OTP with specific email domains or an email list in the Include rule." — common-policies.
- Bypass: "does not enforce any Access security controls and requests are not logged". "Scope Bypass policies as narrowly as possible."
- On bypassed traffic, "security settings revert to the defaults configured for the zone".
- Bypass policies can't use identity selectors such as email.

Evaluation order inside one application: "Bypass and Service Auth policies are evaluated first ... Then, Block and Allow policies". A Bypass policy added to the **main** app would therefore open the whole app, whatever the Allow policy says. Never put a Bypass policy on the main app.

### 4c. Main application

Zero Trust > **Access controls** > **Applications** > **Create new application** > **Self-hosted and private** > **Add public hostname**. — https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/

1. Fields: **Subdomain** `outreach`, **Domain** (dropdown of active zones), **Path** left empty ("To protect an apex domain and all of the paths under it, leave the Path field empty"). An application-name field is not listed in the docs' steps (UNVERIFIED).
2. **Access policies**: add the existing "Outreach staff" policy. "All Access applications are deny by default".
3. Identity providers: tick **One-time PIN** only and untick "Cloudflare". Leave **Apply instant authentication** off; its behaviour with OTP as the only provider is UNVERIFIED.
4. **Session Duration**: this is how often staff re-enter a code. Map the owner's Q11 answer: daily = 24 hours (default), weekly = 1 week, monthly = 1 month.
   - The documented range is "immediate timeout to one month". The exact dropdown entries (for example "1 week") are UNVERIFIED.
5. Additional settings: leave the defaults. HttpOnly is on by default, and Binding Cookie is off. Don't set SameSite to Strict, which causes ERR_TOO_MANY_REDIRECTS.
6. **Create**.

How session length really works (https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/):
- The application token expires after the app or policy session. At that point, "Cloudflare will automatically issue a new application token if the global token is still valid".
- The global session is set at Zero Trust > Access controls > **Access settings** > **Set your global session duration**. Its range is 15 minutes to 1 month, default 24 hours.
- The effective re-login interval is therefore the longer of the two. With the global session left at 24 hours, the app's Session Duration alone decides (24 hours / 1 week / 1 month).
- Owner tools:
  - Revoke everyone: Applications > app > **Configure** > **Revoke existing tokens**.
  - Log yourself out: `https://outreach.<domain>/cdn-cgi/access/logout`.

### 4d. Separate public-endpoints application

1. Create a second self-hosted application the same way. Use **Add public hostname** twice:
   - `outreach` / domain / Path `api/webhooks/*`
   - `outreach` / domain / Path `api/health`

   Whether the Path box wants a leading "/" is UNVERIFIED; the docs' examples have none.
2. Add the policy "Public webhook bypass". Identity providers don't matter here. **Create**.

Why this works, from https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/:
- "When multiple rules are set for a common root path, the more specific rule takes precedence ... and no rule is inherited".
- `example.com/alpha/*` covers `/alpha/one` but **not** `/alpha` itself. The webhook URLs must therefore always have something after `/api/webhooks/`.
- Slashes inside a wildcard: "Using a wildcard in the middle of the Path field covers multiple segments" (`/foo*/bar` matches `/food/stuff/bar`). A trailing `*` should therefore also cover `/api/webhooks/mailgun/events`. That is inferred, not stated. Test it with the POST in section 8.
- "Port numbers are not supported" and "Query strings ... are not supported" in paths. `/api/health?x=1` is still matched by the `api/health` entry.
- At most one `*` between slashes.
- Whether an exact path like `api/health` also matches `api/healthz` is UNVERIFIED. The docs only say a path's rules pass down to sub-paths that have no rule of their own.

Unchanged from cloudflare.md: create both apps **before** the tunnel route, and leave "Protect with Access" off on the route. Bypassed webhook requests carry no JWT. Cloudflare also recommends "creating an Access application before setting up the tunnel route". — self-hosted-public-app page.

Do not turn on the new "Require Access protection" setting (2026-01-22). It blocks any hostname without an Access app, including the owner's main website in Q11 (b). — https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/

## 5. Zone settings (the domain's own menu, not Zero Trust)

All verified 2026-09-23. The "new security dashboard" uses the names below. Accounts still on the old navigation have Security > WAF > Custom rules instead; that is UNVERIFIED for this account.

1. **Email Address Obfuscation: Off.** Security > **Settings** (https://dash.cloudflare.com/?to=/:account/:zone/security/settings) > optional filter **Client-side abuse** > **Email Address Obfuscation** > switch to **Off**. "Cloudflare enables email address obfuscation automatically when you sign up." — https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/
2. **Bot Fight Mode: leave Off.** Same Settings page > filter **Bot traffic** > **Bot fight mode**. The docs only describe turning it on ("Turn Bot fight mode on"), which means it starts off.
   - "You cannot bypass or skip Bot Fight Mode using WAF custom rules or Page Rules". It "may challenge API or mobile app traffic".
   - JavaScript Detections comes with it and can't be disabled.
   - Source: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
3. **WAF custom rule "Mailgun webhooks – skip".** Security rules (https://dash.cloudflare.com/?to=/:account/:zone/security/security-rules) > **Create rule** > **Custom rules** > **Rule name**.
   - Under **When incoming requests match**:
     - Field **Hostname**, operator **equals**, value `outreach.<domain>`;
     - **And** Field **URI Path**, operator **starts with**, value `/api/webhooks/`.

     The dashboard lists "starts with" as an extra operator. In the expression editor it must be written as a function: `(http.host eq "outreach.<domain>" and starts_with(http.request.uri.path, "/api/webhooks/"))`. On Free, `wildcard` also works, but `matches` (regex) needs Business or higher.
   - Under **Then take action** > **Choose action** = **Skip**. Tick:
     - **All managed rules** (skips the Free Managed Ruleset, which is deployed by default);
     - **All rate limiting rules**;
     - from the product list: **Browser Integrity Check** and **Security Level**.

     Why these two products: Browser Integrity Check "is enabled by default" and "challenges visitors without a user agent or with a non-standard user agent". Security Level now just means Under Attack mode, so skipping it keeps webhooks working if the owner ever switches Under Attack on. "All remaining custom rules" is optional.
   - Leave **Log matching requests** on (it is on by default). Select **Deploy**.
   - Sources: https://developers.cloudflare.com/waf/custom-rules/skip/, …/skip/options/, …/create-dashboard/, https://developers.cloudflare.com/ruleset-engine/rules-language/operators/, https://developers.cloudflare.com/waf/tools/browser-integrity-check/, https://developers.cloudflare.com/waf/tools/security-level/
   - Free plan: 5 custom rules, every action except Log.
   - "All Super Bot Fight Mode rules" means nothing on Free, because Super Bot Fight Mode is Pro or higher.
   - Zone Lockdown and Hotlink Protection are listed as skippable products but are not needed.
   - Whether the product checkboxes sit under a "More components to skip" expander is UNVERIFIED.

## 6. Checking the tunnel from our app (cloudflared metrics)

Verified in source at 2026.9.1 (`metrics/metrics.go`, `metrics/readiness.go`, `cmd/cloudflared/tunnel/cmd.go`) and at https://developers.cloudflare.com/tunnel/observability/:
- **Address.** The `--metrics` flag defaults to `localhost:0`. In that case cloudflared tries `localhost:20241` … `localhost:20245` in order and falls back to a random port. Docs: "`cloudflared` starts the metrics server on `127.0.0.1:<PORT>/metrics`" in non-container setups.
  - The Windows service runs `tunnel run --token-file …` without `--metrics`, so it uses this default.
  - A second cloudflared on the PC (for example a manual `tunnel run`) would take the next port.
  - The log line to look for is `Starting metrics server on 127.0.0.1:20241/metrics`.
- **`GET /ready`.** Returns HTTP 200 with body `{"status":200,"readyConnections":4,"connectorId":"<uuid>"}` when active connections > 0. Otherwise it returns HTTP 503 with `{"status":503,"readyConnections":0,"connectorId":"<uuid>"}`. Healthy means 4 connections, and fewer than 4 means "Degraded".
- **`GET /healthcheck`.** Always `OK\n` while the process runs, so it is useless for tunnel state.
- **`GET /metrics`** (Prometheus text) includes:
  - `build_info{goversion="…",revision="…",type="…",version="2026.9.1"} 1`, which lets the app warn about 2026.8.0 or 2026.8.1 and about versions more than a year old;
  - `cloudflared_tunnel_ha_connections`;
  - `cloudflared_tunnel_total_requests`;
  - `cloudflared_tunnel_request_errors` (errors proxying to the origin).
- The same port also serves `/config` (the remote ingress config as JSON), `/debug/pprof/*` and `/diag/*`. They are local only; the app must never proxy or display them.
- Implementation notes (inference):
  - In Node, call `http://127.0.0.1:<port>/ready` with the literal IP, not `localhost`.
  - Try 20241–20245 and accept a port only if the JSON has a `connectorId` field. That makes sure it is cloudflared, not some other program.
  - Short timeout (for example 1 s).
  - Treat "no port answers" as "cloudflared not running".

## 7. Updating cloudflared on Windows

- **Official method** (https://developers.cloudflare.com/tunnel/guides/update-cloudflared/): in an Administrator terminal run `cloudflared update`, then `net start cloudflared`.
  - "Updates will cause cloudflared to restart which will impact traffic currently being served."
  - Internally the updater writes `cfd_update.bat` next to the exe (`sc stop cloudflared`, rename the old exe, rename the new one into place, `sc start cloudflared`). `net start` afterwards is harmless if the service is already running.
  - The package-manager refusal ("installed by a package manager. Please update using the same method") only triggers on non-Windows marker files or on package-manager builds, so it does not fire for the MSI or winget install (source `cmd/cloudflared/updater/update.go`).
  - `cloudflared update` always fetches the newest release; it can't pin a version.
  - "cloudflared will not automatically update on Windows systems" (source).
- **winget method** (not in Cloudflare's docs; commands are standard winget). This is the only way to pin a version:
  1. `net stop cloudflared`
  2. `winget upgrade --id Cloudflare.cloudflared -e`, or `winget install --id Cloudflare.cloudflared -e --version 2026.9.1` to pin
  3. `net start cloudflared`
  4. `cloudflared --version`

  Notes:
  - What an in-place MSI upgrade does to a *running* service is UNVERIFIED, hence stopping it first.
  - The MSI refuses downgrades ("A later version of [ProductName] is already installed", cloudflared.wxs). To go back a version, `winget uninstall` it, then install the older version.
  - Uninstalling the MSI leaves the service and `C:\ProgramData\cloudflared\token` in place, because the MSI doesn't own them. This is inferred from the wxs.
- **Choose one method.** After `cloudflared update`, the MSI/winget record still shows the old version, so winget keeps offering an "upgrade". That is harmless.
- **Support window:** "Cloudflare supports versions of cloudflared that are within one year of the most recent release." — https://developers.cloudflare.com/tunnel/downloads/
- **Known-bad or risky versions in 2026** (GitHub releases, RELEASE_NOTES and issues, checked 2026-09-23):
  - **2026.8.0**: official warning "Do not use this version". It strips trailing slashes (#1717).
  - **2026.8.1**: official warning "Do not use this version". It normalizes paths (#1719). Fixed in 2026.8.2 ("VULN-141859: Revert path normalization").
  - **2026.9.0**: issue #1737 (open) reports segfaults in quic-go `QueueProbePacket` roughly every 75 s, **in a Docker bridge network**; a host-network install of the same binary was stable. It is not reported on Windows. The fix status in 2026.9.1 is UNVERIFIED, because 2026.9.1's notes only concern log levels. If Event Viewer shows repeated Cloudflared restarts on 2026.9.x, pin 2026.8.3 with winget.
  - **Before 2026.7.3**: the Windows service keeps the token on its command line instead of in a token file. Current releases are fine.
  - Current: **2026.9.1** (2026-09-11), previously 2026.9.0 (09-09) and 2026.8.3 (08-31).
- **Behaviour change to know for troubleshooting:** since 2026.4.0 "The default value of `--edge-ip-version` has changed from `4` to `auto`" (CHANGES.md). The source at 2026.9.1 confirms the default `"auto"`. The run-parameters doc still says `4` and is out of date.
  - If a PC with broken IPv6 shows Degraded or Down, try `--edge-ip-version 4`. Likewise, a network that rejects QUIC may need `--protocol http2` (issue #1736: `auto` may not fall back when the QUIC handshake is *rejected*).
  - For a service, both flags go into the registry ImagePath (HKLM\SYSTEM\CurrentControlSet\Services\Cloudflared), before `run`, per https://developers.cloudflare.com/tunnel/reference/run-parameters/. Keep `--token-file C:\ProgramData\cloudflared\token`; don't paste the docs' `--token` example.
  - Environment-variable equivalents are TUNNEL_EDGE_IP_VERSION and TUNNEL_TRANSPORT_PROTOCOL.
- **Deprecation:** 32-bit Windows builds end in 2027 (changelog 2026-09-18). The amd64 MSI is unaffected, even though its installer is marked "Intel" internally.

## 8. Testing, and what the owner sees

1. **Public endpoint (the Access bypass works).** On a phone with **Wi-Fi off (mobile data)**, open `https://outreach.<domain>/api/health`. Expected: the app's small JSON, with **no** Cloudflare login page.
   - The same check from the PC: `curl.exe -i https://outreach.<domain>/api/health`. It still goes out through Cloudflare, because it uses public DNS.
   - Look for `server: cloudflare` and a `cf-ray` header.
   - A 302 to `https://<team>.cloudflareaccess.com/...` means the bypass app doesn't match.
2. **Webhook path.** `curl.exe -i -X POST https://outreach.<domain>/api/webhooks/mailgun/events`.
   - Expected: our app's own "bad signature" response.
   - Not expected: a 302 to cloudflareaccess.com (bypass path wrong, see the section 4d wildcard note), or a Cloudflare challenge or block page (WAF or bot setting).
   - Then use Mailgun's own webhook test (M3 guide).
3. **Main app with Access on.** On the phone, open `https://outreach.<domain>/`:
   - Cloudflare's **Access login page** appears, served from the team domain. It was redesigned 2026-05-12 (one sign-in card, mobile layout, dark mode).
   - Enter the email > **Send login code** > the email arrives from noreply@notify.cloudflare.com > type the PIN > **Sign in** > our app's own sign-in page.
   - An address not in the policy still sees "**A code has been emailed to you**", but no email arrives, by design.
   - A wrong code shows "**That account does not have access.**"
   - Branding is optional: Zero Trust > Reusable components > **Custom pages** > **Access login page** > **Manage** (organisation name, logo, colours) > **Save**.
   - Source: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/, …/access-login-page/, Access changelog 2026-05-12.
4. **Error pages staff may see:**
   - **Error 1033**: the tunnel is not connected. The PC is off or asleep, or the cloudflared service is stopped. The DNS-records doc names this case "1016"; the troubleshooting page says 1033. Expect either.
   - **502 Bad Gateway** "Unable to reach the origin service": the tunnel is fine but Next.js on port 3000 isn't answering.
   - Source: https://developers.cloudflare.com/tunnel/troubleshooting/ and https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
5. **Owner-side checks:**
   - Networking > Tunnels shows **Healthy**.
   - The tunnel's **Live logs** tab (added to the main dashboard 2026-08-10) shows the phone's requests.
   - In Access, the policy tester is at Access controls > Applications > app > **Configure** > **Policies** > **Policy tester**. It only knows users who have logged in at least once.

## Corrections and additions to cloudflare.md

- Menu names are now two sets:
  - Tunnels: main dashboard **Networking > Tunnels**, or Cloudflare One (one.dash.cloudflare.com) **Zero Trust > Networks > Connectors**.
  - Access paths start with **Zero Trust > Access controls**.
  - One-time PIN is under **Zero Trust > Integrations > Identity providers**.
- Access Include rule: the selector is **Emails** (or **Emails ending in**). An "Emails list" means a Zero Trust list used with "in list". The exact builder UI for that is UNVERIFIED.
- `--edge-ip-version` defaults to `auto` since 2026.4.0. The docs saying `4` are out of date.
- Metrics binding confirmed in code (localhost:20241–20245, falling back to a random port). The `/ready` JSON shape is confirmed.
- MSI install path confirmed from the 2026.9.1 MSI itself (32-bit template, ProgramFilesFolder).
- The published-route button is "Add route" in the Tunnels flow and "Save" in the Routes-page flow.
- Tunnel-down error: 1033 on the troubleshooting page, 1016 on the DNS page.
- New risks:
  - #1702 (explicit connectTimeout breaks the origin, open) and #1715 (case-sensitive host matching, open) affect the route settings;
  - #1737 (2026.9.0 QUIC crash, seen only in Docker) is a watch item.
- Free Tunnel Health Alert via Notifications. Recommended.

## Plan implications

- **Owner guide `3-cloudflare`**, in this order:
  1. Domain (Q11 path a, b or c; for c, verify the ICANN email).
  2. Zero Trust onboarding (team name, Free plan, card).
  3. Add One-time PIN.
  4. Policies "Outreach staff" and "Public webhook bypass".
  5. App "Outreach" (empty path, One-time PIN only, Session Duration from Q11).
  6. App "Outreach public endpoints" (`api/webhooks/*` and `api/health`).
  7. winget install, then `service install` from an Admin PowerShell using the full path.
  8. Clear PowerShell history.
  9. Tunnel Healthy.
  10. Route `outreach` to `http://127.0.0.1:3000`, with no additional settings.
  11. Zone settings (obfuscation off, Bot Fight Mode off, Skip rule).
  12. Tunnel Health Alert.
  13. The tests in section 8.
- **Health page and worker:** poll `http://127.0.0.1:{20241..20245}/ready`, identifying cloudflared by `connectorId`. Show connected (readyConnections, where 4 means healthy) or disconnected. Also read `build_info` from `/metrics` and warn on 2026.8.0 or 2026.8.1, and on a version more than 12 months older than the current one. The current one can't be fetched offline, so either compare against a date constant, or skip that check.
- **`update.bat` and README:** give the cloudflared update steps from section 7. Tell the owner never to set Connect timeout or HTTP Host Header on the route. Troubleshooting: 1033/1016 means the PC or tunnel is down; 502 means the app is down; for QUIC/IPv6 problems use `--protocol http2` / `--edge-ip-version 4` via ImagePath (keep `--token-file`).
- **Webhook URLs** must stay strictly under `/api/webhooks/<x>/...`, and never be `/api/webhooks` itself, because of the Access `/*` rule.
