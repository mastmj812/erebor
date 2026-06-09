# start.ps1 - bring up erebor for local dev (backend :8077 + frontend :5180).
#
#   Right-click -> "Run with PowerShell", or from a terminal:  .\start.ps1
#
# The 'oilgas' warehouse (postgresql-x64-18 service) auto-starts on boot, so the
# only thing this does is launch the two dev servers (each in its own window so
# you can watch logs / Ctrl+C them) and open the app once the backend is healthy.
#
#   .\start.ps1            # start both, open the browser
#   .\start.ps1 -NoBrowser # start both, don't open the browser

param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$root     = $PSScriptRoot
$python   = Join-Path $root ".venv\Scripts\python.exe"
$backend  = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

function Test-Port([int]$port) {
    $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# --- 1. Warehouse reachable? (oilgas on :5432) ---------------------------------
if (-not (Test-Port 5432)) {
    Write-Warning "Nothing is listening on localhost:5432 - the 'oilgas' warehouse may be down."
    Write-Host   "  Try: Start-Service postgresql-x64-18    (then re-run this script)"
    Read-Host "Press Enter to continue anyway, or Ctrl+C to abort"
} else {
    Write-Host "[ok] warehouse port 5432 is listening" -ForegroundColor Green
}

# --- 2. Backend (uvicorn :8077) ------------------------------------------------
if (Test-Port 8077) {
    Write-Host "[skip] backend already running on :8077" -ForegroundColor Yellow
} else {
    if (-not (Test-Path $python)) { throw "venv python not found at $python - create the venv first." }
    Write-Host "[start] backend -> http://localhost:8077" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "Set-Location '$backend'; & '$python' -m uvicorn app.main:app --port 8077 --reload"
    )
}

# --- 3. Frontend (vite :5180) --------------------------------------------------
if (Test-Port 5180) {
    Write-Host "[skip] frontend already running on :5180" -ForegroundColor Yellow
} else {
    Write-Host "[start] frontend -> http://localhost:5180" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "Set-Location '$frontend'; npm run dev"
    )
}

# --- 4. Wait for the backend to bind :8077, then open the app ------------------
# A raw TCP port check (Test-Port) is used rather than an HTTP request: under a
# system proxy, Invoke-WebRequest to localhost times out, so HTTP is unreliable
# here. Once uvicorn is listening, the app is ready.
Write-Host "waiting for backend on :8077..." -NoNewline
$up = $false
foreach ($i in 1..30) {
    if (Test-Port 8077) { $up = $true; break }
    Start-Sleep -Seconds 1
    Write-Host "." -NoNewline
}
Write-Host ""

if ($up) {
    Write-Host "[ok] backend listening on :8077" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process "http://localhost:5180" }
    Write-Host "erebor is up -> http://localhost:5180  (Highgrade tab is top-center)" -ForegroundColor Green
} else {
    Write-Warning "Backend never bound :8077 - check the backend window for errors."
}
