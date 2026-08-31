const sessionId = Number(location.hash.slice(1));
let pollTimer;
let chatFollowLatest = true;
let chatRenderSignature = "";
let suppressChatScrollTracking = false;
let canvasRenderSignature = "";
const canvasDetailsOpenState = new Map();
const pendingChatFiles = [];
let pendingChatPreviewUrls = [];
const selectedCharacterIds = new Set();
let currentSession = null;

function updateCharacterSelectionUI() {
  document.querySelectorAll("input[data-character-id]").forEach((input) => {
    input.checked = selectedCharacterIds.has(input.dataset.characterId);
    input.closest(".chat-candidate-card,.canvas-character-card")?.classList.toggle("character-selected", input.checked);
  });
  document.querySelectorAll(".character-group-approve[data-character-approve]").forEach((button) => {
    button.textContent = `确认选中的人物参考图（${selectedCharacterIds.size} 张）`;
  });
}

const analysisLabels = {
  oneSentenceThesis: "一句话剧情命题", synopsis: "剧情梗概", chronology: "剧情时间线", characters: "人物与关系",
  referenceImageCandidates: "主人公参考截图候选", emotionalCurve: "观众情绪曲线", keyDialogue: "关键对白", motifs: "视听母题",
  hookAndCliffhanger: "钩子与悬念", creativeHandoff: "片尾创意衔接", visualStyle: "视觉风格", confidence: "分析置信度",
  productThesis: "产品核心判断", storeFacts: "商店事实", productStructure: "产品玩法结构", sellingPoints: "核心卖点",
  audience: "目标受众", marketMessage: "市场传达", storeCreative: "商店创意系统", reviewSignals: "评论信号",
  acquisitionDirections: "可测试获客方向", conversionSignals: "转化信号", visualDemoPotential: "玩法演示潜力",
  strategicConclusion: "策略结论", evidenceNotes: "证据与来源", timeRange: "时间", beat: "剧情节拍", action: "动作与事件",
  decisionOrShift: "决定或变化", audienceEmotion: "观众情绪", evidence: "证据", role: "角色", appearance: "外观",
  desire: "欲望", vulnerability: "脆弱点", keyChoice: "关键选择", relationshipMovement: "关系变化", available: "是否可用",
  screenshotId: "截图 ID", character: "人物", view: "角度", visibleFeatures: "可见特征", selectionReason: "选择理由",
  risks: "风险", stimulus: "情绪刺激", viewingImpulse: "观看冲动", line: "对白", verification: "核验状态",
  dramaticMeaning: "戏剧意义", openingHook: "开场钩子", retentionMechanism: "留存机制", endingState: "结尾状态",
  transitionOpportunities: "转场机会", renderingType: "画面类型", palette: "色彩", lighting: "光线", cameraLanguage: "镜头语言",
  productName: "产品名称", developer: "开发者", platform: "平台", category: "品类", rating: "评分", reviewCount: "评论数",
  downloadRange: "下载量", monetization: "变现", updateDate: "更新时间", atomicInput: "原子操作", moveRules: "移动规则",
  successCondition: "成功条件", failurePressure: "失败压力", immediateFeedback: "即时反馈", levelLoop: "关卡循环",
  metaLoop: "Meta 循环", economyAndMonetization: "经济与变现", narrativeWrapper: "叙事包装", gameplayTags: "玩法标签",
  promise: "承诺", conversionReason: "转化理由", limitation: "限制", motivations: "动机", interestGroups: "兴趣群体",
  benefitPoints: "利益点", ctaDirections: "CTA 方向", galleryFunnel: "素材漏斗", paletteAndUi: "色彩与 UI",
  gameplayVsWrapper: "玩法与包装", expectationRisk: "预期风险", demonstratedMechanic: "展示玩法", payoff: "回报",
  fidelityRisk: "保真风险", strongestPromise: "最强承诺", mustShowMechanic: "必须展示的玩法", bestWrapper: "最佳包装",
  largestRisk: "最大风险", testableTerritories: "可测试方向", sources: "来源", url: "地址", engine: "分析引擎",
  model: "模型", analyzedAt: "分析时间", codexThreadId: "Novvy 会话", version: "版本",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function annotationInstruction(items) {
  if (!items.length) return "";
  const lines = items.map((item, index) => {
    const label = `区域 ${index + 1}`;
    const request = item.note?.trim() ? `；修改要求：${item.note.trim()}` : "；修改要求：请结合用户的总体说明处理这个位置";
    if (item.type === "point") return `${label}：点选位置 x=${item.x}%, y=${item.y}%${request}`;
    if (item.type === "arrow") return `${label}：箭头从 x=${item.x1}%, y=${item.y1}% 指向 x=${item.x2}%, y=${item.y2}%${request}`;
    return `${label}：框选范围 x=${item.x}%-${item.x + item.width}%, y=${item.y}%-${item.y + item.height}%${request}`;
  });
  return `\n\n图片标注（坐标按图片左上角为原点，宽高均归一化为 0%-100%）：\n${lines.join("\n")}\n请把用户文字中的区域编号与以上位置对应，并保留未被点名的区域。`;
}

function openImageAnnotator(imageUrl, title, onApply) {
  const dialog = element("dialog", "image-annotator-dialog");
  const header = element("header", "image-annotator-header");
  header.append(element("div", "", "标注修改位置"));
  const close = element("button", "image-annotator-close", "×"); close.type = "button"; close.setAttribute("aria-label", "关闭标注");
  header.append(close);
  const help = element("p", "image-annotator-help", `${title} · 在图片上点选、框选或画箭头，标注会自动编号。`);
  const toolbar = element("div", "image-annotator-toolbar");
  let tool = "rect";
  const toolButtons = [["point", "点选"], ["rect", "框选"], ["arrow", "箭头"]].map(([value, label]) => {
    const button = element("button", value === tool ? "active" : "", label); button.type = "button";
    button.addEventListener("click", () => { tool = value; toolButtons.forEach((item) => item.classList.toggle("active", item === button)); });
    toolbar.append(button); return button;
  });
  const undo = element("button", "", "撤销"); undo.type = "button";
  const clear = element("button", "", "清空"); clear.type = "button";
  toolbar.append(undo, clear);
  const stage = element("div", "image-annotator-stage");
  const image = element("img"); image.src = imageUrl; image.alt = title;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
  const defs = document.createElementNS(svg.namespaceURI, "defs");
  const marker = document.createElementNS(svg.namespaceURI, "marker"); marker.id = "annotation-arrowhead"; marker.setAttribute("markerWidth", "10"); marker.setAttribute("markerHeight", "10"); marker.setAttribute("refX", "8.5"); marker.setAttribute("refY", "5"); marker.setAttribute("orient", "auto"); marker.setAttribute("markerUnits", "strokeWidth");
  const arrowPath = document.createElementNS(svg.namespaceURI, "path"); arrowPath.setAttribute("d", "M0,0 L10,5 L0,10 L2.5,5 Z"); marker.append(arrowPath); defs.append(marker); svg.append(defs);
  stage.append(image, svg);
  const list = element("ol", "image-annotation-list");
  const footer = element("footer", "image-annotator-footer");
  const cancel = element("button", "image-annotator-cancel", "取消"); cancel.type = "button";
  const apply = element("button", "image-annotator-apply", "使用这些标注"); apply.type = "button";
  footer.append(cancel, apply);
  dialog.append(header, help, toolbar, stage, list, footer); document.body.append(dialog);
  const annotations = [];
  let start = null;
  const pct = (event) => { const bounds = svg.getBoundingClientRect(); return { x: Math.max(0, Math.min(100, Math.round((event.clientX - bounds.left) / bounds.width * 100))), y: Math.max(0, Math.min(100, Math.round((event.clientY - bounds.top) / bounds.height * 100))) }; };
  const render = () => {
    [...svg.querySelectorAll(".image-annotation-shape")].forEach((node) => node.remove()); list.replaceChildren();
    annotations.forEach((item, index) => {
      let shape;
      if (item.type === "point") { shape = document.createElementNS(svg.namespaceURI, "circle"); shape.setAttribute("cx", item.x); shape.setAttribute("cy", item.y); shape.setAttribute("r", "2.2"); }
      else if (item.type === "arrow") {
        shape = document.createElementNS(svg.namespaceURI, "line"); shape.setAttribute("x1", item.x1); shape.setAttribute("y1", item.y1); shape.setAttribute("x2", item.x2); shape.setAttribute("y2", item.y2); shape.setAttribute("marker-end", "url(#annotation-arrowhead)"); shape.classList.add("image-annotation-arrow");
        const origin = document.createElementNS(svg.namespaceURI, "circle"); origin.setAttribute("cx", item.x1); origin.setAttribute("cy", item.y1); origin.setAttribute("r", "1.5"); origin.setAttribute("class", "image-annotation-shape image-annotation-arrow-origin"); svg.append(origin);
      }
      else { shape = document.createElementNS(svg.namespaceURI, "rect"); shape.setAttribute("x", item.x); shape.setAttribute("y", item.y); shape.setAttribute("width", item.width); shape.setAttribute("height", item.height); }
      shape.setAttribute("class", "image-annotation-shape"); svg.append(shape);
      const badge = document.createElementNS(svg.namespaceURI, "text"); badge.setAttribute("x", item.type === "arrow" ? item.x2 : item.x); badge.setAttribute("y", Math.max(4, (item.type === "arrow" ? item.y2 : item.y) - 1)); badge.setAttribute("class", "image-annotation-shape image-annotation-badge"); badge.textContent = String(index + 1); svg.append(badge);
      const row = element("li", "image-annotation-item");
      const rowTitle = element("label", ""); rowTitle.append(element("b", "", `区域 ${index + 1}`), element("span", "", item.type === "point" ? "点选" : item.type === "arrow" ? "箭头" : "框选"));
      const note = element("textarea", "image-annotation-note"); note.rows = 2; note.placeholder = `描述区域 ${index + 1} 要怎么修改，例如：删除这里的文字`;
      note.value = item.note || "";
      note.addEventListener("input", () => { item.note = note.value; });
      row.append(rowTitle, note); list.append(row);
    });
    apply.disabled = annotations.length === 0;
  };
  svg.addEventListener("pointerdown", (event) => { event.preventDefault(); start = pct(event); svg.setPointerCapture(event.pointerId); });
  svg.addEventListener("pointerup", (event) => {
    if (!start) return; const end = pct(event);
    if (tool === "point") annotations.push({ type: "point", x: end.x, y: end.y });
    else if (tool === "arrow") annotations.push({ type: "arrow", x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    else { const x = Math.min(start.x, end.x); const y = Math.min(start.y, end.y); const width = Math.max(2, Math.abs(end.x - start.x)); const height = Math.max(2, Math.abs(end.y - start.y)); annotations.push({ type: "rect", x, y, width: Math.min(100 - x, width), height: Math.min(100 - y, height) }); }
    start = null; render();
  });
  undo.addEventListener("click", () => { annotations.pop(); render(); });
  clear.addEventListener("click", () => { annotations.length = 0; render(); });
  const dismiss = () => { dialog.close(); dialog.remove(); };
  close.addEventListener("click", dismiss); cancel.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
  apply.addEventListener("click", () => {
    const firstEmpty = annotations.findIndex((item) => !item.note?.trim());
    if (firstEmpty >= 0) {
      const input = list.querySelectorAll(".image-annotation-note")[firstEmpty];
      input.setCustomValidity(`请填写区域 ${firstEmpty + 1} 的修改要求`); input.reportValidity(); input.setCustomValidity(""); input.focus(); return;
    }
    onApply(annotationInstruction(annotations)); dismiss();
  });
  render(); dialog.showModal();
}

function addAnnotationButton(container, imageUrl, title, textarea, disabled) {
  if (!imageUrl || /\.(mp4|mov|webm)(\?|$)/i.test(imageUrl)) return;
  const button = element("button", "image-annotate-button", "标注图片位置"); button.type = "button"; button.disabled = disabled;
  button.addEventListener("click", () => openImageAnnotator(imageUrl, title, (instruction) => {
    textarea.value = `${textarea.value.trim()}${textarea.value.trim() ? "\n" : ""}${instruction.trim()}`;
    textarea.focus();
  }));
  container.append(button);
}

function openImagePreview(imageUrl, title) {
  const dialog = element("dialog", "image-preview-dialog");
  const header = element("header", "image-preview-header");
  header.append(element("strong", "", title || "图片预览"));
  const close = element("button", "image-preview-close", "×"); close.type = "button"; close.setAttribute("aria-label", "关闭大图"); header.append(close);
  const image = element("img", "image-preview-full"); image.src = imageUrl; image.alt = title || "图片预览";
  dialog.append(header, image); document.body.append(dialog);
  const dismiss = () => { dialog.close(); dialog.remove(); };
  close.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dismiss(); });
  dialog.showModal();
}

function enableImagePreview(image, imageUrl, title) {
  image.classList.add("image-preview-trigger"); image.tabIndex = 0; image.setAttribute("role", "button"); image.setAttribute("aria-label", `查看大图：${title}`);
  image.addEventListener("click", () => openImagePreview(imageUrl, title));
  image.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openImagePreview(imageUrl, title); } });
}

