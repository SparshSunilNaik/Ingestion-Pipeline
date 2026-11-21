<#
.SYNOPSIS
  Start the FastAPI backend on 127.0.0.1. By default it supervises a separate worker process
  (IP_WORKER_MODE=subprocess) and a private OpenCode server.
.NOTES
  The API token is generated on first start in backend\data\api-token (readable only by you).
  Paste it into the login page once; the browser then uses an HttpOnly session cookie.
#>
param([int]$Port = 8000)
. (Join-Path $PSScriptRoot "_common.ps1")
$uv = Resolve-Uv
if (-not $uv) { throw "uv not found; run scripts/setup.ps1 first" }
$env:UV_LINK_MODE = "copy"
Push-Location $BackendDir
try {
    Write-Step "API token file: $(Join-Path $BackendDir 'data\api-token') (created on first start)"
    # uvicorn and Python logging write to stderr. With $ErrorActionPreference = "Stop", Windows PowerShell 5.1
    # turns the first captured stderr line into a terminating error and kills the server, so native
    # output must not be treated as an error here.
    $ErrorActionPreference = "Continue"
    # `python -m` avoids launcher .exe shims, which Windows Smart App Control may block.
    & $uv run python -m uvicorn app.main:app_factory --factory --host 127.0.0.1 --port $Port
} finally { Pop-Location }
