import { productionProfile } from "./production-profile.js";

const PLAN_VERSION = "contextual.storyboard-video.v1";
const CREATIVE_PLAN_VERSION = "contextual.video-shot-plan.v1";

function detail(card, pattern) {
  return String((card.details || []).find((item) => pattern.test(item.label))?.content || "").trim();
}

function firstText(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function shotPrompt(shot) {
  return firstText(shot?.promptEn, shot?.prompt_en, shot?.videoPromptEn, shot?.englishPrompt, shot?.prompt);
}

// Producers label per-shot detail entries two different ways in the wild: keyword
// first ("英文提交提示词｜shot-C01｜V2") or the shot id first ("镜头 B1｜英文提交提示词").
// Match both by requiring the keyword pattern and the shot id as independent
// substrings of the label, instead of assuming either comes first.
function detailForShot(card, keywordPattern, sourceShotId) {
  if (!sourceShotId) return "";
  return String((card.details || []).find((item) => keywordPattern.test(item.label) && String(item.label || "").includes(sourceShotId))?.content || "").trim();
}

export function parseStoryboardVideoPlan(card) {
  const raw = detail(card, /分镜任务\s*JSON|storyboard.*json/i);
  let plan;
  if (raw) {
    try { plan = JSON.parse(raw); } catch (error) { throw new Error(`分镜任务 JSON 无法解析：${error.message}`); }
  } else {
    const prompt = detail(card, /英文.*(提交|提示词)|English.*prompt/i);
    if (!prompt) throw new Error("视频提示词卡缺少分镜任务 JSON 和英文提交提示词");
    plan = { schemaVersion: PLAN_VERSION, shots: [{ shotId: "shot-01", order: 1, durationSeconds: productionProfile.default_shot_duration_seconds, reviewZh: detail(card, /中文.*审核/i) || card.summary, promptEn: prompt }] };
  }
  if (![PLAN_VERSION, CREATIVE_PLAN_VERSION].includes(plan?.schemaVersion)) throw new Error(`分镜任务 JSON 契约版本不支持：${plan?.schemaVersion || "missing"}`);
  if (!Array.isArray(plan.shots) || !plan.shots.length) throw new Error("分镜任务 JSON 没有可执行镜头");
  if (plan.shots.length > productionProfile.max_shots_per_final) throw new Error(`分镜任务 JSON 契约无效：最多 ${productionProfile.max_shots_per_final} 镜，当前 ${plan.shots.length} 镜`);
  const shots = plan.shots.map((shot, index) => {
    const expectedId = `shot-${String(index + 1).padStart(2, "0")}`;
    const sourceShotId = String(shot?.shotId || "").trim();
    const durationSeconds = Number(shot?.durationSeconds);
    // The output shot below always uses the canonical shot-NN id derived from array
    // position, never shot.shotId itself, so the source id is not load-bearing beyond
    // the detail lookups above. Producers commonly label shots after their storyboard
    // candidate (e.g. "B1"/"B2"/"B3" for storyboard-B) instead of "shot-01"; only a
    // present order field actually needs to match position (older producers omit it
    // entirely and rely on array order, which we still trust in that case).
    if (shot?.order != null && shot.order !== index + 1) throw new Error(`分镜顺序无效：第 ${index + 1} 个镜头的 order 应为 ${index + 1}`);
    // Real per-shot durations are derived to hit an exact total after cross-fades
    // (e.g. 6.5s) and are rounded to whole seconds only when actually submitted to a
    // video provider (see imarouter-video-generator.js / video-generator.js), so only
    // the min/max budget is enforced here, not integer-ness.
    if (!Number.isFinite(durationSeconds) || durationSeconds < productionProfile.min_shot_duration_seconds || durationSeconds > productionProfile.max_shot_duration_seconds) throw new Error(`${expectedId} 时长必须是 ${productionProfile.min_shot_duration_seconds}-${productionProfile.max_shot_duration_seconds} 秒`);
    const promptEn = firstText(shotPrompt(shot), detailForShot(card, /英文提交提示词|English.*prompt/i, sourceShotId));
    if (!promptEn) throw new Error(`${expectedId} 缺少英文提示词`);
    const reviewZh = firstText(shot?.reviewZh, shot?.review_zh, shot?.summaryZh, detailForShot(card, /中文审核稿/i, sourceShotId));
    return { shotId: expectedId, order: index + 1, durationSeconds, reviewZh, promptEn };
  });
  return { schemaVersion: PLAN_VERSION, shots };
}

export function shotCard(parentCard, shot, patch = {}) {
  return {
    id: `${parentCard.id}-${shot.shotId}`,
    kind: "video_shot",
    title: `视频镜头 ${String(shot.order).padStart(2, "0")}`,
    summary: shot.reviewZh || `第 ${shot.order} 个内容镜头`,
    previewUrl: "",
    status: "generating",
    version: 1,
    details: [
      { label: "所属视频方案", content: parentCard.id },
      { label: "镜头 ID", content: shot.shotId },
      { label: "时长", content: `${shot.durationSeconds} 秒` },
      { label: "英文提交提示词", content: shot.promptEn },
    ],
    ...patch,
  };
}