function canvasDetails(node, key, defaultOpen = false) {
  node.dataset.canvasDetailsKey = key;
  node.open = canvasDetailsOpenState.has(key) ? canvasDetailsOpenState.get(key) : defaultOpen;
  return node;
}

function renderPendingChatFiles() {
  pendingChatPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  pendingChatPreviewUrls = [];
  const root = document.querySelector("#chat-attachment-preview");
  root.replaceChildren();
  pendingChatFiles.forEach((file, index) => {
    const card = element("article", "chat-pending-attachment");
    const previewUrl = URL.createObjectURL(file); pendingChatPreviewUrls.push(previewUrl);
    if (file.type.startsWith("video/")) {
      const video = document.createElement("video"); video.src = previewUrl; video.muted = true; video.playsInline = true; video.preload = "metadata"; card.append(video);
    } else {
      const image = element("img"); image.src = previewUrl; image.alt = file.name; card.append(image);
    }
    const remove = element("button", "chat-pending-remove", "×"); remove.type = "button"; remove.title = `移除 ${file.name}`;
    remove.addEventListener("click", () => { pendingChatFiles.splice(index, 1); renderPendingChatFiles(); });
    card.append(element("span", "", file.name), remove); root.append(card);
  });
  document.querySelector("#chat-attachment-hint").textContent = pendingChatFiles.length ? `已添加 ${pendingChatFiles.length}/6` : "最多 6 个附件";
}

function addPendingChatFiles(files) {
  let unsupported = 0;
  let overflow = 0;
  for (const file of files) {
    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) { unsupported += 1; continue; }
    if (pendingChatFiles.length >= 6) { overflow += 1; continue; }
    pendingChatFiles.push(file);
  }
  renderPendingChatFiles();
  const hint = document.querySelector("#chat-attachment-hint");
  if (overflow) hint.textContent = "最多只能添加 6 个附件";
  else if (unsupported) hint.textContent = "仅支持 JPG、PNG、WebP 和视频";
}

function renderMessageAttachments(attachments = []) {
  const root = element("div", "chat-message-attachments");
  attachments.forEach((attachment) => {
    const link = element("a", `chat-message-attachment ${attachment.type.startsWith("video/") ? "video" : "image"}`);
    link.href = attachment.url; link.target = "_blank"; link.rel = "noreferrer";
    if (attachment.type.startsWith("video/")) {
      const video = document.createElement("video"); video.src = attachment.url; video.controls = true; video.playsInline = true; video.preload = "metadata"; link.append(video);
    } else {
      const image = element("img"); image.src = attachment.url; image.alt = attachment.name; image.loading = "lazy"; link.append(image);
    }
    link.append(element("span", "", attachment.name)); root.append(link);
  });
  return root;
}

function labelFor(key) {
  return analysisLabels[key] || key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function renderAnalysisValue(value) {
  if (Array.isArray(value)) {
    const list = element("div", "source-value-list");
    if (!value.length) list.append(element("p", "source-empty-value", "暂无记录"));
    value.forEach((item) => {
      const card = element("article", "source-value-card");
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const heading = item.name || item.title || item.role || item.promise || item.beat || item.timeRange;
        if (heading) card.append(element("strong", "source-value-heading", String(heading)));
        card.append(renderAnalysisValue(item));
      } else if (typeof item === "string" && /^https?:\/\//.test(item)) {
        const link = element("a", "source-analysis-link", item); link.href = item; link.target = "_blank"; link.rel = "noreferrer"; card.append(link);
      } else card.append(element("p", "source-scalar", String(item ?? "")));
      list.append(card);
    });
    return list;
  }
  if (value && typeof value === "object") {
    const facts = element("dl", "source-analysis-facts");
    Object.entries(value).forEach(([key, childValue]) => {
      const row = element("div", "source-analysis-fact");
      row.append(element("dt", "", labelFor(key)));
      const content = element("dd"); content.append(renderAnalysisValue(childValue));
      row.append(content); facts.append(row);
    });
    return facts;
  }
  if (typeof value === "boolean") return element("span", `source-boolean ${value ? "yes" : "no"}`, value ? "是" : "否");
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    const link = element("a", "source-analysis-link", value); link.href = value; link.target = "_blank"; link.rel = "noreferrer"; return link;
  }
  return element("p", "source-scalar", value === null || value === undefined || value === "" ? "暂无" : String(value));
}

function referenceSlots(drama) {
  const names = { maleFront: "男主正面", maleSide: "男主侧面", femaleFront: "女主正面", femaleSide: "女主侧面" };
  const byId = new Map();
  Object.entries(drama?.result?.referenceImageCandidates || {}).forEach(([slot, candidate]) => {
    if (candidate?.available && candidate.screenshotId) byId.set(candidate.screenshotId, names[slot] || slot);
  });
  return byId;
}

function renderDramaMedia(drama) {
  const section = element("section", "source-media-section");
  section.append(element("h3", "", "全部截图"));
  const gallery = element("div", "source-screenshot-grid");
  const slotMap = referenceSlots(drama);
  (drama.screenshots || []).forEach((shot) => {
    const figure = element("figure", `source-screenshot ${slotMap.has(shot.id) ? "reference-selected" : ""}`);
    const image = element("img"); image.src = shot.url; image.alt = `${shot.timestampSeconds.toFixed(2)} 秒截图`; image.loading = "lazy";
    const caption = element("figcaption"); caption.append(element("span", "", `${shot.timestampSeconds.toFixed(2)}s`));
    if (slotMap.has(shot.id)) caption.append(element("b", "", slotMap.get(shot.id)));
    figure.append(image, caption); gallery.append(figure);
  });
  if (!drama.screenshots?.length) gallery.append(element("p", "source-empty-value", "没有已保存的截图。"));
  section.append(gallery);
  return section;
}

