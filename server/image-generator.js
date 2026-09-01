import { db, now, resolveAssetReferences } from "./database.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";
import { publicInputUrl } from "./character-generator.js";
import { recordCreativeAsset, recordCreativeFeedback, recordCreativeStage } from "./creative-telemetry.js";
import { dramaReferenceImageCandidates } from "./drama-analysis-v3.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function allCards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id = ? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => {
      try { return JSON.parse(row.cards_json || "[]"); } catch { return []; }
    });
}

function cardPrompt(card) {
  const detail = (card.details || []).find((item) => /(GPT-image-2.*(提示词|prompt)|英文.*提示词|English.*prompt)/i.test(item.label));
  return String(detail?.content || "").trim();
}

function appendCardMessage(sessionId, content, card) {
  db.prepare("INSERT INTO creative_messages (session_id, role, content, cards_json, created_at) VALUES (?, 'assistant', ?, ?, ?)")
    .run(sessionId, content, JSON.stringify([card]), now());
}

export function startFinalCardGeneration(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "final_card");
  if (!card) throw new Error("找不到这张落版图候选卡");
  const prompt = cardPrompt(card);
  if (!prompt) throw new Error("这张候选卡缺少 GPT-image-2 英文提示词");

  const timestamp = now();
  const generatingCard = { ...card, status: "generating", previewUrl: "" };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `确认并生成落版图候选 ${cardId}：${card.title}`, timestamp);
  appendCardMessage(sessionId, "好的，方案已经确认。我现在开始生成这张落版图，完成后会把真实预览放回这张卡片供你审核。", generatingCard);
  db.prepare("UPDATE creative_sessions SET stage = 'working', error_message = NULL, updated_at = ? WHERE id = ?").run(timestamp, sessionId);

  runFinalCardGeneration(sessionId, generatingCard, prompt);
}

export function startFinalCardRegeneration(sessionId, cardId, feedback) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请先填写落版图修改意见");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "final_card" && item.previewUrl);
  if (!card) throw new Error("找不到这张已生成的落版图预览");

  const timestamp = now();
  const version = Number(card.version || 1) + 1;
  const generatingCard = {
    ...card, version, status: "generating", previewUrl: "",
    details: [...(card.details || []), { label: `V${version} 修改意见`, content: instruction }],
  };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `修改落版图 ${cardId}：${instruction}`, timestamp);
  appendCardMessage(sessionId, "收到，我会以当前落版图为主图生成修改版。旧版本继续保留，流程仍停留在落版图审核。", generatingCard);
  db.prepare("UPDATE creative_sessions SET stage = 'working', error_message = NULL, updated_at = ? WHERE id = ?").run(timestamp, sessionId);
  runFinalCardRegeneration(sessionId, card, generatingCard, instruction);
}

