# install-services.bat (as administrator) -> scripts\install-services.ps1
# Makes the app and the background sender start with Windows, before anyone logs in, and
# restart by themselves if they stop (PLAN.md B1, B11). Uses NSSM from tools\ and Windows'
# own password-free service accounts (NT SERVICE\OutreachWeb and NT SERVICE\OutreachWorker).
# Safe to run again: it updates the existing services.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ops-common.ps1')
$root = Get-OutreachRoot
$port = 3000

Write-Title 'Polygon Paradise Outreach: make the app start with Windows'

if (-not (Test-IsAdmin)) {
    Write-Problem 'This needs administrator rights. Double-click install-services.bat (it asks Windows for permission).'
    exit 1
}

# 1. NSSM, checked against its recorded fingerprint.
Write-Step 'Checking the service helper (tools\nssm.exe)'
$nssm = Get-VerifiedNssm
if (-not $nssm) { exit 1 }
Write-Good 'tools\nssm.exe is present and its fingerprint matches.'

# 2. Node.js
Write-Step 'Checking Node.js'
$node = Get-NodePath
if (-not $node) {
    Write-Problem "Node.js isn't installed (or Windows can't find it). Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi), then run setup.bat and this again."
    exit 1
}
$nodeVersion = (Invoke-Native $node @('-v')).Output
$abi = (Invoke-Native $node @('-p', 'process.versions.modules')).Output
if ($nodeVersion -notmatch '^v24\.') {
    Write-Problem "This PC has Node.js $nodeVersion, but the app needs Node.js 24. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi; uninstall a newer Node.js first, in Windows' Settings under Apps), then run update.bat."
    exit 1
}
$abiFile = Join-Path $root 'data\.node-abi'
$recorded = ''
if (Test-Path -LiteralPath $abiFile) { $recorded = (Get-Content -LiteralPath $abiFile -Raw).Trim() }
if (-not $recorded) {
    Write-Problem "Setup hasn't finished on this PC yet. Double-click setup.bat first."
    exit 1
}
if ($recorded -ne $abi) {
    Write-Problem 'Node was updated: run update.bat first, then install-services.bat again.'
    exit 1
}
Write-Good "Node.js $nodeVersion ($node)"

# 3. start.bat must be closed and port 3000 free.
Write-Step 'Checking that nothing else runs the app'
$sup = Get-SupervisorProcess (Join-Path $root 'run\supervisor.pid')
if ($sup) {
    Write-Problem 'The app is running in a start.bat window. Close the start.bat window first (or double-click stop.bat), then run install-services.bat again.'
    exit 1
}
$existing = @($script:WebService, $script:WorkerService | Where-Object { Get-ServiceStatusText $_ })
if ($existing.Count -gt 0) {
    Write-Info 'The services already exist. They are stopped now and set up again with the current settings.'
    foreach ($name in @($script:WorkerService, $script:WebService)) {
        if (Get-ServiceStatusText $name) {
            $null = Invoke-Native $nssm @('stop', $name)
            if (-not (Wait-ServiceStatus $name 'Stopped' 60)) {
                Write-Problem "Windows couldn't stop $name. Restart the PC and run install-services.bat again."
                exit 1
            }
        }
    }
}
if (Test-PortListening $port) {
    $owners = (Get-PortOwnerNames $port) -join ', '
    Write-Problem "Port $port is in use ($owners). Close that program (or restart the PC), then run install-services.bat again."
    exit 1
}
Write-Good 'Nothing else is running the app.'

# 4. A finished build and the settings file.
Write-Step 'Checking the build'
if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
    Write-Problem 'The settings file (.env) is missing. Double-click setup.bat first.'
    exit 1
}
if (Test-Path -LiteralPath (Join-Path $root 'run\update-in-progress')) {
    Write-Problem "update.bat hasn't finished installing the new version. Double-click update.bat and let it finish, then run install-services.bat again."
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root '.next\BUILD_ID'))) {
    Write-Problem "The app hasn't been built yet. Double-click setup.bat first (or start.bat once), then run install-services.bat again."
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root '.next\outreach-build.json'))) {
    Write-Problem "The last build of the app didn't finish. Double-click start.bat once (it builds the app), close it, then run install-services.bat again."
    exit 1
}
$workerParams = 'dist\worker.mjs'
$workerEnvExtra = @()
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\worker.mjs'))) {
    if (Test-Path -LiteralPath (Join-Path $root 'worker\index.ts')) {
        Write-Attention "dist\worker.mjs doesn't exist, so the background sender service runs from its source files."
        $workerParams = '--import tsx worker\index.ts'
        $workerEnvExtra = @("TSX_TSCONFIG_PATH=$root\tsconfig.worker.json")
    } else {
        Write-Problem "The background sender hasn't been built (dist\worker.mjs is missing). Double-click update.bat, then run install-services.bat again."
        exit 1
    }
}
Write-Good 'The app is built.'

