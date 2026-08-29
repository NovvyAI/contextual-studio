import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "./database.js";
import { productionProfile } from "./production-profile.js";

const execFileAsync = promisify(execFile);
const outputDir = path.resolve("data/generated/videos");

function finalCardSource(session) {
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const card = [...(workspace.confirmedCards || [])].reverse().find((item) => item.kind === "final_card" && item.status === "confirmed");
  return [card?.previewUrl, ...(card?.details || []).map((item) => item.content)]
    .find((value) => typeof value === "string" && (/^https?:\/\//.test(value) || /^\/api\/screenshots\/\d+$/.test(value))) || "";
}

async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`下载生成素材失败：HTTP ${response.status}`);
  await fsp.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function writeSource(source, target) {
  if (/^https?:\/\//.test(source)) return download(source, target);
  const match = source.match(/^\/api\/screenshots\/(\d+)$/);
  if (!match) throw new Error("已确认落版图地址不可读取");
  const row = db.prepare("SELECT image_blob FROM drama_screenshots WHERE id=?").get(Number(match[1]));
  if (!row) throw new Error("已确认落版图不存在");
  await fsp.writeFile(target, row.image_blob);
}

async function hasAudio(inputPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", inputPath]);
    return Boolean(stdout.trim());
  } catch { return false; }
}

async function mediaDuration(inputPath) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`无法读取镜头时长：${path.basename(inputPath)}`);
  return value;
}

async function crossfadeShots(inputs, outputPath, transitionSeconds = productionProfile.final_assembly.transition_seconds) {
  if (inputs.length === 1) {
    await fsp.copyFile(inputs[0], outputPath);
    return;
  }
  const durations = await Promise.all(inputs.map(mediaDuration));
  const filters = [];
  let elapsed = durations[0];
  let videoLabel = "0:v";
  let audioLabel = "0:a";
  for (let index = 1; index < inputs.length; index += 1) {
    const offset = Math.max(0, elapsed - transitionSeconds).toFixed(3);
    const nextVideo = `vx${index}`;
    const nextAudio = `ax${index}`;
    filters.push(`[${videoLabel}][${index}:v]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset}[${nextVideo}]`);
    filters.push(`[${audioLabel}][${index}:a]acrossfade=d=${transitionSeconds}:c1=tri:c2=tri[${nextAudio}]`);
    videoLabel = nextVideo;
    audioLabel = nextAudio;
    elapsed += durations[index] - transitionSeconds;
  }
  const args = ["-y"];
  inputs.forEach((input) => args.push("-i", input));
  args.push("-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-map", `[${audioLabel}]`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath);
  await execFileAsync("ffmpeg", args, { maxBuffer: 8 * 1024 * 1024 });
}

export async function finalizeVideoWithApprovedCard(sessionId, remoteVideoUrl) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const finalCard = finalCardSource(session);
  if (!finalCard) throw new Error("没有找到已确认的原始落版图");
  await fsp.mkdir(outputDir, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-video-finalize-"));
  const inputVideo = path.join(tempDir, "generated.mp4");
  const inputCard = path.join(tempDir, "final-card.png");
  const fileName = `creative-${sessionId}-${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, fileName);
  try {
    await Promise.all([download(remoteVideoUrl, inputVideo), writeSource(finalCard, inputCard)]);
    const audio = await hasAudio(inputVideo);
    const contentDuration = productionProfile.max_shot_duration_seconds - productionProfile.final_assembly.final_card_duration_seconds;
    const cardDuration = productionProfile.final_assembly.final_card_duration_seconds;
    const videoFilters = `[0:v]trim=duration=${contentDuration},setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v0];[1:v]trim=duration=${cardDuration},setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v1];[v0][v1]concat=n=2:v=1:a=0[v]`;
    const filter = audio
      ? `${videoFilters};[0:a]atrim=duration=${contentDuration},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a0];anullsrc=r=48000:cl=stereo,atrim=duration=${cardDuration}[a1];[a0][a1]concat=n=2:v=0:a=1[a]`
      : videoFilters;
    const args = ["-y", "-i", inputVideo, "-loop", "1", "-t", String(cardDuration), "-i", inputCard, "-filter_complex", filter, "-map", "[v]"];
    if (audio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k"); else args.push("-an");
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", String(contentDuration + cardDuration), outputPath);
    await execFileAsync("ffmpeg", args, { maxBuffer: 8 * 1024 * 1024 });
    return `/api/generated/videos/${fileName}`;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export async function finalizeStoryboardVideosWithApprovedCard(sessionId, shotVideoUrls) {
  if (!Array.isArray(shotVideoUrls) || !shotVideoUrls.length) throw new Error("没有可拼接的已生成镜头");
  if (shotVideoUrls.length > productionProfile.max_shots_per_final) throw new Error(`当前生产 Profile 最多允许 ${productionProfile.max_shots_per_final} 个镜头`);
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  const finalCard = finalCardSource(session);
  if (!finalCard) throw new Error("没有找到已确认的原始落版图");
  await fsp.mkdir(outputDir, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-storyboard-finalize-"));
  const outputName = `creative-${sessionId}-${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, outputName);
  try {
    const normalized = [];
    for (let index = 0; index < shotVideoUrls.length; index += 1) {
      const source = path.join(tempDir, `shot-${index + 1}.mp4`);
      const target = path.join(tempDir, `normalized-${index + 1}.mp4`);
      await download(shotVideoUrls[index], source);
      const audio = await hasAudio(source);
      const args = ["-y", "-i", source];
      if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      args.push("-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0", "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", target);
      await execFileAsync("ffmpeg", args, { maxBuffer: 8 * 1024 * 1024 });
      normalized.push(target);
    }
    const joined = path.join(tempDir, "joined.mp4");
    await crossfadeShots(normalized, joined);
    const cardPath = path.join(tempDir, "final-card.png");
    await writeSource(finalCard, cardPath);
    const cardDuration = productionProfile.final_assembly.final_card_duration_seconds;
    const filter = `[0:v]setpts=PTS-STARTPTS[v0];[1:v]trim=duration=${cardDuration},setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v1];[v0][v1]concat=n=2:v=1:a=0[v];[0:a]asetpts=PTS-STARTPTS[a0];anullsrc=r=48000:cl=stereo,atrim=duration=${cardDuration}[a1];[a0][a1]concat=n=2:v=0:a=1[a]`;
    await execFileAsync("ffmpeg", ["-y", "-i", joined, "-loop", "1", "-t", String(cardDuration), "-i", cardPath, "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath], { maxBuffer: 8 * 1024 * 1024 });
    return `/api/generated/videos/${outputName}`;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export function generatedVideoPath(fileName) {
  if (!/^creative-\d+-\d+\.mp4$/.test(fileName)) return "";
  return path.join(outputDir, fileName);
}
