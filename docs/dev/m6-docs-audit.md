# M6 docs audit: the owner-facing documentation before hand-over

Written 2026-09-27 while preparing Milestone 6 ("Finish and go live", PLAN A8 item 6). Nothing else was changed.

**What was read:** SPEC.md (§11–13, "Testing and definition of done", the README list), PLAN.md (A1, A2, A6, A8, A9,
B3, B6.5–B6.7, B6.14, B10, B11), M3-DESIGN §9.3, the M4/M5 "later milestone" rows, README.md, docs/setup/1-install.md,
2-mailgun-and-dns.md, 3-cloudflare.md, every `.bat` file, `scripts/*.mjs|ps1|ts` and the `scripts/lib` helpers
that print text. Labels quoted in the docs were checked against `src/` with literal-string searches. Section 3 lists what
matched and what didn't.

**How to use this file:** section 0 is the short version. Sections 1–4 are the evidence. Section 5 is the proposed
final layout, section 6 is the checklist of places where a non-developer gets stuck, and section 7 lists the open
questions. Write the docs **after** the M6 screens are final (dashboard, Go-live switch, settings polish), because
several labels below change in M6.

---

## 0. The short version (ranked)

1. **Two of SPEC's seven README items are missing or scattered.** *Adding team members* isn't documented anywhere as one
   procedure. *Backups* only cover restore: nothing explains "Back up now", the second folder, the dashboard's 36-hour
   warning, what is kept and for how long, or moving to a new PC. *Keeping the PC awake* is only in the install guide,
   not the README (SPEC asks for it in the README).
