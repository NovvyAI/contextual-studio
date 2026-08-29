import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { db, now, serializeAnalysis, serializeGameAnalysis, serializeCreativeSession, deleteCreativeAsset } from "./database.js";
import { analyzeDrama } from "./analyzer.js";
import { analyzeGame } from "./game-analyzer.js";
import { runCreativeTurn } from "./creative-agent.js";
import { approveFinalCard, startFinalCardGeneration, startFinalCardRegeneration } from "./image-generator.js";
import { approveCharacterReferences, startCharacterRegeneration, startCustomCharacterGeneration } from "./character-generator.js";
import { startVideoGeneration } from "./video-generator.js";
import { resumeImaRouterVideoGeneration, startImaRouterVideoGeneration } from "./imarouter-video-generator.js";
import { approveStoryboardImages, startStoryboardImageGeneration, startStoryboardImageRegeneration, startStoryboardImageRegenerationByNumber } from "./storyboard-generator.js";
import { approveAndFinalizeVideoShots, approveFinalVideo } from "./video-shot-review.js";
import { generatedVideoPath } from "./video-finalizer.js";
import { landingPackagePath, packageLandingPage } from "./landing-page-packager.js";
import { startAssetCreation, startAssetRegeneration, startAttachmentImageEdit } from "./asset-generator.js";
import { NovvyMcpClient, unpackToolResult } from "./novvy-mcp-client.js";

const port = Number(process.env.PORT || 4180);
const publicDir = path.resolve("public");
const uploadsDir = path.resolve("data/uploads");
const chatUploadsDir = path.resolve("data/chat-uploads");
const maxUploadBytes = 1024 * 1024 * 1024;
let gcloudAuth = { status: "idle", message: "", startedAt: "", completedAt: "" };

function startGcloudLogin() {
  if (gcloudAuth.status === "working") return gcloudAuth;
  gcloudAuth = { status: "working", message: "正在等待 Google 账号验证", startedAt: now(), completedAt: "" };
  const child = spawn("gcloud", ["auth", "login", "--quiet"], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] });
  let detail = "";
  child.stdout.on("data", (chunk) => { detail = `${detail}${chunk}`.slice(-4000); });
  child.stderr.on("data", (chunk) => { detail = `${detail}${chunk}`.slice(-4000); });
  child.once("error", (error) => {
    gcloudAuth = { ...gcloudAuth, status: "failed", message: error.message, completedAt: now() };
  });
  child.once("exit", (code) => {
    if (gcloudAuth.status === "failed") return;
    gcloudAuth = code === 0
      ? { ...gcloudAuth, status: "completed", message: "Google 账号登录成功", completedAt: now() }
      : { ...gcloudAuth, status: "failed", message: detail.match(/ERROR:[^\n]*/)?.[0] || "Google 登录未完成，请重试", completedAt: now() };
  });
  return gcloudAuth;
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxUploadBytes) throw new Error("视频不能超过 1GB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseMultipart(req) {
  const body = await requestBody(req);
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] || "" },
    body,
  });
  return request.formData();
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) return json(res, 404, { error: "文件不存在" });
  res.writeHead(200, { "content-type": contentType, "accept-ranges": "bytes" });
  fs.createReadStream(filePath).pipe(res);
}

