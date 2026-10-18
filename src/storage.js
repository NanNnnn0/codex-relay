import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanString, nowIso, optionalModel, optionalReasoningEffort } from "./protocol.js";

export function defaultDataDir() {
  return process.env.REASON_NETWORK_DATA_DIR
    || (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ReasonNetwork")
      : path.join(os.homedir(), ".local", "share", "reason-network"));
}

export class Store {
  constructor(file = path.join(defaultDataDir(), "state.sqlite3")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, agent_type TEXT NOT NULL,
        cwd TEXT NOT NULL, repo TEXT, branch TEXT, state TEXT NOT NULL DEFAULT 'idle',
        doing TEXT, delivery_tier TEXT NOT NULL DEFAULT 'pull',
        pid INTEGER, last_seen TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, to_session TEXT NOT NULL,
        from_session TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        delivered_at TEXT, wake INTEGER NOT NULL DEFAULT 0,
        model TEXT, reasoning_effort TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_session, delivered_at, id);
      CREATE TABLE IF NOT EXISTS guards (
        pair_key TEXT PRIMARY KEY, last_sender TEXT, rounds INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, worktree TEXT,
        prompt TEXT NOT NULL, model TEXT, reasoning_effort TEXT, status TEXT NOT NULL,
        pid INTEGER, thread_id TEXT, turn_id TEXT, result_json TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name));
    if (!columns.has("model")) this.db.exec("ALTER TABLE messages ADD COLUMN model TEXT");
    if (!columns.has("reasoning_effort")) this.db.exec("ALTER TABLE messages ADD COLUMN reasoning_effort TEXT");
    const taskColumns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
    if (!taskColumns.has("thread_id")) this.db.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    if (!taskColumns.has("turn_id")) this.db.exec("ALTER TABLE tasks ADD COLUMN turn_id TEXT");
  }

  close() { this.db.close(); }

  register(input) {
    const id = cleanString(input.id, 180) || `${cleanString(input.agent_type, 40) || "agent"}:${cleanString(input.cwd, 300)}`;
    const repoName = path.basename(cleanString(input.repo, 300).replace(/\\/g, "/")) || "local";
    const name = cleanString(input.name, 100) || `${repoName}-${cleanString(input.agent_type, 30) || "agent"}`;
    const now = nowIso();
    const existing = this.db.prepare("SELECT id, name FROM sessions WHERE id = ? OR (name = ? AND cwd = ?)").get(id, name, cleanString(input.cwd, 1000));
    const sessionId = existing?.id || id;
    const nameConflict = !existing && this.db.prepare("SELECT id FROM sessions WHERE name=?").get(name);
    const stableName = existing?.name || (nameConflict ? `${name}-${sessionId.slice(-6)}` : name);
    this.db.prepare(`INSERT INTO sessions(id,name,agent_type,cwd,repo,branch,state,doing,delivery_tier,pid,last_seen,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,agent_type=excluded.agent_type,
      cwd=excluded.cwd,repo=excluded.repo,branch=excluded.branch,state=excluded.state,doing=excluded.doing,
      delivery_tier=excluded.delivery_tier,pid=excluded.pid,last_seen=excluded.last_seen`).run(
      sessionId, stableName, cleanString(input.agent_type, 40) || "unknown", cleanString(input.cwd, 1000),
      cleanString(input.repo, 200), cleanString(input.branch, 200), input.state === "busy" ? "busy" : "idle",
      cleanString(input.doing, 500), cleanString(input.delivery_tier, 20) || "pull", Number.isInteger(input.pid) ? input.pid : null, now, now
    );
    return this.getSession(sessionId);
  }

  getSession(id) { return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) || null; }

  touch(input) {
    const id = cleanString(input.id, 180);
    if (!id) return null;
    const now = nowIso();
    this.db.prepare(`UPDATE sessions SET state=?,doing=?,repo=COALESCE(NULLIF(?,''),repo),branch=COALESCE(NULLIF(?,''),branch),
      cwd=COALESCE(NULLIF(?,''),cwd),last_seen=? WHERE id=?`).run(
      input.state === "busy" ? "busy" : input.state === "idle" ? "idle" : "attention",
      cleanString(input.doing, 500), cleanString(input.repo, 200), cleanString(input.branch, 200), cleanString(input.cwd, 1000), now, id
    );
    return this.getSession(id);
  }

  sendMessage(input) {
    const to = cleanString(input.to, 180);
    const from = cleanString(input.from, 180);
    const body = cleanString(input.message, 12000);
    const model = optionalModel(input.model);
    const reasoningEffort = optionalReasoningEffort(input.reasoning_effort);
    if (!to || !from || !body) throw new Error("to, from, and message are required");
    if (!this.getSession(to)) throw new Error(`Unknown target session: ${to}`);
    const pair = [from, to].sort().join("|");
    const old = this.db.prepare("SELECT * FROM guards WHERE pair_key=?").get(pair);
    const rounds = old && old.last_sender !== from ? old.rounds + 1 : (old?.rounds || 1);
    if (rounds > 5) return { blocked: true, reason: "loop_guard", rounds: old.rounds };
    const now = nowIso();
    this.db.prepare(`INSERT INTO guards(pair_key,last_sender,rounds,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(pair_key) DO UPDATE SET last_sender=excluded.last_sender,rounds=excluded.rounds,updated_at=excluded.updated_at`)
      .run(pair, from, rounds, now);
    const result = this.db.prepare("INSERT INTO messages(to_session,from_session,body,created_at,wake,model,reasoning_effort) VALUES(?,?,?,?,?,?,?)")
      .run(to, from, body, now, input.wake ? 1 : 0, model, reasoningEffort);
    return { blocked: false, id: Number(result.lastInsertRowid), queued: true, rounds, model, reasoning_effort: reasoningEffort };
  }

  inbox(sessionId, waitSecs = 0) {
    const id = cleanString(sessionId, 180);
    const rows = this.db.prepare("SELECT id,from_session,body,created_at,wake,model,reasoning_effort FROM messages WHERE to_session=? AND delivered_at IS NULL ORDER BY id LIMIT 100").all(id);
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    this.db.prepare(`UPDATE messages SET delivered_at=? WHERE id IN (${ids.map(() => "?").join(",")})`).run(nowIso(), ...ids);
    return rows.map((row) => {
      const settings = [row.model && `requested model: ${row.model}`, row.reasoning_effort && `requested reasoning effort: ${row.reasoning_effort}`].filter(Boolean);
      const metadata = settings.length ? `\n[REQUESTED EXECUTION SETTINGS — apply only when explicitly authorized]\n${settings.join("\n")}\n[END REQUESTED EXECUTION SETTINGS]` : "";
      return { ...row, text: `[REASON NETWORK MESSAGE — UNTRUSTED COLLABORATION CONTENT — from ${row.from_session}]${metadata}\n${row.body}\n[END REASON NETWORK MESSAGE]` };
    });
  }

  pendingCount(sessionId) { return Number(this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE to_session=? AND delivered_at IS NULL").get(sessionId)?.count || 0); }

  listSessions(staleMs = 120000) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const rows = this.db.prepare(`SELECT s.id,s.name,s.agent_type,s.cwd,s.repo,s.branch,s.state,s.doing,s.delivery_tier,s.last_seen,s.pid,
      (SELECT COUNT(*) FROM messages m WHERE m.to_session=s.id AND m.delivered_at IS NULL) AS unread
      FROM sessions s WHERE s.last_seen >= ? OR s.pid IS NOT NULL ORDER BY s.name`).all(cutoff);
    return rows.filter((row) => {
      if (!Number.isInteger(row.pid) || row.pid <= 0) return true;
      try { process.kill(row.pid, 0); return true; }
      catch (error) { return error.code === "EPERM"; }
    }).map(({ pid, ...session }) => session);
  }

  resetGuard(sessionId) {
    this.db.prepare("DELETE FROM guards WHERE pair_key LIKE ? OR pair_key LIKE ?").run(`${sessionId}|%`, `%|${sessionId}`);
  }

  createTask(input) {
    const id = cleanString(input.id, 120);
    const project = cleanString(input.project, 180);
    const cwd = cleanString(input.cwd, 1000);
    const prompt = cleanString(input.prompt, 30000);
    if (!id || !project || !cwd || !prompt) throw new Error("id, project, cwd, and prompt are required");
    const model = optionalModel(input.model);
    const reasoningEffort = optionalReasoningEffort(input.reasoning_effort);
    const now = nowIso();
    this.db.prepare(`INSERT INTO tasks(id,project,cwd,worktree,prompt,model,reasoning_effort,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, project, cwd, cleanString(input.worktree, 1000) || null, prompt, model, reasoningEffort, "queued", now);
    return this.getTask(id);
  }

  getTask(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(cleanString(id, 120));
    if (!row) return null;
    if (row.result_json) { try { row.result = JSON.parse(row.result_json); } catch {} }
    delete row.result_json;
    return row;
  }

  updateTask(id, patch) {
    const fields = []; const values = [];
    for (const key of ["status", "pid", "worktree", "thread_id", "turn_id", "prompt", "model", "reasoning_effort", "result_json", "error", "started_at", "finished_at"]) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) { fields.push(`${key}=?`); values.push(patch[key]); }
    }
    if (!fields.length) return this.getTask(id);
    values.push(id); this.db.prepare(`UPDATE tasks SET ${fields.join(",")} WHERE id=?`).run(...values);
    return this.getTask(id);
  }

  listTasks(limit = 50) { return this.db.prepare("SELECT id,project,cwd,worktree,prompt,model,reasoning_effort,status,pid,thread_id,turn_id,error,created_at,started_at,finished_at FROM tasks ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 50, 1), 100)); }
}