function openSourceAnalysis(type, source) {
  if (!source) return;
  const dialog = document.querySelector("#source-analysis-dialog");
  document.querySelector("#source-analysis-kind").textContent = type === "drama" ? "SHORT DRAMA ANALYSIS" : "GAME ANALYSIS";
  document.querySelector("#source-analysis-title").textContent = source.title || source.result?.storeFacts?.productName || "完整分析";
  const body = document.querySelector("#source-analysis-body"); body.replaceChildren();
  const intro = element("section", "source-analysis-intro");
  intro.append(element("small", "", type === "drama" ? "分析命题" : "产品判断"), element("p", "", type === "drama" ? source.result?.oneSentenceThesis : source.result?.productThesis));
  if (type === "game" && source.storeUrl) {
    const link = element("a", "source-store-link", "打开原始商店页面 ↗"); link.href = source.storeUrl; link.target = "_blank"; link.rel = "noreferrer"; intro.append(link);
  }
  body.append(intro);
  if (type === "drama") body.append(renderDramaMedia(source));
  else {
    const note = element("section", "source-media-note");
    note.append(element("strong", "", "游戏截图"), element("p", "", "当前游戏分析流程尚未把商店截图保存到数据库；这里展示全部已保存的文字分析和证据链接。"));
    body.append(note);
  }
  const analysis = element("section", "source-complete-analysis");
  analysis.append(element("h3", "", "完整模型分析"), renderAnalysisValue(source.result || {}));
  body.append(analysis);
  dialog.showModal();
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

const cardKindLabels = {
  concept: "创意方案",
  final_card: "落版图",
  reference_panel: "人物与参考图",
  storyboard: "剧情与分镜",
  video_prompt: "视频提示词",
  video_shot: "视频镜头",
  generation_ready: "生成配置",
};

const chatCardKindLabels = {
  concept: "创意方案", final_card: "落版图", character_image: "人物图", prop_image: "道具图",
  reference_image: "参考图", storyboard: "剧情与分镜", storyboard_image: "分镜图片", video_prompt: "视频提示词", video_shot: "视频镜头",
};
const characterCandidateNumbers = { "reference-male_front": "01", "reference-male_side": "02", "reference-female_front": "03", "reference-female_side": "04" };

function legacyConfirmedCards(workspace) {
  if (workspace.confirmedCards?.length || !workspace.selectedConceptIds?.length) return workspace.confirmedCards || [];
  return workspace.concepts
    .filter((concept) => workspace.selectedConceptIds.includes(concept.id))
    .map((concept) => ({
      id: `legacy-concept-${concept.id}`,
      kind: "concept",
      title: `已选择方案 ${concept.id} · ${concept.title}`,
      summary: concept.tailAdAngle,
      status: "confirmed",
      confirmedAt: "历史确认",
      details: [
        { label: "剧集匹配", content: concept.videoMatch },
        { label: "玩法卖点", content: concept.gameplaySellingPoint },
        { label: "目标受众", content: concept.audience },
        { label: "情绪接续", content: concept.emotionalBridge },
        { label: "转化路径", content: concept.conversionPath },
      ],
    }));
}

function renderConfirmedCard(card, expanded) {
  const node = canvasDetails(element("details", `artifact-card ${card.status}`), `confirmed:${card.id}`, expanded);
  const isPreviewUrl = (value) => typeof value === "string" && (/^https?:\/\//.test(value) || /^\/api\/screenshots\/\d+$/.test(value));
  const previewEntries = [
    ...(card.previewUrl ? [{ label: card.title, content: card.previewUrl }] : []),
    ...(card.details || []).filter((item) => isPreviewUrl(item.content)),
  ].filter((item, index, entries) => entries.findIndex((other) => other.content === item.content) === index);
  const previewUrls = previewEntries.map((item) => item.content);
  const previewUrl = previewUrls[0];
  const summary = element("summary");
  const identity = element("div", "artifact-identity");
  if (previewUrl) {
    const thumbnail = element("img", "artifact-summary-preview"); thumbnail.src = previewUrl; thumbnail.alt = ""; thumbnail.loading = "lazy";
    identity.append(thumbnail);
  }
  identity.append(element("span", `artifact-kind kind-${card.kind}`, cardKindLabels[card.kind] || "已确认成果"), element("strong", "", card.title));
  summary.append(identity, element("span", "artifact-toggle", "查看详情"));
  const body = element("div", "artifact-body");
  if (previewUrls.length) {
    const gallery = element("div", "artifact-preview-gallery");
    previewEntries.forEach((entry) => {
      const item = element("figure", "artifact-preview-item");
      const link = element("a", "artifact-preview-link"); link.href = entry.content; link.target = "_blank"; link.rel = "noreferrer";
      const image = element("img", "artifact-preview"); image.src = entry.content; image.alt = entry.label || card.title; image.loading = "lazy";
      link.append(image); item.append(link);
      const description = card.kind === "storyboard" ? (card.details || []).find((detail) => detail.label === `${entry.label}｜文字描述`)?.content : "";
      if (description) item.append(element("figcaption", "artifact-preview-caption", description));
      gallery.append(item);
    });
    body.append(gallery);
  }
  body.append(element("p", "artifact-summary", card.summary));
  const details = element("dl", "artifact-details");
  (card.details || []).filter((item) => !isPreviewUrl(item.content)).forEach((item) => {
    const row = element("div");
    row.append(element("dt", "", item.label), element("dd", "", item.content));
    details.append(row);
  });
  body.append(details, element("small", "artifact-meta", `${card.status === "superseded" ? "已被新版替代" : "已确认"} · ${card.confirmedAt}`));
  node.append(summary, body);
  return node;
}

function latestGeneratedVideoShots(messages) {
  const latest = new Map();
  for (const message of messages || []) for (const card of message.cards || []) {
    if (card.kind === "video_shot") latest.set(card.id, card);
  }
  return [...latest.values()]
    .filter((card) => card.previewUrl)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function latestCharacterCandidates(messages) {
  const latest = new Map();
  for (const message of messages || []) for (const card of message.cards || []) {
    if (card.kind === "character_image") latest.set(card.id, card);
  }
  return [...latest.values()]
    .filter((card) => card.previewUrl && !["superseded", "failed", "generating"].includes(card.status))
    .sort((left, right) => Number(characterCandidateNumbers[left.id] || left.candidateNumber || 999) - Number(characterCandidateNumbers[right.id] || right.candidateNumber || 999));
}

function renderCharacterSelectionPanel(session, cards) {
  const content = canvasDetails(element("details", "workflow-node-card character-selection-node-card"), "character-selection", session.stage === "reference_review");
  const summary = element("summary", "character-selection-summary");
  const copy = element("div"); copy.append(element("strong", "", "人物参考图选择"), element("small", "", `${cards.length} 张最新候选 · 点击展开`));
  summary.append(copy, element("span", "", "查看与勾选"));
  const body = element("div", "canvas-character-selection-body");
  const grid = element("div", "canvas-character-grid");
  cards.forEach((card) => {
    const item = element("label", "canvas-character-card");
    const image = element("img"); image.src = card.previewUrl; image.alt = card.title; image.loading = "lazy";
    const row = element("div", "canvas-character-picker");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.characterId = card.id; checkbox.checked = selectedCharacterIds.has(card.id); checkbox.disabled = session.stage === "working";
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selectedCharacterIds.add(card.id) : selectedCharacterIds.delete(card.id);
      updateCharacterSelectionUI();
    });
    const text = element("span"); text.append(element("b", "", `${characterCandidateNumbers[card.id] || card.candidateNumber || "—"} · ${card.title}`), element("small", "", "勾选后加入正式人物参考组"));
    row.append(checkbox, text); item.append(image, row); grid.append(item);
  });
  body.append(grid, renderCharacterGroupActions(session)); content.append(summary, body);
  return content;
}

function renderVideoShotWorkflowNode(shots) {
  const node = element("article", "workflow-node video-shots-workflow-node");
  node.append(element("div", "workflow-marker", "VID"));
  const content = element("section", "workflow-node-card video-shots-node-card");
  const heading = element("div", "workflow-node-heading");
  heading.append(element("div", "", "逐镜视频候选"), element("span", "", `${shots.length} 个镜头`));
  const grid = element("div", "canvas-video-shot-grid");
  shots.forEach((shot, index) => {
    const card = canvasDetails(element("details", "canvas-video-shot-card"), `video-shot:${shot.id}`, true);
    const summary = element("summary");
    const title = element("div");
    title.append(element("small", "", `镜头 ${String(index + 1).padStart(2, "0")} · V${shot.version || 1}`), element("strong", "", shot.title));
    summary.append(title, element("span", "", "可播放复审"));
    const body = element("div", "canvas-video-shot-body");
    const video = element("video", "canvas-video-shot-player");
    video.src = shot.previewUrl; video.controls = true; video.playsInline = true; video.preload = "metadata";
    body.append(video, element("p", "", shot.summary));
    const meta = element("dl", "canvas-video-shot-meta");
    (shot.details || []).filter((item) => ["时长", "视频供应商", "参考策略", "参考绑定", "版本"].includes(item.label)).forEach((item) => {
      const row = element("div"); row.append(element("dt", "", item.label), element("dd", "", item.content)); meta.append(row);
    });
    body.append(meta); card.append(summary, body); grid.append(card);
  });
  content.append(heading, grid); node.append(content);
  return node;
}

async function regenerateConcept(concept, feedback, textarea) {
  const instruction = feedback.trim();
  if (!instruction) {
    textarea.setCustomValidity("请先填写对这个方案的修改意见");
    textarea.reportValidity();
    textarea.setCustomValidity("");
    return false;
  }
  const original = [
    `标题：${concept.title}`,
    `片尾角度：${concept.tailAdAngle}`,
    `剧集匹配：${concept.videoMatch}`,
    `玩法卖点：${concept.gameplaySellingPoint}`,
    `目标受众：${concept.audience}`,
    `情绪接续：${concept.emotionalBridge}`,
    `转化路径：${concept.conversionPath}`,
    `进入方式：${concept.entryMethod}`,
    `节奏：${concept.rhythm}`,
  ].join("\n");
  await sendMessage(`请只重新生成方案 ${concept.id}，保持编号 ${concept.id} 不变，其他创意方案、已确认成果和未被点名的工作台内容全部保持不变。\n\n原方案：\n${original}\n\n我的修改意见：\n${instruction}\n\n请直接回复修改后的方案 ${concept.id} 及主要变化；这只是修改候选，不代表我确认了它。`);
  return true;
}

function conceptChatCards(workspace) {
  return (workspace?.concepts || []).map((concept) => ({
    id: `concept-${concept.id}`,
    kind: "concept",
    title: `方案 ${concept.id} · ${concept.title}`,
    summary: concept.tailAdAngle,
    previewUrl: "",
    status: workspace.selectedConceptIds?.includes(concept.id) ? "selected" : "candidate",
    details: [
      { label: "剧集匹配", content: concept.videoMatch },
      { label: "玩法卖点", content: concept.gameplaySellingPoint },
      { label: "目标受众", content: concept.audience },
      { label: "情绪接续", content: concept.emotionalBridge },
      { label: "转化路径", content: concept.conversionPath },
      { label: "节奏", content: concept.rhythm },
    ],
  }));
}

async function sendChatCardFeedback(card, feedback, textarea) {
  const instruction = feedback.trim();
  if (!instruction) {
    textarea.setCustomValidity("请先填写对这张卡片的修改意见");
    textarea.reportValidity();
    textarea.setCustomValidity("");
    return false;
  }
  const original = (card.details || []).map((item) => `${item.label}：${item.content}`).join("\n");
  await sendMessage(`请只修改聊天候选卡 ${card.id}（${chatCardKindLabels[card.kind] || "候选"}），其他候选卡、已确认节点和未被点名的工作台内容保持不变。\n\n卡片标题：${card.title}\n卡片摘要：${card.summary}\n当前真实预览：${card.previewUrl || "无"}\n${original}\n\n我的修改意见：${instruction}\n\n请返回同一 card id 的修改版卡片。这次修改不代表我确认或采用它。图片卡只有在新的图片文件真实存在时才能声称已完成修改并替换 previewUrl；否则必须保留当前 previewUrl，并明确说明目前只是修改要求。`);
  return true;
}

function renderChatCard(card, disabled) {
  const node = element("article", `chat-candidate-card chat-kind-${card.kind} status-${card.status}`);
  const header = element("div", "chat-card-header");
  const candidateNumber = characterCandidateNumbers[card.id] || card.candidateNumber;
  const kindLabel = card.kind === "character_image" && candidateNumber ? `人物候选 ${candidateNumber}` : chatCardKindLabels[card.kind] || "";
  if (kindLabel) header.append(element("span", "chat-card-kind", kindLabel));
  header.append(element("span", "chat-card-status", ({ candidate: "候选", selected: "已选择", confirmed: "已确认", superseded: "已替代", generating: "生成中", completed: "已生成", failed: "生成失败" })[card.status] || card.status));
  node.append(header, element("strong", "chat-card-title", card.title), element("p", "chat-card-summary", card.summary));
  if (card.previewUrl) {
    if (card.kind === "video_prompt" || card.kind === "video_shot" || /\.(mp4|mov|webm)(\?|$)/i.test(card.previewUrl)) {
      const video = element("video", "chat-card-preview chat-card-video"); video.src = card.previewUrl; video.controls = true; video.playsInline = true; video.preload = "metadata"; node.append(video);
    } else {
      const image = element("img", "chat-card-preview"); image.src = card.previewUrl; image.alt = card.title; image.loading = "lazy"; enableImagePreview(image, card.previewUrl, card.title); node.append(image);
    }
  } else if (card.status === "generating") {
    const placeholder = element("div", "chat-card-preview chat-card-generating");
    placeholder.append(element("span", "chat-card-generating-spinner"), element("strong", "", "生成中"), element("small", "", "新结果返回后将在这里显示"));
    node.append(placeholder);
  }
  if (card.kind === "character_image" && card.previewUrl) {
    const picker = element("label", "character-card-picker");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.characterId = card.id; checkbox.checked = selectedCharacterIds.has(card.id); checkbox.disabled = disabled;
    const label = element("span", "character-picker-copy");
    const title = element("b", "", checkbox.checked ? "已选中这张人物图" : "选择这张人物图");
    label.append(title, element("small", "", "确认后用于分镜和视频的人物一致性参考"));
    const reflectSelection = () => {
      node.classList.toggle("character-selected", checkbox.checked);
      title.textContent = checkbox.checked ? "已选中这张人物图" : "选择这张人物图";
    };
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selectedCharacterIds.add(card.id) : selectedCharacterIds.delete(card.id);
      reflectSelection();
      updateCharacterSelectionUI();
    });
    picker.append(checkbox, label); node.append(picker); reflectSelection();
  }
  const details = element("details", "chat-card-details");
  details.append(element("summary", "", "查看完整内容"));
  const facts = element("dl");
  (card.details || []).forEach((item) => { const row = element("div"); row.append(element("dt", "", item.label), element("dd", "", item.content)); facts.append(row); });
  details.append(facts); node.append(details);
  const cardErrorText = [card.summary, ...(card.details || []).map((item) => item.content)].filter((value) => typeof value === "string").join("\n");
  if (card.status === "failed" && /(?:gcloud\.storage\.cp|refreshing your current auth tokens|Reauthentication failed|gcloud auth login)/i.test(cardErrorText)) {
    const recovery = element("section", "integration-recovery");
    recovery.append(element("strong", "", "需要重新连接 Google 账号"), element("p", "", "人物参考图上传前需要 Google 身份验证。点击后会打开 Google 登录页，无需使用终端。"));
    const login = element("button", "integration-login-button", "登录 Google 账号"); login.type = "button";
    login.addEventListener("click", async () => {
      try {
        login.disabled = true; login.textContent = "正在打开 Google 登录页…";
        await api("/api/integrations/gcloud/login", { method: "POST" });
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1800));
          const status = await api("/api/integrations/gcloud/login");
          if (status.status === "completed") {
            login.textContent = "登录成功，可以重新生成视频";
            return;
          }
          if (status.status === "failed") throw new Error(status.message || "Google 登录没有完成");
          login.textContent = "请在 Google 页面完成验证…";
        }
        throw new Error("等待登录超时，请再次点击重试");
      } catch (error) {
        login.disabled = false; login.textContent = "重新登录 Google 账号"; alert(error.message);
      }
    });
    recovery.append(login); node.append(recovery);
  }
  const editor = element("div", "chat-card-editor");
  const feedback = element("textarea", "chat-card-feedback"); feedback.rows = 2; feedback.placeholder = "填写修改意见；可直接引用图片 04、图片 06…"; feedback.disabled = disabled;
  const actions = element("div", "chat-card-actions");
  const regenerate = element("button", "chat-card-regenerate", "按意见重新生成"); regenerate.type = "button"; regenerate.disabled = disabled;
  if (["character_image", "storyboard_image", "final_card", "prop_image", "reference_image"].includes(card.kind)) addAnnotationButton(actions, card.previewUrl, card.title, feedback, disabled);
  regenerate.addEventListener("click", async () => {
    try {
      regenerate.disabled = true; regenerate.textContent = "正在提交…";
      let submitted;
      if (card.kind === "character_image") {
        const instruction = feedback.value.trim();
        if (!instruction) { feedback.setCustomValidity("请先填写对这张人物图的修改意见"); feedback.reportValidity(); feedback.setCustomValidity(""); submitted = false; }
        else {
          await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/regenerate-image`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: instruction }) });
          submitted = true; await refreshSession();
        }
      } else if (card.kind === "storyboard_image") {
        const instruction = feedback.value.trim();
        if (!instruction) { feedback.setCustomValidity("请先填写对这张分镜图的修改意见"); feedback.reportValidity(); feedback.setCustomValidity(""); submitted = false; }
        else {
          await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/regenerate-storyboard-image`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: instruction }) });
          submitted = true; await refreshSession();
        }
      } else if (card.kind === "final_card" && card.previewUrl) {
        const instruction = feedback.value.trim();
        if (!instruction) { feedback.setCustomValidity("请先填写对这张落版图的修改意见"); feedback.reportValidity(); feedback.setCustomValidity(""); submitted = false; }
        else {
          await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/regenerate-final-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: instruction }) });
          submitted = true; await refreshSession();
        }
      } else submitted = await sendChatCardFeedback(card, feedback.value, feedback);
      if (!submitted) { regenerate.disabled = false; regenerate.textContent = "按意见重新生成"; }
    } catch (error) {
      feedback.setCustomValidity(error.message); feedback.reportValidity(); feedback.setCustomValidity("");
      regenerate.disabled = false; regenerate.textContent = "按意见重新生成";
    }
  });
  const isFinalCardDraft = card.kind === "final_card" && !card.previewUrl;
  const isFailedFinalCard = isFinalCardDraft && card.status === "failed";
  const isGeneratedFinalCard = card.kind === "final_card" && Boolean(card.previewUrl);
  const isVideoPromptDraft = card.kind === "video_prompt" && !card.previewUrl;
  const isShotBatchReady = isVideoPromptDraft && card.status === "completed" && (card.details || []).some((item) => item.label === "逐镜状态");
  const isFinalVideo = card.kind === "video_prompt" && Boolean(card.previewUrl);
  let videoProvider;
  if (isVideoPromptDraft && !isShotBatchReady) {
    const providerRow = element("label", "video-provider-picker");
    providerRow.append(element("span", "", "视频生成方式"));
    videoProvider = document.createElement("select");
    videoProvider.append(new Option("Novvy MCP（多人物参考）", "novvy"), new Option("ImaRouter（分镜图 + 多人物参考）", "imarouter"));
    videoProvider.disabled = disabled || card.status === "generating";
    providerRow.append(videoProvider);
    actions.append(providerRow);
  }
  const adoptLabel = card.kind === "concept" ? "选择这个方案" : card.kind === "storyboard" ? "选择并生成分镜图" : isFailedFinalCard ? "重新生成落版图" : isFinalCardDraft ? "确认并生成落版图" : isGeneratedFinalCard ? "确认使用" : isFinalVideo && card.status === "confirmed" ? "最终成片已确认" : isFinalVideo ? "确认最终成片" : isShotBatchReady ? "确认全部镜头并合成" : isVideoPromptDraft && card.status === "failed" ? "按所选方式重新生成" : isVideoPromptDraft ? "确认并生成逐镜视频" : "采用这个候选";
  const adopt = element("button", "chat-card-adopt", adoptLabel); adopt.type = "button";
  const actionStages = card.kind === "concept" ? ["concept_review"]
    : card.kind === "storyboard" ? ["storyboard_review"]
      : isFinalCardDraft ? ["concept_selected", "final_card_review"]
        : isGeneratedFinalCard ? ["final_card_review"]
          : isVideoPromptDraft ? ["prompt_review", "ready_to_generate", "video_review"]
            : isFinalVideo ? ["video_review"] : [];
  if (actionStages.length && adoptLabel !== "最终成片已确认") {
    adopt.classList.add("workflow-confirm-action");
    adopt.dataset.workflowStages = actionStages.join(" ");
    adopt.dataset.workflowLabel = adoptLabel;
    adopt.dataset.workflowPriority = "20";
  }
  if (card.kind === "character_image" || card.kind === "storyboard_image" || card.kind === "video_shot") adopt.hidden = true;
  adopt.disabled = disabled || card.status === "selected" || (card.status === "confirmed" && !isVideoPromptDraft) || card.status === "generating" || (card.status === "completed" && !isShotBatchReady && !isFinalVideo);
  adopt.addEventListener("click", async () => {
    if (isFinalVideo) {
      adopt.disabled = true; adopt.textContent = "正在确认最终成片…";
      try {
        await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/approve-final-video`, { method: "POST" });
        return refreshSession();
      } catch (error) {
        adopt.disabled = false; adopt.textContent = adoptLabel; alert(error.message); return;
      }
    }
    if (isVideoPromptDraft) {
      if (isShotBatchReady) {
        adopt.disabled = true; adopt.textContent = "正在拼接…";
        try {
          await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/approve-video-shots`, { method: "POST" });
          return refreshSession();
        } catch (error) {
          adopt.disabled = false; adopt.textContent = adoptLabel;
          feedback.setCustomValidity(error.message); feedback.reportValidity(); feedback.setCustomValidity("");
          return;
        }
      }
      adopt.disabled = true; adopt.textContent = "正在创建视频任务…";
      try {
        await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/generate-video`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: videoProvider?.value || "novvy" }),
        });
        return refreshSession();
      } catch (error) {
        adopt.disabled = false; adopt.textContent = adoptLabel;
        feedback.setCustomValidity(error.message); feedback.reportValidity(); feedback.setCustomValidity("");
        alert(`视频任务没有启动：${error.message}`);
        return;
      }
    }
    if (card.kind === "storyboard") {
      adopt.disabled = true; adopt.textContent = "正在创建分镜图…";
      try {
        await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/generate-storyboard-images`, { method: "POST" });
        return refreshSession();
      } catch (error) {
        adopt.disabled = false; adopt.textContent = adoptLabel;
        feedback.setCustomValidity(error.message); feedback.reportValidity(); feedback.setCustomValidity("");
        alert(`分镜图任务没有启动：${error.message}`);
        return;
      }
    }
    if (isGeneratedFinalCard) {
      adopt.disabled = true; adopt.textContent = "正在确认…";
      try {
        await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/approve`, { method: "POST" });
        return refreshSession();
      } catch (error) {
        adopt.disabled = false; adopt.textContent = adoptLabel;
        feedback.setCustomValidity(error.message); feedback.reportValidity(); feedback.setCustomValidity("");
        return;
      }
    }
    if (!isFinalCardDraft) return sendMessage(`我选择并确认采用候选卡 ${card.id}：${card.title}。请保留其他历史内容。现在立即根据已确认创意生成 2-4 个可审核的落版图方案候选卡：kind 必须为 final_card，previewUrl 保持为空，status 为 candidate；每张卡写清视觉构图、英文标题/副标题/CTA、字体层级、色彩、产品真实性边界和 GPT-image-2 英文生成提示词。此步骤只准备候选方案，不执行图片生成，也不要只告诉我下一步。`);
    adopt.disabled = true;
    adopt.textContent = "正在创建任务…";
    try {
      await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/generate`, { method: "POST" });
      await refreshSession();
      } catch (error) {
        adopt.disabled = false;
        adopt.textContent = adoptLabel;
        feedback.value = `生成未启动：${error.message}`;
        feedback.setCustomValidity(error.message); feedback.reportValidity(); feedback.setCustomValidity("");
      }
  });
  actions.append(regenerate, adopt);
  if (isFinalVideo && card.status === "confirmed") {
    const latestPackage = currentSession?.landingPackages?.find((item) => item.promptCardId === card.id);
    const packageButton = element("button", "landing-package-button", "一键打包落地页"); packageButton.type = "button"; packageButton.disabled = disabled;
    packageButton.addEventListener("click", async () => {
      try {
        packageButton.disabled = true; packageButton.textContent = "正在压缩并打包…";
        const result = await api(`/api/creative/sessions/${sessionId}/cards/${encodeURIComponent(card.id)}/package-landing-page`, { method: "POST" });
        await refreshSession();
        location.href = result.downloadUrl;
      } catch (error) {
        packageButton.disabled = false; packageButton.textContent = "重新打包落地页"; alert(`落地页打包失败：${error.message}`);
      }
    });
    actions.append(packageButton);
    if (latestPackage) {
      const download = element("a", "landing-package-download", `下载最近的落地页包 · ${latestPackage.appName}`);
      download.href = latestPackage.downloadUrl; download.download = latestPackage.fileName;
      actions.append(download);
    }
  }
  editor.append(feedback, actions); node.append(editor);
  return node;
}

