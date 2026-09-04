import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dramaReferenceImageCandidates, isDramaAnalysisV3, migrateDramaAnalysisToV3 } from "./drama-analysis-v3.js";

const dataDir = path.resolve("data");
fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
fs.mkdirSync(path.join(dataDir, "chat-uploads"), { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "contextual-studio.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS drama_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    original_name TEXT NOT NULL,
    video_path TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'uploaded',
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    orientation TEXT,
    analysis_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drama_screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES drama_analyses(id) ON DELETE CASCADE,
    timestamp_seconds REAL NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    width INTEGER,
    height INTEGER,
    image_blob BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drama_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES drama_analyses(id) ON DELETE CASCADE,
    episode_index INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    video_path TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(analysis_id, episode_index)
  );

  CREATE INDEX IF NOT EXISTS idx_drama_screenshots_analysis
    ON drama_screenshots(analysis_id, timestamp_seconds);

  CREATE TABLE IF NOT EXISTS drama_face_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES drama_analyses(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL,
    character_id TEXT,
    timestamp_seconds REAL NOT NULL,
    view TEXT NOT NULL,
    yaw_degrees REAL,
    quality_score REAL NOT NULL DEFAULT 0,
    bbox_json TEXT,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    image_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(analysis_id, candidate_id)
  );

  CREATE INDEX IF NOT EXISTS idx_drama_face_candidates_analysis
    ON drama_face_candidates(analysis_id, character_id, view, quality_score DESC);

  CREATE TABLE IF NOT EXISTS game_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    store_url TEXT NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',
    analysis_json TEXT,
    error_message TEXT,
    codex_thread_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS creative_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL REFERENCES drama_analyses(id),
    game_id INTEGER NOT NULL REFERENCES game_analyses(id),
    title TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'ideating',
    workspace_json TEXT,
    codex_thread_id TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS creative_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_creative_messages_session
    ON creative_messages(session_id, id);

  CREATE TABLE IF NOT EXISTS creative_asset_deletions (
    session_id INTEGER NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
    asset_url TEXT NOT NULL,
    asset_number INTEGER NOT NULL,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY(session_id, asset_url)
  );

  CREATE TABLE IF NOT EXISTS creative_video_shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
    prompt_card_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    shot_order INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    provider TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    task_id TEXT,
    provider_session_id TEXT,
    result_url TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, prompt_card_id, shot_id, version)
  );

  CREATE INDEX IF NOT EXISTS idx_creative_video_shots_session
    ON creative_video_shots(session_id, prompt_card_id, shot_order, version);

  CREATE TABLE IF NOT EXISTS creative_landing_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
    prompt_card_id TEXT NOT NULL,
    file_name TEXT NOT NULL UNIQUE,
    store_url TEXT NOT NULL,
    app_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_creative_landing_packages_session
    ON creative_landing_packages(session_id, id);

  CREATE TABLE IF NOT EXISTS creative_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    preview_url TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    message_id INTEGER REFERENCES creative_messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, card_id, version)
  );

  CREATE INDEX IF NOT EXISTS idx_creative_cards_latest
    ON creative_cards(session_id, card_id, version DESC);

  CREATE INDEX IF NOT EXISTS idx_creative_cards_kind_status
    ON creative_cards(session_id, kind, status);

  CREATE TABLE IF NOT EXISTS creative_telemetry_runs (
    session_id INTEGER PRIMARY KEY REFERENCES creative_sessions(id) ON DELETE CASCADE,
    local_run_id TEXT NOT NULL UNIQUE,
    remote_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS creative_telemetry_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_creative_telemetry_outbox_pending
    ON creative_telemetry_outbox(status, next_attempt_at, id);
`);

const creativeMessageColumns = new Set(db.prepare("PRAGMA table_info(creative_messages)").all().map((column) => column.name));
if (!creativeMessageColumns.has("cards_json")) db.exec("ALTER TABLE creative_messages ADD COLUMN cards_json TEXT");
if (!creativeMessageColumns.has("visibility")) db.exec("ALTER TABLE creative_messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'chat'");
if (!creativeMessageColumns.has("attachments_json")) db.exec("ALTER TABLE creative_messages ADD COLUMN attachments_json TEXT");
const gameAnalysisColumns = new Set(db.prepare("PRAGMA table_info(game_analyses)").all().map((column) => column.name));
if (!gameAnalysisColumns.has("source_json")) db.exec("ALTER TABLE game_analyses ADD COLUMN source_json TEXT");
const faceCandidateColumns = new Set(db.prepare("PRAGMA table_info(drama_face_candidates)").all().map((column) => column.name));
if (!faceCandidateColumns.has("overlay_score")) db.exec("ALTER TABLE drama_face_candidates ADD COLUMN overlay_score REAL NOT NULL DEFAULT 0");
if (!faceCandidateColumns.has("overlay_regions_json")) db.exec("ALTER TABLE drama_face_candidates ADD COLUMN overlay_regions_json TEXT");
if (!faceCandidateColumns.has("needs_cleanup")) db.exec("ALTER TABLE drama_face_candidates ADD COLUMN needs_cleanup INTEGER NOT NULL DEFAULT 0");
if (!faceCandidateColumns.has("episode_index")) db.exec("ALTER TABLE drama_face_candidates ADD COLUMN episode_index INTEGER NOT NULL DEFAULT 1");
const dramaScreenshotColumns = new Set(db.prepare("PRAGMA table_info(drama_screenshots)").all().map((column) => column.name));
if (!dramaScreenshotColumns.has("episode_index")) db.exec("ALTER TABLE drama_screenshots ADD COLUMN episode_index INTEGER NOT NULL DEFAULT 1");
const creativeVideoShotColumns = new Set(db.prepare("PRAGMA table_info(creative_video_shots)").all().map((column) => column.name));
if (!creativeVideoShotColumns.has("model_key")) db.exec("ALTER TABLE creative_video_shots ADD COLUMN model_key TEXT");
if (!gameAnalysisColumns.has("external_source_id")) db.exec("ALTER TABLE game_analyses ADD COLUMN external_source_id TEXT");
const dramaAnalysisColumns = new Set(db.prepare("PRAGMA table_info(drama_analyses)").all().map((column) => column.name));
if (!dramaAnalysisColumns.has("external_source_id")) db.exec("ALTER TABLE drama_analyses ADD COLUMN external_source_id TEXT");
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_drama_analyses_external_source ON drama_analyses(external_source_id) WHERE external_source_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_game_analyses_external_source ON game_analyses(external_source_id) WHERE external_source_id IS NOT NULL;
`);

