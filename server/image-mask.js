import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxMaskBytes = 50 * 1024 * 1024;

function validatePng(input, label, requireAlpha) {
  if (!input) return null;
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || []);
  const mimeType = String(input.mimeType || "").toLowerCase();
  if (mimeType && mimeType !== "image/png") throw new Error(`${label}必须是 PNG 格式`);
  if (!buffer.length) throw new Error(`${label}为空，请重新标注`);
  if (buffer.length >= maxMaskBytes) throw new Error(`${label}必须小于 50MB`);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(pngSignature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label}不是有效的 PNG 文件`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  if (!width || !height) throw new Error(`${label}尺寸无效`);
  if (bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`${label}必须是 8-bit PNG`);
  if (requireAlpha && ![4, 6].includes(colorType)) throw new Error(`${label}必须是带 alpha 通道的 8-bit PNG`);
  return {
    buffer,
    mimeType: "image/png",
    fileName: String(input.fileName || "image.png"),
    width,
    height,
  };
}

export function validatePngEditMask(input) {
  return validatePng(input, "局部编辑蒙版", true);
}

export function validatePngEditInputs(input = null) {
  const mask = validatePngEditMask(input?.maskInput);
  const source = validatePng(input?.sourceInput, "局部编辑原图", false);
  if (source && !mask) throw new Error("提交局部编辑原图时必须同时提供蒙版");
  if (source && (source.width !== mask.width || source.height !== mask.height)) {
    throw new Error("局部编辑原图与蒙版尺寸必须完全一致");
  }
  return { mask, source };
}

export async function uploadPngEditInput(input, publicUrl, kind = "mask") {
  if (!input) return "";
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `contextual-image-edit-${kind}-`));
  const inputPath = path.join(tempDir, `${kind}.png`);
  await fsp.writeFile(inputPath, input.buffer);
  try {
    return await publicUrl(inputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function imageConversionPython() {
  const projectPython = path.resolve(".venv/bin/python");
  const resolver = path.resolve(".agents/skills/novvy-ad-creative/scripts/novvy_python.sh");
  const preferredPython = process.env.CONTEXTUAL_PYTHON || (fs.existsSync(projectPython) ? projectPython : "");
  try {
    const resolved = await execFileAsync(resolver, [], {
      env: { ...process.env, ...(preferredPython ? { NOVVY_PYTHON: preferredPython } : {}) },
      maxBuffer: 1024 * 1024,
    });
    return resolved.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`局部编辑原图转换需要 Python 3.10+ 和 Pillow，请重新运行 ./install_environment.sh。${detail ? ` (${detail})` : ""}`);
  }
}

function ensureMatchingSize(source, mask) {
  if (source.width !== mask.width || source.height !== mask.height) {
    throw new Error(`局部编辑原图 ${source.width}×${source.height} 与蒙版 ${mask.width}×${mask.height} 尺寸不一致`);
  }
}

export async function preparePngEditSource(source, mask, publicUrl) {
  const sourceUrl = await publicUrl(source);
  if (!mask) return sourceUrl;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`下载局部编辑原图失败（HTTP ${response.status}）`);
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes >= maxMaskBytes) throw new Error("局部编辑原图必须小于 50MB");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length >= maxMaskBytes) throw new Error("局部编辑原图必须小于 50MB");
  if (buffer.length >= pngSignature.length && buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    const png = validatePng({ buffer, mimeType: "image/png", fileName: "source.png" }, "局部编辑原图", false);
    ensureMatchingSize(png, mask);
    return sourceUrl;
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "contextual-image-edit-source-"));
  const inputPath = path.join(tempDir, "source-input");
  const outputPath = path.join(tempDir, "source.png");
  await fsp.writeFile(inputPath, buffer);
  try {
    const python = await imageConversionPython();
    const script = path.resolve("server/convert-image-to-png.py");
    await execFileAsync(python, [script, inputPath, outputPath], { maxBuffer: 1024 * 1024 });
    const png = validatePng({ buffer: await fsp.readFile(outputPath), mimeType: "image/png", fileName: "source.png" }, "局部编辑原图", false);
    ensureMatchingSize(png, mask);
    return await publicUrl(outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}
