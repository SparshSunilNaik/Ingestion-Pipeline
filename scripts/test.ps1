<#
.SYNOPSIS
  Run linters, type checks and tests for backend and frontend.
.PARAMETER Live
  Also run opt-in live tests (real GitHub clone and a real OpenCode model call).
.PARAMETER BackendOnly
  Skip frontend checks.
#>
param([switch]$Live, [switch]$BackendOnly)
. (Join-Path $PSScriptRoot "_common.ps1")
$uv = Resolve-Uv
if (-not $uv) { throw "uv not found; run scripts/setup.ps1 first" }
$env:UV_LINK_MODE = "copy"
$failed = @()

function Invoke-Check([string]$Name, [scriptblock]$Block) {
    Write-Step $Name
    & $Block
    if ($LASTEXITCODE -ne 0) { $script:failed += $Name }
}

Push-Location $BackendDir
try {
    Invoke-Check "ruff lint" { & $uv run python -m ruff check . }
    Invoke-Check "ruff format check" { & $uv run python -m ruff format --check . }
    Invoke-Check "mypy" { & $uv run python -m mypy }
    if ($Live) { $env:IP_LIVE_TESTS = "1" } else { Remove-Item Env:IP_LIVE_TESTS -ErrorAction SilentlyContinue }
    Invoke-Check "pytest" { & $uv run python -m pytest tests -rs }
} finally { Pop-Location }

if (-not $BackendOnly) {
    Push-Location $FrontendDir
    try {
        Invoke-Check "eslint" { npm run lint }
        Invoke-Check "tsc" { npx tsc --noEmit }
        Invoke-Check "next build" { npm run build }
    } finally { Pop-Location }
}

if ($failed.Count -gt 0) {
    Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "All checks passed" -ForegroundColor Green
