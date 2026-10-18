import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexAppServer } from "../src/codex-app-server.js";

function fakeSpawn() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stdout.setEncoding("utf8");
  child.kill = (signal) => { child.killed = true; child.exitCode = 0; child.emit("exit", 0, signal); return true; };
  let input = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      const lines = input.split("\n"); input = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line);
        if (request.method === "initialized") continue;
        let result = {};
        if (request.method === "thread/start") result = { thread: { id: "thread-1" } };
        if (request.method === "thread/resume") result = { thread: { id: request.params.threadId } };
        if (request.method === "turn/start") {
          result = { turn: { id: "turn-1", status: "inProgress" } };
          setImmediate(() => child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: request.params.threadId, turnId: "turn-1", delta: "Done" } })}\n`));
          setImmediate(() => child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: "turn-1", status: "completed" } } })}\n`));
        }
        setImmediate(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      }
      callback();
    },
  });
  return child;
}

test("app-server initializes, creates a thread, runs a turn, and captures completion", async () => {
  const child = fakeSpawn();
  const server = new CodexAppServer({ spawn: () => child, idleMs: 0 });
  const thread = await server.startThread({ cwd: "/tmp/project", model: "gpt-6.1-sol" });
  assert.equal(thread.thread.id, "thread-1");
  const turn = await server.runTurn({ threadId: "thread-1", cwd: "/tmp/worktree", prompt: "Implement it", reasoning_effort: "high" });
  assert.equal(turn.status, "completed");
  assert.equal(turn.output, "Done");
  assert.equal(turn.turn_id, "turn-1");
  await server.close();
});

test("idle server can be stopped without an active turn", async () => {
  const child = fakeSpawn();
  const server = new CodexAppServer({ spawn: () => child, idleMs: 0 });
  await server.ensureStarted();
  assert.equal(server.stopIfIdle(), true);
  assert.equal(server.child, null);
  assert.equal(child.killed, true);
});
