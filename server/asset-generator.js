import { cardHistory, creativeAssets, creativeCharacterReferenceAssets, db, insertCardVersion, latestCard, latestCardsByKind, now, resolveAssetReferences, transitionCreativeStage } from "./database.js";
import { publicInputUrl } from "./character-generator.js";
import { preparePngEditSource, uploadPngEditInput, validatePngEditInputs } from "./image-mask.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";
import { recordCreativeAsset, recordCreativeFeedback } from "./creative-telemetry.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function append(sessionId, content, card) {
  const result = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify([card]), now());
  return insertCardVersion(sessionId, Number(result.lastInsertRowid), card);
}
function appendAsset(sessionId, content, card) {
  const result = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,visibility,created_at) VALUES (?,'assistant',?,?,'asset',?)")
    .run(sessionId, content, JSON.stringify([card]), now());
  return insertCardVersion(sessionId, Number(result.lastInsertRowid), card);
}

export function registerChatAttachmentsAsAssets(sessionId, attachments, description = "上传为资产") {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const images = (attachments || []).filter((item) => String(item.type || "").startsWith("image/") && item.storedPath && item.url);
  if (!images.length) throw new Error("“上传为资产”目前只支持图片，请至少上传一张图片");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,attachments_json,created_at) VALUES (?,'user',?,?,?)")
    .run(sessionId, String(description || "上传为资产"), JSON.stringify(attachments), timestamp);
  const cards = images.map((item, index) => ({
    id: `uploaded-asset-${item.storedName.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
    kind: "reference_image",
    title: item.name || `上传图片 ${index + 1}`,
    summary: "用户从聊天框上传的原始图片资产；未经过重绘、裁切或模型生成。",
    previewUrl: item.url,
    version: 1,
    status: "candidate",
    details: [
      { label: "资产来源", content: "聊天框本地上传" },
      { label: "原始文件名", content: item.name || "未知" },
      { label: "文件类型", content: item.type || "image" },
      { label: "文件大小", content: `${item.size || 0} bytes` },
      { label: "存储方式", content: "本地附件；后续提交给云端生成时才按需上传" },
    ],
  }));
  const uploadResult = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,visibility,created_at) VALUES (?,'assistant',?,?,'asset',?)")
    .run(sessionId, `已将 ${cards.length} 张原图登记到资产区域。`, JSON.stringify(cards), timestamp);
  const uploadMessageId = Number(uploadResult.lastInsertRowid);
  for (const card of cards) insertCardVersion(sessionId, uploadMessageId, card);
  const registered = creativeAssets(sessionId).filter((asset) => cards.some((card) => card.previewUrl === asset.url));
  const references = registered.map((asset) => asset.reference);
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
    .run(sessionId, `${references.join("、") || `${cards.length} 张图片`}已加入资产区域。原图没有经过修改，也没有调用图片生成模型。`, timestamp);
  transitionCreativeStage(sessionId, session.stage, { timestamp });
  recordCreativeFeedback(sessionId, String(description || "上传为资产"), { decision: "approved", stageOutputId: cards.map((card) => card.id).join(","), key: `session:${sessionId}:uploaded-assets:${timestamp}` });
  registered.forEach((asset) => recordCreativeAsset(sessionId, "reference_panel", asset.url, { stageOutputId: asset.sourceCardId, metadata: { title: asset.title, source: "chat_upload", reference: asset.reference }, key: `session:${sessionId}:uploaded-asset:${asset.sourceCardId}` }));
  return registered;
}

export function registerReferencedScreenshotsAsAssets(sessionId, description) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const screenshots = resolveAssetReferences(sessionId, description).filter((item) => item.kind === "video_screenshot");
  if (!screenshots.length) throw new Error("请指定要上传的截图编号，例如“截图 14 上传为资产”");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)")
    .run(sessionId, String(description || "上传截图为资产"), timestamp);
  const existingUrls = new Set(creativeAssets(sessionId).map((asset) => asset.url));
  const cards = screenshots.filter((item) => !existingUrls.has(item.url)).map((item) => ({
    id: `screenshot-asset-${item.screenshotId}`,
    kind: "reference_image",
    title: item.title || item.reference,
    summary: `${item.reference}，${item.description || "来自短剧原视频的关键帧"}`,
    previewUrl: item.url,
    version: 1,
    status: "candidate",
    details: [
      { label: "资产来源", content: "短剧原视频截图" },
      { label: "截图编号", content: item.reference },
      { label: "时间点", content: `${Number(item.timestampSeconds || 0).toFixed(2)} 秒` },
      { label: "处理方式", content: "直接登记原始截图；未调用 Codex 或图片生成模型" },
    ],
  }));
  if (cards.length) {
    const screenshotResult = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,visibility,created_at) VALUES (?,'assistant',?,?,'asset',?)")
      .run(sessionId, `已将 ${cards.length} 张短剧截图登记到资产区域。`, JSON.stringify(cards), timestamp);
    const screenshotMessageId = Number(screenshotResult.lastInsertRowid);
    for (const card of cards) insertCardVersion(sessionId, screenshotMessageId, card);
  }
  const registered = creativeAssets(sessionId).filter((asset) => screenshots.some((item) => item.url === asset.url));
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
    .run(sessionId, cards.length
      ? `${registered.map((asset) => asset.reference).join("、")}已加入资产区域。原始截图没有修改，也没有调用 Novvy 对话或图片模型。`
      : "指定截图已经在资产区域，无需重复上传。", timestamp);
  let returnStage = session.stage;
  if (returnStage === "error") {
    let workspace = {};
    try { workspace = JSON.parse(session.workspace_json || "{}"); } catch { /* keep safe fallback */ }
    returnStage = workspace.productionPlan?.referenceStatus === "candidate_review" ? "reference_review" : "concept_review";
  }
  transitionCreativeStage(sessionId, returnStage, { timestamp });
  registered.forEach((asset) => recordCreativeAsset(sessionId, "reference_panel", asset.url, { stageOutputId: asset.sourceCardId, metadata: { title: asset.title, source: "video_screenshot", reference: asset.reference }, key: `session:${sessionId}:screenshot-asset:${asset.sourceCardId}` }));
  return registered;
}

export function registerReferencedScreenshotsAsCharacterReferences(sessionId, description) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const screenshots = resolveAssetReferences(sessionId, description).filter((item) => item.kind === "video_screenshot");
  if (!screenshots.length) throw new Error("请指定人物截图编号，例如“截图 18 上传为人物参考图”");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)")
    .run(sessionId, String(description || "上传截图为人物参考图"), timestamp);
  const existingCharacterCards = latestCardsByKind(sessionId, "character_image");
  const existingIds = new Set(existingCharacterCards.map((card) => card.id));
  let candidateNumber = existingIds.size + 1;
  const requestedLabel = String(description || "").match(/[（(]([^）)]+)[）)]/)?.[1]?.trim() || "";
  const cardsToAdd = screenshots.filter((item) => !existingIds.has(`reference-screenshot-${item.screenshotId}`)).map((item) => {
    const viewLabel = requestedLabel || item.title || "人物参考";
    const characterName = viewLabel.replace(/(?:正面|正脸|侧面|侧脸|左侧|右侧|左侧\s*3\/4|右侧\s*3\/4|3\/4).*$/i, "").trim() || "自定义人物";
    return {
      id: `reference-screenshot-${item.screenshotId}`,
      kind: "character_image",
      title: `${viewLabel}｜${item.reference}`,
      summary: `${item.reference}已直接加入人物参考候选；这是短剧原始截图，未经过重绘。`,
      previewUrl: item.url,
      version: 1,
      candidateNumber: candidateNumber++,
      status: "candidate",
      details: [
        { label: "人物编号", content: `character-user-${characterName}` },
        { label: "剧情身份", content: characterName },
        { label: "人物参考来源", content: item.reference },
        { label: "时间点", content: `${Number(item.timestampSeconds || 0).toFixed(2)} 秒` },
        { label: "处理方式", content: "直接登记短剧原始截图；未调用 Codex 或图片生成模型" },
      ],
    };
  });
  if (cardsToAdd.length) {
    const addResult = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
      .run(sessionId, `已将 ${cardsToAdd.length} 张截图加入人物参考候选，可以在人物确认区域直接勾选。`, JSON.stringify(cardsToAdd), timestamp);
    const addMessageId = Number(addResult.lastInsertRowid);
    for (const card of cardsToAdd) insertCardVersion(sessionId, addMessageId, card);
  } else {
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
      .run(sessionId, "指定截图已经是人物参考候选，无需重复添加。", timestamp);
  }
  transitionCreativeStage(sessionId, "reference_review", { timestamp });
  cardsToAdd.forEach((card) => recordCreativeAsset(sessionId, "reference_panel", card.previewUrl, { stageOutputId: card.id, metadata: { title: card.title, source: "video_screenshot_character_reference" }, key: `session:${sessionId}:character-screenshot:${card.id}` }));
  return cardsToAdd;
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
function promptFor(asset, feedback, references, masked = false) {
  const extra = references.length ? ` Additional numbered references follow the primary image in this order: ${references.map((item) => `${item.reference} (${item.title})`).join(", ")}. Apply only the role explicitly assigned to each reference by the user.` : "";
  const maskGuide = masked ? " A PNG alpha mask is supplied for the first image. Modify only its transparent region and preserve the unmasked composition, rendering style, lighting, and details." : "";
  const common = `User feedback: ${feedback}.${maskGuide}${extra} Return one polished image only. No collage, split screen, comparison layout, labels, shot numbers, explanatory captions, watermark, or unintended text.`;
  if (asset.kind === "character_image" || asset.kind === "character_reference") return `Edit the first image, which is the exact selected character asset version. ${common} Preserve the primary person's identity, face, age, hairstyle, costume and accessories unless the user explicitly requests a change or assigns an attribute from another numbered reference. Do not casually blend identities.`;
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
  transitionCreativeStage(sessionId, "working", { timestamp });
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
  transitionCreativeStage(sessionId, "working", { timestamp });
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
    transitionCreativeStage(sessionId, returnStage === "working" ? "reference_review" : returnStage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `上传图片修改失败：${message}。原始上传图片仍然保留。`, { ...card, status: "failed" });
    transitionCreativeStage(sessionId, returnStage === "working" ? "reference_review" : returnStage, { errorMessage: message });
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
    transitionCreativeStage(sessionId, returnStage === "working" ? "reference_review" : returnStage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAsset(sessionId, `新图片生成失败：${message}`, { ...card, status: "failed" });
    transitionCreativeStage(sessionId, returnStage === "working" ? "reference_review" : returnStage, { errorMessage: message });
  }
}

export function startAssetRegeneration(sessionId, assetNumber, feedback, editInput = null) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const asset = creativeAssets(sessionId).find((item) => item.number === Number(assetNumber));
  if (!asset) throw new Error(`找不到图片 ${String(assetNumber).padStart(2, "0")}`);
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请填写对这张图片的修改意见");
  const edit = validatePngEditInputs(editInput);
  const sourceCard = cardHistory(sessionId, asset.sourceCardId).find((card) => card.previewUrl === asset.url)
    || latestCard(sessionId, asset.sourceCardId);
  if (!sourceCard) throw new Error("找不到这张资产对应的生成卡片");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)")
    .run(sessionId, `修改${asset.reference}（${asset.title}）：${instruction}`, timestamp);
  append(sessionId, `收到，我会以${asset.reference}这个具体版本为主图重新生成；完成后旧图继续保留，新图进入资产区域。`, { ...sourceCard, previewUrl: "", status: "generating" });
  transitionCreativeStage(sessionId, "working", { timestamp });
  regenerate(sessionId, asset, sourceCard, instruction, edit);
}

