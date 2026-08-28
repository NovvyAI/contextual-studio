import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function videoDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
  const duration = Number.parseFloat(stdout);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

async function videoFrames(attachment) {
  const duration = await videoDuration(attachment.storedPath);
  const frameDir = `${attachment.storedPath}.frames`;
  await fsp.mkdir(frameDir, { recursive: true });
  const count = duration > 0 ? 6 : 1;
  const timestamps = Array.from({ length: count }, (_, index) => duration > 0 ? Math.max(0, duration * ((index + 0.5) / count)) : 0);
  const frames = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const framePath = path.join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    await execFileAsync("ffmpeg", ["-y", "-ss", timestamps[index].toFixed(3), "-i", attachment.storedPath, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "2", framePath]);
    frames.push(framePath);
  }
  return { duration, frames };
}

export async function prepareCreativeAttachments(attachments = []) {
  const visualInputs = [];
  const context = [];
  const directories = new Set();
  for (const attachment of attachments) {
    directories.add(path.dirname(attachment.storedPath));
    if (attachment.type.startsWith("image/")) {
      visualInputs.push({ type: "local_image", path: attachment.storedPath });
      context.push(`图片附件：${attachment.name}（${attachment.type}，${attachment.size} bytes）。该图片已作为视觉输入提供。`);
      continue;
    }
    try {
      const { duration, frames } = await videoFrames(attachment);
      frames.forEach((frame) => visualInputs.push({ type: "local_image", path: frame }));
      if (frames[0]) directories.add(path.dirname(frames[0]));
      context.push(`视频附件：${attachment.name}（${attachment.type}，时长约 ${duration.toFixed(2)} 秒）。已按时间均匀抽取 ${frames.length} 张关键帧作为视觉输入；回答时说明判断基于这些关键帧，不要声称逐帧观看了原视频或听到了音频。`);
    } catch (error) {
      context.push(`视频附件：${attachment.name}。关键帧提取失败：${error instanceof Error ? error.message : String(error)}。请明确说明暂时无法可靠读取该视频内容。`);
    }
  }
  return { visualInputs, context: context.join("\n"), directories: [...directories] };
}
