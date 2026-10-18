<#
.SYNOPSIS
  Cleanly stop the remote MCP gateway, idle watcher, and Reason Network daemon.
#>
param(
  [switch]$KeepDaemon
)

. "$PSScriptRoot\common.ps1"
Ensure-RnDirs

$state = Read-RnState
if ($state) {
  if ($state.idleWatchPid) {
    Write-Host "Stopping idle-watch PID $($state.idleWatchPid)"
    Stop-RnPidTree ([int]$state.idleWatchPid)
  }
  if ($state.launcherPid) {
    Write-Host "Stopping launcher PID $($state.launcherPid)"
    Stop-RnPidTree ([int]$state.launcherPid)
  }
  if ($state.gatewayPid) {
    Write-Host "Stopping gateway PID $($state.gatewayPid)"
    Stop-RnPidTree ([int]$state.gatewayPid)
  }
}

# Also catch orphaned cmd/npx/supergateway on our port
try {
  $listeners = Get-NetTCPConnection -LocalPort $script:RnPort -State Listen -ErrorAction SilentlyContinue
  foreach ($l in @($listeners)) {
    if ($l.OwningProcess) {
      Write-Host "Stopping listener PID $($l.OwningProcess) on port $($script:RnPort)"
      Stop-RnPidTree ([int]$l.OwningProcess)
    }
  }
} catch {}

if (-not $KeepDaemon) {
  Stop-RnDaemonByCommandLine
}

$stoppedAt = (Get-Date).ToString('o')
if ($state) {
  $ht = @{
    stoppedAt      = $stoppedAt
    lastActivityAt = $state.lastActivityAt
    port           = $script:RnPort
    host           = $script:RnHost
    localMcpUrl    = $state.localMcpUrl
    status         = 'stopped'
  }
  Write-RnState $ht
} else {
  Write-RnState @{ stoppedAt = $stoppedAt; status = 'stopped'; port = $script:RnPort }
}

Start-Sleep -Milliseconds 400
$still = Get-RnListening
Write-Host "Port $($script:RnPort) listening: $still"
Write-Host "Stopped. State: $script:RnStateFile"

