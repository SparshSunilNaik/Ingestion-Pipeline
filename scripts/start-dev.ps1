<#
.SYNOPSIS
  Start the backend (API + worker + private OpenCode) and the frontend, each in its own window.
.DESCRIPTION
  Both processes keep running until you close their windows (or press Ctrl+C in them).
  The frontend shows a "backend is not running" page with the start command if the backend
  is stopped, and recovers on its own once it is back.
#>
param([int]$BackendPort = 8000)
. (Join-Path $PSScriptRoot "_common.ps1")

function Test-Listening([int]$Port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (Test-Listening $BackendPort) {
    Write-Step "Something already listens on port $BackendPort; not starting another backend."
} else {
    Write-Step "Starting backend on http://127.0.0.1:$BackendPort"
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start-backend.ps1"), "-Port", $BackendPort -WorkingDirectory $RepoRoot
}

if (Test-Listening 3000) {
    Write-Step "Something already listens on port 3000; not starting another frontend."
} else {
    Write-Step "Starting frontend on http://localhost:3000"
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start-frontend.ps1"), "-ApiBase", "http://127.0.0.1:$BackendPort" -WorkingDirectory $RepoRoot
}

Write-Step "Open http://localhost:3000 (first start of the frontend compiles for ~20 s). Check status with scripts\health.ps1"
