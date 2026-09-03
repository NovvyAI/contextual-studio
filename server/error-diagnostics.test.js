import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseCreativeError } from "./error-diagnostics.js";

test("classifies user selection errors as fixable before retry", () => {
  const result = diagnoseCreativeError("请选择同一套方案的分镜图", "统一确认分镜图");
  assert.equal(result.id, "user_input");
  assert.match(result.retryability, /可以解决/);
});

test("classifies ImaRouter real-person review failures", () => {
  const result = diagnoseCreativeError("InputImageSensitiveContentDetected.PrivacyInformation: input image may contain real person", "生成视频");
  assert.equal(result.id, "privacy_image");
  assert.match(result.autoRetry, /自动降级重试一次/);
});

test("preserves unknown errors without inventing a cause", () => {
  const result = diagnoseCreativeError("provider emitted zx-17", "生成图片");
  assert.equal(result.id, "unknown");
  assert.equal(result.raw, "provider emitted zx-17");
  assert.match(result.explanation, /不足以可靠判断/);
});
