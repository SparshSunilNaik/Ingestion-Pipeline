<#
.SYNOPSIS
  Stop the Code Atlas backend and frontend started from this repository (and their worker / OpenCode).
.DESCRIPTION
  Only processes that listen on the given ports AND whose command line lies inside this repository are
  stopped, together with their child processes. Nothing else is touched.
#>
param([int[]]$Ports = @(8000, 3000))
. (Join-Path $PSScriptRoot "_common.ps1")
$ErrorActionPreference = "Continue"

function Stop-Tree([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Tree $_.ProcessId }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$stopped = 0
foreach ($port in $Ports) {
    foreach ($conn in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
        if (-not $proc -or $proc.CommandLine -notlike "*$RepoRoot*") {
            Write-Host "port ${port}: owned by a process outside this repository; left running" -ForegroundColor Yellow
            continue
        }
        # Climb to the outermost launcher in this repository (npx / uv / venv launcher) so nothing respawns.
        $top = $proc
        while ($true) {
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($top.ParentProcessId)" -ErrorAction SilentlyContinue
            if (-not $parent -or $parent.CommandLine -notlike "*$RepoRoot*") { break }
            $top = $parent
        }
        Stop-Tree $top.ProcessId
        Write-Step "port ${port}: stopped process tree $($top.ProcessId)"
        $stopped++
    }
}
if ($stopped -eq 0) { Write-Step "Nothing from this repository was listening on ports $($Ports -join ', ')." }
