import { spawn as defaultSpawn } from "node:child_process";
import { parseLines, randomId } from "./protocol.js";

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export class CodexAppServer {
  constructor(options = {}) {
    this.command = options.command || process.env.CODEX_BIN || "codex";
    this.args = options.args || ["app-server", "--listen", "stdio://"];
    this.spawn = options.spawn || defaultSpawn;
    this.idleMs = options.idleMs ?? Number(process.env.REASON_NETWORK_CODEX_IDLE_MS || 15 * 60_000);
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 6 * 60 * 60_000;
    this.networkAccess = options.networkAccess ?? process.env.REASON_NETWORK_CODEX_NETWORK_ACCESS === "enabled";
    this.child = null;
    this.starting = null;
    this.buffer = "";
    this.nextId = 0;
    this.pending = new Map();
    this.turns = new Map();
    this.activeCalls = 0;
    this.idleTimer = null;
    this.lastActivityAt = null;
  }

  async ensureStarted() {
    if (this.child && this.child.exitCode === null) { clearTimeout(this.idleTimer); return; }
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { await this.starting; }
    finally { this.starting = null; }
  }

  async _start() {
    clearTimeout(this.idleTimer);
    this.buffer = "";
    const child = this.spawn(this.command, this.args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.on("error", (error) => this._onExit(error, child));
    child.on("exit", (code, signal) => this._onExit(new Error(`Codex app-server exited (code=${code}, signal=${signal})`), child));

    this.activeCalls++;
    try {
      await this.request("initialize", {
        clientInfo: { name: "codex-relay", title: "Codex Relay", version: "0.2.0" },
      }, this.initializeTimeoutMs);
      this.notify("initialized", {});
      this.lastActivityAt = Date.now();
    } finally {
      this.activeCalls--;
      this._scheduleIdleStop();
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    const parsed = parseLines(this.buffer);
    this.buffer = parsed.rest;
    for (const line of parsed.lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || "Codex app-server request failed"));
        else entry.resolve(message.result);
        continue;
      }
      this._onNotification(message);
    }
  }

  _onNotification(message) {
    const params = message.params || {};
    if (message.method === "item/agentMessage/delta") {
      const run = this.turns.get(params.threadId);
      if (run && (!run.turnId || run.turnId === params.turnId)) run.output += params.delta || "";
      return;
    }
    if (message.method === "turn/completed") {
      const run = this.turns.get(params.threadId);
      if (!run) return;
      if (run.turnId && params.turn?.id && run.turnId !== params.turn.id) return;
      clearTimeout(run.timer);
      this.turns.delete(params.threadId);
      run.resolve({
        thread_id: params.threadId,
        turn_id: params.turn?.id || run.turnId || null,
        status: params.turn?.status || "completed",
        output: run.output,
        turn: params.turn || null,
      });
      this._scheduleIdleStop();
    }
  }

  _onExit(error, child) {
    if (this.child !== child) return;
    this.child = null;
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(failure);
      this.pending.delete(id);
    }
    for (const run of this.turns.values()) {
      clearTimeout(run.timer);
      run.reject(failure);
    }
    this.turns.clear();
    clearTimeout(this.idleTimer);
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error("Codex app-server is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method, params = {}) {
    if (!this.child || this.child.exitCode !== null) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async startThread(input) {
    await this.ensureStarted();
    this.activeCalls++;
    try {
      return await this.request("thread/start", {
        cwd: input.cwd,
        model: input.model || null,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: false,
        serviceName: "codex-relay",
      });
    } finally {
      this.activeCalls--;
      this.lastActivityAt = Date.now();
      this._scheduleIdleStop();
    }
  }

  async resumeThread(input) {
    await this.ensureStarted();
    this.activeCalls++;
    try {
      return await this.request("thread/resume", {
        threadId: input.threadId,
        cwd: input.cwd,
        model: input.model || null,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
    } finally {
      this.activeCalls--;
      this.lastActivityAt = Date.now();
      this._scheduleIdleStop();
    }
  }

  async runTurn(input) {
    await this.ensureStarted();
    this.activeCalls++;
    const run = deferred();
    run.output = "";
    run.turnId = null;
    run.timer = setTimeout(() => {
      this.turns.delete(input.threadId);
      run.reject(new Error("Codex task exceeded its maximum run time"));
    }, input.timeoutMs || this.turnTimeoutMs);
    this.turns.set(input.threadId, run);
    try {
      const started = await this.request("turn/start", {
        threadId: input.threadId,
        cwd: input.cwd,
        model: input.model || null,
        effort: input.reasoning_effort || null,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: this.networkAccess },
        approvalPolicy: "never",
        input: [{ type: "text", text: input.prompt }],
      });
      run.turnId = started?.turn?.id || null;
      const result = await run.promise;
      return { ...result, turn_id: result.turn_id || run.turnId };
    } catch (error) {
      clearTimeout(run.timer);
      this.turns.delete(input.threadId);
      throw error;
    } finally {
      this.activeCalls--;
      this.lastActivityAt = Date.now();
      this._scheduleIdleStop();
    }
  }

  async interrupt(threadId) {
    if (!this.child || this.child.exitCode !== null) return { interrupted: false };
    await this.request("turn/interrupt", { threadId });
    return { interrupted: true };
  }

  _scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    if (!this.child || this.activeCalls > 0 || this.turns.size > 0 || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => this.stopIfIdle(), this.idleMs);
    this.idleTimer.unref?.();
  }

  stopIfIdle() {
    if (!this.child || this.activeCalls > 0 || this.turns.size > 0) return false;
    const child = this.child;
    this.child = null;
    this.lastActivityAt = Date.now();
    try { child.kill("SIGTERM"); } catch {}
    return true;
  }

  async close() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Codex app-server closed")); }
    this.pending.clear();
    for (const run of this.turns.values()) { clearTimeout(run.timer); run.reject(new Error("Codex app-server closed")); }
    this.turns.clear();
    try { child.kill("SIGTERM"); } catch {}
  }

  get pid() { return this.child?.pid ?? null; }
}

export function createThreadId() { return randomId("rn-thread"); }
