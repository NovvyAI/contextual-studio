import assert from "node:assert/strict";
import test from "node:test";
import { adaptDramaAnalysis, adaptProductAnalysis, dramaDetailView, productDetailView } from "./ai-analysis-api.js";

const dramaId = "5f3c9b2a-1e4d-4a7b-8c2f-9d6e0a1b2c3d";
const productId = "9a1f2b3c-4d5e-4f60-9182-3a4b5c6d7e8f";

test("adapts AI Analysis API drama results without discarding remote evidence", () => {
  const payload = {
    drama: {
      dramaFolderId: dramaId,
      dramaTitle: "替身新娘",
      aiStatus: "DONE",
      episodeCount: 2,
      episodesAnalyzed: 2,
      aiPlot: {
        title_guess: "替身新娘",
        overall_synopsis: "女主被迫代嫁后争取自己的生活。",
        timeline: ["第1集 契约结婚", "第2集 身份揭穿"],
        themes: ["身份错位"],
        main_characters: [{ name: "林悦", role: "女主", arc: "从替身成长为独立设计师", image_gcs: "characters/lin-yue.jpg", imageUrl: "https://example.com/lin-yue.jpg" }],
      },
      aiAnalyzedAt: "2026-08-31T04:12:30.000Z",
    },
    episodes: [{ episodeNumber: 1, aiStatus: "DONE", aiSummary: { synopsis: "代嫁开始" }, sheetImages: [{ object: "episodes/1/sheet.jpg", url: "https://example.com/sheet.jpg" }] }],
  };
  const result = adaptDramaAnalysis(payload);
  assert.equal(result.contract, "novvy.video-analysis.v3");
  assert.equal(result.externalSource.id, dramaId);
  assert.equal(result.episodeAnalyses[0].detailedAnalysis.synopsis, "女主被迫代嫁后争取自己的生活。");
  assert.equal(result.episodeAnalyses[0].characterLibrary.characters[0].candidates[0].url, `/api/analysis-media/dramas/${dramaId}/character-0`);
  assert.equal(result.sourceMedia[1].url, `/api/analysis-media/dramas/${dramaId}/episode-1-sheet-0`);
  assert.equal(result.remoteAnalysis.aiPlot.main_characters[0].image_gcs, "characters/lin-yue.jpg");
  const detail = dramaDetailView(payload);
  assert.equal(detail.status, "completed");
  assert.equal(detail.screenshots.length, 1);
});

test("adapts AI Analysis API product results to the creative product contract", () => {
  const payload = {
    product: {
      productId,
      productName: "王国征途",
      productType: "APP",
      description: "中世纪策略战争手游",
      category: "Strategy",
      platform: "iOS",
      landingUrl: "https://apps.apple.com/app/id123",
      iconUrl: "https://example.com/icon.png",
      aiStatus: "DONE",
      aiGameplay: {
        is_game: true,
        genre: ["策略", "SLG"],
        core_loop: "采集资源 → 升级城建 → 联盟攻城",
        mechanics: [{ name: "联盟战", description: "组队攻城" }],
        theme: ["中世纪"],
        session_style: "长线经营",
        target_audience: "25-40 岁策略玩家",
        selling_points: ["万人同屏", "真实攻城"],
        key_scenes: [{ desc: "联盟集结攻城" }],
        objects: [{ name: "城堡" }],
      },
      screenshotImages: [{ object: "screenshots/1.jpg", url: "https://example.com/screenshot.jpg" }],
      sheetImages: [{ object: "sheets/1.jpg", url: "https://example.com/sheet.jpg" }],
    },
  };
  const result = adaptProductAnalysis(payload);
  assert.equal(result.contract, "novvy.product-analysis.v1");
  assert.equal(result.products[0].productName, "王国征途");
  assert.equal(result.products[0].productTruth.coreAction, "联盟战");
  assert.deepEqual(result.products[0].coreSellingPoints, ["万人同屏", "真实攻城"]);
  assert.equal(result.remoteAnalysis.aiGameplay.core_loop, "采集资源 → 升级城建 → 联盟攻城");
  assert.equal(result.sourceMedia[0].url, `/api/analysis-media/products/${productId}/screenshot-0`);
  const detail = productDetailView(payload);
  assert.equal(detail.platform, "iOS");
  assert.equal(detail.media.length, 2);
});
