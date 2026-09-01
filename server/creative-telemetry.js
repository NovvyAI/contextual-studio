import crypto from "node:crypto";
import { db, now } from "./database.js";
import { dramaAnalysisView } from "./drama-analysis-v3.js";

const apiUrl = String(process.env.NOVVY_TELEMETRY_URL || "").replace(/\/$/, "");
const apiToken = String(process.env.NOVVY_TELEMETRY_TOKEN || "");
const userId = String(process.env.NOVVY_TELEMETRY_USER_ID || "local-user");
const skillName = "novvy-ad-creative";
const skillVersion = String(process.env.NOVVY_SKILL_VERSION || "contextual-studio-v1");
const timeoutMs = Number(process.env.NOVVY_TELEMETRY_TIMEOUT_MS || 15000);
let flushing = false;

function compact(value, maxLength = 12000) {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length <= maxLength ? value : { truncated: true, preview: serialized.slice(0, maxLength) };
}

function localRun(sessionId) {
  let run = db.prepare("SELECT * FROM creative_telemetry_runs WHERE session_id=?").get(sessionId);
  if (run) return run;
  const timestamp = now();
  const localRunId = `contextual-${sessionId}-${crypto.randomUUID()}`;
  db.prepare("INSERT INTO creative_telemetry_runs(session_id,local_run_id,status,created_at,updated_at) VALUES(?,?,'open',?,?)")
    .run(sessionId, localRunId, timestamp, timestamp);
  return db.prepare("SELECT * FROM creative_telemetry_runs WHERE session_id=?").get(sessionId);
}

export function enqueueTelemetry(sessionId, eventType, payload, idempotencyKey) {
  localRun(sessionId);
  db.prepare(`INSERT OR IGNORE INTO creative_telemetry_outbox
    (session_id,event_type,payload_json,idempotency_key,status,attempts,created_at)
    VALUES(?,?,?,?,'pending',0,?)`)
    .run(sessionId, eventType, JSON.stringify(compact(payload)), idempotencyKey, now());
  if (apiUrl && apiToken) setImmediate(flushTelemetryOutbox);
}

export function recordCreativeRunStart(sessionId) {
  const session = db.prepare(`SELECT s.*,d.title drama_title,d.video_path,g.title game_title,g.store_url
    FROM creative_sessions s JOIN drama_analyses d ON d.id=s.drama_id JOIN game_analyses g ON g.id=s.game_id WHERE s.id=?`).get(sessionId);
  if (!session) return;
  enqueueTelemetry(sessionId, "run_start", {
    brief_raw: session.title,
    brief: { workflow: "contextual_studio", dramaId: session.drama_id, gameId: session.game_id },
    product_name: session.game_title || "",
    channel: "contextual_ad",
    market: "",
    reference_video_uri: `local-drama:${session.drama_id}`,
  }, `session:${sessionId}:run-start`);
}

export function recordCreativeStage(sessionId, stage, payload, { version = 1, status = "completed", key = "" } = {}) {
  enqueueTelemetry(sessionId, "stage", { stage, payload: compact(payload), version, status }, key || `session:${sessionId}:stage:${stage}:v${version}:${status}`);
}

