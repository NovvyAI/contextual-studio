import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, now, resolveAssetReferences } from "./database.js";
import { preparePngEditSource, uploadPngEditInput, validatePngEditInputs } from "./image-mask.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";
import { recordCreativeAsset, recordCreativeFeedback, recordCreativeStage } from "./creative-telemetry.js";
import { dramaReferenceImageCandidates } from "./drama-analysis-v3.js";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cards(sessionId) {
  return db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId)
    .flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
}

function append(sessionId, content, card) {
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, content, JSON.stringify([card]), now());
}

export function prepareCharacterReferenceReview(sessionId) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const drama = db.prepare("SELECT analysis_json FROM drama_analyses WHERE id=?").get(session.drama_id);
  const analysis = drama?.analysis_json ? JSON.parse(drama.analysis_json) : {};
  const episode = Array.isArray(analysis.episodeAnalyses) ? analysis.episodeAnalyses.at(-1) : null;
  const dynamicCharacters = Array.isArray(episode?.characterLibrary?.characters) ? episode.characterLibrary.characters : [];
  const candidates = dramaReferenceImageCandidates(analysis);
  const slotMeta = {
    maleFront: ["male_front", "男主人公正面"], maleSide: ["male_side", "男主人公侧面"],
    femaleFront: ["female_front", "女主人公正面"], femaleSide: ["female_side", "女主人公侧面"],
  };
  let referenceCards = dynamicCharacters.flatMap((character) => {
    const bestByView = new Map();
    for (const candidate of character.candidates || []) {
      const current = bestByView.get(candidate.view);
      if (!current || Number(candidate.qualityScore || 0) > Number(current.qualityScore || 0)) bestByView.set(candidate.view, candidate);
    }
    return [...bestByView.values()].map((candidate) => ({
      id: `reference-${character.characterId}-${candidate.candidateId}`,
      kind: "character_image",
      title: `${character.displayName || character.characterId}｜${({ front: "正面", left_profile: "左侧面", right_profile: "右侧面", three_quarter_left: "左侧 3/4", three_quarter_right: "右侧 3/4" })[candidate.view] || "人物候选"}`,
      summary: character.selectionReason || "由本地人脸检测从全片筛选的人物参考截图候选。",
      previewUrl: candidate.url || (candidate.screenshotId ? `/api/face-candidates/${candidate.screenshotId}` : ""),
      candidateNumber: 0,
      details: [
        { label: "人物编号", content: character.characterId },
        { label: "剧情身份", content: character.narrativeRole || "unknown" },
        { label: "画面角度", content: candidate.view || "unknown" },
        { label: "本地质量分", content: String(candidate.qualityScore ?? "unknown") },
        { label: "候选编号", content: candidate.candidateId },
      ], status: "candidate",
    }));
  });
  if (!referenceCards.length) referenceCards = Object.entries(slotMeta).flatMap(([key, [slot, title]]) => {
    const item = candidates[key];
    if (!item?.available || !item.screenshotId) return [];
    return [{
      id: `reference-${slot}`, kind: "character_image", title,
      summary: item.selectionReason || item.visibleFeatures || "来自短剧分析的原始人物截图候选。",
      previewUrl: `/api/screenshots/${item.screenshotId}`,
      details: [
        { label: "参考槽位", content: slot },
        { label: "人物", content: item.character || title.replace(/[正侧]面$/, "") },
        { label: "可见特征", content: item.visibleFeatures || "请查看截图" },
        { label: "替代风险", content: item.risks || "请确认人物身份和角度是否适合作为生成参考" },
      ], status: "candidate",
    }];
  });
  referenceCards = referenceCards.map((card, index) => ({ ...card, candidateNumber: index + 1 }));
  const timestamp = now();
  if (referenceCards.length) {
    db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
      .run(sessionId, "创意方案已经确认。请先选择用于后续制作的人物参考图；也可以继续添加或修改人物候选。", JSON.stringify(referenceCards), timestamp);
  } else {
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
      .run(sessionId, "创意方案已经确认。当前短剧分析中没有完整人物参考截图，请先添加人物参考图。", timestamp);
  }
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  workspace.productionPlan = { ...(workspace.productionPlan || {}), referenceStatus: "candidate_review", finalCardStatus: "waiting_for_characters" };
  db.prepare("UPDATE creative_sessions SET stage='reference_review',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?")
    .run(JSON.stringify(workspace), timestamp, sessionId);
}

