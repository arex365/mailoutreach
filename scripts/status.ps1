# status.bat -> powershell -NoProfile -ExecutionPolicy Bypass -File scripts\status.ps1
# Shows how the app is doing. Changes nothing and needs no administrator rights.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ops-common.ps1')
$root = Get-OutreachRoot
$port = 3000

Write-Title 'Polygon Paradise Outreach: status'

if (Test-Path -LiteralPath (Join-Path $root 'run\update-in-progress')) {
    Write-Step 'Update'
    Write-Problem "update.bat hasn't finished installing the new version, so the app isn't started. Double-click update.bat and let it finish."
}

# 1. Background services
Write-Step 'Background services (start with Windows)'
$webState = Get-ServiceStatusText $script:WebService
$workerState = Get-ServiceStatusText $script:WorkerService
$servicesInstalled = ($null -ne $webState)
if (-not $servicesInstalled) {
    Write-Info 'Not installed. The app runs only while a start.bat window is open. (install-services.bat changes that.)'
} else {
    foreach ($pair in @(@('The app', $script:WebService, $webState), @('The background sender', $script:WorkerService, $workerState))) {
        $label = $pair[0]; $name = $pair[1]; $state = $pair[2]
        if ($null -eq $state) { Write-Problem "$label ($name): not installed. Run install-services.bat again." }
        elseif ($state -eq 'Running') { Write-Good "$label ($name): running" }
        else { Write-Attention "$label ($name): $($state.ToLowerInvariant()). Double-click start.bat to start it." }
    }
}

# The public address (APP_PUBLIC_URL in .env). The last line for a key is the one the app uses (like dotenv and Next.js).
$envFile = Join-Path $root '.env'
$publicUrl = ''
if (Test-Path -LiteralPath $envFile) {
    $line = Select-String -LiteralPath $envFile -Pattern '^\s*(?:export\s+)?APP_PUBLIC_URL\s*=\s*"?([^"]*)"?' | Select-Object -Last 1
    if ($line) { $publicUrl = $line.Matches[0].Groups[1].Value.Trim() }
}

# 2. Remote access: the Cloudflared Windows service (docs\setup\3-cloudflare.md). The app's "Remote access is down"
#    notice sends the Owner here.
Write-Step 'Remote access (Cloudflare Tunnel)'
$tunnelState = Get-ServiceStatusText 'Cloudflared'
if ($null -eq $tunnelState) {
    if ($publicUrl) { Write-Problem 'Remote access (Cloudflared): not installed, so remote staff and Mailgun can''t reach the app. Follow docs\setup\3-cloudflare.md, step 7.' }
    else { Write-Info 'Remote access (Cloudflared): not installed. To set it up, follow docs\setup\3-cloudflare.md.' }
} elseif ($tunnelState -eq 'Running') {
    Write-Good 'Remote access (Cloudflared): running'
} else {
    Write-Attention "Remote access (Cloudflared): $($tunnelState.ToLowerInvariant()). Remote staff and Mailgun can't reach the app. In PowerShell as Administrator, run: net start cloudflared"
}

# 3. start.bat window
Write-Step 'Started by hand (start.bat)'
$sup = Get-SupervisorProcess (Join-Path $root 'run\supervisor.pid')
if ($sup) { Write-Good "A start.bat window is running the app (process $($sup.ProcessId))." }
else { Write-Info 'No start.bat window is running the app.' }