async function runFinalCardRegeneration(sessionId, sourceCard, generatingCard, feedback) {
  try {
    const sourceUrl = await publicInputUrl(sourceCard.previewUrl);
    const referencedAssets = resolveAssetReferences(sessionId, feedback);
    const referencedUrls = [];
    for (const asset of referencedAssets) referencedUrls.push(await publicInputUrl(asset.url));
    const imageUrls = [...new Set([sourceUrl, ...referencedUrls])];
    const referenceGuide = referencedAssets.length
      ? ` Additional numbered reference images are supplied after the current final-card image in this order: ${referencedAssets.map((asset) => `${asset.reference} (${asset.title})`).join(", ")}. Apply only the visual element or role explicitly assigned to each reference by the user; do not treat a reference as a replacement for the entire final card.`
      : "";
    const prompt = `Edit the first supplied image, which is the exact current advertising final-card design. User feedback: ${feedback}.${referenceGuide} Preserve every element not explicitly changed, including product identity, composition, visual hierarchy, English copy and CTA. Keep every visible English word accurate and mobile-readable. Return one polished vertical final-card image only. Do not create a collage, comparison layout, labels, annotations, watermark, or unintended text.`;
    const client = new NovvyMcpClient();
    await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt, imageUrls, inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false,
    }));
    const taskId = findValue(created, ["taskId", "task_id", "id"]);
    const providerSessionId = findValue(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回可查询的生成任务 ID");
    let queried = created;
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = normalizedStatus(queried);
      const previewUrl = findPreviewUrl(queried);
      if (status === "completed" && previewUrl) { queried = { ...queried, previewUrl }; break; }
      if (status === "failed") throw new Error(findValue(queried, ["error", "errorMessage", "message"]) || "Novvy 图片生成失败");
      await wait(5000);
      queried = unpackToolResult(await client.callTool("novvy_query_generation", {
        ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false,
      }));
    }
    const previewUrl = queried.previewUrl || findPreviewUrl(queried);
    if (!previewUrl) throw new Error("图片生成查询超时，尚未返回预览地址");
    appendCardMessage(sessionId, `落版图 V${generatingCard.version} 已生成。请继续审核；确认使用前不会进入人物与参考图。`, {
      ...generatingCard, previewUrl, status: "candidate", details: [
        ...generatingCard.details,
        ...(referencedAssets.length ? [{ label: "引用资产", content: referencedAssets.map((asset) => asset.reference).join("、") }] : []),
        { label: "生成任务", content: taskId || providerSessionId },
      ],
    });
    db.prepare("UPDATE creative_sessions SET stage = 'final_card_review', error_message = NULL, updated_at = ? WHERE id = ?").run(now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCardMessage(sessionId, `落版图修改版生成失败：${message}。原图继续保留，你可以直接重试。`, { ...generatingCard, previewUrl: sourceCard.previewUrl, status: "failed" });
    db.prepare("UPDATE creative_sessions SET stage = 'final_card_review', error_message = ?, updated_at = ? WHERE id = ?").run(message, now(), sessionId);
  }
}

export function approveFinalCard(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "final_card" && item.previewUrl);
  if (!card) throw new Error("找不到已经生成的落版图预览");
  const drama = db.prepare("SELECT analysis_json FROM drama_analyses WHERE id = ?").get(session.drama_id);
  const analysis = drama?.analysis_json ? JSON.parse(drama.analysis_json) : {};
  const candidates = dramaReferenceImageCandidates(analysis);
  const slotMeta = {
    maleFront: ["male_front", "男主人公正面"], maleSide: ["male_side", "男主人公侧面"],
    femaleFront: ["female_front", "女主人公正面"], femaleSide: ["female_side", "女主人公侧面"],
  };
  const referenceCards = Object.entries(slotMeta).flatMap(([key, [slot, title]]) => {
    const item = candidates[key];
    if (!item?.available || !item.screenshotId) return [];
    return [{
      id: `reference-${slot}`, kind: "character_image", title, summary: item.selectionReason || item.visibleFeatures || "来自短剧分析的原始人物截图候选。",
      previewUrl: `/api/screenshots/${item.screenshotId}`,
      details: [
        { label: "参考槽位", content: slot },
        { label: "人物", content: item.character || title.replace(/[正侧]面$/, "") },
        { label: "可见特征", content: item.visibleFeatures || "请查看截图" },
        { label: "替代风险", content: item.risks || "请确认人物身份和角度是否适合作为生成参考" },
      ], status: "candidate",
    }];
  });
  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const priorCards = (workspace.confirmedCards || []).map((item) => item.kind === "final_card" && item.status === "confirmed" ? { ...item, status: "superseded" } : item);
  workspace.confirmedCards = [...priorCards, {
    id: `confirmed-${cardId}-generated`, kind: "final_card", title: `已确认落版图｜${card.title}`,
    summary: "真实生成结果已经用户视觉确认，可作为后续 final_card 参考素材。",
    details: [...(card.details || []), { label: "真实预览", content: card.previewUrl }], status: "confirmed", confirmedAt: timestamp,
  }];
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "approved", referenceStatus: "candidate_review" };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `确认使用已生成的落版图 ${cardId}`, timestamp);
  appendCardMessage(sessionId, referenceCards.length
    ? "这张落版图已经确认使用。接下来请检查男女主人公参考截图；你可以逐张确认，或在对应卡片里指出要更换的角度。"
    : "这张落版图已经确认使用。当前短剧分析里没有完整的人物参考截图，需要先补齐男女主人公的正面和侧面素材。", { ...card, status: "confirmed" });
  if (referenceCards.length) {
    db.prepare("INSERT INTO creative_messages (session_id, role, content, cards_json, created_at) VALUES (?, 'assistant', ?, ?, ?)")
      .run(sessionId, "这是从短剧分析结果中带入的主人公参考截图候选。", JSON.stringify(referenceCards), timestamp);
  }
  db.prepare("UPDATE creative_sessions SET stage = 'reference_review', workspace_json = ?, error_message = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(workspace), timestamp, sessionId);
  recordCreativeFeedback(sessionId, `确认使用已生成的落版图 ${cardId}`, { decision: "approved", assetId: cardId, key: `session:${sessionId}:final-card:${cardId}:approved` });
  recordCreativeStage(sessionId, "final_card", { cardId, title: card.title, previewUrl: card.previewUrl }, { version: Number(card.version || 1), status: "confirmed", key: `session:${sessionId}:final-card:${cardId}:confirmed` });
}

