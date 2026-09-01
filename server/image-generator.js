import { db, now, resolveAssetReferences } from "./database.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";
import { publicInputUrl } from "./character-generator.js";
import { recordCreativeAsset, recordCreativeFeedback, recordCreativeStage } from "./creative-telemetry.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function allCards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id = ? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => {
      try { return JSON.parse(row.cards_json || "[]"); } catch { return []; }
    });
}

export function finalCardPrompt(card) {
  const detail = (card.details || []).find((item) => /(GPT-image-2.*(提示词|prompt)|英文.*提示词|English.*prompt|后续图片生成提示词|图片生成提示词)/i.test(String(item.label || "")));
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
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  if (workspace.productionPlan?.finalCardStatus !== "ready_to_generate") throw new Error("真实落版图需在末镜分镜图确认后生成");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "final_card");
  if (!card) throw new Error("找不到这张落版图候选卡");
  const prompt = finalCardPrompt(card);
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
    appendCardMessage(sessionId, `落版图 V${generatingCard.version} 已生成。请继续审核；确认使用后才会生成正式视频提示词。`, {
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
  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const priorCards = (workspace.confirmedCards || []).map((item) => item.kind === "final_card" && item.status === "confirmed" ? { ...item, status: "superseded" } : item);
  workspace.confirmedCards = [...priorCards, {
    id: `confirmed-${cardId}-generated`, kind: "final_card", title: `已确认落版图｜${card.title}`,
    summary: "真实生成结果已经用户视觉确认，可作为后续 final_card 参考素材。",
    details: [...(card.details || []), { label: "真实预览", content: card.previewUrl }], status: "confirmed", confirmedAt: timestamp,
  }];
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "approved", videoPromptStatus: "pending" };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `确认使用已生成的落版图 ${cardId}`, timestamp);
  appendCardMessage(sessionId, "真实落版图已经确认。现在基于已确认的文字分镜、逐镜图片和落版图自动生成正式视频提示词。", { ...card, status: "confirmed" });
  db.prepare("UPDATE creative_sessions SET stage = 'working', workspace_json = ?, error_message = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(workspace), timestamp, sessionId);
  recordCreativeFeedback(sessionId, `确认使用已生成的落版图 ${cardId}`, { decision: "approved", assetId: cardId, key: `session:${sessionId}:final-card:${cardId}:approved` });
  recordCreativeStage(sessionId, "final_card", { cardId, title: card.title, previewUrl: card.previewUrl }, { version: Number(card.version || 1), status: "confirmed", key: `session:${sessionId}:final-card:${cardId}:confirmed` });
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, "真实落版图已经确认。现在生成正式 video_prompt 审核卡；保留全部人物参考、落版方向、视听方向、文字分镜和逐镜图片，不提交视频生成。", false));
}

export function approveFinalCardDirection(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage !== "final_card_review") throw new Error("当前不在落版方向确认阶段");
  const currentWorkspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  if (currentWorkspace.productionPlan?.finalCardStatus !== "direction_review") throw new Error("当前落版方向已经确认或尚未准备完成");
  const card = allCards(sessionId).find((item) => item.id === cardId && item.kind === "final_card" && !item.previewUrl);
  if (!card) throw new Error("找不到落版方向候选");
  const timestamp = now();
  const workspace = currentWorkspace;
  workspace.confirmedCards ||= [];
  workspace.confirmedCards.push({ ...card, id: `confirmed-${card.id}-direction-${Date.now()}`, title: `已确认落版方向｜${card.title}`, status: "confirmed", confirmedAt: timestamp });
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "direction_approved", videoPromptStatus: "audiovisual_direction_pending" };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认落版方向 ${card.id}`, timestamp);
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)").run(sessionId, "落版方向已确认。现在自动生成视听方向卡；真实落版图会等末镜分镜图确认后再生成。", timestamp);
  db.prepare("UPDATE creative_sessions SET stage='working',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
  recordCreativeFeedback(sessionId, `确认落版方向 ${card.id}`, { decision: "approved", stageOutputId: card.id, key: `session:${sessionId}:final-card-direction:${card.id}:approved` });
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, `已确认落版方向 ${card.id}。现在生成一张 audiovisual-direction-v1 视听方向卡，只总结可执行的视听语言 Bible，不推荐或列举导演；导演由用户在 UI 下拉框选择。进入 audiovisual_review，不生成 storyboard。`, false));
}

export function prepareFinalCardGeneration(sessionId, storyboardImages) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const direction = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "final_card" && !item.details?.some((detail) => detail.label === "真实预览"));
  if (!direction) throw new Error("找不到已确认的落版方向");
  const lastShot = [...storyboardImages].sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1);
  if (!lastShot?.previewUrl) throw new Error("找不到已确认的末镜分镜图");
  const card = {
    ...direction,
    id: String(direction.id).replace(/^confirmed-/, "").replace(/-direction-\d+$/, ""),
    title: `落版图生成稿｜${direction.title.replace(/^已确认落版方向｜/, "")}`,
    summary: "已结合末镜分镜图校准构图与衔接，等待确认后生成真实落版图。",
    previewUrl: "", status: "candidate",
    details: [...(direction.details || []), { label: "末镜衔接参考", content: lastShot.previewUrl }, { label: "末镜要求", content: "延续末镜主体位置、光色、动作终点和视觉重心，自然定格进入品牌与 CTA 落版。" }],
  };
  const timestamp = now();
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "ready_to_generate", videoPromptStatus: "waiting_for_final_card" };
  appendCardMessage(sessionId, "逐镜分镜图已经确认。落版图生成稿已按末镜重新校准；点击“确认并生成落版图”后才会创建真实图片任务。", card);
  db.prepare("UPDATE creative_sessions SET stage='final_card_review',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
}

async function runFinalCardGeneration(sessionId, card, prompt) {
  try {
    const lastShotUrl = card.details?.find((item) => item.label === "末镜衔接参考")?.content || "";
    const referenceUrl = lastShotUrl ? await publicInputUrl(lastShotUrl) : "";
    const client = new NovvyMcpClient();
    await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt: `${prompt}\nUse the supplied last-shot frame as the direct continuity reference. Preserve its subject placement, lighting, palette and visual momentum while resolving naturally into the approved advertising end card.`, ...(referenceUrl ? { imageUrls: [referenceUrl], inputFidelity: "high" } : {}), n: 1, outputFormat: "png", quality: "high", includeRaw: false,
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
