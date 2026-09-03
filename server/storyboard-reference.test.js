import assert from "node:assert/strict";
import test from "node:test";
import { extractReferenceUrl } from "./storyboard-generator.js";

test("extracts a URL from rewritten confirmed reference details", () => {
  assert.equal(
    extractReferenceUrl("图片04｜https://storage.googleapis.com/example/reference.png"),
    "https://storage.googleapis.com/example/reference.png",
  );
});

test("accepts local face and screenshot references", () => {
  assert.equal(extractReferenceUrl("人物｜/api/face-candidates/252"), "/api/face-candidates/252");
  assert.equal(extractReferenceUrl("截图｜/api/screenshots/208"), "/api/screenshots/208");
});
