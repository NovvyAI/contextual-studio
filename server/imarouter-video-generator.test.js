import assert from "node:assert/strict";
import test from "node:test";
import { buildImaRouterVideoRequest } from "./imarouter-video-generator.js";

const shot = { durationSeconds: 9, prompt: "Move naturally." };
const references = { ordered: ["character-a", "character-b", "storyboard"], storyboard: "storyboard" };

test("MiniMax-H3 receives character references first and storyboard last", () => {
  assert.deepEqual(buildImaRouterVideoRequest("MiniMax-H3", shot, references), {
    model: "MiniMax-H3",
    prompt: "Move naturally.",
    duration: 9,
    resolution: "768P",
    ratio: "9:16",
    images: ["character-a", "character-b", "storyboard"],
    role_mode: "reference",
  });
});

test("MiniMax-H3 enforces the official nine-image limit", () => {
  assert.throws(() => buildImaRouterVideoRequest("MiniMax-H3", shot, { ordered: Array(10).fill("image"), storyboard: "image" }), /最多支持 9 张参考图/);
});

test("Kling uses its own image_list request contract", () => {
  const body = buildImaRouterVideoRequest("kling-v3-omni-video", shot, references);
  assert.deepEqual(body.image_list, references.ordered);
  assert.equal(body.sound, "on");
  assert.equal(body.aspect_ratio, "9:16");
  assert.equal(body.images, undefined);
});

test("Vidu uses size as aspect ratio and metadata for resolution", () => {
  const body = buildImaRouterVideoRequest("viduq3-turbo", shot, references);
  assert.equal(body.size, "9:16");
  assert.deepEqual(body.images, references.ordered);
  assert.deepEqual(body.metadata, { resolution: "720p" });
});

test("unknown models safely fall back to Seedance 2.0 Fast", () => {
  const body = buildImaRouterVideoRequest("unknown", shot, references, false);
  assert.equal(body.model, "seedance-2.0-fast");
  assert.equal(body.metadata.audio, false);
  assert.deepEqual(body.images, references.ordered);
});
