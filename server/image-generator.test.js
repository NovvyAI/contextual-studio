import assert from "node:assert/strict";
import test from "node:test";

import { finalCardPrompt } from "./image-generator.js";

test("final card prompt accepts the post-storyboard direction label", () => {
  assert.equal(finalCardPrompt({ details: [{ label: "后续图片生成提示词", content: "Create a vertical final card." }] }), "Create a vertical final card.");
});

test("final card prompt keeps compatibility with legacy labels", () => {
  assert.equal(finalCardPrompt({ details: [{ label: "GPT-image-2 英文提示词", content: "Legacy prompt" }] }), "Legacy prompt");
  assert.equal(finalCardPrompt({ details: [{ label: "其他字段", content: "not a prompt" }] }), "");
});
