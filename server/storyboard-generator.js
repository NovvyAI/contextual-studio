import { db, now, resolveAssetReferences } from "./database.js";
import { publicInputUrl } from "./character-generator.js";
import { preparePngEditSource, uploadPngEditInput, validatePngEditInputs } from "./image-mask.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
}
function latestCards(sessionId) {
  const latest = new Map();
  for (const card of cards(sessionId)) if (card?.id && !latest.has(card.id)) latest.set(card.id, card);
  return latest;
}
function activeStoryboardImageJobs(sessionId) {
  return [...latestCards(sessionId).values()].filter((card) => card.kind === "storyboard_image" && card.status === "generating");
}
function finishStoryboardImageJob(sessionId, errorMessage = null) {
  const hasOtherJobs = activeStoryboardImageJobs(sessionId).length > 0;
  db.prepare("UPDATE creative_sessions SET stage=?,error_message=?,updated_at=? WHERE id=?")
    .run(hasOtherJobs ? "working" : "storyboard_review", errorMessage, now(), sessionId);
}
function append(sessionId, content, messageCards) {
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify(messageCards), now());
}
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
function imageUrl(data) {
  const keys = new Set(["imageurl", "resulturl", "outputurl", "downloadurl"]);
  for (const node of walk(data)) if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) if (keys.has(key.toLowerCase()) && typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  return "";
}
function shotLabel(label) {
  const value = String(label || "").trim();
  return /^(?:(?:镜(?:头)?|shot)\s*(?:\d{1,2}|[一二三])|第\s*(?:\d{1,2}|[一二三])\s*(?:镜|镜头)|(?:storyboard[-_ ]*)?[A-Z]+[-_ ]*0?\d{1,2}\s*(?:[｜|]|$))/i.test(value);
}

function shotContent(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(shotContent).filter(Boolean).join("\n");
  if (value && typeof value === "object") return Object.entries(value)
    .map(([key, item]) => `${key}：${shotContent(item)}`).filter((item) => !item.endsWith("：")).join("\n");
  return value == null ? "" : String(value);
}

function structuredShots(card) {
  const candidates = [card?.shots, card?.storyboard?.shots, card?.content?.shots, card?.details?.shots];
  const source = candidates.find(Array.isArray);
  if (!source) return [];
  return source.map((shot, index) => ({
    label: shot?.label || shot?.title || shot?.shotId || `镜头 ${String(index + 1).padStart(2, "0")}`,
    content: shotContent(shot?.content || shot?.description || shot?.reviewZh || shot?.prompt || shot),
  })).filter((shot) => shot.content);
}

function embeddedShots(details) {
  const text = (details || []).map((item) => shotContent(item?.content)).filter(Boolean).join("\n");
  const marker = /(?:^|\n)\s*((?:(?:镜(?:头)?|shot)\s*(?:\d{1,2}|[一二三])|第\s*(?:\d{1,2}|[一二三])\s*(?:镜|镜头))[^\n：:]*)[：:]?\s*/gim;
  const matches = [...text.matchAll(marker)];
  return matches.map((match, index) => ({
    label: match[1].trim(),
    content: text.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
  })).filter((shot) => shot.content);
}

export function shotDetails(card) {
  const details = Array.isArray(card?.details) ? card.details : [];
  const labeled = details.filter((item) => shotLabel(item?.label))
    .map((item) => ({ ...item, content: shotContent(item.content) })).filter((item) => item.content);
  if (labeled.length) return labeled.slice(0, 3);
  const structured = structuredShots(card);
  if (structured.length) return structured.slice(0, 3);
  return embeddedShots(details).slice(0, 3);
}
function referenceUrls(session) {
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const group = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "reference_panel" && item.status === "confirmed");
  const finalCard = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "final_card" && item.status === "confirmed");
  return [...(group?.details || []), ...(finalCard?.details || [])].map((item) => item.content)
    .filter((value) => typeof value === "string" && (/^https?:\/\//.test(value) || /^\/api\/screenshots\/\d+$/.test(value)));
}

export function startStoryboardImageGeneration(sessionId, storyboardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const storyboard = cards(sessionId).find((item) => item.id === storyboardId && item.kind === "storyboard");
  if (!storyboard) throw new Error("找不到这套剧情与分镜");
  const shots = shotDetails(storyboard);
  if (!shots.length) throw new Error("这套分镜没有可生成的镜头内容");
  const refs = referenceUrls(session);
  if (!refs.length) throw new Error("已确认人物参考图组为空");
  const timestamp = now();
  const placeholders = shots.map((shot, index) => ({
    id: `${storyboard.id}-image-${index + 1}`, kind: "storyboard_image", title: `分镜 ${String(index + 1).padStart(2, "0")}｜${shot.label}`,
    summary: shot.content, previewUrl: "", status: "generating", version: 1,
    details: [{ label: "所属方案", content: storyboard.id }, { label: "镜头内容", content: shot.content }],
  }));
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `选择 ${storyboard.id} 并生成逐镜分镜图`, timestamp);
  append(sessionId, `已选择「${storyboard.title}」。现在生成 ${shots.length} 张逐镜分镜图，完成后可以逐张修改或统一确认。`, placeholders);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  generateGroup(sessionId, storyboard, placeholders, refs);
}

