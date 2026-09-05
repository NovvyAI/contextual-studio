import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, now, insertCardVersion, latestCard, latestConfirmedCard, transitionCreativeStage } from "./database.js";
import { parseStoryboardVideoPlan, shotCard } from "./storyboard-video-plan.js";
import { traceToolCall } from "./mlflow-tracing.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const DEFAULT_VIDEO_MODEL = "seedance-2.0-fast";
const VIDEO_MODELS = Object.freeze({
  "seedance-2.0-fast": { label: "Seedance 2.0 Fast", family: "seedance" },
  "kling-v3-omni-video": { label: "Kling v3 Omni", family: "kling" },
  "MiniMax-H3": { label: "MiniMax-H3", family: "minimax-h3" },
  "viduq3-turbo": { label: "Vidu Q3 Turbo", family: "vidu" },
});
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
  const result = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify([card]), now());
  return insertCardVersion(sessionId, Number(result.lastInsertRowid), card);
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

function resolveVideoModel(value) {
  const key = Object.hasOwn(VIDEO_MODELS, value) ? value : DEFAULT_VIDEO_MODEL;
  return { key, ...VIDEO_MODELS[key] };
}

function nearestDuration(value, allowed) {
  const duration = Math.max(1, Math.round(Number(value) || allowed[0]));
  return allowed.reduce((best, item) => Math.abs(item - duration) < Math.abs(best - duration) ? item : best);
}