2. **"Milestone N" wording is everywhere**, in the docs and on screens: README status and "Installing the Milestone 5
   update", guide 1 §2.5, guide 2's intro and §13/§14/§19/§20 (headings included, so anchors change), the Go-live card
   ("Arrives in Milestone 6"), the Live confirmation ("(Milestone 6)") and the Dashboard placeholder ("Dashboard
   arrives in Milestone 6"). The full list is in §2.6.
3. **There is no go-live guide.** The go-live checklist, the switch, what changes after it, warm-up, the first real
   campaign and the first weeks are undocumented. Guide 2's §19 and §20 are milestone *tests* bolted onto a setup
   guide. They belong in a new `4-going-live.md` (outline in §5.4).
4. **Updating is undocumented.** `update.bat` assumes the new files are already in the folder. No doc says how an update
   arrives or how to copy it in without losing `.env`, `data\` and `backups\` (there is no git). This is an open
   question for the lead (§7, Q-A).
5. **restore.bat labels disagree with the docs and the app.** Guide 1 §9 says the list shows kinds like "Daily
   backup". `scripts/lib/backups.mjs backupKindLabel()` doesn't recognise the background sender's file names
   (`app-YYYY-MM-DD-HHmmss-xxxx.db`), so daily and "Back up now" backups both show as plain **"Backup"**. Settings ›
   Backups calls them "Automatic" / "Manual". Also, backups made by the scripts (`app-preupdate-…`, `app-prerestore-…`,
   `app-premigrate-…`) never appear in Settings › Backups, aren't copied to the second folder and are **never pruned**,
   so they pile up with every update.
6. **The second-folder advice is risky.** The in-app hint suggests `\\office-nas\backups`. The services run as
   password-free virtual accounts (`NT SERVICE\OutreachWorker`), `service-acl.mjs` deliberately skips network shares,
   and such accounts usually can't write to a NAS in a workgroup. The hint also says "run install-services.bat again
   afterwards", which no doc mentions. Recommend a USB drive, a second disk or a OneDrive folder, and say to re-run
   install-services.bat.
7. **The builder's voice is still in the docs.** "until I say so", "When I send you an update", "Tell me…" (guide 1 §1,
   §9; guide 2 §13, §19). After hand-over there is no "me", so these need a named contact or plain instructions.
8. **The question numbers (Q1, Q8, Q10, Q11) mean nothing outside PLAN.md**, and PLAN Part A is now build history. Its
   A1 cost table even says Foundation *includes* 5,000 address checks, while README and guide 2 correctly say it
   includes none.
9. **Duplication:** the scripts table, "Where things are", "What happens when the PC is off", the restore procedure,
   the address-check costs and the "Paused: …" troubleshooting each exist in two or three places (§4). Pick one home
   for each.
10. **Node.js:** nodejs.org's "LTS" button is expected to switch to Node 26 in late October 2026, around go-live
    (verify the date). The app refuses Node 26. The docs must say how to get 24.x (the direct link or "Previous
    releases"), not just "download 24.21.0".
11. **`.env` on this PC has extra lines** (`MAILGUN_APIKEY`, `MAILGUN_SANDBOX`, `MAILGUN_ENDPOINT`). Nothing in the app
    reads them (checked with a search). The docs tell the owner to copy `.env` to a USB stick or password manager, so a
    plain-text Mailgun key in it travels too. The go-live guide should say the key belongs in Settings › Sending &
    Mailgun and these lines should be deleted. Values were not read into this audit.
12. **Most labels match the code** (about 170 checked, §3). The mismatches that aren't milestone texts are few: restore
    kinds, one quoted DNS message, and "Settings > …" versus "Settings › …" in restore.bat.

---

## 1. SPEC README requirements: coverage today

| # | SPEC "README … covering" | Where it is today | Verdict |
|---|---|---|---|
| 1 | installing and the first run | 1-install §1–8; README "First steps" summary | **Covered.** Add stuck points (§6) and the Node 26 warning |
| 2 | Mailgun domain and DNS (SPF, DKIM, DMARC, MX) and the inbound routes | 2-mailgun §4–8, §15 | **Covered** |
| 3 | turning off open/click tracking, turning on unsubscribe handling | 2-mailgun §11 (automatic, with a manual fallback) | **Covered** |
| 4 | Cloudflare Tunnel, with *optional* Access | 3-cloudflare (all of it) | **Partly.** Access is written as compulsory, and the go-live row "Remote access works" requires it (`mode-gates.ts GO_LIVE_ROW_KEYS` + the remote-access row). SPEC says optional; M3-DESIGN §9.3 says to turn it into a warning if the owner declines. Needs a decision (§7 Q-B) and a sentence in the guide |
| 5 | adding team members | nowhere as a procedure (A9 says "Settings › Team"; 2-mailgun §12 covers sending addresses; 3-cloudflare §4 covers staff emails) | **Missing** |
| 6 | keeping the PC awake in sending hours (European hours = afternoon/evening PKT) | 1-install §6–7; setup-pc.bat | **Covered in the guide, missing from the README.** Q12 (US/Australia hours, 24/7?) is still open. Nothing says the power settings only apply **plugged in** (on battery the laptop still sleeps) |
| 7 | backups and restoring from one | README "Restoring a backup"; 1-install §9, §11; the Settings › Backups page | **Partly.** Restore only. Missing: Back up now, second folder, 36-hour warning, keep-14 against script backups kept forever, a practice restore, `.env` plus a backup onto a new PC |

PLAN items also promised to the README: B11's firewall sentence and "Node only from nodejs.org" (they're in 1-install
§10 and §1, not the README); B11 "antivirus troubleshooting in the README" (it's in 1-install §12); A9 item 5 "second
backup folder (OneDrive or USB) + a copy of `.env`" (only the `.env` half is documented). B3 planned
`docs/setup/4-reply-routes`, `5-backups-restore` and `troubleshooting`, which were never written. Reply routes went into
guide 2 §15. Backups and troubleshooting still need a home (§5).

---

## 2. Findings per document

### 2.1 README.md

**Wrong or outdated**
- Line 5: "Status: Milestone 5 of 6 …", a milestone-by-milestone history. Replace it with what the app does.
- Line 5: "Until you go live (Milestone 6), real email only reaches…". Line 62: "Sending live … (after go-live,
  Milestone 6)".
- Line 7: "Installing the Milestone 5 update: …". Remove.
- "docs\setup\ | The guides: install, Mailgun and DNS, Cloudflare". Add the go-live guide.
- "backups\ | … daily ones … (the last 14 are kept)". True only for the sender's backups. Pre-update, pre-restore and
  pre-upgrade backups are kept until deleted by hand (see 0.5).
- "For developers": M3/M4/M5 design pointers and "from Milestone 5 it also answers address checks". This is developer
  history in the owner's entry document. Move it to `docs/dev/` (keep one pointer line).

**Missing**
- A "start here" order that covers the whole journey: guides 1 → 2 → 3 → 4, with time and waiting estimates, and the
  accounts or cards needed up front (Mailgun Foundation, Cloudflare with a card for Access, an Anthropic account with
  credit, a domain).
- Everyday use: the **dashboard** (M6), what "needs attention" means, the daily routine (read the dashboard, answer
  replies in your inbox, click **Answered**, review AI lines, launch campaigns).
- **Your team** (SPEC item 5): Settings › Team › **Invite a teammate** › **Create invite link**. The link works once for
  **72 h**; there's an office link and a "works anywhere" link (`access-link-display.tsx`). Remote staff must also be
  added to Cloudflare's **Outreach staff** policy (guide 3 §4). Each person sets **Sending address**, **Reply inbox**,
  signature and time zone in Settings › My profile, and gets "Reply route: working". Also: **Switch off**, **Switch back
  on**, **Make Owner** (exactly one Owner), **Reset password link** (not for yourself, so the Owner uses
  reset-password.bat), and per-sender limits (Settings › Limits & warm-up › Per-sender limits).
- Sending safely: sending hours, the daily limit and warm-up (numbers from PLAN A5.13 / B6.6), the health auto-pause and
  its thresholds, **Pause all sending**, the test list and what go-live changes. The top-bar table exists; the rest
  doesn't.
- **Keeping the PC awake** (SPEC item 6) as a short section pointing to setup-pc.bat and active hours.
- **Backups** as a full section: automatic daily (kept 14, `Settings › Backups`), **Back up now** (anyone), **Second
  copy** (Owner; re-run install-services.bat afterwards), the 36-hour warning (Settings › Backups today; the dashboard
  in M6), restore, undoing a restore ("Before a restore"), a practice restore before go-live, moving to a new PC.
- **Updating:** how an update arrives (§7 Q-A), update.bat, Node.js updates (24.x only; stop.bat first; update.bat
  after), cloudflared monthly updates, Windows Update active hours.
- **What it costs** each month: Mailgun Foundation about $35; address checks about $0.012 each, since Foundation includes
  none; domain(s); Cloudflare $0; Claude about $1.69 per 300 lines; the app's own limits ($100 checks, $20 AI).
  PLAN A1 is wrong on checks, so the README should be the reference.
- **Troubleshooting index:** symptom → where the answer lives (guide 1 §12, guide 2 §18, guide 3 §16, plus the §6 list).
- How to read these files: a `.md` opened in Notepad shows raw markup and the links can't be clicked (§7 Q-D).

**Unclear for a non-developer**
- The long "Address checks", "AI personal lines" and "Missing emails" sections come before anything about daily use or
  safety, and are dense (budget rules like "never spends more than 125 % of its 'at most', except …"). Move the detail
  into the go-live guide or an "Everyday use" subsection, and keep the README scannable.
- "The top-bar label" section is good. Keep it, and add the M6 meaning of **Sending live** and **Test list only** after
  go-live (M3-DESIGN §9.3 leaves "the label for TEST after go-live" open).

**Duplicated** (see §4): the scripts table (also 1-install §9), "Where things are" (also 1-install §11), "What
happens when the PC is off" (also guide 2 §17, near word-for-word), restore (also 1-install §9 and Settings ›
Backups), address-check costs (also guide 2 §20).

### 2.2 docs/setup/1-install.md

**Wrong or outdated**
- §1: "version 24.21.0 (LTS)". From late October 2026 the "LTS" button on nodejs.org is expected to download Node 26,
  which `node-check.mjs` refuses ("the app needs Node.js 24"). Give the direct 24.x installer path and say that any
  24.x from 24.18 works (`MIN_NODE = 24.18.0`). The PC runs 24.18 today, and setup warns that 24.21.0 is recommended.
- §1: "don't accept it until I say so". The builder's voice.
- §2 item 5: "You need it from Milestone 3 on". Remove the milestone.
- §9 restore: "It lists the backups … with their date and kind ("Before an update", "Daily backup"…)". Daily backups
  actually show as "Backup" (0.5). Fix the script, or the doc.
- §9 table: `update.bat` "When I send you an update". Builder's voice, and it doesn't say how the update gets into the
  folder.
- §5: "change only its data, backups, logs, run and .next folders (and a second backup folder on this PC, if you set
  one)". Correct, but it needs the step: after setting the second folder, run install-services.bat again (the app's
  hint says so; the guide doesn't).
- §11 / §12 name `logs\web.log` and `logs\worker.log`. That's true with the services. In start.bat mode the files are
  `logs\web-YYYY-MM-DD.log`, `logs\worker-…`, `logs\start-…` (`supervisor.mjs DailyLog`), and the practice copy writes
  `logs\demo-*`. Say "the newest file in `logs\`", as the scripts do.

**Missing**
- UAC: the permission prompt names **Windows Command Processor**, verified publisher Microsoft Windows. The first window
  closes and a second one opens (the `.bat` files re-launch themselves elevated). A non-developer may think it failed.
- Delayed start after a restart: the services are "Automatic (Delayed Start)", so they come up about 1–2 minutes after
  Windows starts. The guide says to wait two minutes but not why.
- On battery the PC still sleeps (setup-pc changes the plugged-in settings only).
- What to do after installing Node.js: stop.bat first, install, then update.bat; if Node moved to another folder, run
  install-services.bat again, because the services store node.exe's full path (`install-services.ps1 Get-NodePath`).
- Forgot password: the Owner can also make links for Members in Settings › Team › **Reset password link**. The Owner
  can't make one for themselves there, so remotely they need someone at the PC to run reset-password.bat. After 5 wrong
  tries a person waits a minute (PLAN B10), and the Owner is notified.
- Don't put the app folder in OneDrive or Dropbox, and don't move it (there's a troubleshooting line for "moved", not
  for "synced").
- Keeping `.env` safe is covered, but **backups plus `.env` onto a new PC** (disaster recovery) is not.

**Unclear**
- §12's NSSM re-download uses `Get-FileHash … | Set-Content` in PowerShell. It's fine as a last resort, but label it
  "only if asked", and put the winget path second.
- §9 packs a long restore paragraph (two Mailgun checks, 35 minutes, Resume confirmation) into a table-adjacent note.
  Move it to the README's backups section with a short "what you'll see" list.

**Duplicated:** §9's scripts table and restore procedure, and §11 "Where your data lives", all appear in the README
too. Keep them here and link to them from the README, or the other way round, but only in one place.

### 2.3 docs/setup/2-mailgun-and-dns.md

**Wrong or outdated**
- Intro: "(step 19) test follow-ups and replies, and (step 20) set up address checks and AI personal lines". This is
  milestone structure.
- §1 and elsewhere: "(Q8)", "(Q10)", "(Q1)". These are PLAN question numbers.
- §13: "Until you go live (Milestone 6)". The confirmation it quotes ("… Switch to live?") comes from
  `components/settings/sending/texts.ts:43`, which itself says "(Milestone 6)". Both change in M6.
- §13 "If it fails": "Tell me, and send the answers you gave". §19: "Tell me which automatic-reply text you used", "tell
  me, and send the follow-up's original". Builder's voice.
- §14 "Next: … step 19"; §19 heading "Test follow-ups and replies (Milestone 4)" (the anchor
  `#19-test-follow-ups-and-replies-milestone-4` breaks when the heading changes); "Replies from before the Milestone 4
  update are listed there once as well; … 'Older replies were found'" (one-off upgrade history); "Before you go live
  (Milestone 6), replies from your test mailboxes don't change …".
- §20 heading "(Milestone 5)", "From Milestone 5 the app can…", "**The Milestone 5 test.**"
- §18: the quoted DNS message "These are Mailgun's US servers; your domain is in the EU." The app actually says
  "These are Mailgun's mail servers for the other region (…); your domain is in the EU region."
  (`core/dns/checklist.ts:553`).

**Missing**
- After go-live, §13's mode names and the label change ("Live (test list only)" becomes whatever M6 calls it). Settle
  the wording once the switch exists.
- Where the Mailgun key goes, and that it doesn't go in `.env` (see 0.11).
- Warm-up and the domain-age advice are one paragraph in §16. They belong in the go-live guide with the numbers.

**Unclear**
- "Setup A / Setup B / Setup C" in §13 is internal jargon. Say "the normal setup" or "the check-only setup" and keep the
  letters in brackets, since the screen shows them.
- §19 step 0 (practice copy dry-run helpers) is a long paragraph inside a numbered list.

**Duplicated:** §17 "What happens when the PC is off" is the README's section again. §20's cost paragraph matches the
README's. §18 "Paused: …" overlaps 1-install §12.

**Proposed change:** keep §1–18 as the Mailgun/DNS setup guide. Keep only the setup parts of §20 here (turning on
Validations, "Test address checks", the Anthropic key and Console spend limit), or move them to guide 4's "Before you
start". Move §19 and §20's tests to guide 4 as "rehearsal before going live".

### 2.4 docs/setup/3-cloudflare.md

**Wrong or outdated**
- "Before you start": "(Q11)" twice.
- Nothing else is outdated. Labels match the app (Settings › System › Remote access card: "Remote access works",
  "Only your team gets past Cloudflare's login", **Check now**; checklist texts naming "Cloudflare guide, step 5" and
  "step 6").

**Missing**
- Access is optional (SPEC). Add a box saying what happens if it's skipped: today the go-live row requires it (§7
  Q-B).