# 4. Health
Write-Step "App health (http://127.0.0.1:$port/api/health)"
$health = Invoke-HealthCheck -Port $port -TimeoutSec 5
if (-not $health.Answered) {
    Write-Problem "The app doesn't answer. Nobody can open it and no emails go out. Double-click start.bat."
} elseif (-not $health.Healthy) {
    Write-Problem "The app answers, but reports a problem (status $($health.Status)). Look at the newest file in the logs folder."
} else {
    $dbValue = $health.Json.database
    $db = [string]$dbValue
    if ($dbValue -is [bool]) { if ($dbValue) { $db = 'ok' } else { $db = 'problem' } }
    if ($db) { Write-Good "The app answers. Database: $db." } else { Write-Good 'The app answers.' }
    $seenRaw = $health.Json.workerLastSeen
    if (-not $seenRaw) {
        Write-Attention "The background sender hasn't checked in yet, so no emails are going out. Double-click start.bat, or restart the PC."
    } else {
        $seen = $null
        if ($seenRaw -is [datetime]) { $seen = $seenRaw } else { try { $seen = [datetime]::Parse([string]$seenRaw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } catch { $seen = $null } }
        if ($null -eq $seen) {
            Write-Info "The background sender last checked in at $seenRaw."
        } else {
            $local = $seen.ToLocalTime()
            $ago = [int]((Get-Date) - $local).TotalSeconds
            if ($ago -le 60) { Write-Good ("The background sender checked in {0} seconds ago ({1:HH:mm:ss})." -f [Math]::Max(0, $ago), $local) }
            else { Write-Attention ("The background sender hasn't checked in since {0:dd MMM HH:mm}, so no emails are going out. Restart the PC or double-click start.bat." -f $local) }
        }
    }
}

# 5. Practice copy
Write-Step 'Practice copy (start-demo.bat)'
$demo = Get-SupervisorProcess (Join-Path $root 'run\demo.pid')
if ($demo) { Write-Good 'Running at http://localhost:3001 (made-up data, nothing is ever sent).' }
else { Write-Info 'Not running.' }

# 6. Backups: the newest backup the background sender made (Daily backup or Back up now; the backups update.bat and
#    restore.bat make don't count, so they can't hide failed daily ones), its kind read from the database (read-only),
#    and a warning when the app folder sits where OneDrive, a sync program or ransomware protection can take it over.
Write-Step 'Backups'
$nodeExe = Get-NodePath
if ($nodeExe) {
    $libUrl = ([System.Uri](Join-Path $root 'scripts\lib\backups.mjs')).AbsoluteUri
    $code = "import('$libUrl').then(async (m) => console.log(JSON.stringify(await m.newestBackupStatus(process.argv[1]))))"
    $newest = Invoke-Native $nodeExe @('-e', $code, $root)
    $backupInfo = $null
    try { $backupInfo = (($newest.Output -split "`n")[-1]) | ConvertFrom-Json } catch { $backupInfo = $null }
    if ($newest.ExitCode -ne 0 -or -not $backupInfo) { Write-Info "Couldn't read the backups folder." }
    elseif ($backupInfo.stale) { Write-Attention ([string]$backupInfo.line) }
    else { Write-Info ([string]$backupInfo.line) }
} else {
    Write-Info "Couldn't read the backups folder (Node.js wasn't found)."
}
$riskyFolder = $null
foreach ($part in ($root -split '[\\/]')) {
    if ($part -match '^(Desktop|Documents|Pictures|Dropbox|Google Drive)$' -or $part -match '^OneDrive') { $riskyFolder = $part; break }
}
if ($riskyFolder) {
    Write-Attention "The app folder is inside $riskyFolder, which OneDrive, a sync program or Windows' ransomware protection can take over. Move it to C:\Outreach (docs\setup\4-going-live.md, step 4)."
}

# 7. Addresses
Write-Step 'Addresses'
Write-Info "On this PC:        http://localhost:$port"
$lan = @(Get-LanAddresses)
if ($lan.Count -eq 0) { Write-Attention 'No office network found right now (is the Wi-Fi or cable connected?).' }
foreach ($a in $lan) { Write-Info ("Office computers:  http://{0}:{1}   ({2})" -f $a.Address, $port, $a.Alias) }
if (Test-Path -LiteralPath $envFile) {
    if ($publicUrl) { Write-Info "Remote staff:      $publicUrl" } else { Write-Info 'Remote staff:      not set up yet (see docs\setup\3-cloudflare.md)' }
}

# 8. Network and firewall
Write-Step 'Network and firewall'
try {
    foreach ($p in @(Get-NetConnectionProfile -ErrorAction Stop)) {
        $cat = [string]$p.NetworkCategory
        if ($cat -eq 'Public') { Write-Attention "Network '$($p.Name)' ($($p.InterfaceAlias)) is marked Public, so office computers can't reach the app. setup-pc.bat can mark it Private." }
        else { Write-Good "Network '$($p.Name)' ($($p.InterfaceAlias)) is marked $cat." }
    }
} catch {
    Write-Info "Couldn't read the network profiles."
}
try {
    $findings = @(Get-FirewallFindings -Port $port)
    $public = @($findings | Where-Object { $_.Kind -eq 'PublicAllow' })
    $blocks = @($findings | Where-Object { $_.Kind -eq 'Block' })
    foreach ($f in $public) {
        Write-Attention "The rule '$($f.DisplayName)' lets computers on public networks (cafe or hotel Wi-Fi) reach $($f.What). Run setup-pc.bat to switch it off."
    }
    foreach ($f in $blocks) {
        Write-Attention "The rule '$($f.DisplayName)' blocks $($f.What), so office computers may not reach the app. This usually comes from clicking Cancel on the Windows firewall question. Run setup-pc.bat to remove it."
    }
    if ($public.Count -eq 0 -and $blocks.Count -eq 0) { Write-Good 'No firewall rule opens the app to public networks, and none blocks it.' }
    $ours = Get-NetFirewallRule -Name 'Outreach-Web-In' -ErrorAction SilentlyContinue
    if ($ours -and ([string]$ours.Enabled) -eq 'True') { Write-Good "The rule 'Outreach web app (TCP 3000, private network only)' is on." }
    else { Write-Info "The office-network rule for port 3000 isn't set up. setup-pc.bat adds it." }
} catch {
    Write-Info "Couldn't read the firewall rules from this window. setup-pc.bat checks them with administrator rights."
}

# 9. Logs
Write-Step 'Logs'
$logs = Join-Path $root 'logs'
$newest = Get-ChildItem -LiteralPath $logs -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3
if ($newest) { foreach ($l in $newest) { Write-Info ("logs\{0}  ({1:dd MMM HH:mm})" -f $l.Name, $l.LastWriteTime) } }
else { Write-Info 'No log files yet.' }
Write-Host ''
exit 0
