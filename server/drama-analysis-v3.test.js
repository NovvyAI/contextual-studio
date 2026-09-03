import test from "node:test";
import assert from "node:assert/strict";
import { dramaAnalysisView, dramaReferenceImageCandidates, migrateDramaAnalysisToV3 } from "./drama-analysis-v3.js";

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

test("series view merges every episode instead of exposing only the last one", () => {
  const episode = (episodeIndex, thesis) => ({
    episodeIndex, confidence: "medium", oneLineSummary: thesis,
    detailedAnalysis: { ...detailedAnalysis, oneSentenceThesis: thesis, synopsis: `${thesis} synopsis`, chronology: [{ timeRange: "0-5s", beat: thesis }] },
    referenceImageCandidates: { slots: [] }, characterLibrary: { characters: [{ characterId: `ep${episodeIndex}-lead`, candidates: [] }], unassignedCandidateIds: [], limitations: [] },
  });
  const view = dramaAnalysisView({ contract: "novvy.video-analysis.v3", episodeAnalyses: [episode(1, "first"), episode(2, "second")] });
  assert.match(view.oneSentenceThesis, /2 集剧集分析/);
  assert.equal(view.chronology.length, 2);
  assert.equal(view.characterLibrary.characters.length, 2);
});

test("legacy v2 analysis migrates deterministically and preserves reference screenshot ids", () => {
  const legacy = {
    version: 2,
    oneSentenceThesis: "legacy thesis",
    synopsis: "legacy synopsis",
    chronology: [{ beat: "legacy turn" }],
    characters: [{ name: "Eileen" }],
    emotionalCurve: [], keyDialogue: [], motifs: [],
    hookAndCliffhanger: { endingState: "unresolved" },
    creativeHandoff: { safeToReuse: ["dress"], continuityRisks: [], transitionOpportunities: [] },
    visualStyle: { renderingType: "live_action_realistic" },
    confidence: { overall: "medium", observed: ["frame"], strongInferences: [], limitations: ["sampled"] },
    referenceImageCandidates: {
      maleFront: { screenshotId: 12, character: "Lucian", view: "front", confidence: "high" },
      femaleSide: { screenshotId: 18, character: "Eileen", view: "side", confidence: "medium" },
    },
  };
  const migrated = migrateDramaAnalysisToV3(legacy);
  const view = dramaAnalysisView(migrated);
  assert.equal(migrated.contract, "novvy.video-analysis.v3");
  assert.equal(migrated.migration.sourceContract, "legacy.version.2");
  assert.equal(view.oneSentenceThesis, "legacy thesis");
  assert.equal(view.referenceImageCandidates.maleFront.screenshotId, 12);
  assert.equal(view.referenceImageCandidates.femaleSide.screenshotId, 18);
  assert.equal(view.referenceImageCandidates.maleSide.available, false);
});