async function runFinalCardGeneration(sessionId, card, prompt) {
  try {
    const client = new NovvyMcpClient();
    await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt, n: 1, outputFormat: "png", quality: "high", includeRaw: false,
    }));
    const taskId = findValue(created, ["taskId", "task_id", "id"]);
    const providerSessionId = findValue(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回可查询的生成任务 ID");

    let queried = created;
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = normalizedStatus(queried);
      const previewUrl = findPreviewUrl(queried);
      if (status === "completed" && previewUrl) {
        queried = { ...queried, taskId, previewUrl };
        break;
      }
      if (status === "failed") throw new Error(findValue(queried, ["error", "errorMessage", "message"]) || "Novvy 图片生成失败");
      await wait(5000);
      queried = unpackToolResult(await client.callTool("novvy_query_generation", {
        ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false,
      }));
    }
    const previewUrl = queried.previewUrl || findPreviewUrl(queried);
    if (!previewUrl) throw new Error("图片生成查询超时，尚未返回预览地址");
    const completedCard = {
      ...card,
      status: "candidate",
      previewUrl,
      details: [...(card.details || []), { label: "生成任务", content: taskId || providerSessionId }],
    };
    appendCardMessage(sessionId, "落版图已经生成好了。请直接查看真实预览；你可以确认采用，也可以在卡片里写修改意见后生成新版本。", completedCard);
    db.prepare("UPDATE creative_sessions SET stage = 'final_card_review', updated_at = ? WHERE id = ?").run(now(), sessionId);
    recordCreativeStage(sessionId, "final_card", { cardId: card.id, title: card.title, status: "generated" }, { version: Number(card.version || 1), status: "awaiting_confirmation", key: `session:${sessionId}:final-card:${card.id}:v${Number(card.version || 1)}:generated` });
    recordCreativeAsset(sessionId, "final_card", previewUrl, { version: Number(card.version || 1), stageOutputId: card.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCardMessage(sessionId, `这次落版图没有生成成功：${message}。候选方案和提示词都已保留，你可以直接重试。`, { ...card, status: "failed" });
    db.prepare("UPDATE creative_sessions SET stage = 'final_card_review', error_message = ?, updated_at = ? WHERE id = ?").run(message, now(), sessionId);
  }
}

function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (value && typeof value === "object") return [value, ...Object.values(value).flatMap(walk)];
  return [value];
}

function findValue(data, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const node of walk(data)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (wanted.has(key.toLowerCase()) && (typeof value === "string" || typeof value === "number")) return String(value);
    }
  }
  return "";
}

function normalizedStatus(data) {
  const status = findValue(data, ["status", "state"]).toLowerCase();
  if (/complete|success|succeed|done/.test(status)) return "completed";
  if (/fail|error|cancel/.test(status)) return "failed";
  return "working";
}

function findPreviewUrl(data) {
  const keys = new Set(["imageurl", "resulturl", "outputurl", "downloadurl"]);
  for (const node of walk(data)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const [key, value] of Object.entries(node)) if (keys.has(key.toLowerCase()) && typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  return "";
}
