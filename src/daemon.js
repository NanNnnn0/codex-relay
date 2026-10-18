import net from "node:net";
import { Store } from "./storage.js";
import { asObject, jsonLine, parseLines, pipePath, PROTOCOL_VERSION, randomId } from "./protocol.js";
import { startTask, continueTask, getTask, listTasks, cancelTask, closeTaskRunner } from "./task-runner.js";

const store = new Store();
const pendingWaiters = new Map();

async function wakeTarget(to) {
  const command = process.env.REASON_NETWORK_WAKE_COMMAND;
  if (!command) return { attempted: false, mode: "pull" };
  const escaped = String(to).replace(/["`$\\]/g, "");
  const rendered = command.replaceAll("{sessionId}", escaped);
  try {
    const { exec } = await import("node:child_process");
    exec(rendered, { windowsHide: true, timeout: 5000 }, () => {});
    return { attempted: true, mode: "configured-command" };
  } catch { return { attempted: false, mode: "pull" }; }
}

async function dispatch(request) {
  const p = asObject(request.params);
  switch (request.method) {
    case "register": {
      const session = store.register(p);
      return { session, pending: store.pendingCount(session.id) };
    }
    case "touch": return { session: store.touch(p), pending: store.pendingCount(p.id) };
    case "pending_count": return { unread: store.pendingCount(p.session_id) };
    case "reset_guard": store.resetGuard(p.session_id); return { ok: true };
    case "delegate_task": return startTask({ ...p, id: p.id || randomId("task") });
    case "continue_task": return continueTask(p);
    case "get_task_status": return getTask(p.task_id);
    case "get_task_result": return getTask(p.task_id);
    case "list_tasks": return listTasks(p.limit);
    case "cancel_task": return cancelTask(p.task_id);
    case "list_sessions": return { sessions: store.listSessions() };
    case "send_message": {
      const result = store.sendMessage(p);
      if (!result.blocked && p.wake) result.wake = await wakeTarget(p.to);
      const waiter = pendingWaiters.get(p.to);
      if (waiter) { pendingWaiters.delete(p.to); waiter(); }
      return result;
    }
    case "check_inbox": {
      const waitSecs = Math.min(Math.max(Number(p.wait_secs) || 0, 0), 120);
      let messages = store.inbox(p.session_id, waitSecs);
      if (!messages.length && waitSecs) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { if (pendingWaiters.get(p.session_id) === resolve) pendingWaiters.delete(p.session_id); resolve(); }, waitSecs * 1000);
          pendingWaiters.set(p.session_id, () => { clearTimeout(timer); resolve(); });
        });
        messages = store.inbox(p.session_id, 0);
      }
      return { messages, unread: store.pendingCount(p.session_id) };
    }
    default: throw new Error(`Unknown method: ${request.method}`);
  }
}

function serve(socket) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", async (chunk) => {
    buffer += chunk;
    const parsed = parseLines(buffer); buffer = parsed.rest;
    for (const line of parsed.lines) {
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { socket.write(jsonLine({ error: "invalid_json" })); continue; }
      try { socket.write(jsonLine({ id: req.id ?? null, ok: true, result: await dispatch(req) })); }
      catch (error) { socket.write(jsonLine({ id: req.id ?? null, ok: false, error: error.message })); }
    }
  });
}

const server = net.createServer(serve);
const socketPath = pipePath();
if (process.platform !== "win32") { try { (await import("node:fs")).unlinkSync(socketPath); } catch {} }
server.listen(socketPath, () => {
  process.stdout.write(`Reason Network daemon listening on ${socketPath} (protocol ${PROTOCOL_VERSION})\n`);
});
async function shutdown() { await closeTaskRunner(); server.close(); store.close(); process.exit(0); }
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
