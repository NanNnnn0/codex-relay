# Shared helpers for reason-network-local remote package.
# Dot-source from other scripts: . "$PSScriptRoot\common.ps1"

$ErrorActionPreference = 'Stop'

$script:RnRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:RnRemoteDir = $PSScriptRoot
$script:RnStateDir = Join-Path $env:LOCALAPPDATA 'ReasonNetwork\remote'
$script:RnStateFile = Join-Path $script:RnStateDir 'state.json'
$script:RnLogDir = Join-Path $script:RnStateDir 'logs'
$script:RnApiKeyFile = Join-Path $script:RnStateDir 'api-key.txt'

# Defaults (override via env before calling scripts)
$script:RnPort = if ($env:REASON_NETWORK_REMOTE_PORT) { [int]$env:REASON_NETWORK_REMOTE_PORT } else { 3920 }
$script:RnHost = if ($env:REASON_NETWORK_REMOTE_HOST) { $env:REASON_NETWORK_REMOTE_HOST } else { '127.0.0.1' }
$script:RnIdleMinutes = if ($env:REASON_NETWORK_REMOTE_IDLE_MINUTES) { [int]$env:REASON_NETWORK_REMOTE_IDLE_MINUTES } else { 15 }
$script:RnAgent = if ($env:REASON_NETWORK_AGENT) { $env:REASON_NETWORK_AGENT } else { 'grokbot' }
$script:RnSession = if ($env:REASON_NETWORK_SESSION) { $env:REASON_NETWORK_SESSION } else { 'grokbot-main' }
$script:RnCwd = if ($env:REASON_NETWORK_CWD) { $env:REASON_NETWORK_CWD } else { $script:RnRoot }
$script:RnDelegation = if ($env:REASON_NETWORK_DELEGATION) { $env:REASON_NETWORK_DELEGATION } else { 'enabled' }

function Ensure-RnDirs {
  New-Item -ItemType Directory -Path $script:RnStateDir -Force | Out-Null
  New-Item -ItemType Directory -Path $script:RnLogDir -Force | Out-Null
}

function Get-RnNode {
  $candidates = @(
    $env:REASON_NETWORK_NODE,
    'C:\Program Files\nodejs\node.exe',
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  ) | Where-Object { $_ }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  throw 'Node.js not found. Install Node 22+ (24 recommended) or set REASON_NETWORK_NODE.'
}

function Assert-RnNodeVersion {
  $node = Get-RnNode
  $ver = & $node -v 2>&1
  if ($ver -notmatch '^v(\d+)\.') { throw "Cannot parse Node version from: $ver" }
  $major = [int]$Matches[1]
  if ($major -lt 22) {
    throw "Node $ver is too old. reason-network-local requires Node >= 22 (got major $major)."
  }
  return @{ Path = $node; Version = $ver; Major = $major }
}

function Get-RnNpx {
  $dir = Split-Path (Get-RnNode) -Parent
  foreach ($name in @('npx.cmd', 'npx')) {
    $p = Join-Path $dir $name
    if (Test-Path -LiteralPath $p) { return $p }
  }
  $cmd = Get-Command npx -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'npx not found next to node. Reinstall Node.js.'
}

function Read-RnState {
  if (-not (Test-Path -LiteralPath $script:RnStateFile)) { return $null }
  try {
    return Get-Content -LiteralPath $script:RnStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-RnState([hashtable]$State) {
  Ensure-RnDirs
  $json = $State | ConvertTo-Json -Depth 6
  Set-Content -LiteralPath $script:RnStateFile -Value $json -Encoding UTF8
}

function Get-OrCreate-RnApiKey {
  Ensure-RnDirs
  if ($env:REASON_NETWORK_REMOTE_API_KEY) { return $env:REASON_NETWORK_REMOTE_API_KEY }
  if ($env:SUPERGATEWAY_API_KEY) { return $env:SUPERGATEWAY_API_KEY }
  if (Test-Path -LiteralPath $script:RnApiKeyFile) {
    $existing = (Get-Content -LiteralPath $script:RnApiKeyFile -Raw -Encoding UTF8).Trim()
    if ($existing) { return $existing }
  }
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x')
  Set-Content -LiteralPath $script:RnApiKeyFile -Value $key -Encoding ASCII -NoNewline
  return $key
}

function Test-RnProcessAlive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    return $null -ne $p
  } catch { return $false }
}

function Get-RnEstablishedCount {
  try {
    return @(Get-NetTCPConnection -LocalPort $script:RnPort -State Established -ErrorAction SilentlyContinue).Count
  } catch { return 0 }
}

function Get-RnListening {
  try {
    return @(Get-NetTCPConnection -LocalPort $script:RnPort -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  } catch { return $false }
}

function Stop-RnPidTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  if (-not (Test-RnProcessAlive $ProcessId)) { return }
  # Kill children first (npx -> node tree)
  try {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-RnPidTree ([int]$_.ProcessId) }
  } catch {}
  try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}

function Stop-RnDaemonByCommandLine {
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'reason-network-local[\\/]+src[\\/]+daemon\.js' } |
      ForEach-Object {
        Write-Host "Stopping Reason Network daemon PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  } catch {}
}

function Invoke-RnHealthCheck {
  $url = "http://$($script:RnHost):$($script:RnPort)/healthz"
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return ($resp.StatusCode -eq 200)
  } catch { return $false }
}
