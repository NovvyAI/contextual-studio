import fs from "node:fs";

const matrixUrl = new URL("../.agents/skills/novvy-ad-creative/references/audiovisual-quality-matrix.json", import.meta.url);
const matrix = JSON.parse(fs.readFileSync(matrixUrl, "utf8"));
const rows = Array.isArray(matrix.director_rows) ? matrix.director_rows : [];

function useful(value) {
  const text = String(value || "").trim();
  return text && text !== "not_provided" ? text : "";
}

function observableParameters(row) {
  const fields = row.fields || {};
  return [
    ["构图", fields["核心视觉要素/构图"]],
    ["运镜", fields["运镜与镜头动作"]],
    ["光色", fields["影调与光线"]],
    ["剪辑与声音", fields["剪辑与声音"]],
    ["表演", fields["表演要求"]],
  ].filter(([, value]) => useful(value)).slice(0, 4).map(([label, value]) => `${label}：${useful(value)}`);
}

const directors = [...new Map(rows.map((row) => ({
  id: row.record_id,
  name: useful(row.fields?.["导演名称"]),
  completeness: row.completeness_status === "complete" ? "完整" : "部分",
  parameters: observableParameters(row),
})).filter((item) => item.name).map((item) => [item.name, item])).values()];

export function listDirectorStyles() {
  return directors.map((item) => ({ ...item, parameters: [...item.parameters] }));
}

export function directorStyle(name) {
  return listDirectorStyles().find((item) => item.name === String(name || "").trim()) || null;
}