- Adding or removing a staff member: step 4's policy is the only place. Cross-link it from the README's "Your team".
- §13: if the services are installed, update.bat is needed after setup.bat. This is present, but the app's own texts
  only say "run setup.bat again" (see §2.6).

**Unclear:** the registry edit in §16 (ImagePath `--protocol http2`) is risky for a non-developer. Mark it "only if the
tunnel keeps showing Degraded, or ask for help".

**Keep the step numbers stable.** App texts cite them: guide 3 steps 5 and 6 (`remote-access-card.tsx:75,84`,
`core/dns/checklist.ts:989,1006`), guide 3 step 7 (`scripts/status.ps1`), guide 2 step 9 (`core/dns/checklist.ts:911,914`)
and step 7 (a code comment). Renumbering means editing those strings too.

### 2.5 The scripts' on-screen texts (.bat, scripts/*.mjs, *.ps1)

Mostly good: plain words, the next step always named, `[ok]` / `[!]` / `[x]` markers, "Press any key to close". Issues:

| Where | Text or behaviour | Problem | Suggestion |
|---|---|---|---|
| `scripts/lib/backups.mjs backupKindLabel` → restore.bat list | Worker backups (`app-2026-09-27-221405-k3x9.db`) → "Backup" | The docs promise "Daily backup". The app says "Automatic" / "Manual" | Recognise the worker pattern ("Daily or Back up now"), or read the kind from the `Backup` rows. Use one vocabulary in the app, restore.bat and the docs |
| `restore.mjs` final box | "in Settings > Sending & Mailgun" | Docs and app use "›" | Use "›" (the console is UTF-8, `chcp 65001`) or keep ">" everywhere in scripts, and say which in CONVENTIONS |
| `setup.mjs`, `update.mjs`, `install-services.ps1`, `ops-common.ps1` | "see docs\setup\1-install.md, Troubleshooting" | Fine, but it pins the section name | Keep a "Troubleshooting" heading in guide 1 |
| `status.ps1` | "Follow docs\setup\3-cloudflare.md, step 7." | Pins step 7 | Keep guide 3 numbering |
| `status.ps1` | No backup line | The M6 "old-backup warning" only exists in the app | Optional: "Newest backup: 27 Sep 22:14 (7 hours ago)" in status.bat, so a restore rehearsal and a "services down" day can be checked from the PC |
| `service-control.mjs`, `supervisor.mjs` | "Remote staff (https): not set up yet (see docs\setup\3-cloudflare.md)" | Fine | — |
| `update.mjs` success | "It runs in the new start.bat window. Keep that window open." | Fine | — |
| `setup.bat`, `start.bat`, … `:nonode` | "download Node.js 24.21.0 - the Windows installer" | The Node 26 LTS switch (0.10) | Add "(not 26)" and the address of the 24.x downloads |
| `setup-pc.ps1` step 6 | Active hours 8:00 AM to 2:00 AM, fallback 6:00 AM to 12:00 AM | Consistent with guide 1 §7 | — |
| `reset-password.ts` | "The app must be running (start.bat) for the link to open." | With the services it's always running, so "start.bat" reads oddly | "The app must be running (status.bat shows it)" |
| `update.mjs` / guide | Script backups aren't pruned (0.5) | Disk use grows | Either prune `app-pre*` older than N, or document "delete old app-preupdate files now and then" |