export const now = () => new Date().toISOString();

// Materializes a "从云端已解析短剧选择" pick into the same drama_analyses table local
// uploads use, keyed by external_source_id so re-syncing the same remote drama updates
// the existing row instead of duplicating it. Downstream code (creative-agent context,
// character reference review, etc.) never needs to know whether a row came from a local
// upload or a remote sync.
export function upsertExternalDrama(detail) {
  const sourceId = String(detail?.sourceId || "").trim();
  if (!sourceId || !detail?.result) throw new Error("远端短剧分析缺少来源 ID 或结果");
  const timestamp = now();
  const existing = db.prepare("SELECT id FROM drama_analyses WHERE external_source_id=?").get(sourceId);
  if (existing) {
    db.prepare(`
      UPDATE drama_analyses
      SET title=?,status='completed',analysis_json=?,error_message=NULL,updated_at=?
      WHERE id=?
    `).run(detail.title || "未命名短剧", JSON.stringify(detail.result), timestamp, existing.id);
    return db.prepare("SELECT * FROM drama_analyses WHERE id=?").get(existing.id);
  }
  const createdAt = detail.createdAt || detail.analyzedAt || timestamp;
  const inserted = db.prepare(`
    INSERT INTO drama_analyses
      (title,original_name,video_path,mime_type,file_size,status,analysis_json,error_message,created_at,updated_at,external_source_id)
    VALUES (?,?,?,'',0,'completed',?,NULL,?,?,?)
  `).run(detail.title || "未命名短剧", `remote:${sourceId}`, "", JSON.stringify(detail.result), createdAt, timestamp, sourceId);
  return db.prepare("SELECT * FROM drama_analyses WHERE id=?").get(Number(inserted.lastInsertRowid));
}

// Same idea as upsertExternalDrama, for "从云端已解析 App 选择".
export function upsertExternalProduct(detail) {
  const sourceId = String(detail?.sourceId || "").trim();
  if (!sourceId || !detail?.result) throw new Error("远端 App 分析缺少来源 ID 或结果");
  const timestamp = now();
  const storeUrl = detail.storeUrl || `novvy-product:${sourceId}`;
  const platform = detail.platform === "Android" ? "google_play" : detail.platform === "iOS" ? "apple_app_store" : String(detail.platform || "unknown");
  const source = {
    productId: sourceId,
    productName: detail.productName || detail.title || "未命名 App",
    category: detail.category || "",
    os: detail.platform || "",
    iconUrl: detail.iconUrl || "",
    landingUrl: detail.storeUrl || "",
  };
  const existing = db.prepare("SELECT id FROM game_analyses WHERE external_source_id=?").get(sourceId);
  if (existing) {
    db.prepare(`
      UPDATE game_analyses
      SET title=?,store_url=?,platform=?,status='completed',analysis_json=?,source_json=?,error_message=NULL,updated_at=?
      WHERE id=?
    `).run(source.productName, storeUrl, platform, JSON.stringify(detail.result), JSON.stringify(source), timestamp, existing.id);
    return db.prepare("SELECT * FROM game_analyses WHERE id=?").get(existing.id);
  }
  const createdAt = detail.createdAt || detail.analyzedAt || timestamp;
  const inserted = db.prepare(`
    INSERT INTO game_analyses
      (title,store_url,platform,status,analysis_json,error_message,codex_thread_id,created_at,updated_at,source_json,external_source_id)
    VALUES (?,?,?,'completed',?,NULL,NULL,?,?,?,?)
  `).run(source.productName, storeUrl, platform, JSON.stringify(detail.result), createdAt, timestamp, JSON.stringify(source), sourceId);
  return db.prepare("SELECT * FROM game_analyses WHERE id=?").get(Number(inserted.lastInsertRowid));
}