function layoutWorkflowNodes(flow) {
  const nodes = [...flow.querySelectorAll(":scope > .workflow-node")];
  const positionFor = (index) => {
    const row = Math.floor(index / 2) + 1;
    const positionInRow = index % 2;
    const column = row % 2 === 1 ? positionInRow + 1 : 2 - positionInRow;
    return { row, column };
  };
  nodes.forEach((node, index) => {
    const position = positionFor(index);
    node.style.gridRow = String(position.row);
    node.style.gridColumn = String(position.column);
    node.classList.remove("flow-right", "flow-left", "flow-down", "flow-end");
    const next = nodes[index + 1];
    if (!next) return node.classList.add("flow-end");
    const nextPosition = positionFor(index + 1);
    if (nextPosition.row > position.row) node.classList.add("flow-down");
    else node.classList.add(nextPosition.column > position.column ? "flow-right" : "flow-left");
  });
}

function inferCreativeStage(session, workspace) {
  if (session.stage !== "working") return session.stage;
  const latestCards = [...(session.messages || [])].reverse().find((message) => message.cards?.length)?.cards || [];
  if (latestCards.some((card) => card.kind === "video_prompt")) return "prompt_review";
  if (latestCards.some((card) => card.kind === "storyboard")) return "storyboard_review";
  if (latestCards.some((card) => ["character_image", "prop_image", "reference_image"].includes(card.kind))) return "reference_review";
  if (latestCards.some((card) => card.kind === "final_card")) return "final_card_review";
  return workspace?.selectedConceptIds?.length ? "concept_selected" : "concept_review";
}