### 2.6 In-app texts the docs depend on (change them together with the docs in M6)

These aren't doc files, but the docs quote them. They are all placeholder or milestone texts:

| File | Text |
|---|---|
| `src/app/(app)/dashboard/page.tsx:10-14` | `ComingLater` → "Dashboard arrives in Milestone 6" plus "Until then, start on Contacts." |
| `src/app/(app)/page.tsx:4-7` | Home redirects to /contacts "until the dashboard arrives". Home becomes the dashboard in M6. `components/contacts/get-started.tsx:65` has the same note |
| `src/components/page-header.tsx:57-85` | `ComingLater` itself ("… arrives in Milestone N"). Delete it once the Dashboard no longer uses it (M5-DESIGN §2 row: "ComingLater stays (Dashboard, M6)") |
| `src/app/(app)/settings/sending/page.tsx:98` | Go live card: "Arrives in Milestone 6. Until then, real email only reaches your test list." |
| `src/app/(app)/settings/sending/page.tsx:120` | "Everything going live needs is in place. The switch arrives in Milestone 6." |
| `src/components/settings/sending/texts.ts:43` | Live confirmation: "… Everyone else is left out until you go live (Milestone 6). Switch to live?" |
| `src/app/(app)/settings/backups/second-folder-form.tsx:11-12`, `server/services/backups.ts:540,553` | Suggests a network share (`\\office-nas\backups`). See 0.6 |
| `src/app/(app)/settings/system/page.tsx:100` | "To change it, run setup.bat again." Incomplete: with the services it's setup.bat, then update.bat, then **Apply recommended settings** (guide 3 §"Changing the public address later") |
| `core/mailgun/routes.ts:142`, `core/dns/checklist.ts:802,935`, `access-link-display.tsx:8`, `settings/sending/page.tsx:158` | "… then run setup.bat again". Same gap: add "(and update.bat if the app runs as a service)", or have setup.bat's message carry it, which it already does |
| Wording still to settle in M6 (M3-DESIGN §9.3, M4-DESIGN row 133) | The top-bar label for a TEST campaign after go-live; the "(test list)" suffix and "sent to your test list before going live" (`components/campaigns/format.ts:831`); whether test-list LIVE sends before go-live count as "emailed" afterwards |

