import assert from "node:assert/strict";
import test from "node:test";
import { parseStoryboardVideoPlan } from "./storyboard-video-plan.js";

function cardWithPlan(plan, extraDetails = []) {
  return { summary: "test", details: [{ label: "分镜任务 JSON", content: JSON.stringify(plan) }, ...extraDetails] };
}

test("creative plan uses the English prompt embedded in each shot", () => {
  const parsed = parseStoryboardVideoPlan(cardWithPlan({
    schemaVersion: "contextual.video-shot-plan.v1",
    shots: [{ shotId: "shot-A01", durationSeconds: 5, promptEn: "Embedded English video prompt", reviewZh: "中文镜头说明" }],
  }));
  assert.equal(parsed.shots[0].promptEn, "Embedded English video prompt");
  assert.equal(parsed.shots[0].reviewZh, "中文镜头说明");
});

test("creative plan accepts prompt aliases emitted by compatible producers", () => {
  for (const [field, value] of [["prompt_en", "snake prompt"], ["videoPromptEn", "video prompt"], ["englishPrompt", "English prompt"], ["prompt", "generic prompt"]]) {
    const parsed = parseStoryboardVideoPlan(cardWithPlan({ schemaVersion: "contextual.video-shot-plan.v1", shots: [{ shotId: "shot-B01", durationSeconds: 5, [field]: value }] }));
    assert.equal(parsed.shots[0].promptEn, value);
  }
});

test("detail labels may contain text after the source shot id", () => {
  const parsed = parseStoryboardVideoPlan(cardWithPlan(
    { schemaVersion: "contextual.video-shot-plan.v1", shots: [{ shotId: "shot-C01", durationSeconds: 5 }] },
    [{ label: "英文提交提示词｜shot-C01｜V2", content: "Prompt from labeled detail" }],
  ));
  assert.equal(parsed.shots[0].promptEn, "Prompt from labeled detail");
});