export function recordCreativeAsset(sessionId, assetType, storageUri, { version = 1, stageOutputId = "", parentAssetId = "", metadata = {}, key = "" } = {}) {
  if (!/^https?:\/\//.test(String(storageUri || ""))) return;
  enqueueTelemetry(sessionId, "asset", {
    asset_type: assetType, storage_uri: storageUri, version, stage_output_id: stageOutputId,
    parent_asset_id: parentAssetId, metadata: compact(metadata),
  }, key || `session:${sessionId}:asset:${assetType}:${crypto.createHash("sha256").update(storageUri).digest("hex").slice(0, 20)}`);
}

export function recordCreativeFeedback(sessionId, rawFeedback, { decision = "unclassified", assetId = "", stageOutputId = "", creativeVersion = "", key = "" } = {}) {
  const original = String(rawFeedback || "").trim();
  const explicitFeedback = original.match(/(?:我的)?修改意见[：:]\s*([\s\S]*?)(?:\n\n请返回|\n请返回|$)/)?.[1]?.trim();
  const compactRevision = original.match(/^(?:修改人物候选|修改落版图|修改分镜图)[^：:]*[：:]\s*([\s\S]+)$/)?.[1]?.trim();
  const normalized = explicitFeedback || compactRevision || original.slice(0, 2000);
  if (!normalized) return;
  enqueueTelemetry(sessionId, "feedback", {
    raw_feedback: normalized, decision, asset_id: assetId, stage_output_id: stageOutputId, creative_version: creativeVersion,
  }, key || `session:${sessionId}:feedback:${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`);
}

export function recordCreativeRunComplete(sessionId, status = "completed") {
  enqueueTelemetry(sessionId, "run_complete", { status }, `session:${sessionId}:complete:${status}`);
}

export function backfillCreativeTelemetry(sessionId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  recordCreativeRunStart(sessionId);
  const drama = db.prepare("SELECT title,analysis_json FROM drama_analyses WHERE id=?").get(session.drama_id);
  const game = db.prepare("SELECT title,store_url,analysis_json FROM game_analyses WHERE id=?").get(session.game_id);
  const dramaResult = drama?.analysis_json ? JSON.parse(drama.analysis_json) : {};
  const dramaView = dramaAnalysisView(dramaResult);
  const gameResult = game?.analysis_json ? JSON.parse(game.analysis_json) : {};
  recordCreativeStage(sessionId, "video_analysis", { title: drama?.title || "", thesis: dramaView.oneSentenceThesis, visualStyle: dramaView.visualStyle }, { key: `session:${sessionId}:stage:video_analysis:source:${session.drama_id}` });
  recordCreativeStage(sessionId, "product_analysis", { title: game?.title || "", storeUrl: game?.store_url || "", thesis: gameResult.productThesis || gameResult.products?.[0]?.descriptionSummary || "" }, { key: `session:${sessionId}:stage:product_analysis:source:${session.game_id}` });

  const messages = db.prepare("SELECT id,role,content,cards_json,created_at FROM creative_messages WHERE session_id=? ORDER BY id").all(sessionId);
  for (const message of messages) {
    if (message.role === "user") {
      const decision = /确认|采用|选择/.test(message.content) ? "approved" : /拒绝|不要这个|放弃/.test(message.content) ? "rejected" : /修改|调整|重新生成|改成|去掉|增加/.test(message.content) ? "rework" : "unclassified";
      if (decision !== "unclassified") recordCreativeFeedback(sessionId, message.content, { decision, key: `session:${sessionId}:message:${message.id}:feedback` });
      continue;
    }
    let cards = [];
    try { cards = JSON.parse(message.cards_json || "[]"); } catch { cards = []; }
    if (!cards.length) continue;
    const kinds = new Set(cards.map((card) => card.kind));
    const stage = kinds.has("video_prompt") ? (cards.some((card) => card.previewUrl) ? "video_review" : "video_generation")
      : kinds.has("storyboard") || kinds.has("storyboard_image") ? "creative_plan"
        : kinds.has("final_card") ? "final_card"
          : kinds.has("character_image") || kinds.has("reference_image") ? "reference_panel"
            : kinds.has("concept") ? "recommendation" : "";
    if (stage) recordCreativeStage(sessionId, stage, { cards: cards.map((card) => ({ id: card.id, kind: card.kind, title: card.title, summary: card.summary, status: card.status })) }, { status: cards.some((card) => card.status === "confirmed") ? "confirmed" : "completed", key: `session:${sessionId}:message:${message.id}:stage:${stage}` });
    for (const card of cards) {
      if (!card.previewUrl) continue;
      const assetType = card.kind === "final_card" ? "final_card" : card.kind === "video_prompt" ? "generated_video" : card.kind === "storyboard_image" ? "storyboard" : card.kind === "character_image" || card.kind === "reference_image" ? "reference_panel" : "";
      if (assetType) recordCreativeAsset(sessionId, assetType, card.previewUrl, { version: Number(card.version || 1), stageOutputId: card.id, key: `session:${sessionId}:message:${message.id}:asset:${card.id}` });
    }
  }
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  if (workspace.productionPlan?.videoGenerationStatus === "approved") recordCreativeRunComplete(sessionId, "completed");
  return telemetryStatus();
}

async function request(method, pathname, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl}${pathname}`, {
      method, signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": apiToken },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Telemetry API ${response.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

async function ensureRemoteRun(sessionId) {
  const run = localRun(sessionId);
  if (run.remote_run_id) return run.remote_run_id;
  const startEvent = db.prepare("SELECT * FROM creative_telemetry_outbox WHERE session_id=? AND event_type='run_start' ORDER BY id LIMIT 1").get(sessionId);
  if (!startEvent) throw new Error("缺少 run_start 事件");
  const skill = await request("GET", `/v1/skill-versions/resolve?skill_name=${encodeURIComponent(skillName)}&version=${encodeURIComponent(skillVersion)}`);
  const payload = { ...JSON.parse(startEvent.payload_json), skill_version_id: skill.id, created_by: userId };
  const remote = await request("POST", "/v1/runs", payload);
  const remoteRunId = String(remote.id || remote.run_id || "");
  if (!remoteRunId) throw new Error("Telemetry API 未返回 run_id");
  const timestamp = now();
  db.prepare("UPDATE creative_telemetry_runs SET remote_run_id=?,updated_at=? WHERE session_id=?").run(remoteRunId, timestamp, sessionId);
  db.prepare("UPDATE creative_telemetry_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?").run(timestamp, startEvent.id);
  return remoteRunId;
}

async function sendEvent(event) {
  if (event.event_type === "run_start") return ensureRemoteRun(event.session_id);
  const runId = await ensureRemoteRun(event.session_id);
  const payload = { ...JSON.parse(event.payload_json), idempotency_key: event.idempotency_key };
  if (event.event_type === "stage") return request("POST", `/v1/runs/${runId}/stages`, payload);
  if (event.event_type === "asset") return request("POST", `/v1/runs/${runId}/assets`, payload);
  if (event.event_type === "feedback") return request("POST", `/v1/runs/${runId}/feedback`, payload);
  if (event.event_type === "run_complete") return request("PATCH", `/v1/runs/${runId}/status`, payload);
  throw new Error(`未知 telemetry 事件：${event.event_type}`);
}

export async function flushTelemetryOutbox() {
  if (flushing || !apiUrl || !apiToken) return;
  flushing = true;
  try {
    const events = db.prepare(`SELECT * FROM creative_telemetry_outbox
      WHERE status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY id LIMIT 50`).all(now());
    for (const event of events) {
      try {
        await sendEvent(event);
        if (event.event_type !== "run_start") db.prepare("UPDATE creative_telemetry_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?").run(now(), event.id);
      } catch (error) {
        const attempts = Number(event.attempts || 0) + 1;
        const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attempts - 1, 8)));
        const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        db.prepare("UPDATE creative_telemetry_outbox SET status='failed',attempts=?,next_attempt_at=?,last_error=? WHERE id=?")
          .run(attempts, nextAttempt, error instanceof Error ? error.message : String(error), event.id);
      }
    }
  } finally { flushing = false; }
}

export function telemetryStatus() {
  const counts = Object.fromEntries(db.prepare("SELECT status,COUNT(*) count FROM creative_telemetry_outbox GROUP BY status").all().map((row) => [row.status, row.count]));
  return { configured: Boolean(apiUrl && apiToken), apiUrl: apiUrl || "", userId, skillVersion, counts };
}

export function startTelemetryWorker() {
  if (!apiUrl || !apiToken) return;
  setImmediate(flushTelemetryOutbox);
  const timer = setInterval(flushTelemetryOutbox, 30000);
  timer.unref();
}
