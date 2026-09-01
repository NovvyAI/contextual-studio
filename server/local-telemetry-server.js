import http from "node:http";
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const port = Number(process.env.LOCAL_TELEMETRY_PORT || 4191);
const token = String(process.env.LOCAL_TELEMETRY_TOKEN || "contextual-local-dev");
const dataDir = path.resolve(process.env.LOCAL_TELEMETRY_DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "local-telemetry.sqlite"));
const dashboardDir = path.resolve("public");

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name TEXT NOT NULL,
    version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(skill_name, version)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_version_id INTEGER NOT NULL REFERENCES skill_versions(id),
    created_by TEXT NOT NULL,
    brief_raw TEXT,
    brief_json TEXT NOT NULL,
    product_name TEXT,
    channel TEXT,
    market TEXT,
    reference_video_uri TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'completed',
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    stage_output_id TEXT,
    parent_asset_id TEXT,
    metadata_json TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    raw_feedback TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'unclassified',
    asset_id TEXT,
    stage_output_id TEXT,
    creative_version TEXT,
    time_range TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, idempotency_key)
  );
`);

const now = () => new Date().toISOString();
const send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const sendFile = (res, fileName, contentType) => {
  const body = readFileSync(path.join(dashboardDir, fileName));
  res.writeHead(200, { "content-type": contentType, "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
};

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch { return ""; }
}

function sanitize(value, key = "") {
  if (/authorization|api.?key|token|cookie|signature/i.test(key)) return "[已隐藏]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  if (typeof value !== "string") return value;
  if (/^https?:\/\//.test(value)) return safeUrl(value);
  if (/^(?:\/Users\/|\/home\/|[A-Za-z]:\\)/.test(value)) return "[本机路径已隐藏]";
  return value;
}

function dashboardData() {
  const totals = Object.fromEntries(["runs", "stages", "assets", "feedback"].map((table) => [table, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
  const runs = db.prepare(`SELECT r.*,sv.skill_name,sv.version skill_version,
    (SELECT COUNT(*) FROM stages WHERE run_id=r.id) stage_count,
    (SELECT COUNT(*) FROM assets WHERE run_id=r.id) asset_count,
    (SELECT COUNT(*) FROM feedback WHERE run_id=r.id) feedback_count
    FROM runs r JOIN skill_versions sv ON sv.id=r.skill_version_id ORDER BY r.updated_at DESC,r.id DESC LIMIT 100`).all();
  return {
    generatedAt: now(), totals,
    runs: runs.map((run) => ({
      id: run.id, createdBy: run.created_by, brief: sanitize(parseJson(run.brief_json)), briefRaw: sanitize(run.brief_raw),
      productName: run.product_name, channel: run.channel, market: run.market, referenceVideoUri: sanitize(run.reference_video_uri),
      status: run.status, createdAt: run.created_at, updatedAt: run.updated_at, skillName: run.skill_name, skillVersion: run.skill_version,
      counts: { stages: run.stage_count, assets: run.asset_count, feedback: run.feedback_count },
      stages: db.prepare("SELECT id,stage,payload_json,version,status,created_at FROM stages WHERE run_id=? ORDER BY created_at,id").all(run.id)
        .map((row) => ({ id: row.id, stage: row.stage, payload: sanitize(parseJson(row.payload_json)), version: row.version, status: row.status, createdAt: row.created_at })),
      assets: db.prepare("SELECT id,asset_type,storage_uri,version,stage_output_id,parent_asset_id,metadata_json,created_at FROM assets WHERE run_id=? ORDER BY created_at,id").all(run.id)
        .map((row) => ({ id: row.id, assetType: row.asset_type, storageUri: safeUrl(row.storage_uri), version: row.version, stageOutputId: row.stage_output_id, parentAssetId: row.parent_asset_id, metadata: sanitize(parseJson(row.metadata_json)), createdAt: row.created_at })),
      feedback: db.prepare("SELECT id,raw_feedback,decision,asset_id,stage_output_id,creative_version,time_range,created_at FROM feedback WHERE run_id=? ORDER BY created_at,id").all(run.id)
        .map((row) => ({ id: row.id, feedback: sanitize(row.raw_feedback), decision: row.decision, assetId: row.asset_id, stageOutputId: row.stage_output_id, creativeVersion: row.creative_version, timeRange: row.time_range, createdAt: row.created_at })),
    })),
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体超过 2MB");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function requireRun(runId) {
  const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
  if (!run) throw new Error("采集任务不存在");
  return run;
}

function insertIdempotent(table, columns, values, runId, idempotencyKey) {
  if (idempotencyKey) {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE run_id=? AND idempotency_key=?`).get(runId, idempotencyKey);
    if (existing) return existing;
  }
  const result = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(result.lastInsertRowid);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true, service: "contextual-local-telemetry" });
    if (req.method === "GET" && ["/", "/dashboard"].includes(url.pathname)) return sendFile(res, "telemetry-dashboard.html", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/telemetry-dashboard.css") return sendFile(res, "telemetry-dashboard.css", "text/css; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/telemetry-dashboard.js") return sendFile(res, "telemetry-dashboard.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/v1/local/dashboard-data") return send(res, 200, dashboardData());
    if (req.headers["x-api-key"] !== token) return send(res, 401, { error: "Invalid telemetry token" });

    if (req.method === "GET" && url.pathname === "/v1/skill-versions/resolve") {
      const skillName = url.searchParams.get("skill_name") || "novvy-ad-creative";
      const version = url.searchParams.get("version") || "contextual-studio-v1";
      db.prepare("INSERT OR IGNORE INTO skill_versions(skill_name,version,created_at) VALUES(?,?,?)").run(skillName, version, now());
      return send(res, 200, db.prepare("SELECT * FROM skill_versions WHERE skill_name=? AND version=?").get(skillName, version));
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = await readJson(req);
      const timestamp = now();
      const result = db.prepare(`INSERT INTO runs
        (skill_version_id,created_by,brief_raw,brief_json,product_name,channel,market,reference_video_uri,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'open',?,?)`).run(
        body.skill_version_id, String(body.created_by || "local-user"), String(body.brief_raw || ""), JSON.stringify(body.brief || {}),
        String(body.product_name || ""), String(body.channel || ""), String(body.market || ""), String(body.reference_video_uri || ""), timestamp, timestamp,
      );
      return send(res, 201, db.prepare("SELECT * FROM runs WHERE id=?").get(result.lastInsertRowid));
    }
    if (req.method === "GET" && url.pathname === "/v1/local/status") {
      const count = (table) => db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
      return send(res, 200, { runs: count("runs"), stages: count("stages"), assets: count("assets"), feedback: count("feedback") });
    }

    const match = url.pathname.match(/^\/v1\/runs\/(\d+)\/(stages|assets|feedback|status)$/);
    if (!match) return send(res, 404, { error: "Not found" });
    const runId = Number(match[1]);
    const resource = match[2];
    requireRun(runId);
    const body = await readJson(req);
    if (req.method === "PATCH" && resource === "status") {
      db.prepare("UPDATE runs SET status=?,updated_at=? WHERE id=?").run(String(body.status || "completed"), now(), runId);
      return send(res, 200, db.prepare("SELECT * FROM runs WHERE id=?").get(runId));
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    if (resource === "stages") {
      const row = insertIdempotent("stages", ["run_id", "stage", "payload_json", "version", "status", "idempotency_key", "created_at"],
        [runId, String(body.stage || ""), JSON.stringify(body.payload || {}), Number(body.version || 1), String(body.status || "completed"), body.idempotency_key || null, now()], runId, body.idempotency_key);
      return send(res, 201, row);
    }
    if (resource === "assets") {
      const row = insertIdempotent("assets", ["run_id", "asset_type", "storage_uri", "version", "stage_output_id", "parent_asset_id", "metadata_json", "idempotency_key", "created_at"],
        [runId, String(body.asset_type || ""), String(body.storage_uri || ""), Number(body.version || 1), String(body.stage_output_id || ""), String(body.parent_asset_id || ""), JSON.stringify(body.metadata || {}), body.idempotency_key || null, now()], runId, body.idempotency_key);
      return send(res, 201, row);
    }
    const row = insertIdempotent("feedback", ["run_id", "raw_feedback", "decision", "asset_id", "stage_output_id", "creative_version", "time_range", "idempotency_key", "created_at"],
      [runId, String(body.raw_feedback || ""), String(body.decision || "unclassified"), String(body.asset_id || ""), String(body.stage_output_id || ""), String(body.creative_version || ""), String(body.time_range || ""), body.idempotency_key || null, now()], runId, body.idempotency_key);
    return send(res, 201, row);
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local telemetry collector: http://127.0.0.1:${port}`);
  console.log(`Database: ${path.join(dataDir, "local-telemetry.sqlite")}`);
});
