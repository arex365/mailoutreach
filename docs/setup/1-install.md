# Install guide

This guide sets up Polygon Paradise Outreach on your PC. It takes about 30 minutes, and you only do it once. Every step is a double-click on a file in this folder.

Mailgun and DNS ([2-mailgun-and-dns.md](2-mailgun-and-dns.md)) and Cloudflare, for remote access ([3-cloudflare.md](3-cloudflare.md)), have their own guides. Do them after this one: the Mailgun guide tells you when to switch to the Cloudflare guide. The [Going-live guide](4-going-live.md) comes last.

**Before you start**

- Use the PC that will run the app: plugged in and on the office network.
- **Put the app folder in `C:\Outreach`**, never in Desktop, Documents, Pictures, OneDrive or Dropbox: a sync program or Windows' ransomware protection can take the database over there. The background services run from this folder, so moving it later means running `install-services.bat` again ([Going-live guide, step 4](4-going-live.md#4-the-pc) says how).
- If the app came as a zip file: right-click the zip › **Properties**, tick **Unblock** (if it's there), click **OK**, then right-click › **Extract All…**. Never run anything from inside the zip.
- You need an internet connection for the first setup.
- **When Windows asks for permission** ("Do you want to allow this app to make changes to your device?", named **Windows Command Processor**, verified publisher Microsoft Windows), click **Yes**. The first window then closes and a new one opens with administrator rights; that's normal.

---

## 1. Install Node.js 24

Node.js is the engine the app runs on.

1. Install Node.js 24 (not 26): open https://nodejs.org/dist/latest-v24.x/ and download the file ending in -x64.msi. Any 24.x from 24.18 works; the app refuses 26.
2. Run it and keep the default options. You don't need "Tools for native modules".
3. To check: open PowerShell, type `node -v` and press Enter. It should say `v24.` and a number.

Only install Node.js from nodejs.org's 24.x folder. The big "LTS" button on nodejs.org may offer Node.js 26, and winget or Windows may offer to move you to it: don't accept it, because the app refuses 26. If Node.js does change, the app tells you "Node was updated: run update.bat", and double-clicking `update.bat` fixes it (if it's now Node.js 25 or 26, see [Troubleshooting](#12-troubleshooting) first).

**Updating Node.js later** (a new 24.x with security fixes): double-click `stop.bat`, install the new 24.x the same way, then double-click `update.bat`. If the installer put Node.js into a different folder, run `install-services.bat` again too, because the services remember where node.exe is.

## 2. Run setup.bat

Double-click **`setup.bat`**. It:

1. checks Node.js;
2. installs the app's parts (a few minutes the first time);
3. checks that the database and password parts work with your Node.js;
4. creates the settings file `.env` with a new encryption key;
5. asks for the app's **public address**. Press **Enter** to skip it for now. Remote staff and Mailgun reach the app through it, so you need it before Mailgun can talk to the app: the [Cloudflare guide](3-cloudflare.md) sets it up and then has you run `setup.bat` again to enter it;
6. creates the database (`data\app.db`);
7. builds the app (a few more minutes);
8. prints your **one-time setup code** in a box.

Keep the window open until you've written the code down or typed it in the next step.

Running `setup.bat` again is always safe. It never replaces your encryption key or your data. While nobody has created the Owner account yet, it prints a new code each time, and the old one stops working. Once the Owner exists it says **Setup is already done**.

## 3. Start the app and create your Owner account

1. Double-click **`start.bat`**. A window opens. After a minute it shows a box saying **Polygon Paradise Outreach is running**, with the addresses. **Keep this window open**: closing it stops the app.
2. Your browser opens `http://localhost:3000`. If it doesn't, type that address yourself.
3. Enter the setup code, your name, your email address and a password (at least 10 characters; a short sentence works well).

You're now signed in as the Owner. If Windows asks whether to let Node.js through the firewall, read [The Windows firewall question](#10-the-windows-firewall-question) first.

## 4. The office address

The start.bat window also shows the **office address**, for example `http://192.168.1.101:3000`. Other computers on the office network use that address.

- It only works after step 6 (`setup-pc.bat`), because Windows blocks it while the Wi-Fi is marked "Public".
- The address can change when the router restarts. To keep it fixed, ask whoever manages the router for a "DHCP reservation" for this PC.
- The office address uses plain http. Passwords travel unencrypted over the office Wi-Fi, and browsers don't allow desktop notifications or one-click copying there. The secure https address from the [Cloudflare guide](3-cloudflare.md) has none of these limits.

## 5. Make the app start with Windows

1. **Close the start.bat window** (click the X, or press Ctrl+C). Wait until it has closed.
2. Double-click **`install-services.bat`**. Windows asks for permission: click **Yes**.
3. It checks its helper program (`tools\nssm.exe`), sets up two background services, starts them, and checks that the app answers.

What this means:

- The app and the background sender now start by themselves when Windows starts, **even before anyone logs in**, and restart within seconds if they ever stop. They start about 1 to 2 minutes after Windows ("Automatic (Delayed Start)"), so right after a restart the app needs a moment before it answers.
- You don't need a start.bat window any more. From now on `start.bat` only starts the services (if they're stopped) and opens the app, and `stop.bat` stops them until the next restart.
- They run under Windows' own password-free service accounts (`NT SERVICE\OutreachWeb` and `NT SERVICE\OutreachWorker`). These can read this folder, but change only its `data`, `backups`, `logs`, `run` and `.next` folders (and a second backup folder, if you set one: after saving it in Settings › Backups, run `install-services.bat` again so they may write there, then click **Back up now** and check that the new backup says **Copied**). The scripts you run as administrator stay out of their reach. Your Microsoft password isn't stored anywhere, so changing it can't stop sending.
- Their messages go to the `logs` folder: look at the newest file there.

**Test it:** restart the PC, wait two minutes without logging in, then open the office address from another computer.

To go back to using start.bat by hand, double-click `uninstall-services.bat`. Your data and settings stay.

## 6. Prepare the PC (setup-pc.bat)

Double-click **`setup-pc.bat`** and click **Yes**. Every step first says what it will do and asks **Y/N**. Answer N to skip a step; you can run it again at any time.

1. **Mark the office network as Private.** It lists the networks this PC is connected to. Windows only lets other computers reach this PC on "Private" networks. Right now your Wi-Fi is marked "Public", which blocks the office. If "HOME-Ground 2" is the office network, choose that one.
2. **Close old Node.js openings on public networks.** When a Node.js program first runs, Windows makes rules called "Node.js JavaScript Runtime". Two of them on this PC let computers on public Wi-Fi (cafés, hotels) reach it. This switches those off. It also removes any "block" rules that clicking Cancel on the firewall question creates.
3. **Let office computers reach the app.** Adds one rule: port 3000, only on Private networks, and only from computers on the same local network.
4. **Check the firewall.** Looks for anything that still opens the app to public networks, or blocks it, and offers to switch it off.
5. **Keep the PC awake while plugged in.** Emails only go out while the PC is on and awake. When plugged in: never sleep, never hibernate, and closing the lid does nothing. Battery settings stay as they are, so **on battery the laptop still goes to sleep** and nothing is sent: keep it plugged in during sending hours.
6. **Windows Update active hours.** Shows the current setting and how to change it (next section), and can open the right Settings page.

## 7. Windows Update active hours

Windows restarts for updates outside its "active hours". European working hours are 11:00 to 23:00 in Pakistan, so the restart should happen at night.

1. Open **Settings › Windows Update › Advanced options › Active hours**.
2. Set **Adjust active hours** to **Manually**.
3. Choose **8:00 AM** to **2:00 AM**.
4. If Windows doesn't accept that (it allows at most 18 hours), choose **6:00 AM** to **12:00 AM** (midnight) instead. That still covers 11:00 to 23:00.

## 8. The practice copy

Double-click **`start-demo.bat`** to open a practice copy at `http://localhost:3001`.

- Sign in as **demo@example.com** with the password **practice-only-password**. Your practice teammate is ali@example.com (same password).
- It has about 80 made-up companies in the four lists from your old tool: German 3D Companies, Norway 3D Companies, Worldwide Directory and Instagram Creators. Every web address ends in `.example`, so none of them is a real company.
- **Nothing is ever sent**, and your real data (`data\app.db`) is never touched. Only this PC can open it.
- Close its window to stop it.
- To start over with fresh practice data: close the practice copy, delete `data\demo.db`, and double-click `start-demo.bat` again.

It uses the app's build, so run `setup.bat` (or `start.bat`) once before the first practice session.

## 9. Everyday scripts

Every double-click script, what it does and when to use it, is in the README's table, [The double-click scripts](../../README.md#the-double-click-scripts). Backups, `restore.bat` and moving to a new PC are in [Backups and restore](../../README.md#backups-and-restore): `restore.bat` lists the backups newest first, each with its kind (**Daily backup**, **Back up now**, **Before an update**, **Before a restore**, **Before a database upgrade**), and after a restore sending stays paused until you've read the restore report and clicked **Resume sending**.

## 10. The Windows firewall question

If Windows asks whether to allow Node.js through the firewall, tick only **Private networks** (untick **Public networks**) and click **Allow**. If you clicked Cancel by mistake, run `setup-pc.bat` again: it removes the block rule that Cancel creates.

## 11. Where your data lives

All your data is in one file, `data\app.db`; the README's [Where things live](../../README.md#where-things-live) lists every folder. Messages for troubleshooting are in the `logs` folder: the newest file there is the one to look at.

**Keep a copy of `.env` somewhere safe**, for example on a USB stick or in a password manager, not only in this folder. Without it the saved API keys (Mailgun, Claude) can't be read, and you'd have to type them in again. Never send this file to anyone.

## 12. Troubleshooting

**"Node was updated: run update.bat."** Node.js changed since the app was installed, so some of its parts no longer fit. Double-click `update.bat`. If you're on Node.js 25 or 26, first uninstall it (in Windows' own Settings app: **Apps**, then **Installed apps**, **Node.js**, **Uninstall**), then install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi). The installer never replaces a newer version by itself.

