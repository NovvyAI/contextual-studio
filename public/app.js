const records = document.querySelector("#records");
const emptyState = document.querySelector("#empty-state");
const dramaBrowser = document.querySelector("#drama-browser");
const dramaDetail = document.querySelector("#drama-detail");
const message = document.querySelector("#form-message");
const gameRecords = document.querySelector("#game-records");
const gameEmptyState = document.querySelector("#game-empty-state");
const gameBrowser = document.querySelector("#game-browser");
const gameDetail = document.querySelector("#game-detail");
const gameMessage = document.querySelector("#game-form-message");
const creativeEntryMessage = document.querySelector("#creative-entry-message");

let dramaItems = [];
let gameItems = [];
let selectedDramaId = "";
let selectedGameId = "";
let dramaLoadSequence = 0;
let gameLoadSequence = 0;
const dramaDetails = new Map();
const gameDetails = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateLabel(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}

async function api(url, options) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data?.error?.message || data?.error || "请求失败");
  return data;
}

function analysisSection(title, items, renderItem) {
  if (!items?.length) return null;
  const section = element("section", "analysis-section");
  section.append(element("h3", "", title));
  const content = element("div", "analysis-list");
  items.forEach((item, index) => content.append(renderItem(item, index)));
  section.append(content);
  return section;
}

function appendSection(root, section) {
  if (section) root.append(section);
}

function dramaAnalysisView(result = {}) {
  result = result && typeof result === "object" ? result : {};
  const episode = result.contract === "novvy.video-analysis.v3" && Array.isArray(result.episodeAnalyses) ? result.episodeAnalyses.at(-1) || {} : {};
  const detailed = episode.detailedAnalysis || {};
  const notes = detailed.confidenceNotes || {};
  return {
    oneSentenceThesis: detailed.oneSentenceThesis || episode.oneLineSummary || "",
    synopsis: detailed.synopsis || "",
    chronology: detailed.chronology || [], characters: detailed.characters || [], emotionalCurve: detailed.emotionalCurve || [], keyDialogue: detailed.keyDialogue || [], motifs: detailed.motifs || [],
    hookAndCliffhanger: detailed.hookAndCliffhanger || {}, creativeHandoff: detailed.creativeHandoff || { transitionOpportunities: [] }, characterLibrary: episode.characterLibrary || { characters: [] },
    confidence: { overall: episode.confidence || "unknown", strongInferences: notes.strongInferences || [], limitations: notes.limitations || episode.risksAndUncertainties || [] },
  };
}

