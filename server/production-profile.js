import fs from "node:fs";
import path from "node:path";

const profilePath = path.resolve("config/production-profile.json");

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`生产 Profile 的 ${field} 必须是正整数`);
  return value;
}

function loadProductionProfile() {
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  if (profile.schema_version !== "contextual.production-profile.v1") throw new Error("生产 Profile schema_version 不受支持");
  positiveInteger(profile.max_final_video_deliverables, "max_final_video_deliverables");
  positiveInteger(profile.max_shots_per_final, "max_shots_per_final");
  positiveInteger(profile.min_shot_duration_seconds, "min_shot_duration_seconds");
  positiveInteger(profile.default_shot_duration_seconds, "default_shot_duration_seconds");
  positiveInteger(profile.max_shot_duration_seconds, "max_shot_duration_seconds");
  if (profile.min_shot_duration_seconds > profile.default_shot_duration_seconds || profile.default_shot_duration_seconds > profile.max_shot_duration_seconds) throw new Error("生产 Profile 的镜头时长范围无效");
  if (profile.max_ai_video_submissions !== null) positiveInteger(profile.max_ai_video_submissions, "max_ai_video_submissions");
  if (!Array.isArray(profile.allowed_video_providers) || !profile.allowed_video_providers.length) throw new Error("生产 Profile 至少需要一个视频提供者");
  if (!profile.final_assembly || typeof profile.final_assembly.transition_seconds !== "number" || profile.final_assembly.transition_seconds < 0) throw new Error("生产 Profile 的转场时长无效");
  return Object.freeze(profile);
}

export const productionProfile = loadProductionProfile();
export { profilePath as productionProfilePath };
