const PLAN_VERSION = "contextual.storyboard-video.v1";

function detail(card, pattern) {
  return String((card.details || []).find((item) => pattern.test(item.label))?.content || "").trim();
}

export function parseStoryboardVideoPlan(card) {
  const raw = detail(card, /分镜任务\s*JSON|storyboard.*json/i);
  let plan;
  if (raw) {
    try { plan = JSON.parse(raw); } catch (error) { throw new Error(`分镜任务 JSON 无法解析：${error.message}`); }
  } else {
    const prompt = detail(card, /英文.*(提交|提示词)|English.*prompt/i);
    if (!prompt) throw new Error("视频提示词卡缺少分镜任务 JSON 和英文提交提示词");
    plan = { schemaVersion: PLAN_VERSION, shots: [{ shotId: "shot-01", order: 1, durationSeconds: 12, reviewZh: detail(card, /中文.*审核/i) || card.summary, promptEn: prompt }] };
  }
  if (plan?.schemaVersion !== PLAN_VERSION || !Array.isArray(plan.shots) || !plan.shots.length || plan.shots.length > 3) throw new Error("分镜任务 JSON 契约无效");
  const shots = plan.shots.map((shot, index) => {
    const expectedId = `shot-${String(index + 1).padStart(2, "0")}`;
    const durationSeconds = Number(shot?.durationSeconds);
    if (shot?.shotId !== expectedId || shot?.order !== index + 1) throw new Error(`分镜顺序无效：应为 ${expectedId}`);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 15) throw new Error(`${expectedId} 时长必须是 4-15 秒整数`);
    const promptEn = String(shot?.promptEn || "").trim();
    if (!promptEn) throw new Error(`${expectedId} 缺少英文提示词`);
    return { shotId: expectedId, order: index + 1, durationSeconds, reviewZh: String(shot.reviewZh || "").trim(), promptEn };
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
