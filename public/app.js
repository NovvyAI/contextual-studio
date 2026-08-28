const form = document.querySelector("#upload-form");
const input = document.querySelector("#video-input");
const dropzone = document.querySelector("#dropzone");
const fileCard = document.querySelector("#file-card");
const fileName = document.querySelector("#file-name");
const fileSize = document.querySelector("#file-size");
const analyzeButton = document.querySelector("#analyze-button");
const message = document.querySelector("#form-message");
const records = document.querySelector("#records");
const emptyState = document.querySelector("#empty-state");
const dramaBrowser = document.querySelector("#drama-browser");
const dramaDetail = document.querySelector("#drama-detail");
const gameForm = document.querySelector("#game-form");
const gameMessage = document.querySelector("#game-form-message");
const gameRecords = document.querySelector("#game-records");
const gameEmptyState = document.querySelector("#game-empty-state");
const gameBrowser = document.querySelector("#game-browser");
const gameDetail = document.querySelector("#game-detail");
let pollTimer;
let gamePollTimer;
let selectedDramaId = null;
let selectedGameId = null;

const sizeLabel = (bytes) => bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const timeLabel = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function analysisSection(title, items, renderItem) {
  const section = element("section", "analysis-section");
  section.append(element("h3", "", title));
  const content = element("div", "analysis-list");
  (items || []).forEach((item, index) => content.append(renderItem(item, index)));
  if (!items?.length) content.append(element("p", "muted", "没有足够证据得出可靠结论。"));
  section.append(content);
  return section;
}

