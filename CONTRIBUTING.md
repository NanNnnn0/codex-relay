# Contributing

Issues and pull requests are welcome.

Before opening a pull request:

1. Run `npm test` on Node.js 22 or newer.
2. Keep the MCP bridge stateless and put durable behavior in the daemon.
3. Add focused tests for storage, protocol, or task-runner changes.
4. Do not include API keys, local paths, database files, logs, or generated
   runtime state.

Describe the user-visible behavior, the platform tested, and any Codex CLI
version assumptions in the pull request.
