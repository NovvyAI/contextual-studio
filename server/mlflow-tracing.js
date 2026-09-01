import * as mlflow from "@mlflow/core";

const trackingUri = String(process.env.MLFLOW_TRACKING_URI || "").trim();
const experimentId = String(process.env.MLFLOW_EXPERIMENT_ID || "").trim();
const maxStringLength = Math.max(1000, Number(process.env.MLFLOW_TRACE_MAX_STRING_LENGTH || 200000));
let enabled = Boolean(trackingUri && experimentId);
let initializationError = "";

if (enabled) {
  try {
    mlflow.init({ trackingUri, experimentId });
  } catch (error) {
    enabled = false;
    initializationError = error instanceof Error ? error.message : String(error);
    console.warn(`MLflow tracing disabled: ${initializationError}`);
  }
}

const sensitiveKey = /(authorization|api[-_]?key|cookie|password|secret|token|credential|signed[-_]?url)/i;

function sanitizeString(value) {
  let text = String(value);
  if (/^data:[^,]+;base64,/i.test(text)) return "[REDACTED_DATA_URL]";
  text = text.replace(/\b(authorization|api[-_]?key|cookie|password|secret|token|credential)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[REDACTED]");
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw.replace(/[),.;]+$/, ""));
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch { return raw; }
  });
  text = text.replace(/\/(?:Users|home)\/[^\s"'<>]+/g, (raw) => `[LOCAL_PATH]/${raw.split("/").at(-1) || "file"}`);
  return text.length <= maxStringLength ? text : `${text.slice(0, maxStringLength)}\n[TRUNCATED ${text.length - maxStringLength} CHARS]`;
}

export function sanitizeTraceValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[BINARY ${value.byteLength} BYTES]`;
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, seen));
  if (typeof value !== "object") return sanitizeString(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = sensitiveKey.test(key) ? "[REDACTED]" : sanitizeTraceValue(item, seen);
  seen.delete(value);
  return output;
}

function preview(value, fallback) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return sanitizeString(text).slice(0, 1000) || fallback;
  } catch { return fallback; }
}

export async function traceOperation({ name, spanType, inputs, sessionId = "", attributes = {} }, operation) {
  if (!enabled) return operation();
  const safeInputs = sanitizeTraceValue(inputs);
  return mlflow.withSpan(async (span) => {
    if (sessionId) mlflow.updateCurrentTrace({ sessionId: String(sessionId), requestPreview: preview(safeInputs, name) });
    for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, sanitizeTraceValue(value));
    const result = await operation();
    const safeOutput = sanitizeTraceValue(result);
    span.setOutputs(safeOutput);
    mlflow.updateCurrentTrace({ responsePreview: preview(safeOutput, `${name} completed`) });
    return result;
  }, { name, spanType, inputs: safeInputs, attributes: { "contextual.studio": true } });
}

export function runCodexWithTrace(thread, input, options, { name, sessionId = "", model = "codex-config-default" } = {}) {
  return traceOperation({
    name: name || "codex.thread.run",
    spanType: mlflow.SpanType.LLM,
    sessionId,
    inputs: { model, prompt: input, outputSchema: options?.outputSchema || null },
    attributes: { "gen_ai.system": "codex", "gen_ai.request.model": model },
  }, async () => {
    const turn = await thread.run(input, options);
    return turn;
  });
}

export function traceToolCall(provider, name, args, operation) {
  return traceOperation({
    name: `${provider}.${name}`,
    spanType: mlflow.SpanType.TOOL,
    inputs: { provider, tool: name, arguments: args },
    attributes: { "tool.provider": provider, "tool.name": name },
  }, operation);
}

export function mlflowTracingStatus() {
  return { enabled, trackingUri, experimentId, initializationError };
}

export function flushMlflowTraces() {
  return enabled ? mlflow.flushTraces() : Promise.resolve();
}
