#!/usr/bin/env python3
"""Validate and query the bundled audiovisual creative-quality matrix."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


MATRIX_PATH = Path(__file__).resolve().parents[1] / "references" / "audiovisual-quality-matrix.json"
EXPECTED_SCHEMA_VERSION = "2.0.0"
EXPECTED_SOURCE_SHA256 = "46d15c7da3e35424540ab6bc17892fda862e84c91ac3be7635ed15eff9f31418"
QUALITY_FIELDS = (
    "模块分类",
    "字段名称",
    "核心定义",
    "适用场景/条件",
    "4级品质分级标准",
    "核心校验检查项",
    "AI硬性生成约束",
    "标准提示词模板",
    "AI可发散范围",
    "业务目标",
    "典型踩坑",
)
DIRECTOR_FIELDS = (
    "模块分类",
    "导演名称",
    "叙事内核",
    "核心视觉要素/构图",
    "运镜与镜头动作",
    "影调与光线",
    "剪辑与声音",
    "可加入意象",
    "表演要求",
    "适用短剧/游戏",
    "不适用场景",
    "AI硬性生成约束",
    "标准提示词模板",
    "AI可发散范围",
    "典型踩坑",
)


class MatrixError(ValueError):
    """Raised when the bundled matrix is incomplete or inconsistent."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise MatrixError(message)


def _validate_rows(rows: Any, expected_fields: tuple[str, ...], prefix: str) -> None:
    _require(isinstance(rows, list), f"{prefix} rows must be a list")
    ids: set[str] = set()
    for index, row in enumerate(rows):
        _require(isinstance(row, dict), f"{prefix} row {index} must be an object")
        record_id = row.get("record_id")
        _require(isinstance(record_id, str) and record_id.startswith(prefix), f"invalid {prefix} record id at row {index}")
        _require(record_id not in ids, f"duplicate record id: {record_id}")
        ids.add(record_id)
        fields = row.get("fields")
        _require(isinstance(fields, dict), f"{record_id} fields must be an object")
        _require(tuple(fields.keys()) == expected_fields, f"{record_id} fields do not match the canonical order")
        for field_name in expected_fields:
            value = fields.get(field_name)
            _require(isinstance(value, str) and value.strip(), f"{record_id}.{field_name} must be non-empty")


def load_matrix(path: Path = MATRIX_PATH) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MatrixError(f"cannot read audiovisual quality matrix: {exc}") from exc

    _require(isinstance(data, dict), "matrix root must be an object")
    _require(data.get("schema_version") == EXPECTED_SCHEMA_VERSION, "unsupported matrix schema version")
    _require(data.get("source_sha256") == EXPECTED_SOURCE_SHA256, "matrix source fingerprint changed")
    quality_rows = data.get("quality_rows")
    director_rows = data.get("director_rows")
    _validate_rows(quality_rows, QUALITY_FIELDS, "DQ-")
    _validate_rows(director_rows, DIRECTOR_FIELDS, "DIR-")
    _require(data.get("quality_record_count") == len(quality_rows) == 129, "quality record count must be 129")
    _require(data.get("director_source_record_count") == 61, "director source record count must be 61")
    _require(data.get("director_record_count") == len(director_rows) == 60, "unique director count must be 60")
    _require(data.get("director_duplicate_record_count") == 1, "director duplicate count must be 1")
    _require(data.get("director_partial_record_count") == 15, "partial director count must be 15")
    _require(data.get("claimed_director_count") == 65, "claimed director count must be 65")
    _require(data.get("director_claim_gap") == 5, "director claim gap must be 5")
    names = [row["fields"]["导演名称"] for row in director_rows]
    _require(len(set(names)) == len(names), "director names must be unique")
    return data


