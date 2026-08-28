import { creativeAssets, db, now, resolveAssetReferences } from "./database.js";
import { publicInputUrl } from "./character-generator.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
}
function append(sessionId, content, card) {
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify([card]), now());
}
function appendAsset(sessionId, content, card) {
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,visibility,created_at) VALUES (?,'assistant',?,?,'asset',?)")
    .run(sessionId, content, JSON.stringify([card]), now());
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
function promptFor(asset, feedback, references) {
  const extra = references.length ? ` Additional numbered references follow the primary image in this order: ${references.map((item) => `${item.reference} (${item.title})`).join(", ")}. Apply only the role explicitly assigned to each reference by the user.` : "";
  const common = `User feedback: ${feedback}.${extra} Return one polished image only. No collage, split screen, comparison layout, labels, shot numbers, explanatory captions, watermark, or unintended text.`;
  if (asset.kind === "character_image") return `Edit the first image, which is the exact selected character asset version. ${common} Preserve the primary person's identity, face, age, hairstyle, costume and accessories unless the user explicitly requests a change or assigns an attribute from another numbered reference. Do not casually blend identities.`;
  if (asset.kind === "storyboard_image") return `Edit the first image, which is the exact selected storyboard key frame. ${common} Preserve all unmentioned characters, composition, lighting, scene and continuity. Produce one vertical 9:16 cinematic key frame.`;
  if (asset.kind === "final_card") return `Edit the first image, which is the exact approved advertising final-card design. ${common} Preserve all unmentioned layout, product identity, English copy and CTA. Keep every visible English word accurate and mobile-readable.`;
  return `Edit the first image, which is the exact selected creative asset version. ${common} Preserve every element not mentioned by the user.`;
}

export function startAssetCreation(sessionId, description, interruptedCard = null) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const instruction = String(description || "").trim();
  if (!instruction) throw new Error("请填写要生成的图片描述");
  const timestamp = now();
  const card = {
    id: interruptedCard?.id || `asset-custom-${Date.now()}`, kind: "reference_image", title: "自定义生成图片",
    summary: instruction, previewUrl: "", version: Number(interruptedCard?.version || 0) + 1, status: "generating",
    details: [{ label: "生成要求", content: instruction }, { label: "创建入口", content: "资产区域空白卡片" }],
  };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,visibility,created_at) VALUES (?,'user',?,'asset',?)")
    .run(sessionId, `从资产区域生成图片：${instruction}`, timestamp);
  appendAsset(sessionId, "正在根据文字描述生成一张新图片。", card);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  createAsset(sessionId, card, instruction, session.stage);
}

export function startAttachmentImageEdit(sessionId, attachments, description, options = {}) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const images = (attachments || []).filter((item) => String(item.type || "").startsWith("image/") && item.storedPath);
  const instruction = String(description || "").trim();
  if (!images.length) throw new Error("没有找到可编辑的上传图片");
  if (!instruction) throw new Error("请说明希望怎样修改图片");
  const timestamp = now();
  const card = {
    id: `attachment-edit-${Date.now()}`, kind: "reference_image", title: "上传图片修改候选",
    summary: instruction, previewUrl: "", version: 1, status: "generating",
    details: [{ label: "修改意见", content: instruction }, { label: "主参考图", content: images[0].name || "用户上传图片" }],
  };
  if (options.recordUser !== false) {
    db.prepare("INSERT INTO creative_messages (session_id,role,content,attachments_json,created_at) VALUES (?,'user',?,?,?)")
      .run(sessionId, instruction, JSON.stringify(attachments), timestamp);
  }
  append(sessionId, "收到，我正在以你上传的图片为主图执行真实修改；完成后会在这张卡片中显示新图片。", card);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  editAttachmentImage(sessionId, images, card, instruction, session.stage);
}

async function editAttachmentImage(sessionId, images, card, instruction, returnStage) {
  try {
    const imageUrls = [];
    for (const item of images) imageUrls.push(await publicInputUrl(item.storedPath));
    const prompt = `Edit the first supplied image as the exact primary source. User request: ${instruction}. Preserve all people, animals, objects, poses, anatomy, clothing, accessories, composition, camera angle, setting, lighting, and style that the user did not explicitly ask to change. Additional supplied images, if any, are secondary references only. Return one polished edited image only. No collage, comparison, split screen, labels, captions, watermark, subtitles, or unintended text.`;
    const client = new NovvyMcpClient(); await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt, imageUrls, inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false,
    }));
    const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回图片任务 ID");
    let result = created; const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline && !imageUrl(result)) {
      const status = valueFor(result, ["status", "state"]).toLowerCase();
      if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "图片生成失败");
      await wait(5000);
      result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
    }
    const previewUrl = imageUrl(result); if (!previewUrl) throw new Error("图片生成查询超时");
    append(sessionId, "上传图片的修改版已经生成，并已加入资产区域。", { ...card, previewUrl, status: "candidate", details: [...card.details, { label: "生成任务", content: taskId || providerSessionId }] });
    db.prepare("UPDATE creative_sessions SET stage=?,error_message=NULL,updated_at=? WHERE id=?").run(returnStage === "working" ? "reference_review" : returnStage, now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `上传图片修改失败：${message}。原始上传图片仍然保留。`, { ...card, status: "failed" });
    db.prepare("UPDATE creative_sessions SET stage=?,error_message=?,updated_at=? WHERE id=?").run(returnStage === "working" ? "reference_review" : returnStage, message, now(), sessionId);
  }
}

