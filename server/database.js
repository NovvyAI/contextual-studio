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

export const now = () => new Date().toISOString();

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

export function serializeAnalysis(row) {
  if (!row) return null;
  const screenshots = db.prepare(`
    SELECT id, timestamp_seconds, width, height
    FROM drama_screenshots WHERE analysis_id = ? ORDER BY timestamp_seconds
  `).all(row.id);
  const faceCandidates = db.prepare(`
    SELECT id,candidate_id,character_id,timestamp_seconds,view,yaw_degrees,quality_score
    FROM drama_face_candidates WHERE analysis_id=? ORDER BY timestamp_seconds,id
  `).all(row.id);
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
    videoUrl: `/api/dramas/${row.id}/video`,
    screenshots: screenshots.map((item) => ({
      id: item.id,
      timestampSeconds: item.timestamp_seconds,
      width: item.width,
      height: item.height,
      url: `/api/screenshots/${item.id}`,
    })),
    faceCandidates: faceCandidates.map((item) => ({
      id: item.id,
      candidateId: item.candidate_id,
      characterId: item.character_id || "",
      timestampSeconds: item.timestamp_seconds,
      view: item.view,
      yawDegrees: item.yaw_degrees,
      qualityScore: item.quality_score,
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
  return db.prepare("SELECT id,timestamp_seconds,width,height FROM drama_screenshots WHERE analysis_id=? ORDER BY timestamp_seconds,id").all(session.drama_id)
    .map((shot, index) => ({
      number: index + 1,
      reference: `截图 ${String(index + 1).padStart(2, "0")}`,
      kind: "video_screenshot",
      title: roleByScreenshotId.get(shot.id) || `${Number(shot.timestamp_seconds).toFixed(2)} 秒关键帧`,
      description: `${Number(shot.timestamp_seconds).toFixed(2)} 秒的短剧原视频截图，${shot.width}×${shot.height}${roleByScreenshotId.has(shot.id) ? `；已标记为${roleByScreenshotId.get(shot.id)}` : ""}。`,
      url: `/api/screenshots/${shot.id}`,
      screenshotId: shot.id,
      timestampSeconds: shot.timestamp_seconds,
      version: 1,
    }));
}

export function creativeCharacterReferenceAssets(sessionId) {
  const session = db.prepare("SELECT drama_id FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) return [];
  const drama = db.prepare("SELECT analysis_json FROM drama_analyses WHERE id=?").get(session.drama_id);
  let analysis = {};
  try { analysis = JSON.parse(drama?.analysis_json || "{}"); } catch { return []; }
  const episode = Array.isArray(analysis.episodeAnalyses) ? analysis.episodeAnalyses.at(-1) : null;
  const viewOrder = ["front", "three_quarter_left", "three_quarter_right", "left_profile", "right_profile"];
  const viewLabels = { front: "正面", three_quarter_left: "左侧 3/4", three_quarter_right: "右侧 3/4", left_profile: "左侧面", right_profile: "右侧面" };
  const selected = [];
  for (const character of episode?.characterLibrary?.characters || []) {
    const bestByView = new Map();
    for (const candidate of character.candidates || []) {
      const current = bestByView.get(candidate.view);
      if (!current || Number(candidate.qualityScore || 0) > Number(current.qualityScore || 0)) bestByView.set(candidate.view, candidate);
    }
    for (const view of viewOrder) {
      const candidate = bestByView.get(view);
      if (!candidate?.screenshotId) continue;
      selected.push({ character, candidate, view });
    }
  }
  return selected.map(({ character, candidate, view }, index) => ({
    number: index + 1,
    reference: `人物图 ${String(index + 1).padStart(2, "0")}`,
    kind: "character_reference",
    title: `${character.displayName || character.characterId}｜${viewLabels[view] || view}`,
    description: `${character.narrativeRole || "unknown"}；来自短剧原视频 ${Number(candidate.timestampSeconds || 0).toFixed(2)} 秒；本地质量分 ${Number(candidate.qualityScore || 0).toFixed(2)}。`,
    url: candidate.url || `/api/face-candidates/${candidate.screenshotId}`,
    characterId: character.characterId,
    candidateId: candidate.candidateId,
    timestampSeconds: candidate.timestampSeconds,
    view,
    qualityScore: candidate.qualityScore,
    version: 1,
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
    landingPackages,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
