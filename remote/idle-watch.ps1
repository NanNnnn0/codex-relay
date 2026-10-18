<#
.SYNOPSIS
  Watch MCP port activity; call stop-remote.ps1 after N minutes with no clients.

.DESCRIPTION
  Polls Established TCP connections on the remote port. Any connection refreshes
  lastActivityAt in the state file. When idle longer than IdleMinutes, stops
  gateway + daemon via stop-remote.ps1.

.PARAMETER IdleMinutes
  Minutes without Established connections before stop (default 15).

.PARAMETER PollSeconds
  Poll interval (default 30).
#>
param(
  [int]$IdleMinutes = 0,
  [int]$PollSeconds = 30
)

. "$PSScriptRoot\common.ps1"
Ensure-RnDirs

if ($IdleMinutes -gt 0) { $script:RnIdleMinutes = $IdleMinutes }
if ($script:RnIdleMinutes -lt 1) { $script:RnIdleMinutes = 15 }

$watchLog = Join-Path $script:RnLogDir 'idle-watch.log'
function Write-WatchLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $watchLog -Value $line -Encoding UTF8
  Write-Host $line
}

Write-WatchLog "idle-watch started; idleMinutes=$($script:RnIdleMinutes) pollSeconds=$PollSeconds port=$($script:RnPort)"

while ($true) {
  Start-Sleep -Seconds $PollSeconds

  $state = Read-RnState
  if (-not $state -or $state.status -eq 'stopped') {
    Write-WatchLog 'No running state; exiting idle-watch.'
    break
  }

  $gatewayAlive = $state.gatewayPid -and (Test-RnProcessAlive ([int]$state.gatewayPid))
  $listening = Get-RnListening
  if (-not $gatewayAlive -and -not $listening) {
    Write-WatchLog 'Gateway gone; exiting idle-watch.'
    break
  }

  $established = Get-RnEstablishedCount
  $now = Get-Date
  $ht = @{}
  $state.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }

  if ($established -gt 0) {
    $ht.lastActivityAt = $now.ToString('o')
    $ht.lastEstablishedCount = $established
    Write-RnState $ht
    continue
  }

  # Also treat a successful recent health from an external probe as non-idle?
  # No — health checks alone should NOT reset idle (Tailscale/monitoring).
  # Only Established client connections count.

  $last = $null
  if ($ht.lastActivityAt) {
    try { $last = [datetime]::Parse($ht.lastActivityAt) } catch { $last = $null }
  }
  if (-not $last -and $ht.startedAt) {
    try { $last = [datetime]::Parse($ht.startedAt) } catch { $last = $now }
  }
  if (-not $last) { $last = $now }

  $idleFor = ($now - $last).TotalMinutes
  if ($idleFor -ge $script:RnIdleMinutes) {
    Write-WatchLog ("Idle {0:N1} min (>= {1}); calling stop-remote.ps1" -f $idleFor, $script:RnIdleMinutes)
    & (Join-Path $script:RnRemoteDir 'stop-remote.ps1')
    Write-WatchLog 'stop-remote finished; exiting.'
    break
  }
}
