import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "src", "hook.js");
const node = process.execPath;
const home = os.homedir();
const flags = new Set(process.argv.slice(2));
if (!flags.has("--claude") && !flags.has("--codex")) throw new Error("Choose --claude or --codex");

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.reason-network-backup-${Date.now()}`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function command() { return { type: "command", command: `"${node}" "${hook}" ${flags.has("--codex") ? "codex" : "claude"}`, timeout: 5 }; }
function addHook(hooks, event) {
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  const exists = list.some((entry) => (entry.hooks || []).some((item) => item.command === node && item.args?.includes(hook)));
  if (!exists) list.push({ matcher: "", hooks: [command()] });
  hooks[event] = list;
}

if (flags.has("--claude")) {
  const file = path.join(home, ".claude", "settings.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (fs.existsSync(file)) throw new Error(`Cannot parse ${file}: ${error.message}`); }
  config.hooks ||= {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) addHook(config.hooks, event);
  saveJson(file, config);
  process.stdout.write(`Installed Claude Code hooks in ${file}\n`);
}

if (flags.has("--codex")) {
  const file = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "hooks.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (fs.existsSync(file)) throw new Error(`Cannot parse ${file}: ${error.message}`); }
  config.hooks ||= {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) addHook(config.hooks, event);
  saveJson(file, config);
  process.stdout.write(`Installed Codex hooks in ${file}\n`);
}