export function startStoryboardImageRegeneration(sessionId, cardId, feedback, editInput = null) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const activeJobs = activeStoryboardImageJobs(sessionId);
  if (session.stage === "working" && !activeJobs.length) throw new Error("当前仍有其他任务正在处理");
  const card = latestCards(sessionId).get(cardId);
  if (!card) throw new Error("找不到这张分镜图");
  if (card.kind !== "storyboard_image") throw new Error("这不是分镜图片卡片");
  if (card.status === "generating") throw new Error("这张分镜图已经在生成中");
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请填写分镜图修改意见");
  const edit = validatePngEditInputs(editInput);
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `修改分镜图 ${cardId}：${instruction}`, timestamp);
  append(sessionId, "收到，我会以当前分镜图为基础只修改这一个镜头。", [{ ...card, previewUrl: "", status: "generating" }]);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  regenerateOne(sessionId, card, instruction, referenceUrls(session), edit);
}

export function startStoryboardImageRegenerationByNumber(sessionId, shotNumber, feedback) {
  const targetNumber = Number(shotNumber);
  if (!Number.isInteger(targetNumber) || targetNumber < 1) throw new Error("分镜编号无效");
  const latestById = new Map();
  for (const card of cards(sessionId)) if (card?.id && !latestById.has(card.id)) latestById.set(card.id, card);
  const card = [...latestById.values()].find((item) => {
    if (item.kind !== "storyboard_image") return false;
    const titleNumber = String(item.title || "").match(/^分镜\s*0*(\d+)/)?.[1];
    const idNumber = String(item.id || "").match(/-image-(\d+)$/)?.[1];
    return Number(titleNumber || idNumber) === targetNumber;
  });
  if (!card) throw new Error(`找不到分镜 ${String(targetNumber).padStart(2, "0")} 的已生成图片`);
  startStoryboardImageRegeneration(sessionId, card.id, feedback);
}

export function approveStoryboardImages(sessionId, cardIds) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const latest = new Map();
  cards(sessionId).forEach((card) => { if (!latest.has(card.id)) latest.set(card.id, card); });
  const selected = [...new Set((cardIds || []).map(String))].map((id) => latest.get(id)).filter((card) => card?.kind === "storyboard_image" && card.previewUrl);
  if (!selected.length || selected.length !== new Set(cardIds || []).size) throw new Error("部分分镜图尚未生成完成");
  const storyboardId = selected[0].details?.find((item) => item.label === "所属方案")?.content;
  if (!storyboardId || selected.some((card) => card.details?.find((item) => item.label === "所属方案")?.content !== storyboardId)) throw new Error("请选择同一套方案的分镜图");
  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  workspace.confirmedCards ||= [];
  workspace.confirmedCards.push({
    id: `confirmed-${storyboardId}-images-${Date.now()}`, kind: "storyboard", title: `已确认分镜图｜${storyboardId}`,
    summary: `已确认 ${selected.length} 张逐镜草案图，供视频生成和 ImaRouter 单图生视频使用。`,
    details: selected.flatMap((card) => [
      { label: card.title, content: card.previewUrl },
      { label: `${card.title}｜文字描述`, content: card.details?.find((item) => item.label === "镜头内容")?.content || card.summary || "" },
    ]), status: "confirmed", confirmedAt: timestamp,
  });
  workspace.productionPlan = { ...(workspace.productionPlan || {}), videoPromptStatus: "storyboard_images_approved" };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `统一确认 ${storyboardId} 的逐镜分镜图`, timestamp);
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)").run(sessionId, "分镜图组已经确认。我现在基于已确认文字分镜和逐镜图片自动生成正式视频提示词。", timestamp);
  db.prepare("UPDATE creative_sessions SET stage='working',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, `已确认 ${storyboardId} 及其逐镜分镜图片。现在生成正式 video_prompt 审核卡；保留全部历史内容，不提交视频生成。`, false));
}

