<#
.SYNOPSIS
  Development health check: backend liveness/readiness, agent runtime and frontend.
#>
param([string]$ApiBase = "http://127.0.0.1:8000", [string]$FrontendUrl = "http://localhost:3000")
. (Join-Path $PSScriptRoot "_common.ps1")
$ErrorActionPreference = "Continue"
$ok = $true

# Authenticated endpoints use the local API token (never printed).
$tokenFile = Join-Path $BackendDir "data\api-token"
$headers = @{}
if (Test-Path $tokenFile) { $headers["Authorization"] = "Bearer " + (Get-Content $tokenFile -Raw).Trim() }

function Get-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -Headers $headers -TimeoutSec 20 } catch { return $null }
}

$health = Get-Json "$ApiBase/api/health"
if ($health) { Write-Host "[ok]   backend $($health.version) at $ApiBase" -ForegroundColor Green }
else { Write-Host "[fail] backend not reachable at $ApiBase" -ForegroundColor Red; $ok = $false }

$ready = Get-Json "$ApiBase/api/health/ready"
if ($ready) {
    $color = if ($ready.status -eq "ok") { "Green" } else { "Yellow" }
    Write-Host "[$($ready.status)] database=$($ready.database) worker_running=$($ready.worker_running) worker_mode=$($ready.agent.worker_mode) auth=$($ready.agent.auth_mode) git=$($ready.git)" -ForegroundColor $color
}

$agent = Get-Json "$ApiBase/api/agent/status"
if (-not $agent -and -not (Test-Path $tokenFile)) { Write-Host "[warn] no API token file yet; start the backend once" -ForegroundColor Yellow }
if ($agent) {
    $color = if ($agent.agent_ready) { "Green" } else { "Yellow" }
    Write-Host "[agent] mode=$($agent.mode) available=$($agent.available) version=$($agent.version) model=$($agent.selected_model) ready=$($agent.agent_ready)" -ForegroundColor $color
    if ($agent.error) { Write-Host "        $($agent.error)" -ForegroundColor Yellow }
}

$repos = Get-Json "$ApiBase/api/repositories"
if ($repos) {
    Write-Host "[repos] $(@($repos).Count) repositories" -ForegroundColor Green
    foreach ($repo in @($repos)) {
        if ($repo.current) {
            Write-Host ("        {0}/{1}  snapshot {2}  commit {3}  analyzer {4}  ({5} snapshots)" -f $repo.owner, $repo.name, $repo.current.id, $repo.current.commit_sha.Substring(0, 12), $repo.current.analyzer_version, @($repo.snapshots).Count)
        }
    }
}

try {
    $r = Invoke-WebRequest -Uri $FrontendUrl -TimeoutSec 15 -UseBasicParsing
    Write-Host "[ok]   frontend HTTP $($r.StatusCode) at $FrontendUrl" -ForegroundColor Green
} catch { Write-Host "[warn] frontend not reachable at $FrontendUrl" -ForegroundColor Yellow }

if (-not $ok) { exit 1 }
