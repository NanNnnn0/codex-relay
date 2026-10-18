# Remote MCP gateway

This package exposes the local stdio bridge through Streamable HTTP so a remote
coordinator can call Codex Relay tools. It is intended for a
private tunnel such as Tailscale Serve. The gateway listens on loopback by
default and requires an API key for MCP requests.

## Prerequisites

- Windows 10/11
- Node.js 22 or newer and `npx`
- Tailscale or another private HTTPS tunnel
- The repository checked out on the Windows machine

## Start

```powershell
cd path\to\codex-relay\remote
.\start-remote.ps1
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REASON_NETWORK_CWD` | repository root | Session working directory reported to the daemon. |
| `REASON_NETWORK_AGENT` | `grokbot` | Agent type shown in the session directory. |
| `REASON_NETWORK_SESSION` | `grokbot-main` | Stable session name. |
| `REASON_NETWORK_DELEGATION` | `enabled` | Set to `disabled` for messaging-only access. |
| `REASON_NETWORK_REMOTE_PORT` | `3920` | Local gateway port. |
| `REASON_NETWORK_REMOTE_IDLE_MINUTES` | `15` | Stop after this many minutes without a client connection. |
| `REASON_NETWORK_REMOTE_API_KEY` | generated | Override the stored API key. |

The script writes runtime state, logs, and the generated key under
`%LOCALAPPDATA%\ReasonNetwork\remote\`. These files are deliberately outside
the repository. `%LOCALAPPDATA%` is a Windows environment path and can point to
a profile on a drive other than `C:`.

Local endpoints:

```text
http://127.0.0.1:3920/mcp
http://127.0.0.1:3920/healthz
```

Stop the gateway with:

```powershell
.\stop-remote.ps1
```

Use `-KeepDaemon` when the MCP gateway should stop while the local daemon stays
available to native agent sessions.

## Publish privately

After the local health check succeeds, publish only the loopback port through a
private HTTPS tunnel:

```powershell
tailscale serve --bg 3920
tailscale serve status
```

Give the remote coordinator the resulting URL ending in `/mcp` and the bearer
token stored in `api-key.txt`. Do not commit or paste the key into a repository.
If a public tunnel is unavoidable, keep the API key enabled and restrict access
at the tunnel layer as well.

## Limitations

- The gateway coordinates sessions registered with this Windows daemon. It does
  not create a cross-cloud agent network.
- The remote bridge does not wake a stopped Windows process by itself. Start the
  gateway before the coordinator sends work, or provide a separate service/task
  that starts it at logon.
- Health checks intentionally do not require authentication so tunnel monitors
  can probe liveness. Do not use `/healthz` as an authorization check.