function currentStagePresentation(session, workspace) {
  const stage = inferCreativeStage(session, workspace);
  const latestFinalCardSet = [...(session.messages || [])]
    .reverse()
    .map((message) => (message.cards || []).filter((card) => card.kind === "final_card"))
    .find((cards) => cards.length) || [];
  const hasGeneratedFinalCard = latestFinalCardSet.some((card) => Boolean(card.previewUrl));
  return ({
    concept_review: { stage, title: "创意方案候选", heading: "正在讨论的创意方向", kind: "concept", statusKey: "" },
    concept_selected: { stage, title: "已选方案深化", heading: "已选创意与落版准备", kind: "concept", statusKey: "finalCardStatus" },
    final_card_review: {
      stage,
      title: hasGeneratedFinalCard ? "确认落版图" : "确认落版方案",
      heading: hasGeneratedFinalCard ? "落版图已生成" : "落版图方案待确认",
      kind: "final_card",
      statusKey: "finalCardStatus",
    },
    reference_review: { stage, title: "人物与参考图", heading: "人物、道具与参考图", kind: "reference_image", statusKey: "referenceStatus" },
    storyboard_review: { stage, title: "剧情与分镜", heading: "视频剧情与分镜候选", kind: "storyboard", statusKey: "videoPromptStatus" },
    prompt_review: { stage, title: "视频提示词审核", heading: "正在讨论的视频提示词", kind: "video_prompt", statusKey: "videoPromptStatus" },
    ready_to_generate: { stage, title: "视频生成确认", heading: "等待确认的视频生成方案", kind: "video_prompt", statusKey: "videoGenerationStatus" },
    video_review: { stage, title: "视频成片复审", heading: "已生成的视频", kind: "video_prompt", statusKey: "videoGenerationStatus" },
  })[stage] || { stage, title: "当前创作", heading: "当前创作内容", kind: "generic", statusKey: "" };
}