document.querySelectorAll(".tab[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab[data-tab]").forEach((item) => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${tab.dataset.tab}-panel`));
  if (tab.dataset.tab === "game") loadGames();
  if (tab.dataset.tab === "creative") loadCreativeHome();
}));

function renderAnalysis(root, result, screenshots) {
  if (!result?.oneSentenceThesis) return;
  const hook = result.hookAndCliffhanger;
  const hookGrid = element("div", "insight-grid");
  [["开场钩子", hook.openingHook], ["留存机制", hook.retentionMechanism], ["结尾状态", hook.endingState], ["悬念机制", hook.cliffhangerMechanic]].forEach(([label, value]) => {
    const card = element("div", "insight-card"); card.append(element("small", "", label), element("p", "", value)); hookGrid.append(card);
  });
  root.append(hookGrid);

  root.append(analysisSection("剧情时间线", result.chronology, (item) => {
    const row = element("article", "timeline-item");
    const time = element("span", "timeline-time", item.timeRange);
    const copy = element("div", "");
    copy.append(element("strong", "", `${item.beat} · ${item.audienceEmotion}`), element("p", "", item.action), element("small", "", item.decisionOrShift));
    row.append(time, copy); return row;
  }));
  root.append(analysisSection("人物与关系变化", result.characters, (item) => {
    const card = element("article", "character-card");
    card.append(element("strong", "", item.role), element("span", `confidence ${item.confidence}`, item.confidence.replace("strong_inference", "强推断").replace("observed", "已观察").replace("speculative", "推测")), element("p", "", item.appearance), element("dl", "mini-facts"));
    const dl = card.querySelector("dl");
    [["欲望", item.desire], ["脆弱点", item.vulnerability], ["关键选择", item.keyChoice], ["关系变化", item.relationshipMovement]].forEach(([name, value]) => { const line = element("div"); line.append(element("dt", "", name), element("dd", "", value)); dl.append(line); });
    return card;
  }));
  const candidateLabels = { maleFront: "男主 · 正面", maleSide: "男主 · 侧面", femaleFront: "女主 · 正面", femaleSide: "女主 · 侧面" };
  const screenshotMap = new Map((screenshots || []).map((shot) => [shot.id, shot]));
  root.append(analysisSection("主人公参考截图", Object.entries(result.referenceImageCandidates || {}), ([slot, candidate]) => {
    const card = element("article", `reference-card ${candidate.available ? "" : "missing"}`);
    const shot = screenshotMap.get(candidate.screenshotId);
    if (candidate.available && shot) {
      const image = element("img"); image.src = shot.url; image.alt = candidateLabels[slot]; card.append(image);
    } else {
      card.append(element("div", "reference-placeholder", "暂无可靠画面"));
    }
    const copy = element("div", "reference-copy");
    copy.append(element("strong", "", candidateLabels[slot] || slot), element("span", `candidate-confidence ${candidate.confidence}`, candidate.confidence), element("p", "", candidate.available ? candidate.visibleFeatures : "当前采样画面中没有可靠候选"), element("small", "", candidate.selectionReason));
    if (candidate.risks?.length) copy.append(element("div", "candidate-risk", candidate.risks.join("；")));
    card.append(copy); return card;
  }));
  root.append(analysisSection("观众情绪曲线", result.emotionalCurve, (item) => {
    const row = element("article", "emotion-item"); row.append(element("span", "timeline-time", item.timeRange), element("strong", "", item.audienceEmotion), element("p", "", `${item.stimulus} → ${item.viewingImpulse}`)); return row;
  }));
  if (result.keyDialogue?.some((item) => item.verification !== "unavailable")) root.append(analysisSection("关键对白", result.keyDialogue.filter((item) => item.verification !== "unavailable"), (item) => {
    const quote = element("blockquote", "dialogue"); quote.append(element("p", "", `“${item.line}”`), element("footer", "", `${item.timeRange} · ${item.dramaticMeaning}`)); return quote;
  }));
  root.append(analysisSection("视听母题", result.motifs, (item) => {
    const card = element("article", "motif-card"); card.append(element("strong", "", item.element), element("p", "", item.appearance), element("small", "", `${item.narrativeMeaning} · ${item.reusePotential}`)); return card;
  }));
  root.append(analysisSection("片尾创意衔接机会", result.creativeHandoff.transitionOpportunities, (item) => {
    const card = element("article", "opportunity-card"); card.append(element("strong", "", item.name), element("p", "", item.sourceMoment), element("ul", ""));
    const ul = card.querySelector("ul"); [item.emotionalBridge, item.visualBridge, item.causalBridge].forEach((value) => ul.append(element("li", "", value))); return card;
  }));
  const notes = element("section", "analysis-section confidence-notes");
  notes.append(element("h3", "", `置信度：${result.confidence.overall}`));
  const noteList = element("ul"); [...result.confidence.strongInferences, ...result.confidence.limitations].forEach((value) => noteList.append(element("li", "", value))); notes.append(noteList); root.append(notes);
}

function selectFile(file) {
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  fileName.textContent = file.name;
  fileSize.textContent = `${sizeLabel(file.size)} · ${file.type || "video"}`;
  fileCard.classList.remove("hidden");
  dropzone.classList.add("has-file");
  analyzeButton.disabled = false;
  message.textContent = "";
}

input.addEventListener("change", () => selectFile(input.files[0]));
["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
  event.preventDefault(); dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
  event.preventDefault(); dropzone.classList.remove("dragging");
}));
dropzone.addEventListener("drop", (event) => selectFile(event.dataTransfer.files[0]));
document.querySelector("#remove-file").addEventListener("click", () => {
  input.value = ""; fileCard.classList.add("hidden"); dropzone.classList.remove("has-file"); analyzeButton.disabled = true;
});

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function archiveListItem(item, selected, type) {
  const button = element("button", `archive-item ${selected ? "selected" : ""}`);
  const heading = element("div", "archive-item-heading");
  heading.append(element("strong", "", type === "drama" ? item.title : item.result?.products?.[0]?.productName || item.result?.storeFacts?.productName || item.title || "待识别游戏"));
  const status = element("span", `status ${item.status}`, ({ uploaded: "等待", analyzing: "分析中", completed: "完成", failed: "失败" })[item.status] || item.status);
  heading.append(status);
  const summary = type === "drama" ? item.result?.oneSentenceThesis || item.result?.seriesAnalysis?.oneLineSeriesSummary : item.result?.products?.[0]?.descriptionSummary || item.result?.productThesis;
  button.append(heading, element("p", "", summary || item.errorMessage || "等待分析结果"), element("small", "", new Date(item.createdAt).toLocaleString("zh-CN")));
  return button;
}

function renderDramaDetail(item) {
  dramaDetail.replaceChildren();
  if (!item) return;
  const node = document.querySelector("#record-template").content.cloneNode(true);
  node.querySelector(".record-title").textContent = item.title;
  node.querySelector(".record-meta").textContent = `${new Date(item.createdAt).toLocaleString("zh-CN")} · ${sizeLabel(item.fileSize)}`;
  const status = node.querySelector(".status"); status.className = `status ${item.status}`;
  status.textContent = ({ uploaded: "等待分析", analyzing: "分析中", completed: "已完成", failed: "失败" })[item.status] || item.status;
  node.querySelector("video").src = item.videoUrl;
  node.querySelector(".thesis").textContent = item.result?.oneSentenceThesis || item.errorMessage || (item.status === "analyzing" ? "模型正在理解剧情、人物与情绪变化…" : "等待开始分析");
  node.querySelector(".synopsis").textContent = item.result?.synopsis || "完成后将在这里显示短剧剧情分析。";
  renderAnalysis(node.querySelector(".analysis-content"), item.result, item.screenshots);
  dramaDetail.append(node);
}

function render(items) {
  records.replaceChildren();
  const hasItems = items.length > 0;
  emptyState.classList.toggle("hidden", hasItems);
  dramaBrowser.classList.toggle("hidden", !hasItems);
  if (hasItems && !items.some((item) => item.id === selectedDramaId)) selectedDramaId = items[0].id;
  for (const item of items) {
    const button = archiveListItem(item, item.id === selectedDramaId, "drama");
    button.addEventListener("click", () => { selectedDramaId = item.id; render(items); });
    records.append(button);
  }
  renderDramaDetail(items.find((item) => item.id === selectedDramaId));
  const active = items.some((item) => item.status === "analyzing");
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(loadRecords, 1500);
}

async function loadRecords() {
  try { render((await api("/api/dramas")).items); } catch (error) { message.textContent = error.message; }
}

function renderGameAnalysis(root, result) {
  if (result?.products?.[0]) {
    const product = result.products[0];
    const truth = product.productTruth;
    root.append(analysisSection("产品真实性", [["首次核心体验", truth.firstCoreExperience], ["核心动作", truth.coreAction], ["操作对象", truth.operationObject], ["即时反馈", truth.immediateFeedback], ["早期结果", truth.earlyOutcome], ["商店首屏承诺", truth.storefrontPromise]], ([label, value]) => { const row = element("article", "product-structure-row"); row.append(element("strong", "", label), element("p", "", value || "unknown")); return row; }));
    root.append(analysisSection("核心卖点", product.coreSellingPoints, (value) => { const card = element("article", "selling-point"); card.append(element("strong", "", value)); return card; }));
    const audience = product.audience;
    root.append(analysisSection("目标受众", [["年龄", audience.ageRange], ["性别倾向", audience.genderSkew], ["兴趣", audience.interestGroups.join("、")], ["轻度/核心", audience.casualOrHardcore], ["地区语言", audience.regionLanguageFit]], ([label, value]) => { const card = element("article", "conclusion-row"); card.append(element("small", "", label), element("p", "", value || "unknown")); return card; }));
    root.append(analysisSection("市场传达", [["核心承诺", product.marketMessage.promise], ["利益点", product.marketMessage.benefitPoints.join("；")], ["CTA 方向", product.marketMessage.ctaDirections.join("；")]], ([label, value]) => { const card = element("article", "motif-card"); card.append(element("strong", "", label), element("p", "", value)); return card; }));
    root.append(analysisSection("转化信号", product.conversionSignals, (value) => { const card = element("article", "opportunity-card"); card.append(element("p", "", value)); return card; }));
    if (product.risks.length || result.unknowns?.length) root.append(analysisSection("风险与未知项", [...product.risks, ...(result.unknowns || [])], (value) => { const card = element("article", "conclusion-row"); card.append(element("p", "", value)); return card; }));
    return;
  }
  if (!result?.productThesis) return;
  const facts = result.storeFacts;
  const factsGrid = element("div", "insight-grid game-facts");
  [["开发者", facts.developer], ["品类", facts.category], ["评分", facts.rating], ["更新", facts.updateDate]].forEach(([label, value]) => {
    const card = element("div", "insight-card"); card.append(element("small", "", label), element("p", "", value || "未知")); factsGrid.append(card);
  });
  root.append(factsGrid);
  const structure = result.productStructure;
  root.append(analysisSection("产品玩法结构", [["原子操作", structure.atomicInput], ["移动规则", structure.moveRules], ["成功条件", structure.successCondition], ["失败压力", structure.failurePressure], ["即时反馈", structure.immediateFeedback], ["关卡循环", structure.levelLoop], ["Meta 循环", structure.metaLoop], ["经济与变现", structure.economyAndMonetization]], ([label, value]) => {
    const row = element("article", "product-structure-row"); row.append(element("strong", "", label), element("p", "", value)); return row;
  }));
  root.append(analysisSection("核心卖点", result.sellingPoints, (item) => {
    const card = element("article", "selling-point");
    card.append(element("span", "selling-rank", `0${item.rank}`), element("strong", "", item.promise), element("p", "", item.evidence), element("small", "", `${item.conversionReason} · 风险：${item.limitation}`));
    const scores = element("div", "score-row"); [["真实", item.truthScore], ["可演示", item.demonstrabilityScore], ["差异", item.distinctivenessScore], ["情绪", item.emotionalPullScore], ["深度", item.depthScore]].forEach(([name, score]) => scores.append(element("span", "", `${name} ${score}/5`))); card.append(scores); return card;
  }));
  const audience = result.audience;
  const audienceCard = element("article", "audience-card");
  audienceCard.append(element("strong", "", `${audience.ageRange} · ${audience.casualOrHardcore}`), element("p", "", audience.motivations.join("；")), element("small", "", `兴趣：${audience.interestGroups.join("、") || "未知"}`));
  root.append(analysisSection("目标受众", [audienceCard], (item) => item));
  root.append(analysisSection("商店创意系统", [["Icon", result.storeCreative.icon], ["素材漏斗", result.storeCreative.galleryFunnel.join(" → ")], ["色彩与 UI", result.storeCreative.paletteAndUi], ["玩法与包装", result.storeCreative.gameplayVsWrapper], ["预期风险", result.storeCreative.expectationRisk]], ([label, value]) => {
    const card = element("article", "motif-card"); card.append(element("strong", "", label), element("p", "", value)); return card;
  }));
  root.append(analysisSection("可测试获客方向", result.acquisitionDirections, (item) => {
    const card = element("article", "opportunity-card"); card.append(element("strong", "", item.name), element("p", "", item.hook), element("ul"));
    [item.demonstratedMechanic, item.payoff, `目标情绪：${item.audienceEmotion}`, `保真风险：${item.fidelityRisk}`].forEach((value) => card.querySelector("ul").append(element("li", "", value))); return card;
  }));
  const conclusion = result.strategicConclusion;
  root.append(analysisSection("策略结论", [["最强承诺", conclusion.strongestPromise], ["必须展示的玩法", conclusion.mustShowMechanic], ["最佳情绪包装", conclusion.bestWrapper], ["最大风险", conclusion.largestRisk]], ([label, value]) => {
    const card = element("article", "conclusion-row"); card.append(element("small", "", label), element("p", "", value)); return card;
  }));
  if (result.evidenceNotes?.sources?.length) root.append(analysisSection("证据来源", result.evidenceNotes.sources, (item) => {
    const link = element("a", "source-link", item.label || item.url); link.href = item.url; link.target = "_blank"; link.rel = "noreferrer"; return link;
  }));
}

function renderGameDetail(item) {
  gameDetail.replaceChildren();
  if (!item) return;
  const node = document.querySelector("#game-record-template").content.cloneNode(true);
  node.querySelector(".record-title").textContent = item.result?.products?.[0]?.productName || item.result?.storeFacts?.productName || item.title || "待识别游戏";
  node.querySelector(".record-meta").textContent = `${item.platform === "google_play" ? "Google Play" : "Apple App Store"} · ${new Date(item.createdAt).toLocaleString("zh-CN")}`;
  const status = node.querySelector(".status"); status.className = `status ${item.status}`;
  status.textContent = ({ uploaded: "等待分析", analyzing: "分析中", completed: "已完成", failed: "失败" })[item.status] || item.status;
  node.querySelector(".game-thesis").textContent = item.result?.products?.[0]?.descriptionSummary || item.result?.productThesis || item.errorMessage || (item.status === "analyzing" ? "Novvy 正在核验产品信息并分析游戏…" : "等待开始分析");
  node.querySelector(".game-message").textContent = item.result?.products?.[0]?.marketMessage?.promise || item.result?.marketMessage?.promise || "完成后将在这里显示产品定位与市场传达。";
  renderGameAnalysis(node.querySelector(".game-analysis-content"), item.result);
  gameDetail.append(node);
}

function renderGames(items) {
  gameRecords.replaceChildren();
  const hasItems = items.length > 0;
  gameEmptyState.classList.toggle("hidden", hasItems);
  gameBrowser.classList.toggle("hidden", !hasItems);
  if (hasItems && !items.some((item) => item.id === selectedGameId)) selectedGameId = items[0].id;
  for (const item of items) {
    const button = archiveListItem(item, item.id === selectedGameId, "game");
    button.addEventListener("click", () => { selectedGameId = item.id; renderGames(items); });
    gameRecords.append(button);
  }
  renderGameDetail(items.find((item) => item.id === selectedGameId));
  const active = items.some((item) => item.status === "analyzing");
  clearTimeout(gamePollTimer);
  if (active) gamePollTimer = setTimeout(loadGames, 1800);
}

async function loadGames() {
  try { renderGames((await api("/api/games")).items); } catch (error) { gameMessage.textContent = error.message; }
}

const creativeEntryMessage = document.querySelector("#creative-entry-message");
const novvyProductButton = document.querySelector("#novvy-product-button");
const novvyProductCatalog = document.querySelector("#novvy-product-catalog");

async function waitForCatalogGame(gameId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const game = await api(`/api/games/${gameId}`);
    if (game.status === "completed") {
      await loadCreativeHome();
      document.querySelector("#creative-game-select").value = String(gameId);
      creativeEntryMessage.textContent = `“${game.result?.products?.[0]?.productName || game.result?.storeFacts?.productName || game.title || "所选游戏"}”分析完成，已经选入工作台。`;
      return;
    }
    if (game.status === "failed") throw new Error(game.errorMessage || "游戏分析失败");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("游戏仍在分析中，可以稍后刷新创意工作台页面继续选择");
}

function renderNovvyProductCatalog(items) {
  novvyProductCatalog.replaceChildren();
  const heading = element("div", "product-catalog-head");
  heading.append(element("strong", "", "Novvy 产品库"), element("span", "", `${items.length} 个可选游戏`));
  const grid = element("div", "product-catalog-grid");
  items.forEach((product) => {
    const card = element("article", "product-catalog-card");
    if (product.iconUrl) { const icon = element("img"); icon.src = product.iconUrl; icon.alt = ""; card.append(icon); }
    else card.append(element("div", "product-icon-placeholder"));
    const copy = element("div", "product-catalog-copy");
    copy.append(element("strong", "", product.productName), element("small", "", [product.os, product.categoryZh].filter(Boolean).join(" · ") || "平台未知"), element("span", "", product.description || product.landingUrl));
    const choose = element("button", "", "选择并分析"); choose.type = "button";
    choose.addEventListener("click", async () => {
      choose.disabled = true; choose.textContent = "正在创建…";
      creativeEntryMessage.textContent = `正在分析“${product.productName}”，完成后会自动选中。`;
      try {
        const created = await api("/api/games", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storeUrl: product.landingUrl, title: product.productName, product }) });
        if (created.status !== "completed" && created.status !== "analyzing") await api(`/api/games/${created.id}/analyze`, { method: "POST" });
        novvyProductCatalog.classList.add("hidden");
        await waitForCatalogGame(created.id);
      } catch (error) {
        creativeEntryMessage.textContent = error.message;
        choose.disabled = false; choose.textContent = "选择并分析";
      }
    });
    card.append(copy, choose); grid.append(card);
  });
  if (!items.length) grid.append(element("p", "muted", "Novvy 产品库当前没有返回可用的商店地址。"));
  novvyProductCatalog.append(heading, grid);
}

novvyProductButton.addEventListener("click", async () => {
  if (!novvyProductCatalog.classList.contains("hidden")) { novvyProductCatalog.classList.add("hidden"); return; }
  novvyProductButton.disabled = true;
  creativeEntryMessage.textContent = "正在读取 Novvy 产品库…";
  try {
    const result = await api("/api/novvy/products");
    renderNovvyProductCatalog(result.items || []);
    novvyProductCatalog.classList.remove("hidden");
    creativeEntryMessage.textContent = "选择一个游戏后会先完成游戏分析，再自动加入工作台选择。";
  } catch (error) { creativeEntryMessage.textContent = error.message; }
  finally { novvyProductButton.disabled = false; }
});

function fillSelect(select, items, placeholder) {
  const current = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  items.forEach((item) => select.append(new Option(item.title, item.id)));
  if (items.some((item) => String(item.id) === current)) select.value = current;
}

function renderSessionList(items) {
  const list = document.querySelector("#creative-session-list"); list.replaceChildren();
  if (!items.length) { list.append(element("p", "muted", "还没有创意工作台。先从上方选择短剧和游戏开始。")); return; }
  items.forEach((session) => {
    const button = element("button", "session-card");
    button.append(element("span", `status ${session.stage === "working" ? "analyzing" : "completed"}`, session.stage === "working" ? "处理中" : "继续创作"), element("strong", "", session.title), element("p", "", session.workspace?.connectionThesis || "正在建立剧游连接…"), element("small", "", new Date(session.updatedAt).toLocaleString("zh-CN")));
    button.addEventListener("click", () => openCreativeSession(session.id)); list.append(button);
  });
}

async function loadCreativeHome() {
  try {
    const [sources, sessions] = await Promise.all([api("/api/creative/sources"), api("/api/creative/sessions")]);
    fillSelect(document.querySelector("#creative-drama-select"), sources.dramas, sources.dramas.length ? "请选择短剧" : "暂无已完成短剧");
    fillSelect(document.querySelector("#creative-game-select"), sources.games, sources.games.length ? "请选择游戏" : "暂无已完成游戏");
    document.querySelector("#creative-create-button").disabled = !sources.dramas.length || !sources.games.length;
    renderSessionList(sessions.items);
  } catch (error) { creativeEntryMessage.textContent = error.message; }
}

function openCreativeSession(id) {
  const opened = window.open("about:blank", "_blank");
  if (!opened) {
    creativeEntryMessage.textContent = "浏览器阻止了新页面，请允许本站打开新标签页。";
    return;
  }
  opened.opener = null;
  opened.location.replace(`/workbench.html#${id}`);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  analyzeButton.disabled = true;
  analyzeButton.querySelector("span").textContent = "正在上传…";
  message.textContent = "视频上传完成后会自动开始分析。";
  try {
    const created = await api("/api/dramas", { method: "POST", body: new FormData(form) });
    await api(`/api/dramas/${created.id}/analyze`, { method: "POST" });
    form.reset(); fileCard.classList.add("hidden"); dropzone.classList.remove("has-file");
    message.textContent = "已创建分析任务，结果会自动刷新。";
    await loadRecords();
  } catch (error) {
    message.textContent = error.message;
    analyzeButton.disabled = false;
  } finally {
    analyzeButton.querySelector("span").textContent = "开始分析";
  }
});

