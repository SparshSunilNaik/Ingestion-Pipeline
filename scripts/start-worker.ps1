<#
.SYNOPSIS
  Run a standalone worker process (for IP_WORKER_MODE=external). Several workers may run safely:
  jobs are claimed atomically and each job runs in its own child process with a timeout.
#>
. (Join-Path $PSScriptRoot "_common.ps1")
$uv = Resolve-Uv
if (-not $uv) { throw "uv not found; run scripts/setup.ps1 first" }
$env:UV_LINK_MODE = "copy"
Push-Location $BackendDir
try { & $uv run python -m app.worker_main } finally { Pop-Location }