function migrateLegacyDramaAnalyses() {
  const rows = db.prepare("SELECT id,analysis_json FROM drama_analyses WHERE status='completed' AND analysis_json IS NOT NULL").all();
  const update = db.prepare("UPDATE drama_analyses SET analysis_json=? WHERE id=?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      let analysis;
      try { analysis = JSON.parse(row.analysis_json); } catch { continue; }
      if (isDramaAnalysisV3(analysis)) continue;
      const migrated = migrateDramaAnalysisToV3(analysis);
      if (migrated) update.run(JSON.stringify(migrated), row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

migrateLegacyDramaAnalyses();

function deserializeCard(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch { payload = {}; }
  return { ...payload, id: row.card_id, kind: row.kind, status: row.status, previewUrl: row.preview_url, version: row.version, messageId: row.message_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

// Single card, latest version.
export function latestCard(sessionId, cardId) {
  return deserializeCard(db.prepare("SELECT * FROM creative_cards WHERE session_id=? AND card_id=? ORDER BY version DESC LIMIT 1").get(sessionId, cardId));
}

// One specific historical version of a card (for revision-history display).
export function cardVersion(sessionId, cardId, version) {
  return deserializeCard(db.prepare("SELECT * FROM creative_cards WHERE session_id=? AND card_id=? AND version=?").get(sessionId, cardId, version));
}

// Full version history of a card, oldest first.
export function cardHistory(sessionId, cardId) {
  return db.prepare("SELECT * FROM creative_cards WHERE session_id=? AND card_id=? ORDER BY version ASC").all(sessionId, cardId).map(deserializeCard);
}

// Latest version of every distinct card_id under a kind (e.g. all current character_image candidates).
export function latestCardsByKind(sessionId, kind, { excludeStatuses = [] } = {}) {
  const rows = db.prepare(`
    SELECT c.* FROM creative_cards c
    INNER JOIN (SELECT card_id, MAX(version) AS version FROM creative_cards WHERE session_id=? AND kind=? GROUP BY card_id) latest
      ON latest.card_id = c.card_id AND latest.version = c.version
    WHERE c.session_id=? AND c.kind=?
    ORDER BY c.id ASC
  `).all(sessionId, kind, sessionId, kind);
  return rows.filter((row) => !excludeStatuses.includes(row.status)).map(deserializeCard);
}

// Latest version of every distinct card_id across the whole session (used to build the frontend's `cards` array).
export function liveCardsForSession(sessionId, { excludeStatuses = ["superseded"] } = {}) {
  const rows = db.prepare(`
    SELECT c.* FROM creative_cards c
    INNER JOIN (SELECT card_id, MAX(version) AS version FROM creative_cards WHERE session_id=? GROUP BY card_id) latest
      ON latest.card_id = c.card_id AND latest.version = c.version
    WHERE c.session_id=?
    ORDER BY c.id ASC
  `).all(sessionId, sessionId);
  return rows.filter((row) => !excludeStatuses.includes(row.status)).map(deserializeCard);
}

// Most recently confirmed card of a kind — replaces the old
// `[...workspace.confirmedCards].reverse().find(item => item.kind===X && item.status==='confirmed')`
// convention. Ordered by row id (insertion order), not version, because the same card_id can be
// confirmed more than once across its lifecycle (e.g. final_card: direction confirmed first,
// the real generated image confirmed later) and the most recent confirmation event should win.
export function latestConfirmedCard(sessionId, kind) {
  return deserializeCard(db.prepare("SELECT * FROM creative_cards WHERE session_id=? AND kind=? AND status='confirmed' ORDER BY id DESC LIMIT 1").get(sessionId, kind));
}

// Appends a new version row for `card.id` (auto-incrementing version per card_id within the session).
// Use for a brand-new card, or when the user explicitly asked for a new round of generation.
export function insertCardVersion(sessionId, messageId, card) {
  const cardId = String(card?.id || "");
  if (!cardId) throw new Error("card 缺少 id，无法写入 creative_cards");
  if (!card?.kind) throw new Error(`card ${cardId} 缺少 kind，无法写入 creative_cards`);
  const version = Number(db.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM creative_cards WHERE session_id=? AND card_id=?").get(sessionId, cardId).version);
  const timestamp = now();
  db.prepare("INSERT INTO creative_cards (session_id,card_id,kind,version,status,preview_url,payload_json,message_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(sessionId, cardId, card.kind, version, card.status || "candidate", card.previewUrl || "", JSON.stringify(card), messageId || null, timestamp, timestamp);
  return latestCard(sessionId, cardId);
}

// Patches the CURRENT version in place (e.g. generating -> completed/failed with a real previewUrl).
// Does not bump version — this is a status/content transition within the same generation attempt,
// mirroring how creative_video_shots rows are updated in place while a task is in flight.
export function updateCardStatus(sessionId, cardId, version, patch, messageId) {
  const row = db.prepare("SELECT * FROM creative_cards WHERE session_id=? AND card_id=? AND version=?").get(sessionId, cardId, version);
  if (!row) throw new Error(`找不到 ${cardId} 的第 ${version} 版`);
  let payload = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch { payload = {}; }
  const merged = { ...payload, ...patch };
  const timestamp = now();
  db.prepare("UPDATE creative_cards SET status=?,preview_url=?,payload_json=?,message_id=COALESCE(?,message_id),updated_at=? WHERE session_id=? AND card_id=? AND version=?")
    .run(merged.status || row.status, merged.previewUrl ?? row.preview_url, JSON.stringify(merged), messageId || null, timestamp, sessionId, cardId, version);
  return latestCard(sessionId, cardId);
}

// Marks each card_id's current version as superseded (abandoned sibling candidates, an outdated
// confirmed value being replaced, etc). Never touches an already-confirmed or already-superseded row.
export function supersedeCards(sessionId, cardIds) {
  if (!cardIds?.length) return;
  const timestamp = now();
  const stmt = db.prepare(`
    UPDATE creative_cards SET status='superseded',updated_at=?
    WHERE session_id=? AND card_id=? AND status NOT IN ('confirmed','superseded')
      AND version=(SELECT MAX(version) FROM creative_cards WHERE session_id=? AND card_id=?)
  `);
  for (const cardId of cardIds) stmt.run(timestamp, sessionId, cardId, sessionId, cardId);
}

// Backfill: replay every historical creative_messages.cards_json entry (oldest message first,
// per session) into creative_cards, so pre-migration sessions end up with exactly the same
// "latest version per card_id" result the old full-history-scan logic used to compute. Guarded
// per session (not globally) — a session is skipped once it has any creative_cards rows of its
// own, so this stays correct and idempotent even when sessions created under old, pre-refactor
// code keep showing up in a database that other sessions have already written new-code rows
// into (e.g. after switching branches back and forth during testing).
function backfillCreativeCardsFromMessages() {
  const backfilledSessionIds = new Set(db.prepare("SELECT DISTINCT session_id FROM creative_cards").all().map((row) => row.session_id));
  const sessions = db.prepare("SELECT id,workspace_json FROM creative_sessions ORDER BY id ASC").all().filter((session) => !backfilledSessionIds.has(session.id));
  if (!sessions.length) return;
  const sessionIds = new Set(sessions.map((session) => session.id));
  const messages = db.prepare("SELECT id,session_id,cards_json FROM creative_messages WHERE cards_json IS NOT NULL ORDER BY session_id ASC,id ASC").all()
    .filter((message) => sessionIds.has(message.session_id));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const message of messages) {
      let cards = [];
      try { cards = JSON.parse(message.cards_json || "[]"); } catch { continue; }
      for (const card of cards) {
        if (!card?.id || !card?.kind) continue;
        insertCardVersion(message.session_id, message.id, card);
      }
    }
    // workspace.confirmedCards was the pre-migration record of concept/reference_panel/
    // audiovisual_direction/storyboard confirmations — those were never written as a
    // status='confirmed' creative_messages card the way final_card/video_prompt were, so
    // the message replay above alone would leave old sessions missing most of their
    // confirmed-cards canvas history. Replay each session's confirmedCards array too, in
    // its original (chronological) order, so latestConfirmedCard() still finds them.
    for (const session of sessions) {
      let workspace = {};
      try { workspace = JSON.parse(session.workspace_json || "{}"); } catch { continue; }
      for (const card of workspace.confirmedCards || []) {
        if (!card?.id || !card?.kind) continue;
        insertCardVersion(session.id, null, card);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

backfillCreativeCardsFromMessages();

export function serializeAnalysis(row) {
  if (!row) return null;
  const screenshots = db.prepare(`
    SELECT id, episode_index, timestamp_seconds, width, height
    FROM drama_screenshots WHERE analysis_id = ? ORDER BY episode_index,timestamp_seconds
  `).all(row.id);
  const faceCandidates = db.prepare(`
    SELECT id,episode_index,candidate_id,character_id,timestamp_seconds,view,yaw_degrees,quality_score,overlay_score,overlay_regions_json,needs_cleanup
    FROM drama_face_candidates WHERE analysis_id=? ORDER BY episode_index,timestamp_seconds,id
  `).all(row.id);
  const episodes = db.prepare("SELECT id,episode_index,original_name,mime_type,file_size,duration_seconds,width,height FROM drama_episodes WHERE analysis_id=? ORDER BY episode_index").all(row.id);
  return {
    id: row.id,
    title: row.title,
    originalName: row.original_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    status: row.status,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    result: row.analysis_json ? JSON.parse(row.analysis_json) : null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    videoUrl: row.video_path && fs.existsSync(row.video_path) ? `/api/dramas/${row.id}/video` : "",
    sourceId: row.external_source_id || "",
    inputType: episodes.length > 1 ? "series_folder" : "single_video",
    episodes: episodes.map((item) => ({ id: item.id, episodeIndex: item.episode_index, originalName: item.original_name, mimeType: item.mime_type, fileSize: item.file_size, durationSeconds: item.duration_seconds, width: item.width, height: item.height, videoUrl: `/api/dramas/${row.id}/episodes/${item.episode_index}/video` })),
    screenshots: screenshots.map((item) => ({
      id: item.id,
      episodeIndex: item.episode_index,
      timestampSeconds: item.timestamp_seconds,
      width: item.width,
      height: item.height,
      url: `/api/screenshots/${item.id}`,
    })),
    faceCandidates: faceCandidates.map((item) => ({
      id: item.id,
      episodeIndex: item.episode_index,
      candidateId: item.candidate_id,
      characterId: item.character_id || "",
      timestampSeconds: item.timestamp_seconds,
      view: item.view,
      yawDegrees: item.yaw_degrees,
      qualityScore: item.quality_score,
      overlayScore: Number(item.overlay_score || 0),
      overlayRegions: (() => { try { return JSON.parse(item.overlay_regions_json || "[]"); } catch { return []; } })(),
      needsCleanup: Boolean(item.needs_cleanup),
      url: `/api/face-candidates/${item.id}`,
    })),
  };
}

export function serializeGameAnalysis(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    storeUrl: row.store_url,
    platform: row.platform,
    status: row.status,
    result: row.analysis_json ? JSON.parse(row.analysis_json) : null,
    errorMessage: row.error_message,
    codexThreadId: row.codex_thread_id,
    source: row.source_json ? JSON.parse(row.source_json) : null,
    sourceId: row.external_source_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function creativeAssets(sessionId, includeDeleted = false) {
  const visualKinds = new Set(["final_card", "character_image", "prop_image", "reference_image", "storyboard_image"]);
  const rows = db.prepare("SELECT id,cards_json,created_at FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id").all(sessionId);
  const seen = new Set();
  const deletedUrls = new Set(db.prepare("SELECT asset_url FROM creative_asset_deletions WHERE session_id=?").all(sessionId).map((row) => row.asset_url));
  const assets = [];
  let assetNumber = 0;
  for (const row of rows) {
    let cards;
    try { cards = JSON.parse(row.cards_json || "[]"); } catch { cards = []; }
    for (const card of cards) {
      const url = String(card.previewUrl || "");
      if (!visualKinds.has(card.kind) || !url || seen.has(url)) continue;
      if (!/^https?:\/\//.test(url) && !/^\/api\/screenshots\/\d+$/.test(url) && !/^\/api\/creative\/chat-attachments\/\d+\/[^/]+$/.test(url)) continue;
      seen.add(url);
      assetNumber += 1;
      const asset = {
        number: assetNumber,
        reference: `图片 ${String(assetNumber).padStart(2, "0")}`,
        kind: card.kind,
        title: card.title || "未命名图片",
        description: card.summary || card.details?.find((item) => item.label)?.content || "创意工作流图片资产",
        url,
        sourceCardId: card.id || "",
        version: Number(card.version || 1),
        createdAt: row.created_at,
        deleted: deletedUrls.has(url),
      };
      if (includeDeleted || !asset.deleted) assets.push(asset);
    }
  }
  return assets;
}

export function deleteCreativeAsset(sessionId, assetNumber) {
  const asset = creativeAssets(sessionId, true).find((item) => item.number === assetNumber && !item.deleted);
  if (!asset) return null;
  db.prepare(`
    INSERT INTO creative_asset_deletions(session_id,asset_url,asset_number,deleted_at)
    VALUES(?,?,?,?)
    ON CONFLICT(session_id,asset_url) DO UPDATE SET asset_number=excluded.asset_number,deleted_at=excluded.deleted_at
  `).run(sessionId, asset.url, asset.number, now());
  return asset;
}

export function creativeScreenshotAssets(sessionId) {
  const session = db.prepare("SELECT drama_id FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) return [];
  const drama = db.prepare("SELECT analysis_json FROM drama_analyses WHERE id=?").get(session.drama_id);
  const analysis = drama?.analysis_json ? JSON.parse(drama.analysis_json) : {};
  const sourceCandidates = dramaReferenceImageCandidates(analysis);
  const roleByScreenshotId = new Map();
  const roleLabels = { maleFront: "男主正面", maleSide: "男主侧面", femaleFront: "女主正面", femaleSide: "女主侧面" };
  for (const [key, candidate] of Object.entries(sourceCandidates)) {
    if (candidate?.screenshotId) roleByScreenshotId.set(Number(candidate.screenshotId), roleLabels[key] || candidate.character || "人物参考");
  }
  const localShots = db.prepare("SELECT id,episode_index,timestamp_seconds,width,height FROM drama_screenshots WHERE analysis_id=? ORDER BY episode_index,timestamp_seconds,id").all(session.drama_id)
    .map((shot, index) => ({
      number: index + 1,
      reference: `截图 ${String(index + 1).padStart(2, "0")}`,
      kind: "video_screenshot",
      title: roleByScreenshotId.get(shot.id) || `第 ${shot.episode_index} 集 · ${Number(shot.timestamp_seconds).toFixed(2)} 秒关键帧`,
      description: `第 ${shot.episode_index} 集 ${Number(shot.timestamp_seconds).toFixed(2)} 秒的短剧原视频截图，${shot.width}×${shot.height}${roleByScreenshotId.has(shot.id) ? `；已标记为${roleByScreenshotId.get(shot.id)}` : ""}。`,
      url: `/api/screenshots/${shot.id}`,
      screenshotId: shot.id,
      timestampSeconds: shot.timestamp_seconds,
      version: 1,
    }));
  if (localShots.length) return localShots;
  // 云端已解析短剧没有本地原视频，没有 drama_screenshots 行；退回远端提供的整集拼图（sourceMedia 里的
  // episode_sheet 项），保证"视频截图区"仍有内容可看、可引用。
  return (Array.isArray(analysis.sourceMedia) ? analysis.sourceMedia : [])
    .filter((item) => item?.kind === "episode_sheet" && item.url)
    .map((item, index) => ({
      number: index + 1,
      reference: `截图 ${String(index + 1).padStart(2, "0")}`,
      kind: "video_screenshot",
      title: item.title || `拼图 ${index + 1}`,
      description: `远端整剧分析提供的剧集拼图（无精确时间码）。`,
      url: item.url,
      screenshotId: item.key,
      timestampSeconds: 0,
      version: 1,
    }));
}

export function creativeCharacterReferenceAssets(sessionId) {
  const session = db.prepare("SELECT drama_id FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) return [];
  const drama = db.prepare("SELECT analysis_json FROM drama_analyses WHERE id=?").get(session.drama_id);
  let analysis = {};
  try { analysis = JSON.parse(drama?.analysis_json || "{}"); } catch { return []; }
  const episodes = Array.isArray(analysis.episodeAnalyses) ? analysis.episodeAnalyses : [];
  const viewOrder = ["front", "three_quarter_left", "three_quarter_right", "left_profile", "right_profile"];
  const viewLabels = { front: "正面", three_quarter_left: "左侧 3/4", three_quarter_right: "右侧 3/4", left_profile: "左侧面", right_profile: "右侧面" };
  // 同一个角色可能在多集的 characterLibrary 里重复出现（本地多集分析里是同一角色的不同镜头，
  // 云端整剧分析里则是完全相同的一份数据被复制到每一集）；按 characterId 合并后再挑每个视角最好
  // 的一张，避免角色卡片按集数重复。
  const charactersById = new Map();
  for (const character of episodes.flatMap((item) => item?.characterLibrary?.characters || [])) {
    const id = character.characterId || character.displayName;
    const existing = charactersById.get(id);
    if (existing) existing.candidates = [...(existing.candidates || []), ...(character.candidates || [])];
    else charactersById.set(id, { ...character, candidates: [...(character.candidates || [])] });
  }
  const selected = [];
  for (const character of charactersById.values()) {
    const bestByView = new Map();
    for (const candidate of character.candidates || []) {
      const current = bestByView.get(candidate.view);
      if (!current || Number(candidate.qualityScore || 0) > Number(current.qualityScore || 0)) bestByView.set(candidate.view, candidate);
    }
    for (const view of viewOrder) {
      const candidate = bestByView.get(view);
      if (candidate?.screenshotId == null && !candidate?.url) continue;
      selected.push({ character, candidate, view });
    }
  }
  const assets = selected.map(({ character, candidate, view }) => ({
    kind: "character_reference",
    title: `${character.displayName || character.characterId}｜${viewLabels[view] || view}`,
    description: `${character.narrativeRole || "unknown"}；来自短剧原视频 ${Number(candidate.timestampSeconds || 0).toFixed(2)} 秒；本地质量分 ${Number(candidate.qualityScore || 0).toFixed(2)}。`,
    url: candidate.url || `/api/face-candidates/${candidate.screenshotId}`,
    characterId: character.characterId,
    candidateId: candidate.candidateId,
    timestampSeconds: candidate.timestampSeconds,
    view,
    qualityScore: candidate.qualityScore,
    overlayScore: candidate.overlayScore,
    overlayRegions: candidate.overlayRegions || [],
    needsCleanup: Boolean(candidate.needsCleanup),
    version: 1,
  }));
  const latestCards = new Map();
  const rows = db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id").all(sessionId);
  for (const row of rows) {
    let messageCards = [];
    try { messageCards = JSON.parse(row.cards_json || "[]"); } catch { /* ignore malformed history */ }
    for (const card of messageCards) if (card.kind === "character_image" && card.id) latestCards.set(card.id, card);
  }
  const seenUrls = new Set(assets.map((asset) => asset.url));
  for (const card of latestCards.values()) {
    const url = String(card.previewUrl || "");
    if (!url || seenUrls.has(url) || ["failed", "generating", "superseded"].includes(card.status)) continue;
    const details = new Map((card.details || []).map((item) => [item.label, item.content]));
    const timeValue = Number.parseFloat(String(details.get("时间点") || ""));
    assets.push({
      kind: "character_reference",
      title: card.title || "人物参考候选",
      description: card.summary || "工作台中新增或生成的人物参考候选。",
      url,
      characterId: details.get("人物编号") || card.id,
      candidateId: details.get("候选编号") || card.id,
      timestampSeconds: Number.isFinite(timeValue) ? timeValue : null,
      view: details.get("画面角度") || "custom",
      qualityScore: details.get("本地质量分") || null,
      overlayScore: 0,
      overlayRegions: [],
      needsCleanup: false,
      version: Number(card.version || 1),
    });
    seenUrls.add(url);
  }
  return assets.map((asset, index) => ({
    ...asset,
    number: index + 1,
    reference: `人物图 ${String(index + 1).padStart(2, "0")}`,
  }));
}

export function resolveAssetReferences(sessionId, text) {
  const imageByNumber = new Map(creativeAssets(sessionId).map((asset) => [asset.number, asset]));
  const screenshotByNumber = new Map(creativeScreenshotAssets(sessionId).map((asset) => [asset.number, asset]));
  const characterByNumber = new Map(creativeCharacterReferenceAssets(sessionId).map((asset) => [asset.number, asset]));
  const value = String(text || "");
  const imageNumbers = [...new Set([...value.matchAll(/(?:参考)?图片\s*0*(\d+)/gi)].map((match) => Number(match[1])))];
  const screenshotNumbers = [...new Set([...value.matchAll(/(?:视频)?截图\s*0*(\d+)/gi)].map((match) => Number(match[1])))];
  const characterNumbers = [...new Set([...value.matchAll(/人物图\s*0*(\d+)/gi)].map((match) => Number(match[1])))];
  const missingImages = imageNumbers.filter((number) => !imageByNumber.has(number));
  const missingScreenshots = screenshotNumbers.filter((number) => !screenshotByNumber.has(number));
  const missingCharacters = characterNumbers.filter((number) => !characterByNumber.has(number));
  if (missingImages.length || missingScreenshots.length || missingCharacters.length) {
    const missing = [missingImages.length ? `图片 ${missingImages.map((number) => String(number).padStart(2, "0")).join("、")}` : "", missingScreenshots.length ? `截图 ${missingScreenshots.map((number) => String(number).padStart(2, "0")).join("、")}` : "", missingCharacters.length ? `人物图 ${missingCharacters.map((number) => String(number).padStart(2, "0")).join("、")}` : ""].filter(Boolean).join("；");
    throw new Error(`找不到资产${missing}`);
  }
  return [...imageNumbers.map((number) => imageByNumber.get(number)), ...screenshotNumbers.map((number) => screenshotByNumber.get(number)), ...characterNumbers.map((number) => characterByNumber.get(number))];
}

function conceptRevisionFeedback(content) {
  const text = String(content || "");
  const target = text.match(/(?:concept-|方案\s*)([A-Z])\b/i)?.[1]?.toUpperCase();
  if (!target || !/(?:修改聊天候选卡|重新生成方案|修改方案)/.test(text)) return null;
  const feedback = text.match(/(?:我的)?修改意见[：:]\s*([\s\S]*?)(?:(?:\n\n|。)请(?:返回|直接)|$)/)?.[1]?.trim() || "按本轮要求修改方案";
  return { target, feedback };
}

function conceptRevisionHistory(messages) {
  const history = {};
  const pendingFeedback = new Map();
  for (const message of messages) {
    if (message.role === "user") {
      const revision = conceptRevisionFeedback(message.content);
      if (revision) pendingFeedback.set(revision.target, { feedback: revision.feedback, createdAt: message.created_at });
      continue;
    }
    let cards = [];
    try { cards = JSON.parse(message.cards_json || "[]"); } catch { /* Ignore malformed historical cards. */ }
    for (const card of cards.filter((item) => item.kind === "concept" && /^concept-[A-Z]$/i.test(item.id || ""))) {
      const conceptId = card.id.slice(-1).toUpperCase();
      history[conceptId] ||= [];
      const pending = pendingFeedback.get(conceptId);
      if (history[conceptId].length && !pending) continue;
      history[conceptId].push({
        version: history[conceptId].length + 1,
        feedback: pending?.feedback || "初始方案",
        title: card.title || `方案 ${conceptId}`,
        summary: card.summary || "",
        details: card.details || [],
        status: "completed",
        createdAt: message.created_at,
      });
      pendingFeedback.delete(conceptId);
    }
  }
  for (const [conceptId, pending] of pendingFeedback) {
    history[conceptId] ||= [];
    history[conceptId].push({
      version: history[conceptId].length + 1,
      feedback: pending.feedback,
      title: `方案 ${conceptId} 修改版生成中`,
      summary: "Novvy 正在根据这条修改意见生成新版本，完成后会在这个节点原位更新。",
      details: [], status: "generating", createdAt: pending.createdAt,
    });
  }
  return history;
}

function finalCardRevisionFeedback(content) {
  const text = String(content || "");
  const target = text.match(/修改聊天候选卡\s*(final-card-[^\s（]+)/i)?.[1];
  if (!target) return null;
  const feedback = text.match(/(?:我的)?修改意见[：:]\s*([\s\S]*?)(?:(?:\n\n|。)请(?:返回|直接)|$)/)?.[1]?.trim() || "按本轮要求修改落版方案";
  return { target, feedback };
}

function finalCardRevisionHistory(messages) {
  const history = {};
  const pendingFeedback = new Map();
  for (const message of messages) {
    if (message.role === "user") {
      const revision = finalCardRevisionFeedback(message.content);
      if (revision) pendingFeedback.set(revision.target, { feedback: revision.feedback, createdAt: message.created_at });
      continue;
    }
    let cards = [];
    try { cards = JSON.parse(message.cards_json || "[]"); } catch { /* Ignore malformed historical cards. */ }
    for (const card of cards.filter((item) => item.kind === "final_card" && item.id)) {
      history[card.id] ||= [];
      const pending = pendingFeedback.get(card.id);
      if (history[card.id].length && !pending) continue;
      history[card.id].push({
        version: history[card.id].length + 1,
        feedback: pending?.feedback || "初始方案",
        title: card.title || "落版方案",
        summary: card.summary || "",
        details: card.details || [],
        status: "completed",
        createdAt: message.created_at,
      });
      pendingFeedback.delete(card.id);
    }
  }
  for (const [cardId, pending] of pendingFeedback) {
    history[cardId] ||= [];
    history[cardId].push({
      version: history[cardId].length + 1,
      feedback: pending.feedback,
      title: "落版方案修改版生成中",
      summary: "Novvy 正在根据这条修改意见生成新版本，完成后会在这个节点原位更新。",
      details: [], status: "generating", createdAt: pending.createdAt,
    });
  }
  return history;
}

export function serializeCreativeSession(row) {
  if (!row) return null;
  const drama = db.prepare("SELECT * FROM drama_analyses WHERE id = ?").get(row.drama_id);
  const game = db.prepare("SELECT * FROM game_analyses WHERE id = ?").get(row.game_id);
  const messages = db.prepare("SELECT id, role, content, cards_json, attachments_json, created_at FROM creative_messages WHERE session_id = ? AND COALESCE(visibility,'chat')='chat' ORDER BY id").all(row.id);
  const landingPackages = db.prepare("SELECT prompt_card_id,file_name,store_url,app_name,created_at FROM creative_landing_packages WHERE session_id=? ORDER BY id DESC").all(row.id).map((item) => ({
    promptCardId: item.prompt_card_id,
    fileName: item.file_name,
    storeUrl: item.store_url,
    appName: item.app_name,
    createdAt: item.created_at,
    downloadUrl: `/api/generated/landing-pages/${encodeURIComponent(item.file_name)}`,
  }));
  return {
    id: row.id, title: row.title, stage: row.stage,
    workspace: row.workspace_json ? JSON.parse(row.workspace_json) : null,
    codexThreadId: row.codex_thread_id, errorMessage: row.error_message,
    drama: serializeAnalysis(drama),
    game: serializeGameAnalysis(game),
    conceptRevisions: conceptRevisionHistory(messages),
    finalCardRevisions: finalCardRevisionHistory(messages),
    messages: messages.map((message) => ({
      id: message.id, role: message.role, content: message.content,
      cards: message.cards_json ? JSON.parse(message.cards_json) : [],
      attachments: message.attachments_json ? JSON.parse(message.attachments_json).map(({ storedPath, ...attachment }) => attachment) : [],
      createdAt: message.created_at,
    })),
    assets: creativeAssets(row.id),
    characterReferences: creativeCharacterReferenceAssets(row.id),
    screenshots: creativeScreenshotAssets(row.id),
    cards: liveCardsForSession(row.id),
    landingPackages,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