export function retryFailedStoryboardImages(sessionId, cardIds) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const latest = new Map();
  cards(sessionId).forEach((card) => { if (!latest.has(card.id)) latest.set(card.id, card); });
  const failedCards = [...new Set((cardIds || []).map(String))].map((id) => latest.get(id))
    .filter((card) => card?.kind === "storyboard_image" && !card.previewUrl);
  if (!failedCards.length) throw new Error("当前没有需要重试的分镜图");
  const storyboardId = failedCards[0].details?.find((item) => item.label === "所属方案")?.content;
  const storyboard = latest.get(storyboardId);
  if (!storyboard || storyboard.kind !== "storyboard") throw new Error("找不到失败分镜所属的文字分镜方案");
  if (failedCards.some((card) => card.details?.find((item) => item.label === "所属方案")?.content !== storyboardId)) throw new Error("失败分镜不属于同一套方案");
  const refs = referenceUrls(session);
  if (!refs.length) throw new Error("已确认人物参考图组为空");
  const timestamp = now();
  const placeholders = failedCards.map((card) => ({ ...card, previewUrl: "", status: "generating", details: (card.details || []).filter((item) => item.label !== "失败原因") }));
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `重试 ${storyboardId} 中失败的 ${failedCards.length} 张分镜图`, timestamp);
  append(sessionId, `正在只重试 ${failedCards.length} 张失败分镜图；已经生成成功的图片保持不变。`, placeholders);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  generateGroup(sessionId, storyboard, placeholders, refs);
}

async function generateImage(prompt, imageUrls, maskUrl = "") {
  const client = new NovvyMcpClient(); await client.initialize();
  const created = unpackToolResult(await client.callTool("novvy_create_image_generation", { model: "gpt-image-2", prompt, imageUrls, ...(maskUrl ? { maskUrl } : {}), inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false }));
  const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
  if (!taskId && !providerSessionId) throw new Error("Novvy 未返回分镜图任务 ID");
  let result = created; const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline && !imageUrl(result)) {
    const status = valueFor(result, ["status", "state"]).toLowerCase();
    if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "分镜图生成失败");
    await wait(5000);
    result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
  }
  const previewUrl = imageUrl(result); if (!previewUrl) throw new Error("分镜图生成查询超时");
  return { previewUrl, taskId: taskId || providerSessionId };
}

async function generateGroup(sessionId, storyboard, placeholders, referenceSources) {
  try {
    const refs = [];
    for (const source of referenceSources) refs.push(await publicInputUrl(source));
    const results = await Promise.allSettled(placeholders.map(async (card, index) => {
      const shotContract = (card.details || []).map((item) => `${item.label}: ${Array.isArray(item.content) ? item.content.join("; ") : item.content}`).join("\n");
      const prompt = `Create storyboard frame ${index + 1} of ${placeholders.length} for a vertical 9:16 live-action mobile game advertisement. Storyboard concept: ${storyboard.title}. Overall story: ${storyboard.summary}. This shot: ${card.summary}. Approved shot contract:\n${shotContract}\nTreat the shot contract as binding for narrative function, start/peak/result/reaction state, character blocking and performance, shot size, composition, camera height and angle, lens perspective, depth and focus, motivated camera movement endpoint, lighting and color continuity, gameplay action, object positions, and transition. Enforce this causal order across the sequence: character or user input, physical-world action, physical-world result, UI feedback, character reaction, then a larger unresolved hook. This frame must show the most informative physical action peak, physical result, or reaction state assigned to this shot; UI success, narration, or celebration cannot replace the visible world result. Preserve the exact identities, faces, ages, hairstyles, costumes, and accessories from the supplied character references. Keep hands, contact points, prop count and state, eyelines, screen direction, spatial topology, and lighting direction continuous. Compose one production-ready key frame, not a collage, contact sheet, split screen, captioned storyboard, or UI mockup. No labels, subtitles, watermarks, borders, shot numbers, or explanatory text. Precise English text, Logo, numbers, buttons and CTA are reserved for deterministic overlays. Do not use a transition, crop, blur, flare, or UI overlay to hide identity, hand, prop, or spatial continuity problems.`;
      const generated = await generateImage(prompt, refs);
      return { ...card, previewUrl: generated.previewUrl, status: "candidate", details: [...card.details, { label: "生成任务", content: generated.taskId }] };
    }));
    const completed = results.map((result, index) => result.status === "fulfilled" ? result.value : {
      ...placeholders[index], status: "failed", details: [...placeholders[index].details, { label: "失败原因", content: result.reason instanceof Error ? result.reason.message : String(result.reason) }],
    });
    const failedCount = results.filter((result) => result.status === "rejected").length;
    append(sessionId, failedCount
      ? `${placeholders.length - failedCount} 张分镜图已生成，${failedCount} 张生成失败。成功图片已保留，可单独重试失败镜头。`
      : "逐镜分镜图已经生成。你可以在任意卡片里修改单镜，确认全部画面后再统一采用。", completed);
    const errorMessage = failedCount ? `${failedCount} 张分镜图生成失败` : null;
    db.prepare("UPDATE creative_sessions SET stage='storyboard_review',error_message=?,updated_at=? WHERE id=?").run(errorMessage, now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `分镜图生成没有全部完成：${message}。文字分镜和已经生成的结果均保留。`, placeholders.map((card) => ({ ...card, status: "failed" })));
    db.prepare("UPDATE creative_sessions SET stage='storyboard_review',error_message=?,updated_at=? WHERE id=?").run(message, now(), sessionId);
  }
}

