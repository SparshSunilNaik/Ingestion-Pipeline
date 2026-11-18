<#
.SYNOPSIS
  Development health check: backend liveness/readiness, agent runtime and frontend.
#>
param([string]$ApiBase = "http://127.0.0.1:8000", [string]$FrontendUrl = "http://localhost:3000")
. (Join-Path $PSScriptRoot "_common.ps1")
$ErrorActionPreference = "Continue"
$ok = $true

function Get-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 15 } catch { return $null }
}

$health = Get-Json "$ApiBase/api/health"
if ($health) { Write-Host "[ok]   backend $($health.version) at $ApiBase" -ForegroundColor Green }
else { Write-Host "[fail] backend not reachable at $ApiBase" -ForegroundColor Red; $ok = $false }

$ready = Get-Json "$ApiBase/api/health/ready"
if ($ready) {
    $color = if ($ready.status -eq "ok") { "Green" } else { "Yellow" }
    Write-Host "[$($ready.status)] database=$($ready.database) worker_running=$($ready.worker_running) git=$($ready.git)" -ForegroundColor $color
}

$agent = Get-Json "$ApiBase/api/agent/status"
if ($agent) {
    $color = if ($agent.agent_ready) { "Green" } else { "Yellow" }
    Write-Host "[agent] mode=$($agent.mode) available=$($agent.available) version=$($agent.version) model=$($agent.selected_model) ready=$($agent.agent_ready)" -ForegroundColor $color
    if ($agent.error) { Write-Host "        $($agent.error)" -ForegroundColor Yellow }
}

try {
    $r = Invoke-WebRequest -Uri $FrontendUrl -TimeoutSec 15 -UseBasicParsing
    Write-Host "[ok]   frontend HTTP $($r.StatusCode) at $FrontendUrl" -ForegroundColor Green
} catch { Write-Host "[warn] frontend not reachable at $FrontendUrl" -ForegroundColor Yellow }

if (-not $ok) { exit 1 }
