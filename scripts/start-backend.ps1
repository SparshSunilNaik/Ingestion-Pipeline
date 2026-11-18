<#
.SYNOPSIS
  Start the FastAPI backend (and its in-process job worker) on 127.0.0.1.
#>
param([int]$Port = 8000)
. (Join-Path $PSScriptRoot "_common.ps1")
$uv = Resolve-Uv
if (-not $uv) { throw "uv not found; run scripts/setup.ps1 first" }
$env:UV_LINK_MODE = "copy"
Push-Location $BackendDir
try {
    # `python -m` avoids launcher .exe shims, which Windows Smart App Control may block.
    & $uv run python -m uvicorn app.main:app_factory --factory --host 127.0.0.1 --port $Port
} finally { Pop-Location }