async function regenerateOne(sessionId, card, feedback, fallbackReferences, edit = { mask: null, source: null }) {
  try {
    const maskUrl = await uploadPngEditInput(edit.mask, publicInputUrl, "mask");
    const sourceUrl = card.previewUrl ? await preparePngEditSource(card.previewUrl, edit.mask, publicInputUrl) : "";
    const sources = card.previewUrl ? [sourceUrl] : fallbackReferences;
    const referencedAssets = resolveAssetReferences(sessionId, feedback);
    sources.push(...referencedAssets.map((asset) => asset.url));
    const uploaded = [];
    for (const source of [...new Set(sources)]) uploaded.push(await publicInputUrl(source));
    const assetGuide = referencedAssets.length ? ` Numbered assets explicitly referenced by the user are supplied after the current storyboard image: ${referencedAssets.map((asset) => `${asset.reference} (${asset.title})`).join(", ")}. Apply only the person, pose, scene, composition, object, or style role assigned by the user to each asset.` : "";
    const maskGuide = maskUrl ? " A PNG alpha mask is supplied for the first image. Modify only its transparent region and preserve the unmasked composition, characters, lighting, continuity, and rendering style." : "";
    const prompt = card.previewUrl
      ? `Edit the first supplied storyboard key frame according to the user's instruction: ${feedback}.${maskGuide}${assetGuide} Preserve every element not mentioned by the user. Do not blend identities unless explicitly requested. Return one clean vertical 9:16 cinematic frame. No collage, captions, labels, shot numbers, borders, subtitles, logos, or watermark.`
      : `Create one vertical 9:16 cinematic storyboard key frame for this shot: ${card.summary}. User instruction: ${feedback}.${assetGuide} Preserve the supplied character identities, costumes and accessories. No collage, captions, labels, shot numbers, borders, subtitles, logos, or watermark.`;
    const generated = await generateImage(prompt, uploaded, maskUrl);
    append(sessionId, `${card.title} 已按意见生成新版，图片已在原卡片中更新。`, [{ ...card, previewUrl: generated.previewUrl, status: "candidate", version: Number(card.version || 1) + 1, details: [...card.details, { label: "本版修改", content: feedback }, ...(edit.mask ? [{ label: "局部编辑蒙版", content: `${edit.mask.width}×${edit.mask.height} PNG alpha` }] : []), ...(referencedAssets.length ? [{ label: "引用资产", content: referencedAssets.map((asset) => asset.reference).join("、") }] : []), { label: "生成任务", content: generated.taskId }] }]);
    finishStoryboardImageJob(sessionId, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `这张分镜图修改失败：${message}。上一版图片仍然保留。`, [{ ...card, status: "failed" }]);
    finishStoryboardImageJob(sessionId, message);
  }
}
