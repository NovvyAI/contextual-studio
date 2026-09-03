import { db, now } from "./database.js";

const rules = [
  {
    id: "user_input",
    test: /请选择|请至少|请输入|不能超过|不支持附件格式|找不到这张|缺少(?:英文提示词|镜头|参考|图片|任务 ID)|JSON.*(?:无效|无法解析)|契约无效|最多\s*\d+\s*镜/i,
    source: "用户操作或流程校验",
    explanation: "请求在本地校验阶段被拦截，尚未提交给生成服务。通常是选择不完整、输入不符合当前步骤，或当前卡片缺少必要数据。",
    resolution: "按照原始错误指出的缺项修正选择或输入，然后重新执行原操作。现有成果不会因此丢失。",
    retryability: "可以解决；修正输入后重试",
    autoRetry: "不会自动重试，避免重复创建任务",
  },
  {
    id: "google_auth",
    test: /gcloud|refreshing your current auth tokens|Reauthentication failed|Google.*(?:登录|验证)|GCS.*失败/i,
    source: "Google / GCS 身份验证",
    explanation: "本机保存的 Google 登录凭据已过期、缺失或无法在后台刷新，素材因此无法上传到 GCS。",
    resolution: "点击失败卡片中的“登录 Google 账号”，完成浏览器验证后重新执行原任务。",
    retryability: "可以解决；重新登录后重试",
    autoRetry: "登录完成前不会自动重试",
  },
  {
    id: "novvy_auth",
    test: /NOVVY_MCP_AUTHORIZATION|Unauthorized|401|403|authorization|bearer/i,
    source: "Novvy 授权",
    explanation: "Novvy MCP 凭据缺失、过期或无权调用当前能力，请求未能正常执行。",
    resolution: "检查项目 .env 中的 NOVVY_MCP_AUTHORIZATION，重新连接或更新密钥并重启服务，然后重试。",
    retryability: "可以解决；恢复授权后重试",
    autoRetry: "授权恢复前不会自动重试",
  },
  {
    id: "privacy_image",
    test: /InputImageSensitiveContentDetected\.PrivacyInformation|may contain real person|input image.*privacy/i,
    source: "ImaRouter 输入安全审核",
    explanation: "供应商把某张输入参考图判断为可能包含真人隐私信息。这不是程序崩溃，而是平台审核拒绝了该素材。",
    resolution: "系统会在能够定位具体参考图时移除该图并自动重试一次；若仍失败，请替换被标记的人物图或分镜图后重试。",
    retryability: "有条件可解决；需要降级或替换触发图片",
    autoRetry: "可定位触发图片时自动降级重试一次",
  },
  {
    id: "audio_copyright",
    test: /OutputAudioSensitiveContentDetected|output audio.*copyright|audio.*copyright restrictions/i,
    source: "生成音频版权审核",
    explanation: "画面生成不一定有问题，但供应商认为生成音频可能涉及版权限制。",
    resolution: "系统应只把受影响镜头降级为无生成音频并重试，其他已完成镜头保持不变。",
    retryability: "可以解决；关闭该镜头生成音频后重试",
    autoRetry: "自动进行一次无音频降级重试",
  },
  {
    id: "content_safety",
    test: /SensitiveContentDetected|violate platform rules|sensitive information|content policy/i,
    source: "生成内容安全审核",
    explanation: "输入素材、提示词或模型输出触发了供应商内容安全规则。仅凭错误文本通常无法确认具体画面元素。",
    resolution: "保留现有提示词和素材，减少可能触发审核的暴力、隐私或敏感描述，必要时替换参考图后再生成。",
    retryability: "有条件可解决；调整提示词或参考素材后重试",
    autoRetry: "不会盲目自动重试相同请求",
  },
  {
    id: "rate_limit",
    test: /429|rate.?limit|quota|too many requests|资源繁忙|capacity/i,
    source: "外部服务限流或容量",
    explanation: "请求频率、账户配额或供应商瞬时容量达到限制，输入内容本身未必有问题。",
    resolution: "等待片刻后重试；如果持续发生，检查供应商套餐、配额和并发限制。",
    retryability: "通常可以解决；稍后重试",
    autoRetry: "当前任务不会无限自动重试",
  },
  {
    id: "network",
    test: /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|无法解析|network|socket hang up|查询超时/i,
    source: "网络或远程服务连接",
    explanation: "本地服务无法稳定连接远程接口，或远程任务在限定时间内没有返回结果。任务可能仍在供应商侧运行。",
    resolution: "先检查网络和服务状态；存在 taskId 时优先继续查询原任务，不要立即重复提交。没有 taskId 时再重试原操作。",
    retryability: "通常可以解决；优先恢复查询或稍后重试",
    autoRetry: "有任务 ID 时应恢复查询，避免重复扣费",
  },
  {
    id: "thread_conflict",
    test: /already has an active writer|thread-store conflict/i,
    source: "Novvy 会话并发冲突",
    explanation: "同一个 Novvy 会话同时存在两个写入任务，后发任务被拒绝，以免会话记录互相覆盖。",
    resolution: "等待当前任务结束后再发送；若任务已中断，重启本地服务后恢复原工作台。",
    retryability: "可以解决；释放当前写入任务后重试",
    autoRetry: "不会并发重试同一个会话",
  },
  {
    id: "database_readonly",
    test: /readonly database|attempt to write a readonly database/i,
    source: "本地数据库权限",
    explanation: "运行服务的用户对本地 SQLite 数据库或其所在目录没有写权限，因此状态和结果无法保存。",
    resolution: "恢复项目 data 目录及数据库文件的写权限，并用同一用户重新启动服务后重试。",
    retryability: "可以解决；修复文件权限后重试",
    autoRetry: "写权限恢复前不会自动重试",
  },
  {
    id: "image_dimensions",
    test: /Image width validation failed|Required width is \d+-\d+px/i,
    source: "图片尺寸校验",
    explanation: "人物或参考图尺寸不符合上传服务要求，请求在本地上传前被拦截。",
    resolution: "宽度不足 300px 的人物裁切图现在会自动等比例放大；刷新后重新执行原任务即可。",
    retryability: "可以解决；标准化图片后重试",
    autoRetry: "重新执行时自动标准化",
  },
  {
    id: "invalid_provider_parameters",
    test: /InvalidParameter|Invalid parameters|Invalid base64 image_url|status=400 Bad Request/i,
    source: "外部生成服务参数校验",
    explanation: "供应商拒绝了请求参数，常见原因是模型字段不兼容、图片地址无效或素材格式不符合接口契约。",
    resolution: "检查所选模型的输入契约和失败字段，修正后再提交；相同参数不应直接重复发送。",
    retryability: "可以解决；修正参数或素材后重试",
    autoRetry: "不会用相同无效参数自动重试",
  },
];