function sendDownload(res, filePath, downloadName) {
  if (!fs.existsSync(filePath)) return json(res, 404, { error: "文件不存在" });
  const size = fs.statSync(filePath).size;
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": size,
    "content-disposition": `attachment; filename="${downloadName}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function sendVideoFile(req, res, filePath) {
  if (!fs.existsSync(filePath)) return json(res, 404, { error: "视频不存在" });
  const size = fs.statSync(filePath).size;
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    return fs.createReadStream(filePath).pipe(res);
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { "content-type": "video/mp4", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  return fs.createReadStream(filePath, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/integrations/gcloud/login") {
      return json(res, 202, startGcloudLogin());
    }
    if (req.method === "GET" && url.pathname === "/api/integrations/gcloud/login") {
      return json(res, 200, gcloudAuth);
    }
    if (req.method === "GET" && url.pathname === "/api/dramas") {
      const rows = db.prepare("SELECT * FROM drama_analyses ORDER BY id DESC").all();
      return json(res, 200, { items: rows.map(serializeAnalysis) });
    }

    if (req.method === "GET" && url.pathname === "/api/games") {
      const rows = db.prepare("SELECT * FROM game_analyses ORDER BY id DESC").all();
      return json(res, 200, { items: rows.map(serializeGameAnalysis) });
    }

    if (req.method === "GET" && url.pathname === "/api/novvy/products") {
      const client = new NovvyMcpClient();
      await client.initialize();
      const result = unpackToolResult(await client.callTool("novvy_list_products", {}));
      const candidates = Array.isArray(result) ? result : [result?.products, result?.items, result?.data].find(Array.isArray) || [];
      const products = candidates.map((item, index) => ({
        id: String(item.id || item.productId || `${index + 1}`),
        productName: String(item.productName || item.name || "未命名游戏"),
        description: String(item.description || ""),
        categoryZh: String(item.categoryZh || item.category || "未分类"),
        os: String(item.os || ""),
        iconUrl: String(item.iconUrl || ""),
        landingUrl: String(item.landingUrl || item.storeUrl || ""),
      })).filter((item) => item.landingUrl);
      return json(res, 200, { items: products });
    }

    const generatedVideoMatch = url.pathname.match(/^\/api\/generated\/videos\/([^/]+)$/);
    if (req.method === "GET" && generatedVideoMatch) {
      const filePath = generatedVideoPath(decodeURIComponent(generatedVideoMatch[1]));
      return filePath ? sendVideoFile(req, res, filePath) : json(res, 404, { error: "视频不存在" });
    }

    const landingPackageMatch = url.pathname.match(/^\/api\/generated\/landing-pages\/([^/]+)$/);
    if (req.method === "GET" && landingPackageMatch) {
      const fileName = decodeURIComponent(landingPackageMatch[1]);
      const filePath = landingPackagePath(fileName);
      return filePath ? sendDownload(res, filePath, fileName) : json(res, 404, { error: "落地页包不存在" });
    }

    const chatAttachmentMatch = url.pathname.match(/^\/api\/creative\/chat-attachments\/(\d+)\/([^/]+)$/);
    if (req.method === "GET" && chatAttachmentMatch) {
      const sessionId = Number(chatAttachmentMatch[1]);
      const storedName = path.basename(decodeURIComponent(chatAttachmentMatch[2]));
      const attachment = db.prepare("SELECT attachments_json FROM creative_messages WHERE session_id=? AND attachments_json IS NOT NULL ORDER BY id DESC").all(sessionId)
        .flatMap((row) => { try { return JSON.parse(row.attachments_json || "[]"); } catch { return []; } })
        .find((item) => item.storedName === storedName);
      if (!attachment) return json(res, 404, { error: "附件不存在" });
      return attachment.type.startsWith("video/") ? sendVideoFile(req, res, attachment.storedPath) : sendFile(res, attachment.storedPath, attachment.type);
    }

    if (req.method === "GET" && url.pathname === "/api/creative/sources") {
      const dramas = db.prepare("SELECT id, title, analysis_json, created_at FROM drama_analyses WHERE status = 'completed' ORDER BY id DESC").all();
      const games = db.prepare("SELECT id, title, analysis_json, platform, created_at FROM game_analyses WHERE status = 'completed' ORDER BY id DESC").all();
      return json(res, 200, {
        dramas: dramas.map((item) => ({ id: item.id, title: item.title, summary: item.analysis_json ? JSON.parse(item.analysis_json).oneSentenceThesis : "", createdAt: item.created_at })),
        games: games.map((item) => { const analysis = item.analysis_json ? JSON.parse(item.analysis_json) : {}; return { id: item.id, title: item.title, platform: item.platform, summary: analysis.products?.[0]?.descriptionSummary || analysis.productThesis || "", createdAt: item.created_at }; }),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/creative/sessions") {
      const rows = db.prepare("SELECT * FROM creative_sessions ORDER BY id DESC").all();
      return json(res, 200, { items: rows.map(serializeCreativeSession) });
    }

    if (req.method === "POST" && url.pathname === "/api/creative/sessions") {
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      const dramaId = Number(body.dramaId);
      const gameId = Number(body.gameId);
      const drama = db.prepare("SELECT * FROM drama_analyses WHERE id = ? AND status = 'completed'").get(dramaId);
      const game = db.prepare("SELECT * FROM game_analyses WHERE id = ? AND status = 'completed'").get(gameId);
      if (!drama || !game) return json(res, 400, { error: "请选择已完成分析的短剧和游戏" });
      const timestamp = now();
      const title = `${drama.title} × ${game.title || "游戏创意"}`;
      const inserted = db.prepare("INSERT INTO creative_sessions (drama_id, game_id, title, stage, created_at, updated_at) VALUES (?, ?, ?, 'working', ?, ?)")
        .run(dramaId, gameId, title, timestamp, timestamp);
      const id = Number(inserted.lastInsertRowid);
      db.prepare("INSERT INTO creative_messages (session_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)")
        .run(id, "已连接短剧与游戏分析，正在生成第一组片尾广告创意方向。", timestamp);
      runCreativeTurn(id, "生成首次片尾创意方向", true);
      return json(res, 201, serializeCreativeSession(db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(id)));
    }

    const creativeMessageMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/messages$/);
    if (req.method === "POST" && creativeMessageMatch) {
      const id = Number(creativeMessageMatch[1]);
      const session = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(id);
      if (!session) return json(res, 404, { error: "创意工作台不存在" });
      if (session.stage === "working") return json(res, 409, { error: "Novvy 正在处理上一条消息" });
      const isMultipart = String(req.headers["content-type"] || "").includes("multipart/form-data");
      const body = isMultipart ? await parseMultipart(req) : JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      const content = String(isMultipart ? body.get("content") : body.content || "").trim();
      const files = isMultipart ? body.getAll("attachments").filter((file) => file instanceof File && file.size) : [];
      if (!content && !files.length) return json(res, 400, { error: "请输入消息或添加图片、视频" });
      if (files.length > 6) return json(res, 400, { error: "每条消息最多添加 6 个附件" });
      const attachments = [];
      const sessionUploadDir = path.join(chatUploadsDir, String(id));
      await fsp.mkdir(sessionUploadDir, { recursive: true });
      for (const file of files) {
        const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
        const isVideo = file.type.startsWith("video/");
        if (!isImage && !isVideo) return json(res, 400, { error: `不支持附件格式：${file.name}` });
        if (isImage && file.size > 20 * 1024 * 1024) return json(res, 400, { error: `图片不能超过 20MB：${file.name}` });
        if (isVideo && file.size > 500 * 1024 * 1024) return json(res, 400, { error: `视频不能超过 500MB：${file.name}` });
        const extension = path.extname(file.name).toLowerCase() || (isImage ? ".jpg" : ".mp4");
        const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
        const storedPath = path.join(sessionUploadDir, storedName);
        await fsp.writeFile(storedPath, Buffer.from(await file.arrayBuffer()));
        attachments.push({ name: file.name, type: file.type, size: file.size, storedName, storedPath, url: `/api/creative/chat-attachments/${id}/${encodeURIComponent(storedName)}` });
      }
      const userMessage = content || "请查看并分析我上传的附件。";
      const attachmentImageEdit = attachments.some((item) => item.type.startsWith("image/"))
        && /修改|调整|编辑|重绘|重新生成|改成|换成|替换|去掉|去除|移除|删除|增加|添加|变成|变为|希望|不要/i.test(content);
      if (attachmentImageEdit) {
        startAttachmentImageEdit(id, attachments, userMessage);
        return json(res, 202, { id, status: "working", action: "attachment_image_edit", attachmentCount: attachments.length });
      }
      const conceptRevisionMatch = content.match(/(?:修改聊天候选卡\s*concept-|只(?:修改|重新生成)方案\s*)([A-D])\b/i);
      const finalCardRevisionMatch = content.match(/修改聊天候选卡\s*(final-card-[^\s（]+)/i);
      const storyboardTarget = content.match(/分镜(?:图|镜头)?\s*0*(\d+)/i);
      const storyboardEditIntent = /修改|调整|重绘|重新生成|改成|换成|替换|去掉|去除|移除|删除|增加|添加|希望|需要|不要|不一样|不同/i.test(content);
      if (!attachments.length && storyboardTarget && storyboardEditIntent) {
        startStoryboardImageRegenerationByNumber(id, Number(storyboardTarget[1]), content);
        return json(res, 202, { id, status: "working", action: "storyboard_image_regeneration", shotNumber: Number(storyboardTarget[1]) });
      }
      const characterImageRequest = /(?:生成|创建|做|画|制作).{0,18}(?:人物|男主|女主|男人|女人|正脸|侧脸|正面|侧面)|(?:基于|使用|参考).{0,18}(?:图片|截图).{0,30}(?:生成|创建|做|画)|(?:修改|调整|放大|缩小|聚焦|裁切|裁剪|去掉|去除|移除|删除|替换|换成|改成).{0,24}(?:图片|截图|人物|男主|女主|正脸|侧脸)|(?:图片|截图)\s*0*\d+.{0,24}(?:修改|调整|放大|缩小|聚焦|裁切|裁剪|去掉|去除|移除|删除|替换|换成|改成)/i.test(content);
      if (!attachments.length && !conceptRevisionMatch && !finalCardRevisionMatch && characterImageRequest && /(?:图片|截图)\s*0*\d+|(?:人物|男主|女主|男人|女人|正脸|侧脸|正面|侧面)/i.test(content)) {
        startCustomCharacterGeneration(id, content);
        return json(res, 202, { id, status: "working", action: "character_image_generation" });
      }
      const timestamp = now();
      db.prepare("INSERT INTO creative_messages (session_id, role, content, attachments_json, created_at) VALUES (?, 'user', ?, ?, ?)").run(id, userMessage, attachments.length ? JSON.stringify(attachments) : null, timestamp);
      db.prepare("UPDATE creative_sessions SET stage = 'working', updated_at = ? WHERE id = ?").run(timestamp, id);
      runCreativeTurn(id, userMessage, false, attachments, {
        ...(conceptRevisionMatch ? { conceptRevisionId: conceptRevisionMatch[1].toUpperCase() } : {}),
        ...(finalCardRevisionMatch ? { finalCardRevisionId: finalCardRevisionMatch[1] } : {}),
      });
      return json(res, 202, { id, status: "working", attachmentCount: attachments.length });
    }

    const creativeCardGenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/generate$/);
    if (req.method === "POST" && creativeCardGenerateMatch) {
      const id = Number(creativeCardGenerateMatch[1]);
      const cardId = decodeURIComponent(creativeCardGenerateMatch[2]);
      startFinalCardGeneration(id, cardId);
      return json(res, 202, { id, cardId, status: "working" });
    }

    const creativeCardApproveMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/approve$/);
    if (req.method === "POST" && creativeCardApproveMatch) {
      const id = Number(creativeCardApproveMatch[1]);
      const cardId = decodeURIComponent(creativeCardApproveMatch[2]);
      approveFinalCard(id, cardId);
      const row = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(id);
      return json(res, 200, serializeCreativeSession(row));
    }

    const finalCardRegenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/regenerate-final-card$/);
    if (req.method === "POST" && finalCardRegenerateMatch) {
      const id = Number(finalCardRegenerateMatch[1]);
      const cardId = decodeURIComponent(finalCardRegenerateMatch[2]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      startFinalCardRegeneration(id, cardId, body.feedback);
      return json(res, 202, { id, cardId, status: "working", action: "final_card_regeneration" });
    }

    const characterRegenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/regenerate-image$/);
    if (req.method === "POST" && characterRegenerateMatch) {
      const id = Number(characterRegenerateMatch[1]);
      const cardId = decodeURIComponent(characterRegenerateMatch[2]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      startCharacterRegeneration(id, cardId, body.feedback);
      return json(res, 202, { id, cardId, status: "working" });
    }

    const characterApproveMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/characters\/approve$/);
    if (req.method === "POST" && characterApproveMatch) {
      const id = Number(characterApproveMatch[1]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      approveCharacterReferences(id, body.cardIds);
      return json(res, 202, { id, status: "working" });
    }

    const characterCreateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/characters\/generate$/);
    if (req.method === "POST" && characterCreateMatch) {
      const id = Number(characterCreateMatch[1]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      startCustomCharacterGeneration(id, body.description, body.replaceCardId);
      return json(res, 202, { id, status: "working" });
    }

    const videoGenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/generate-video$/);
    if (req.method === "POST" && videoGenerateMatch) {
      const id = Number(videoGenerateMatch[1]);
      const cardId = decodeURIComponent(videoGenerateMatch[2]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      const provider = body.provider === "imarouter" ? "imarouter" : "novvy";
      if (provider === "imarouter") startImaRouterVideoGeneration(id, cardId);
      else startVideoGeneration(id, cardId);
      return json(res, 202, { id, cardId, provider, status: "working" });
    }

    const videoShotsApproveMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/approve-video-shots$/);
    if (req.method === "POST" && videoShotsApproveMatch) {
      const id = Number(videoShotsApproveMatch[1]);
      const cardId = decodeURIComponent(videoShotsApproveMatch[2]);
      const finalUrl = await approveAndFinalizeVideoShots(id, cardId);
      return json(res, 200, { id, cardId, finalUrl, status: "completed" });
    }

    const finalVideoApproveMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/approve-final-video$/);
    if (req.method === "POST" && finalVideoApproveMatch) {
      const id = Number(finalVideoApproveMatch[1]);
      const cardId = decodeURIComponent(finalVideoApproveMatch[2]);
      approveFinalVideo(id, cardId);
      return json(res, 200, serializeCreativeSession(db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(id)));
    }

    const landingPackageCreateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/package-landing-page$/);
    if (req.method === "POST" && landingPackageCreateMatch) {
      const id = Number(landingPackageCreateMatch[1]);
      const cardId = decodeURIComponent(landingPackageCreateMatch[2]);
      return json(res, 201, await packageLandingPage(id, cardId));
    }

    const storyboardGenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/generate-storyboard-images$/);
    if (req.method === "POST" && storyboardGenerateMatch) {
      const id = Number(storyboardGenerateMatch[1]);
      const cardId = decodeURIComponent(storyboardGenerateMatch[2]);
      startStoryboardImageGeneration(id, cardId);
      return json(res, 202, { id, cardId, status: "working" });
    }

    const storyboardRegenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/cards\/([^/]+)\/regenerate-storyboard-image$/);
    if (req.method === "POST" && storyboardRegenerateMatch) {
      const id = Number(storyboardRegenerateMatch[1]);
      const cardId = decodeURIComponent(storyboardRegenerateMatch[2]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      startStoryboardImageRegeneration(id, cardId, body.feedback);
      return json(res, 202, { id, cardId, status: "working" });
    }

    const storyboardApproveMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/storyboards\/approve$/);
    if (req.method === "POST" && storyboardApproveMatch) {
      const id = Number(storyboardApproveMatch[1]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      approveStoryboardImages(id, body.cardIds);
      return json(res, 202, { id, status: "working" });
    }

    const assetRegenerateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/assets\/(\d+)\/regenerate$/);
    if (req.method === "POST" && assetRegenerateMatch) {
      const id = Number(assetRegenerateMatch[1]);
      const assetNumber = Number(assetRegenerateMatch[2]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      startAssetRegeneration(id, assetNumber, body.feedback);
      return json(res, 202, { id, assetNumber, status: "working" });
    }

    const assetCreateMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/assets\/generate$/);
    if (req.method === "POST" && assetCreateMatch) {
      const id = Number(assetCreateMatch[1]);
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      startAssetCreation(id, body.description);
      return json(res, 202, { id, status: "working" });
    }

    const assetDeleteMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)\/assets\/(\d+)$/);
    if (req.method === "DELETE" && assetDeleteMatch) {
      const id = Number(assetDeleteMatch[1]);
      const assetNumber = Number(assetDeleteMatch[2]);
      const session = db.prepare("SELECT id FROM creative_sessions WHERE id=?").get(id);
      if (!session) return json(res, 404, { error: "工作台不存在" });
      const deleted = deleteCreativeAsset(id, assetNumber);
      if (!deleted) return json(res, 404, { error: `找不到图片 ${String(assetNumber).padStart(2, "0")}` });
      return json(res, 200, { id, assetNumber, deleted: true });
    }

    const creativeDetailMatch = url.pathname.match(/^\/api\/creative\/sessions\/(\d+)$/);
    if (req.method === "GET" && creativeDetailMatch) {
      const row = db.prepare("SELECT * FROM creative_sessions WHERE id = ?").get(Number(creativeDetailMatch[1]));
      return row ? json(res, 200, serializeCreativeSession(row)) : json(res, 404, { error: "工作台不存在" });
    }

    if (req.method === "POST" && url.pathname === "/api/games") {
      const body = JSON.parse((await requestBody(req)).toString("utf8") || "{}");
      const storeUrl = String(body.storeUrl || "").trim();
      const title = String(body.title || "").trim();
      const product = body.product && typeof body.product === "object" ? body.product : null;
      let parsed;
      try { parsed = new URL(storeUrl); } catch { return json(res, 400, { error: "请输入有效的商店地址" }); }
      const isGoogle = parsed.hostname === "play.google.com" && parsed.pathname.startsWith("/store/apps/details");
      const isApple = parsed.hostname === "apps.apple.com" && /\/app\//.test(parsed.pathname);
      if (!isGoogle && !isApple) return json(res, 400, { error: "目前只支持 Google Play 或 Apple App Store 地址" });
      const existing = db.prepare("SELECT * FROM game_analyses WHERE store_url=? AND status IN ('uploaded','analyzing','completed') ORDER BY id DESC LIMIT 1").get(storeUrl);
      if (existing) return json(res, 200, { ...serializeGameAnalysis(existing), reused: true });
      const platform = isGoogle ? "google_play" : "apple_app_store";
      const timestamp = now();
      const source = product || { productName: title, description: "", category: "", categoryZh: "", os: isGoogle ? "Android" : "iOS", landingUrl: storeUrl };
      const result = db.prepare("INSERT INTO game_analyses (title, store_url, platform, source_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'uploaded', ?, ?)")
        .run(title, storeUrl, platform, JSON.stringify(source), timestamp, timestamp);
      const row = db.prepare("SELECT * FROM game_analyses WHERE id = ?").get(Number(result.lastInsertRowid));
      return json(res, 201, serializeGameAnalysis(row));
    }

    const gameAnalyzeMatch = url.pathname.match(/^\/api\/games\/(\d+)\/analyze$/);
    if (req.method === "POST" && gameAnalyzeMatch) {
      const id = Number(gameAnalyzeMatch[1]);
      const row = db.prepare("SELECT * FROM game_analyses WHERE id = ?").get(id);
      if (!row) return json(res, 404, { error: "游戏分析记录不存在" });
      if (row.status === "analyzing") return json(res, 409, { error: "正在分析中" });
      analyzeGame(id);
      return json(res, 202, { id, status: "analyzing" });
    }

    const gameDetailMatch = url.pathname.match(/^\/api\/games\/(\d+)$/);
    if (req.method === "GET" && gameDetailMatch) {
      const row = db.prepare("SELECT * FROM game_analyses WHERE id = ?").get(Number(gameDetailMatch[1]));
      return row ? json(res, 200, serializeGameAnalysis(row)) : json(res, 404, { error: "记录不存在" });
    }

    if (req.method === "POST" && url.pathname === "/api/dramas") {
      const form = await parseMultipart(req);
      const file = form.get("video");
      const titleValue = String(form.get("title") || "").trim();
      if (!(file instanceof File) || !file.size) return json(res, 400, { error: "请选择短剧视频" });
      if (!file.type.startsWith("video/")) return json(res, 400, { error: "只支持视频文件" });
      const extension = path.extname(file.name).toLowerCase() || ".mp4";
      const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
      const storedPath = path.join(uploadsDir, storedName);
      await fsp.writeFile(storedPath, Buffer.from(await file.arrayBuffer()));
      const timestamp = now();
      const result = db.prepare(`
        INSERT INTO drama_analyses
        (title, original_name, video_path, mime_type, file_size, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?)
      `).run(titleValue || path.parse(file.name).name, file.name, storedPath, file.type, file.size, timestamp, timestamp);
      const row = db.prepare("SELECT * FROM drama_analyses WHERE id = ?").get(Number(result.lastInsertRowid));
      return json(res, 201, serializeAnalysis(row));
    }

    const analyzeMatch = url.pathname.match(/^\/api\/dramas\/(\d+)\/analyze$/);
    if (req.method === "POST" && analyzeMatch) {
      const id = Number(analyzeMatch[1]);
      const row = db.prepare("SELECT * FROM drama_analyses WHERE id = ?").get(id);
      if (!row) return json(res, 404, { error: "分析记录不存在" });
      if (row.status === "analyzing") return json(res, 409, { error: "正在分析中" });
      analyzeDrama(id);
      return json(res, 202, { id, status: "analyzing" });
    }

    const detailMatch = url.pathname.match(/^\/api\/dramas\/(\d+)$/);
    if (req.method === "GET" && detailMatch) {
      const row = db.prepare("SELECT * FROM drama_analyses WHERE id = ?").get(Number(detailMatch[1]));
      return row ? json(res, 200, serializeAnalysis(row)) : json(res, 404, { error: "记录不存在" });
    }

    const videoMatch = url.pathname.match(/^\/api\/dramas\/(\d+)\/video$/);
    if (req.method === "GET" && videoMatch) {
      const row = db.prepare("SELECT video_path, mime_type FROM drama_analyses WHERE id = ?").get(Number(videoMatch[1]));
      return row ? sendFile(res, row.video_path, row.mime_type || "video/mp4") : json(res, 404, { error: "视频不存在" });
    }

    const screenshotMatch = url.pathname.match(/^\/api\/screenshots\/(\d+)$/);
    if (req.method === "GET" && screenshotMatch) {
      const row = db.prepare("SELECT image_blob, mime_type FROM drama_screenshots WHERE id = ?").get(Number(screenshotMatch[1]));
      if (!row) return json(res, 404, { error: "截图不存在" });
      res.writeHead(200, { "content-type": row.mime_type, "cache-control": "public, max-age=31536000, immutable" });
      return res.end(row.image_blob);
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(publicDir, relativePath);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) return json(res, 404, { error: "Not found" });
    const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    return sendFile(res, filePath, contentTypes[path.extname(filePath)] || "application/octet-stream");
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

function recoverInterruptedCreativeTurns() {
  const interrupted = db.prepare("SELECT * FROM creative_sessions WHERE stage='working'").all();
  for (const session of interrupted) {
    const interruptedVideo = db.prepare("SELECT prompt_card_id FROM creative_video_shots WHERE session_id=? AND provider='imarouter' AND status='generating' AND task_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(session.id);
    if (interruptedVideo) {
      const timestamp = now();
      db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
        .run(session.id, "检测到 ImaRouter 视频轮询中断，正在从已保存的任务 ID 恢复；不会重新提交已创建的镜头。", timestamp);
      setImmediate(() => resumeImaRouterVideoGeneration(session.id, interruptedVideo.prompt_card_id));
      continue;
    }
    const latestCardRow = db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC LIMIT 1").get(session.id);
    let latestCards = [];
    try { latestCards = JSON.parse(latestCardRow?.cards_json || "[]"); } catch { latestCards = []; }
    const interruptedAsset = latestCards.find((card) => card.kind === "reference_image" && card.status === "generating" && /^asset-custom-/.test(card.id));
    if (interruptedAsset) {
      const timestamp = now();
      const detail = (interruptedAsset.details || []).find((item) => item.label === "生成要求")?.content || interruptedAsset.summary;
      db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, session.id);
      db.prepare("INSERT INTO creative_messages (session_id,role,content,visibility,created_at) VALUES (?,'assistant',?,'asset',?)")
        .run(session.id, "检测到服务器重启中断了资产图片生成，正在自动恢复同一张图片请求。", timestamp);
      setImmediate(() => startAssetCreation(session.id, detail, interruptedAsset));
      continue;
    }
    const interruptedCharacter = latestCards.find((card) => card.kind === "character_image" && card.status === "generating");
    if (interruptedCharacter) {
      const timestamp = now();
      const detail = (interruptedCharacter.details || []).find((item) => item.label === "生成要求")?.content
        || [...(interruptedCharacter.details || [])].reverse().find((item) => /修改/.test(item.label))?.content
        || interruptedCharacter.summary;
      db.prepare("UPDATE creative_sessions SET stage='reference_review',error_message=NULL,updated_at=? WHERE id=?").run(timestamp, session.id);
      db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
        .run(session.id, "检测到服务器重启中断了人物图片生成，正在自动恢复同一张候选卡，不需要重新发送修改意见。", timestamp);
      setImmediate(() => {
        if (/^reference-custom-/.test(interruptedCharacter.id)) startCustomCharacterGeneration(session.id, detail, interruptedCharacter.id);
        else startCharacterRegeneration(session.id, interruptedCharacter.id, detail);
      });
      continue;
    }
    let workspace = {};
    try { workspace = JSON.parse(session.workspace_json || "{}"); } catch { workspace = {}; }
    if (workspace.productionPlan?.videoPromptStatus !== "storyboard_pending") continue;
    const hasStoryboard = db.prepare("SELECT 1 FROM creative_messages WHERE session_id=? AND cards_json LIKE '%\"kind\":\"storyboard\"%' LIMIT 1").get(session.id);
    if (hasStoryboard) continue;
    const timestamp = now();
    db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
      .run(session.id, "检测到服务器重启中断了分镜生成，现已自动恢复，不需要重新确认人物参考图。", timestamp);
    setImmediate(() => runCreativeTurn(session.id, "恢复已确认人物参考图之后被服务器重启中断的流程。请立即生成 3 个完整的视频剧情与分镜候选 storyboard-A/B/C；保留全部已确认成果，不要再次要求确认人物图，也不要提交图片或视频生成。", false));
  }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Contextual Studio: http://127.0.0.1:${port}`);
  recoverInterruptedCreativeTurns();
});
