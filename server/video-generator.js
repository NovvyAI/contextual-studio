import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { db, now } from "./database.js";
import { publicInputUrl } from "./character-generator.js";
import { runCodexWithTrace } from "./mlflow-tracing.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";
import { parseStoryboardVideoPlan, shotCard } from "./storyboard-video-plan.js";
import { finalizeVideoWithApprovedCard } from "./video-finalizer.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (value && typeof value === "object") return [value, ...Object.values(value).flatMap(walk)];
  return [value];
}
function valueFor(data, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const node of walk(data)) if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) if (wanted.has(key.toLowerCase()) && ["string", "number"].includes(typeof value)) return String(value);
  }
  return "";
}
function resultUrl(data) {
  // Query responses also contain the submitted humanImageUrls. Only explicit
  // output fields are safe to treat as the generated video.
  return valueFor(data, ["videoUrl", "resultUrl", "outputUrl", "downloadUrl"]);
}
function allCards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
}

function referenceUrl(value) {
  if (typeof value !== "string") return "";
  return value.match(/https?:\/\/[^\s，；]+|\/api\/screenshots\/\d+/)?.[0] || "";
}
function append(sessionId, content, card) {
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify([card]), now());
}

export function startVideoGeneration(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "video_prompt");
  if (!card) throw new Error("找不到视频提示词卡");
  const plan = parseStoryboardVideoPlan(card);
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const referenceGroup = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "reference_panel" && item.status === "confirmed");
  const referenceUrls = (referenceGroup?.characterReferenceUrls?.length ? referenceGroup.characterReferenceUrls : (referenceGroup?.details || []).map((item) => item.content)).map(referenceUrl).filter(Boolean);
  if (!referenceUrls.length) throw new Error("已确认人物参考图组为空");
  const confirmedStoryboard = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "storyboard" && item.status === "confirmed");
  const storyboardUrls = (confirmedStoryboard?.details || []).map((item) => referenceUrl(item.content)).filter(Boolean);
  if (storyboardUrls.length < plan.shots.length) throw new Error(`已确认分镜图不足：需要 ${plan.shots.length} 张，当前只有 ${storyboardUrls.length} 张`);
  const generateAudio = !/OutputAudioSensitiveContentDetected|output audio.*copyright/i.test(session.error_message || "");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认视频提示词并生成视频：${cardId}`, timestamp);
  append(sessionId, generateAudio
    ? "视频提示词已经确认。我正在上传人物参考并生成视频，完成后会在这张卡片里显示成片。"
    : "视频提示词已经确认。上一次任务因生成音频触发版权策略，本次将关闭生成音频并重新生成视频。", { ...card, previewUrl: "", status: "generating" });
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  generate(sessionId, card, plan, referenceUrls, storyboardUrls, generateAudio);
}

export function resumeNovvyStoryboardVideoGeneration(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "video_prompt");
  if (!card) throw new Error("找不到待恢复的视频提示词卡");
  const plan = parseStoryboardVideoPlan(card);
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const referenceGroup = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "reference_panel" && item.status === "confirmed");
  const referenceUrls = (referenceGroup?.characterReferenceUrls?.length ? referenceGroup.characterReferenceUrls : (referenceGroup?.details || []).map((item) => item.content)).map(referenceUrl).filter(Boolean);
  const confirmedStoryboard = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "storyboard" && item.status === "confirmed");
  const storyboardUrls = (confirmedStoryboard?.details || []).map((item) => referenceUrl(item.content)).filter(Boolean);
  if (!referenceUrls.length) throw new Error("已确认人物参考图组为空");
  if (storyboardUrls.length < plan.shots.length) throw new Error(`已确认分镜图不足：需要 ${plan.shots.length} 张，当前只有 ${storyboardUrls.length} 张`);
  const generateAudio = !/OutputAudioSensitiveContentDetected|output audio.*copyright/i.test(session.error_message || "");
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  generate(sessionId, card, plan, referenceUrls, storyboardUrls, generateAudio);
}

export function resumeVideoGeneration(sessionId, cardId, taskId, providerSessionId = "") {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "video_prompt");
  if (!card) throw new Error("找不到视频提示词卡");
  if (!taskId && !providerSessionId) throw new Error("缺少 Novvy 视频任务 ID");
  const timestamp = now();
  if (card.status !== "generating" || card.previewUrl) {
    append(sessionId, "视频任务仍在生成中。此前误把输入人物参考图识别成了视频预览，现已移除错误预览并继续查询原任务，不会重新创建任务。", {
      ...card,
      previewUrl: "",
      status: "generating",
      details: [...(card.details || []).filter((item) => item.label !== "视频任务"), { label: "视频任务", content: taskId || providerSessionId }],
    });
  }
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  return monitorVideoTask(sessionId, card, taskId, providerSessionId);
}

async function generate(sessionId, card, plan, referenceUrls, storyboardUrls, generateAudio) {
  try {
    const humanImageUrls = [];
    for (const url of referenceUrls) humanImageUrls.push(await publicInputUrl(url));
    const storyboardImageUrls = [];
    for (const url of storyboardUrls) storyboardImageUrls.push(await publicInputUrl(url));
    const client = new NovvyMcpClient(); await client.initialize();
    for (const shot of plan.shots) {
      const createdAt = now();
      const existing = db.prepare("SELECT * FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=? ORDER BY version DESC LIMIT 1").get(sessionId, card.id, shot.shotId);
      if (existing?.status === "completed" && existing.result_url) continue;
      const version = existing?.status === "generating" ? Number(existing.version) : Number(db.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=?").get(sessionId, card.id, shot.shotId).version);
      if (existing?.status !== "generating") {
        db.prepare("INSERT INTO creative_video_shots (session_id,prompt_card_id,shot_id,shot_order,version,provider,duration_seconds,prompt,status,created_at,updated_at) VALUES (?,?,?,?,?,'novvy',?,?,'generating',?,?)")
          .run(sessionId, card.id, shot.shotId, shot.order, version, shot.durationSeconds, shot.promptEn, createdAt, createdAt);
      }
      const storyboardImageUrl = storyboardImageUrls[shot.order - 1];
      if (!storyboardImageUrl) throw new Error(`${shot.shotId}：缺少同序号的已确认分镜图`);
      const prompt = `The single imageUrls reference is the approved storyboard frame for this exact shot. Use it as the primary constraint for composition, camera angle, scene layout, action, pose, and object placement. The humanImageUrls references control character identity, facial features, age, hairstyle, costume, and accessories. ${shot.promptEn}`;
      let taskId = existing?.status === "generating" ? existing.task_id : "";
      let providerSessionId = existing?.status === "generating" ? existing.provider_session_id : "";
      let result = null;
      if (!taskId && !providerSessionId) {
        result = unpackToolResult(await client.callTool("novvy_create_video_generation", {
          model: "seedance-2.0-fast", prompt, imageUrls: [storyboardImageUrl], humanImageUrls, ratio: "9:16", duration: shot.durationSeconds, resolution: "720p", generateAudio, includeRaw: false,
        }));
        taskId = valueFor(result, ["taskId", "task_id", "id"]); providerSessionId = valueFor(result, ["sessionId", "session_id"]);
        if (!taskId && !providerSessionId) throw new Error(`${shot.shotId}：Novvy 未返回视频任务 ID`);
        db.prepare("UPDATE creative_video_shots SET task_id=?,provider_session_id=?,updated_at=? WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND version=?")
          .run(taskId, providerSessionId, now(), sessionId, card.id, shot.shotId, version);
      }
      const deadline = Date.now() + 30 * 60 * 1000;
      let previewUrl = resultUrl(result);
      while (!previewUrl && Date.now() < deadline) {
        const status = valueFor(result, ["status", "state"]).toLowerCase();
        if (/fail|error|cancel/.test(status)) throw new Error(`${shot.shotId}：${valueFor(result, ["errorMessage", "message", "error"]) || "视频生成失败"}`);
        if (result) await wait(8000);
        result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "seedance-2.0-fast", includeRaw: false }));
        previewUrl = resultUrl(result);
      }
      if (!previewUrl) throw new Error(`${shot.shotId} 查询超时`);
      db.prepare("UPDATE creative_video_shots SET status='completed',result_url=?,updated_at=? WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND version=?")
        .run(previewUrl, now(), sessionId, card.id, shot.shotId, version);
      append(sessionId, `${shot.shotId} V${version} 已生成，可以单独播放复审。`, shotCard(card, shot, { previewUrl, status: "completed", version, details: [...shotCard(card, shot).details, { label: "版本", content: `V${version}` }, { label: "视频供应商", content: "Novvy MCP / Seedance 2.0 Fast" }, { label: "参考绑定", content: `对应分镜图 ${shot.order} + ${humanImageUrls.length} 张人物参考图` }, { label: "视频任务", content: taskId || providerSessionId }] }));
    }
    append(sessionId, "全部内容镜头已经生成。请逐镜播放复审；确认后再按顺序拼接，并追加已确认的原始落版图。", { ...card, previewUrl: "", status: "completed", details: [...(card.details || []).filter((item) => item.label !== "失败原因"), { label: "逐镜状态", content: `${plan.shots.length} 个镜头已完成，等待统一确认拼接` }] });
    db.prepare("UPDATE creative_sessions SET stage='video_review',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  } catch (error) {
    failVideoTask(sessionId, card, error);
  }
}

async function monitorVideoTask(sessionId, card, taskId, providerSessionId) {
  try {
    const client = new NovvyMcpClient(); await client.initialize();
    await pollVideoTask(client, sessionId, card, taskId, providerSessionId);
  } catch (error) {
    failVideoTask(sessionId, card, error);
  }
}

async function pollVideoTask(client, sessionId, card, taskId, providerSessionId, initialResult = null) {
  let result = initialResult;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    if (!result) {
      result = unpackToolResult(await client.callTool("novvy_query_generation", {
        ...(taskId ? { taskId } : {}),
        ...(providerSessionId ? { sessionId: providerSessionId } : {}),
        model: "seedance-2.0-fast",
        includeRaw: false,
      }));
    }
    const status = valueFor(result, ["status", "state"]).toLowerCase();
    if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "视频生成失败");
    const previewUrl = resultUrl(result);
    if (previewUrl) {
      const finalVideoUrl = await finalizeVideoWithApprovedCard(sessionId, previewUrl);
      append(sessionId, "视频已经生成完成。你可以直接播放复审，或在卡片里提出修改意见生成下一版。", {
        ...card,
        previewUrl: finalVideoUrl,
        status: "completed",
        details: [...(card.details || []).filter((item) => !["视频任务", "落版处理"].includes(item.label)), { label: "视频任务", content: taskId || providerSessionId }, { label: "落版处理", content: `完整保留 ${shot.durationSeconds} 秒内容视频，最后追加 ${productionProfile.final_assembly.final_card_duration_seconds} 秒已确认原始落版图` }],
      });
      db.prepare("UPDATE creative_sessions SET stage='video_review',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
      return;
    }
    await wait(8000);
    result = null;
  }
  throw new Error("视频仍未生成完成，查询已暂停，可稍后继续查询原任务");
}

function failVideoTask(sessionId, card, error) {
  const message = error instanceof Error ? error.message : String(error);
  const audioPolicyFailure = /OutputAudioSensitiveContentDetected|output audio.*copyright/i.test(message);
  const guidance = audioPolicyFailure ? "这是生成音频的版权策略拦截，并非播放器故障。提示词和人物参考图均已保留；点击卡片里的“关闭音频并重新生成”可创建无生成音频的新版本。" : "提示词和人物参考图组均已保留。";
  append(sessionId, `这次视频没有生成成功：${message}。${guidance}`, {
    ...card,
    previewUrl: "",
    status: "failed",
    details: [...(card.details || []).filter((item) => item.label !== "失败原因"), { label: "失败原因", content: message }],
  });
  db.prepare("UPDATE creative_sessions SET stage='prompt_review',error_message=?,updated_at=? WHERE id=?").run(message, now(), sessionId);
}

export async function translatePromptWithCodex(card) {
  const schema = { type: "object", additionalProperties: false, required: ["prompt"], properties: { prompt: { type: "string" } } };
  const codex = new Codex();
  const thread = codex.startThread({ workingDirectory: path.resolve("."), skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false });
  const audit = (card.details || []).map((item) => `${item.label}: ${item.content}`).join("\n\n");
  const input = `Convert the following approved Chinese video audit into one complete English Seedance video-generation prompt. Preserve every approved story beat and constraint. Use no more than 3 shots. All on-screen text, dialogue, voiceover, speech, CTA, and final-card copy must be English only. Keep the same male and female identities from the supplied human reference images. Do not mention URLs, model names, resolution fields, JSON, or internal implementation. Return only the required JSON object.\n\n${audit}`;
  const turn = await runCodexWithTrace(thread, input, { outputSchema: schema, signal: AbortSignal.timeout(10 * 60 * 1000) }, { name: "codex.video_prompt_translation", sessionId: `video-prompt:${card.id}` });
  const prompt = String(JSON.parse(turn.finalResponse).prompt || "").trim();
  if (!prompt) throw new Error("Novvy 未能生成英文视频提交提示词");
  return prompt;
}