# 5. Create or update both services.
function Set-Nssm([string]$Name, [string[]]$Setting) {
    $r = Invoke-Native $nssm (@('set', $Name) + $Setting)
    if ($r.ExitCode -ne 0) { throw "nssm set $Name $($Setting[0]) failed: $($r.Output)" }
}

function Install-OutreachService([string]$Name, [string]$DisplayName, [string]$Description, [string]$Parameters, [string]$LogName, [string[]]$Environment) {
    if (-not (Get-ServiceStatusText $Name)) {
        $r = Invoke-Native $nssm @('install', $Name, $node)
        if ($r.ExitCode -ne 0) { throw "Couldn't create the service $Name. $($r.Output)" }
    }
    Set-Nssm $Name @('Application', $node)
    Set-Nssm $Name @('AppParameters', $Parameters)
    Set-Nssm $Name @('AppDirectory', $root)
    Set-Nssm $Name @('DisplayName', $DisplayName)
    Set-Nssm $Name @('Description', $Description)
    Set-Nssm $Name @('Start', 'SERVICE_DELAYED_AUTO_START')
    Set-Nssm $Name @('AppExit', 'Default', 'Restart')
    Set-Nssm $Name @('AppRestartDelay', '5000')
    Set-Nssm $Name @('AppStopMethodConsole', '4000')
    $log = Join-Path $root "logs\$LogName"
    Set-Nssm $Name @('AppStdout', $log)
    Set-Nssm $Name @('AppStderr', $log)
    Set-Nssm $Name @('AppRotateFiles', '1')
    Set-Nssm $Name @('AppRotateOnline', '1')
    Set-Nssm $Name @('AppRotateBytes', '10485760')
    Set-Nssm $Name (@('AppEnvironmentExtra') + $Environment)
    # Windows' own password-free account for this service: nobody's password is stored,
    # and changing your Microsoft password later can't stop the app.
    $account = "NT SERVICE\$Name"
    $r = Invoke-Native $nssm @('set', $Name, 'ObjectName', $account)
    if ($r.ExitCode -ne 0) {
        $r2 = Invoke-Native 'sc.exe' @('config', $Name, 'obj=', $account)
        if ($r2.ExitCode -ne 0) { throw "Couldn't set the account for $Name. $($r.Output) $($r2.Output)" }
    }
}

Write-Step 'Setting up the services'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
$commonEnv = @('NODE_ENV=production', 'PRISMA_HIDE_UPDATE_MESSAGE=1', 'NEXT_TELEMETRY_DISABLED=1', 'DOTENV_CONFIG_QUIET=true')
try {
    Install-OutreachService -Name $script:WebService `
        -DisplayName 'Polygon Paradise Outreach (app)' `
        -Description 'The Polygon Paradise Outreach web app on port 3000.' `
        -Parameters "node_modules\next\dist\bin\next start -H 0.0.0.0 -p $port --keepAliveTimeout 100000" `
        -LogName 'web.log' `
        -Environment ($commonEnv + @("PORT=$port"))
    Write-Good "Set up $($script:WebService) (the app)."
    Install-OutreachService -Name $script:WorkerService `
        -DisplayName 'Polygon Paradise Outreach (background sender)' `
        -Description 'Sends emails and follow-ups, checks addresses, catches up after the PC was off, and makes backups.' `
        -Parameters $workerParams `
        -LogName 'worker.log' `
        -Environment ($commonEnv + @('OUTREACH_PROCESS=worker') + $workerEnvExtra)
    Write-Good "Set up $($script:WorkerService) (the background sender)."
} catch {
    Write-Problem "Setting up the services failed: $($_.Exception.Message)"
    Write-Info 'Nothing was started. Run install-services.bat again; if it keeps failing, restart the PC first.'
    exit 1
}

