import assert from "node:assert/strict";
import test from "node:test";
import { buildImaRouterVideoRequest } from "./imarouter-video-generator.js";

const shot = { durationSeconds: 9, prompt: "Move naturally." };
const references = { ordered: ["character-a", "character-b", "storyboard"], storyboard: "storyboard" };

test("MiniMax only receives the storyboard as first frame", () => {
  assert.deepEqual(buildImaRouterVideoRequest("MiniMax-Hailuo-2.3", shot, references), {
    model: "MiniMax-Hailuo-2.3",
    prompt: "Move naturally.",
    duration: 10,
    size: "768p",
    metadata: { first_frame_image: "storyboard" },
  });
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