function renderAssetLibrary(assets, screenshots, disabled) {
  const section = element("section", "asset-library");
  const heading = element("div", "asset-library-heading");
  const copy = element("div");
  copy.append(element("small", "", "ASSETS"), element("h2", "", "资产区域"), element("p", "", "聊天时可直接说“图片 04”或组合多个图片编号。"));
  heading.append(copy, element("span", "asset-count", `${assets.length + screenshots.length} 项`));
  section.append(heading);
  section.append(element("h3", "asset-zone-title", "生成图片"));
  const grid = element("div", "asset-library-grid");
  assets.forEach((asset) => {
    const card = element("article", "asset-library-card");
    const media = element("button", "asset-library-media"); media.type = "button"; media.setAttribute("aria-label", `查看大图：${asset.reference} ${asset.title}`);
    const image = element("img"); image.src = asset.url; image.alt = `${asset.reference} ${asset.title}`; image.loading = "lazy"; media.append(image);
    media.addEventListener("click", () => openImagePreview(asset.url, `${asset.reference} · ${asset.title}`));
    const body = element("div", "asset-library-body");
    const top = element("div", "asset-library-card-heading"); top.append(element("b", "asset-number", asset.reference), element("small", "", `V${asset.version || 1}`));
    body.append(top, element("strong", "", asset.title), element("p", "", asset.description));
    const use = element("button", "asset-use-button", `引用 ${asset.reference}`); use.type = "button";
    use.addEventListener("click", () => {
      const input = document.querySelector("#creative-chat-input");
      const prefix = input.value.trim(); input.value = `${prefix}${prefix ? "\n" : ""}使用${asset.reference}（${asset.title}）：`;
      input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    });
    const remove = element("button", "asset-delete-button", `删除 ${asset.reference}`); remove.type = "button"; remove.disabled = disabled;
    remove.addEventListener("click", async () => {
      if (!window.confirm(`从当前工作台资产区删除${asset.reference}？\n\n编号不会重排；历史聊天和远程原文件会保留。`)) return;
      try {
        remove.disabled = true; remove.textContent = "正在删除…";
        await api(`/api/creative/sessions/${sessionId}/assets/${asset.number}`, { method: "DELETE" });
        await refreshSession();
      } catch (error) { remove.disabled = false; remove.textContent = `删除 ${asset.reference}`; alert(error.message); }
    });
    const revision = element("div", "asset-revision");
    const feedback = element("textarea", "asset-feedback"); feedback.rows = 2; feedback.placeholder = `对${asset.reference}提出修改；可引用其他图片或截图…`; feedback.disabled = disabled;
    const regenerate = element("button", "asset-regenerate", "按意见重新生成"); regenerate.type = "button"; regenerate.disabled = disabled;
    regenerate.addEventListener("click", async () => {
      const instruction = feedback.value.trim(); if (!instruction) return feedback.focus();
      try {
        regenerate.disabled = true; regenerate.textContent = "正在提交…";
        await api(`/api/creative/sessions/${sessionId}/assets/${asset.number}/regenerate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: instruction }) });
        await refreshSession();
      } catch (error) { regenerate.disabled = false; regenerate.textContent = "按意见重新生成"; alert(error.message); }
    });
    revision.append(feedback);
    addAnnotationButton(revision, asset.url, `${asset.reference} ${asset.title}`, feedback, disabled);
    revision.append(regenerate);
    const actions = element("div", "asset-actions"); actions.append(use, remove);
    body.append(actions, revision); card.append(media, body); grid.append(card);
  });
  const createCard = element("article", "asset-library-card asset-create-card");
  const createMedia = element("div", "asset-library-media asset-create-media");
  createMedia.append(element("span", "asset-create-plus", "+"), element("strong", "", "添加图片"), element("small", "", "根据文字描述生成"));
  const createBody = element("div", "asset-library-body");
  const description = element("textarea", "asset-feedback asset-create-description"); description.rows = 4; description.placeholder = "描述想生成的图片；也可以引用图片 04、截图 08…"; description.disabled = disabled;
  const generate = element("button", "asset-regenerate asset-create-generate", "生成图片"); generate.type = "button"; generate.disabled = disabled;
  generate.addEventListener("click", async () => {
    const instruction = description.value.trim(); if (!instruction) return description.focus();
    try {
      generate.disabled = true; generate.textContent = "正在提交…";
      await api(`/api/creative/sessions/${sessionId}/assets/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: instruction }) });
      await refreshSession();
    } catch (error) { generate.disabled = false; generate.textContent = "生成图片"; alert(error.message); }
  });
  createBody.append(description, generate); createCard.append(createMedia, createBody); grid.append(createCard);
  section.append(grid);
  const screenshotHeading = element("div", "asset-screenshot-heading");
  screenshotHeading.append(element("h3", "asset-zone-title", "视频截图区"), element("span", "asset-count", `${screenshots.length} 张`));
  section.append(screenshotHeading);
  const screenshotGrid = element("div", "asset-library-grid asset-screenshot-grid");
  screenshots.forEach((asset) => {
    const card = element("article", "asset-library-card screenshot-asset-card");
    const media = element("button", "asset-library-media"); media.type = "button"; media.setAttribute("aria-label", `查看大图：${asset.reference} ${asset.title}`);
    const image = element("img"); image.src = asset.url; image.alt = `${asset.reference} ${asset.title}`; image.loading = "lazy"; media.append(image);
    media.addEventListener("click", () => openImagePreview(asset.url, `${asset.reference} · ${asset.title}`));
    const body = element("div", "asset-library-body");
    const top = element("div", "asset-library-card-heading"); top.append(element("b", "asset-number screenshot-number", asset.reference), element("small", "", `${Number(asset.timestampSeconds || 0).toFixed(2)}s`));
    body.append(top, element("strong", "", asset.title), element("p", "", asset.description));
    const use = element("button", "asset-use-button", `引用 ${asset.reference}`); use.type = "button";
    use.addEventListener("click", () => {
      const input = document.querySelector("#creative-chat-input");
      const prefix = input.value.trim(); input.value = `${prefix}${prefix ? "\n" : ""}使用${asset.reference}（${asset.title}）：`;
      input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    });
    body.append(use); card.append(media, body); screenshotGrid.append(card);
  });
  if (!screenshots.length) screenshotGrid.append(element("p", "asset-library-empty", "短剧分析保存关键帧后，会显示在这个区域。"));
  section.append(screenshotGrid);
  return section;
}

function renderCanvas(session) {
  document.querySelector("#workbench-title").textContent = session.title;
  document.title = `${session.title} · 创意工作台`;
  const status = document.querySelector("#workbench-status");
  status.className = `status ${session.stage === "working" ? "analyzing" : session.stage === "error" ? "failed" : "completed"}`;
  status.textContent = session.stage === "working" ? "Novvy 处理中" : session.stage === "error" ? "需要处理" : "可交互";

  const renderSignature = JSON.stringify([session.stage, session.workspace, session.messages, session.conceptRevisions, session.finalCardRevisions, session.assets, session.screenshots]);
  if (renderSignature === canvasRenderSignature) return;
  canvasRenderSignature = renderSignature;
  document.querySelectorAll("#creative-canvas details[data-canvas-details-key]").forEach((details) => canvasDetailsOpenState.set(details.dataset.canvasDetailsKey, details.open));

  const strip = document.querySelector("#source-strip");
  strip.replaceChildren();
  strip.classList.add("hidden");

  const canvas = document.querySelector("#creative-canvas");
  canvas.replaceChildren();
  const workspace = session.workspace;
  if (!workspace) {
    const loading = element("div", "canvas-loading");
    loading.append(element("div", "loader"), element("strong", "", "正在生成剧游连接与创意方向"), element("p", "", "Novvy 会基于已保存的短剧和游戏分析构建第一版画布。"));
    canvas.append(loading);
    return;
  }

  const confirmedCards = legacyConfirmedCards(workspace);
  const characterCandidates = latestCharacterCandidates(session.messages);
  const hasConfirmedReferenceGroup = confirmedCards.some((card) => card.kind === "reference_panel" && card.status === "confirmed");
  const presentation = currentStagePresentation(session, workspace);
  const flow = element("section", "workflow-flow");
  const sourceNode = element("article", "workflow-node source-workflow-node");
  sourceNode.append(element("div", "workflow-marker", "01"));
  const sourceNodeCard = element("div", "workflow-node-card source-node-card");
  const sourceNodeHeading = element("div", "workflow-node-heading");
  sourceNodeHeading.append(element("div", "", "输入素材"), element("span", "", "已连接"));
  const sourceNodeItems = element("div", "source-node-items");
  [["短剧", "drama", session.drama], ["游戏", "game", session.game]].forEach(([label, type, source]) => {
    const button = element("button", "source-node-item"); button.type = "button";
    button.append(element("small", "", label), element("strong", "", source?.title || "未知"));
    button.addEventListener("click", () => openSourceAnalysis(type, source)); sourceNodeItems.append(button);
  });
  sourceNodeCard.append(sourceNodeHeading, sourceNodeItems); sourceNode.append(sourceNodeCard); flow.append(sourceNode);

  confirmedCards.forEach((card, index) => {
    const node = element("article", `workflow-node confirmed-workflow-node ${card.status}`);
    node.append(element("div", "workflow-marker", `V${index + 1}`));
    const content = element("div", "workflow-node-card"); content.append(renderConfirmedCard(card, false));
    if (card.kind === "reference_panel" && card.status === "confirmed" && characterCandidates.length) content.append(renderCharacterSelectionPanel(session, characterCandidates));
    node.append(content); flow.append(node);
  });

  const generatedVideoShots = latestGeneratedVideoShots(session.messages);
  if (generatedVideoShots.length) flow.append(renderVideoShotWorkflowNode(generatedVideoShots));

  const live = element("article", "workflow-node current-workflow-node");
  live.append(element("div", "workflow-marker current", "●"));
  const liveCard = element("section", "board-section live-board workflow-node-card");
  const liveHeading = element("div", "board-heading");
  const liveCopy = element("div");
  liveCopy.append(element("small", "", "CURRENT"), element("h2", "", presentation.title));
  liveHeading.append(liveCopy, element("span", "board-live", session.stage === "working" ? "Novvy 正在更新" : "可继续修改"));
  liveCard.append(liveHeading);

  const strategy = element("section", "strategy-board");
  [["剧游连接", workspace.connectionThesis], ["目标受众", workspace.audienceStrategy], ["情绪接续", workspace.emotionalContinuity], ["转化策略", workspace.conversionStrategy]].forEach(([label, value]) => {
    const card = element("article");
    card.append(element("small", "", label), element("p", "", value));
    strategy.append(card);
  });
  liveCard.append(strategy);

  const latestCards = [...session.messages].reverse().find((message) => message.cards?.length)?.cards || [];
  const focusKinds = presentation.kind === "reference_image" ? new Set(["character_image", "prop_image", "reference_image"]) : new Set([presentation.kind]);
  const focusCards = latestCards.filter((card) => focusKinds.has(card.kind));
  const focus = element("section", "current-focus");
  focus.append(element("h3", "canvas-heading", presentation.heading));
  if (focusCards.length) {
    const list = element("div", "current-focus-list");
    focusCards.forEach((card) => {
      const item = element("article", "current-focus-card");
      const focusNumber = characterCandidateNumbers[card.id] || card.candidateNumber;
      const focusLabel = card.kind === "character_image" && focusNumber ? `人物候选 ${focusNumber}` : chatCardKindLabels[card.kind] || "候选";
      item.append(element("small", "", focusLabel), element("strong", "", card.title), element("p", "", card.summary));
      if (card.previewUrl) {
        const image = element("img", "current-focus-preview"); image.src = card.previewUrl; image.alt = card.title; image.loading = "lazy";
        item.append(image);
      }
      const revisions = card.kind === "final_card" ? session.finalCardRevisions?.[card.id] || [] : [];
      if (revisions.length > 1) {
        const history = canvasDetails(element("details", "concept-revision-history"), `final-card-history:${card.id}`, false);
        history.append(element("summary", "", `修改历史 · ${revisions.length} 个版本`));
        const chain = element("ol", "concept-revision-chain");
        revisions.forEach((entry) => {
          const revisionItem = element("li", `concept-revision-entry ${entry.status === "generating" ? "generating" : ""}`);
          const revisionHeading = element("div", "concept-revision-heading");
          const time = entry.createdAt ? new Date(entry.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
          const version = element("b", "", `V${entry.version}`);
          if (entry.status === "generating") version.append(element("span", "concept-revision-generating", "生成中"));
          revisionHeading.append(version, element("time", "", time));
          revisionItem.append(revisionHeading, element("strong", "", entry.title));
          if (entry.version > 1) revisionItem.append(element("p", "concept-revision-feedback", `你的意见：${entry.feedback}`));
          revisionItem.append(element("p", "concept-revision-result", entry.summary));
          chain.append(revisionItem);
        });
        history.append(chain);
        item.append(history);
      }
      list.append(item);
    });
    focus.append(list);
  } else if (presentation.statusKey && workspace.productionPlan?.[presentation.statusKey]) {
    focus.append(element("p", "current-focus-status", workspace.productionPlan[presentation.statusKey]));
  }
  liveCard.append(focus);
  if (!hasConfirmedReferenceGroup && characterCandidates.length) liveCard.append(renderCharacterSelectionPanel(session, characterCandidates));

  const concepts = element("div", "concept-grid");
  const hasSelectedConcept = Boolean(workspace.selectedConceptIds?.length);
  (workspace.concepts || []).forEach((concept) => {
    const selected = workspace.selectedConceptIds?.includes(concept.id);
    const card = canvasDetails(element("details", `concept-card has-folding ${selected ? "selected" : ""}`), `concept:${concept.id}`, !hasSelectedConcept || selected);
    const summary = element("summary", "concept-summary");
    const summaryCopy = element("div", "concept-summary-copy");
    summaryCopy.append(element("strong", "", concept.title), element("p", "", concept.tailAdAngle));
    summary.append(element("div", "concept-id", concept.id), summaryCopy, element("span", "concept-fold-label", selected ? "已选方案" : "查看详情"));
    const body = element("div", "concept-body");
    const facts = element("dl");
    [["匹配点", concept.videoMatch], ["玩法卖点", concept.gameplaySellingPoint], ["受众", concept.audience], ["情绪桥", concept.emotionalBridge], ["节奏", concept.rhythm]].forEach(([name, value]) => {
      const row = element("div");
      row.append(element("dt", "", name), element("dd", "", value));
      facts.append(row);
    });
    body.append(facts);
    const revisions = session.conceptRevisions?.[concept.id] || [];
    if (revisions.length > 1) {
      const history = canvasDetails(element("details", "concept-revision-history"), `concept-history:${concept.id}`, false);
      history.append(element("summary", "", `修改历史 · ${revisions.length} 个版本`));
      const chain = element("ol", "concept-revision-chain");
      revisions.forEach((entry) => {
        const item = element("li", `concept-revision-entry ${entry.status === "generating" ? "generating" : ""}`);
        const heading = element("div", "concept-revision-heading");
        const time = entry.createdAt ? new Date(entry.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
        const version = element("b", "", `V${entry.version}`);
        if (entry.status === "generating") version.append(element("span", "concept-revision-generating", "生成中"));
        heading.append(version, element("time", "", time));
        item.append(heading, element("strong", "", entry.title));
        if (entry.version > 1) item.append(element("p", "concept-revision-feedback", `你的意见：${entry.feedback}`));
        item.append(element("p", "concept-revision-result", entry.summary));
        chain.append(item);
      });
      history.append(chain); body.append(history);
    }
    const choose = element("button", "concept-choose", selected ? "已选择" : `选择方案 ${concept.id}`);
    choose.type = "button";
    choose.disabled = session.stage === "working";
    choose.addEventListener("click", () => sendMessage(`选择方案 ${concept.id}，请沿用其余已确认信息继续推进。`));
    const revision = element("div", "concept-revision");
    revision.append(element("label", "", `修改方案 ${concept.id}`));
    const feedback = element("textarea", "concept-feedback");
    feedback.rows = 3;
    feedback.placeholder = `输入对方案 ${concept.id} 的修改意见…`;
    feedback.disabled = session.stage === "working";
    const regenerate = element("button", "concept-regenerate", "重新生成此方案 ↻");
    regenerate.type = "button";
    regenerate.disabled = session.stage === "working";
    regenerate.addEventListener("click", async () => {
      try {
        regenerate.disabled = true;
        regenerate.textContent = "正在提交…";
        const submitted = await regenerateConcept(concept, feedback.value, feedback);
        if (!submitted) {
          regenerate.disabled = false;
          regenerate.textContent = "重新生成此方案 ↻";
        }
      } catch (error) {
        feedback.setCustomValidity(error.message);
        feedback.reportValidity();
        feedback.setCustomValidity("");
        regenerate.disabled = false;
        regenerate.textContent = "重新生成此方案 ↻";
      }
    });
    revision.append(feedback, regenerate);
    body.append(choose, revision);
    card.append(summary, body);
    concepts.append(card);
  });
  const conceptArchive = canvasDetails(element("details", "current-concept-archive"), "concept-archive", presentation.stage === "concept_review");
  conceptArchive.append(element("summary", "", presentation.stage === "concept_review" ? "创意方案候选" : `创意方案回看${workspace.selectedConceptIds?.length ? ` · 已选择 ${workspace.selectedConceptIds.join("、")}` : ""}`), concepts);
  liveCard.append(conceptArchive); live.append(liveCard); flow.append(live);
  layoutWorkflowNodes(flow);
  canvas.append(flow, renderAssetLibrary(session.assets || [], session.screenshots || [], session.stage === "working"));
}

function renderCharacterGroupActions(session) {
  const panel = element("section", "character-group-actions");
  panel.append(element("strong", "", "人物参考图组操作"), element("p", "", "请在每张人物图片下方勾选需要采用的参考图；也可以继续添加新的角度或人物候选。"));
  const approve = element("button", "character-group-approve", `确认选中的人物参考图（${selectedCharacterIds.size} 张）`); approve.type = "button"; approve.dataset.characterApprove = "true"; approve.disabled = session.stage === "working";
  approve.classList.add("workflow-confirm-action"); approve.dataset.workflowStages = "reference_review"; approve.dataset.workflowLabel = "确认选中的人物参考图"; approve.dataset.workflowPriority = "100";
  approve.addEventListener("click", async () => {
    if (!selectedCharacterIds.size) return alert("请先至少勾选一张人物参考图。");
    try {
      approve.disabled = true; approve.textContent = "正在确认…";
      await api(`/api/creative/sessions/${sessionId}/characters/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardIds: [...selectedCharacterIds] }) });
      await refreshSession();
    } catch (error) { approve.disabled = false; approve.textContent = `确认选中的人物参考图（${selectedCharacterIds.size} 张）`; alert(error.message); }
  });
  const add = element("details", "character-add-option");
  add.append(element("summary", "", "+ 添加人物图"));
  const description = element("textarea", "character-add-description"); description.rows = 3; description.placeholder = "例如：增加一张女主左侧 90° 侧脸，保持蓝色礼服和盘发，不要字幕…"; description.disabled = session.stage === "working";
  const generate = element("button", "character-add-generate", "生成人物候选"); generate.type = "button"; generate.disabled = session.stage === "working";
  generate.addEventListener("click", async () => {
    const value = description.value.trim(); if (!value) return description.focus();
    try {
      generate.disabled = true; generate.textContent = "正在创建…";
      await api(`/api/creative/sessions/${sessionId}/characters/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: value }) });
      await refreshSession();
    } catch (error) { generate.disabled = false; generate.textContent = "生成人物候选"; alert(error.message); }
  });
  add.append(description, generate); panel.append(approve, add);
  return panel;
}

