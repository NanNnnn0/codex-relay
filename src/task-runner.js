import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "./storage.js";
import { cleanString, nowIso, optionalModel, optionalReasoningEffort, randomId } from "./protocol.js";
import { CodexAppServer } from "./codex-app-server.js";

const store = new Store();
const active = new Map();
const queued = [];

function defaultTaskRoot() {
  if (process.env.REASON_NETWORK_TASK_ROOT) return path.resolve(process.env.REASON_NETWORK_TASK_ROOT);
  const dataRoot = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataRoot, "ReasonNetwork", "tasks");
}

const taskRoot = defaultTaskRoot();
const appServer = new CodexAppServer();
let runningTaskId = null;
fs.mkdirSync(taskRoot, { recursive: true });

function safeSegment(value) {
  return cleanString(value, 100).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function buildPrompt(input) {
  const criteria = Array.isArray(input.acceptance_criteria)
    ? input.acceptance_criteria.map((x) => cleanString(x, 1000)).filter(Boolean)
    : [];
  return [
    "You are executing a delegated coding task from a coordinator.",
    `Task: ${cleanString(input.prompt, 30000)}`,
    criteria.length ? `Acceptance criteria:\n${criteria.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
    "Work directly in the assigned workspace. Run the requested tests. Implement the task and report changed files and test results.",
    "Return a concise final summary with status, changed files, tests run, and any remaining issue.",
  ].filter(Boolean).join("\n\n");
}

function createWorktree(taskId, projectCwd, requestedWorktree) {
  if (!projectCwd || !fs.existsSync(projectCwd)) throw new Error(`Project cwd does not exist: ${projectCwd}`);
  try { execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectCwd, stdio: "pipe" }); }
  catch { throw new Error(`Project cwd is not a Git repository: ${projectCwd}`); }
  const worktree = path.resolve(requestedWorktree || path.join(taskRoot, safeSegment(taskId)));
  if (worktree !== taskRoot && !worktree.startsWith(`${taskRoot}${path.sep}`)) {
    throw new Error(`Worktree must be under the configured task root: ${taskRoot}`);
  }
  if (fs.existsSync(worktree) && !fs.existsSync(path.join(worktree, ".git"))) {
    throw new Error(`Worktree path exists but is not a Git worktree: ${worktree}`);
  }
  if (!fs.existsSync(path.join(worktree, ".git"))) {
    const branch = `reason-network/${safeSegment(taskId)}`;
    try { execFileSync("git", ["worktree", "add", "-B", branch, worktree, "HEAD"], { cwd: projectCwd, stdio: "pipe" }); }
    catch (error) { throw new Error(`Could not create Codex worktree: ${error.stderr?.toString() || error.message}`); }
  }
  return worktree;
}

function collectWorkspaceResult(worktree) {
  try {
    const changedFiles = execFileSync("git", ["status", "--short"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const diffStat = execFileSync("git", ["diff", "--stat"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { changed_files: changedFiles ? changedFiles.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [], diff_stat: diffStat };
  } catch (error) { return { workspace_error: error.message }; }
}

async function runTask(taskId) {
  const task = store.getTask(taskId);
  if (!task || task.status === "cancelled") return;
  runningTaskId = taskId;
  const run = { status: "running", threadId: task.thread_id || null, cancelRequested: false };
  active.set(taskId, run);
  store.updateTask(taskId, { status: "running", started_at: nowIso(), error: null });
  try {
    let threadId = task.thread_id;
    if (threadId) {
      await appServer.resumeThread({ threadId, cwd: task.worktree, model: task.model });
    } else {
      const started = await appServer.startThread({ cwd: task.worktree, model: task.model });
      threadId = started?.thread?.id || started?.threadId;
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      run.threadId = threadId;
      store.updateTask(taskId, { thread_id: threadId, pid: appServer.pid });
    }
    const result = await appServer.runTurn({
      threadId,
      cwd: task.worktree,
      prompt: buildPrompt(task),
      model: task.model,
      reasoning_effort: task.reasoning_effort,
    });
    const workspace = collectWorkspaceResult(task.worktree);
    const status = run.cancelRequested || result.status === "interrupted" ? "cancelled" : result.status === "completed" ? "completed" : "failed";
    store.updateTask(taskId, {
      status,
      thread_id: threadId,
      turn_id: result.turn_id,
      pid: appServer.pid,
      result_json: JSON.stringify({ ...result, ...workspace, thread_id: threadId }),
      error: status === "failed" ? result.turn?.error?.message || "Codex turn failed" : null,
      finished_at: nowIso(),
    });
  } catch (error) {
    const status = run.cancelRequested ? "cancelled" : "failed";
    store.updateTask(taskId, { status, error: error.message, finished_at: nowIso() });
  } finally {
    active.delete(taskId);
    runningTaskId = null;
    pump();
  }
}

function pump() {
  if (runningTaskId || !queued.length) return;
  const taskId = queued.shift();
  if (store.getTask(taskId)?.status === "cancelled") return pump();
  void runTask(taskId);
}

export function startTask(input) {
  const taskId = cleanString(input.id, 120) || randomId("task");
  const model = optionalModel(input.model);
  const reasoningEffort = optionalReasoningEffort(input.reasoning_effort);
  const worktree = createWorktree(taskId, cleanString(input.cwd, 1000), cleanString(input.worktree, 1000));
  const task = store.createTask({ ...input, id: taskId, worktree, model, reasoning_effort: reasoningEffort });
  queued.push(task.id);
  pump();
  return store.getTask(task.id);
}

export function continueTask(input) {
  const taskId = cleanString(input.task_id, 120);
  const current = store.getTask(taskId);
  if (!current) throw new Error(`Unknown task: ${taskId}`);
  if (!current.thread_id) throw new Error(`Task has no Codex thread yet: ${taskId}`);
  if (current.status === "running" || queued.includes(taskId)) throw new Error(`Task is already active: ${taskId}`);
  const prompt = cleanString(input.prompt, 30000);
  if (!prompt) throw new Error("prompt is required");
  const model = input.model == null ? current.model : optionalModel(input.model);
  const reasoningEffort = input.reasoning_effort == null ? current.reasoning_effort : optionalReasoningEffort(input.reasoning_effort);
  store.updateTask(taskId, { prompt, model, reasoning_effort: reasoningEffort, status: "queued", error: null, finished_at: null });
  queued.push(taskId);
  pump();
  return store.getTask(taskId);
}

export function getTask(id) { return store.getTask(id); }
export function listTasks(limit) {
  return {
    tasks: store.listTasks(limit),
    app_server: {
      running: !!appServer.child,
      idle_ms: appServer.idleMs,
      last_activity_at: appServer.lastActivityAt ? new Date(appServer.lastActivityAt).toISOString() : null,
    },
  };
}

export async function cancelTask(id) {
  const taskId = cleanString(id, 120);
  const current = store.getTask(taskId);
  if (!current) return null;
  const queueIndex = queued.indexOf(taskId);
  if (queueIndex >= 0) queued.splice(queueIndex, 1);
  const run = active.get(taskId);
  if (run) {
    run.cancelRequested = true;
    if (run.threadId) { try { await appServer.interrupt(run.threadId); } catch {} }
  }
  store.updateTask(taskId, { status: "cancelled", finished_at: nowIso() });
  return store.getTask(taskId);
}

export async function closeTaskRunner() { await appServer.close(); }
