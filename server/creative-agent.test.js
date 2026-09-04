import assert from "node:assert/strict";
import test, { after } from "node:test";
import { db, now } from "./database.js";
import { isMissingThreadError, recentMessagesDigest } from "./creative-agent.js";

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
  const sessionId = Number(db.prepare("INSERT INTO creative_sessions (drama_id,game_id,title,stage,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(dramaId, gameId, "test session", "working", timestamp, timestamp).lastInsertRowid);
  createdDramaIds.push(dramaId);
  createdGameIds.push(gameId);
  createdSessionIds.push(sessionId);
  return sessionId;
}

function fixtureMessage(sessionId, role, content) {
  return Number(db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,?,?,?)").run(sessionId, role, content, now()).lastInsertRowid);
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

test("isMissingThreadError matches typical resumeThread failure wording", () => {
  assert.equal(isMissingThreadError(new Error("thread not found")), true);
  assert.equal(isMissingThreadError(new Error("Session does not exist")), true);
  assert.equal(isMissingThreadError(new Error("No such conversation")), true);
  assert.equal(isMissingThreadError(new Error("invalid thread id")), true);
});

test("isMissingThreadError leaves unrelated failures alone so they are not silently retried", () => {
  assert.equal(isMissingThreadError(new Error("The operation was aborted due to timeout")), false);
  assert.equal(isMissingThreadError(new Error("Response did not match outputSchema")), false);
  assert.equal(isMissingThreadError(new Error("network error")), false);
  assert.equal(isMissingThreadError(undefined), false);
});

test("recentMessagesDigest returns oldest-to-newest, capped to the requested limit", () => {
  const sessionId = fixtureSession();
  fixtureMessage(sessionId, "user", "第一条");
  fixtureMessage(sessionId, "assistant", "第二条");
  fixtureMessage(sessionId, "user", "第三条");
  const digest = recentMessagesDigest(sessionId, 2);
  const lines = digest.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /第二条/);
  assert.match(lines[1], /第三条/);
});

test("recentMessagesDigest reports a placeholder for a session with no messages", () => {
  const sessionId = fixtureSession();
  assert.equal(recentMessagesDigest(sessionId), "（无历史消息）");
});