# 6. Folder permissions for the two service accounts: read and run this folder, change only
#    data\, backups\, logs\, run\ and .next\ (scripts\lib\service-acl.mjs). The scripts, tools\nssm.exe
#    and node_modules stay read-only for them, because start/stop/update/restore.bat run those as
#    administrator. The second backup folder (Settings > Backups) is granted on its own, last: an unplugged
#    or FAT/exFAT stick only gives a warning, and the services are still set up. A second folder inside
#    this folder, a Windows or program folder, or a whole profile folder (C:\Users\<you>, its Documents,
#    Desktop, Pictures, Downloads or OneDrive itself) is refused with a warning, and a folder an earlier run
#    granted that isn't needed any more loses its permission again (review fix SECURITY-01).
Write-Step 'Giving the services access to this folder'
Write-Info 'This can take a minute (the folder has many small files)...'
$aclRecord = Join-Path $root 'run\service-acl.txt'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'run') | Out-Null
# Node prints UTF-8: read it as UTF-8, so a folder name with an accent arrives (and is recorded) unchanged.
$previousEncoding = $null
try {
    $previousEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
    $previousEncoding = $null
}
try {
    $grant = Invoke-Native $node @((Join-Path $root 'scripts\service-acl.mjs'), 'grant')
} finally {
    if ($previousEncoding) { try { [Console]::OutputEncoding = $previousEncoding } catch { } }
}
$grantResult = $null
try { $grantResult = (($grant.Output -split "`n")[-1]) | ConvertFrom-Json } catch { $grantResult = $null }
if ($grant.ExitCode -ne 0 -or -not $grantResult -or -not $grantResult.ok) {
    $why = $grant.Output
    if ($grantResult -and $grantResult.error) { $why = $grantResult.error }
    Write-Problem "Windows couldn't set the folder permissions: $why"
    exit 1
}
if ($grantResult.warning) { Write-Attention ([string]$grantResult.warning) }
foreach ($old in @($grantResult.revoked)) {
    if ($old) { Write-Info "Took back the services' access to $old, which the app doesn't use any more." }
}
# The accounts also need to see the folders above this one (for example C:\Users\<you>),
# but only their names and dates, never their contents: "read attributes" on that folder only.
# Every folder that gets a permission is recorded, so uninstall-services.bat can remove it again.
$granted = @($grantResult.folders | ForEach-Object { [string]$_ })
$openSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')  # Everyone, Authenticated Users, Users
$dir = Split-Path -Parent $root
while ($dir -and (Split-Path -Parent $dir)) {
    $alreadyOpen = $false
    try {
        $rules = (Get-Acl -LiteralPath $dir).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq 'Allow' -and ($openSids -contains $rule.IdentityReference.Value) -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAttributes) -ne 0)) {
                $alreadyOpen = $true
            }
        }
    } catch {
        $alreadyOpen = $false
    }
    if (-not $alreadyOpen) {
        $r = Invoke-Native 'icacls.exe' @($dir, '/grant', "NT SERVICE\$($script:WebService):(RA)", "NT SERVICE\$($script:WorkerService):(RA)", '/Q')
        if ($r.ExitCode -eq 0) { $granted += $dir }
        else { Write-Attention "Couldn't add 'read attributes' on $dir. If the services don't start, see Troubleshooting." }
    }
    $dir = Split-Path -Parent $dir
}
# Keep every folder an earlier run recorded (an earlier second backup folder, for example), so a folder never drops
# out of the list before uninstall-services.bat has taken the services' permissions off it.
$record = @($granted)
if (Test-Path -LiteralPath $aclRecord) {
    foreach ($line in @(Get-Content -LiteralPath $aclRecord)) {
        $entry = ([string]$line).Trim()
        if ($entry -and -not ($record -contains $entry)) { $record += $entry }
    }
}
Set-Content -LiteralPath $aclRecord -Value $record -Encoding UTF8
Write-Good 'The services can read this folder, but change only data, backups, logs, run and .next (plus a second backup folder, if you set one).'

# 7. Start: the app first, then the background sender.
Write-Step 'Starting the services'
foreach ($name in @($script:WebService, $script:WorkerService)) {
    $r = Invoke-Native $nssm @('start', $name)
    if (-not (Wait-ServiceStatus $name 'Running' 60)) {
        $logName = 'web.log'
        if ($name -eq $script:WorkerService) { $logName = 'worker.log' }
        Write-Problem "$name didn't start. $($r.Output)"
        $logPath = Join-Path $root "logs\$logName"
        if (Test-Path -LiteralPath $logPath) {
            Write-Info "Last lines of logs\$($logName):"
            Get-Content -LiteralPath $logPath -Tail 15 | ForEach-Object { Write-Info "  $_" }
        }
        Write-Info 'See docs\setup\1-install.md, Troubleshooting. Run install-services.bat again after fixing it.'
        exit 1
    }
    Write-Good "$name is running."
}

Write-Info 'Waiting for the app to answer (up to 2 minutes)...'
$health = Wait-Healthy -Port $port -TimeoutSeconds 120
if (-not $health -or -not $health.Healthy) {
    Write-Attention "The services are running, but the app didn't answer its health check yet. Run status.bat in a minute. If it still fails, look at logs\web.log."
    exit 1
}
Write-Good 'The app answers.'

Write-Host ''
Write-Host '  Done. What this means:' -ForegroundColor Green
Write-Info '- The app and the background sender now start by themselves when Windows starts, even before'
Write-Info '  anyone logs in, and start again within seconds if they ever stop.'
Write-Info '- You no longer need to keep a start.bat window open. start.bat now just opens the app,'
Write-Info '  and stop.bat stops it until the next restart or start.bat.'
Write-Info "- Logs: logs\web.log and logs\worker.log (a new file after every 10 MB)."
if ($grantResult.secondFolder) {
    Write-Info "- The background sender may now copy backups to $($grantResult.secondFolder). In the app, open"
    Write-Info '  Settings > Backups, click Back up now and check that the new backup says Copied (on a laptop).'
}
Write-Info "- Open the app at http://localhost:$port"
foreach ($a in @(Get-LanAddresses)) { Write-Info ("  Office computers: http://{0}:{1}" -f $a.Address, $port) }
Write-Info '- Test it: restart the PC, wait two minutes without logging in, and open the office address from another computer.'
exit 0
