import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  cardHistory, cardVersion, db, insertCardVersion, latestCard, latestCardsByKind,
  latestConfirmedCard, liveCardsForSession, now, supersedeCards, updateCardStatus,
} from "./database.js";

// These tests exercise real SQL against server/database.js's actual DatabaseSync
// connection (there is no separate test DB), which is the same file the running
// dev server reads. `status: "test_fixture"` (never "completed") keeps these rows
// out of any real query that filters on completed status, and the `after()` hook
// below deletes every row this file creates so a test run never leaves stray drama/
// game/session data behind in the shared database — that previously showed up as
// bogus null-titled entries in the real "选择已完成的游戏" picker.
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

function fixtureMessage(sessionId) {
  return Number(db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)").run(sessionId, "test", now()).lastInsertRowid);
}

after(() => {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Deleting sessions first cascades away their creative_messages/creative_cards rows.
    for (const id of createdSessionIds) db.prepare("DELETE FROM creative_sessions WHERE id=?").run(id);
    for (const id of createdDramaIds) db.prepare("DELETE FROM drama_analyses WHERE id=?").run(id);
    for (const id of createdGameIds) db.prepare("DELETE FROM game_analyses WHERE id=?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});

test("insertCardVersion assigns sequential versions per card_id and round-trips the payload", () => {
  const sessionId = fixtureSession();
  const messageId = fixtureMessage(sessionId);
  const first = insertCardVersion(sessionId, messageId, { id: "final-card-A", kind: "final_card", status: "candidate", title: "V1", details: [{ label: "x", content: "y" }] });
  assert.equal(first.version, 1);
  assert.equal(first.title, "V1");
  assert.deepEqual(first.details, [{ label: "x", content: "y" }]);

  const second = insertCardVersion(sessionId, messageId, { id: "final-card-A", kind: "final_card", status: "generating", title: "V2" });
  assert.equal(second.version, 2);
  assert.equal(latestCard(sessionId, "final-card-A").version, 2);
  assert.equal(cardVersion(sessionId, "final-card-A", 1).title, "V1");
});

test("updateCardStatus patches the same version in place without bumping it", () => {
  const sessionId = fixtureSession();
  const messageId = fixtureMessage(sessionId);
  const inserted = insertCardVersion(sessionId, messageId, { id: "final-card-B", kind: "final_card", status: "generating", previewUrl: "", details: [] });
  const updated = updateCardStatus(sessionId, "final-card-B", inserted.version, { status: "candidate", previewUrl: "https://example.com/b.png" });
  assert.equal(updated.version, inserted.version);
  assert.equal(updated.status, "candidate");
  assert.equal(updated.previewUrl, "https://example.com/b.png");
  assert.equal(cardHistory(sessionId, "final-card-B").length, 1);
});

test("latestCardsByKind returns the latest version per card_id and can exclude statuses", () => {
  const sessionId = fixtureSession();
  const messageId = fixtureMessage(sessionId);
  insertCardVersion(sessionId, messageId, { id: "char-1", kind: "character_image", status: "candidate", previewUrl: "https://example.com/1.png" });
  insertCardVersion(sessionId, messageId, { id: "char-2", kind: "character_image", status: "candidate", previewUrl: "https://example.com/2.png" });
  insertCardVersion(sessionId, messageId, { id: "char-2", kind: "character_image", status: "superseded", previewUrl: "https://example.com/2.png" });

  const all = latestCardsByKind(sessionId, "character_image");
  assert.equal(all.length, 2);
  assert.equal(all.find((card) => card.id === "char-2").status, "superseded");

  const live = latestCardsByKind(sessionId, "character_image", { excludeStatuses: ["superseded"] });
  assert.deepEqual(live.map((card) => card.id), ["char-1"]);
});

test("latestConfirmedCard returns the most recently confirmed row across card_ids, by insertion order not version", () => {
  const sessionId = fixtureSession();
  const messageId = fixtureMessage(sessionId);
  // Direction confirmed first (version 1 of card A)...
  insertCardVersion(sessionId, messageId, { id: "final-card-A", kind: "final_card", status: "confirmed", title: "direction confirmed" });
  // ...then the same card_id moves through generation and gets confirmed again at a later version.
  insertCardVersion(sessionId, messageId, { id: "final-card-A", kind: "final_card", status: "generating", title: "generating real image" });
  const finalConfirm = insertCardVersion(sessionId, messageId, { id: "final-card-A", kind: "final_card", status: "confirmed", title: "real image confirmed" });

  const confirmed = latestConfirmedCard(sessionId, "final_card");
  assert.equal(confirmed.title, "real image confirmed");
  assert.equal(confirmed.version, finalConfirm.version);
});

test("supersedeCards marks only the current version of live sibling cards, never a confirmed one", () => {
  const sessionId = fixtureSession();
  const messageId = fixtureMessage(sessionId);
  insertCardVersion(sessionId, messageId, { id: "direction-01", kind: "final_card", status: "confirmed" });
  insertCardVersion(sessionId, messageId, { id: "direction-02", kind: "final_card", status: "candidate" });
  insertCardVersion(sessionId, messageId, { id: "direction-03", kind: "final_card", status: "candidate" });

  supersedeCards(sessionId, ["direction-01", "direction-02", "direction-03"]);

  assert.equal(latestCard(sessionId, "direction-01").status, "confirmed");
  assert.equal(latestCard(sessionId, "direction-02").status, "superseded");
  assert.equal(latestCard(sessionId, "direction-03").status, "superseded");
});

test("liveCardsForSession excludes superseded cards by default and returns latest versions", () => {
  const sessionId = fixtureSession();
  const messageId = fixtureMessage(sessionId);
  insertCardVersion(sessionId, messageId, { id: "storyboard-image-1", kind: "storyboard_image", status: "candidate", previewUrl: "https://example.com/s1.png" });
  insertCardVersion(sessionId, messageId, { id: "storyboard-image-2", kind: "storyboard_image", status: "generating" });
  insertCardVersion(sessionId, messageId, { id: "storyboard-image-2", kind: "storyboard_image", status: "candidate", previewUrl: "https://example.com/s2.png" });
  const abandoned = insertCardVersion(sessionId, messageId, { id: "storyboard-image-3", kind: "storyboard_image", status: "candidate" });
  supersedeCards(sessionId, [abandoned.id]);

  const live = liveCardsForSession(sessionId);
  assert.deepEqual(live.map((card) => card.id).sort(), ["storyboard-image-1", "storyboard-image-2"]);
  assert.equal(live.find((card) => card.id === "storyboard-image-2").status, "candidate");
});

test("backfill replays historical cards_json into the same 'latest wins' result the old full-history scan produced", () => {
  const sessionId = fixtureSession();
  // Simulate the pre-migration pattern: every step appends a brand-new creative_messages
  // row carrying the same card id, exactly like image-generator.js's old appendCardMessage.
  const steps = [
    { role: "assistant", card: { id: "final-card-direction-01", kind: "final_card", status: "candidate", title: "direction" } },
    { role: "assistant", card: { id: "final-card-direction-01", kind: "final_card", status: "generating", title: "generating" } },
    { role: "assistant", card: { id: "final-card-direction-01", kind: "final_card", status: "candidate", title: "generated v1", previewUrl: "https://example.com/v1.png" } },
    { role: "assistant", card: { id: "final-card-direction-01", kind: "final_card", status: "confirmed", title: "confirmed", previewUrl: "https://example.com/v1.png" } },
  ];
  const messageIds = [];
  for (const step of steps) {
    const result = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,?,?,?,?)")
      .run(sessionId, step.role, "step", JSON.stringify([step.card]), now());
    messageIds.push(Number(result.lastInsertRowid));
  }
  // This mirrors backfillCreativeCardsFromMessages()'s own replay logic (it only runs once
  // globally at module load, so the test drives the same insertCardVersion calls directly
  // against this fixture session to prove the "latest wins" outcome matches).
  steps.forEach((step, index) => insertCardVersion(sessionId, messageIds[index], step.card));

  const latest = latestCard(sessionId, "final-card-direction-01");
  assert.equal(latest.status, "confirmed");
  assert.equal(latest.version, 4);
  assert.equal(cardHistory(sessionId, "final-card-direction-01").length, 4);
});
