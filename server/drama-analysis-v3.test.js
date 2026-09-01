import test from "node:test";
import assert from "node:assert/strict";
import { dramaAnalysisView, dramaReferenceImageCandidates } from "./drama-analysis-v3.js";

const detailedAnalysis = {
  oneSentenceThesis: "canonical thesis",
  synopsis: "canonical synopsis",
  chronology: [{ beat: "turn" }],
  characters: [],
  emotionalCurve: [],
  keyDialogue: [],
  motifs: [{ name: "ring" }],
  hookAndCliffhanger: { endingState: "unresolved" },
  creativeHandoff: { safeToReuse: [], continuityRisks: [], transitionOpportunities: [] },
  confidenceNotes: { observed: ["frame 1"], strongInferences: [], limitations: ["sampled"] },
};

test("v3 view reads the canonical episode and maps side slots by slot identity", () => {
  const analysis = {
    contract: "novvy.video-analysis.v3",
    episodeAnalyses: [{
      confidence: "medium",
      oneLineSummary: "summary",
      detailedAnalysis,
      visualStyle: { renderingType: "cartoon_animation" },
      narrativeContinuity: { lastFrameState: "black" },
      referenceImageCandidates: { slots: [{
        slot: "female_side",
        screenshotId: 9,
        timeRange: "28.39s",
        character: "女主",
        view: "three_quarter",
        visibleFeatures: "profile",
        selectionReason: "best available",
        confidence: "medium",
        risks: [],
      }] },
      risksAndUncertainties: [],
    }],
  };

  const view = dramaAnalysisView(analysis);
  assert.equal(view.oneSentenceThesis, "canonical thesis");
  assert.equal(view.referenceImageCandidates.femaleSide.view, "side");
  assert.equal(view.referenceImageCandidates.femaleSide.viewDescription, "three_quarter");
  assert.equal(view.referenceImageCandidates.femaleSide.screenshotId, 9);
  assert.equal(view.confidence.overall, "medium");
});

test("v2 and missing contracts are rejected", () => {
  assert.throws(() => dramaAnalysisView({ contract: "novvy.video-analysis.v2" }), /请重新分析短剧/);
  assert.throws(() => dramaReferenceImageCandidates(null), /请重新分析短剧/);
});
