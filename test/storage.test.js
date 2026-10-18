import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { identifyHookSession } from "../src/hook.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rn-local-"));
  const store = new Store(path.join(dir, "state.sqlite3"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test("registers stable sessions and stores queued messages as untrusted inbox items", (t) => {
  const store = fixture(t);
  store.register({ id: "claude:1", name: "api-claude", agent_type: "claude", cwd: "C:/repo", repo: "repo", branch: "main" });
  store.register({ id: "codex:2", name: "repo-codex", agent_type: "codex", cwd: "C:/repo" });
  const sent = store.sendMessage({ from: "claude:1", to: "codex:2", message: "Review this", model: "gpt-5.6-codex", reasoning_effort: "high", wake: false });
  assert.equal(sent.queued, true);
  assert.equal(sent.model, "gpt-5.6-codex");
  assert.equal(sent.reasoning_effort, "high");
  const inbox = store.inbox("codex:2");
  assert.match(inbox[0].text, /UNTRUSTED COLLABORATION CONTENT/);
  assert.match(inbox[0].text, /requested model: gpt-5.6-codex/);
  assert.equal(inbox[0].reasoning_effort, "high");
  assert.equal(store.pendingCount("codex:2"), 0);
});

test("rejects unsupported reasoning effort", (t) => {
  const store = fixture(t);
  store.register({ id: "a", name: "a", cwd: "C:/a", agent_type: "a" });
  store.register({ id: "b", name: "b", cwd: "C:/b", agent_type: "b" });
  assert.throws(() => store.sendMessage({ from: "a", to: "b", message: "x", reasoning_effort: "extreme" }), /reasoning_effort/);
});

test("breaks alternating agent loops after five sends", (t) => {
  const store = fixture(t);
  store.register({ id: "a", name: "a", cwd: "C:/a", agent_type: "a" });
  store.register({ id: "b", name: "b", cwd: "C:/b", agent_type: "b" });
  const outcomes = ["a", "b", "a", "b", "a", "b"].map((from) => store.sendMessage({ from, to: from === "a" ? "b" : "a", message: "next" }));
  assert.equal(outcomes.at(-1).blocked, true);
  assert.equal(outcomes.at(-1).reason, "loop_guard");
});

test("derives hook identity from vendor session IDs", () => {
  assert.equal(identifyHookSession({ session_id: "abc", cwd: "C:/repo" }, "codex").id, "codex:abc");
});