Messages like "Not on the test list (until you go live, …)" (`core/rules/eligibility.ts:337`, `sending/loop.ts:502`) stay
correct after M6.

### 2.7 PLAN.md Part A (owner-facing, but now history)

PLAN says "Part A … is written for you; please read all of it". Once the README is final, PLAN is build history. Add a
line at the top of PLAN (in M6, not now) saying "Build plan, kept for reference; the README is the manual". Known stale
points:
- A1: the cost table's "5,000 address checks/month included" (M5 found Foundation includes none).
- A2: "You'll get full step-by-step guides … with Milestone 3".
- A9: "press Enter to skip until Milestone 3".
- B3: guides `4-reply-routes`, `5-backups-restore`, `troubleshooting` were never written.

---

## 3. Label check: doc wording against the source

**Matched (literal string found in `src/`):** Save and connect · Domain sending key (optional) · Your Mailgun plan keeps
event logs for … days and stored replies for … · Check again · Checked just now · Apply recommended settings · Still
spreading · Couldn't check right now · The public address answers · Open tracking is off · Mailgun's unsubscribe
handling is on · Suspicious replies are marked · Mailgun keeps stored replies for · Webhook signing key saved · Reply
routes are set up for · Secure unsubscribe links are ready · The certificate for secure unsubscribe links is ready ·
Unsubscribe links use https/http · Nobody has a sending address yet · Connected to … key ending · Add a test mailbox ·
Add address · Live (test list only) · Save mode · Switch to live · Send test emails to my test list · Paste the email's
original headers here, and the app reads them for you · Read the headers · Unsubscribe reached the app · Save the result
· Try Setup B (check only) · Back to Setup A · Setup A passed · Setup … didn't pass · New list · Create list · Add company
(dialog "Add a company": Company name, Country, Add to list, First person › Email) · Email these companies · Launch
campaign · Send me a test · Dry-run outbox · Simulate · Unclear reply · Out-of-office · "In a dry run this only changes
this campaign" · Ignore sending hours · Treat follow-up days as minutes · Dry-run helpers · Cancel campaign · Stopped:
they replied · Waiting for follow-up · Waiting for sending hours · Waiting for the check with Mailgun · Automatic reply
from · Follow-ups are on hold · I've checked my inbox · Replies waiting for an answer · Answered · No answer needed ·
Real reply · It was an auto-reply · Older replies were found · Check with Mailgun now · Resume sending · Pause all
sending · restored from a backup · this database was copied or moved · last ran on another computer · the database file
was replaced · Test list only · Sending live · Dry run · Stopped by the test-list guard · Mailgun asked us to slow down ·
Mailgun didn't answer in time · The app can't check with Mailgun · is proxied (orange cloud) · SPF records; mail
servers ignore all of them · Other mail servers are also listed · Mailgun won't forward replies to · Another Mailgun
route catches · When did you buy · Domain age · Gmail dashboard · Monthly safety limit · Replies reach each sender ·
Mailgun knows your domain · Unsubscribe links are secure (HTTPS) · Reply test · Before you start · Sending address ·
Reply inbox · Reply route: Being set up… / working · is kept for mail servers · replies would go round in circles · Test
address checks · Checked in … · Checks included in your plan each month · Address check key · Address checks (card) ·
Resume checks · Address checks paused/stopped · Mailgun refused address checks for a billing or plan reason · won't run
address checks on this account right now · Anthropic API key · Save key · "Key saved. It works with …" · AI drafting
paused · Resume drafting · Check emails · Check N addresses · Cost: about … · Address checks finished · Draft personal
lines · Draft N lines · Draft with AI · AI lines ready to review · Edit then approve · Regenerate · Write one yourself ·
Open the page · AI, approved by · Export for Claude · This file has a company_id column · isn't a company ID like · Add N
people · Ignore this column · Check these again too · Did you mean · Mark unsubscribed · Remove it · Waiting for re-check
· Left out: address couldn't be checked · Remote access works · Only your team gets past Cloudflare's login · Check now ·
Remote access is down · has a known problem · Setup code / Your name / Your email / Password / Password again · Back up
now · Second folder · Save folder · Stop copying · "The last backup is more than 36 hours old" · Settings nav: My
profile, Notifications, Backups, Sending & Mailgun, Domain checklist, Limits & warm-up, Deliverability, Email footer,
AI, Team, System.

**Mismatches**

