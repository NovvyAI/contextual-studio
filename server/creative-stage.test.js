import assert from "node:assert/strict";
import test, { after } from "node:test";
import { CREATIVE_STAGES, db, now, transitionCreativeStage } from "./database.js";

// Same real-database fixture convention as creative-cards.test.js: status: "test_fixture"
// keeps rows out of any real "completed" query, and after() deletes everything this file
// creates so a test run never leaves stray data in the shared dev database.
const createdSessionIds = [];
const createdDramaIds = [];
const createdGameIds = [];

function fixtureSession() {
  const timestamp = now();
  const dramaId = Number(db.prepare("INSERT INTO drama_analyses (title,original_name,video_path,file_size,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("test drama", "test.mp4", "/tmp/test.mp4", 0, "test_fixture", timestamp, timestamp).lastInsertRowid);
  const gameId = Number(db.prepare("INSERT INTO game_analyses (store_url,platform,status,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run("https://play.google.com/store/apps/details?id=test", "google_play", "test_fixture", timestamp, timestamp).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO creative_sessions (drama_id,game_id,title,stage,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(dramaId, gameId, "test session", "concept_review", "stale prior error", timestamp, timestamp).lastInsertRowid);
  createdDramaIds.push(dramaId);
  createdGameIds.push(gameId);
  createdSessionIds.push(sessionId);
  return sessionId;
}

function readSession(sessionId) {
  return db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
}

after(() => {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of createdSessionIds) db.prepare("DELETE FROM creative_sessions WHERE id=?").run(id);
    for (const id of createdDramaIds) db.prepare("DELETE FROM drama_analyses WHERE id=?").run(id);
    for (const id of createdGameIds) db.prepare("DELETE FROM game_analyses WHERE id=?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});

test("transitionCreativeStage rejects an unknown stage name", () => {
  const sessionId = fixtureSession();
  assert.throws(() => transitionCreativeStage(sessionId, "not_a_real_stage"), /未知的创意工作台阶段/);
});

test("transitionCreativeStage accepts every stage CREATIVE_STAGES lists", () => {
  const sessionId = fixtureSession();
  for (const stage of CREATIVE_STAGES) {
    transitionCreativeStage(sessionId, stage);
    assert.equal(readSession(sessionId).stage, stage);
  }
});

test("transitionCreativeStage clears error_message by default", () => {
  const sessionId = fixtureSession();
  assert.equal(readSession(sessionId).error_message, "stale prior error");
  transitionCreativeStage(sessionId, "working");
  assert.equal(readSession(sessionId).error_message, null);
});

test("transitionCreativeStage sets error_message when given one", () => {
  const sessionId = fixtureSession();
  transitionCreativeStage(sessionId, "error", { errorMessage: "boom" });
  assert.equal(readSession(sessionId).error_message, "boom");
});

test("transitionCreativeStage keepErrorMessage leaves a prior error untouched", () => {
  const sessionId = fixtureSession();
  transitionCreativeStage(sessionId, "working", { keepErrorMessage: true });
  const row = readSession(sessionId);
  assert.equal(row.stage, "working");
  assert.equal(row.error_message, "stale prior error");
});

test("transitionCreativeStage only writes workspace_json and codex_thread_id when explicitly given", () => {
  const sessionId = fixtureSession();
  transitionCreativeStage(sessionId, "working");
  assert.equal(readSession(sessionId).workspace_json, null);
  transitionCreativeStage(sessionId, "concept_review", { workspaceJson: JSON.stringify({ a: 1 }), codexThreadId: "thread-1" });
  const row = readSession(sessionId);
  assert.equal(row.workspace_json, JSON.stringify({ a: 1 }));
  assert.equal(row.codex_thread_id, "thread-1");
});