function mcpConfigPath() {
  if (process.env.NOVVY_MCP_CONFIG) return path.resolve(process.env.NOVVY_MCP_CONFIG);
  const root = path.join(os.homedir(), ".codex/plugins/cache/novvy-local/novvy-ad-creative");
  const version = fs.readdirSync(root).sort().reverse().find((item) => fs.existsSync(path.join(root, item, ".mcp.json")));
  if (!version) throw new Error("找不到 Novvy MCP 本地配置");
  return path.join(root, version, ".mcp.json");
}

export async function publicInputUrl(previewUrl) {
  if (/^https?:\/\//.test(previewUrl)) return previewUrl;
  if (path.isAbsolute(previewUrl) && fs.existsSync(previewUrl)) return uploadLocalImage(previewUrl, "uploaded_reference");
  const chatAttachmentMatch = previewUrl.match(/^\/api\/creative\/chat-attachments\/(\d+)\/([^/]+)$/);
  if (chatAttachmentMatch) {
    const sessionId = Number(chatAttachmentMatch[1]);
    const storedName = decodeURIComponent(chatAttachmentMatch[2]);
    const attachment = db.prepare("SELECT attachments_json FROM creative_messages WHERE session_id=? AND attachments_json IS NOT NULL ORDER BY id DESC").all(sessionId)
      .flatMap((row) => { try { return JSON.parse(row.attachments_json || "[]"); } catch { return []; } })
      .find((item) => item.storedName === storedName && item.storedPath);
    if (!attachment || !fs.existsSync(attachment.storedPath)) throw new Error("本地上传资产文件不存在");
    return uploadLocalImage(attachment.storedPath, "uploaded_reference");
  }
  const match = previewUrl.match(/^\/api\/screenshots\/(\d+)$/);
  const faceMatch = previewUrl.match(/^\/api\/face-candidates\/(\d+)$/);
  if (!match && !faceMatch) throw new Error("人物候选缺少可上传的真实图片");
  const screenshot = match
    ? db.prepare("SELECT image_blob,mime_type FROM drama_screenshots WHERE id=?").get(Number(match[1]))
    : db.prepare("SELECT image_blob,mime_type FROM drama_face_candidates WHERE id=?").get(Number(faceMatch[1]));
  if (!screenshot) throw new Error("人物候选原图不存在");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-character-"));
  const inputPath = path.join(tempDir, screenshot.mime_type === "image/png" ? "input.png" : "input.jpg");
  await fsp.writeFile(inputPath, screenshot.image_blob);
  try {
    return await uploadLocalImage(inputPath, "character_reference");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function uploadLocalImage(inputPath, slot) {
  const script = path.resolve(".agents/skills/novvy-ad-creative/scripts/upload_ai_platform_asset.py");
  const projectPython = path.resolve(".venv/bin/python");
  const resolver = path.resolve(".agents/skills/novvy-ad-creative/scripts/novvy_python.sh");
  const preferredPython = process.env.CONTEXTUAL_PYTHON || (fs.existsSync(projectPython) ? projectPython : "");
  let python;
  try {
    const resolved = await execFileAsync(resolver, [], { env: { ...process.env, ...(preferredPython ? { NOVVY_PYTHON: preferredPython } : {}) }, maxBuffer: 1024 * 1024 });
    python = resolved.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`图片上传需要 Python 3.10 或更高版本。请重新运行 ./install_environment.sh 后重试。${detail ? ` (${detail})` : ""}`);
  }
  const { stdout } = await execFileAsync(python, [script, "--mode", "asset", "--kind", "image", "--mcp-json", mcpConfigPath(), "--slot", `${slot}=${inputPath}`], { env: { ...process.env, NOVVY_PYTHON: python }, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  const url = result.videoPayloadHint?.imageUrls?.[0] || result.referenceUrls?.[0];
  if (!url) throw new Error("图片上传后没有返回公开地址");
  return url;
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

const SIX_VIEW_LABELS = ["正脸", "侧脸", "侧 3/4", "全身正面", "全身侧面", "全身侧 3/4"];

function detailValue(card, label) {
  return String((card.details || []).find((item) => item.label === label)?.content || "").trim();
}

function isSixViewPanel(card) {
  return detailValue(card, "参考类型") === "人物六视图面板";
}

function characterIdentity(card) {
  const characterId = detailValue(card, "人物编号") || detailValue(card, "人物");
  const displayName = characterId || String(card.title || "人物").split("｜")[0].trim() || card.id;
  return { id: characterId || card.id, name: displayName };
}

async function createSixViewPanel(sessionId, character, sourceCards, candidateNumber) {
  const inputUrls = [];
  for (const card of sourceCards) inputUrls.push(await publicInputUrl(card.previewUrl));
  const card = {
    id: `six-view-${character.id}-${Date.now()}`,
    kind: "character_image",
    title: `${character.name}｜六视图面板`,
    summary: `同一人物的 ${SIX_VIEW_LABELS.join("、")}，请完整审核人物身份、服装和六个角度。`,
    previewUrl: "",
    candidateNumber,
    status: "generating",
    details: [
      { label: "人物编号", content: character.id },
      { label: "参考类型", content: "人物六视图面板" },
      { label: "固定槽位", content: SIX_VIEW_LABELS.join("｜") },
      { label: "身份来源", content: sourceCards.map((item) => item.title).join("、") },
    ],
  };
  append(sessionId, `正在为「${character.name}」补齐缺失角度并生成六视图面板。`, card);
  const client = new NovvyMcpClient(); await client.initialize();
  const prompt = `Create one clean 2-by-3 character turnaround reference panel for the exact same person shown in all supplied identity references. The six cells, in reading order, must be: (1) face front, (2) face side profile, (3) face three-quarter view, (4) full-body front, (5) full-body side profile, (6) full-body three-quarter view. Preserve the same facial identity, age, body proportions, skin tone, hairstyle, hair color, costume, costume colors, hat, footwear, jewelry, and accessories in every cell. Use a plain neutral light-gray studio background, consistent lighting and scale, one person only in each cell. Show the complete body including feet in all full-body cells. No captions, subtitles, text, labels, logos, watermarks, props, extra people, or cropped limbs. This is a production identity reference panel, not a dramatic scene.`;
  const created = unpackToolResult(await client.callTool("novvy_create_image_generation", { model: "gpt-image-2", prompt, imageUrls: inputUrls, inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false }));
  const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
  if (!taskId && !providerSessionId) throw new Error(`Novvy 未返回「${character.name}」六视图任务 ID`);
  let result = created; const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline && !imageUrl(result)) {
    const status = valueFor(result, ["status", "state"]).toLowerCase();
    if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || `「${character.name}」六视图生成失败`);
    await wait(5000);
    result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
  }
  const previewUrl = imageUrl(result);
  if (!previewUrl) throw new Error(`「${character.name}」六视图生成查询超时`);
  const completed = { ...card, previewUrl, status: "candidate", details: [...card.details, { label: "生成任务", content: taskId || providerSessionId }] };
  append(sessionId, `「${character.name}」六视图面板已经生成。请检查六个角度是否为同一人物、服装是否一致；可以在卡片内修改后再确认。`, completed);
  recordCreativeAsset(sessionId, "reference_panel", previewUrl, { stageOutputId: card.id, metadata: { title: card.title, characterId: character.id, type: "six_view_panel" } });
  return completed;
}

async function generateSixViewPanels(sessionId, groups) {
  try {
    let number = 1;
    for (const group of groups) await createSixViewPanel(sessionId, group.character, group.cards, number++);
    const session = db.prepare("SELECT workspace_json FROM creative_sessions WHERE id=?").get(sessionId);
    const workspace = session?.workspace_json ? JSON.parse(session.workspace_json) : {};
    workspace.productionPlan = { ...(workspace.productionPlan || {}), sixViewStatus: "candidate_review", referenceStatus: "six_view_review" };
    db.prepare("UPDATE creative_sessions SET stage='reference_review',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?")
      .run(JSON.stringify(workspace), now(), sessionId);
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
      .run(sessionId, `已为 ${groups.length} 个人物生成六视图面板。请勾选每个人物的一张合格面板，再点击“确认六视图面板并继续”。`, now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=?,updated_at=? WHERE id=?").run(message, now(), sessionId);
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
      .run(sessionId, `六视图面板没有全部生成成功：${message}。已生成的候选会保留，可以修改或重新确认人物身份后重试。`, now());
  }
}

export function resumeSixViewPanelGeneration(sessionId) {
  const session = db.prepare("SELECT workspace_json FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const pending = workspace.pendingCharacterReferences || [];
  const latest = new Map();
  cards(sessionId).forEach((card) => { if (!latest.has(card.id)) latest.set(card.id, card); });
  const completedCharacters = new Set([...latest.values()].filter((card) => isSixViewPanel(card) && card.previewUrl && card.status === "candidate").map((card) => characterIdentity(card).id));
  const grouped = new Map();
  for (const item of pending) {
    const card = latest.get(item.id) || { ...item, details: [{ label: "人物编号", content: item.characterId || item.id }] };
    const character = { id: item.characterId || characterIdentity(card).id, name: String(item.title || "人物").split("｜")[0] };
    if (completedCharacters.has(character.id)) continue;
    const group = grouped.get(character.id) || { character, cards: [] };
    group.cards.push(card); grouped.set(character.id, group);
  }
  if (!grouped.size) {
    workspace.productionPlan = { ...(workspace.productionPlan || {}), sixViewStatus: "candidate_review", referenceStatus: "six_view_review" };
    db.prepare("UPDATE creative_sessions SET stage='reference_review',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), now(), sessionId);
    return;
  }
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  generateSixViewPanels(sessionId, [...grouped.values()]);
}

export function startCharacterRegeneration(sessionId, cardId, feedback, editInput = null) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const card = cards(sessionId).find((item) => item.id === cardId && item.kind === "character_image" && item.previewUrl);
  if (!card) throw new Error("找不到这张人物候选的真实图片");
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请填写人物图修改意见");
  const edit = validatePngEditInputs(editInput);
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `修改人物候选 ${cardId}：${instruction}`, timestamp);
  append(sessionId, "收到，我正在基于这张人物候选生成修改版；完成后新图会替换在同一张卡片里。", { ...card, previewUrl: "", status: "generating" });
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  regenerate(sessionId, card, instruction, edit);
}

function identityBaseCard(sessionId, description) {
  const all = cards(sessionId);
  if (/(女主|女性|女人|女孩|女主人公)/.test(description)) return all.find((item) => item.id === "reference-female_front" && item.previewUrl);
  if (/(男主|男性|男人|男孩|男主人公)/.test(description)) return all.find((item) => item.id === "reference-male_front" && item.previewUrl);
  return null;
}

export function startCustomCharacterGeneration(sessionId, description, replaceCardId = "") {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const instruction = String(description || "").trim();
  if (!instruction) throw new Error("请描述要添加的人物图");
  const existingCustom = cards(sessionId).filter((item) => /^reference-custom-/.test(item.id));
  const replacing = replaceCardId ? existingCustom.find((item) => item.id === replaceCardId) : null;
  const number = replacing?.candidateNumber || String(5 + new Set(existingCustom.map((item) => item.id)).size).padStart(2, "0");
  const explicitlyReferenced = resolveAssetReferences(sessionId, instruction)[0];
  const baseCard = explicitlyReferenced ? { id: explicitlyReferenced.sourceCardId || explicitlyReferenced.reference, title: explicitlyReferenced.title, previewUrl: explicitlyReferenced.url } : identityBaseCard(sessionId, instruction);
  const card = { id: replacing?.id || `reference-custom-${Date.now()}`, kind: "character_image", title: replacing?.title || `自定义人物候选 ${number}`, summary: instruction, previewUrl: "", version: Number(replacing?.version || 0) + 1, candidateNumber: number, details: [{ label: "生成要求", content: instruction }, { label: "身份参考", content: explicitlyReferenced ? `${explicitlyReferenced.reference}｜${explicitlyReferenced.title}` : baseCard ? `${baseCard.title}（${baseCard.id}）` : "未指定现有人物，按纯文字创建" }], status: "generating" };
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `添加人物候选：${instruction}`, timestamp);
  append(sessionId, `收到，我正在生成人物候选 ${card.candidateNumber}。完成后会加入当前人物参考图组。`, card);
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  generateCustom(sessionId, card, instruction, baseCard);
}

export function approveCharacterReferences(sessionId, cardIds) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const selectedIds = [...new Set((cardIds || []).map(String))];
  if (!selectedIds.length) throw new Error("请至少勾选一张人物图");
  const latest = new Map();
  cards(sessionId).forEach((card) => { if (!latest.has(card.id)) latest.set(card.id, card); });
  const selected = selectedIds.map((id) => latest.get(id)).filter((card) => card?.previewUrl && !["superseded", "failed", "generating"].includes(card.status));
  if (selected.length !== selectedIds.length) throw new Error("部分人物候选已作废、仍在生成或缺少真实图片，请刷新后重新勾选");
  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const sixViewReview = workspace.productionPlan?.sixViewStatus === "candidate_review";
  if (!sixViewReview) {
    const grouped = new Map();
    for (const card of selected) {
      const character = characterIdentity(card);
      const group = grouped.get(character.id) || { character, cards: [] };
      group.cards.push(card); grouped.set(character.id, group);
    }
    workspace.pendingCharacterReferences = selected.map((card) => ({ id: card.id, title: card.title, previewUrl: card.previewUrl, characterId: characterIdentity(card).id }));
    workspace.productionPlan = { ...(workspace.productionPlan || {}), sixViewStatus: "generating", referenceStatus: "six_view_generating", finalCardStatus: "waiting_for_characters" };
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认人物身份参考：${selectedIds.join("、")}`, timestamp);
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
      .run(sessionId, `已确认 ${grouped.size} 个人物身份。现在自动补齐每个人物缺少的正脸、侧脸、侧 3/4、全身正面、全身侧面和全身侧 3/4，并生成待审核的六视图面板；不会直接进入下一阶段。`, timestamp);
    db.prepare("UPDATE creative_sessions SET stage='working',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
    generateSixViewPanels(sessionId, [...grouped.values()]);
    return;
  }
  if (selected.some((card) => !isSixViewPanel(card))) throw new Error("六视图审核阶段只能勾选每个人物的六视图面板，请取消散装人物图后重试");
  const expectedCharacters = new Set((workspace.pendingCharacterReferences || []).map((item) => item.characterId || characterIdentity(latest.get(item.id) || item).id));
  const selectedCharacters = new Set(selected.map((card) => characterIdentity(card).id));
  if (selectedCharacters.size !== selected.length) throw new Error("同一个人物只能确认一张六视图面板");
  if (expectedCharacters.size && [...expectedCharacters].some((id) => !selectedCharacters.has(id))) throw new Error("每个已确认人物都需要勾选一张六视图面板");
  workspace.confirmedCards ||= [];
  workspace.confirmedCards.push({
    id: `confirmed-reference-group-${Date.now()}`, kind: "reference_panel", title: "已确认人物参考图组",
    summary: `已确认 ${selected.length} 个人物六视图面板，供 ImaRouter 锁定人物身份；原始人物参考继续供分镜与 Novvy MCP 使用。`,
    details: selected.map((card) => ({ label: card.title, content: card.previewUrl })), status: "confirmed", confirmedAt: timestamp,
    characterPanelUrls: selected.map((card) => card.previewUrl),
    characterReferenceUrls: (workspace.pendingCharacterReferences || []).map((item) => item.previewUrl).filter(Boolean),
  });
  workspace.productionPlan = { ...(workspace.productionPlan || {}), sixViewStatus: "approved", referenceStatus: "approved", finalCardStatus: "direction_pending", videoPromptStatus: "final_card_direction_pending" };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认人物六视图面板：${selectedIds.join("、")}`, timestamp);
  const autoMessage = `人物六视图面板已经确认，共 ${selected.length} 个人物。现在生成 2-4 张 final_card 落版方向候选卡：只确定末镜衔接意图、主视觉、9:16 构图、英文标题/副标题/CTA、字体层级、色彩、产品真实性边界和后续图片生成提示词；previewUrl 为空，不执行图片生成。stage 使用 final_card_review，等待用户确认一个落版方向，不要生成 audiovisual_direction 或 storyboard。`;
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)").run(sessionId, `已确认 ${selected.length} 张人物六视图面板。现在自动生成落版方向候选。`, timestamp);
  db.prepare("UPDATE creative_sessions SET stage='working',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
  recordCreativeFeedback(sessionId, `确认人物六视图面板：${selectedIds.join("、")}`, { decision: "approved", stageOutputId: "reference-panel", key: `session:${sessionId}:reference-panel:approved:${timestamp}` });
  recordCreativeStage(sessionId, "reference_panel", { cards: selected.map((card) => ({ id: card.id, title: card.title, previewUrl: card.previewUrl })) }, { status: "confirmed", key: `session:${sessionId}:reference-panel:${timestamp}` });
  selected.forEach((card) => recordCreativeAsset(sessionId, "reference_panel", card.previewUrl, { stageOutputId: card.id, metadata: { title: card.title } }));
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, autoMessage, false));
}