| Doc | Doc says | App or script says |
|---|---|---|
| 1-install §9 | restore.bat shows kinds "Daily backup"… | restore.bat: "Backup" for daily and manual (0.5); Settings › Backups: "Automatic", "Manual" |
| 2-mailgun §18 | "These are Mailgun's US servers; your domain is in the EU." | "These are Mailgun's mail servers for the other region (…); your domain is in the EU region." |
| 2-mailgun §13 | Confirmation text quoted without "(Milestone 6)" | `texts.ts:43` includes "(Milestone 6)" (changes in M6 anyway) |
| README, guides | "Settings › Sending & Mailgun" | restore.bat prints "Settings > Sending & Mailgun" |
| Get started card | "Invite your team: Create invite links for your teammates." | Team page button "Invite a teammate", dialog button "Create invite link". Consistent enough, but the README should use the button names |

Not checkable in code (third-party screens, correctly marked "(it may be called …)"): every Mailgun, Cloudflare,
Anthropic Console, Gmail and Outlook.com label.

---

## 4. Duplication map: one home per topic

| Topic | Now in | Single home (proposal) | Others become |
|---|---|---|---|
| Double-click scripts table | README, 1-install §9 | README "The double-click scripts" | 1-install links to it |
| Where things live | README, 1-install §11 | README | link |
| Restore procedure | README, 1-install §9, Settings › Backups card | README "Backups and restore" (full) | 1-install: one line + link. The in-app card stays (short, consistent wording) |
| What happens when the PC is off | README, 2-mailgun §17 (plus PLAN A4.3) | README | 2-mailgun: one line + link |
| Address-check costs and plans | README, 2-mailgun §20 (PLAN A1 wrong) | README "What it costs" | link |
| "Paused: …" causes | 1-install §12, 2-mailgun §18 | 2-mailgun §18 (Mailgun causes); 1-install keeps restore/copy/move causes | cross-links |
| Firewall question | 1-install §10, setup-pc.ps1 summary | 1-install §10 | README troubleshooting index links |
| Node.js version rules | 1-install §1, §12; every `.bat` | 1-install §1 | — |
| Keeping the PC awake | 1-install §6–7, setup-pc.ps1 | 1-install §6–7 | README: 3-line summary + link (SPEC wants it in the README) |

---

## 5. Proposed final structure

### 5.1 README.md: the entry point (the owner's manual)

1. **Polygon Paradise Outreach**: what it is (three background programs, one data file, the practice copy), in about
   8 lines.
2. **Start here**: a checklist with ticks, in order: guide 1 (30 min), guide 2 (about 1 hour over 1–2 days), guide 3
   (45 min plus up to 24 h waiting), guide 4 (going live). What to have ready: a domain for sending, maybe one for the
   app, a Mailgun Foundation account with business verification, a Cloudflare account and card, an Anthropic account
   with credit, 2–3 test mailboxes.
