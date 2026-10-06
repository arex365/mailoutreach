# Downloads NSSM 2.24-101 (the helper that runs the app as a Windows service) into tools\nssm.exe.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\get-nssm.ps1
# The download is only used when its SHA-256 matches the known value; nothing else is ever substituted.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ops-common.ps1')
$root = Get-OutreachRoot
$url = 'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip'
$zipSha256 = '99F5045FFFBFFB745D67FE3A065A953C4A3D9C253B868892D9B685B0EE7D07B8'

Write-Title 'Download NSSM 2.24-101'
$zip = Join-Path ([IO.Path]::GetTempPath()) ('nssm-{0}.zip' -f [Guid]::NewGuid().ToString('N'))
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Info "Downloading $url ..."
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 120
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actual -ne $zipSha256) {
        Write-Problem "The download's fingerprint doesn't match ($actual), so it was not used."
        Write-Info 'Try again later, or: winget install --id NSSM.NSSM -e, then copy nssm.exe into the tools folder.'
        exit 1
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entry = $archive.Entries | Where-Object { $_.FullName -match '(^|/)win64/nssm\.exe$' } | Select-Object -First 1
        if (-not $entry) { throw 'win64\nssm.exe is not in the download.' }
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'tools') | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $root 'tools\nssm.exe'), $true)
    } finally {
        $archive.Dispose()
    }
    $hash = (Get-FileHash -LiteralPath (Join-Path $root 'tools\nssm.exe') -Algorithm SHA256).Hash
    Set-Content -LiteralPath (Join-Path $root 'tools\nssm.sha256') -Value $hash -Encoding ASCII
    Write-Good "tools\nssm.exe is ready (SHA-256 $hash)."
} catch {
    Write-Problem "Couldn't get NSSM: $($_.Exception.Message)"
    Write-Info 'Try again later, or: winget install --id NSSM.NSSM -e, then copy nssm.exe into the tools folder.'
    exit 1
} finally {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}
exit 0
