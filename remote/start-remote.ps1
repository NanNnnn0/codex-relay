<#
.SYNOPSIS
  Start Codex Relay MCP over Streamable HTTP via supergateway (localhost only).

.DESCRIPTION
  - Requires Node >= 22
  - Auto-starts the named-pipe daemon via mcp-bridge
  - Exposes http://127.0.0.1:3920/mcp (default)
  - Writes state + API key under %LOCALAPPDATA%\ReasonNetwork\remote\
  - Optionally starts idle-watch.ps1

.PARAMETER SkipIdleWatch
  Do not launch the idle watcher.

.PARAMETER IdleMinutes
  Idle minutes before auto-stop (default 15, or REASON_NETWORK_REMOTE_IDLE_MINUTES).
#>
param(
  [switch]$SkipIdleWatch,
  [int]$IdleMinutes = 0
)

. "$PSScriptRoot\common.ps1"
Ensure-RnDirs

if ($IdleMinutes -gt 0) { $script:RnIdleMinutes = $IdleMinutes }

$nodeInfo = Assert-RnNodeVersion
$npx = Get-RnNpx
$nodeDir = Split-Path $nodeInfo.Path -Parent
$bridge = Join-Path $script:RnRoot 'src\mcp-bridge.js'
if (-not (Test-Path -LiteralPath $bridge)) {
  throw "mcp-bridge.js not found at $bridge"
}

$existing = Read-RnState
if ($existing -and $existing.gatewayPid -and (Test-RnProcessAlive ([int]$existing.gatewayPid)) -and (Get-RnListening)) {
  Write-Host "Already running."
  Write-Host "  Local MCP URL : $($existing.localMcpUrl)"
  Write-Host "  Health        : $($existing.healthUrl)"
  Write-Host "  API key file  : $script:RnApiKeyFile"
  Write-Host "  State         : $script:RnStateFile"
  if (-not $SkipIdleWatch) {
    $watchAlive = $existing.idleWatchPid -and (Test-RnProcessAlive ([int]$existing.idleWatchPid))
    if (-not $watchAlive) {
      Write-Host "Idle watch not running; starting it..."
      $watchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:RnRemoteDir 'idle-watch.ps1'), '-IdleMinutes', $script:RnIdleMinutes)
      $wp = Start-Process -FilePath 'powershell.exe' -ArgumentList $watchArgs -WindowStyle Hidden -PassThru
      $ht = @{}
      $existing.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
      $ht.idleWatchPid = $wp.Id
      Write-RnState $ht
    }
  }
  exit 0
}

$apiKey = Get-OrCreate-RnApiKey
$now = (Get-Date).ToString('o')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $script:RnLogDir "gateway-$stamp.log"
$errLog = Join-Path $script:RnLogDir "gateway-$stamp.err.log"

# Use PATH `node` + relative bridge path so --stdio has no spaces (avoids Program Files split).
# The launcher inherits its working directory from Start-Process below. Keep the
# generated .cmd ASCII-only: the project path contains Chinese characters and
# PowerShell's ASCII encoding would otherwise turn them into question marks.
$stdioCmd = 'node src/mcp-bridge.js'

Write-Host "Node          : $($nodeInfo.Path) $($nodeInfo.Version)"
Write-Host "Project root  : $($script:RnRoot)"
Write-Host "Agent/session : $($script:RnAgent) / $($script:RnSession)"
Write-Host "CWD           : $($script:RnCwd)"
Write-Host "Gateway       : npx -y supergateway (streamableHttp :$($script:RnPort)/mcp)"
Write-Host "Log           : $outLog"

# Redirect inside cmd (not Start-Process), and feed NUL to stdin so supergateway
# does not exit when the launcher's stdin pipe closes.
$wrapper = Join-Path $script:RnStateDir 'run-gateway.cmd'
$wrapperBody = @"
@echo off
set "PATH=$nodeDir;%PATH%"
set "SUPERGATEWAY_API_KEY=$apiKey"
"$npx" -y supergateway --stdio "$stdioCmd" --outputTransport streamableHttp --stateful --sessionTimeout 1800000 --port $($script:RnPort) --host $($script:RnHost) --streamableHttpPath /mcp --healthEndpoint /healthz --apiKey "$apiKey" --logLevel info < NUL >> "$outLog" 2>> "$errLog"
"@
Set-Content -LiteralPath $wrapper -Value $wrapperBody -Encoding ASCII