3. **Everyday use**: dashboard first; Contacts, lists, statuses; starting a campaign (the six steps in one line each);
   replies (the app can't see your inbox, click **Answered**); notifications; AI lines; address checks; missing emails
   with Claude; the top-bar label table (with the M6 meanings).
4. **Your team**: invite (72 h link, office or anywhere link), Cloudflare staff list, profile (sending address, reply
   inbox, signature, time zone), roles, switch off, make Owner, reset passwords, per-sender limits.
5. **Sending safely**: sending hours, daily limit and warm-up, health auto-pause and Resume, Pause all sending, the
   30-day rule. One paragraph each; details in guide 4.
6. **When the PC is off, and keeping it awake**: the current "PC is off" section plus a summary of setup-pc and
   active hours.
7. **Backups and restore**: automatic, Back up now, second copy, the 36-hour warning, what's kept, restore, undo, a
   practice restore, moving to a new PC (`.env` + newest backup + guide 1 + restore.bat).
8. **Updating**: getting the new version into the folder (§7 Q-A), update.bat, Node.js, cloudflared, Windows Update.
9. **The double-click scripts** (single table).
10. **Troubleshooting**: a symptom index linking to the guides plus the §6 items not covered elsewhere.
11. **What it costs** (single, correct table).
12. **Where things live**: `data\app.db`, `.env`, `backups\` (and `backups\practice\` or `backups\demo\`), the second
    folder, `logs\` (by mode), `run\` ("the scripts' working files; don't touch"), `tools\`, `docs\setup\`.
13. One line: "For developers: see `docs/dev/README.md`". Create that file from today's "For developers" section.

### 5.2 Guides 1–3

- **1-install.md**: keep §1–8, §10 and §12. Add the §6 stuck points: UAC, SmartScreen or unblock, delayed start,
  battery, Node 26, folder not in OneDrive, `.env` + backup for a new PC. Replace §9 and §11 with links to the README.
  Remove "Milestone 3" and "I". Fix the restore kind wording.
- **2-mailgun-and-dns.md**: §1–18 only. Remove the Q-numbers, milestone texts and "tell me". Rename the Setup
  A/B jargon. Fix the §18 quote. Move §19 and §20's tests to guide 4. Keep §20's *setup* here as "§19 Address checks
  and the Anthropic key" (Validations on, test one check, Anthropic key and Console limit), or put it in guide 4
  "Before you start"; either works, but only one.
- **3-cloudflare.md**: remove Q11. Add the "Access is recommended; if you skip it…" box once §7 Q-B is decided. Add a
  "Staff joining or leaving" pointer. Keep the step numbers (§2.4).

### 5.3 What stays in the app

Settings › Backups' "How to restore a backup" card, the checklist rows' fix texts and the pause cards are the in-app
help. Their wording must match the README (restore kinds, "›", no milestones).

### 5.4 New docs/setup/4-going-live.md: the go-live checklist

Write it against the finished M6 screens. Proposed outline:

1. **Before you start** (days ahead): the sending domain is at least 30 days old (**Domain age** row); Mailgun business
   verification approved; the Foundation plan and the monthly safety limit set (guide 2 §9); Validations switched on
   for address checks; the Anthropic key saved (optional); `.env` lines that don't belong removed (0.11).
2. **The Domain checklist is all green.** List the rows `goLiveBlockers()` requires (`GO_LIVE_ROW_KEYS`), in the
   screen's words: Mailgun knows your domain · SPF · DKIM · MX · Unsubscribe links work · Unsubscribe links are secure
   (HTTPS) · DMARC · Open and click tracking are off · Unsubscribe handling is on · Spam filter marks, never deletes ·
   Stored replies are kept · Webhook signing key saved · Mailgun tells the app what happened · Replies reach each sender
   · Mailgun lets you send · Remote access works. Also: the reply test passed, sending not paused, every sender has a
   working reply route. The Go-live card lists whatever is missing under "Before going live:".
3. **Rehearsal with your test mailboxes** (today's guide 2 §14, §19, §20 tests): a live test campaign, a reply that
   stops follow-ups, an out-of-office that doesn't, the thread check, one address check, 20 AI lines, the Claude round
   trip.
4. **The PC**: services installed, setup-pc done, active hours set, **restart test** (PLAN A8 M6 "a PC restart"),
   status.bat all green.
5. **Backups**: Back up now; second copy set (then install-services.bat); `.env` stored off the PC; a **practice
   restore** (A8 "a backup and a restore"). Do it before going live, and include what the restore report looks like and
   Resume.
6. **Settings to check once**: the Email footer (company name, address), portfolio URL, sending hours, daily maximum
   (1,000) and per-sender limits, health thresholds, the 30-day rule length, check rules and limit, the AI limit and
   model, everyone's profile and signature.
7. **Tidy the test data**: what to do with the "Test mailboxes" list and companies and the test list after go-live
   (decision in M6, §7 Q-E).
8. **Switch on Go live**: where it is, the confirmation text, what changes (label **Sending live**, the test-list guard
   off, **new** campaigns in Live mode reach everyone eligible; campaigns keep their launch mode), and whether it can be
   switched off again (M6 decides; document it).
9. **Warm-up starts**: day 1 limit 50; the steps (50, 59, 69, … 1,000); it rises after a weekday on which at least half
   of the limit was used, and only while bounces and complaints are low; about 4 weeks to 1,000; where to see "day N of
   20, tomorrow's limit …" (dashboard, Limits & warm-up); overriding with confirmation.
10. **The first real campaign together** (A8): a small list of 20–30 checked addresses; Verify, Review, Schedule; what
    to watch on the dashboard the next day.
11. **The first weeks**: a daily 5 minutes (dashboard attention list, replies, AI lines); weekly (the backup age, Domain
    checklist green, status.bat); monthly (cloudflared update, Node 24.x security update via update.bat, Mailgun and
    Anthropic invoices against the app's limits).
12. **If something goes wrong**: auto-pause (what the numbers mean, fix the list, Resume); Pause all sending; a
    complaint; the tunnel down; the PC off for more than 5 days (outage hold).

---

## 6. Where a non-developer gets stuck: checklist for the final docs

Legend: ✅ documented well · ◐ partly · ❌ missing. "Add to" = where the final text should live.

| # | Situation | What the owner sees | Today | Add to |
|---|---|---|---|---|
| 1 | Windows SmartScreen or the Attachment Manager when files came from a download or zip | "Windows protected your PC" (More info › Run anyway) or "Open File – Security Warning" on a `.bat` | ❌ (not an issue on today's PC, where files were made locally; it becomes one if updates arrive as a zip) | 1-install troubleshooting + the update section: "right-click the zip › Properties › **Unblock** before extracting" |
| 2 | Running from inside a zip | Scripts fail or can't find files | ❌ | Update section: "Extract all first" |
| 3 | UAC prompt | "Do you want to allow this app to make changes?", **Windows Command Processor**; the first window closes | ◐ ("click Yes") | 1-install §5 |
| 4 | Smart App Control | Blocks unsigned `tools\nssm.exe` | ❌ (Off on this PC per `research/windows-ops.md:29,73`) | 1-install troubleshooting, one line |
| 5 | Firewall prompt for Node.js | "Windows Defender Firewall has blocked some features…" | ✅ 1-install §10, setup-pc summary | README troubleshooting index |
| 6 | Antivirus quarantines nssm.exe or a native part | install-services fails; "A part of the app (better-sqlite3) doesn't work" | ✅ 1-install §12 | index |
| 7 | Node.js "LTS" becomes 26 (late Oct 2026) | setup/update: "This PC has Node.js 26…, but the app needs Node.js 24" | ◐ (the rule is there; how to download 24.x isn't) | 1-install §1 + `.bat` texts |
| 8 | Node updated while the services run | The installer wants to close node.exe; after that "Node was updated: run update.bat" | ◐ | 1-install: stop.bat → install → update.bat; install-services.bat again if Node's folder changed |
| 9 | Port 3000 in use | "Port 3000 is already in use…" | ✅ 1-install §12 | — |
| 10 | Services don't start | install-services shows the log's last lines; status.bat says stopped | ✅ §12 (add "update unfinished" and "Controlled folder access" in one list) | — |
| 11 | Services not up yet after a restart | Office link fails for about 1–2 minutes | ◐ ("wait two minutes") | Explain the delayed start |
| 12 | Forgot password (Member) | Sign-in fails; "Too many tries. Wait N seconds" | ◐ (reset-password.bat only) | README "Your team": the Owner's Settings › Team › **Reset password link** |
| 13 | Forgot password (Owner, remote) | No in-app way | ❌ | README: someone at the PC runs reset-password.bat, which shows office and public links |
| 14 | Invite link expired or used | The link page refuses | ❌ | README: **New invite link** (72 h) |
| 15 | Lost the setup code | — | ✅ §12 | — |
| 16 | PC restarted (Windows Update) during sending hours | Emails wait; "Waiting for the check with Mailgun" | ◐ | README "PC off" section + active hours |
| 17 | Laptop on battery or lid closed on battery | Sleeps, so nothing is sent and remote access is down | ❌ | README/1-install §6: plugged in only |
| 18 | Office address changed (router restart) | Office staff can't open the saved link | ✅ §4 (DHCP reservation) | — |
| 19 | Network marked Public | Office can't reach the app | ✅ | — |
| 20 | "Not secure" in the browser on the office address; no pop-ups or Copy buttons | — | ✅ §4 | index |
| 21 | Tunnel down, error 1033, 502 | Remote staff and Mailgun can't reach the app | ✅ guide 3 §16 | index |
| 22 | Access code email not arriving or already used | — | ✅ guide 3 §16 | — |
| 23 | update.bat failed half-way | start.bat refuses; the services don't auto-start | ✅ §12 | Update section |
| 24 | How to get the new version into the folder | — | ❌ | §7 Q-A |
| 25 | Practice copy open blocks setup/update | "The practice copy … is open" | ✅ §12 | — |
| 26 | "Paused: …" | Red label; card in Settings › Sending & Mailgun | ✅ | — |
| 27 | Folder moved, copied or synced (OneDrive) | "Paused: this database was copied or moved"; sync conflicts | ◐ (moved/copied ✅, synced ❌) | 1-install "Before you start" |
| 28 | Disk full | "The backup failed … free disk space" notification | ❌ (only in the notification) | README backups |
| 29 | Second folder unplugged or unreachable | "Couldn't copy the backup to the second folder" | ❌ | README backups |
| 30 | PC clock wrong | "The office PC's clock looks wrong" | ❌ | README troubleshooting: "Set time automatically" |
| 31 | `.env` lost or the encryption key replaced | Keys must be typed again; setup "Safety stop" | ◐ | README backups / new PC |
| 32 | New PC or disk failure | — | ❌ | README "Moving to a new PC" |
| 33 | README opened in Notepad | Raw markdown, links can't be clicked | ❌ | §7 Q-D |
| 34 | Mailgun or Cloudflare screens renamed | — | ✅ "(it may be called …)" | — |
| 35 | Browser shows nothing right after start.bat's first run | Building for minutes | ✅ (start.bat says so) | — |

---

## 7. Open questions (for the lead, then the owner)

- **Q-A: How are updates delivered after hand-over?** No git, no installer. Options: (a) a zip of the new version,
  extracted over the folder, with a stated list of what must never be overwritten (`.env`, `data\`, `backups\`,
  `logs\`, `run\`, `tools\nssm.*`), then update.bat; (b) an `update.bat <zip>` that does the copy itself; (c) git. The
  README's "Updating" section depends on this. SmartScreen and Unblock (§6 #1) apply to (a) and (b).
- **Q-B: Is Cloudflare Access optional (SPEC) or required (current go-live gate)?** M3-DESIGN §9.3 suggests a warning
  instead of a blocker if the owner declines. Q11 is still unanswered, so the default is Access = yes.
- **Q-C: Whose name replaces the builder's "I" and "tell me"?** For example "your developer" or a named contact.
- **Q-D: How will the owner read the docs?** `.md` files in Notepad show raw markup. Options: accept it (Windows 11
  Notepad may format Markdown, depending on the version; unverified); ship HTML copies; or add a Help page in the app
  that shows the README and guides (small, but new scope).
- **Q-E: The test mailboxes after go-live.** Keep the test list (still used by "Send me a test"?), keep or delete the
  "Test mailboxes" companies, and whether their pre-go-live LIVE sends count as "emailed" (M3-DESIGN §9.3). This decides
  guide 4 step 7.
- **Q-F: Second backup folder.** Confirm USB, second disk or OneDrive only (no network shares), and change the in-app
  hint to match. Should `install-services.bat` run automatically, or should the page detect that the background sender
  can't write there?
- **Q-G: Script backups.** Prune `app-preupdate/prerestore/premigrate` (for example keep the newest 5), or document
  deleting them by hand? Also copy them to the second folder?
- **Still unanswered from PLAN:** Q8 (sending domain name), Q9 (plan/region, default Foundation/EU), Q10 (test
  mailboxes), Q11 (app domain, Access, staff list, session length), Q12 (24/7 or which regions). Guide 4 should say
  where each answer is entered, rather than referring to question numbers.

---

## 8. Suggested order for the M6 docs work

1. Build the M6 screens first (dashboard, Go live, settings polish, backup warnings), then fix the §2.6 texts and the
   restore.bat labels.
2. Write `4-going-live.md` against the finished switch and checklist.
3. Restructure the README (§5.1), then trim guides 1–3 (§5.2) so each topic has one home (§4).
4. Search `docs/setup/` and README for `Milestone`, `Q\d`, ` I `, `me,` and `tell me`; there should be no hits. Check
   anchors: README → `1-install.md#…`, 1-install → `2-mailgun-and-dns.md#18-troubleshooting`,
   `3-cloudflare.md#16-troubleshooting`, and any link to guide 2 §19 (its heading changes).
5. Re-run the label check in §3 on the final text (literal-string search of every **bold** label in the docs against
   `src/`).
