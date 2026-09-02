import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, now } from "./database.js";
import { parseStoryboardVideoPlan, shotCard } from "./storyboard-video-plan.js";
import { traceToolCall } from "./mlflow-tracing.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const VIDEO_MODEL = "seedance-2.0-fast";
const VIDEO_MODEL_LABEL = "Seedance 2.0 Fast";
const OK = new Set(["succeeded", "completed", "success"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

function config() {
  const apiKey = String(process.env.IMAROUTER_API_KEY || "").trim().replace(/^Bearer\s+/i, "");
  const baseUrl = String(process.env.IMAROUTER_BASE_URL || "https://api.imarouter.com").trim().replace(/\/+$/, "");
  if (!apiKey) throw new Error("ImaRouter 尚未配置：请在 .env 中设置 IMAROUTER_API_KEY");
  return { baseUrl, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" } };
}

async function request(url, options) {
  let body = options?.body;
  try { body = typeof body === "string" ? JSON.parse(body) : body; } catch { /* Preserve non-JSON bodies as text. */ }
  return traceToolCall("imarouter", "http_request", { method: options?.method || "GET", url, body }, async () => {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(90_000) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    if (!response.ok) throw new Error(`ImaRouter HTTP ${response.status}: ${data?.message || text.slice(0, 300)}`);
    return { httpStatus: response.status, data };
  }).then((result) => result.data);
}

function append(sessionId, content, card) {
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify([card]), now());
}

function allCards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
}

function explicitVideoUrl(data) {
  const candidates = [];
  if (Array.isArray(data?.results)) for (const item of data.results) candidates.push(typeof item === "string" ? item : item?.url);
  candidates.push(data?.metadata?.url, data?.video_url, typeof data?.output === "string" ? data.output : data?.output?.url);
  return candidates.find((value) => typeof value === "string" && /^https?:\/\//.test(value)) || "";
}

function referenceUrl(value) {
  if (typeof value !== "string") return "";
  return value.match(/https?:\/\/[^\s，；]+|\/api\/screenshots\/\d+/)?.[0] || "";
}

function privacyReferenceIndex(message, referenceCount) {
  if (!/InputImageSensitiveContentDetected\.PrivacyInformation|may contain real person/i.test(message || "")) return -1;
  const contentIndex = Number(String(message).match(/content\[(\d+)\]/i)?.[1]);
  if (!Number.isInteger(contentIndex)) return -1;
  // ImaRouter 的错误索引包含位于 content[0] 的文本，图片从 content[1] 开始。
  const imageIndex = contentIndex - 1;
  return imageIndex >= 0 && imageIndex < referenceCount ? imageIndex : -1;
}

function isOutputAudioCopyrightFailure(message) {
  return /OutputAudioSensitiveContentDetected|output audio.*copyright|output audio may be related to copyright restrictions/i.test(message || "");
}

export function orderImaRouterShotReferences(characterReferences, storyboardReference, shotOrder) {
  return {
    images: [...characterReferences, storyboardReference],
    labels: [
      ...characterReferences.map((_, index) => `人物身份参考 ${index + 1}`),
      `分镜图 ${shotOrder}`,
    ],
  };
}

function imaRouterReferenceInstruction(characterCount, storyboardAvailable = true) {
  const identityInstruction = characterCount > 0
    ? `Reference images 1 through ${characterCount} are approved six-view character panels, one panel per character. Use them only to preserve each character's identity, facial features, body proportions, hairstyle, costume, and accessories. `
    : "No character identity panel remains after provider review. Preserve character identity from the written shot description. ";
  const compositionInstruction = storyboardAvailable
    ? "The final reference image is the approved storyboard frame for this exact shot and is the authority for composition, camera angle, scene layout, action, pose, and object placement. "
    : "The storyboard reference was excluded by the provider privacy check, so follow the written shot description for composition, camera, action, pose, and object placement. ";
  return `${identityInstruction}${compositionInstruction}Do not reproduce a six-view grid, contact sheet, split screen, labels, or reference-panel layout in the generated video. `;
}

async function createAssetReference(baseUrl, headers, imageUrl) {
  const group = await request(`${baseUrl}/v1/assets/group/create`, {
    method: "POST", headers, body: JSON.stringify({ name: "contextual-studio", group_type: "AIGC", project_name: "default", model: "seedance-upload" }),
  });
  const groupId = group?.data?.Id;
  if (!group?.success || !groupId) throw new Error(`ImaRouter 创建素材分组失败：${group?.message || "未返回 groupId"}`);
  const created = await request(`${baseUrl}/v1/assets/create`, { method: "POST", headers, body: JSON.stringify({ url: imageUrl, group_id: groupId }) });
  const assetId = created?.data?.Id;
  if (!created?.success || !assetId) throw new Error(`ImaRouter 上传参考图失败：${created?.message || "未返回 assetId"}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await request(`${baseUrl}/v1/assets/get`, { method: "POST", headers, body: JSON.stringify({ id: assetId }) });
    const status = String(result?.data?.Status || "").toLowerCase();
    if (["active", "approved", "success"].includes(status)) return `asset://${assetId}`;
    if (["rejected", "failed", "error", "banned", "blocked"].includes(status)) throw new Error(`ImaRouter 参考图未通过审核（${status}）`);
    await wait(2000);
  }
  throw new Error("ImaRouter 参考图审核超时");
}

function selectReferences(workspace) {
  const confirmedStoryboard = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "storyboard" && item.status === "confirmed");
  const referenceGroup = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "reference_panel" && item.status === "confirmed");
  const storyboardUrls = (confirmedStoryboard?.details || []).map((item) => referenceUrl(item.content)).filter(Boolean);
  const characterUrls = (referenceGroup?.characterPanelUrls?.length
    ? referenceGroup.characterPanelUrls
    : [referenceGroup?.previewUrl, ...(referenceGroup?.details || []).map((item) => item.content)])
    .map(referenceUrl).filter(Boolean);
  if (!storyboardUrls.length) throw new Error("ImaRouter 没有可用的已确认分镜图");
  if (!characterUrls.length) throw new Error("ImaRouter 没有可用的已确认人物参考图");
  return {
    storyboardUrls: [...new Set(storyboardUrls)],
    characterUrls: [...new Set(characterUrls)],
    storyboardCount: storyboardUrls.length,
    characterCount: characterUrls.length,
    strategy: `${storyboardUrls.length} 张已确认分镜图 + ${characterUrls.length} 张已确认人物参考图`,
  };
}

