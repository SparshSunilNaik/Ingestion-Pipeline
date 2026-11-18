# Shared helpers for Ingestion-Pipeline PowerShell scripts.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Resolve-Uv {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # `pip install --user uv` places uv in the per-user Scripts directory.
    $userScripts = & python -c "import sysconfig; print(sysconfig.get_path('scripts', f'{__import__('os').name}_user'))" 2>$null
    if ($userScripts) {
        $candidate = Join-Path $userScripts "uv.exe"
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}
