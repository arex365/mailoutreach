# Shared helpers for the Windows operations scripts. Dot-source it:  . (Join-Path $PSScriptRoot 'lib\ops-common.ps1')
# Plain ASCII on purpose: Windows PowerShell 5.1 reads files without a BOM as ANSI.

$script:OutreachRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:WebService = 'OutreachWeb'
$script:WorkerService = 'OutreachWorker'
$script:AppPort = 3000

function Get-OutreachRoot { return $script:OutreachRoot }

function Write-Title([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor White
    Write-Host ('=' * $Text.Length) -ForegroundColor White
}

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Write-Good([string]$Text) { Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "       $Text" }
function Write-Attention([string]$Text) { Write-Host "  [!]  $Text" -ForegroundColor Yellow }
function Write-Problem([string]$Text) { Write-Host "  [x]  $Text" -ForegroundColor Red }

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Asks a yes/no question. Enter gives the default.
function Read-YesNo([string]$Question, [bool]$Default = $false) {
    $hint = 'y/N'
    if ($Default) { $hint = 'Y/n' }
    while ($true) {
        $answer = Read-Host "  $Question ($hint)"
        if ($null -eq $answer) { return $Default }
        $a = $answer.Trim().ToLowerInvariant()
        if ($a -eq '') { return $Default }
        if ($a -eq 'y' -or $a -eq 'yes') { return $true }
        if ($a -eq 'n' -or $a -eq 'no') { return $false }
        Write-Attention 'Type Y for yes or N for no.'
    }
}

# Runs a program and returns its exit code and output (NUL bytes from UTF-16 programs removed).
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }
    $text = (($output -join "`n") -replace "`0", '').Trim()
    return [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Get-ServiceStatusText([string]$Name) {
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { return $null }
    return [string]$svc.Status
}

function Wait-ServiceStatus([string]$Name, [string]$Status, [int]$TimeoutSeconds = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ServiceStatusText $Name) -eq $Status) { return $true }
        Start-Sleep -Seconds 1
    }
    return ((Get-ServiceStatusText $Name) -eq $Status)
}

# The start.bat / start-demo.bat helper behind a pid file, or $null when it isn't running.
function Get-SupervisorProcess([string]$PidFile) {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $raw = Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue
    $procId = 0
    if (-not $raw -or -not [int]::TryParse($raw.Trim(), [ref]$procId)) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ($proc.Name -ne 'node.exe') { return $null }
    if ($proc.CommandLine -and ($proc.CommandLine -notmatch 'run-prod|start-demo')) { return $null }
    return $proc
}

function Test-PortListening([int]$Port) {
    $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$listen
}

function Get-PortOwnerNames([int]$Port) {
    $names = @()
    foreach ($c in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($p) { $names += ('{0} (process {1})' -f $p.ProcessName, $p.Id) }
    }
    return ($names | Select-Object -Unique)
}

# IPv4 addresses on the office network (skips virtual adapters, VPNs and 169.254.x.x).
function Get-LanAddresses {
    $virtual = 'vEthernet|VirtualBox|VMware|Hyper-V|Loopback|WSL|Docker|Bluetooth|Tailscale|ZeroTier|Hamachi|Radmin|OpenVPN|WireGuard|VPN|TAP-|Npcap'
    $list = @()
    foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
        if ($a.IPAddress -like '127.*' -or $a.IPAddress -like '169.254.*') { continue }
        if ($a.InterfaceAlias -match $virtual) { continue }
        if ($a.AddressState -and ([string]$a.AddressState) -ne 'Preferred') { continue }
        $list += [pscustomobject]@{ Address = $a.IPAddress; Alias = $a.InterfaceAlias }
    }
    return $list
}

# One look at http://127.0.0.1:<port>/api/health.
function Invoke-HealthCheck([int]$Port = 3000, [int]$TimeoutSec = 5) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSec
        $json = $null
        try { $json = $r.Content | ConvertFrom-Json } catch { $json = $null }
        $healthy = ([int]$r.StatusCode -eq 200) -and ($null -ne $json) -and [bool]$json.ok
        return [pscustomobject]@{ Answered = $true; Healthy = $healthy; Status = [int]$r.StatusCode; Json = $json }
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ Answered = ($null -ne $status); Healthy = $false; Status = $status; Json = $null }
    }
}

function Wait-Healthy([int]$Port = 3000, [int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Invoke-HealthCheck -Port $Port -TimeoutSec 4
        if ($last.Healthy) { return $last }
        Start-Sleep -Seconds 2
    }
    return $last
}

# Does a firewall port list (like "3000", "2000-4000", "Any", or several) include this port?
function Test-PortSpecCovers($Spec, [int]$Port) {
    foreach ($item in @($Spec)) {
        $s = [string]$item
        if ($s -match '^\d+$') {
            if ([int]$s -eq $Port) { return $true }
        } elseif ($s -match '^(\d+)-(\d+)$') {
            if ($Port -ge [int]$Matches[1] -and $Port -le [int]$Matches[2]) { return $true }
        }
    }
    return $false
}

