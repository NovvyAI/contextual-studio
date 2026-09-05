import { db, now, resolveAssetReferences, cardHistory, insertCardVersion, latestCard, latestCardsByKind, latestConfirmedCard, supersedeCards, transitionCreativeStage } from "./database.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";
import { publicInputUrl } from "./character-generator.js";
import { preparePngEditSource, uploadPngEditInput, validatePngEditInputs } from "./image-mask.js";
import { recordCreativeAsset, recordCreativeFeedback, recordCreativeStage } from "./creative-telemetry.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function finalCardPrompt(card) {
  const detail = (card.details || []).find((item) => /(GPT-image-2.*(提示词|prompt)|英文.*提示词|English.*prompt|后续图片生成提示词|图片生成提示词)/i.test(String(item.label || "")));
  return String(detail?.content || "").trim();
}

function mergeCardDetails(...groups) {
  const merged = new Map();
  for (const details of groups) for (const item of details || []) if (item?.label) merged.set(item.label, item);
  return [...merged.values()];
}

// Among every historical version of this card_id, the one with the most complete prompt/details —
// a repair-prompt turn or a later production step can produce a version with fewer details than an
// earlier one, so "latest" isn't always "richest".
function richestVersion(sessionId, cardId) {
  return [...cardHistory(sessionId, cardId).filter((item) => item.kind === "final_card")]
    .sort((left, right) => Number(Boolean(finalCardPrompt(right))) - Number(Boolean(finalCardPrompt(left))) || (right.details?.length || 0) - (left.details?.length || 0))[0];
}

function appendCardMessage(sessionId, content, card) {
  const result = db.prepare("INSERT INTO creative_messages (session_id, role, content, cards_json, created_at) VALUES (?, 'assistant', ?, ?, ?)")
    .run(sessionId, content, JSON.stringify([card]), now());
  return insertCardVersion(sessionId, Number(result.lastInsertRowid), card);
}

export function startFinalCardGeneration(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  if (workspace.productionPlan?.finalCardStatus !== "ready_to_generate") throw new Error("真实落版图需在末镜分镜图确认后生成");
  const confirmedDirectionId = latestConfirmedCard(sessionId, "final_card")?.id || "";
  if (!confirmedDirectionId || confirmedDirectionId !== cardId) throw new Error("这张候选卡不是已确认的落版方向，不能生成真实图片");
  const currentCard = latestCard(sessionId, cardId);
  const sourceCard = richestVersion(sessionId, cardId);
  if (!currentCard || !sourceCard) throw new Error("找不到这张落版图候选卡");
  const card = { ...sourceCard, ...currentCard, details: mergeCardDetails(sourceCard.details, currentCard.details) };
  const prompt = finalCardPrompt(card);
  if (!prompt) throw new Error("这张候选卡缺少 GPT-image-2 英文提示词");

  const timestamp = now();
  const generatingCard = { ...card, status: "generating", previewUrl: "" };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `确认并生成落版图候选 ${cardId}：${card.title}`, timestamp);
  const inserted = appendCardMessage(sessionId, "好的，方案已经确认。我现在开始生成这张落版图，完成后会把真实预览放回这张卡片供你审核。", generatingCard);
  transitionCreativeStage(sessionId, "working", { timestamp });

  runFinalCardGeneration(sessionId, inserted, prompt);
}

export function startFinalCardRegeneration(sessionId, cardId, feedback, editInput = null) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请先填写落版图修改意见");
  const edit = validatePngEditInputs(editInput);
  const card = latestCard(sessionId, cardId);
  if (!card || card.kind !== "final_card" || !card.previewUrl) throw new Error("找不到这张已生成的落版图预览");

  const timestamp = now();
  const version = Number(card.version || 1) + 1;
  const generatingCard = {
    ...card, version, status: "generating", previewUrl: "",
    details: [...(card.details || []), { label: `V${version} 修改意见`, content: instruction }],
  };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `修改落版图 ${cardId}：${instruction}`, timestamp);
  const inserted = appendCardMessage(sessionId, "收到，我会以当前落版图为主图生成修改版。旧版本继续保留，流程仍停留在落版图审核。", generatingCard);
  transitionCreativeStage(sessionId, "working", { timestamp });
  runFinalCardRegeneration(sessionId, card, inserted, instruction, edit);
}

