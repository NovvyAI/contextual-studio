const defaultBaseUrl = "https://developer.novvy.ai";
const requestTimeoutMs = Number(process.env.AI_ANALYSIS_API_TIMEOUT_MS || 30000);
const detailCacheTtlMs = Number(process.env.AI_ANALYSIS_API_CACHE_TTL_MS || 5 * 60 * 1000);
const detailCache = new Map();

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function authorization() {
  const direct = text(process.env.AI_ANALYSIS_API_AUTHORIZATION);
  if (direct) return /^Bearer\s+/i.test(direct) ? direct : `Bearer ${direct}`;
  const apiKey = text(process.env.AI_ANALYSIS_API_KEY);
  if (apiKey) return `Bearer ${apiKey.replace(/^Bearer\s+/i, "")}`;
  const mcpAuthorization = text(process.env.NOVVY_MCP_AUTHORIZATION);
  if (mcpAuthorization) return /^Bearer\s+/i.test(mcpAuthorization) ? mcpAuthorization : `Bearer ${mcpAuthorization}`;
  throw new Error("AI Analysis API 尚未配置：请设置 AI_ANALYSIS_API_KEY");
}

function baseUrl() {
  return text(process.env.AI_ANALYSIS_API_BASE_URL, defaultBaseUrl).replace(/\/+$/, "");
}

function uuid(value, label) {
  const id = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error(`${label} ID 无效`);
  return id;
}