# Enabled inbound firewall rules that matter for the app:
#   Kind 'PublicAllow' - allows node.exe or TCP 3000 on public networks (cafe Wi-Fi etc.)
#   Kind 'Block'       - blocks node.exe or TCP 3000 (office computers can't reach the app)
# Throws when Windows won't let this window read the firewall rules.
function Get-FirewallFindings([int]$Port = 3000) {
    $findings = @()
    $rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction Stop)
    if ($rules.Count -eq 0) { return $findings }
    $programs = @{}
    foreach ($f in @(Get-NetFirewallApplicationFilter -All -ErrorAction Stop)) { $programs[$f.InstanceID] = [string]$f.Program }
    # Reading every port filter at once needs administrator rights; one rule at a time doesn't.
    $ports = $null
    try {
        $ports = @{}
        foreach ($f in @(Get-NetFirewallPortFilter -All -ErrorAction Stop)) { $ports[$f.InstanceID] = $f }
    } catch {
        $ports = $null
    }
    foreach ($r in $rules) {
        $program = [string]$programs[$r.InstanceID]
        $isNode = ($program -match '(^|\\)node\.exe$')
        $anyProgram = (-not $program) -or ($program -eq 'Any')
        # A rule for one specific other program can't open or block node.exe.
        if (-not $isNode -and -not $anyProgram) { continue }
        $coversPort = $false
        if (-not $isNode) {
            if ($null -ne $ports) { $pf = $ports[$r.InstanceID] }
            else { $pf = $r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue }
            if ($pf) {
                $proto = [string]$pf.Protocol
                if ($proto -eq 'TCP' -or $proto -eq 'Any') { $coversPort = Test-PortSpecCovers $pf.LocalPort $Port }
            }
        }
        if (-not ($isNode -or $coversPort)) { continue }
        $profileValue = [int]$r.Profile
        $coversPublic = ($profileValue -eq 0) -or (($profileValue -band 4) -ne 0)
        $what = 'node.exe'
        if (-not $isNode) { $what = "TCP port $Port" }
        $action = [string]$r.Action
        if ($action -eq 'Allow' -and $coversPublic) {
            $findings += [pscustomobject]@{ Kind = 'PublicAllow'; Name = $r.Name; DisplayName = $r.DisplayName; What = $what; IsNode = $isNode; Profile = [string]$r.Profile }
        } elseif ($action -eq 'Block') {
            $findings += [pscustomobject]@{ Kind = 'Block'; Name = $r.Name; DisplayName = $r.DisplayName; What = $what; IsNode = $isNode; Profile = [string]$r.Profile }
        }
    }
    return $findings
}

# node.exe that the services will run (full path), or $null.
function Get-NodePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $cmd) { return $null }
    return $cmd.Source
}

function Show-GetNssmHelp {
    Write-Info 'tools\nssm.exe (the small program that runs the app as a Windows service) is missing or changed.'
    Write-Info 'To get it again, do ONE of these, then run install-services.bat again:'
    Write-Info '  a) In PowerShell in this folder:'
    Write-Info '       powershell -NoProfile -ExecutionPolicy Bypass -File scripts\get-nssm.ps1'
    Write-Info '     It downloads NSSM 2.24-101 from nssm.cc and checks its fingerprint.'
    Write-Info '  b) winget install --id NSSM.NSSM -e'
    Write-Info '     then copy nssm.exe (64-bit) into the tools folder and write its SHA-256 into tools\nssm.sha256:'
    Write-Info '       (Get-FileHash tools\nssm.exe -Algorithm SHA256).Hash | Set-Content tools\nssm.sha256'
    Write-Info 'If your antivirus removed it, see docs\setup\1-install.md, Troubleshooting.'
}

# Checks tools\nssm.exe against tools\nssm.sha256. Returns the path, or $null (and explains).
function Get-VerifiedNssm {
    $root = Get-OutreachRoot
    $nssm = Join-Path $root 'tools\nssm.exe'
    $shaFile = Join-Path $root 'tools\nssm.sha256'
    if (-not (Test-Path -LiteralPath $nssm) -or -not (Test-Path -LiteralPath $shaFile)) {
        Write-Problem 'tools\nssm.exe or tools\nssm.sha256 is missing.'
        Show-GetNssmHelp
        return $null
    }
    $expected = ((Get-Content -LiteralPath $shaFile -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
    $actual = (Get-FileHash -LiteralPath $nssm -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($expected -ne $actual) {
        Write-Problem "tools\nssm.exe isn't the file that was checked (its fingerprint differs), so it isn't used."
        Show-GetNssmHelp
        return $null
    }
    return $nssm
}