function renderAnalysis(root, result) {
  const analysis = dramaAnalysisView(result);
  const hookEntries = [["开场钩子", analysis.hookAndCliffhanger.openingHook], ["留存机制", analysis.hookAndCliffhanger.retentionMechanism], ["结尾状态", analysis.hookAndCliffhanger.endingState], ["悬念机制", analysis.hookAndCliffhanger.cliffhangerMechanic]].filter(([, value]) => value);
  if (hookEntries.length) {
    const hookGrid = element("div", "insight-grid");
    hookEntries.forEach(([label, value]) => { const card = element("div", "insight-card"); card.append(element("small", "", label), element("p", "", value)); hookGrid.append(card); });
    root.append(hookGrid);
  }
  appendSection(root, analysisSection("剧情时间线", analysis.chronology, (item) => {
    const row = element("article", "timeline-item"); const copy = element("div");
    copy.append(element("strong", "", item.beat || item.action || "剧情节点"), element("p", "", item.action || ""));
    if (item.decisionOrShift) copy.append(element("small", "", item.decisionOrShift));
    row.append(element("span", "timeline-time", item.timeRange || "整剧"), copy); return row;
  }));
  appendSection(root, analysisSection("人物与关系变化", analysis.characters, (item) => {
    const confidence = String(item.confidence || "unknown"); const card = element("article", "character-card");
    card.append(element("strong", "", item.role || "主要人物"), element("span", `confidence ${confidence}`, confidence.replace("strong_inference", "强推断").replace("observed", "已解析").replace("speculative", "推测")));
    if (item.appearance) card.append(element("p", "", item.appearance));
    const dl = element("dl", "mini-facts");
    [["欲望", item.desire], ["脆弱点", item.vulnerability], ["人物弧光", item.keyChoice], ["关系变化", item.relationshipMovement]].filter(([, value]) => value && value !== "unknown").forEach(([name, value]) => { const line = element("div"); line.append(element("dt", "", name), element("dd", "", value)); dl.append(line); });
    if (dl.children.length) card.append(dl); return card;
  }));
  appendSection(root, analysisSection("主要人物代表帧", analysis.characterLibrary?.characters || [], (character) => {
    const card = element("article", "character-card");
    card.append(element("strong", "", `${character.displayName || character.characterId} · ${character.narrativeRole || "主要人物"}`), element("p", "", character.selectionReason || "来自远端整剧解析"));
    const gallery = element("div", "source-screenshot-grid character-reference-gallery");
    (character.candidates || []).filter((candidate) => candidate.url).forEach((candidate) => { const figure = element("figure", "source-screenshot reference-selected"); const image = element("img"); image.src = candidate.url; image.alt = character.displayName || "人物代表帧"; image.loading = "lazy"; const caption = element("figcaption"); caption.append(element("span", "", candidate.view === "front" ? "代表帧" : candidate.view || "代表帧")); figure.append(image, caption); gallery.append(figure); });
    if (gallery.children.length) card.append(gallery); return card;
  }));
  appendSection(root, analysisSection("观众情绪曲线", analysis.emotionalCurve, (item) => { const row = element("article", "emotion-item"); row.append(element("span", "timeline-time", item.timeRange || ""), element("strong", "", item.audienceEmotion || ""), element("p", "", `${item.stimulus || ""}${item.viewingImpulse ? ` → ${item.viewingImpulse}` : ""}`)); return row; }));
  appendSection(root, analysisSection("关键对白", analysis.keyDialogue.filter((item) => item.verification !== "unavailable"), (item) => { const quote = element("blockquote", "dialogue"); quote.append(element("p", "", `“${item.line || ""}”`), element("footer", "", `${item.timeRange || ""}${item.dramaticMeaning ? ` · ${item.dramaticMeaning}` : ""}`)); return quote; }));
  appendSection(root, analysisSection("主题与标签", analysis.motifs, (item) => { const card = element("article", "motif-card"); card.append(element("strong", "", item.name || item.element || "主题"), element("p", "", item.appearance || item.dramaticMeaning || "")); return card; }));
  appendSection(root, analysisSection("片尾创意衔接机会", analysis.creativeHandoff.transitionOpportunities || [], (item) => { const card = element("article", "opportunity-card"); card.append(element("strong", "", item.name || "衔接机会"), element("p", "", item.sourceMoment || "")); return card; }));
  if (analysis.confidence.limitations.length || analysis.confidence.strongInferences.length) {
    const notes = element("section", "analysis-section confidence-notes"); notes.append(element("h3", "", `证据说明 · ${analysis.confidence.overall}`));
    const list = element("ul"); [...analysis.confidence.strongInferences, ...analysis.confidence.limitations].forEach((value) => list.append(element("li", "", value))); notes.append(list); root.append(notes);
  }
}

function renderGameAnalysis(root, result) {
  const product = result?.products?.[0]; if (!product) return;
  const truth = product.productTruth || {};
  appendSection(root, analysisSection("产品真实性", [["首次核心体验", truth.firstCoreExperience], ["核心动作", truth.coreAction], ["操作对象", truth.operationObject], ["即时反馈", truth.immediateFeedback], ["早期结果", truth.earlyOutcome], ["商店首屏承诺", truth.storefrontPromise]], ([label, value]) => { const row = element("article", "product-structure-row"); row.append(element("strong", "", label), element("p", "", value || "unknown")); return row; }));
  appendSection(root, analysisSection("核心卖点", product.coreSellingPoints || [], (value) => { const card = element("article", "selling-point"); card.append(element("strong", "", value)); return card; }));
  const audience = product.audience || {};
  appendSection(root, analysisSection("目标受众", [["受众描述", audience.ageRange], ["性别倾向", audience.genderSkew], ["兴趣", (audience.interestGroups || []).join("、")], ["轻度/核心", audience.casualOrHardcore], ["地区语言", audience.regionLanguageFit]], ([label, value]) => { const card = element("article", "conclusion-row"); card.append(element("small", "", label), element("p", "", value || "unknown")); return card; }));
  const market = product.marketMessage || {};
  appendSection(root, analysisSection("市场传达", [["核心承诺", market.promise], ["利益点", (market.benefitPoints || []).join("；")], ["CTA 方向", (market.ctaDirections || []).join("；")]], ([label, value]) => { const card = element("article", "motif-card"); card.append(element("strong", "", label), element("p", "", value || "unknown")); return card; }));
  appendSection(root, analysisSection("转化信号", product.conversionSignals || [], (value) => { const card = element("article", "opportunity-card"); card.append(element("p", "", value)); return card; }));
  appendSection(root, analysisSection("风险与未知项", [...(product.risks || []), ...(result.unknowns || [])], (value) => { const card = element("article", "conclusion-row"); card.append(element("p", "", value)); return card; }));
}