async function regenerate(sessionId, card, feedback, edit) {
  try {
    const sourceUrl = await preparePngEditSource(card.previewUrl, edit.mask, publicInputUrl);
    const maskUrl = await uploadPngEditInput(edit.mask, publicInputUrl, "mask");
    const referencedAssets = resolveAssetReferences(sessionId, feedback);
    const referencedUrls = [];
    for (const asset of referencedAssets) referencedUrls.push(await publicInputUrl(asset.url));
    const imageUrls = [...new Set([sourceUrl, ...referencedUrls])];
    const client = new NovvyMcpClient(); await client.initialize();
    const assetGuide = referencedAssets.length ? ` Additional reference images named by the user are supplied after the current card image in this order: ${referencedAssets.map((asset) => `${asset.reference} (${asset.title})`).join(", ")}. Use only the attributes the user explicitly assigns to each numbered asset.` : "";
    const maskGuide = maskUrl ? " A PNG alpha mask is supplied for the first image. Modify only its transparent region and preserve every unmasked pixel-level visual element as closely as possible." : "";
    const prompt = `Edit the first supplied image, which is the current character card, according to this user request: ${feedback}.${maskGuide}${assetGuide}\nPreserve the current card person's identity unless the user explicitly assigns identity from a numbered asset. Do not casually blend faces or identities. Produce one clean character-reference image only. Do not add captions, subtitles, labels, logos, watermarks, or extra people.`;
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", { model: "gpt-image-2", prompt, imageUrls, ...(maskUrl ? { maskUrl } : {}), inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false }));
    const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回人物图任务 ID");
    let result = created; const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline && !imageUrl(result)) {
      const status = valueFor(result, ["status", "state"]).toLowerCase();
      if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "人物图生成失败");
      await wait(5000);
      result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
    }
    const previewUrl = imageUrl(result); if (!previewUrl) throw new Error("人物图生成查询超时");
    const version = Number(card.version || 1) + 1;
    append(sessionId, `人物候选 ${card.id} 的 V${version} 已经生成，新图已替换在原卡片中。`, { ...card, previewUrl, version, status: "candidate", details: [...(card.details || []), { label: `V${version} 修改`, content: feedback }, ...(edit.mask ? [{ label: "局部编辑蒙版", content: `${edit.mask.width}×${edit.mask.height} PNG alpha` }] : []), ...(referencedAssets.length ? [{ label: "引用资产", content: referencedAssets.map((asset) => asset.reference).join("、") }] : []), { label: "生成任务", content: taskId || providerSessionId }] });
    db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `这次人物图没有生成成功：${message}。原图仍保留在同一张卡片中。`, { ...card, status: "failed" });
    db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=?,updated_at=? WHERE id=?").run(message, now(), sessionId);
  }
}

