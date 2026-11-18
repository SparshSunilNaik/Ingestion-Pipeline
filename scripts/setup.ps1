<#
.SYNOPSIS
  Install backend and frontend dependencies on Windows.
.DESCRIPTION
  Checks tool versions, installs uv (per-user, via pip) if missing, syncs the Python
  environment with uv and installs frontend packages with npm ci.
#>
. (Join-Path $PSScriptRoot "_common.ps1")

Write-Step "Checking tools"
foreach ($tool in @("python", "node", "npm", "git")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" }
}
python --version
node --version
git --version
$pyOk = python -c "import sys; print(int(sys.version_info >= (3, 12)))"
if ($pyOk -ne "1") { throw "Python 3.12+ is required" }

$uv = Resolve-Uv
if (-not $uv) {
    Write-Step "Installing uv for the current user (pip install --user uv)"
    python -m pip install --user --quiet uv
    $uv = Resolve-Uv
    if (-not $uv) { throw "uv installation failed; install it from https://docs.astral.sh/uv/" }
}
& $uv --version

Write-Step "Syncing backend environment"
$env:UV_LINK_MODE = "copy"
Push-Location $BackendDir
try {
    & $uv sync
    if (-not (Test-Path ".env") -and (Test-Path ".env.example")) { Copy-Item ".env.example" ".env" }
} finally { Pop-Location }

Write-Step "Installing frontend packages"
Push-Location $FrontendDir
try { npm ci } finally { Pop-Location }

if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Write-Step "OpenCode detected: $(opencode --version)"
} else {
    Write-Warning "OpenCode not found on PATH. The deterministic pipeline works without it; agent reports require it."
}
Write-Step "Setup complete"
