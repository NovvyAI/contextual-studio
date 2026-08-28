#!/usr/bin/env python3
"""Validate and deterministically compile Novvy storyboard prompts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "novvy.storyboard-prompts.v1"
MODEL = "seedance-2.0-fast"
RATIO = "9:16"
RESOLUTION = "720p"
SHOT_ID_PATTERN = re.compile(r"^shot-(\d{2})$")
PLAN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CJK_PATTERN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
PLACEHOLDER_PATTERN = re.compile(r"\{[^{}]+\}|\bTODO\b|\[TODO", re.IGNORECASE)
URL_PATTERN = re.compile(r"(?:https?://|asset://)", re.IGNORECASE)
FORBIDDEN_PROMPT_TOKENS = (
    "imageUrls",
    "humanImageUrls",
    "generateAudio",
    "resolution",
    "seedance-2.0-fast",
    "720p",
)
RENDERING_TYPES = {"live_action_realistic", "cartoon_animation", "mixed_unknown"}
NARRATIVE_STAGES = {"real_operation", "stage_success", "causal_escalation", "agency_handoff"}

ROOT_KEYS = {
    "schemaVersion",
    "planId",
    "creativeOptionId",
    "visualStyle",
    "referenceSnapshot",
    "generation",
    "shots",
}
VISUAL_STYLE_KEYS = {"renderingType", "reviewLabelZh", "promptLabelEn"}
REFERENCE_KEYS = {"snapshotId", "referenceField", "slotOrder", "referenceUrls", "summaryZh"}
GENERATION_KEYS = {"model", "ratio", "resolution", "generateAudio"}
BILINGUAL_KEYS = {"zh", "en"}
SHOT_KEYS = {
    "shotId",
    "order",
    "version",
    "durationSeconds",
    "narrativeStage",
    "narrativeFunction",
    "coreGameplayAction",
    "audienceAndSellingPoint",
    "includesFinalCard",
    "referenceBindings",
    "identityConstraints",
    "continuity",
    "visualAction",
    "onScreenTextEn",
    "dialogue",
    "voiceoverEn",
    "camera",
    "transition",
    "audio",
    "additionalNegativeConstraints",
    "finalCard",
}
REFERENCE_BINDING_KEYS = {"slot", "purpose"}
DIALOGUE_KEYS = {"speakerEn", "targetEn", "lineEn"}
FINAL_CARD_KEYS = {"productNameEn", "benefitEn", "ctaEn", "destinationEn", "layout"}


class ContractError(ValueError):
    pass


def json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def require_dict(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{path} must be an object")
    return value


def require_list(value: object, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise ContractError(f"{path} must be an array")
    return value


def require_string(value: object, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{path} must be a non-empty string")
    text = value.strip()
    if PLACEHOLDER_PATTERN.search(text):
        raise ContractError(f"{path} contains an unfinished placeholder")
    return text


def require_exact_keys(value: dict[str, Any], expected: set[str], path: str) -> None:
    actual = set(value)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing or extra:
        details = []
        if missing:
            details.append("missing=" + ",".join(missing))
        if extra:
            details.append("extra=" + ",".join(extra))
        raise ContractError(f"{path} has invalid fields ({'; '.join(details)})")


def validate_english(text: str, path: str) -> str:
    if CJK_PATTERN.search(text):
        raise ContractError(f"{path} must not contain Chinese characters")
    if URL_PATTERN.search(text):
        raise ContractError(f"{path} must not contain a real reference URL")
    for token in FORBIDDEN_PROMPT_TOKENS:
        if token.lower() in text.lower():
            raise ContractError(f"{path} must not contain payload/config token {token}")
    return text


def validate_bilingual(value: object, path: str) -> dict[str, str]:
    item = require_dict(value, path)
    require_exact_keys(item, BILINGUAL_KEYS, path)
    zh = require_string(item["zh"], f"{path}.zh")
    en = validate_english(require_string(item["en"], f"{path}.en"), f"{path}.en")
    return {"zh": zh, "en": en}


def validate_string_array(value: object, path: str, *, english: bool = False) -> list[str]:
    items = require_list(value, path)
    result = []
    for index, raw in enumerate(items):
        text = require_string(raw, f"{path}[{index}]")
        result.append(validate_english(text, f"{path}[{index}]") if english else text)
    return result


def validate_bilingual_array(value: object, path: str) -> list[dict[str, str]]:
    return [validate_bilingual(item, f"{path}[{index}]") for index, item in enumerate(require_list(value, path))]


def validate_reference_snapshot(value: object, rendering_type: str) -> dict[str, Any]:
    snapshot = require_dict(value, "referenceSnapshot")
    require_exact_keys(snapshot, REFERENCE_KEYS, "referenceSnapshot")
    snapshot_id = require_string(snapshot["snapshotId"], "referenceSnapshot.snapshotId")
    reference_field = require_string(snapshot["referenceField"], "referenceSnapshot.referenceField")
    if reference_field not in {"imageUrls", "humanImageUrls"}:
        raise ContractError("referenceSnapshot.referenceField must be imageUrls or humanImageUrls")
    if rendering_type == "live_action_realistic" and reference_field != "humanImageUrls":
        raise ContractError("live_action_realistic plans must use a reviewed humanImageUrls snapshot")
    if rendering_type in {"cartoon_animation", "mixed_unknown"} and reference_field != "imageUrls":
        raise ContractError(f"{rendering_type} plans must use imageUrls")

    slots = validate_string_array(snapshot["slotOrder"], "referenceSnapshot.slotOrder")
    urls = validate_string_array(snapshot["referenceUrls"], "referenceSnapshot.referenceUrls")
    if len(slots) != len(urls):
        raise ContractError("referenceSnapshot.slotOrder and referenceUrls must have the same length")
    if len(set(slots)) != len(slots):
        raise ContractError("referenceSnapshot.slotOrder must not contain duplicates")
    if reference_field == "humanImageUrls" and "final_card" in slots:
        raise ContractError("humanImageUrls snapshots must not contain final_card")
    for index, url in enumerate(urls):
        if reference_field == "humanImageUrls" and not url.startswith("asset://"):
            raise ContractError(f"referenceSnapshot.referenceUrls[{index}] must be an asset:// reference")
        if reference_field == "imageUrls" and not url.lower().startswith(("http://", "https://")):
            raise ContractError(f"referenceSnapshot.referenceUrls[{index}] must be an HTTP(S) reference")
    return {
        "snapshotId": snapshot_id,
        "referenceField": reference_field,
        "slotOrder": slots,
        "referenceUrls": urls,
        "summaryZh": require_string(snapshot["summaryZh"], "referenceSnapshot.summaryZh"),
    }


def validate_final_card(value: object, path: str) -> dict[str, Any] | None:
    if value is None:
        return None
    card = require_dict(value, path)
    require_exact_keys(card, FINAL_CARD_KEYS, path)
    result = {
        key: validate_english(require_string(card[key], f"{path}.{key}"), f"{path}.{key}")
        for key in ("productNameEn", "benefitEn", "ctaEn", "destinationEn")
    }
    result["layout"] = validate_bilingual(card["layout"], f"{path}.layout")
    return result


def validate_shot(value: object, index: int, slot_order: list[str], is_last: bool) -> dict[str, Any]:
    path = f"shots[{index}]"
    shot = require_dict(value, path)
    require_exact_keys(shot, SHOT_KEYS, path)
    shot_id = require_string(shot["shotId"], f"{path}.shotId")
    match = SHOT_ID_PATTERN.fullmatch(shot_id)
    expected_order = index + 1
    if match is None or int(match.group(1)) != expected_order:
        raise ContractError(f"{path}.shotId must be shot-{expected_order:02d}")
    order = shot["order"]
    if not isinstance(order, int) or isinstance(order, bool) or order != expected_order:
        raise ContractError(f"{path}.order must be {expected_order}")
    version = shot["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ContractError(f"{path}.version must be an integer >= 1")
    duration = shot["durationSeconds"]
    if not isinstance(duration, int) or isinstance(duration, bool) or not 4 <= duration <= 15:
        raise ContractError(f"{path}.durationSeconds must be an integer from 4 to 15")
    narrative_stage = require_string(shot["narrativeStage"], f"{path}.narrativeStage")
    if narrative_stage not in NARRATIVE_STAGES:
        raise ContractError(f"{path}.narrativeStage is invalid")

    bindings = []
    for binding_index, raw_binding in enumerate(require_list(shot["referenceBindings"], f"{path}.referenceBindings")):
        binding_path = f"{path}.referenceBindings[{binding_index}]"
        binding = require_dict(raw_binding, binding_path)
        require_exact_keys(binding, REFERENCE_BINDING_KEYS, binding_path)
        bindings.append(
            {
                "slot": require_string(binding["slot"], f"{binding_path}.slot"),
                "purpose": validate_bilingual(binding["purpose"], f"{binding_path}.purpose"),
            }
        )
    if [binding["slot"] for binding in bindings] != slot_order:
        raise ContractError(f"{path}.referenceBindings must exactly follow referenceSnapshot.slotOrder")

    continuity = require_dict(shot["continuity"], f"{path}.continuity")
    require_exact_keys(continuity, {"start", "end"}, f"{path}.continuity")
    includes_final_card = shot["includesFinalCard"]
    if not isinstance(includes_final_card, bool):
        raise ContractError(f"{path}.includesFinalCard must be boolean")
    if includes_final_card != is_last:
        raise ContractError("only the final shot may include the final card, and the final shot must include it")
    final_card = validate_final_card(shot["finalCard"], f"{path}.finalCard")
    if includes_final_card != (final_card is not None):
        raise ContractError(f"{path}.finalCard must match includesFinalCard")

    dialogue = []
    for dialogue_index, raw_dialogue in enumerate(require_list(shot["dialogue"], f"{path}.dialogue")):
        dialogue_path = f"{path}.dialogue[{dialogue_index}]"
        item = require_dict(raw_dialogue, dialogue_path)
        require_exact_keys(item, DIALOGUE_KEYS, dialogue_path)
        dialogue.append(
            {
                key: validate_english(require_string(item[key], f"{dialogue_path}.{key}"), f"{dialogue_path}.{key}")
                for key in ("speakerEn", "targetEn", "lineEn")
            }
        )

    return {
        "shotId": shot_id,
        "order": order,
        "version": version,
        "durationSeconds": duration,
        "narrativeStage": narrative_stage,
        "narrativeFunction": validate_bilingual(shot["narrativeFunction"], f"{path}.narrativeFunction"),
        "coreGameplayAction": validate_bilingual(shot["coreGameplayAction"], f"{path}.coreGameplayAction"),
        "audienceAndSellingPoint": validate_bilingual(shot["audienceAndSellingPoint"], f"{path}.audienceAndSellingPoint"),
        "includesFinalCard": includes_final_card,
        "referenceBindings": bindings,
        "identityConstraints": validate_bilingual_array(shot["identityConstraints"], f"{path}.identityConstraints"),
        "continuity": {
            "start": validate_bilingual(continuity["start"], f"{path}.continuity.start"),
            "end": validate_bilingual(continuity["end"], f"{path}.continuity.end"),
        },
        "visualAction": validate_bilingual(shot["visualAction"], f"{path}.visualAction"),
        "onScreenTextEn": validate_string_array(shot["onScreenTextEn"], f"{path}.onScreenTextEn", english=True),
        "dialogue": dialogue,
        "voiceoverEn": validate_string_array(shot["voiceoverEn"], f"{path}.voiceoverEn", english=True),
        "camera": validate_bilingual(shot["camera"], f"{path}.camera"),
        "transition": validate_bilingual(shot["transition"], f"{path}.transition"),
        "audio": validate_bilingual(shot["audio"], f"{path}.audio"),
        "additionalNegativeConstraints": validate_bilingual_array(
            shot["additionalNegativeConstraints"], f"{path}.additionalNegativeConstraints"
        ),
        "finalCard": final_card,
    }


def validate_plan(value: object) -> dict[str, Any]:
    plan = require_dict(value, "root")
    require_exact_keys(plan, ROOT_KEYS, "root")
    if plan.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError(f"schemaVersion must be {SCHEMA_VERSION}")
    plan_id = require_string(plan["planId"], "planId")
    if not PLAN_ID_PATTERN.fullmatch(plan_id):
        raise ContractError("planId must be a stable alphanumeric ID")

    style = require_dict(plan["visualStyle"], "visualStyle")
    require_exact_keys(style, VISUAL_STYLE_KEYS, "visualStyle")
    rendering_type = require_string(style["renderingType"], "visualStyle.renderingType")
    if rendering_type not in RENDERING_TYPES:
        raise ContractError("visualStyle.renderingType is invalid")
    normalized_style = {
        "renderingType": rendering_type,
        "reviewLabelZh": require_string(style["reviewLabelZh"], "visualStyle.reviewLabelZh"),
        "promptLabelEn": validate_english(
            require_string(style["promptLabelEn"], "visualStyle.promptLabelEn"), "visualStyle.promptLabelEn"
        ),
    }

    generation = require_dict(plan["generation"], "generation")
    require_exact_keys(generation, GENERATION_KEYS, "generation")
    expected_generation = {"model": MODEL, "ratio": RATIO, "resolution": RESOLUTION, "generateAudio": True}
    if generation != expected_generation:
        raise ContractError(f"generation must equal {expected_generation}")

    snapshot = validate_reference_snapshot(plan["referenceSnapshot"], rendering_type)
    raw_shots = require_list(plan["shots"], "shots")
    if not 1 <= len(raw_shots) <= 3:
        raise ContractError("shots must contain 1 to 3 items")
    shots = [validate_shot(shot, index, snapshot["slotOrder"], index == len(raw_shots) - 1) for index, shot in enumerate(raw_shots)]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "planId": plan_id,
        "creativeOptionId": require_string(plan["creativeOptionId"], "creativeOptionId"),
        "visualStyle": normalized_style,
        "referenceSnapshot": snapshot,
        "generation": expected_generation,
        "shots": shots,
    }


def list_or_none(values: list[str]) -> str:
    return "；".join(values) if values else "无"


def render_review(plan: dict[str, Any]) -> str:
    snapshot = plan["referenceSnapshot"]
    generation = plan["generation"]
    lines = [
        "# 逐分镜任务审核稿",
        "",
        f"计划 ID：{plan['planId']}",
        f"创意方案：{plan['creativeOptionId']}",
        f"参考图快照：{snapshot['snapshotId']}（{snapshot['summaryZh']}）",
        f"固定生成参数：{generation['model']} / {generation['ratio']} / {generation['resolution']} / 音频开启",
        "",
        "| 分镜 ID | 版本 | 时长 | 叙事阶段 | 剧情功能 | 核心玩法动作 | 是否落版 | 参考图快照 |",
        "|---|---:|---:|---|---|---|---|---|",
    ]
    for shot in plan["shots"]:
        lines.append(
            f"| {shot['shotId']} | V{shot['version']} | {shot['durationSeconds']}s | {shot['narrativeStage']} | "
            f"{shot['narrativeFunction']['zh']} | {shot['coreGameplayAction']['zh']} | "
            f"{'是' if shot['includesFinalCard'] else '否'} | {snapshot['snapshotId']} |"
        )

    for shot in plan["shots"]:
        lines.extend(render_shot_review(plan, shot))
    return "\n".join(lines).rstrip() + "\n"


def render_shot_review(plan: dict[str, Any], shot: dict[str, Any]) -> list[str]:
    snapshot = plan["referenceSnapshot"]
    dialogue = [f"{item['speakerEn']} -> {item['targetEn']}: \"{item['lineEn']}\"" for item in shot["dialogue"]]
    identity = [item["zh"] for item in shot["identityConstraints"]]
    negative = [item["zh"] for item in shot["additionalNegativeConstraints"]]
    card = shot["finalCard"]
    card_lines = ["不包含落版。"]
    if card:
        card_lines = [
            f"产品名：{card['productNameEn']}",
            f"核心利益点：{card['benefitEn']}",
            f"CTA：{card['ctaEn']}",
            f"承接入口：{card['destinationEn']}",
            f"布局：{card['layout']['zh']}",
        ]
    lines = [
        "",
        f"### {shot['shotId']} / V{shot['version']}",
        "",
        "【分镜任务】",
        f"时长：{shot['durationSeconds']} 秒",
        f"画幅：{plan['generation']['ratio']}",
        f"画风：{plan['visualStyle']['reviewLabelZh']}",
        f"叙事阶段：{shot['narrativeStage']}",
        f"剧情功能：{shot['narrativeFunction']['zh']}",
        f"核心玩法动作：{shot['coreGameplayAction']['zh']}",
        f"受众与卖点：{shot['audienceAndSellingPoint']['zh']}",
        "",
        "【参考图绑定】",
        f"快照 ID：{snapshot['snapshotId']}",
        f"实际槽位顺序：{' -> '.join(snapshot['slotOrder'])}",
    ]
    for index, binding in enumerate(shot["referenceBindings"], start=1):
        lines.append(f"{index}. {binding['slot']}：{binding['purpose']['zh']}")
    lines.extend(
        [
            "",
            "【人物与画面一致性】",
            *([f"- {item}" for item in identity] or ["- 无额外约束。"]),
            "- 所有分镜必须使用同一个参考图快照；不得换脸、改变身份或新增主要人物。",
            "",
            "【前后镜连续性】",
            f"起始状态：{shot['continuity']['start']['zh']}",
            f"结束交接：{shot['continuity']['end']['zh']}",
            "",
            "【当前分镜脚本】",
            f"画面动作：{shot['visualAction']['zh']}",
            f"屏幕文字：{list_or_none(shot['onScreenTextEn'])}",
            f"人物对白：{list_or_none(dialogue)}",
            f"旁白：{list_or_none(shot['voiceoverEn'])}",
            f"运镜：{shot['camera']['zh']}",
            f"转场：{shot['transition']['zh']}",
            "",
            "【声音与对白】",
            f"{shot['audio']['zh']}；所有对白、旁白、屏幕文字和 CTA 只使用英文。",
            "",
            "【落版】",
            *card_lines,
            "",
            "【负面约束】",
            "- 不要水印、换脸、身份漂移、肢体畸形、服装穿模、镜中错误人物、无关场景或新增主要人物。",
            "- 不要生成中文画面文字或中文语音，不要添加无关字幕或无关品牌标识。",
            *([f"- {item}" for item in negative] or ["- 无额外负面约束。"]),
        ]
    )
    return lines


def english_list(values: list[str]) -> str:
    return "; ".join(values) if values else "None."


def render_prompt(plan: dict[str, Any], shot: dict[str, Any]) -> str:
    snapshot = plan["referenceSnapshot"]
    bindings = [f"{index}. {item['slot']}: {item['purpose']['en']}" for index, item in enumerate(shot["referenceBindings"], start=1)]
    identity = [item["en"] for item in shot["identityConstraints"]]
    dialogue = [f"{item['speakerEn']} to {item['targetEn']}: \"{item['lineEn']}\"" for item in shot["dialogue"]]
    negative = [item["en"] for item in shot["additionalNegativeConstraints"]]
    card = shot["finalCard"]
    card_text = "Do not show a final card in this shot."
    if card:
        card_text = (
            f"Show the approved final card only at the end. Product name: {card['productNameEn']}. "
            f"Benefit: {card['benefitEn']}. CTA: {card['ctaEn']}. Destination: {card['destinationEn']}. "
            f"Layout: {card['layout']['en']}"
        )
    prompt = "\n".join(
        [
            "[SHOT TASK]",
            f"Shot ID: {shot['shotId']}",
            f"Version: V{shot['version']}",
            f"Create a {shot['durationSeconds']}-second vertical {plan['visualStyle']['promptLabelEn']} short video.",
            f"Narrative stage: {shot['narrativeStage']}",
            f"Narrative function: {shot['narrativeFunction']['en']}",
            f"Core gameplay action: {shot['coreGameplayAction']['en']}",
            f"Audience and selling point: {shot['audienceAndSellingPoint']['en']}",
            "",
            "[REFERENCE BINDING]",
            "Use every reference image supplied with this task in the exact order below. Keep this immutable reference set for every shot and revision in the plan.",
            *bindings,
            "",
            "[IDENTITY AND VISUAL CONSISTENCY]",
            *(identity or ["Preserve every established character identity and the confirmed visual style."]),
            "Do not change faces, body type, age, skin tone, hairstyle, clothing identity, or established props. Do not add major characters.",
            "",
            "[CONTINUITY]",
            f"Start state: {shot['continuity']['start']['en']}",
            f"End handoff: {shot['continuity']['end']['en']}",
            "",
            "[SHOT SCRIPT]",
            f"Visual action: {shot['visualAction']['en']}",
            f"On-screen text: {english_list(shot['onScreenTextEn'])}",
            f"Dialogue: {english_list(dialogue)}",
            f"Voiceover: {english_list(shot['voiceoverEn'])}",
            f"Camera: {shot['camera']['en']}",
            f"Transition: {shot['transition']['en']}",
            "",
            "[AUDIO AND LANGUAGE]",
            shot["audio"]["en"],
            "All on-screen text, spoken dialogue, voiceover, CTA, and final-card copy must be English only.",
            "",
            "[FINAL CARD]",
            card_text,
            "",
            "[NEGATIVE CONSTRAINTS]",
            "No watermark, face swap, identity drift, anatomy errors, extra limbs, clothing intersections, incorrect reflections, unrelated scene changes, extra major characters, Chinese text, Chinese speech, unrelated subtitles, or unrelated brand marks.",
            *negative,
        ]
    ).rstrip()
    for token in FORBIDDEN_PROMPT_TOKENS:
        if token.lower() in prompt.lower():
            raise ContractError(f"compiled prompt unexpectedly contains forbidden token {token}")
    if URL_PATTERN.search(prompt):
        raise ContractError("compiled prompt unexpectedly contains a reference URL")
    return prompt


def compile_plan(value: object, shot_id: str = "") -> dict[str, Any]:
    plan = validate_plan(value)
    selected = plan["shots"]
    if shot_id:
        selected = [shot for shot in selected if shot["shotId"] == shot_id]
        if not selected:
            raise ContractError(f"shot not found: {shot_id}")
    snapshot = plan["referenceSnapshot"]
    tasks = []
    for shot in selected:
        prompt = render_prompt(plan, shot)
        payload = {
            "model": MODEL,
            "prompt": prompt,
            "ratio": RATIO,
            "duration": shot["durationSeconds"],
            "resolution": RESOLUTION,
            "generateAudio": True,
            snapshot["referenceField"]: list(snapshot["referenceUrls"]),
        }
        tasks.append(
            {
                "shotId": shot["shotId"],
                "order": shot["order"],
                "version": shot["version"],
                "durationSeconds": shot["durationSeconds"],
                "snapshotId": snapshot["snapshotId"],
                "prompt": prompt,
                "promptSha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "payload": payload,
            }
        )
    return {
        "ok": True,
        "schemaVersion": SCHEMA_VERSION,
        "planId": plan["planId"],
        "creativeOptionId": plan["creativeOptionId"],
        "referenceSnapshotId": snapshot["snapshotId"],
        "taskTableMarkdown": render_review(plan).split("\n\n### ", 1)[0].rstrip() + "\n",
        "reviewMarkdown": render_review(plan),
        "videoTasks": tasks,
    }


def workspace_dir() -> Path:
    configured = os.environ.get("NOVVY_WORKSPACE_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else (Path.home() / "novvy_ad_workplace").resolve()


def ensure_workspace_output(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(workspace_dir())
    except ValueError as exc:
        raise ContractError(f"output directory must be inside Novvy workspace: {workspace_dir()}") from exc
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def load_json(path: Path) -> object:
    try:
        return json.loads(path.expanduser().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"could not read storyboard JSON: {exc}") from exc


def check_schema_file(path: Path) -> None:
    schema = load_json(path)
    schema_obj = require_dict(schema, "schema")
    version = require_dict(schema_obj.get("properties"), "schema.properties").get("schemaVersion")
    if not isinstance(version, dict) or version.get("const") != SCHEMA_VERSION:
        raise ContractError("schema file version does not match compiler")
    required = schema_obj.get("required")
    if not isinstance(required, list) or set(required) != ROOT_KEYS:
        raise ContractError("schema root required fields do not match compiler")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compile a fixed Novvy storyboard prompt contract.")
    parser.add_argument("input", type=Path, help="Storyboard plan JSON")
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory inside Novvy workspace")
    parser.add_argument("--shot-id", default="", help="Compile only one shot for a revision")
    parser.add_argument("--check-schema", type=Path, default=None, help="Verify the checked-in schema version and root fields")
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        if args.check_schema:
            check_schema_file(args.check_schema)
        compiled = compile_plan(load_json(args.input), args.shot_id)
        output_dir = ensure_workspace_output(args.output_dir)
        stem = f"{compiled['planId']}-{args.shot_id or 'all-shots'}"
        review_path = output_dir / f"{stem}-review.md"
        compiled_path = output_dir / f"{stem}-compiled.json"
        review_path.write_text(compiled["reviewMarkdown"], encoding="utf-8")
        compiled_path.write_text(json_dumps(compiled) + "\n", encoding="utf-8")
        print(
            json_dumps(
                {
                    "ok": True,
                    "schemaVersion": SCHEMA_VERSION,
                    "planId": compiled["planId"],
                    "referenceSnapshotId": compiled["referenceSnapshotId"],
                    "shotCount": len(compiled["videoTasks"]),
                    "reviewPath": str(review_path),
                    "compiledPath": str(compiled_path),
                    "promptHashes": [
                        {"shotId": task["shotId"], "promptSha256": task["promptSha256"]}
                        for task in compiled["videoTasks"]
                    ],
                }
            )
        )
        return 0
    except ContractError as exc:
        print(json_dumps({"ok": False, "errorClass": "storyboard_contract", "error": str(exc), "safeNextStep": "fix_storyboard_json_then_recompile"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

