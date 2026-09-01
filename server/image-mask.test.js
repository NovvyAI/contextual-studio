import test from "node:test";
import assert from "node:assert/strict";
import { preparePngEditSource, validatePngEditInputs, validatePngEditMask } from "./image-mask.js";

const rgbaPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwW3AAAAAElFTkSuQmCC", "base64");

test("accepts a PNG edit mask with an alpha channel", () => {
  const mask = validatePngEditMask({ buffer: rgbaPng, mimeType: "image/png", fileName: "mask.png" });
  assert.equal(mask.width, 1);
  assert.equal(mask.height, 1);
  assert.equal(mask.mimeType, "image/png");
});

test("rejects masks without a PNG alpha color type", () => {
  const rgbPngHeader = Buffer.from(rgbaPng);
  rgbPngHeader[25] = 2;
  assert.throws(() => validatePngEditMask({ buffer: rgbPngHeader, mimeType: "image/png" }), /alpha/);
});

test("rejects non-PNG input", () => {
  assert.throws(() => validatePngEditMask({ buffer: Buffer.from("not a png"), mimeType: "image/jpeg" }), /PNG/);
});

test("accepts a PNG source whose dimensions match the mask", () => {
  const edit = validatePngEditInputs({
    maskInput: { buffer: rgbaPng, mimeType: "image/png" },
    sourceInput: { buffer: rgbaPng, mimeType: "image/png" },
  });
  assert.equal(edit.mask.width, edit.source.width);
  assert.equal(edit.mask.height, edit.source.height);
});

test("rejects a PNG source whose dimensions differ from the mask", () => {
  const twoPixelSource = Buffer.from(rgbaPng);
  twoPixelSource.writeUInt32BE(2, 16);
  assert.throws(() => validatePngEditInputs({
    maskInput: { buffer: rgbaPng, mimeType: "image/png" },
    sourceInput: { buffer: twoPixelSource, mimeType: "image/png" },
  }), /尺寸必须完全一致/);
});

test("reuses a matching PNG source without conversion", async () => {
  const sourceUrl = `data:image/png;base64,${rgbaPng.toString("base64")}`;
  const mask = validatePngEditMask({ buffer: rgbaPng, mimeType: "image/png" });
  assert.equal(await preparePngEditSource(sourceUrl, mask, async (value) => value), sourceUrl);
});
