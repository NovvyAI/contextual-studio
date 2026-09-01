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
  const detailed = episode.detailedAnalysis;
  const confidenceNotes = detailed.confidenceNotes || {};
  return {
    contract: dramaAnalysisContract,
    oneSentenceThesis: detailed.oneSentenceThesis || episode.oneLineSummary || "",
    synopsis: detailed.synopsis || "",
    chronology: detailed.chronology || [],
    characters: detailed.characters || [],
    emotionalCurve: detailed.emotionalCurve || [],
    keyDialogue: detailed.keyDialogue || [],
    motifs: detailed.motifs || [],
    hookAndCliffhanger: detailed.hookAndCliffhanger || {},
    creativeHandoff: detailed.creativeHandoff || { safeToReuse: [], continuityRisks: [], transitionOpportunities: [] },
    visualStyle: episode.visualStyle || {},
    referenceImageCandidates: dramaReferenceImageCandidates(analysis),
    confidence: {
      overall: episode.confidence || "low",
      observed: confidenceNotes.observed || [],
      strongInferences: confidenceNotes.strongInferences || [],
      limitations: confidenceNotes.limitations || episode.risksAndUncertainties || [],
    },
    narrativeContinuity: episode.narrativeContinuity || {},
  };
}