# Do NOT RedirectStandardOutput/Error/Input here — that closes stdin and kills supergateway.
$oldAgent = $env:REASON_NETWORK_AGENT
$oldSession = $env:REASON_NETWORK_SESSION
$oldCwd = $env:REASON_NETWORK_CWD
$oldDelegation = $env:REASON_NETWORK_DELEGATION
$env:REASON_NETWORK_AGENT = $script:RnAgent
$env:REASON_NETWORK_SESSION = $script:RnSession
$env:REASON_NETWORK_CWD = $script:RnCwd
$env:REASON_NETWORK_DELEGATION = $script:RnDelegation
try {
  $gp = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$wrapper`"") `
    -WorkingDirectory $script:RnRoot `
    -WindowStyle Hidden `
    -PassThru
} finally {
  $env:REASON_NETWORK_AGENT = $oldAgent
  $env:REASON_NETWORK_SESSION = $oldSession
  $env:REASON_NETWORK_CWD = $oldCwd
  $env:REASON_NETWORK_DELEGATION = $oldDelegation
}

$localMcpUrl = "http://$($script:RnHost):$($script:RnPort)/mcp"
$healthUrl = "http://$($script:RnHost):$($script:RnPort)/healthz"

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-RnProcessAlive $gp.Id)) {
    # cmd /c may exit after spawning if something odd happens; also check port
    if (Get-RnListening) { $ready = (Invoke-RnHealthCheck); if ($ready) { break } }
    $errTail = if (Test-Path $errLog) { Get-Content $errLog -Tail 50 -ErrorAction SilentlyContinue } else { @() }
    $outTail = if (Test-Path $outLog) { Get-Content $outLog -Tail 50 -ErrorAction SilentlyContinue } else { @() }
    throw ("Gateway exited early (launcher PID {0}). stderr:`n{1}`nstdout:`n{2}" -f $gp.Id, ($errTail -join "`n"), ($outTail -join "`n"))
  }
  if (Invoke-RnHealthCheck) { $ready = $true; break }
}

if (-not $ready) {
  Write-Warning "Health check not green yet; gateway may still be installing. Check:"
  Write-Warning "  $outLog"
  Write-Warning "  $errLog"
}

# Prefer the process that actually owns the listen port (npx/node), not only cmd launcher
$listenPid = $gp.Id
try {
  $l = Get-NetTCPConnection -LocalPort $script:RnPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($l -and $l.OwningProcess) { $listenPid = [int]$l.OwningProcess }
} catch {}

$idleWatchPid = 0
if (-not $SkipIdleWatch) {
  $watchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:RnRemoteDir 'idle-watch.ps1'), '-IdleMinutes', $script:RnIdleMinutes)
  $wp = Start-Process -FilePath 'powershell.exe' -ArgumentList $watchArgs -WindowStyle Hidden -PassThru
  $idleWatchPid = $wp.Id
}

$state = @{
  startedAt       = $now
  lastActivityAt  = $now
  gatewayPid      = $listenPid
  launcherPid     = $gp.Id
  idleWatchPid    = $idleWatchPid
  port            = $script:RnPort
  host            = $script:RnHost
  localMcpUrl     = $localMcpUrl
  healthUrl       = $healthUrl
  transport       = 'streamableHttp'
  agent           = $script:RnAgent
  session         = $script:RnSession
  cwd             = $script:RnCwd
  delegation      = $script:RnDelegation
  nodePath        = $nodeInfo.Path
  nodeVersion     = $nodeInfo.Version
  gatewayLog      = $outLog
  gatewayErrLog   = $errLog
  idleMinutes     = $script:RnIdleMinutes
  apiKeyFile      = $script:RnApiKeyFile
  stdioCommand    = $stdioCmd
  note            = 'Expose via Tailscale Serve; AddMcpServer with https URL ending in /mcp; Bearer token from api-key.txt'
}
Write-RnState $state

Write-Host ""
Write-Host "=== reason-network remote started ==="
Write-Host "  Local MCP URL : $localMcpUrl"
Write-Host "  Health        : $healthUrl"
Write-Host "  Gateway PID   : $listenPid (launcher $($gp.Id))"
Write-Host "  Idle watch    : $(if ($idleWatchPid) { $idleWatchPid } else { 'skipped' }) (idle $($script:RnIdleMinutes) min)"
Write-Host "  API key file  : $script:RnApiKeyFile"
Write-Host "  State         : $script:RnStateFile"
Write-Host ""
Write-Host "Next: publish with Tailscale Serve (see remote/README.md), then give the coordinator the HTTPS URL."
Write-Host "API key (also in file): $apiKey"
