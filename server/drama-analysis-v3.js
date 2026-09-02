export const dramaAnalysisContract = "novvy.video-analysis.v3";

const slotNames = {
  male_front: "maleFront",
  male_side: "maleSide",
  female_front: "femaleFront",
  female_side: "femaleSide",
};

function missingCandidate(slot) {
  return {
    available: false,
    screenshotId: 0,
    timeRange: "unknown",
    character: slot.startsWith("male") ? "男主" : "女主",
    view: slot.endsWith("Side") ? "side" : "front",
    viewDescription: "unknown",
    visibleFeatures: "",
    selectionReason: "短剧分析未找到可靠候选",
    confidence: "low",
    risks: ["缺少可靠人物角度"],
  };
}

export function isDramaAnalysisV3(analysis) {
  return Boolean(analysis && typeof analysis === "object" && analysis.contract === dramaAnalysisContract);
}

const legacyReferenceSlots = {
  maleFront: "male_front",
  maleSide: "male_side",
  femaleFront: "female_front",
  femaleSide: "female_side",
};

function migrateReferenceImageCandidates(candidates = {}) {
  if (Array.isArray(candidates?.slots)) return candidates;
  const slots = Object.entries(legacyReferenceSlots).map(([legacySlot, slot]) => {
    const candidate = candidates?.[legacySlot] || {};
    return {
      slot,
      screenshotId: Number(candidate.screenshotId || 0),
      timeRange: candidate.timeRange || "unknown",
      character: candidate.character || (slot.startsWith("male") ? "男主" : "女主"),
      view: candidate.view || (slot.endsWith("_side") ? "side" : "front"),
      visibleFeatures: candidate.visibleFeatures || "",
      selectionReason: candidate.selectionReason || "",
      confidence: candidate.confidence || "low",
      risks: Array.isArray(candidate.risks) ? candidate.risks : [],
    };
  });
  return { slots, characterConsistencyRules: [], missingOrWeakSlots: slots.filter((item) => !item.screenshotId).map((item) => item.slot) };
}

// Converts persisted v2 artifacts without another model call. Legacy root
// fields remain intact for auditability, while all runtime readers use the
// canonical v3 episode node created here.
export function migrateDramaAnalysisToV3(analysis) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return null;
  if (isDramaAnalysisV3(analysis)) return analysis;
  const existingEpisode = Array.isArray(analysis.episodeAnalyses) ? analysis.episodeAnalyses.at(-1) : null;
  const detailedAnalysis = existingEpisode?.detailedAnalysis || {
    oneSentenceThesis: analysis.oneSentenceThesis || "",
    synopsis: analysis.synopsis || "",
    chronology: Array.isArray(analysis.chronology) ? analysis.chronology : [],
    characters: Array.isArray(analysis.characters) ? analysis.characters : [],
    emotionalCurve: Array.isArray(analysis.emotionalCurve) ? analysis.emotionalCurve : [],
    keyDialogue: Array.isArray(analysis.keyDialogue) ? analysis.keyDialogue : [],
    motifs: Array.isArray(analysis.motifs) ? analysis.motifs : [],
    hookAndCliffhanger: analysis.hookAndCliffhanger || {},
    creativeHandoff: analysis.creativeHandoff || { safeToReuse: [], continuityRisks: [], transitionOpportunities: [] },
    confidenceNotes: {
      observed: Array.isArray(analysis.confidence?.observed) ? analysis.confidence.observed : [],
      strongInferences: Array.isArray(analysis.confidence?.strongInferences) ? analysis.confidence.strongInferences : [],
      limitations: Array.isArray(analysis.confidence?.limitations) ? analysis.confidence.limitations : [],
    },
  };
  if (!detailedAnalysis || typeof detailedAnalysis !== "object") return null;
  const episode = {
    ...(existingEpisode || {}),
    confidence: existingEpisode?.confidence || analysis.confidence?.overall || "low",
    oneLineSummary: existingEpisode?.oneLineSummary || detailedAnalysis.oneSentenceThesis || "",
    visualStyle: existingEpisode?.visualStyle || analysis.visualStyle || {},
    narrativeContinuity: existingEpisode?.narrativeContinuity || analysis.narrativeContinuity || analysis.seriesContinuity || {},
    referenceImageCandidates: migrateReferenceImageCandidates(existingEpisode?.referenceImageCandidates || analysis.referenceImageCandidates),
    risksAndUncertainties: existingEpisode?.risksAndUncertainties || analysis.confidence?.limitations || [],
    detailedAnalysis,
  };
  return {
    ...analysis,
    contract: dramaAnalysisContract,
    episodeCount: Number(analysis.episodeCount || 1),
    episodeAnalyses: [episode],
    migration: {
      ...(analysis.migration || {}),
      sourceContract: analysis.contract || (analysis.version ? `legacy.version.${analysis.version}` : "legacy.unknown"),
      method: "deterministic-v2-to-v3",
    },
  };
}

export function assertDramaAnalysisV3(analysis) {
  if (!isDramaAnalysisV3(analysis)) throw new Error("短剧分析契约不是 novvy.video-analysis.v3，请重新分析短剧");
  const episode = Array.isArray(analysis.episodeAnalyses) ? analysis.episodeAnalyses.at(-1) : null;
  if (!episode?.detailedAnalysis) throw new Error("novvy.video-analysis.v3 缺少 episodeAnalyses[].detailedAnalysis");
  return episode;
}

