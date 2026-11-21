<#
.SYNOPSIS
  Start the Next.js development server on http://localhost:3000.
#>
param([string]$ApiBase = "http://127.0.0.1:8000")
. (Join-Path $PSScriptRoot "_common.ps1")
# Read by the /api proxy route (frontend/lib/proxy.ts).
$env:IP_BACKEND_URL = $ApiBase
Push-Location $FrontendDir
# Native stderr (logs) must not terminate the script under Windows PowerShell 5.1.
$ErrorActionPreference = "Continue"
try { npm run dev } finally { Pop-Location }