function renderStoryboardGroupActions(session, storyboardCards) {
  const panel = element("section", "character-group-actions storyboard-group-actions");
  panel.append(element("strong", "", "逐镜分镜图操作"), element("p", "", "可以继续逐张修改；全部画面符合预期后，统一确认这组分镜图并自动生成视频提示词。"));
  const approve = element("button", "character-group-approve", "统一确认这组分镜图");
  approve.type = "button";
  approve.classList.add("workflow-confirm-action"); approve.dataset.workflowStages = "storyboard_review"; approve.dataset.workflowLabel = "统一确认这组分镜图"; approve.dataset.workflowPriority = "100";
  const failedCards = storyboardCards.filter((card) => !card.previewUrl && card.status !== "generating");
  approve.disabled = session.stage === "working" || !storyboardCards.length || storyboardCards.some((card) => !card.previewUrl || card.status === "generating");
  approve.addEventListener("click", async () => {
    try {
      approve.disabled = true; approve.textContent = "正在确认…";
      await api(`/api/creative/sessions/${sessionId}/storyboards/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardIds: storyboardCards.map((card) => card.id) }) });
      await refreshSession();
    } catch (error) { approve.disabled = false; approve.textContent = "统一确认这组分镜图"; alert(error.message); }
  });
  panel.append(approve);
  if (failedCards.length) {
    const retry = element("button", "character-group-retry", `重试失败的分镜图（${failedCards.length} 张）`); retry.type = "button"; retry.disabled = session.stage === "working";
    retry.addEventListener("click", async () => {
      try {
        retry.disabled = true; retry.textContent = "正在重试…";
        await api(`/api/creative/sessions/${sessionId}/storyboards/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardIds: failedCards.map((card) => card.id) }) });
        await refreshSession();
      } catch (error) { retry.disabled = false; retry.textContent = `重试失败的分镜图（${failedCards.length} 张）`; alert(error.message); }
    });
    panel.append(retry);
  }
  return panel;
}

