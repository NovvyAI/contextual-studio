import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, now } from "./database.js";
import { generatedVideoPath } from "./video-finalizer.js";

const execFileAsync = promisify(execFile);
const outputRoot = path.resolve("data/generated/landing-pages");
const maxVideoBytes = 5 * 1024 * 1024;

const analyticsSource = `(() => {
  const events = [];
  function emit(name, params = {}) {
    const event = { name, params, timestamp: new Date().toISOString() };
    events.push(event);
    window.dispatchEvent(new CustomEvent("novvy:analytics", { detail: event }));
    if (Array.isArray(window.dataLayer)) window.dataLayer.push({ event: name, ...params });
  }
  window.NovvyAnalytics = {
    events,
    track: emit,
    click(name, action, params = {}) { emit(name, { action, ...params }); },
    registerMedia(video, options = {}) {
      for (const type of ["play", "pause", "ended", "error"]) video.addEventListener(type, () => emit("media_" + type, options));
    },
  };
})();\n`;

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function validStoreUrl(value) {
  const url = new URL(String(value || ""));
  const google = url.protocol === "https:" && url.hostname === "play.google.com" && url.searchParams.get("id");
  const apple = url.protocol === "https:" && ["apps.apple.com", "itunes.apple.com"].includes(url.hostname) && /\/id\d+/.test(url.pathname);
  if (!google && !apple) throw new Error("当前游戏缺少有效的 Google Play 或 Apple App Store 地址");
  return url.href;
}

async function durationSeconds(source) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source]);
  const duration = Number(stdout.trim());
  if (!(duration > 0)) throw new Error("无法读取最终成片时长");
  return duration;
}