export function dramaReferenceImageCandidates(analysis) {
  const episode = assertDramaAnalysisV3(analysis);
  const slots = Array.isArray(episode.referenceImageCandidates?.slots) ? episode.referenceImageCandidates.slots : [];
  const candidates = Object.fromEntries(Object.values(slotNames).map((slot) => [slot, missingCandidate(slot)]));
  for (const item of slots) {
    const localSlot = slotNames[item.slot];
    if (!localSlot) continue;
    candidates[localSlot] = {
      available: Boolean(item.screenshotId),
      screenshotId: Number(item.screenshotId || 0),
      timeRange: item.timeRange || "unknown",
      character: item.character || missingCandidate(localSlot).character,
      view: item.slot.endsWith("_side") ? "side" : "front",
      viewDescription: item.view || "unknown",
      visibleFeatures: item.visibleFeatures || "",
      selectionReason: item.selectionReason || "",
      confidence: item.confidence === "unknown" ? "low" : item.confidence || "low",
      risks: Array.isArray(item.risks) ? item.risks : [],
    };
  }
  return candidates;
}

// Derives a transient UI/creative view from the v3 canonical episode. The
// derived object is never persisted in the analysis artifact.
export function dramaAnalysisView(analysis) {
  const episode = assertDramaAnalysisV3(analysis);
  const episodes = analysis.episodeAnalyses.filter((item) => item?.detailedAnalysis);
  const detailedEpisodes = episodes.map((item, index) => ({ item, detailed: item.detailedAnalysis, episodeNumber: Number(item.episodeNumber || index + 1) }));
  const plot = analysis.remoteAnalysis?.aiPlot || {};
  const prefixTimeRange = (episodeNumber, value) => {
    const timeRange = typeof value === "string" ? value.trim() : "";
    if (/^第\s*\d+\s*集/.test(timeRange)) return timeRange;
    return `第 ${episodeNumber} 集${timeRange ? ` · ${timeRange}` : ""}`;
  };
  const unique = (items, keyOf) => [...new Map(items.map((item) => [keyOf(item), item])).values()];
  const chronology = detailedEpisodes.flatMap(({ detailed, episodeNumber }) => (detailed.chronology || []).map((item) => ({ ...item, timeRange: prefixTimeRange(episodeNumber, item.timeRange) })));
  const emotionalCurve = detailedEpisodes.flatMap(({ detailed, episodeNumber }) => (detailed.emotionalCurve || []).map((item) => ({ ...item, timeRange: prefixTimeRange(episodeNumber, item.timeRange) })));
  const characters = unique(detailedEpisodes.flatMap(({ detailed }) => detailed.characters || []), (item) => item.role || JSON.stringify(item));
  const episodeMotifs = detailedEpisodes.flatMap(({ detailed }) => detailed.motifs || []);
  const plotMotifs = [...(Array.isArray(plot.themes) ? plot.themes : []), ...(Array.isArray(plot.tags) ? plot.tags : [])]
    .map((value) => ({ name: String(value || ""), appearance: String(value || ""), dramaticMeaning: String(value || ""), reusableBridge: "" }));
  const motifs = unique([...plotMotifs, ...episodeMotifs], (item) => item.name || item.element || JSON.stringify(item));
  const firstDetailed = detailedEpisodes[0]?.detailed || {};
  const lastDetailed = detailedEpisodes.at(-1)?.detailed || episode.detailedAnalysis;
  const confidenceNotes = lastDetailed.confidenceNotes || {};
  const limitations = unique(detailedEpisodes.flatMap(({ detailed, item }) => detailed.confidenceNotes?.limitations || item.risksAndUncertainties || []), (item) => String(item));
  return {
    contract: dramaAnalysisContract,
    oneSentenceThesis: plot.title_guess || firstDetailed.oneSentenceThesis || episode.oneLineSummary || "",
    synopsis: plot.overall_synopsis || detailedEpisodes.map(({ detailed }) => detailed.synopsis).filter(Boolean).join("\n"),
    chronology,
    characters,
    emotionalCurve,
    keyDialogue: detailedEpisodes.flatMap(({ detailed }) => detailed.keyDialogue || []),
    motifs,
    hookAndCliffhanger: {
      openingHook: Array.isArray(plot.timeline) ? plot.timeline[0] || "" : firstDetailed.hookAndCliffhanger?.openingHook || "",
      retentionMechanism: firstDetailed.hookAndCliffhanger?.retentionMechanism || "",
      endingState: Array.isArray(plot.timeline) ? plot.timeline.at(-1) || "" : lastDetailed.hookAndCliffhanger?.endingState || "",
      cliffhangerMechanic: lastDetailed.hookAndCliffhanger?.cliffhangerMechanic || "",
    },
    creativeHandoff: lastDetailed.creativeHandoff || { safeToReuse: [], continuityRisks: [], transitionOpportunities: [] },
    visualStyle: episode.visualStyle || {},
    referenceImageCandidates: dramaReferenceImageCandidates(analysis),
    episodeAnalyses: detailedEpisodes.map(({ item, episodeNumber }) => ({ episodeNumber, aiStatus: item.aiStatus || "", oneLineSummary: item.oneLineSummary || "", detailedAnalysis: item.detailedAnalysis })),
    confidence: {
      overall: episode.confidence || "low",
      observed: confidenceNotes.observed || [],
      strongInferences: confidenceNotes.strongInferences || [],
      limitations,
    },
    narrativeContinuity: episode.narrativeContinuity || {},
  };
}
