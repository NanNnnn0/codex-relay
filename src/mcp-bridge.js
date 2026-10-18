import net from "node:net";
import { spawn } from "node:child_process";
import process from "node:process";
import { asObject, jsonLine, parseLines, pipePath } from "./protocol.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));
let daemonProcess;
let requestId = 0;
let socket;
let buffer = "";
const replies = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    socket = net.createConnection(pipePath());
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk; const parsed = parseLines(buffer); buffer = parsed.rest;
      for (const line of parsed.lines) { if (!line.trim()) continue; try { const msg = JSON.parse(line); replies.get(msg.id)?.(msg); replies.delete(msg.id); } catch {} }
    });
    socket.once("connect", resolve); socket.once("error", reject);
  });
}

async function ensureDaemon() {
  try { await connect(); return; } catch {}
  if (!daemonProcess) {
    daemonProcess = spawn(process.execPath, [daemonPath], { detached: true, stdio: "ignore", windowsHide: true });
    daemonProcess.unref();
  }
  for (let i = 0; i < 30; i++) { try { await connect(); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error("Reason Network daemon is unavailable");
}

function call(method, params) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    replies.set(id, (msg) => msg.ok ? resolve(msg.result) : reject(new Error(msg.error || "daemon_error")));
    socket.write(jsonLine({ id, method, params }));
  });
}

function gitInfo(cwd) {
  try { const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); const branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return { repo, branch }; } catch { return { repo: "", branch: "" }; }
}

async function main() {
  await ensureDaemon();
  const cwd = process.env.REASON_NETWORK_CWD || process.cwd();
  const agent = process.env.REASON_NETWORK_AGENT || "mcp-agent";
  const name = process.env.REASON_NETWORK_SESSION || "";
  const id = process.env.REASON_NETWORK_SESSION_ID || `${agent}:${cwd}`;
  const git = gitInfo(cwd);
  await call("register", { id, name, agent_type: agent, cwd, pid: process.pid, ...git, delivery_tier: "pull" });
  const tools = [
    { name: "list_sessions", description: "List live local agent sessions and their passive state.", inputSchema: { type: "object", properties: {} } },
    { name: "send_message", description: "Queue an isolated collaboration message. model and reasoning_effort are requested execution settings; they do not silently change the recipient session.", inputSchema: { type: "object", required: ["to", "message"], properties: { to: { type: "string" }, message: { type: "string" }, model: { type: "string", description: "Requested model identifier; the recipient decides whether to switch." }, reasoning_effort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], description: "Requested thinking intensity." }, wake: { type: "boolean" } } } },
    { name: "check_inbox", description: "Read queued collaboration messages; wait up to 120 seconds when requested.", inputSchema: { type: "object", properties: { wait_secs: { type: "number", minimum: 0, maximum: 120 } } } },
  ];
  if (process.env.REASON_NETWORK_DELEGATION === "enabled") {
    tools.push(
      { name: "delegate_task", description: "Delegate a non-trivial coding task to Codex. Use for multi-file, test-heavy, or difficult implementation work. The daemon lazily starts one app-server and runs the task in an isolated worktree.", inputSchema: { type: "object", required: ["project", "cwd", "prompt"], properties: { project: { type: "string" }, cwd: { type: "string" }, prompt: { type: "string" }, acceptance_criteria: { type: "array", items: { type: "string" } }, worktree: { type: "string" }, model: { type: "string" }, reasoning_effort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] } } } },
      { name: "continue_task", description: "Continue a completed or failed Codex task by reusing its existing thread and worktree.", inputSchema: { type: "object", required: ["task_id", "prompt"], properties: { task_id: { type: "string" }, prompt: { type: "string" }, model: { type: "string" }, reasoning_effort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] } } } },
      { name: "get_task_status", description: "Get the status and result metadata of a delegated Codex task.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } } },
      { name: "get_task_result", description: "Get the final structured output of a delegated Codex task.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } } },
      { name: "list_tasks", description: "List recent delegated Codex tasks.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
      { name: "cancel_task", description: "Cancel a running delegated Codex task.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } } },
    );
  }
  let input = "";
  let queue = Promise.resolve();
  const heartbeat = setInterval(() => call("touch", { id, state: "idle", cwd, pid: process.pid, ...git }).catch(() => {}), 30000);
  process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => {
    input += chunk; const parsed = parseLines(input); input = parsed.rest;
    for (const line of parsed.lines) {
      queue = queue.then(async () => {
        if (!line.trim()) return;
        let req; try { req = JSON.parse(line); } catch { return; }
      try {
        let result;
        if (req.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "reason-network-local", version: "0.2.0" } };
        else if (req.method === "notifications/initialized") return;
        else if (req.method === "tools/list") result = { tools };
        else if (req.method === "tools/call") {
          const args = asObject(req.params?.arguments);
          if (req.params?.name === "list_sessions") result = await call("list_sessions", {});
          else if (req.params?.name === "send_message") result = await call("send_message", { ...args, from: id });
          else if (req.params?.name === "check_inbox") result = await call("check_inbox", { session_id: id, wait_secs: args.wait_secs });
          else if (["delegate_task", "continue_task", "get_task_status", "get_task_result", "list_tasks", "cancel_task"].includes(req.params?.name)) result = await call(req.params.name, { ...args, from: id });
          else throw new Error("Unknown tool");
          const pending = result.unread ?? (await call("pending_count", { session_id: id })).unread;
          result.notice = pending ? `You have ${pending} unread Reason Network message(s).` : "";
        } else throw new Error(`Unknown MCP method: ${req.method}`);
        process.stdout.write(jsonLine({ jsonrpc: "2.0", id: req.id ?? null, result }));
      } catch (error) { process.stdout.write(jsonLine({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32000, message: error.message } })); }
      });
    }
  });
  process.stdin.on("end", () => queue.finally(() => { clearInterval(heartbeat); socket?.end(); process.exit(0); }));
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
