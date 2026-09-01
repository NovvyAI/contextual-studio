import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { traceToolCall } from "./mlflow-tracing.js";

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function localPluginConfig() {
  const explicit = process.env.NOVVY_MCP_CONFIG;
  if (explicit) return readJson(path.resolve(explicit));
  const root = path.join(os.homedir(), ".codex/plugins/cache/novvy-local/novvy-ad-creative");
  try {
    const versions = fs.readdirSync(root).sort().reverse();
    for (const version of versions) {
      const config = readJson(path.join(root, version, ".mcp.json"));
      if (config) return config;
    }
  } catch { /* Cloud deployments use environment configuration. */ }
  return null;
}

function connectionConfig() {
  const local = localPluginConfig()?.mcpServers?.novvy_ai_platform || {};
  const url = String(process.env.NOVVY_MCP_URL || local.url || "").trim();
  const authorization = String(
    process.env.NOVVY_MCP_AUTHORIZATION || local.http_headers?.Authorization || local.headers?.Authorization || "",
  ).trim();
  if (!url) throw new Error("缺少 NOVVY_MCP_URL");
  if (!authorization) throw new Error("缺少 NOVVY_MCP_AUTHORIZATION");
  return { url, authorization: /^Bearer\s/i.test(authorization) ? authorization : `Bearer ${authorization}` };
}

function parsePayload(text, contentType) {
  if (!text.trim()) return null;
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const events = text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
  return events.at(-1) || null;
}

export class NovvyMcpClient {
  constructor() {
    const config = connectionConfig();
    this.url = config.url;
    this.authorization = config.authorization;
    this.sessionId = "";
    this.requestId = 0;
  }

  async request(method, params, notification = false) {
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: this.authorization,
      "content-type": "application/json",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    if (!notification) body.id = ++this.requestId;
    const response = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    this.sessionId ||= response.headers.get("mcp-session-id") || "";
    const responseText = await response.text();
    if (!response.ok) {
      let detail = "";
      try {
        const parsed = parsePayload(responseText, response.headers.get("content-type") || "");
        detail = parsed?.error?.message || parsed?.message || "";
      } catch { detail = responseText.trim().slice(0, 500); }
      const authHint = response.status === 401 || response.status === 403 ? "。请检查本机 .env 中的 NOVVY_MCP_AUTHORIZATION 是否有效" : "";
      throw new Error(`Novvy MCP HTTP ${response.status}${detail ? `：${detail}` : ""}${authHint}`);
    }
    const payload = parsePayload(responseText, response.headers.get("content-type") || "");
    if (payload?.error) throw new Error(payload.error.message || "Novvy MCP 调用失败");
    return payload?.result ?? payload;
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "contextual-studio", version: "0.1.0" },
    });
    await this.request("notifications/initialized", {}, true);
  }

  callTool(name, args) {
    return traceToolCall("novvy_mcp", name, args, () => this.request("tools/call", { name, arguments: args }));
  }
}

export function unpackToolResult(value) {
  if (value?.isError) {
    const detail = value.content?.map((item) => item.text).filter(Boolean).join("\n");
    throw new Error(detail || "Novvy 工具返回失败");
  }
  if (value?.structuredContent) return value.structuredContent;
  const text = value?.content?.find((item) => item.type === "text")?.text;
  if (text) {
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return value;
}
