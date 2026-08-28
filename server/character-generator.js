import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, now, resolveAssetReferences } from "./database.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";

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

function mcpConfigPath() {
  if (process.env.NOVVY_MCP_CONFIG) return path.resolve(process.env.NOVVY_MCP_CONFIG);
  const root = path.join(os.homedir(), ".codex/plugins/cache/novvy-local/novvy-ad-creative");
  const version = fs.readdirSync(root).sort().reverse().find((item) => fs.existsSync(path.join(root, item, ".mcp.json")));
  if (!version) throw new Error("找不到 Novvy MCP 本地配置");
  return path.join(root, version, ".mcp.json");
}

export async function publicInputUrl(previewUrl) {
  if (/^https?:\/\//.test(previewUrl)) return previewUrl;
  const match = previewUrl.match(/^\/api\/screenshots\/(\d+)$/);
  if (!match) throw new Error("人物候选缺少可上传的真实图片");
  const screenshot = db.prepare("SELECT image_blob,mime_type FROM drama_screenshots WHERE id=?").get(Number(match[1]));
  if (!screenshot) throw new Error("人物候选原图不存在");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-character-"));
  const inputPath = path.join(tempDir, screenshot.mime_type === "image/png" ? "input.png" : "input.jpg");
  await fsp.writeFile(inputPath, screenshot.image_blob);
  try {
    const script = path.resolve(".agents/skills/novvy-ad-creative/scripts/upload_ai_platform_asset.py");
    const { stdout } = await execFileAsync("python3", [script, "--mode", "asset", "--kind", "image", "--mcp-json", mcpConfigPath(), "--slot", `character_reference=${inputPath}`], { maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    const url = result.videoPayloadHint?.imageUrls?.[0] || result.referenceUrls?.[0];
    if (!url) throw new Error("人物原图上传后没有返回公开地址");
    return url;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
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

export function startCharacterRegeneration(sessionId, cardId, feedback) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  const card = cards(sessionId).find((item) => item.id === cardId && item.kind === "character_image" && item.previewUrl);
  if (!card) throw new Error("找不到这张人物候选的真实图片");
  const instruction = String(feedback || "").trim();
  if (!instruction) throw new Error("请填写人物图修改意见");
  const timestamp = now();
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `修改人物候选 ${cardId}：${instruction}`, timestamp);
  append(sessionId, "收到，我正在基于这张人物候选生成修改版；完成后新图会替换在同一张卡片里。", { ...card, previewUrl: "", status: "generating" });
  db.prepare("UPDATE creative_sessions SET stage='working',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, sessionId);
  regenerate(sessionId, card, instruction);
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
  workspace.confirmedCards ||= [];
  workspace.confirmedCards.push({
    id: `confirmed-reference-group-${Date.now()}`, kind: "reference_panel", title: "已确认人物参考图组",
    summary: `已采用 ${selected.length} 张人物参考图，供后续剧情分镜和视频人物一致性使用。`,
    details: selected.map((card) => ({ label: card.title, content: card.previewUrl })), status: "confirmed", confirmedAt: timestamp,
  });
  workspace.productionPlan = { ...(workspace.productionPlan || {}), referenceStatus: "approved", videoPromptStatus: "storyboard_pending" };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `统一采用人物候选：${selectedIds.join("、")}`, timestamp);
  const autoMessage = `人物参考图组已确认，共采用 ${selected.length} 张真实图片。现在自动生成 3 个视频剧情与分镜候选；必须结合已确认创意、落版图和人物参考槽位，输出 storyboard-A/B/C，不要提交视频生成。`;
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)").run(sessionId, `已采用你勾选的 ${selected.length} 张人物图。我现在自动生成视频剧情与分镜候选，不需要你再发送指令。`, timestamp);
  db.prepare("UPDATE creative_sessions SET stage='working',workspace_json=?,error_message=NULL,updated_at=? WHERE id=?").run(JSON.stringify(workspace), timestamp, sessionId);
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, autoMessage, false));
}

async function regenerate(sessionId, card, feedback) {
  try {
    const sourceUrl = await publicInputUrl(card.previewUrl);
    const referencedAssets = resolveAssetReferences(sessionId, feedback);
    const referencedUrls = [];
    for (const asset of referencedAssets) referencedUrls.push(await publicInputUrl(asset.url));
    const imageUrls = [...new Set([sourceUrl, ...referencedUrls])];
    const client = new NovvyMcpClient(); await client.initialize();
    const assetGuide = referencedAssets.length ? ` Additional reference images named by the user are supplied after the current card image in this order: ${referencedAssets.map((asset) => `${asset.reference} (${asset.title})`).join(", ")}. Use only the attributes the user explicitly assigns to each numbered asset.` : "";
    const prompt = `Edit the first supplied image, which is the current character card, according to this user request: ${feedback}.${assetGuide}\nPreserve the current card person's identity unless the user explicitly assigns identity from a numbered asset. Do not casually blend faces or identities. Produce one clean character-reference image only. Do not add captions, subtitles, labels, logos, watermarks, or extra people.`;
    const created = unpackToolResult(await client.callTool("novvy_create_image_generation", { model: "gpt-image-2", prompt, imageUrls, inputFidelity: "high", n: 1, outputFormat: "png", quality: "high", includeRaw: false }));
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
    append(sessionId, `人物候选 ${card.id} 的 V${version} 已经生成，新图已替换在原卡片中。`, { ...card, previewUrl, version, status: "candidate", details: [...(card.details || []), { label: `V${version} 修改`, content: feedback }, ...(referencedAssets.length ? [{ label: "引用资产", content: referencedAssets.map((asset) => asset.reference).join("、") }] : []), { label: "生成任务", content: taskId || providerSessionId }] });
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