function renderMediaGallery(root, media, title) {
  if (!media?.length) { root.replaceChildren(); return; }
  const section = element("section", "remote-media-gallery"); section.append(element("h3", "", title)); const grid = element("div", "remote-media-grid");
  media.forEach((item) => { const figure = element("figure", "remote-media-card"); const image = element("img"); image.src = item.url; image.alt = item.title || title; image.loading = "lazy"; figure.append(image, element("figcaption", "", item.title || "解析图片")); grid.append(figure); });
  section.append(grid); root.replaceChildren(section);
}

function archiveListItem(item, selected, type) {
  const button = element("button", `archive-item remote-archive-item ${selected ? "selected" : ""}`); const imageUrl = type === "drama" ? item.coverImageUrl : item.iconUrl; const thumb = element("div", `remote-list-thumb ${type}`);
  if (imageUrl) { const image = element("img"); image.src = imageUrl; image.alt = ""; image.loading = "lazy"; thumb.append(image); } else thumb.append(element("span", "", type === "drama" ? "DR" : "APP"));
  const copy = element("div", "remote-list-copy"); const heading = element("div", "archive-item-heading"); heading.append(element("strong", "", item.title || item.productName || "未命名"), element("span", "status completed", "完成"));
  const summary = type === "drama" ? `${item.episodeCount || 0} 集 · 整剧解析完成` : `${item.platform || "平台未知"} · ${item.category || "未分类"}`;
  copy.append(heading, element("p", "", summary), element("small", "", dateLabel(item.analyzedAt || item.createdAt))); button.append(thumb, copy); return button;
}

function detailLoading(root, label) { root.replaceChildren(element("div", "detail-loading", `正在读取${label}完整解析…`)); }

function renderDramaDetail(item) {
  dramaDetail.replaceChildren(); if (!item) return;
  const node = document.querySelector("#record-template").content.cloneNode(true); node.querySelector(".record-title").textContent = item.title;
  node.querySelector(".record-meta").textContent = `${item.episodeCount || 0} 集 · 已解析 ${item.episodesAnalyzed || item.episodeCount || 0} 集 · ${dateLabel(item.analyzedAt || item.updatedAt)}`;
  const status = node.querySelector(".status"); status.className = "status completed"; status.textContent = "已完成";
  const cover = node.querySelector(".record-cover"); if (item.coverImageUrl) { cover.src = item.coverImageUrl; cover.classList.add("visible"); node.querySelector(".record-cover-placeholder").classList.add("hidden"); }
  const analysis = dramaAnalysisView(item.result); node.querySelector(".thesis").textContent = analysis.oneSentenceThesis || item.title; node.querySelector(".synopsis").textContent = analysis.synopsis || "远端解析未提供整剧梗概。";
  renderMediaGallery(node.querySelector(".remote-media-section"), (item.media || []).filter((media) => media.kind === "episode_sheet"), "分集解析拼图"); renderAnalysis(node.querySelector(".analysis-content"), item.result); dramaDetail.append(node);
}

function renderGameDetail(item) {
  gameDetail.replaceChildren(); if (!item) return;
  const node = document.querySelector("#game-record-template").content.cloneNode(true); const product = item.result?.products?.[0] || {};
  node.querySelector(".record-title").textContent = item.productName || item.title; node.querySelector(".record-meta").textContent = `${item.platform || "平台未知"} · ${item.category || "未分类"} · ${dateLabel(item.analyzedAt || item.updatedAt)}`;
  const status = node.querySelector(".status"); status.className = "status completed"; status.textContent = "已完成";
  const icon = node.querySelector(".record-app-icon"); if (item.iconUrl) { icon.src = item.iconUrl; icon.classList.add("visible"); node.querySelector(".record-app-placeholder").classList.add("hidden"); }
  node.querySelector(".game-thesis").textContent = product.descriptionSummary || item.title; node.querySelector(".game-message").textContent = product.marketMessage?.promise || product.rawGameplay?.core_loop || "远端解析未提供核心玩法描述。";
  renderMediaGallery(node.querySelector(".remote-media-section"), item.media || [], "商店截图与创意拼图"); renderGameAnalysis(node.querySelector(".game-analysis-content"), item.result); gameDetail.append(node);
}