async function landingVideo(source, destination) {
  if ((await fsp.stat(source)).size <= maxVideoBytes) {
    await fsp.copyFile(source, destination);
    return;
  }
  const duration = await durationSeconds(source);
  for (const targetBytes of [4_800_000, 4_450_000, 4_100_000]) {
    const audioBitrate = 80_000;
    const videoBitrate = Math.max(180_000, Math.floor((targetBytes * 8 / duration) - audioBitrate));
    const passLog = path.join(os.tmpdir(), `contextual-landing-${process.pid}-${Date.now()}`);
    const common = ["-y", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", String(videoBitrate), "-maxrate", String(Math.floor(videoBitrate * 1.15)), "-bufsize", String(videoBitrate * 2), "-movflags", "+faststart", "-c:a", "aac", "-b:a", String(audioBitrate), "-ac", "2", "-passlogfile", passLog];
    try {
      await execFileAsync("ffmpeg", [...common, "-pass", "1", "-an", "-f", "mp4", "/dev/null"], { maxBuffer: 8 * 1024 * 1024 });
      await execFileAsync("ffmpeg", [...common, "-pass", "2", destination], { maxBuffer: 8 * 1024 * 1024 });
    } finally {
      await Promise.all(["-0.log", "-0.log.mbtree"].map((suffix) => fsp.rm(`${passLog}${suffix}`, { force: true })));
    }
    if ((await fsp.stat(destination)).size <= maxVideoBytes) return;
  }
  throw new Error("最终成片压缩后仍超过 5 MB，无法生成标准落地页包");
}

function pageHtml({ appName, destination, hasIcon }) {
  const name = escapeHtml(appName);
  const icon = hasIcon ? '<img src="app-icon.png" alt="">' : escapeHtml(appName.slice(0, 1).toUpperCase());
  return `<!doctype html><html lang="en"><head><script src="analytics.js"></script><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${name}</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#070b12;display:grid;place-items:center;overflow:hidden;font-family:Arial,sans-serif}main{position:relative;width:min(100vw,56.25vh);height:min(177.78vw,100vh);background:#000;overflow:hidden}video{display:block;width:100%;height:100%;object-fit:cover}.sound{position:absolute;top:max(14px,env(safe-area-inset-top));left:14px;z-index:2;width:42px;height:42px;border:1px solid #ffffff55;border-radius:50%;background:#070b12bb;color:#fff;font-size:19px}.end{position:absolute;inset:0;display:grid;place-items:end center;padding:24px 14px max(24px,env(safe-area-inset-bottom));opacity:0;pointer-events:none;background:linear-gradient(transparent 52%,#040911cc);transition:.3s}.end.visible{opacity:1;pointer-events:auto}.card{width:min(100%,410px);display:grid;grid-template-columns:60px minmax(0,1fr) auto;align-items:center;gap:11px;padding:12px;border:1px solid #ffffff30;border-radius:9px;background:#121d2af5;box-shadow:0 12px 34px #0008}.icon{width:60px;height:60px;display:grid;place-items:center;overflow:hidden;border-radius:11px;background:#1a73c9;color:#fff;font-size:25px;font-weight:800}.icon img{width:100%;height:100%;object-fit:cover}.copy{min-width:0;color:#fff}.copy b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy small{display:block;margin-top:5px;color:#d4dce5}.cta{min-height:42px;padding:0 12px;border:0;border-radius:6px;background:#18a957;color:#fff;font-weight:700}
</style></head><body><main><video id="video" src="tail-ad-video.mp4" playsinline preload="auto"></video><button id="sound" class="sound" type="button" aria-label="Mute">🔊</button><div id="end" class="end"><section class="card"><div class="icon">${icon}</div><div class="copy"><b>${name}</b><small>★★★★★ 4.8<br>Start your next challenge today</small></div><button id="cta" class="cta" type="button">Download</button></section></div></main><script>
const video=document.querySelector('#video'),end=document.querySelector('#end'),sound=document.querySelector('#sound'),destination=${JSON.stringify(destination)};let shown=false;function track(n,p){window.NovvyAnalytics&&window.NovvyAnalytics.track(n,p)}function show(reason){if(shown)return;shown=true;end.classList.add('visible');track('end_card_shown',{trigger:reason})}function play(){return video.play().catch(()=>{video.muted=true;sound.textContent='🔇';track('autoplay_muted_fallback');return video.play()}).catch(()=>show('playback_blocked'))}video.muted=false;sound.addEventListener('click',()=>{video.muted=!video.muted;sound.textContent=video.muted?'🔇':'🔊';window.NovvyAnalytics&&window.NovvyAnalytics.click('sound_button',video.muted?'mute':'unmute')});video.addEventListener('timeupdate',()=>{if(video.currentTime>=3)show('video_progress')});video.addEventListener('ended',()=>show('video_complete'));video.addEventListener('error',()=>show('video_error'));window.NovvyAnalytics&&window.NovvyAnalytics.registerMedia(video,{name:'tail_ad_video'});document.querySelector('#cta').addEventListener('click',()=>{window.NovvyAnalytics&&window.NovvyAnalytics.click('primary_cta','open_destination',{scene:'end_card'});if(window.novvy&&typeof window.novvy.open==='function')window.novvy.open();else location.assign(destination)});if(window.__novvyBridgeVersion>=1){if(window.__novvyViewable)play();window.addEventListener('novvy:viewablechange',e=>e.detail&&e.detail.viewable?play():video.pause())}else play();
</script></body></html>`;
}

async function downloadIcon(url, destination) {
  if (!/^https:\/\//.test(String(url || ""))) return false;
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return false;
    await fsp.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return true;
  } catch { return false; }
}

export async function packageLandingPage(sessionId, promptCardId) {
  const session = db.prepare("SELECT s.*,g.title game_title,g.store_url,g.source_json,g.analysis_json FROM creative_sessions s JOIN game_analyses g ON g.id=s.game_id WHERE s.id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const cards = db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC").all(sessionId).flatMap((row) => { try { return JSON.parse(row.cards_json || "[]"); } catch { return []; } });
  const card = cards.find((item) => item.id === promptCardId && item.kind === "video_prompt" && item.status === "confirmed" && item.previewUrl);
  if (!card) throw new Error("请先确认最终成片，再执行一键打包");
  const match = String(card.previewUrl).match(/^\/api\/generated\/videos\/([^/]+)$/);
  const sourceVideo = match ? generatedVideoPath(decodeURIComponent(match[1])) : "";
  if (!sourceVideo) throw new Error("最终成片不是可打包的本地文件");
  const destination = validStoreUrl(session.store_url);
  let source = {}; let analysis = {};
  try { source = JSON.parse(session.source_json || "{}"); } catch { /* ignore */ }
  try { analysis = JSON.parse(session.analysis_json || "{}"); } catch { /* ignore */ }
  const product = analysis.products?.[0] || {};
  const appName = String(source.productName || product.productName || session.game_title || "Game");
  const iconUrl = String(source.iconUrl || product.iconUrl || "");
  const packageName = `creative-${sessionId}-${Date.now()}`;
  const packageDir = path.join(outputRoot, packageName);
  const zipPath = path.join(outputRoot, `${packageName}.zip`);
  await fsp.mkdir(packageDir, { recursive: true });
  try {
    const hasIcon = await downloadIcon(iconUrl, path.join(packageDir, "app-icon.png"));
    await Promise.all([
      fsp.writeFile(path.join(packageDir, "analytics.js"), analyticsSource),
      fsp.writeFile(path.join(packageDir, "index.html"), pageHtml({ appName, destination, hasIcon })),
      landingVideo(sourceVideo, path.join(packageDir, "tail-ad-video.mp4")),
    ]);
    await execFileAsync("zip", ["-q", "-r", zipPath, "."], { cwd: packageDir });
    const timestamp = now();
    db.prepare("INSERT INTO creative_landing_packages(session_id,prompt_card_id,file_name,store_url,app_name,created_at) VALUES(?,?,?,?,?,?)").run(sessionId, promptCardId, path.basename(zipPath), destination, appName, timestamp);
    return { fileName: path.basename(zipPath), downloadUrl: `/api/generated/landing-pages/${encodeURIComponent(path.basename(zipPath))}`, appName, storeUrl: destination, createdAt: timestamp };
  } catch (error) {
    await Promise.all([fsp.rm(packageDir, { recursive: true, force: true }), fsp.rm(zipPath, { force: true })]);
    throw error;
  }
}

export function landingPackagePath(fileName) {
  if (!/^creative-\d+-\d+\.zip$/.test(fileName)) return "";
  return path.join(outputRoot, fileName);
}
