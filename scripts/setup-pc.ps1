# setup-pc.bat (as administrator) -> scripts\setup-pc.ps1
# Prepares this laptop for running the app all day (PLAN.md A4 point 9, Q12, B11):
#   1. the office network is marked Private
#   2. old Node.js firewall openings on public networks are closed, Cancel-created block rules removed
#   3. one firewall rule lets office computers reach the app (TCP 3000, private network only)
#   4. a check that nothing opens the app to public networks
#   5. power: never sleep or hibernate while plugged in, closing the lid does nothing (plugged in only)
#   6. how to set Windows Update's active hours
# Every step says what it will do and asks first. Answer N to skip it. Run it again any time.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ops-common.ps1')
$port = 3000
$changes = @()

Write-Title 'Polygon Paradise Outreach: prepare this PC'
if (-not (Test-IsAdmin)) {
    Write-Problem 'This needs administrator rights. Double-click setup-pc.bat (it asks Windows for permission).'
    exit 1
}
Write-Info 'This changes a few Windows settings so office computers can reach the app and the PC keeps'
Write-Info 'sending emails. Every step says what it will do and asks first. Answer N to skip a step.'

# ---------------------------------------------------------------------------------------------
Write-Step 'Step 1 of 6: mark the office network as Private'
Write-Info 'Windows only lets other computers reach this PC on networks marked Private. Public is meant'
Write-Info 'for cafes, hotels and airports, where nobody should reach it.'
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
if ($profiles.Count -eq 0) {
    Write-Attention 'No network is connected right now. Connect to the office Wi-Fi or cable and run setup-pc.bat again.'
} else {
    for ($i = 0; $i -lt $profiles.Count; $i++) {
        $p = $profiles[$i]
        Write-Info ("{0}. {1}  (connection: {2}, now: {3})" -f ($i + 1), $p.Name, $p.InterfaceAlias, $p.NetworkCategory)
    }
    if (Read-YesNo 'Mark the office network as Private?') {
        $pick = $null
        if ($profiles.Count -eq 1) {
            $pick = $profiles[0]
        } else {
            $answer = Read-Host '  Type the number of the office network (Enter to skip)'
            $n = 0
            if ([int]::TryParse(([string]$answer).Trim(), [ref]$n) -and $n -ge 1 -and $n -le $profiles.Count) { $pick = $profiles[$n - 1] }
        }
        if (-not $pick) {
            Write-Info 'Skipped.'
        } elseif ([string]$pick.NetworkCategory -eq 'Private') {
            Write-Good "'$($pick.Name)' is already Private."
        } elseif ([string]$pick.NetworkCategory -eq 'DomainAuthenticated') {
            Write-Info "'$($pick.Name)' is a company domain network; Windows manages it, so it's left alone."
        } else {
            Write-Info "Running: Set-NetConnectionProfile -InterfaceAlias '$($pick.InterfaceAlias)' -NetworkCategory Private"
            try {
                Set-NetConnectionProfile -InterfaceAlias $pick.InterfaceAlias -NetworkCategory Private
                Write-Good "'$($pick.Name)' is now Private."
                $changes += "Marked the network '$($pick.Name)' as Private."
            } catch {
                Write-Problem "Windows didn't allow it: $($_.Exception.Message)"
            }
        }
    } else {
        Write-Info 'Skipped.'
    }
}

# ---------------------------------------------------------------------------------------------
Write-Step 'Step 2 of 6: close old Node.js openings on public networks'
Write-Info 'When a Node.js program first runs, Windows asks whether to let it through the firewall and'
Write-Info 'makes rules called "Node.js JavaScript Runtime". Some of them let computers on public Wi-Fi'
Write-Info 'reach this PC. This switches off the ones that cover public networks. Clicking Cancel on that'
Write-Info 'question makes "block" rules instead, which stop office computers reaching the app; those are removed.'
$appFilters = @{}
foreach ($f in @(Get-NetFirewallApplicationFilter -All -ErrorAction SilentlyContinue)) { $appFilters[$f.InstanceID] = [string]$f.Program }
$nodePublic = @(Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' -ErrorAction SilentlyContinue | Where-Object {
        $pv = [int]$_.Profile
        ([string]$_.Enabled -eq 'True') -and (($pv -eq 0) -or (($pv -band 4) -ne 0))
    })
