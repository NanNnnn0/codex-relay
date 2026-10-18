export const PROTOCOL_VERSION = 1;
export const PIPE_NAME = "\\\\.\\pipe\\reason-network-local";
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function cleanString(value, max = 4000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000\r\n]/g, " ").trim().slice(0, max);
}

export function optionalModel(value) {
  if (value == null || value === "") return null;
  const model = cleanString(value, 120);
  if (!model) throw new Error("model must be a non-empty string");
  return model;
}

export function optionalReasoningEffort(value) {
  if (value == null || value === "") return null;
  const effort = cleanString(value, 20).toLowerCase();
  if (!REASONING_EFFORTS.includes(effort)) {
    throw new Error(`reasoning_effort must be one of: ${REASONING_EFFORTS.join(", ")}`);
  }
  return effort;
}

export function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function parseLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  return { lines: lines.slice(0, -1), rest: lines.at(-1) || "" };
}

export function pipePath() {
  if (process.platform === "win32") return PIPE_NAME;
  return `${process.env.TMPDIR || "/tmp"}/reason-network-local.sock`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