async function runFinalCardRegeneration(sessionId, sourceCard, generatingCard, feedback, edit) {
  try {
    const sourceUrl = await preparePngEditSource(sourceCard.previewUrl, edit.mask, publicInputUrl);
    const maskUrl = await uploadPngEditInput(edit.mask, publicInputUrl, "mask");
    const referencedAssets = resolveAssetReferences(sessionId, feedback);
    const referencedUrls = [];
    for (const asset of referencedAssets) referencedUrls.push(await publicInputUrl(asset.url));
    const imageUrls = [...new Set([sourceUrl, ...referencedUrls])];
    const referenceGuide = referencedAssets.length
      ? ` Additional numbered reference images are supplied after the current final-card image in this order: ${referencedAssets.map((asset) => `${asset.reference} (${asset.title})`).join(", ")}. Apply only the visual element or role explicitly assigned to each reference by the user; do not treat a reference as a replacement for the entire final card.`
      : "";
    const maskGuide = maskUrl ? " A PNG alpha mask is supplied for the first image. Treat its transparent area as the only intended edit region and preserve the rest of the first image." : "";
    const prompt = `Edit the first supplied image, which is the exact current advertising final-card design. User feedback: ${feedback}.${maskGuide}${referenceGuide} Preserve every element not explicitly changed, including product identity, composition, visual hierarchy, English copy and CTA. Keep every visible English word accurate and mobile-readable. Return one polished vertical final-card image only. Do not create a collage, comparison layout, labels, annotations, watermark, or unintended text.`;
    const client = new NovvyMcpClient();
    await client.initialize();
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", {
      model: "gpt-image-2", prompt, imageUrls, ...(maskUrl ? { maskUrl } : {}), inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false,
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
        ...(edit.mask ? [{ label: "局部编辑蒙版", content: `${edit.mask.width}×${edit.mask.height} PNG alpha` }] : []),
        ...(referencedAssets.length ? [{ label: "引用资产", content: referencedAssets.map((asset) => asset.reference).join("、") }] : []),
        { label: "生成任务", content: taskId || providerSessionId },
      ],
    });
    transitionCreativeStage(sessionId, "final_card_review");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCardMessage(sessionId, `落版图修改版生成失败：${message}。原图继续保留，你可以直接重试。`, { ...generatingCard, previewUrl: sourceCard.previewUrl, status: "failed" });
    transitionCreativeStage(sessionId, "final_card_review", { errorMessage: message });
  }
}