export function buildImaRouterVideoRequest(modelKey, shot, references, generateAudio = true) {
  const model = resolveVideoModel(modelKey);
  const prompt = String(shot.prompt || "");
  if (model.family === "minimax-h3") {
    if (!references.ordered.length) throw new Error("MiniMax-H3 至少需要一张参考图");
    if (references.ordered.length > 9) throw new Error(`MiniMax-H3 最多支持 9 张参考图，当前为 ${references.ordered.length} 张`);
    return {
      model: model.key,
      prompt,
      duration: Math.min(15, Math.max(4, Math.round(Number(shot.durationSeconds) || 5))),
      resolution: "768P",
      ratio: "9:16",
      images: references.ordered,
      role_mode: "reference",
    };
  }
  if (model.family === "kling") {
    const images = references.ordered;
    return {
      model: model.key, prompt, duration: Math.min(15, Math.max(3, Math.round(shot.durationSeconds))),
      aspect_ratio: "9:16", mode: "std", sound: generateAudio ? "on" : "off",
      ...(images.length === 1 ? { image: images[0] } : { image_list: images }),
    };
  }
  if (model.family === "vidu") {
    return {
      model: model.key, prompt, duration: Math.min(16, Math.max(1, Math.round(shot.durationSeconds))),
      size: "9:16", images: references.ordered, metadata: { resolution: "720p" },
    };
  }
  return {
    model: model.key, prompt, duration: nearestDuration(shot.durationSeconds, [4, 5, 6, 8, 10, 12, 15]),
    aspect_ratio: "9:16", metadata: { resolution: "720p", audio: generateAudio }, images: references.ordered,
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

function selectReferences(sessionId, requireCharacters = true) {
  const confirmedStoryboard = latestConfirmedCard(sessionId, "storyboard");
  const referenceGroup = latestConfirmedCard(sessionId, "reference_panel");
  const storyboardUrls = (confirmedStoryboard?.details || []).map((item) => referenceUrl(item.content)).filter(Boolean);
  const characterUrls = (referenceGroup?.characterPanelUrls?.length
    ? referenceGroup.characterPanelUrls
    : [referenceGroup?.previewUrl, ...(referenceGroup?.details || []).map((item) => item.content)])
    .map(referenceUrl).filter(Boolean);
  if (!storyboardUrls.length) throw new Error("ImaRouter 没有可用的已确认分镜图");
  if (requireCharacters && !characterUrls.length) throw new Error("ImaRouter 没有可用的已确认人物参考图");
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
  if (/^https?:\/\//i.test(source) && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(source)) {
    return stabilizeRemoteReferenceUrl(source);
  }
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

function sniffImageMimeType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

// The object path is derived only from the source's origin+pathname (no query string),
// so a signed URL whose token rotates on every fetch still resolves to the same cached
// object, and the cache-hit check always agrees with the actual upload target.
export function stableReferenceObjectPath(source) {
  const normalizedSource = (() => {
    try {
      const url = new URL(source);
      return `${url.origin}${url.pathname}`;
    } catch {
      return source;
    }
  })();
  const sourceExtension = path.extname(normalizedSource).toLowerCase();
  const extension = [".png", ".jpg", ".jpeg", ".webp"].includes(sourceExtension) ? sourceExtension.replace(".jpeg", ".jpg") : ".jpg";
  const digest = createHash("sha256").update(normalizedSource).digest("hex");
  return `contextual-studio/imarouter-references/${digest}${extension}`;
}

async function stabilizeRemoteReferenceUrl(source) {
  const bucket = String(process.env.IMAROUTER_GCS_BUCKET || "novvy-seedance-public").trim();
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(bucket)) throw new Error("IMAROUTER_GCS_BUCKET 配置无效");
  const ownPrefix = `https://storage.googleapis.com/${bucket}/`;
  if (source.startsWith(ownPrefix)) return source;

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-imarouter-reference-"));
  try {
    const objectPath = stableReferenceObjectPath(source);
    const stableUrl = `${ownPrefix}${objectPath}`;
    const cached = await fetch(stableUrl, { method: "HEAD", signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (cached?.ok) return stableUrl;
    const response = await fetch(source, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`源素材返回 HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("源素材为空");
    // Some object stores serve valid images with a generic Content-Type such as
    // application/octet-stream, so validate the actual bytes instead of trusting the
    // header — trusting the header used to hard-reject genuine images.
    const sniffedType = sniffImageMimeType(bytes);
    if (!sniffedType) throw new Error(`源素材不是可识别的图片格式（Content-Type: ${response.headers.get("content-type") || "未知"}）`);
    const localExtension = sniffedType === "image/png" ? "png" : sniffedType === "image/webp" ? "webp" : sniffedType === "image/gif" ? "gif" : "jpg";
    const localPath = path.join(tempDir, `reference.${localExtension}`);
    await fsp.writeFile(localPath, bytes);
    try {
      await execFileAsync("gcloud", ["storage", "cp", localPath, `gs://${bucket}/${objectPath}`], { maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`稳定参考图上传 GCS 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const validation = await fetch(stableUrl, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
    if (!validation.ok) throw new Error(`稳定参考图上传后不可公开读取（HTTP ${validation.status}）`);
    return stableUrl;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`ImaRouter 参考图稳定化失败：${detail}；未提交视频任务`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export function startImaRouterVideoGeneration(sessionId, cardId, requestedModel = DEFAULT_VIDEO_MODEL, targetShotId = "", promptOverride = "") {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  config();
  const card = latestCard(sessionId, cardId);
  if (!card || card.kind !== "video_prompt") throw new Error("找不到视频提示词卡");
  const fullPlan = parseStoryboardVideoPlan(card);
  const plan = targetShotId ? { ...fullPlan, shots: fullPlan.shots.filter((shot) => shot.shotId === targetShotId).map((shot) => promptOverride ? { ...shot, promptEn: promptOverride } : shot) } : fullPlan;
  if (!plan.shots.length) throw new Error(`找不到要重新生成的视频镜头：${targetShotId}`);
  const model = resolveVideoModel(requestedModel);
  const reference = selectReferences(sessionId);
  const timestamp = now();
  // An explicit retry from a failed review state must not keep polling the old,
  // terminal provider task. Startup recovery uses resumeImaRouterVideoGeneration
  // instead and therefore still resumes genuinely active tasks after a restart.
  // The session mutex above (stage==='working' throws) guarantees no generate()
  // call is currently active, so ANY row still 'generating' here is a leftover
  // from a previous crashed run — regardless of which model it used. Scoping this
  // cleanup to only the newly requested model left stale rows under other models
  // forever 'generating', which server-restart recovery could then pick up and
  // resume with a stale, unrequested model.
  if (session.stage !== "working" && session.error_message) {
    db.prepare("UPDATE creative_video_shots SET status='failed',error_message=COALESCE(error_message,?),updated_at=? WHERE session_id=? AND prompt_card_id=? AND provider='imarouter' AND status='generating'")
      .run(session.error_message, timestamp, sessionId, card.id);
  }
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, targetShotId ? `使用 ImaRouter 重新生成 ${targetShotId}` : `使用 ImaRouter 生成视频：${cardId}`, timestamp);
  const modelStrategy = "人物六视图在前，对应分镜图在最后";
  append(sessionId, `已选择 ImaRouter / ${model.label}。正在准备逐镜参考素材并生成视频。参考策略：${modelStrategy}。`, {
    ...card, previewUrl: "", status: "generating",
    details: [...(card.details || []).filter((item) => !["视频供应商", "参考策略"].includes(item.label)), { label: "视频供应商", content: `ImaRouter / ${model.label}` }, { label: "参考策略", content: modelStrategy }],
  });
  transitionCreativeStage(sessionId, "working", { timestamp });
  generate(sessionId, card, plan, reference, model.key, Boolean(targetShotId));
}

export function resumeImaRouterVideoGeneration(sessionId, cardId, requestedModel = DEFAULT_VIDEO_MODEL) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = latestCard(sessionId, cardId);
  if (!card || card.kind !== "video_prompt") throw new Error("找不到待恢复的视频提示词卡");
  const plan = parseStoryboardVideoPlan(card);
  const model = resolveVideoModel(requestedModel);
  const reference = selectReferences(sessionId);
  transitionCreativeStage(sessionId, "working");
  generate(sessionId, card, plan, reference, model.key);
}

async function generate(sessionId, card, plan, reference, modelKey, forceNewVersion = false) {
  let activeShotId = "";
  try {
    const { baseUrl, headers } = config();
    const model = resolveVideoModel(modelKey);
    if (reference.storyboardUrls.length < plan.shots.length) throw new Error(`已确认分镜图不足：需要 ${plan.shots.length} 张，当前只有 ${reference.storyboardUrls.length} 张`);
    const storyboardPublicUrls = [];
    for (const source of reference.storyboardUrls) storyboardPublicUrls.push(await ensurePublicReferenceUrl(source));
    const characterPublicUrls = [];
    for (const source of reference.characterUrls) characterPublicUrls.push(await ensurePublicReferenceUrl(source));
    const useReviewedAssets = model.family === "seedance";
    const storyboardReferences = useReviewedAssets ? await Promise.all(storyboardPublicUrls.map((url) => createAssetReference(baseUrl, headers, url))) : storyboardPublicUrls;
    const characterReferences = useReviewedAssets ? await Promise.all(characterPublicUrls.map((url) => createAssetReference(baseUrl, headers, url))) : characterPublicUrls;
    for (const shot of plan.shots) {
      activeShotId = shot.shotId;
      const createdAt = now();
      const existing = db.prepare("SELECT * FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND COALESCE(model_key,?)=? ORDER BY version DESC LIMIT 1")
        .get(sessionId, card.id, shot.shotId, DEFAULT_VIDEO_MODEL, model.key);
      if (!forceNewVersion && existing?.status === "completed" && existing.result_url) continue;
      const resumeExisting = !forceNewVersion && existing?.status === "generating";
      const version = resumeExisting ? Number(existing.version) : Number(db.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=?").get(sessionId, card.id, shot.shotId).version);
      const storyboardReference = storyboardReferences[shot.order - 1];
      if (!storyboardReference) throw new Error(`${shot.shotId}：缺少同序号的已确认分镜图`);
      let taskId = resumeExisting ? existing.task_id : "";
      const orderedReferences = orderImaRouterShotReferences(characterReferences, storyboardReference, shot.order);
      let activeImageReferences = [...orderedReferences.images];
      const referenceLabels = [...orderedReferences.labels];
      let removedPrivacyReference = "";
      let generateAudio = true;
      let audioDowngraded = false;
      const submitShot = async (prompt) => request(`${baseUrl}/v1/videos`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildImaRouterVideoRequest(model.key, { ...shot, prompt }, { ordered: activeImageReferences, storyboard: storyboardReference }, generateAudio)),
      });
      if (!taskId) {
        db.prepare("INSERT INTO creative_video_shots (session_id,prompt_card_id,shot_id,shot_order,version,provider,model_key,duration_seconds,prompt,status,created_at,updated_at) VALUES (?,?,?,?,?,'imarouter',?,?,?,'generating',?,?)")
          .run(sessionId, card.id, shot.shotId, shot.order, version, model.key, shot.durationSeconds, shot.promptEn, createdAt, createdAt);
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
        } else if (["seedance", "kling"].includes(model.family) && !audioDowngraded && isOutputAudioCopyrightFailure(failureMessage)) {
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
      const referenceSummary = `${characterReferences.length} 张人物身份参考在前，对应分镜图 ${shot.order} 在最后`;
      append(sessionId, `${shot.shotId} V${version} 已生成，可以单独播放复审。`, shotCard(card, shot, { previewUrl, status: "completed", version, details: [...shotCard(card, shot).details, { label: "版本", content: `V${version}` }, { label: "视频供应商", content: `ImaRouter / ${model.label}` }, { label: "参考策略", content: removedPrivacyReference ? `已移除 ${removedPrivacyReference} 后自动重试成功` : referenceSummary }, { label: "音频", content: model.family === "seedance" || model.family === "kling" ? (audioDowngraded ? "该镜头因版权审核自动降级为无音频" : "生成同步音频") : "该模型不生成音频" }, { label: "视频任务", content: taskId }] }));
    }
    if (forceNewVersion) {
      append(sessionId, `${plan.shots[0].shotId} 已重新生成新版本。其他镜头保持不变，请播放复审后再统一确认。`, { ...card, previewUrl: "", status: "completed", details: [...(card.details || []).filter((item) => item.label !== "失败原因"), { label: "单镜重生成", content: `${plan.shots[0].shotId} 已完成新版本，其他镜头未重新生成` }] });
    } else {
      append(sessionId, "全部内容镜头已经生成。请逐镜播放复审；确认后再按顺序拼接，并追加已确认的原始落版图。", { ...card, previewUrl: "", status: "completed", details: [...(card.details || []).filter((item) => item.label !== "失败原因"), { label: "逐镜状态", content: `${plan.shots.length} 个镜头已完成，等待统一确认拼接` }] });
    }
    transitionCreativeStage(sessionId, "video_review");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (activeShotId) {
      db.prepare("UPDATE creative_video_shots SET status='failed',error_message=?,updated_at=? WHERE id=(SELECT id FROM creative_video_shots WHERE session_id=? AND prompt_card_id=? AND shot_id=? AND provider='imarouter' AND COALESCE(model_key,?)=? AND status='generating' ORDER BY version DESC LIMIT 1)")
        .run(message, now(), sessionId, card.id, activeShotId, DEFAULT_VIDEO_MODEL, resolveVideoModel(modelKey).key);
    }
    append(sessionId, `ImaRouter 视频没有生成成功：${message}。提示词和参考素材均已保留。`, {
      ...card, previewUrl: "", status: "failed",
      details: [...(card.details || []).filter((item) => !["失败原因", "视频供应商", "参考策略"].includes(item.label)), { label: "视频供应商", content: `ImaRouter / ${resolveVideoModel(modelKey).label}` }, { label: "参考策略", content: reference.strategy }, { label: "失败原因", content: message }],
    });
    transitionCreativeStage(sessionId, "prompt_review", { errorMessage: message });
  }
}