function renderMessages(session) {
  const root = document.querySelector("#creative-messages");
  const signature = JSON.stringify([session.stage, session.messages]);
  if (signature === chatRenderSignature) return;
  chatRenderSignature = signature;
  const priorScrollTop = root.scrollTop;
  const anchor = [...root.querySelectorAll(":scope > .chat-message")].find((message) => message.getBoundingClientRect().bottom > root.getBoundingClientRect().top);
  const anchorId = anchor?.dataset.messageId || "";
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - root.getBoundingClientRect().top : 0;
  suppressChatScrollTracking = true;
  root.replaceChildren();
  const latestCharacterCards = new Map();
  let characterGroupMessageId = null;
  const latestStoryboardImageCards = new Map();
  let storyboardGroupMessageId = null;
  const mutableCardKinds = new Set(["final_card", "video_prompt", "video_shot"]);
  const latestMutableCardMessageIds = new Map();
  session.messages.forEach((message) => (message.cards || []).forEach((card) => {
    if (card.kind === "character_image") {
      characterGroupMessageId = message.id;
      latestCharacterCards.set(card.id, card);
    }
    if (card.kind === "storyboard_image") {
      storyboardGroupMessageId ??= message.id;
      latestStoryboardImageCards.set(card.id, card);
    }
    if (mutableCardKinds.has(card.kind) && card.id) latestMutableCardMessageIds.set(card.id, message.id);
  }));
  const groupedCharacterCards = [...latestCharacterCards.values()].sort((a, b) => {
    const left = Number(characterCandidateNumbers[a.id] || a.candidateNumber || 999);
    const right = Number(characterCandidateNumbers[b.id] || b.candidateNumber || 999);
    return left - right;
  });
  const visibleCharacterIds = new Set(groupedCharacterCards.filter((card) => card.previewUrl && !["superseded", "failed", "generating"].includes(card.status)).map((card) => card.id));
  for (const id of selectedCharacterIds) if (!visibleCharacterIds.has(id)) selectedCharacterIds.delete(id);
  const groupedStoryboardImageCards = [...latestStoryboardImageCards.values()].sort((a, b) => a.id.localeCompare(b.id));
  const hasPersistedCards = session.messages.some((message) => message.cards?.length);
  const fallbackCardMessageId = !hasPersistedCards ? [...session.messages].reverse().find((message) => message.role === "assistant")?.id : null;
  session.messages.forEach((message) => {
    const bubble = element("article", `chat-message ${message.role}`);
    bubble.dataset.messageId = message.id;
    bubble.append(element("small", "", message.role === "user" ? "你" : "Novvy"), element("p", "", message.content));
    if (message.attachments?.length) bubble.append(renderMessageAttachments(message.attachments));
    const rawCards = message.cards?.length ? message.cards : message.id === fallbackCardMessageId ? conceptChatCards(session.workspace) : [];
    const cards = [
      ...rawCards.filter((card) => card.kind !== "character_image" && card.kind !== "storyboard_image" && (!mutableCardKinds.has(card.kind) || latestMutableCardMessageIds.get(card.id) === message.id)),
      ...(message.id === characterGroupMessageId ? groupedCharacterCards : []),
      ...(message.id === storyboardGroupMessageId ? groupedStoryboardImageCards : []),
    ];
    if (cards.length) {
      bubble.classList.add("has-cards");
      const cardList = element("div", "chat-candidate-list");
      if (cards.some((card) => card.kind === "storyboard_image")) cardList.classList.add("storyboard-image-list");
      cards.forEach((card) => cardList.append(renderChatCard(card, session.stage === "working")));
      if (message.id === characterGroupMessageId && groupedCharacterCards.some((card) => card.previewUrl)) cardList.append(renderCharacterGroupActions(session));
      if (message.id === storyboardGroupMessageId && groupedStoryboardImageCards.length) cardList.append(renderStoryboardGroupActions(session, groupedStoryboardImageCards));
      bubble.append(cardList);
    }
    root.append(bubble);
  });
  if (session.stage === "working") {
    const latestUserMessage = [...session.messages].reverse().find((message) => message.role === "user")?.content || "";
    const bubble = element("article", "chat-message assistant typing");
    bubble.append(element("small", "", "Novvy"), element("p", "", humanThinkingReply(latestUserMessage)));
    root.append(bubble);
  }
  renderCurrentTask(session);
  if (chatFollowLatest) root.scrollTop = root.scrollHeight;
  else if (anchorId) {
    const restoredAnchor = root.querySelector(`.chat-message[data-message-id="${anchorId}"]`);
    if (restoredAnchor) root.scrollTop += restoredAnchor.getBoundingClientRect().top - root.getBoundingClientRect().top - anchorOffset;
    else root.scrollTop = Math.min(priorScrollTop, Math.max(0, root.scrollHeight - root.clientHeight));
  } else root.scrollTop = Math.min(priorScrollTop, Math.max(0, root.scrollHeight - root.clientHeight));
  requestAnimationFrame(() => { suppressChatScrollTracking = false; });
  const disabled = session.stage === "working";
  document.querySelector("#creative-chat-input").disabled = disabled;
  document.querySelector("#creative-send").disabled = disabled;
  document.querySelector("#chat-attachment-input").disabled = disabled;
  document.querySelector("#chat-attachment-button").classList.toggle("disabled", disabled);
}

function renderCurrentTask(session) {
  const panel = document.querySelector("#chat-current-task");
  panel.replaceChildren();
  const stageLabels = {
    ideating: "创意方向", concept_review: "创意方案确认", concept_selected: "落版图准备",
    final_card_review: "落版图确认", reference_review: "人物与参考图确认",
    storyboard_review: "剧情与分镜确认", prompt_review: "视频提示词确认",
    ready_to_generate: "视频生成确认", video_review: "逐镜视频复审", working: "任务处理中",
  };
  const candidates = [...document.querySelectorAll("#creative-messages .workflow-confirm-action")]
    .filter((action) => !action.hidden && String(action.dataset.workflowStages || "").split(/\s+/).includes(session.stage))
    .sort((left, right) => Number(right.dataset.workflowPriority || 0) - Number(left.dataset.workflowPriority || 0));
  const currentAction = candidates[0] || null;
  const copy = element("div", "chat-current-task-copy");
  copy.append(element("small", "", "当前待处理"), element("strong", "", stageLabels[session.stage] || "继续当前创作"));
  const description = session.stage === "working"
    ? "正在处理，完成后会更新当前任务"
    : currentAction ? currentAction.dataset.workflowLabel : "当前没有需要确认才能继续的步骤";
  copy.append(element("p", "", description));
  const button = element("button", "", currentAction ? "定位到待确认步骤" : session.stage === "working" ? "处理中" : "暂无待确认");
  button.type = "button"; button.disabled = !currentAction;
  button.addEventListener("click", () => {
    const target = currentAction.closest(".character-group-actions,.chat-candidate-card,.chat-message") || currentAction;
    if (!target) return;
    document.querySelectorAll(".current-task-highlight").forEach((item) => item.classList.remove("current-task-highlight"));
    target.classList.add("current-task-highlight");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => target.classList.remove("current-task-highlight"), 1800);
  });
  const row = element("div", "chat-current-task-row"); row.append(copy, button); panel.append(row);
}

function humanThinkingReply(message) {
  if (/(可以|能不能|能否|是否).*(反馈|意见|修改|调整)|(反馈|意见).*(修改|调整)/.test(message)) {
    return "当然可以。你把具体反馈告诉我，我会按你的意见修改，并保留原版本方便你随时比较。";
  }
  if (/(修改|调整|改成|换成|不喜欢|反馈)/.test(message)) {
    return "收到，我在仔细看你的修改意见。稍等一下，我会给你一个具体的新版本。";
  }
  if (/(选择|确认|就用|采用)/.test(message)) {
    return "好的，我明白你的选择了。稍等一下，我把确认后的内容完整整理给你。";
  }
  return "我在仔细看你的想法，稍等一下，我马上给你一个具体回复。";
}

function renderError(error) {
  document.querySelector("#workbench-status").className = "status failed";
  document.querySelector("#workbench-status").textContent = "载入失败";
  const canvas = document.querySelector("#creative-canvas");
  canvas.replaceChildren(element("div", "canvas-loading", error.message));
}

async function refreshSession() {
  if (!Number.isInteger(sessionId) || sessionId <= 0) return renderError(new Error("工作台地址无效，请从项目列表重新进入。"));
  try {
    const session = await api(`/api/creative/sessions/${sessionId}`);
    currentSession = session;
    renderCanvas(session);
    renderMessages(session);
    clearTimeout(pollTimer);
    if (session.stage === "working") pollTimer = setTimeout(refreshSession, 1800);
  } catch (error) {
    renderError(error);
  }
}

async function sendMessage(content, attachments = []) {
  if (!content.trim() && !attachments.length) return;
  const options = attachments.length ? (() => {
    const form = new FormData(); form.append("content", content);
    attachments.forEach((file) => form.append("attachments", file, file.name));
    return { method: "POST", body: form };
  })() : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) };
  await api(`/api/creative/sessions/${sessionId}/messages`, options);
  document.querySelector("#creative-chat-input").value = "";
  if (attachments.length) {
    pendingChatFiles.splice(0);
    document.querySelector("#chat-attachment-input").value = "";
    renderPendingChatFiles();
  }
  chatFollowLatest = true;
  await refreshSession();
}

document.querySelector("#creative-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#creative-chat-input");
  try {
    await sendMessage(input.value, [...pendingChatFiles]);
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
    input.setCustomValidity("");
  }
});

document.querySelector("#close-workbench").addEventListener("click", () => {
  window.close();
  setTimeout(() => { location.href = "/"; }, 100);
});

document.querySelector("#source-analysis-close").addEventListener("click", () => document.querySelector("#source-analysis-dialog").close());
document.querySelector("#source-analysis-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.querySelector("#chat-attachment-input").addEventListener("change", (event) => {
  addPendingChatFiles([...event.target.files]);
  event.target.value = "";
});

const chatPanel = document.querySelector(".chat-panel");
const chatDropOverlay = document.querySelector("#chat-drop-overlay");
let chatDragDepth = 0;
function hasDraggedFiles(event) { return [...(event.dataTransfer?.types || [])].includes("Files"); }
function hideChatDropOverlay() {
  chatDragDepth = 0;
  chatPanel.classList.remove("dragging-files");
  chatDropOverlay.setAttribute("aria-hidden", "true");
}
chatPanel.addEventListener("dragenter", (event) => {
  if (!hasDraggedFiles(event) || document.querySelector("#chat-attachment-input").disabled) return;
  event.preventDefault(); chatDragDepth += 1;
  chatPanel.classList.add("dragging-files"); chatDropOverlay.setAttribute("aria-hidden", "false");
});
chatPanel.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event) || document.querySelector("#chat-attachment-input").disabled) return;
  event.preventDefault(); event.dataTransfer.dropEffect = "copy";
});
chatPanel.addEventListener("dragleave", (event) => {
  if (!hasDraggedFiles(event)) return;
  chatDragDepth = Math.max(0, chatDragDepth - 1);
  if (!chatDragDepth) hideChatDropOverlay();
});
chatPanel.addEventListener("drop", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  const disabled = document.querySelector("#chat-attachment-input").disabled;
  const files = [...(event.dataTransfer?.files || [])];
  hideChatDropOverlay();
  if (!disabled) { addPendingChatFiles(files); document.querySelector("#creative-chat-input").focus(); }
});
window.addEventListener("dragend", hideChatDropOverlay);

const chatMessages = document.querySelector("#creative-messages");
chatMessages.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) chatFollowLatest = false;
}, { passive: true });
chatMessages.addEventListener("scroll", () => {
  if (suppressChatScrollTracking) return;
  const distanceFromBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
  chatFollowLatest = distanceFromBottom <= 24;
}, { passive: true });

refreshSession();