export function startCharacterReferenceRegeneration(sessionId, characterReferenceNumber, feedback, editInput = null) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const asset = creativeCharacterReferenceAssets(sessionId).find((item) => item.number === Number(characterReferenceNumber));
  if (!asset) throw new Error(`找不到人物图 ${String(characterReferenceNumber).padStart(2, "0")}`);
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请填写对这张人物参考图的修改意见");
  const edit = validatePngEditInputs(editInput);
  const timestamp = now();
  const targetCardId = `reference-${asset.characterId}-${asset.candidateId}`;
  const rawMatch = latestCard(sessionId, targetCardId);
  const matchingCard = rawMatch?.kind === "character_image" ? rawMatch : null;
  const sourceCard = matchingCard
    ? { ...matchingCard, previewUrl: "", status: "generating" }
    : {
      id: targetCardId,
      kind: "character_image",
      title: `${asset.title}｜修改候选`,
      summary: instruction,
      previewUrl: "",
      version: 1,
      status: "generating",
      details: [
        { label: "人物编号", content: asset.characterId },
        { label: "画面角度", content: asset.view },
        { label: "候选编号", content: asset.candidateId },
      ],
    };
  sourceCard.details = [
    ...(sourceCard.details || []),
    { label: "原始人物参考", content: asset.reference },
    { label: "本版修改", content: instruction },
    { label: "生成方式", content: "以原视频人物截图为第一张高保真参考图" },
  ];
  db.prepare("INSERT INTO creative_messages (session_id,role,content,visibility,created_at) VALUES (?,'user',?,'asset',?)")
    .run(sessionId, `修改${asset.reference}（${asset.title}）：${instruction}`, timestamp);
  append(sessionId, `正在以${asset.reference}为主图重新生成，并同步更新右侧对应的人物候选卡。原始人物参考图会继续保留。`, sourceCard);
  transitionCreativeStage(sessionId, "working", { timestamp });
  regenerate(sessionId, asset, sourceCard, instruction, { ...edit, returnStage: session.stage });
}