**"Port 3000 is already in use."** Probably the app is already running: as a background service, or in another start.bat window. Try `http://localhost:3000` in your browser, or double-click `status.bat`. If another program uses port 3000, close it or restart the PC.

**"Windows protected your PC" or a security warning when you double-click a `.bat` file.** The files came from a zip that wasn't unblocked. Delete the extracted files, right-click the zip › **Properties** › tick **Unblock** › **OK**, and extract it again.

**Smart App Control blocks a part of the app.** Smart App Control (Windows Security › App & browser control) can block `tools\nssm.exe`. It is off on the office PC. On a new PC where it is on, ask for help before switching it off (see "Getting help" in the README).

**Your antivirus removed `tools\nssm.exe`.** Some antivirus programs distrust NSSM because it runs programs as Windows services. Restore it from the antivirus quarantine and add an exception for this folder. `install-services.bat` checks its fingerprint against `tools\nssm.sha256`, so a changed file is never used. Only if it can't be restored: download it again by running this in PowerShell in this folder: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\get-nssm.ps1`. (Or `winget install --id NSSM.NSSM -e`, then copy the 64-bit `nssm.exe` into `tools\` and write its fingerprint with `(Get-FileHash tools\nssm.exe -Algorithm SHA256).Hash | Set-Content tools\nssm.sha256`.)

