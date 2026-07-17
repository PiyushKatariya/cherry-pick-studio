# =============================================================================
# studio.ps1 - Launch engine for Cherry-Pick Studio.
# Used by the .bat launchers. Modes:
#   web      -> start (or reopen) the browser UI on a FREE port
#   desktop  -> start the Electron desktop app
#   all      -> smart combined: start ONLY whatever is not already running
# Each project is checked independently, so killing one and re-running 'all'
# starts only the missing one.
# =============================================================================
param(
    [ValidateSet('all', 'web', 'desktop')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
$ServerScript = Join-Path $AppDir 'server\server.js'
$ElectronExe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'

function Write-Head($text) {
    Write-Host ''
    Write-Host ' ============================================================'
    Write-Host "  $text"
    Write-Host ' ============================================================'
}

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Ensure-Deps {
    if (Test-Path (Join-Path $AppDir 'node_modules')) {
        Write-Host ' [OK] Dependencies present.'
        return
    }
    Write-Host ' [INFO] Installing dependencies (npm install)...'
    Push-Location $AppDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    }
    finally { Pop-Location }
    Write-Host ' [OK] Dependencies installed.'
}

function Get-FreePort {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $l.Start()
    $port = $l.LocalEndpoint.Port
    $l.Stop()
    return $port
}

function Get-WebProcess {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
    return ($procs.Where({ $_.CommandLine -like '*cherry-pick-studio*server.js*' }, 'First') | Select-Object -First 1)
}

function Get-WebPort($proc) {
    if (-not $proc) { return $null }
    $conn = Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.LocalPort }
    return $null
}

function Get-DesktopProcesses {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'")
    return @($procs.Where({ $_.ExecutablePath -like '*cherry-pick-studio*' }))
}

function Start-Web {
    Write-Host ''
    Write-Host ' ------------------------------------------------------------'
    Write-Host '  WEB server'
    Write-Host ' ------------------------------------------------------------'

    $proc = Get-WebProcess
    if ($proc) {
        $port = Get-WebPort $proc
        if ($port) {
            Write-Host " [SKIP] Web already running on port $port - opening browser."
            Start-Process "http://localhost:$port"
        }
        else {
            Write-Host ' [SKIP] Web already running (port could not be detected).'
        }
        return
    }

    $port = Get-FreePort
    Write-Host " [START] Web not running. Starting on free port $port ..."

    # Launch the server in its own console window that stays open.
    $node = Find-Node
    $inner = "set PORT=$port&& `"$node`" `"$ServerScript`""
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $inner) -WorkingDirectory $AppDir

    Start-Sleep -Seconds 2
    Start-Process "http://localhost:$port"
    Write-Host " [OK] Web launched: http://localhost:$port"
}

function Start-Desktop {
    Write-Host ''
    Write-Host ' ------------------------------------------------------------'
    Write-Host '  DESKTOP app'
    Write-Host ' ------------------------------------------------------------'

    $running = Get-DesktopProcesses
    if ($running.Count -gt 0) {
        Write-Host " [SKIP] Desktop already running ($($running.Count) process(es))."
        return
    }

    if (-not (Test-Path $ElectronExe)) {
        Write-Host ' [ERROR] Electron binary missing:'
        Write-Host "   $ElectronExe"
        Write-Host '   Fix with:  npm install electron --force'
        return
    }

    Write-Host ' [START] Desktop not running. Starting it...'
    # Quote the app path: it can contain spaces (e.g. "D:\Piyush Katariya\...").
    Start-Process -FilePath $ElectronExe -ArgumentList @("`"$AppDir`"") -WorkingDirectory $AppDir
    Write-Host ' [OK] Desktop app launched.'
}

# ----- Main -----
Write-Head "Cherry-Pick Studio - $($Mode.ToUpper())"

$node = Find-Node
if (-not $node) {
    Write-Host ' [ERROR] Node.js is not installed or not found.'
    Write-Host '         Install it from: https://nodejs.org/'
    exit 1
}
Write-Host " [OK] Node.js: $node"

if (-not (Test-Path $ServerScript)) {
    Write-Host " [ERROR] server\server.js not found in: $AppDir"
    exit 1
}

Ensure-Deps

if ($Mode -eq 'all' -or $Mode -eq 'web') { Start-Web }
if ($Mode -eq 'all' -or $Mode -eq 'desktop') { Start-Desktop }

Write-Host ''
Write-Host ' Done.'
exit 0
