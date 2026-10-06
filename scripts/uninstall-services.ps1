# uninstall-services.bat (as administrator) -> scripts\uninstall-services.ps1
# Stops the background sender, then the app, and removes both Windows services.
# Your data, backups and settings stay exactly where they are.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ops-common.ps1')
$root = Get-OutreachRoot

Write-Title 'Polygon Paradise Outreach: stop starting with Windows'

if (-not (Test-IsAdmin)) {
    Write-Problem 'This needs administrator rights. Double-click uninstall-services.bat (it asks Windows for permission).'
    exit 1
}

$names = @($script:WorkerService, $script:WebService)
$present = @($names | Where-Object { Get-ServiceStatusText $_ })
if ($present.Count -eq 0) {
    Write-Good "The services aren't installed. Nothing to do."
    exit 0
}

# NSSM if it's there and unchanged; otherwise Windows' own sc.exe works too.
$nssm = $null
$nssmPath = Join-Path $root 'tools\nssm.exe'
$shaFile = Join-Path $root 'tools\nssm.sha256'
if ((Test-Path -LiteralPath $nssmPath) -and (Test-Path -LiteralPath $shaFile)) {
    $expected = ((Get-Content -LiteralPath $shaFile -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
    if ((Get-FileHash -LiteralPath $nssmPath -Algorithm SHA256).Hash.ToUpperInvariant() -eq $expected) { $nssm = $nssmPath }
}

Write-Step 'Stopping the background sender, then the app'
foreach ($name in $present) {
    if ((Get-ServiceStatusText $name) -ne 'Stopped') {
        if ($nssm) { $null = Invoke-Native $nssm @('stop', $name) } else { $null = Invoke-Native 'sc.exe' @('stop', $name) }
        if (Wait-ServiceStatus $name 'Stopped' 60) { Write-Good "$name is stopped." }
        else { Write-Attention "$name didn't stop within a minute. It is removed anyway and disappears after a restart." }
    } else {
        Write-Good "$name was already stopped."
    }
}

# Remove the folder permissions while the account names still exist.
Write-Step 'Removing the services'' folder permissions'
$accounts = @("NT SERVICE\$($script:WebService)", "NT SERVICE\$($script:WorkerService)")
$null = Invoke-Native 'icacls.exe' (@($root, '/remove') + $accounts + @('/Q'))
$aclRecord = Join-Path $root 'run\service-acl.txt'
if (Test-Path -LiteralPath $aclRecord) {
    # install-services.bat records every folder it ever gave the services access to (earlier second backup
    # folders too). A folder that isn't there now (an unplugged USB stick) stays in the record, so the next
    # install-services.bat can take that permission off once the folder is back.
    $left = @()
    foreach ($line in @(Get-Content -LiteralPath $aclRecord)) {
        $dir = ([string]$line).Trim()
        if (-not $dir) { continue }
        if (Test-Path -LiteralPath $dir) {
            $r = Invoke-Native 'icacls.exe' (@($dir, '/remove') + $accounts + @('/Q'))
            if ($r.ExitCode -ne 0) { $left += $dir }
        } else {
            $left += $dir
        }
    }
    if ($left.Count -gt 0) {
        Set-Content -LiteralPath $aclRecord -Value $left -Encoding UTF8
        foreach ($dir in $left) {
            Write-Attention "Couldn't take the services' permission off $dir (is the drive plugged in?). If you run install-services.bat again later, it takes it off."
        }
    } else {
        Remove-Item -LiteralPath $aclRecord -Force -ErrorAction SilentlyContinue
    }
}
Write-Good 'Done.'

Write-Step 'Removing the services'
foreach ($name in $present) {
    if ($nssm) { $r = Invoke-Native $nssm @('remove', $name, 'confirm') } else { $r = Invoke-Native 'sc.exe' @('delete', $name) }
    if ($r.ExitCode -eq 0) { Write-Good "Removed $name." }
    else { Write-Problem "Couldn't remove $name. $($r.Output)" }
}

Write-Host ''
Write-Info 'The app no longer starts with Windows. To use it, double-click start.bat and keep that window open.'
Write-Info 'Your data (data\app.db), backups and settings (.env) are unchanged.'
Write-Info 'To make it start with Windows again, run install-services.bat.'
exit 0