$nodeBlocks = @(Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue | Where-Object { $appFilters[$_.InstanceID] -match '(^|\\)node\.exe$' })
if ($nodePublic.Count -eq 0 -and $nodeBlocks.Count -eq 0) {
    Write-Good 'Nothing to do: no Node.js rule covers public networks and none blocks Node.js.'
} else {
    foreach ($r in $nodePublic) { Write-Info ("Switch off: '{0}' ({1}, networks: {2})" -f $r.DisplayName, $appFilters[$r.InstanceID], $r.Profile) }
    foreach ($r in $nodeBlocks) { Write-Info ("Remove block rule: '{0}' ({1}, networks: {2})" -f $r.DisplayName, $appFilters[$r.InstanceID], $r.Profile) }
    if (Read-YesNo 'Make these changes?') {
        foreach ($r in $nodePublic) {
            Disable-NetFirewallRule -Name $r.Name
            $changes += "Switched off the firewall rule '$($r.DisplayName)' ($($r.Profile))."
        }
        foreach ($r in $nodeBlocks) {
            Remove-NetFirewallRule -Name $r.Name
            $changes += "Removed the block rule '$($r.DisplayName)'."
        }
        Write-Good 'Done.'
    } else {
        Write-Info 'Skipped.'
    }
}

# ---------------------------------------------------------------------------------------------
Write-Step 'Step 3 of 6: let office computers reach the app'
Write-Info "Adds one firewall rule: TCP port $port, only on Private networks, only from computers on the same"
Write-Info 'local network (office), never from the internet or public Wi-Fi.'
$ours = Get-NetFirewallRule -Name 'Outreach-Web-In' -ErrorAction SilentlyContinue
if ($ours -and [string]$ours.Enabled -eq 'True') {
    Write-Good "The rule 'Outreach web app (TCP $port, private network only)' already exists."
} elseif ($ours) {
    Write-Info 'The rule exists but is switched off.'
    if (Read-YesNo 'Switch it on?') {
        Enable-NetFirewallRule -Name 'Outreach-Web-In'
        $changes += 'Switched on the firewall rule for the app.'
        Write-Good 'Switched on.'
    } else { Write-Info 'Skipped.' }
} elseif (Read-YesNo 'Add this rule?') {
    New-NetFirewallRule -Name 'Outreach-Web-In' -DisplayName "Outreach web app (TCP $port, private network only)" `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private -RemoteAddress LocalSubnet | Out-Null
    $changes += "Added the firewall rule for TCP $port (private network, local subnet only)."
    Write-Good 'Added.'
} else {
    Write-Info 'Skipped.'
}

# ---------------------------------------------------------------------------------------------
Write-Step 'Step 4 of 6: check that nothing opens the app to public networks'
Write-Info "Looks for any switched-on rule that lets public networks reach node.exe or port $port, and any rule that blocks them."
if (Read-YesNo 'Check the firewall now?' $true) {
    try {
        $findings = @(Get-FirewallFindings -Port $port)
        if ($findings.Count -eq 0) {
            Write-Good 'All good: nothing opens the app to public networks and nothing blocks it.'
        }
        foreach ($f in $findings) {
            if ($f.Kind -eq 'PublicAllow') {
                Write-Attention "'$($f.DisplayName)' lets public networks reach $($f.What) (networks: $($f.Profile))."
                if (Read-YesNo 'Switch this rule off?' $true) {
                    Disable-NetFirewallRule -Name $f.Name
                    $changes += "Switched off the firewall rule '$($f.DisplayName)'."
                    Write-Good 'Switched off.'
                }
            } else {
                Write-Attention "'$($f.DisplayName)' blocks $($f.What), so office computers may not reach the app."
                if (Read-YesNo 'Switch this rule off?' $true) {
                    Disable-NetFirewallRule -Name $f.Name
                    $changes += "Switched off the block rule '$($f.DisplayName)'."
                    Write-Good 'Switched off.'
                }
            }
        }
    } catch {
        Write-Problem "Couldn't read the firewall rules: $($_.Exception.Message)"
    }
} else {
    Write-Info 'Skipped.'
}

# ---------------------------------------------------------------------------------------------
function Get-AcPowerValue([string]$Group, [string]$Setting) {
    $r = Invoke-Native 'powercfg.exe' @('/q', 'SCHEME_CURRENT', $Group, $Setting)
    if ($r.ExitCode -ne 0) { return $null }
    $hex = @([regex]::Matches($r.Output, '0x[0-9a-fA-F]{8}') | ForEach-Object { $_.Value })
    if ($hex.Count -lt 2) { return $null }
    # The last two values are "plugged in" (AC) and "on battery" (DC), in that order.
    return [Convert]::ToInt64($hex[$hex.Count - 2], 16)
}

function Format-Timeout($Seconds) {
    if ($null -eq $Seconds) { return 'not available on this PC' }
    if ($Seconds -eq 0) { return 'never' }
    return ('after {0} minutes' -f [Math]::Round($Seconds / 60))
}

function Show-PowerSummary {
    $lidNames = @{ 0 = 'do nothing'; 1 = 'sleep'; 2 = 'hibernate'; 3 = 'shut down' }
    $lid = Get-AcPowerValue 'SUB_BUTTONS' 'LIDACTION'
    $lidText = 'unknown'
    if ($null -ne $lid -and $lidNames.ContainsKey([int]$lid)) { $lidText = $lidNames[[int]$lid] }
    Write-Info ('Plugged in, sleep:          {0}' -f (Format-Timeout (Get-AcPowerValue 'SUB_SLEEP' 'STANDBYIDLE')))
    Write-Info ('Plugged in, hibernate:      {0}' -f (Format-Timeout (Get-AcPowerValue 'SUB_SLEEP' 'HIBERNATEIDLE')))
    Write-Info ('Plugged in, closing the lid: {0}' -f $lidText)
    Write-Info 'On battery: unchanged.'
}

Write-Step 'Step 5 of 6: keep the PC awake while it is plugged in'
Write-Info 'Emails only go out while the PC is on and awake. When plugged in, this sets:'
Write-Info '  never sleep, never hibernate, and closing the lid does nothing.'
Write-Info 'Battery settings are left alone, and hibernation itself stays available.'
Write-Info 'Now:'
Show-PowerSummary
if (Read-YesNo 'Change the plugged-in power settings?') {
    $cmds = @(
        @('/change', 'standby-timeout-ac', '0'),
        @('/change', 'hibernate-timeout-ac', '0'),
        @('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0'),
        @('/setactive', 'SCHEME_CURRENT')
    )
    $ok = $true
    foreach ($c in $cmds) {
        Write-Info ('Running: powercfg {0}' -f ($c -join ' '))
        $r = Invoke-Native 'powercfg.exe' $c
        if ($r.ExitCode -ne 0) { $ok = $false; Write-Attention "powercfg said: $($r.Output)" }
    }
    if ($ok) { Write-Good 'Done.'; $changes += 'Plugged in: never sleep, never hibernate, closing the lid does nothing.' }
    Write-Info 'Now:'
    Show-PowerSummary
} else {
    Write-Info 'Skipped.'
}

# ---------------------------------------------------------------------------------------------
Write-Step 'Step 6 of 6: Windows Update active hours'
Write-Info 'Windows restarts for updates outside its "active hours". European working hours are'
Write-Info '11:00 to 23:00 in Pakistan, so the restart should happen at night.'
try {
    $ux = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -ErrorAction Stop
    $mode = 'set by hand'
    if ($ux.SmartActiveHoursState -eq 1) { $mode = 'adjusted automatically by Windows' }
    if ($null -ne $ux.ActiveHoursStart -and $null -ne $ux.ActiveHoursEnd) {
        Write-Info ('Now: {0:00}:00 to {1:00}:00 ({2}).' -f [int]$ux.ActiveHoursStart, [int]$ux.ActiveHoursEnd, $mode)
    }
} catch {
    Write-Info "Couldn't read the current active hours."
}
Write-Info 'How to set them:'
Write-Info '  1. Open Settings > Windows Update > Advanced options > Active hours.'
Write-Info '  2. Set "Adjust active hours" to Manually.'
Write-Info '  3. Start time 8:00 AM, end time 2:00 AM.'
Write-Info '  4. If Windows refuses that (it allows at most 18 hours), use 6:00 AM to 12:00 AM (midnight).'
Write-Info '     That still covers 11:00 to 23:00.'
if (Read-YesNo 'Open that Settings page now?') {
    Start-Process 'ms-settings:windowsupdate-options'
    Write-Info 'The Settings window is open. Click Active hours there.'
} else {
    Write-Info 'Skipped.'
}

# ---------------------------------------------------------------------------------------------
Write-Step 'Summary'
if ($changes.Count -eq 0) {
    Write-Info 'Nothing was changed.'
} else {
    foreach ($c in $changes) { Write-Good $c }
}
Write-Info 'You can run setup-pc.bat again at any time; it only changes what you agree to.'
Write-Info "If Windows ever asks whether to let Node.js through the firewall: tick only 'Private networks' and click Allow."
Write-Info 'If you clicked Cancel by mistake, run setup-pc.bat again.'
exit 0