async function generateCustom(sessionId, card, description, baseCard) {
  try {
    const client = new NovvyMcpClient(); await client.initialize();
    const sourceUrl = baseCard ? await publicInputUrl(baseCard.previewUrl) : "";
    const prompt = baseCard
      ? `Edit the provided character reference into one new camera-angle reference image. User request: ${description}. The person must remain exactly the same individual as the input image. Preserve facial identity, facial proportions, age, skin tone, hairstyle, hair color, hat, costume design, costume colors, and accessories. Change only the requested camera angle or pose. Show one person only. No captions, subtitles, labels, logos, watermarks, split panels, or extra people.`
      : `Create one polished vertical character reference image for a live-action historical drama advertising production. Character request: ${description}. Show one person only, with a clear face and useful identity details. No captions, subtitles, labels, logos, watermarks, split panels, or extra people.`;
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", { model: "gpt-image-2", prompt, ...(sourceUrl ? { imageUrls: [sourceUrl], inputFidelity: "high" } : {}), n: 1, outputFormat: "png", quality: "high", includeRaw: false }));
    const taskId = valueFor(created, ["taskId", "task_id", "id"]); const providerSessionId = valueFor(created, ["sessionId", "session_id"]);
    if (!taskId && !providerSessionId) throw new Error("Novvy 未返回人物图任务 ID");
    let result = created; const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline && !imageUrl(result)) {
      const status = valueFor(result, ["status", "state"]).toLowerCase();
      if (/fail|error|cancel/.test(status)) throw new Error(valueFor(result, ["errorMessage", "message", "error"]) || "人物图生成失败");
      await wait(5000);
      result = unpackToolResult(await client.callTool("novvy_query_generation", { ...(taskId ? { taskId } : {}), ...(providerSessionId ? { sessionId: providerSessionId } : {}), model: "gpt-image-2", includeRaw: false }));
    }
    const previewUrl = imageUrl(result); if (!previewUrl) throw new Error("人物图生成查询超时");
    append(sessionId, `人物候选 ${card.candidateNumber} 已生成，并已加入人物参考图组。`, { ...card, previewUrl, status: "candidate", details: [...card.details, { label: "生成任务", content: taskId || providerSessionId }] });
    db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=NULL,updated_at=? WHERE id=?").run(now(), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(sessionId, `新增人物候选失败：${message}`, { ...card, status: "failed" });
    db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=?,updated_at=? WHERE id=?").run(message, now(), sessionId);
  }
}