async function regenerate(sessionId, asset, sourceCard, feedback, options = {}) {
  const appendResult = options.assetOnly ? appendAsset : append;
  try {
    const referenced = resolveAssetReferences(sessionId, feedback).filter((item) => item.url !== asset.url);
    const sourceUrl = await preparePngEditSource(asset.url, options.mask, publicInputUrl);
    const maskUrl = await uploadPngEditInput(options.mask, publicInputUrl, "mask");
    const inputs = [sourceUrl];
    for (const item of referenced) inputs.push(await publicInputUrl(item.url));
    const client = new NovvyMcpClient(); await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt: promptFor(asset, feedback, referenced, Boolean(maskUrl)), imageUrls: [...new Set(inputs)], ...(maskUrl ? { maskUrl } : {}), inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false,
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
    const completed = { ...sourceCard, previewUrl, version, status: "candidate", summary: `${sourceCard.summary || asset.description}（基于${asset.reference}修改）`, details: [...(sourceCard.details || []), { label: `V${version} 修改`, content: feedback }, { label: "主参考资产", content: asset.reference }, ...(options.mask ? [{ label: "局部编辑蒙版", content: `${options.mask.width}×${options.mask.height} PNG alpha` }] : []), ...(referenced.length ? [{ label: "额外引用", content: referenced.map((item) => item.reference).join("、") }] : []), { label: "生成任务", content: taskId || providerSessionId }] };
    appendResult(sessionId, `${asset.reference}的修改版已经生成。原图保留，新版本已加入生成图片区域。`, completed);
    const stage = options.returnStage || (asset.kind === "final_card" ? "final_card_review" : asset.kind === "storyboard_image" ? "storyboard_review" : "reference_review");
    transitionCreativeStage(sessionId, stage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendResult(sessionId, `${asset.reference}重新生成失败：${message}。原资产仍然保留。`, { ...sourceCard, previewUrl: asset.url, status: "failed" });
    const stage = options.returnStage || (asset.kind === "final_card" ? "final_card_review" : asset.kind === "storyboard_image" ? "storyboard_review" : "reference_review");
    transitionCreativeStage(sessionId, stage, { errorMessage: message });
  }
}
