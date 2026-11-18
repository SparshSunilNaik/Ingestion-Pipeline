<#
.SYNOPSIS
  Start the Next.js development server on http://localhost:3000.
#>
param([string]$ApiBase = "http://127.0.0.1:8000")
. (Join-Path $PSScriptRoot "_common.ps1")
$env:NEXT_PUBLIC_API_BASE = $ApiBase
Push-Location $FrontendDir
try { npm run dev } finally { Pop-Location }