**Your antivirus removed a part of the database engine.** It usually shows as "A part of the app (better-sqlite3) doesn't work" or a Prisma error, and the quarantined file is under `node_modules\` (a `.node` or `.dll` file). Restore it from quarantine, add an exception for this folder, and double-click `update.bat`.

**The services don't start.** `install-services.bat` shows the last lines of the log; the full messages are in the newest files in the `logs` folder. If you moved this folder, run `install-services.bat` again. If Windows "Controlled folder access" is ever switched on, allow `node.exe` through it.

**The app doesn't answer right after a restart.** The services start about 1 to 2 minutes after Windows. Wait two minutes, then run `status.bat`.

**Office computers can't open the app.** Run `status.bat`: it warns if the network is marked Public or a firewall rule blocks the app. Run `setup-pc.bat` to fix both. Also check that the other computer is on the same network and uses the address status.bat shows (it can change after a router restart).

**You lost the setup code.** Run `setup.bat` again for a new one (this only works while no Owner account exists). It also forgets the wrong tries with older codes, so "too many tries" doesn't block the new one. If the app is already running, close the start.bat window and double-click `start.bat` again, so it picks up the new code.

**Someone forgot their password.** The Owner can make a reset link for a Member in **Settings › Team** (the person's **⋯** menu › **Reset password link**). For the Owner's own password, or when nobody can sign in, double-click `reset-password.bat` on this PC.

**"Paused: …" in the top bar.** Sending has stopped for everyone, dry runs included. Open **Settings › Sending & Mailgun**: the red card says why (for example too many bounces, a Mailgun problem, or a restore) and what to do. Fix that, then click **Resume sending**. If the cause is still there, sending simply pauses again with the same message. The [Mailgun guide](2-mailgun-and-dns.md#18-troubleshooting) lists the usual causes.

**"Paused: this database was copied or moved" in the top bar.** The app's database now opens from a different place than before (for example after moving this folder). If you moved the app on purpose, click **Resume sending** in Settings › Sending & Mailgun. If this is a copy of the real database, don't resume: the copy would send the same emails again.

**"Paused: this database last ran on another computer" or "Paused: the database file was replaced".** The app folder or `data\app.db` was copied from another computer, the PC was renamed, or someone put a different database file in place of `data\app.db`. The red card in Settings › Sending & Mailgun names the other computer. If the app still runs on that computer, don't resume: both would send the same emails. If you moved the app to this computer on purpose, renamed the PC, or replaced the file on purpose, click **Resume sending**. To go back to a backup, always use `restore.bat`: it checks Mailgun for emails sent since the backup was made.

**status.bat says "Remote access (Cloudflared): stopped".** Remote staff and Mailgun can't reach the app. Open PowerShell as Administrator and type `net start cloudflared`. The [Cloudflare guide](3-cloudflare.md#16-troubleshooting) has more.

**status.bat says the app folder is inside Pictures (or Documents, Desktop, OneDrive).** Move it to `C:\Outreach`: [Going-live guide, step 4](4-going-live.md#4-the-pc).

**update.bat stopped with an error.** Read the message: it says which step failed. Your data was backed up first, and the message shows the exact `restore.bat` command if you need that data back. Nothing half-built was started, so no emails went out. Until `update.bat` has run to the end, `start.bat` and `restore.bat` don't start the app and the services don't start with Windows (`status.bat` says so too). Fix the problem the message names, then double-click `update.bat` again.

**"… the practice copy (the start-demo.bat window) is open …"** `setup.bat` and `start.bat` don't reinstall or rebuild the app while the practice copy runs, because it uses the same files. Close the start-demo.bat window and try again.

**stop.bat says the app "is still upgrading the database".** A start.bat window was upgrading the database when you asked it to stop. Stopping that in the middle could damage the upgrade, so it's left to finish; the window stops by itself right after. Wait a few minutes and try again.