function filteredDramas() { const query = document.querySelector("#drama-search").value.trim().toLocaleLowerCase(); return query ? dramaItems.filter((item) => item.title.toLocaleLowerCase().includes(query)) : dramaItems; }
function filteredGames() { const query = document.querySelector("#game-search").value.trim().toLocaleLowerCase(); return query ? gameItems.filter((item) => item.title.toLocaleLowerCase().includes(query)) : gameItems; }

function renderDramaList() {
  const items = filteredDramas(); records.replaceChildren(); emptyState.classList.toggle("hidden", Boolean(items.length)); dramaBrowser.classList.toggle("hidden", !items.length);
  if (!items.some((item) => item.id === selectedDramaId)) selectedDramaId = items[0]?.id || "";
  items.forEach((item) => { const button = archiveListItem(item, item.id === selectedDramaId, "drama"); button.addEventListener("click", () => selectDrama(item.id)); records.append(button); });
  if (selectedDramaId) void ensureDramaDetail(selectedDramaId); else dramaDetail.replaceChildren();
}

function renderGameList() {
  const items = filteredGames(); gameRecords.replaceChildren(); gameEmptyState.classList.toggle("hidden", Boolean(items.length)); gameBrowser.classList.toggle("hidden", !items.length);
  if (!items.some((item) => item.id === selectedGameId)) selectedGameId = items[0]?.id || "";
  items.forEach((item) => { const button = archiveListItem(item, item.id === selectedGameId, "game"); button.addEventListener("click", () => selectGame(item.id)); gameRecords.append(button); });
  if (selectedGameId) void ensureGameDetail(selectedGameId); else gameDetail.replaceChildren();
}

function selectDrama(id) { selectedDramaId = id; renderDramaList(); }
function selectGame(id) { selectedGameId = id; renderGameList(); }

async function ensureDramaDetail(id) {
  const cached = dramaDetails.get(id); if (cached) { if (selectedDramaId === id) renderDramaDetail(cached); return; }
  const sequence = ++dramaLoadSequence; detailLoading(dramaDetail, "短剧");
  try { const detail = await api(`/api/dramas/${encodeURIComponent(id)}`); dramaDetails.set(id, detail); if (selectedDramaId === id && sequence === dramaLoadSequence) renderDramaDetail(detail); }
  catch (error) { if (selectedDramaId === id) dramaDetail.replaceChildren(element("div", "detail-loading error", error.message)); }
}

async function ensureGameDetail(id) {
  const cached = gameDetails.get(id); if (cached) { if (selectedGameId === id) renderGameDetail(cached); return; }
  const sequence = ++gameLoadSequence; detailLoading(gameDetail, "App");
  try { const detail = await api(`/api/games/${encodeURIComponent(id)}`); gameDetails.set(id, detail); if (selectedGameId === id && sequence === gameLoadSequence) renderGameDetail(detail); }
  catch (error) { if (selectedGameId === id) gameDetail.replaceChildren(element("div", "detail-loading error", error.message)); }
}

async function loadRecords({ fresh = false } = {}) {
  const button = document.querySelector("#refresh-button"); button.disabled = true; message.textContent = "正在读取 AI Analysis API…"; if (fresh) dramaDetails.clear();
  try { const result = await api("/api/dramas"); dramaItems = result.items || []; document.querySelector("#drama-stats").replaceChildren(element("strong", "", String(result.analyzedCount || 0)), element("span", "", `已完成解析 / 数据库共 ${result.total || 0} 部短剧`)); message.textContent = ""; renderDramaList(); }
  catch (error) { message.textContent = error.message; dramaItems = []; renderDramaList(); } finally { button.disabled = false; }
}

async function loadGames({ fresh = false } = {}) {
  const button = document.querySelector("#game-refresh-button"); button.disabled = true; gameMessage.textContent = "正在读取 AI Analysis API…"; if (fresh) gameDetails.clear();
  const query = new URLSearchParams(); const os = document.querySelector("#game-os-filter").value; const category = document.querySelector("#game-category-filter").value; if (os) query.set("os", os); if (category) query.set("category", category);
  try { const result = await api(`/api/games${query.size ? `?${query}` : ""}`); gameItems = result.items || []; document.querySelector("#game-stats").replaceChildren(element("strong", "", String(result.analyzedCount || 0)), element("span", "", `当前筛选已解析 / 数据库共 ${result.total || 0} 个产品`)); gameMessage.textContent = ""; renderGameList(); }
  catch (error) { gameMessage.textContent = error.message; gameItems = []; renderGameList(); } finally { button.disabled = false; }
}