async function request(pathname) {
  const response = await fetch(`${baseUrl()}${pathname}`, {
    headers: { authorization: authorization(), accept: "application/json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || payload?.ok === false) {
    const message = text(payload?.error?.message) || text(payload?.error) || `AI Analysis API 请求失败 (${response.status})`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }
  return payload || {};
}

async function cachedDetail(kind, id, loader, { fresh = false } = {}) {
  const key = `${kind}:${id}`;
  const cached = detailCache.get(key);
  if (!fresh && cached && Date.now() - cached.loadedAt < detailCacheTtlMs) return cached.value;
  const value = await loader();
  detailCache.set(key, { value, loadedAt: Date.now() });
  return value;
}

export function analysisMediaUrl(kind, id, mediaKey) {
  return `/api/analysis-media/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(mediaKey)}`;
}

export async function listAnalyzedDramas() {
  const payload = await request("/api/drama-analysis/dramas");
  const dramas = asArray(payload.dramas).map((item) => ({
    id: text(item.dramaFolderId),
    sourceId: text(item.dramaFolderId),
    title: text(item.dramaTitle, "未命名短剧"),
    status: "completed",
    aiStatus: text(item.aiStatus, "DONE"),
    episodeCount: Number(item.episodeCount || 0),
    coverImageUrl: item.coverImageUrl ? analysisMediaUrl("dramas", item.dramaFolderId, "cover") : "",
    analyzedAt: item.aiAnalyzedAt || null,
    createdAt: item.aiAnalyzedAt || null,
  })).filter((item) => item.id);
  return { total: Number(payload.totalDramas || 0), analyzedCount: Number(payload.analyzedCount ?? dramas.length), items: dramas };
}

export async function getAnalyzedDrama(folderId, options = {}) {
  const id = uuid(folderId, "短剧");
  return cachedDetail("drama", id, () => request(`/api/drama-analysis/dramas/${encodeURIComponent(id)}`), options);
}

export async function listAnalyzedProducts({ os = "", category = "" } = {}) {
  const query = new URLSearchParams();
  if (text(os)) query.set("os", text(os));
  if (text(category)) query.set("category", text(category));
  const payload = await request(`/api/product-analysis/products${query.size ? `?${query}` : ""}`);
  const products = asArray(payload.products).map((item) => ({
    id: text(item.productId),
    sourceId: text(item.productId),
    title: text(item.productName, "未命名 App"),
    productName: text(item.productName, "未命名 App"),
    productType: text(item.productType, "APP"),
    category: text(item.category, "未分类"),
    platform: text(item.platform),
    iconUrl: text(item.iconUrl),
    status: "completed",
    aiStatus: text(item.aiStatus, "DONE"),
    analyzedAt: item.aiAnalyzedAt || null,
    createdAt: item.aiAnalyzedAt || null,
  })).filter((item) => item.id);
  return { total: Number(payload.totalProducts || 0), analyzedCount: Number(payload.analyzedCount ?? products.length), items: products };
}

export async function getAnalyzedProduct(productId, options = {}) {
  const id = uuid(productId, "产品");
  return cachedDetail("product", id, () => request(`/api/product-analysis/products/${encodeURIComponent(id)}`), options);
}

function dramaMedia(payload) {
  const drama = asObject(payload.drama);
  const plot = asObject(drama.aiPlot);
  const media = [];
  asArray(plot.main_characters).forEach((character, index) => {
    if (text(character?.imageUrl)) media.push({ key: `character-${index}`, url: character.imageUrl, object: text(character.image_gcs), kind: "character", title: text(character.name, `人物 ${index + 1}`) });
  });
  asArray(payload.episodes).forEach((episode) => {
    asArray(episode?.sheetImages).forEach((sheet, sheetIndex) => {
      if (text(sheet?.url)) media.push({ key: `episode-${Number(episode.episodeNumber || 0)}-sheet-${sheetIndex}`, url: sheet.url, object: text(sheet.object), kind: "episode_sheet", title: `第 ${Number(episode.episodeNumber || 0)} 集拼图 ${sheetIndex + 1}` });
    });
  });
  return media;
}

function productMedia(payload) {
  const product = asObject(payload.product);
  return [
    ...asArray(product.screenshotImages).map((item, index) => ({ key: `screenshot-${index}`, url: text(item?.url), object: text(item?.object), kind: "store_screenshot", title: `商店截图 ${index + 1}` })),
    ...asArray(product.sheetImages).map((item, index) => ({ key: `sheet-${index}`, url: text(item?.url), object: text(item?.object), kind: "creative_sheet", title: `创意拼图 ${index + 1}` })),
  ].filter((item) => item.url);
}

export async function resolveAnalysisMediaUrl(kind, id, mediaKey) {
  if (kind === "dramas") {
    const payload = await getAnalyzedDrama(id);
    if (mediaKey === "cover") return dramaMedia(payload).find((item) => item.kind === "character")?.url || "";
    return dramaMedia(payload).find((item) => item.key === mediaKey)?.url || "";
  }
  if (kind === "products") {
    const payload = await getAnalyzedProduct(id);
    return productMedia(payload).find((item) => item.key === mediaKey)?.url || "";
  }
  return "";
}

function timelineItem(value, index) {
  const copy = text(value, `剧情节点 ${index + 1}`);
  const episode = copy.match(/第\s*\d+\s*集/)?.[0] || "整剧";
  return { timeRange: episode, beat: copy, action: copy, decisionOrShift: "", audienceEmotion: "" };
}

function characterItem(character) {
  const name = text(character?.name, text(character?.label));
  const role = text(character?.role, text(character?.prominence, name || "主要人物"));
  return {
    role: name && name !== role ? `${name} · ${role}` : role,
    appearance: text(character?.label),
    desire: "unknown",
    vulnerability: "unknown",
    keyChoice: text(character?.arc, text(character?.emotion_arc, "unknown")),
    relationshipMovement: text(character?.arc, "unknown"),
    confidence: "observed",
  };
}

function episodeLabel(episodeNumber) {
  return episodeNumber > 0 ? `第 ${episodeNumber} 集` : "分集";
}

function episodeEmotionCurve(summary, episodeNumber) {
  const output = [];
  asArray(summary.characters).forEach((character, characterIndex) => {
    const characterName = text(character?.label, `人物 ${characterIndex + 1}`);
    const emotions = asArray(character?.emotions).slice().sort((left, right) => text(left?.ts).localeCompare(text(right?.ts)));
    emotions.forEach((emotion) => {
      const emotionName = text(emotion?.emotion, "情绪未标注");
      const intensity = text(emotion?.intensity);
      const timestamp = text(emotion?.ts);
      output.push({
        timeRange: `${episodeLabel(episodeNumber)}${timestamp ? ` · ${timestamp}` : ""}`,
        stimulus: text(emotion?.trigger),
        audienceEmotion: `${characterName}：${emotionName}${intensity ? `（${intensity}）` : ""}`,
        viewingImpulse: "",
        evidence: text(emotion?.evidence),
        character: characterName,
        characterEmotion: emotionName,
        intensity,
      });
    });
    if (!emotions.length && text(character?.emotion_arc)) {
      output.push({
        timeRange: episodeLabel(episodeNumber),
        stimulus: text(character.emotion_arc),
        audienceEmotion: `${characterName}：情绪变化`,
        viewingImpulse: "",
        evidence: text(character.emotion_arc),
        character: characterName,
        characterEmotion: text(character.emotion_arc),
        intensity: "",
      });
    }
  });
  return output;
}

function episodeMotifs(summary) {
  return asArray(summary.objects).map((item) => {
    const name = typeof item === "string" ? text(item) : text(item?.name);
    const brand = typeof item === "string" ? "" : text(item?.brand);
    return { name, appearance: brand ? `${name} · ${brand}` : name, dramaticMeaning: "", reusableBridge: "" };
  }).filter((item) => item.name);
}

function episodeDetailedAnalysis(episode, episodeNumber) {
  const summary = asObject(episode?.aiSummary);
  const synopsis = text(summary.synopsis);
  const characters = asArray(summary.characters);
  const emotionalCurve = episodeEmotionCurve(summary, episodeNumber);
  const limitations = [];
  if (!Object.keys(summary).length) limitations.push(`${episodeLabel(episodeNumber)}尚未返回 AI 分集解析。`);
  else if (!emotionalCurve.length) limitations.push(`${episodeLabel(episodeNumber)}的远端解析未提供人物情绪节点。`);
  return {
    oneSentenceThesis: synopsis || episodeLabel(episodeNumber),
    synopsis,
    chronology: synopsis ? [{ timeRange: episodeLabel(episodeNumber), beat: synopsis, action: synopsis, decisionOrShift: "", audienceEmotion: "" }] : [],
    characters: characters.map(characterItem),
    emotionalCurve,
    keyDialogue: [],
    motifs: episodeMotifs(summary),
    hookAndCliffhanger: { openingHook: "", retentionMechanism: "", endingState: "", cliffhangerMechanic: "" },
    creativeHandoff: { safeToReuse: [], continuityRisks: [], transitionOpportunities: [] },
    confidenceNotes: {
      observed: Object.keys(summary).length ? [`${episodeLabel(episodeNumber)}内容来自 AI Analysis API 的分集解析。`] : [],
      strongInferences: [],
      limitations,
    },
  };
}

export function adaptDramaAnalysis(payload) {
  const drama = asObject(payload?.drama);
  const plot = asObject(drama.aiPlot);
  const sourceId = text(drama.dramaFolderId);
  const characters = asArray(plot.main_characters);
  const timeline = asArray(plot.timeline);
  const episodes = asArray(payload?.episodes).slice().sort((left, right) => Number(left?.episodeNumber || 0) - Number(right?.episodeNumber || 0));
  const synopsis = text(plot.overall_synopsis) || episodes.map((episode) => text(episode?.aiSummary?.synopsis)).filter(Boolean).join("\n");
  const media = dramaMedia(payload).map((item) => ({ ...item, url: analysisMediaUrl("dramas", sourceId, item.key) }));
  const mediaByKey = new Map(media.map((item) => [item.key, item]));
  const characterLibrary = {
    characters: characters.map((character, index) => ({
      characterId: `remote-character-${index + 1}`,
      displayName: text(character?.name, `人物 ${index + 1}`),
      narrativeRole: text(character?.role, "主要人物"),
      selectionReason: text(character?.arc, "来自 AI Analysis API 的主要人物代表帧"),
      candidates: mediaByKey.has(`character-${index}`) ? [{
        candidateId: `remote-character-${index + 1}-representative`,
        screenshotId: 0,
        timestampSeconds: 0,
        view: "front",
        qualityScore: 1,
        url: mediaByKey.get(`character-${index}`).url,
        sourceObject: text(character?.image_gcs),
        needsCleanup: false,
      }] : [],
    })),
    unassignedCandidateIds: [],
    limitations: characters.length ? ["人物图片是远端整剧分析选取的代表帧，未提供精确时间码和多角度分类。"] : ["远端分析未提供主要人物代表帧。"],
  };
  const fallbackDetailedAnalysis = {
    oneSentenceThesis: text(plot.title_guess) || text(drama.dramaTitle, "短剧整剧分析"),
    synopsis,
    chronology: timeline.map(timelineItem),
    characters: characters.map(characterItem),
    emotionalCurve: [], keyDialogue: [],
    motifs: [...asArray(plot.themes), ...asArray(plot.tags)].map((value) => ({ name: text(value), appearance: text(value), dramaticMeaning: text(value), reusableBridge: "" })).filter((item) => item.name),
    hookAndCliffhanger: { openingHook: text(timeline[0]), retentionMechanism: "", endingState: text(timeline.at(-1)), cliffhangerMechanic: "" },
    creativeHandoff: { safeToReuse: [], continuityRisks: [], transitionOpportunities: [] },
    confidenceNotes: { observed: ["内容来自 AI Analysis API 返回的整剧解析结果。"], strongInferences: [], limitations: ["接口没有返回分集解析，暂时保留整剧投影。"] },
  };
  const episodeAnalyses = episodes.length ? episodes.map((episode, index) => {
    const episodeNumber = Number(episode?.episodeNumber || index + 1);
    const detailedAnalysis = episodeDetailedAnalysis(episode, episodeNumber);
    return {
      episodeNumber,
      videoAssetId: text(episode?.videoAssetId),
      aiStatus: text(episode?.aiStatus),
      confidence: Object.keys(asObject(episode?.aiSummary)).length ? "observed" : "low",
      oneLineSummary: detailedAnalysis.oneSentenceThesis,
      visualStyle: { scenes: asArray(episode?.aiSummary?.scenes), onScreenText: asArray(episode?.aiSummary?.on_screen_text) },
      narrativeContinuity: { lastFrameState: "" },
      referenceImageCandidates: { slots: [], characterConsistencyRules: [], missingOrWeakSlots: ["male_front", "male_side", "female_front", "female_side"] },
      characterLibrary,
      risksAndUncertainties: detailedAnalysis.confidenceNotes.limitations,
      detailedAnalysis,
    };
  }) : [{
    episodeNumber: 1,
    aiStatus: text(drama.aiStatus),
    confidence: "observed",
    oneLineSummary: fallbackDetailedAnalysis.oneSentenceThesis,
    visualStyle: {}, narrativeContinuity: { lastFrameState: fallbackDetailedAnalysis.hookAndCliffhanger.endingState },
    referenceImageCandidates: { slots: [], characterConsistencyRules: [], missingOrWeakSlots: ["male_front", "male_side", "female_front", "female_side"] },
    characterLibrary, risksAndUncertainties: fallbackDetailedAnalysis.confidenceNotes.limitations, detailedAnalysis: fallbackDetailedAnalysis,
  }];
  return {
    contract: "novvy.video-analysis.v3",
    engine: "novvy-ai-analysis-api",
    analyzedAt: drama.aiAnalyzedAt || null,
    episodeCount: Number(drama.episodeCount || episodes.length || 0),
    episodeAnalyses,
    externalSource: { type: "novvy-ai-analysis-api", resource: "drama", id: sourceId, publisherId: text(drama.publisherId), aiStatus: text(drama.aiStatus), aiLastJobId: text(drama.aiLastJobId) },
    sourceMedia: media,
    remoteAnalysis: { aiPlot: plot, episodes: episodes.map((episode) => ({ videoAssetId: episode.videoAssetId, episodeNumber: episode.episodeNumber, fileName: episode.fileName, aiStatus: episode.aiStatus, aiSummary: episode.aiSummary, aiError: episode.aiError, aiAnalyzedAt: episode.aiAnalyzedAt })) },
  };
}

export function adaptProductAnalysis(payload) {
  const product = asObject(payload?.product);
  const gameplay = asObject(product.aiGameplay);
  const sourceId = text(product.productId);
  const mechanics = asArray(gameplay.mechanics);
  const genres = asArray(gameplay.genre).map(String);
  const themes = asArray(gameplay.theme).map(String);
  const sellingPoints = asArray(gameplay.selling_points).map(String);
  const keyScenes = asArray(gameplay.key_scenes).map((item) => typeof item === "string" ? item : text(item?.desc)).filter(Boolean);
  const objects = asArray(gameplay.objects).map((item) => typeof item === "string" ? item : text(item?.name)).filter(Boolean);
  const media = productMedia(payload).map((item) => ({ ...item, url: analysisMediaUrl("products", sourceId, item.key) }));
  const coreLoop = text(gameplay.core_loop, "unknown");
  const productName = text(product.productName, "未命名 App");
  const description = text(product.description, "unknown");
  const audienceText = text(gameplay.target_audience, "unknown");
  const normalized = {
    productName,
    landingUrl: text(product.landingUrl),
    os: text(product.platform, "unknown"),
    category: text(product.category, "unknown"),
    categoryZh: text(product.category, "unknown"),
    descriptionSummary: description,
    gameplayTags: [...genres, ...themes, ...mechanics.map((item) => text(item?.name)).filter(Boolean)],
    coreSellingPoints: sellingPoints,
    audience: { ageRange: audienceText, genderSkew: "unknown", interestGroups: [...genres, ...themes], casualOrHardcore: text(gameplay.session_style, "unknown"), regionLanguageFit: "unknown" },
    marketMessage: { promise: sellingPoints[0] || coreLoop, benefitPoints: sellingPoints, ctaDirections: [] },
    productTruth: {
      firstCoreExperience: keyScenes[0] || coreLoop,
      coreAction: mechanics.map((item) => text(item?.name)).filter(Boolean).join("、") || coreLoop,
      operationObject: objects.join("、") || "unknown",
      immediateFeedback: keyScenes.join("；") || "unknown",
      earlyOutcome: sellingPoints[0] || "unknown",
      storefrontPromise: description,
    },
    conversionSignals: sellingPoints,
    visualDemoPotential: keyScenes,
    risks: gameplay.is_game === false ? ["远端分析标记该产品不是游戏。"] : [],
    rawGameplay: gameplay,
  };
  return {
    contract: "novvy.product-analysis.v1",
    engine: "novvy-ai-analysis-api",
    analyzedAt: product.aiAnalyzedAt || null,
    productThesis: description,
    products: [normalized],
    ranking: [{ productName, reason: sellingPoints.join("；") || coreLoop }],
    globalAudienceNotes: audienceText,
    unknowns: normalized.risks,
    externalSource: { type: "novvy-ai-analysis-api", resource: "product", id: sourceId, advertiserId: text(product.advertiserId), aiStatus: text(product.aiStatus), aiLastJobId: text(product.aiLastJobId) },
    sourceMedia: media,
    remoteAnalysis: { aiGameplay: gameplay, screenshotImages: media.filter((item) => item.kind === "store_screenshot"), sheetImages: media.filter((item) => item.kind === "creative_sheet") },
  };
}

export function dramaDetailView(payload) {
  const drama = asObject(payload?.drama);
  const result = adaptDramaAnalysis(payload);
  const sourceMedia = asArray(result.sourceMedia);
  return {
    id: text(drama.dramaFolderId), sourceId: text(drama.dramaFolderId), title: text(drama.dramaTitle, "未命名短剧"), status: "completed",
    aiStatus: text(drama.aiStatus), episodeCount: Number(drama.episodeCount || 0), episodesAnalyzed: Number(drama.episodesAnalyzed || 0),
    coverImageUrl: sourceMedia.find((item) => item.kind === "character")?.url || "", result,
    screenshots: sourceMedia.filter((item) => item.kind === "episode_sheet").map((item, index) => ({ id: item.key, url: item.url, title: item.title, timestampSeconds: index })),
    media: sourceMedia, analyzedAt: drama.aiAnalyzedAt || null, createdAt: drama.createdAt || drama.aiAnalyzedAt || null, updatedAt: drama.updatedAt || drama.aiAnalyzedAt || null,
  };
}

export function productDetailView(payload) {
  const product = asObject(payload?.product);
  const result = adaptProductAnalysis(payload);
  return {
    id: text(product.productId), sourceId: text(product.productId), title: text(product.productName, "未命名 App"), productName: text(product.productName, "未命名 App"),
    productType: text(product.productType, "APP"), category: text(product.category, "未分类"), platform: text(product.platform), iconUrl: text(product.iconUrl), storeUrl: text(product.landingUrl), status: "completed",
    result, media: asArray(result.sourceMedia), analyzedAt: product.aiAnalyzedAt || null, createdAt: product.createdAt || product.aiAnalyzedAt || null, updatedAt: product.updatedAt || product.aiAnalyzedAt || null,
  };
}