export function approveFinalCard(sessionId, cardId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const card = latestCard(sessionId, cardId);
  if (!card || card.kind !== "final_card" || !card.previewUrl) throw new Error("找不到已经生成的落版图预览");
  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "approved", videoPromptStatus: "pending" };
  db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(sessionId, `确认使用已生成的落版图 ${cardId}`, timestamp);
  appendCardMessage(sessionId, "真实落版图已经确认。现在基于已确认的文字分镜、逐镜图片和落版图自动生成正式视频提示词。", { ...card, status: "confirmed", confirmedAt: timestamp });
  transitionCreativeStage(sessionId, "working", { workspaceJson: JSON.stringify(workspace), timestamp });
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
  const card = richestVersion(sessionId, cardId);
  if (!card) throw new Error("找不到落版方向候选");
  const timestamp = now();
  const workspace = currentWorkspace;
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "direction_approved", videoPromptStatus: "audiovisual_direction_pending" };
  // Every other still-live direction candidate from the original 2-4 proposals is abandoned —
  // mark them superseded so their chat card stops being a clickable "confirm/generate" action.
  const siblingIds = latestCardsByKind(sessionId, "final_card", { excludeStatuses: ["superseded", "confirmed"] })
    .filter((item) => !item.previewUrl && item.id !== cardId).map((item) => item.id);
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认落版方向 ${card.id}`, timestamp);
  const inserted = appendCardMessage(sessionId, "落版方向已确认。现在自动生成视听方向卡；真实落版图会等末镜分镜图确认后再生成。", { ...card, status: "confirmed", confirmedAt: timestamp });
  supersedeCards(sessionId, siblingIds);
  if (siblingIds.length) {
    db.prepare("INSERT INTO creative_messages (session_id, role, content, cards_json, created_at) VALUES (?, 'assistant', ?, ?, ?)")
      .run(sessionId, "其余落版方向候选保留记录，不再推进，也不会生成图片。", JSON.stringify(siblingIds.map((id) => ({ ...richestVersion(sessionId, id), status: "superseded" }))), timestamp);
  }
  transitionCreativeStage(sessionId, "working", { workspaceJson: JSON.stringify(workspace), timestamp });
  recordCreativeFeedback(sessionId, `确认落版方向 ${card.id}`, { decision: "approved", stageOutputId: card.id, key: `session:${sessionId}:final-card-direction:${card.id}:approved` });
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, `已确认落版方向 ${inserted.id}。现在生成一张 audiovisual-direction-v1 视听方向卡，只总结可执行的视听语言 Bible，不推荐或列举导演；导演由用户在 UI 下拉框选择。进入 audiovisual_review，不生成 storyboard。`, false));
}

export function prepareFinalCardGeneration(sessionId, storyboardImages) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const direction = latestConfirmedCard(sessionId, "final_card");
  if (!direction) throw new Error("找不到已确认的落版方向");
  const historicalDirection = richestVersion(sessionId, direction.id);
  const lastShot = [...storyboardImages].sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1);
  if (!lastShot?.previewUrl) throw new Error("找不到已确认的末镜分镜图");
  const card = {
    ...direction,
    ...(historicalDirection || {}),
    ...direction,
    id: direction.id,
    title: `落版图生成稿｜${direction.title}`,
    summary: "已结合末镜分镜图校准构图与衔接，等待确认后生成真实落版图。",
    previewUrl: "", status: "candidate",
    details: mergeCardDetails(historicalDirection?.details, direction.details, [{ label: "末镜衔接参考", content: lastShot.previewUrl }, { label: "末镜要求", content: "延续末镜主体位置、光色、动作终点和视觉重心，自然定格进入品牌与 CTA 落版。" }]),
  };
  const timestamp = now();
  workspace.productionPlan = { ...(workspace.productionPlan || {}), finalCardStatus: "ready_to_generate", videoPromptStatus: "waiting_for_final_card" };
  appendCardMessage(sessionId, "逐镜分镜图已经确认。落版图生成稿已按末镜重新校准；点击“确认并生成落版图”后才会创建真实图片任务。", card);
  transitionCreativeStage(sessionId, "final_card_review", { workspaceJson: JSON.stringify(workspace), timestamp });
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
    transitionCreativeStage(sessionId, "final_card_review", { keepErrorMessage: true });
    recordCreativeStage(sessionId, "final_card", { cardId: card.id, title: card.title, status: "generated" }, { version: Number(card.version || 1), status: "awaiting_confirmation", key: `session:${sessionId}:final-card:${card.id}:v${Number(card.version || 1)}:generated` });
    recordCreativeAsset(sessionId, "final_card", previewUrl, { version: Number(card.version || 1), stageOutputId: card.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCardMessage(sessionId, `这次落版图没有生成成功：${message}。候选方案和提示词都已保留，你可以直接重试。`, { ...card, status: "failed" });
    transitionCreativeStage(sessionId, "final_card_review", { errorMessage: message });
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