function fillSelect(select, items, placeholder) {
  const current = select.value; select.replaceChildren(new Option(placeholder, "")); items.forEach((item) => select.append(new Option(item.platform ? `${item.title} · ${item.platform}` : item.title, item.id))); if (items.some((item) => String(item.id) === current)) select.value = current;
}

function renderSessionList(items) {
  const list = document.querySelector("#creative-session-list"); list.replaceChildren(); if (!items.length) { list.append(element("p", "muted", "还没有创意工作台。先从上方选择短剧和 App 开始。")); return; }
  items.forEach((session) => { const button = element("button", "session-card"); button.append(element("span", `status ${session.stage === "working" ? "analyzing" : "completed"}`, session.stage === "working" ? "处理中" : "继续创作"), element("strong", "", session.title), element("p", "", session.workspace?.connectionThesis || "正在建立剧与 App 的连接…"), element("small", "", dateLabel(session.updatedAt))); button.addEventListener("click", () => openCreativeSession(session.id)); list.append(button); });
}

async function loadCreativeHome() {
  const [sourcesResult, sessionsResult] = await Promise.allSettled([api("/api/creative/sources"), api("/api/creative/sessions")]); const messages = [];
  if (sourcesResult.status === "fulfilled") { const sources = sourcesResult.value; fillSelect(document.querySelector("#creative-drama-select"), sources.dramas, sources.dramas.length ? "请选择短剧" : "暂无已解析短剧"); fillSelect(document.querySelector("#creative-game-select"), sources.games, sources.games.length ? "请选择 App" : "暂无已解析 App"); document.querySelector("#creative-create-button").disabled = !sources.dramas.length || !sources.games.length; }
  else { fillSelect(document.querySelector("#creative-drama-select"), [], "短剧加载失败"); fillSelect(document.querySelector("#creative-game-select"), [], "App 加载失败"); document.querySelector("#creative-create-button").disabled = true; messages.push(`创意来源加载失败：${sourcesResult.reason.message}`); }
  if (sessionsResult.status === "fulfilled") renderSessionList(sessionsResult.value.items || []); else { renderSessionList([]); messages.push(`历史工作台加载失败：${sessionsResult.reason.message}`); }
  creativeEntryMessage.textContent = messages.join("；");
}

function openCreativeSession(id) {
  const opened = window.open("about:blank", "_blank"); if (!opened) { creativeEntryMessage.textContent = "浏览器阻止了新页面，请允许本站打开新标签页。"; return; } opened.opener = null; opened.location.replace(`/workbench.html#${id}`);
}

document.querySelectorAll(".tab[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab[data-tab]").forEach((item) => item.classList.toggle("active", item === tab)); document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${tab.dataset.tab}-panel`));
  if (tab.dataset.tab === "game" && !gameItems.length) void loadGames(); if (tab.dataset.tab === "creative") void loadCreativeHome();
}));

document.querySelector("#drama-search").addEventListener("input", renderDramaList);
document.querySelector("#game-search").addEventListener("input", renderGameList);
document.querySelector("#drama-search-form").addEventListener("submit", (event) => { event.preventDefault(); renderDramaList(); });
document.querySelector("#refresh-button").addEventListener("click", () => loadRecords({ fresh: true }));
document.querySelector("#game-filter-form").addEventListener("submit", (event) => { event.preventDefault(); void loadGames({ fresh: true }); });

document.querySelector("#creative-create-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const newPage = window.open("about:blank", "_blank"); if (!newPage) { creativeEntryMessage.textContent = "浏览器阻止了新页面，请允许本站打开新标签页。"; return; } newPage.opener = null;
  const button = document.querySelector("#creative-create-button"); button.disabled = true; creativeEntryMessage.textContent = "正在拉取最新完整解析并创建工作台…";
  try { const session = await api("/api/creative/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dramaSourceId: document.querySelector("#creative-drama-select").value, gameSourceId: document.querySelector("#creative-game-select").value }) }); creativeEntryMessage.textContent = ""; newPage.location.replace(`/workbench.html#${session.id}`); await loadCreativeHome(); }
  catch (error) { newPage.close(); creativeEntryMessage.textContent = error.message; button.disabled = false; }
});

void loadRecords();
