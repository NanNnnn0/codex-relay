# Codex Relay

![Status: experimental](https://img.shields.io/badge/status-experimental-orange)
![Node.js: 22%2B](https://img.shields.io/badge/node.js-22%2B-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

A Windows-first MCP relay that lets a coding Grok Bot delegate difficult coding
tasks to Codex. It keeps the useful M0 idea from
[Reason Network](https://github.com/reason-machines/reason-network): one daemon
owns shared state, while each agent gets a thin MCP bridge.

This project is intentionally smaller than the full Reason Network. It does not
implement team membership or peer-to-peer transport. It is for one computer,
multiple agent sessions, and an optional remote MCP gateway.

## What it does

- Tracks local agent sessions, repositories, branches, busy/idle state, and
  unread messages in SQLite.
- Delivers isolated collaboration messages through `list_sessions`,
  `send_message`, and `check_inbox`.
- Optionally lets a coordinator delegate difficult coding work to Codex through
  `delegate_task`, then inspect or continue it with the task tools.
- Creates one Git worktree per delegated task and reuses the same Codex thread
  when a task is continued.
- Starts one Codex app-server on demand, queues concurrent tasks, and stops the
  app-server after an idle timeout.
- Installs Claude Code or Codex hooks for passive session updates and turn-level
  inbox injection.

## Requirements

- Windows 10/11 for the named-pipe workflow. Linux and macOS use a Unix socket
  fallback for development.
- Node.js 22 or newer. Node.js 24 is recommended because the daemon uses the
  built-in `node:sqlite` module.
- Git for worktree-based Codex tasks.
- Codex CLI installed and authenticated when delegation is enabled.

## Quick start

```powershell
git clone https://github.com/NanNnnn0/codex-relay.git
cd codex-relay
npm test
npm run daemon
```

The daemon stores state in the platform user-data directory and listens on
`\\.\pipe\reason-network-local` on Windows. This internal pipe name is kept
for compatibility with existing installations. Set
`REASON_NETWORK_DATA_DIR` to choose another database directory.

Paths such as `C:\\path\\to\\codex-relay` in the examples are placeholders.
Clone the repository wherever you prefer (including another drive) and replace
the example path with that location.

Configure an MCP client to start the stateless bridge:

```json
{
  "command": "node",
  "args": ["C:\\path\\to\\codex-relay\\src\\mcp-bridge.js"],
  "env": {
    "REASON_NETWORK_AGENT": "claude",
    "REASON_NETWORK_SESSION": "api-claude",
    "REASON_NETWORK_CWD": "C:\\path\\to\\your\\repo"
  }
}
```

The bridge starts the daemon if needed. The three base tools are always
available. Set `REASON_NETWORK_DELEGATION=enabled` in the bridge environment to
expose Codex task delegation tools.

## Delegate coding work to Codex

The delegation tools are designed for a coordinator such as a coding Grok Bot:

| Tool | Purpose |
| --- | --- |
| `delegate_task` | Create a worktree and queue a new Codex task. |
| `continue_task` | Reuse the task's worktree and Codex thread. |
| `get_task_status` | Read task state and execution metadata. |
| `get_task_result` | Read the final summary, changed files, and test result. |
| `list_tasks` | List recent tasks and app-server state. |
| `cancel_task` | Interrupt a running task or remove a queued task. |

Example request:

```json
{
  "project": "example-api",
  "cwd": "C:\\work\\example-api",
  "prompt": "Add request validation and update the API tests.",
  "acceptance_criteria": [
    "Validation covers malformed input",
    "All existing tests pass"
  ],
  "model": "gpt-6.1-sol",
  "reasoning_effort": "high"
}
```

Supported reasoning levels are `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, and `ultra`. The model and effort are passed to Codex for that
task only; they do not silently change an existing agent session.

Delegated work runs in an isolated worktree under the task root. Configure it
with `REASON_NETWORK_TASK_ROOT`; otherwise it defaults to a user-data directory.
The task sandbox does not have network access unless the daemon environment sets
`REASON_NETWORK_CODEX_NETWORK_ACCESS=enabled`.

## Hooks

Install hooks after reviewing the generated configuration and its backup:

```powershell
node src/install-hooks.js --claude
node src/install-hooks.js --codex
```

Hooks report session state without requiring agents to describe what they are
doing. Incoming messages are marked as untrusted peer content before they are
added to a turn. `REASON_NETWORK_WAKE_COMMAND` can provide an explicit wake
command for clients that support one.

## Remote MCP gateway

The `remote/` package wraps the stdio bridge with `supergateway` and exposes a
local Streamable HTTP endpoint for a remote coordinator. It binds to loopback,
generates an API key outside the repository, and includes an idle watcher.

```powershell
cd remote
.\start-remote.ps1
```

Publish the local port through a private tunnel such as Tailscale Serve, then
give the coordinator the resulting `/mcp` URL and the generated API key. Read
[`remote/README.md`](remote/README.md) for the complete setup and security
guidance. Set `REASON_NETWORK_DELEGATION=disabled` before starting if the remote
bridge should expose messaging only.

## Architecture

```text
Claude / Codex / Grok Bot
          | MCP stdio or Streamable HTTP
          v
     thin bridge
          | named pipe / Unix socket
          v
  long-lived daemon + SQLite
          |
          +-- session directory and mailboxes
          +-- task queue and Git worktrees
          +-- lazy Codex app-server
```

The bridge is stateless. The daemon owns persistence, delivery, queueing, and
the five-round alternating-message loop guard. Peer messages are framed as
untrusted collaboration data and are never treated as user instructions by the
bridge.

## Development

```powershell
npm test
npm run daemon
```

The test suite covers SQLite message delivery, loop protection, hook identity,
and the Codex app-server protocol adapter. Contributions should include tests
for new protocol or storage behavior. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
and [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).

This is an independent local implementation inspired by the M0 architecture
described in Reason Network's public design documentation.