export function diagnoseCreativeError(error, operation = "当前操作") {
  const raw = String(error instanceof Error ? error.message : error || "未知错误").trim() || "未知错误";
  const match = rules.find((rule) => rule.test.test(raw));
  const diagnosis = match || {
    id: "unknown",
    source: "未分类异常",
    explanation: "现有错误信息不足以可靠判断唯一根因。系统会保留原始错误，避免把推测当成事实。",
    resolution: "先刷新查看任务是否已产生结果；若没有，再重试一次。重复失败时请保留完整错误和任务 ID 继续排查。",
    retryability: "暂不确定；可在确认没有运行中的任务后重试一次",
    autoRetry: "不会自动重试未知错误",
  };
  return { ...diagnosis, raw, operation };
}

function diagnosticCard(diagnosis) {
  return {
    id: `error-diagnostic-${Date.now()}`,
    kind: "error_diagnostic",
    title: `${diagnosis.operation}｜错误诊断`,
    summary: diagnosis.explanation,
    previewUrl: "",
    status: "failed",
    details: [
      { label: "错误来源", content: diagnosis.source },
      { label: "原始错误", content: diagnosis.raw },
      { label: "是否可解决", content: diagnosis.retryability },
      { label: "处理建议", content: diagnosis.resolution },
      { label: "自动重试策略", content: diagnosis.autoRetry },
      { label: "诊断分类", content: diagnosis.id },
    ],
  };
}

export function recordCreativeError(sessionId, error, operation = "当前操作") {
  const session = db.prepare("SELECT id FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) return null;
  const diagnosis = diagnoseCreativeError(error, operation);
  const duplicate = db.prepare("SELECT cards_json FROM creative_messages WHERE session_id=? AND cards_json IS NOT NULL ORDER BY id DESC LIMIT 20").all(sessionId)
    .some((row) => {
      try { return JSON.parse(row.cards_json || "[]").some((card) => card.kind === "error_diagnostic" && (card.details || []).some((item) => item.label === "原始错误" && item.content === diagnosis.raw)); }
      catch { return false; }
    });
  if (duplicate) return diagnosis;
  db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, `我检查了“${operation}”的失败信息。下面保留原始错误，并说明原因、可恢复性和重试方式。`, JSON.stringify([diagnosticCard(diagnosis)]), now());
  return diagnosis;
}

export function ensureCreativeErrorDiagnostic(sessionId, error) {
  if (!error) return null;
  return recordCreativeError(sessionId, error, "后台任务");
}
