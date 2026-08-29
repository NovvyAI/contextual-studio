import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { productionProfile } from "./production-profile.js";
import { generatedVideoPath } from "./video-finalizer.js";

const execFileAsync = promisify(execFile);
const qcDir = path.resolve("data/generated/video-qc");

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fsp.readFile(filePath));
  return hash.digest("hex");
}

export async function reviewFinalVideo(finalUrl, shotRows = []) {
  const fileName = path.basename(new URL(finalUrl, "http://localhost").pathname);
  const videoPath = generatedVideoPath(fileName);
  if (!videoPath) throw new Error("最终视频 QC 无法定位成片文件");
  await fsp.access(videoPath);
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath], { maxBuffer: 8 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const audio = (probe.streams || []).find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number.parseFloat(probe.format?.duration || "0");
  const issues = [];
  if (!video) issues.push("缺少视频轨");
  if (!audio) issues.push("缺少音轨");
  if (video && (Number(video.width) !== 720 || Number(video.height) !== 1280)) issues.push(`尺寸不是 720×1280（实际 ${video.width}×${video.height}）`);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) issues.push("无法读取有效时长");
  await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-i", videoPath, "-map", "0:v:0", ...(audio ? ["-map", "0:a:0"] : []), "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
  await fsp.mkdir(qcDir, { recursive: true });
  const stem = path.parse(fileName).name;
  const contactSheetPath = path.join(qcDir, `${stem}-contact.jpg`);
  await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-i", videoPath, "-vf", "fps=0.5,scale=270:-2,tile=6x5", "-frames:v", "1", contactSheetPath], { maxBuffer: 8 * 1024 * 1024 });
  const report = {
    schemaVersion: "contextual.final-video-qc.v1",
    status: issues.length ? "failed" : "passed",
    fileName,
    sha256: await sha256(videoPath),
    durationSeconds: Number(durationSeconds.toFixed(3)),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    videoCodec: String(video?.codec_name || ""),
    pixelFormat: String(video?.pix_fmt || ""),
    audioCodec: String(audio?.codec_name || ""),
    hasAudio: Boolean(audio),
    shotCount: shotRows.length,
    providers: [...new Set(shotRows.map((row) => row.provider).filter(Boolean))],
    profileId: productionProfile.profile_id,
    finalAssemblyMode: productionProfile.final_assembly.mode,
    contactSheetPath,
    issues,
  };
  const reportPath = path.join(qcDir, `${stem}.json`);
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (issues.length) throw new Error(`最终视频技术 QC 未通过：${issues.join("；")}`);
  return { ...report, reportPath };
}
