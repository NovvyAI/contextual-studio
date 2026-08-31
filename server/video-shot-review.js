import { db, now } from "./database.js";
import { finalizeStoryboardVideosWithApprovedCard } from "./video-finalizer.js";
import { reviewFinalVideo } from "./video-quality-review.js";
import { recordCreativeAsset, recordCreativeFeedback, recordCreativeRunComplete, recordCreativeStage } from "./creative-telemetry.js";

function allCards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
}

export async function approveAndFinalizeVideoShots(sessionId, promptCardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const promptCard = allCards(sessionId).find((card) => card.id === promptCardId && card.kind === "video_prompt");
  if (!promptCard) throw new Error("找不到所属视频提示词卡");
  const rows = db.prepare(`SELECT s.* FROM creative_video_shots s JOIN (SELECT shot_id,MAX(version) version FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? GROUP BY shot_id) latest ON latest.shot_id=s.shot_id AND latest.version=s.version WHERE s.session_id=? AND s.prompt_card_id=? ORDER BY s.shot_order`).all(sessionId, promptCardId, sessionId, promptCardId);
  if (!rows.length || rows.some((row) => row.status !== "completed" || !row.result_url)) throw new Error("还有镜头没有生成完成，暂时不能拼接");
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  const finalUrl = await finalizeStoryboardVideosWithApprovedCard(sessionId, rows.map((row) => row.result_url));
  const qc = await reviewFinalVideo(finalUrl, rows);
  db.prepare("UPDATE creative_video_shots SET status='approved',updated_at=? WHERE session_id=? AND prompt_card_id=? AND status='completed'").run(now(), sessionId, promptCardId);
  const details = [...(promptCard.details || []).filter((item) => !["逐镜状态", "落版处理", "技术 QC", "成片 SHA-256"].includes(item.label)), { label: "逐镜状态", content: `${rows.length} 个镜头已审核并按顺序拼接` }, { label: "落版处理", content: "内容镜头完整拼接后，最后 3 秒直接追加已确认原始落版图" }, { label: "技术 QC", content: `已通过完整解码、${qc.width}×${qc.height}、${qc.durationSeconds} 秒、${qc.videoCodec}/${qc.pixelFormat}、音轨 ${qc.audioCodec}` }, { label: "成片 SHA-256", content: qc.sha256 }];
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)").run(sessionId, "逐镜视频已经确认并合成为成片，最后追加的是已确认原始落版图。你可以播放最终成片复审。", JSON.stringify([{ ...promptCard, previewUrl: finalUrl, status: "completed", details }]), now());
  db.prepare("UPDATE creative_sessions SET stage='video_review',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  recordCreativeStage(sessionId, "video_generation", { promptCardId, shotCount: rows.length, quality: qc }, { status: "awaiting_confirmation", key: `session:${sessionId}:video:${promptCardId}:${qc.sha256}` });
  recordCreativeAsset(sessionId, "generated_video", finalUrl, { stageOutputId: promptCardId, metadata: { shotCount: rows.length, sha256: qc.sha256 } });
  return finalUrl;
}

export function approveFinalVideo(sessionId, promptCardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = allCards(sessionId).find((item) => item.id === promptCardId && item.kind === "video_prompt" && item.previewUrl);
  if (!card) throw new Error("找不到可确认的最终成片");
  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  workspace.confirmedCards ||= [];
  const alreadyConfirmed = workspace.confirmedCards.some((item) => item.kind === "video_prompt" && item.status === "confirmed" && (item.details || []).some((detail) => detail.label === "最终成片" && detail.content === card.previewUrl));
  if (!alreadyConfirmed) workspace.confirmedCards.push({
    id: `confirmed-final-video-${Date.now()}`,
    kind: "video_prompt",
    title: "已确认最终成片",
    summary: "逐镜视频已经审核、按顺序拼接，并在末尾追加已确认原始落版图。",
    details: [...(card.details || []).filter((item) => item.label !== "失败原因"), { label: "最终成片", content: card.previewUrl }],
    status: "confirmed",
    confirmedAt: timestamp,
  });
  workspace.productionPlan = { ...(workspace.productionPlan || {}), videoGenerationStatus: "approved" };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认最终成片：${promptCardId}`, timestamp);
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, "最终成片已经确认，并已保存到左侧工作流画布。逐镜视频和历史版本仍会保留。", JSON.stringify([{ ...card, status: "confirmed", details: (card.details || []).filter((item) => item.label !== "失败原因") }]), timestamp);
  db.prepare("UPDATE creative_sessions SET stage='video_review',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
  recordCreativeFeedback(sessionId, `确认最终成片：${promptCardId}`, { decision: "approved", assetId: promptCardId, key: `session:${sessionId}:final-video:${promptCardId}:approved` });
  recordCreativeStage(sessionId, "video_review", { promptCardId, previewUrl: card.previewUrl }, { status: "confirmed", key: `session:${sessionId}:video-review:${promptCardId}:confirmed` });
  recordCreativeRunComplete(sessionId, "completed");
}