def summary(data: dict[str, Any]) -> dict[str, Any]:
    modules: dict[str, int] = {}
    for row in data["quality_rows"]:
        module = row["fields"]["模块分类"]
        modules[module] = modules.get(module, 0) + 1
    return {
        "schemaVersion": data["schema_version"],
        "sourceSha256": data["source_sha256"],
        "sourceLogicalRecordCount": data["source_logical_record_count"],
        "canonicalRecordCount": data["source_canonical_record_count"],
        "qualityRecordCount": data["quality_record_count"],
        "qualityModules": modules,
        "directorSourceRecordCount": data["director_source_record_count"],
        "uniqueDirectorCount": data["director_record_count"],
        "completeDirectorCount": data["director_record_count"] - data["director_partial_record_count"],
        "partialDirectorCount": data["director_partial_record_count"],
        "duplicateDirectorSourceCount": data["director_duplicate_record_count"],
        "claimedDirectorCount": data["claimed_director_count"],
        "directorClaimGap": data["director_claim_gap"],
        "normalizationRepairCount": len(data["normalization_repairs"]),
    }


def _contains(row: dict[str, Any], text: str) -> bool:
    if not text:
        return True
    needle = text.casefold()
    values = [row.get("record_id", ""), *row.get("fields", {}).values()]
    return any(needle in str(value).casefold() for value in values)


def query_quality(
    data: dict[str, Any],
    *,
    record_id: str = "",
    module: str = "",
    field: str = "",
    search: str = "",
) -> list[dict[str, Any]]:
    rows = data["quality_rows"]
    return [
        row
        for row in rows
        if (not record_id or row["record_id"] == record_id)
        and (not module or row["fields"]["模块分类"] == module)
        and (not field or row["fields"]["字段名称"] == field)
        and _contains(row, search)
    ]


def query_directors(
    data: dict[str, Any],
    *,
    record_id: str = "",
    name: str = "",
    completeness: str = "all",
    search: str = "",
) -> list[dict[str, Any]]:
    rows = data["director_rows"]
    return [
        row
        for row in rows
        if (not record_id or row["record_id"] == record_id)
        and (not name or row["fields"]["导演名称"] == name)
        and (completeness == "all" or row.get("completeness_status") == completeness)
        and _contains(row, search)
    ]


def _limited_result(query_type: str, rows: list[dict[str, Any]], limit: int) -> dict[str, Any]:
    returned = rows if limit == 0 else rows[:limit]
    return {
        "queryType": query_type,
        "matchCount": len(rows),
        "returnedCount": len(returned),
        "truncated": len(returned) != len(rows),
        "records": returned,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=MATRIX_PATH, help="matrix JSON path")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("summary", help="validate the matrix and print its inventory")

    quality = subparsers.add_parser("quality", help="query quality records")
    quality.add_argument("--record-id", default="")
    quality.add_argument("--module", default="")
    quality.add_argument("--field", default="")
    quality.add_argument("--search", default="")
    quality.add_argument("--limit", type=int, default=20, help="maximum results; 0 returns all")

    director = subparsers.add_parser("director", help="query director-style records")
    director.add_argument("--record-id", default="")
    director.add_argument("--name", default="")
    director.add_argument("--completeness", choices=("all", "complete", "partial"), default="all")
    director.add_argument("--search", default="")
    director.add_argument("--limit", type=int, default=20, help="maximum results; 0 returns all")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        data = load_matrix(args.matrix)
        if args.command == "summary":
            result = summary(data)
        elif args.command == "quality":
            if args.limit < 0:
                raise MatrixError("limit cannot be negative")
            rows = query_quality(
                data,
                record_id=args.record_id,
                module=args.module,
                field=args.field,
                search=args.search,
            )
            result = _limited_result("quality", rows, args.limit)
        else:
            if args.limit < 0:
                raise MatrixError("limit cannot be negative")
            rows = query_directors(
                data,
                record_id=args.record_id,
                name=args.name,
                completeness=args.completeness,
                search=args.search,
            )
            result = _limited_result("director", rows, args.limit)
    except MatrixError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