async function materializeReference(baseUrl, headers, source) {
  const publicUrl = await ensurePublicReferenceUrl(source);
  return createAssetReference(baseUrl, headers, publicUrl);
}

async function ensurePublicReferenceUrl(source) {
  if (/^https?:\/\//i.test(source) && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(source)) return source;
  const match = source.match(/^\/api\/screenshots\/(\d+)$/);
  if (!match) throw new Error(`ImaRouter 无法读取参考图：${source}`);
  const screenshotId = Number(match[1]);
  const screenshot = db.prepare("SELECT image_blob,mime_type FROM drama_screenshots WHERE id=?").get(screenshotId);
  if (!screenshot) throw new Error("ImaRouter 人物参考截图不存在");
  const bucket = String(process.env.IMAROUTER_GCS_BUCKET || "novvy-seedance-public").trim();
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(bucket)) throw new Error("IMAROUTER_GCS_BUCKET 配置无效");
  const extension = screenshot.mime_type === "image/png" ? "png" : "jpg";
  const objectPath = `contextual-studio/screenshots/${screenshotId}.${extension}`;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-imarouter-"));
  const localPath = path.join(tempDir, `reference.${extension}`);
  try {
    await fsp.writeFile(localPath, screenshot.image_blob);
    await execFileAsync("gcloud", ["storage", "cp", localPath, `gs://${bucket}/${objectPath}`], { maxBuffer: 4 * 1024 * 1024 });
    return `https://storage.googleapis.com/${bucket}/${objectPath}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`人物参考图上传 GCS 失败：${detail}`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export function startImaRouterVideoGeneration(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  config();
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "video_prompt");
  if (!card) throw new Error("找不到视频提示词卡");
  const plan = parseStoryboardVideoPlan(card);
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const reference = selectReferences(workspace);
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `使用 ImaRouter 生成视频：${cardId}`, timestamp);
  append(sessionId, `已选择 ImaRouter。正在准备逐镜分镜图和多人物参考图，然后通过 ${VIDEO_MODEL_LABEL} 生成视频。参考策略：${reference.strategy}。`, {
    ...card, previewUrl: "", status: "generating",
    details: [...(card.details || []).filter((item) => !["视频供应商", "参考策略"].includes(item.label)), { label: "视频供应商", content: `ImaRouter / ${VIDEO_MODEL_LABEL}` }, { label: "参考策略", content: reference.strategy }],
  });
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  generate(sessionId, card, plan, reference);
}

export function resumeImaRouterVideoGeneration(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "video_prompt");
  if (!card) throw new Error("找不到待恢复的视频提示词卡");
  const plan = parseStoryboardVideoPlan(card);
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const reference = selectReferences(workspace);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  generate(sessionId, card, plan, reference);
}

async function generate(sessionId, card, plan, reference) {
  try {
    const { baseUrl, headers } = config();
    if (reference.storyboardUrls.length < plan.shots.length) throw new Error(`已确认分镜图不足：需要 ${plan.shots.length} 张，当前只有 ${reference.storyboardUrls.length} 张`);
    const storyboardReferences = [];
    for (const source of reference.storyboardUrls) storyboardReferences.push(await materializeReference(baseUrl, headers, source));
    const characterReferences = [];
    for (const source of reference.characterUrls) characterReferences.push(await materializeReference(baseUrl, headers, source));
    for (const shot of plan.shots) {
      const createdAt = now();
      const existing = db.prepare("SELECT * FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=? ORDER BY version DESC LIMIT 1").get(sessionId, card.id, shot.shotId);
      if (existing?.status === "completed" && existing.result_url) continue;
      const version = existing?.status === "generating" ? Number(existing.version) : Number(db.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=?").get(sessionId, card.id, shot.shotId).version);
      const storyboardReference = storyboardReferences[shot.order - 1];
      if (!storyboardReference) throw new Error(`${shot.shotId}：缺少同序号的已确认分镜图`);
      let taskId = existing?.status === "generating" ? existing.task_id : "";
      const orderedReferences = orderImaRouterShotReferences(characterReferences, storyboardReference, shot.order);
      let activeImageReferences = [...orderedReferences.images];
      const referenceLabels = [...orderedReferences.labels];
      let removedPrivacyReference = "";
      let generateAudio = true;
      let audioDowngraded = false;
      const submitShot = async (prompt) => request(`${baseUrl}/v1/videos`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: VIDEO_MODEL, prompt, duration: shot.durationSeconds, aspect_ratio: "9:16", metadata: { resolution: "720p", audio: generateAudio }, images: activeImageReferences }),
      });
      if (!taskId) {
        db.prepare("INSERT INTO creative_video_shots (session_id,prompt_card_id,shot_id,shot_order,version,provider,duration_seconds,prompt,status,created_at,updated_at) VALUES (?,?,?,?,?,'imarouter',?,?,'generating',?,?)")
          .run(sessionId, card.id, shot.shotId, shot.order, version, shot.durationSeconds, shot.promptEn, createdAt, createdAt);
        const referenceInstruction = imaRouterReferenceInstruction(characterReferences.length);
        const created = await submitShot(`${referenceInstruction}${shot.promptEn}`);
        taskId = created?.id || created?.task_id;
        if (!taskId) throw new Error(`${shot.shotId}：ImaRouter 未返回视频任务 ID`);
        db.prepare("UPDATE creative_video_shots SET task_id=?,updated_at=? WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND version=?").run(taskId, now(), sessionId, card.id, shot.shotId, version);
      }
      let previewUrl = "";
      let privacyRetried = false;
      for (let attempt = 0; attempt < 3 && !previewUrl; attempt += 1) {
        const deadline = Date.now() + 15 * 60_000;
        let failureMessage = "";
        while (Date.now() < deadline) {
          const result = await request(`${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, { method: "GET", headers });
          const status = String(result?.status || "").toLowerCase();
          if (OK.has(status)) { previewUrl = explicitVideoUrl(result); break; }
          if (FAILED.has(status)) { failureMessage = result?.error?.message || `ImaRouter 视频生成失败（${status}）`; break; }
          await wait(5000);
        }
        if (previewUrl) break;
        if (!failureMessage) throw new Error(`${shot.shotId} 查询超时或未返回视频地址`);
        let retryInstruction = "";
        const removeIndex = !privacyRetried ? privacyReferenceIndex(failureMessage, activeImageReferences.length) : -1;
        if (removeIndex >= 0 && activeImageReferences.length > 1) {
          privacyRetried = true;
          removedPrivacyReference = referenceLabels[removeIndex] || `参考图 ${removeIndex + 1}`;
          activeImageReferences.splice(removeIndex, 1);
          referenceLabels.splice(removeIndex, 1);
          const storyboardAvailable = activeImageReferences.at(-1) === storyboardReference;
          const activeCharacterCount = storyboardAvailable ? activeImageReferences.length - 1 : activeImageReferences.length;
          retryInstruction = imaRouterReferenceInstruction(activeCharacterCount, storyboardAvailable);
          db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
            .run(sessionId, `${shot.shotId} 的 ${removedPrivacyReference} 触发真人隐私检测，Novvy 已自动移除该图并重试一次。`, now());
        } else if (!audioDowngraded && isOutputAudioCopyrightFailure(failureMessage)) {
          audioDowngraded = true;
          generateAudio = false;
          retryInstruction = `Generate a silent video with no music, dialogue, voice, or sound effects. `;
          db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
            .run(sessionId, `${shot.shotId} 的生成音频触发版权限制，Novvy 仅将这一镜降级为无音频并自动重试；其他镜头不受影响。`, now());
        } else {
          throw new Error(`${shot.shotId}：${failureMessage}`);
        }
        const retried = await submitShot(`${retryInstruction}${shot.promptEn}`);
        taskId = retried?.id || retried?.task_id;
        if (!taskId) throw new Error(`${shot.shotId}：隐私降级重试未返回视频任务 ID`);
        db.prepare("UPDATE creative_video_shots SET task_id=?,updated_at=? WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND version=?").run(taskId, now(), sessionId, card.id, shot.shotId, version);
      }
      if (!previewUrl) throw new Error(`${shot.shotId} 查询超时或未返回视频地址`);
      db.prepare("UPDATE creative_video_shots SET status='completed',result_url=?,updated_at=? WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND version=?").run(previewUrl, now(), sessionId, card.id, shot.shotId, version);
      append(sessionId, `${shot.shotId} V${version} 已生成，可以单独播放复审。`, shotCard(card, shot, { previewUrl, status: "completed", version, details: [...shotCard(card, shot).details, { label: "版本", content: `V${version}` }, { label: "视频供应商", content: `ImaRouter / ${VIDEO_MODEL_LABEL}` }, { label: "参考策略", content: removedPrivacyReference ? `已移除 ${removedPrivacyReference} 后自动重试成功` : `${characterReferences.length} 张人物身份参考在前，对应分镜图 ${shot.order} 在最后` }, { label: "音频", content: audioDowngraded ? "该镜头因版权审核自动降级为无音频" : "生成同步音频" }, { label: "视频任务", content: taskId }] }));
    }
    append(sessionId, "全部内容镜头已经生成。请逐镜播放复审；确认后再按顺序拼接，并追加已确认的原始落版图。", { ...card, previewUrl: "", status: "completed", details: [...(card.details || []).filter((item) => item.label !== "失败原因"), { label: "逐镜状态", content: `${plan.shots.length} 个镜头已完成，等待统一确认拼接` }] });
    db.prepare("UPDATE creative_sessions SET stage='video_review',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `ImaRouter 视频没有生成成功：${message}。提示词和参考素材均已保留。`, {
      ...card, previewUrl: "", status: "failed",
      details: [...(card.details || []).filter((item) => !["失败原因", "视频供应商", "参考策略"].includes(item.label)), { label: "视频供应商", content: `ImaRouter / ${VIDEO_MODEL_LABEL}` }, { label: "参考策略", content: reference.strategy }, { label: "失败原因", content: message }],
    });
    db.prepare("UPDATE creative_sessions SET stage='prompt_review',error_message=?,updated_at=? WHERE id=?").run(message, now(), sessionId);
  }
}