document.querySelector("#refresh-button").addEventListener("click", loadRecords);
gameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#game-analyze-button"); button.disabled = true; button.querySelector("span").textContent = "正在创建…";
  gameMessage.textContent = "创建后将由 Novvy 在后台完成商店与玩法分析。";
  try {
    const created = await api("/api/games", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storeUrl: document.querySelector("#game-url").value, title: document.querySelector("#game-title").value }) });
    if (created.status !== "completed" && created.status !== "analyzing") await api(`/api/games/${created.id}/analyze`, { method: "POST" });
    gameForm.reset(); gameMessage.textContent = "已创建游戏分析任务，结果会自动刷新。"; await loadGames();
  } catch (error) { gameMessage.textContent = error.message; }
  finally { button.disabled = false; button.querySelector("span").textContent = "开始分析游戏"; }
});
document.querySelector("#game-refresh-button").addEventListener("click", loadGames);

document.querySelector("#creative-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const newPage = window.open("about:blank", "_blank");
  if (!newPage) {
    creativeEntryMessage.textContent = "浏览器阻止了新页面，请允许本站打开新标签页。";
    return;
  }
  newPage.opener = null;
  const button = document.querySelector("#creative-create-button");
  button.disabled = true;
  creativeEntryMessage.textContent = "正在创建工作台并建立第一版剧游连接…";
  try {
    const session = await api("/api/creative/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dramaId: document.querySelector("#creative-drama-select").value,
        gameId: document.querySelector("#creative-game-select").value,
      }),
    });
    creativeEntryMessage.textContent = "";
    newPage.location.replace(`/workbench.html#${session.id}`);
  } catch (error) {
    newPage.close();
    creativeEntryMessage.textContent = error.message;
    button.disabled = false;
  }
});

loadRecords();