async function createAsset(sessionId, card, instruction, returnStage) {
  try {
    const referenced = resolveAssetReferences(sessionId, instruction);
    const inputs = [];
    for (const item of referenced) inputs.push(await publicInputUrl(item.url));
    const referenceGuide = referenced.length
      ? ` Supplied numbered references, in order: ${referenced.map((item) => `${item.reference} (${item.title})`).join(", ")}. Follow the user's stated role for each reference and do not blend identities accidentally.`
      : "";
    const prompt = `Create one polished production-ready image from this user request: ${instruction}.${referenceGuide} Return one image only, not a collage, contact sheet, split screen, comparison, UI mockup, or explanatory diagram. Do not add captions, labels, watermarks, logos, subtitles, or unintended text.`;
    const client = new NovvyMcpClient(); await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt, ...(inputs.length ? { imageUrls: [...new Set(inputs)], inputFidelity: "high" } : {}), n: 1, outputFormat: "png", quality: "high", includeRaw: false,
    }));
    const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回图片任务 ID");
    let result = created; const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline && !imageUrl(result)) {
      const status = valueFor(result, ["status", "state"]).toLowerCase();
      if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "图片生成失败");
      await wait(5000);
      result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
    }
    const previewUrl = imageUrl(result); if (!previewUrl) throw new Error("图片生成查询超时");
    appendAsset(sessionId, "新图片已经生成，并已加入资产区域。", { ...card, previewUrl, status: "candidate", details: [...card.details, ...(referenced.length ? [{ label: "引用资产", content: referenced.map((item) => item.reference).join("、") }] : []), { label: "生成任务", content: taskId || providerSessionId }] });
    db.prepare("UPDATE creative_sessions SET stage=?,error_message=NULL,updated_at=? WHERE id=?").run(returnStage === "working" ? "reference_review" : returnStage, now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAsset(sessionId, `新图片生成失败：${message}`, { ...card, status: "failed" });
    db.prepare("UPDATE creative_sessions SET stage=?,error_message=?,updated_at=? WHERE id=?").run(returnStage === "working" ? "reference_review" : returnStage, message, now(), sessionId);
  }
}

export function startAssetRegeneration(sessionId, assetNumber, feedback) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const asset = creativeAssets(sessionId).find((item) => item.number === Number(assetNumber));
  if (!asset) throw new Error(`找不到图片 ${String(assetNumber).padStart(2, "0")}`);
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请填写对这张图片的修改意见");
  const sourceCard = cards(sessionId).find((card) => card.id === asset.sourceCardId && card.previewUrl === asset.url)
    || cards(sessionId).find((card) => card.id === asset.sourceCardId);
  if (!sourceCard) throw new Error("找不到这张资产对应的生成卡片");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)")
    .run(sessionId, `修改${asset.reference}（${asset.title}）：${instruction}`, timestamp);
  append(sessionId, `收到，我会以${asset.reference}这个具体版本为主图重新生成；完成后旧图继续保留，新图进入资产区域。`, { ...sourceCard, previewUrl: "", status: "generating" });
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  regenerate(sessionId, asset, sourceCard, instruction);
}

async function regenerate(sessionId, asset, sourceCard, feedback) {
  try {
    const referenced = resolveAssetReferences(sessionId, feedback).filter((item) => item.url !== asset.url);
    const inputs = [await publicInputUrl(asset.url)];
    for (const item of referenced) inputs.push(await publicInputUrl(item.url));
    const client = new NovvyMcpClient(); await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt: promptFor(asset, feedback, referenced), imageUrls: [...new Set(inputs)], inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false,
    }));
    const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回图片任务 ID");
    let result = created; const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline && !imageUrl(result)) {
      const status = valueFor(result, ["status", "state"]).toLowerCase();
      if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "图片生成失败");
      await wait(5000);
      result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
    }
    const previewUrl = imageUrl(result); if (!previewUrl) throw new Error("图片生成查询超时");
    const version = Math.max(Number(asset.version || 1), Number(sourceCard.version || 1)) + 1;
    const completed = { ...sourceCard, previewUrl, version, status: "candidate", summary: `${sourceCard.summary || asset.description}（基于${asset.reference}修改）`, details: [...(sourceCard.details || []), { label: `V${version} 修改`, content: feedback }, { label: "主参考资产", content: asset.reference }, ...(referenced.length ? [{ label: "额外引用", content: referenced.map((item) => item.reference).join("、") }] : []), { label: "生成任务", content: taskId || providerSessionId }] };
    append(sessionId, `${asset.reference}的修改版已经生成。旧图保留，新版本已加入资产区域。`, completed);
    const stage = asset.kind === "final_card" ? "final_card_review" : asset.kind === "storyboard_image" ? "storyboard_review" : "reference_review";
    db.prepare("UPDATE creative_sessions SET stage=?,error_message=NULL,updated_at=? WHERE id=?").run(stage, now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `${asset.reference}重新生成失败：${message}。原资产仍然保留。`, { ...sourceCard, previewUrl: asset.url, status: "failed" });
    const stage = asset.kind === "final_card" ? "final_card_review" : asset.kind === "storyboard_image" ? "storyboard_review" : "reference_review";
    db.prepare("UPDATE creative_sessions SET stage=?,error_message=?,updated_at=? WHERE id=?").run(stage, message, now(), sessionId);
  }
}
