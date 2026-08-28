#!/usr/bin/env python3
"""Validate reference reviews, build immutable snapshots, and plan recovery."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any


REVIEW_SCHEMA_VERSION = "novvy.reference-review.v1"
RECOVERY_SCHEMA_VERSION = "novvy.generation-recovery.v1"
RECOVERY_STATE_VERSION = "novvy.generation-recovery-state.v1"
UPLOAD_MODES = {"asset", "seedance-human"}
VISUAL_CLASSES = {"human_photorealistic", "non_human", "uncertain"}
REVIEW_DECISIONS = {"pass", "exclude", "block"}
MATCH_RESULTS = {"pass", "fail", "unknown", "not_applicable"}
KNOWN_NON_HUMAN_SLOTS = {"final_card", "product_icon"}
REFERENCE_SLOT_ORDER = ("male_front", "male_side", "female_front", "female_side", "final_card")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
ACTIVE_SHOT_STATES = {"submitted", "polling", "generated", "approved", "failed"}
REFERENCE_ERROR_CLASSES = {"reference_mode_mismatch", "material_not_human", "human_review_required"}
STOP_ERROR_CLASSES = {"auth", "permission", "prompt_or_parameter", "content_policy", "unknown"}
ALLOWED_ERROR_CLASSES = REFERENCE_ERROR_CLASSES | STOP_ERROR_CLASSES | {
    "reference_invalid_or_inactive",
    "transient_remote",
    "ambiguous_commit",
    "response_contract",
    "source_invalid",
}

ROOT_REVIEW_KEYS = {
    "schemaVersion",
    "reviewId",
    "requestedUploadMode",
    "requiredSlots",
    "waivedSlots",
    "priorFailure",
    "slots",
}
PRIOR_FAILURE_KEYS = {"phase", "errorClass", "failedSlot", "summary"}
SLOT_KEYS = {
    "slot",
    "source",
    "sourceFingerprint",
    "pixelReviewed",
    "visualClass",
    "reviewDecision",
    "reviewReason",
    "identityMatch",
    "viewMatch",
}


class WorkflowError(ValueError):
    def __init__(self, message: str, *, error_class: str, safe_next_step: str) -> None:
        super().__init__(message)
        self.error_class = error_class
        self.safe_next_step = safe_next_step


def json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def require_dict(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkflowError(f"{path} must be an object", error_class="contract", safe_next_step="fix_reference_workflow_json")
    return value


def require_list(value: object, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise WorkflowError(f"{path} must be an array", error_class="contract", safe_next_step="fix_reference_workflow_json")
    return value


def require_string(value: object, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise WorkflowError(f"{path} must be a string", error_class="contract", safe_next_step="fix_reference_workflow_json")
    return value.strip()


def require_exact_keys(value: dict[str, Any], expected: set[str], path: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = ",".join(sorted(expected - actual)) or "none"
        extra = ",".join(sorted(actual - expected)) or "none"
        raise WorkflowError(
            f"{path} fields are invalid; missing={missing}; extra={extra}",
            error_class="contract",
            safe_next_step="fix_reference_workflow_json",
        )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def validate_local_fingerprint(source: str, fingerprint: str, path: str) -> None:
    if source.lower().startswith(("http://", "https://")):
        return
    local_path = Path(source).expanduser().resolve()
    if not local_path.is_file():
        raise WorkflowError(
            f"{path}.source is not a readable local file",
            error_class="source_invalid",
            safe_next_step="provide_a_readable_reference_image_then_repeat_pixel_review",
        )
    if not SHA256_PATTERN.fullmatch(fingerprint):
        raise WorkflowError(
            f"{path}.sourceFingerprint must be sha256:<hex> for a local reviewed image",
            error_class="contract",
            safe_next_step="recompute_the_reviewed_image_sha256",
        )
    actual = sha256_file(local_path)
    if actual != fingerprint:
        raise WorkflowError(
            f"{path}.source changed after pixel review",
            error_class="source_invalid",
            safe_next_step="repeat_pixel_review_on_the_current_image_bytes",
        )


def validate_review(value: object) -> dict[str, Any]:
    review = require_dict(value, "root")
    require_exact_keys(review, ROOT_REVIEW_KEYS, "root")
    if review.get("schemaVersion") != REVIEW_SCHEMA_VERSION:
        raise WorkflowError(
            f"schemaVersion must be {REVIEW_SCHEMA_VERSION}",
            error_class="contract",
            safe_next_step="fix_reference_review_schema_version",
        )
    mode = require_string(review["requestedUploadMode"], "requestedUploadMode")
    if mode not in UPLOAD_MODES:
        raise WorkflowError("requestedUploadMode is invalid", error_class="contract", safe_next_step="choose_asset_or_seedance_human")
    required_slots = [require_string(item, f"requiredSlots[{index}]") for index, item in enumerate(require_list(review["requiredSlots"], "requiredSlots"))]
    waived_slots = [require_string(item, f"waivedSlots[{index}]") for index, item in enumerate(require_list(review["waivedSlots"], "waivedSlots"))]
    if len(set(required_slots)) != len(required_slots) or len(set(waived_slots)) != len(waived_slots):
        raise WorkflowError("requiredSlots and waivedSlots must not contain duplicates", error_class="contract", safe_next_step="deduplicate_required_or_waived_slots")
    if not set(waived_slots).issubset(set(required_slots)):
        raise WorkflowError("waivedSlots must be a subset of requiredSlots", error_class="contract", safe_next_step="fix_required_and_waived_slot_contract")
    if mode == "seedance-human" and not required_slots:
        raise WorkflowError("seedance-human review requires at least one required character slot", error_class="contract", safe_next_step="declare_the_character_slots_required_by_the_storyboard")

    prior_failure = review["priorFailure"]
    if prior_failure is not None:
        prior_failure = require_dict(prior_failure, "priorFailure")
        require_exact_keys(prior_failure, PRIOR_FAILURE_KEYS, "priorFailure")
        phase = require_string(prior_failure["phase"], "priorFailure.phase")
        if phase not in {"upload", "video"}:
            raise WorkflowError("priorFailure.phase is invalid", error_class="contract", safe_next_step="fix_reference_review_json")
        prior_failure = {
            "phase": phase,
            "errorClass": require_string(prior_failure["errorClass"], "priorFailure.errorClass"),
            "failedSlot": require_string(prior_failure["failedSlot"], "priorFailure.failedSlot", allow_empty=True),
            "summary": require_string(prior_failure["summary"], "priorFailure.summary"),
        }

    slots = []
    seen = set()
    for index, raw in enumerate(require_list(review["slots"], "slots")):
        path = f"slots[{index}]"
        item = require_dict(raw, path)
        require_exact_keys(item, SLOT_KEYS, path)
        slot = require_string(item["slot"], f"{path}.slot")
        if slot in seen:
            raise WorkflowError(f"duplicate slot: {slot}", error_class="contract", safe_next_step="deduplicate_reference_review_slots")
        seen.add(slot)
        if slot == "product_icon":
            raise WorkflowError(
                "product_icon is not a reference slot",
                error_class="source_invalid",
                safe_next_step="remove_product_icon_from_the_reference_review",
            )
        source = require_string(item["source"], f"{path}.source")
        fingerprint = require_string(item["sourceFingerprint"], f"{path}.sourceFingerprint")
        pixel_reviewed = item["pixelReviewed"]
        if not isinstance(pixel_reviewed, bool):
            raise WorkflowError(f"{path}.pixelReviewed must be boolean", error_class="contract", safe_next_step="fix_reference_review_json")
        visual_class = require_string(item["visualClass"], f"{path}.visualClass")
        decision = require_string(item["reviewDecision"], f"{path}.reviewDecision")
        identity_match = require_string(item["identityMatch"], f"{path}.identityMatch")
        view_match = require_string(item["viewMatch"], f"{path}.viewMatch")
        if visual_class not in VISUAL_CLASSES or decision not in REVIEW_DECISIONS:
            raise WorkflowError(f"{path} visual class or decision is invalid", error_class="contract", safe_next_step="fix_reference_review_json")
        if identity_match not in MATCH_RESULTS or view_match not in MATCH_RESULTS:
            raise WorkflowError(f"{path} identity/view result is invalid", error_class="contract", safe_next_step="fix_reference_review_json")
        if not pixel_reviewed:
            raise WorkflowError(
                f"{slot} was not inspected at pixel level",
                error_class="human_review_required",
                safe_next_step="render_and_reinspect_every_candidate_image_then_rebuild_the_review_manifest",
            )
        validate_local_fingerprint(source, fingerprint, path)
        if mode == "seedance-human":
            if source.lower().startswith(("http://", "https://")):
                raise WorkflowError(
                    f"{slot} uses a mutable remote URL",
                    error_class="source_invalid",
                    safe_next_step="materialize_the_remote_image_inside_novvy_workspace_then_review_and_upload_the_same_bytes",
                )
            expected_decision = {
                "human_photorealistic": "pass",
                "non_human": "exclude",
                "uncertain": "block",
            }[visual_class]
            if decision != expected_decision:
                raise WorkflowError(
                    f"{slot} decision must be {expected_decision} for {visual_class}",
                    error_class="contract",
                    safe_next_step="fix_reference_review_decision",
                )
            if slot in KNOWN_NON_HUMAN_SLOTS and visual_class == "human_photorealistic":
                raise WorkflowError(
                    f"{slot} can never be confirmed as a human reference",
                    error_class="material_not_human",
                    safe_next_step="exclude_the_non_human_slot_and_repeat_pixel_review",
                )
            if decision == "pass" and (identity_match != "pass" or view_match != "pass"):
                raise WorkflowError(
                    f"{slot} cannot pass without identity and view matches",
                    error_class="human_review_required",
                    safe_next_step="replace_or_reinspect_the_character_reference",
                )
        else:
            expected_decision = "block" if visual_class == "uncertain" else "pass"
            if decision != expected_decision:
                raise WorkflowError(
                    f"{slot} decision must be {expected_decision} for {visual_class} in asset mode",
                    error_class="contract",
                    safe_next_step="fix_reference_review_decision",
                )
        slots.append(
            {
                "slot": slot,
                "source": source,
                "sourceFingerprint": fingerprint,
                "pixelReviewed": pixel_reviewed,
                "visualClass": visual_class,
                "reviewDecision": decision,
                "reviewReason": require_string(item["reviewReason"], f"{path}.reviewReason"),
                "identityMatch": identity_match,
                "viewMatch": view_match,
            }
        )
    if not slots:
        raise WorkflowError("slots must not be empty", error_class="contract", safe_next_step="provide_reference_review_slots")
    reviewed_names = {item["slot"] for item in slots}
    unknown_required = set(required_slots) - reviewed_names
    if unknown_required:
        raise WorkflowError(
            "required slots were not reviewed: " + ", ".join(sorted(unknown_required)),
            error_class="human_review_required",
            safe_next_step="review_or_replace_every_required_reference_slot",
        )
    return {
        "schemaVersion": REVIEW_SCHEMA_VERSION,
        "reviewId": require_string(review["reviewId"], "reviewId"),
        "requestedUploadMode": mode,
        "requiredSlots": required_slots,
        "waivedSlots": waived_slots,
        "priorFailure": prior_failure,
        "slots": slots,
    }


def plan_upload(value: object) -> dict[str, Any]:
    review = validate_review(value)
    mode = review["requestedUploadMode"]
    if mode == "asset" and any(
        item["visualClass"] == "human_photorealistic" and item["reviewDecision"] == "pass" for item in review["slots"]
    ):
        raise WorkflowError(
            "asset mode contains a photorealistic human reference",
            error_class="reference_mode_mismatch",
            safe_next_step="repeat_pixel_review_and_use_seedance_human_upload_for_only_the_confirmed_human_slots",
        )
    waived_set = set(review["waivedSlots"])
    blocked = [item for item in review["slots"] if item["reviewDecision"] == "block" and item["slot"] not in waived_set]
    if blocked:
        raise WorkflowError(
            "uncertain reference slots block upload: " + ", ".join(item["slot"] for item in blocked),
            error_class="human_review_required",
            safe_next_step="replace_or_reinspect_uncertain_slots_before_upload",
        )
    accepted = [item for item in review["slots"] if item["reviewDecision"] == "pass"]
    skipped = [
        item
        for item in review["slots"]
        if item["reviewDecision"] == "exclude" or (item["reviewDecision"] == "block" and item["slot"] in waived_set)
    ]
    if mode == "seedance-human":
        accepted = [item for item in accepted if item["visualClass"] == "human_photorealistic"]
    if not accepted:
        raise WorkflowError(
            "no accepted reference slots remain",
            error_class="human_review_required" if mode == "seedance-human" else "source_invalid",
            safe_next_step="provide_at_least_one_valid_reference_image",
        )
    order = {slot: index for index, slot in enumerate(REFERENCE_SLOT_ORDER)}
    accepted = [
        item
        for _key, item in sorted(
            ((order.get(item["slot"], len(order) + index), item) for index, item in enumerate(accepted)),
            key=lambda pair: pair[0],
        )
    ]
    accepted_names = {item["slot"] for item in accepted}
    missing_required = set(review["requiredSlots"]) - accepted_names - set(review["waivedSlots"])
    if missing_required:
        raise WorkflowError(
            "required reference slots did not pass review: " + ", ".join(sorted(missing_required)),
            error_class="human_review_required",
            safe_next_step="replace_missing_required_references_or_record_an_explicit_user_waiver_before_upload",
        )
    args = []
    for item in accepted:
        args.extend(["--slot", f"{item['slot']}={item['source']}"])
    if mode == "seedance-human":
        for item in accepted:
            args.extend(["--confirmed-human-slot", item["slot"]])
    args.extend(["--mode", mode])
    canonical = {
        "reviewId": review["reviewId"],
        "uploadMode": mode,
        "requiredSlots": review["requiredSlots"],
        "waivedSlots": review["waivedSlots"],
        "accepted": [
            {"slot": item["slot"], "sourceFingerprint": item["sourceFingerprint"], "visualClass": item["visualClass"]}
            for item in accepted
        ],
        "skipped": [
            {"slot": item["slot"], "sourceFingerprint": item["sourceFingerprint"], "visualClass": item["visualClass"]}
            for item in skipped
        ],
    }
    audit_id = "audit-" + hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    return {
        "ok": True,
        "schemaVersion": REVIEW_SCHEMA_VERSION,
        "reviewId": review["reviewId"],
        "auditId": audit_id,
        "uploadMode": mode,
        "requiredSlots": review["requiredSlots"],
        "waivedSlots": review["waivedSlots"],
        "acceptedSlots": accepted,
        "confirmedHumanSlots": [item["slot"] for item in accepted] if mode == "seedance-human" else [],
        "skippedSlots": [
            {"slot": item["slot"], "visualClass": item["visualClass"], "reason": item["reviewReason"]} for item in skipped
        ],
        "uploadArgs": args,
        "limits": {"maxScriptRuns": 3, "maxSameErrorClassRepairRuns": 1},
    }


def build_snapshot(upload_result: object, upload_plan: object, supersedes_snapshot_id: str = "") -> dict[str, Any]:
    result = require_dict(upload_result, "uploadResult")
    plan = require_dict(upload_plan, "uploadPlan")
    if result.get("ok") is not True:
        raise WorkflowError("uploadResult is not successful", error_class="response_contract", safe_next_step="fix_or_recover_the_upload_before_building_a_snapshot")
    field = require_string(result.get("referenceField"), "uploadResult.referenceField")
    expected_field = "humanImageUrls" if plan.get("uploadMode") == "seedance-human" else "imageUrls"
    if field != expected_field:
        raise WorkflowError("uploadResult reference field does not match the reviewed upload plan", error_class="response_contract", safe_next_step="recover_or_repeat_the_correct_upload_mode")
    refs = require_list(result.get("referenceUrls"), "uploadResult.referenceUrls")
    accepted = require_list(plan.get("acceptedSlots"), "uploadPlan.acceptedSlots")
    result_slots = require_list(result.get("slots"), "uploadResult.slots")
    accepted_names = [require_string(item.get("slot"), f"uploadPlan.acceptedSlots[{index}].slot") for index, item in enumerate(accepted) if isinstance(item, dict)]
    result_names = [require_string(item.get("slot"), f"uploadResult.slots[{index}].slot") for index, item in enumerate(result_slots) if isinstance(item, dict)]
    if len(refs) != len(accepted) or result_names != accepted_names:
        raise WorkflowError("uploadResult slot order or reference count changed", error_class="response_contract", safe_next_step="recover_created_references_before_retrying_upload")
    ordered = []
    for index, (item, reference) in enumerate(zip(accepted, refs)):
        if not isinstance(item, dict):
            raise WorkflowError("uploadPlan accepted slot is invalid", error_class="contract", safe_next_step="rebuild_upload_plan")
        reference = require_string(reference, f"uploadResult.referenceUrls[{index}]")
        ordered.append(
            {
                "slot": accepted_names[index],
                "reference": reference,
                "sourceFingerprint": require_string(item.get("sourceFingerprint"), f"uploadPlan.acceptedSlots[{index}].sourceFingerprint"),
                "visualClass": require_string(item.get("visualClass"), f"uploadPlan.acceptedSlots[{index}].visualClass"),
            }
        )
    canonical = {"referenceField": field, "orderedSlots": ordered}
    snapshot_id = "ref-" + hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:20]
    return {
        "ok": True,
        "schemaVersion": "novvy.reference-snapshot.v1",
        "snapshotId": snapshot_id,
        "supersedesSnapshotId": supersedes_snapshot_id,
        "referenceField": field,
        "referenceUrls": [item["reference"] for item in ordered],
        "slotOrder": [item["slot"] for item in ordered],
        "summaryZh": "、".join(item["slot"] for item in ordered) + f"，共 {len(ordered)} 张已审核参考图",
        "orderedSlots": ordered,
        "auditId": plan.get("auditId", ""),
    }


def infer_error_class(phase: str, code: str, message: str) -> str:
    text = f"{code} {message}".lower()
    if any(marker in text for marker in ("invalid token", "unauthorized", "forbidden", "authentication")):
        return "auth"
    if any(marker in text for marker in ("content policy", "safety policy", "moderation")):
        return "content_policy"
    if any(
        marker in text
        for marker in (
            "non-human",
            "non human",
            "not human",
            "not a real person",
            "material_not_human",
            "material not human",
            "真人素材不合格",
        )
    ):
        return "material_not_human"
    if any(marker in text for marker in ("humanimageurls", "human image", "human reference", "seedance human", "reference_mode_mismatch", "真人参考图")):
        return "reference_mode_mismatch"
    if any(marker in text for marker in ("inactive asset", "asset inactive", "reference expired", "invalid reference", "asset not found")):
        return "reference_invalid_or_inactive"
    if any(marker in text for marker in ("timeout", "timed out", "rate limit", "429", "503", "temporarily unavailable")):
        return "transient_remote"
    if any(marker in text for marker in ("invalid parameter", "invalid prompt", "bad request")):
        return "prompt_or_parameter"
    return "unknown"


def plan_recovery(value: object) -> dict[str, Any]:
    context = require_dict(value, "root")
    if context.get("schemaVersion") != RECOVERY_SCHEMA_VERSION:
        raise WorkflowError(f"schemaVersion must be {RECOVERY_SCHEMA_VERSION}", error_class="contract", safe_next_step="fix_recovery_context_json")
    phase = require_string(context.get("phase"), "phase")
    if phase not in {"upload", "video"}:
        raise WorkflowError("phase must be upload or video", error_class="contract", safe_next_step="fix_recovery_context_json")
    failure = require_dict(context.get("failure"), "failure")
    explicit = str(failure.get("errorClass") or "").strip()
    code = str(failure.get("code") or "").strip()
    message = str(failure.get("message") or "").strip()
    error_class = explicit if explicit in ALLOWED_ERROR_CLASSES else infer_error_class(phase, code, message)
    correction_count = context.get("referenceCorrectionCount", 0)
    operation_attempt = context.get("operationAttempt", 1)
    if not isinstance(correction_count, int) or correction_count < 0 or not isinstance(operation_attempt, int) or operation_attempt < 1:
        raise WorkflowError("retry counters are invalid", error_class="contract", safe_next_step="fix_recovery_context_json")
    active_snapshot_id = str(context.get("activeSnapshotId") or "").strip()
    shot_states = require_list(context.get("shotStates", []), "shotStates")

    if phase == "video" and error_class in REFERENCE_ERROR_CLASSES and (not active_snapshot_id or not shot_states):
        raise WorkflowError(
            "video reference recovery requires activeSnapshotId and shotStates",
            error_class="contract",
            safe_next_step="provide_the_active_snapshot_and_every_storyboard_shot_state",
        )

    affected = []
    if phase == "video" and error_class in REFERENCE_ERROR_CLASSES:
        for index, raw in enumerate(shot_states):
            item = require_dict(raw, f"shotStates[{index}]")
            if item.get("snapshotId") == active_snapshot_id and item.get("status") in ACTIVE_SHOT_STATES:
                affected.append(require_string(item.get("shotId"), f"shotStates[{index}].shotId"))
        if not affected:
            raise WorkflowError(
                "no shots are bound to activeSnapshotId",
                error_class="contract",
                safe_next_step="fix_active_snapshot_or_shot_state_before_recovery",
            )

    if error_class in REFERENCE_ERROR_CLASSES:
        if phase == "video" and correction_count >= 1:
            return {
                "ok": False,
                "state": "BLOCKED",
                "errorClass": error_class,
                "nextAction": "stop_after_reference_correction_budget_exhausted",
                "safeNextStep": "inspect_platform_failure_and_request_replacement_material_or_user_direction",
                "affectedShotIds": affected,
                "limits": {"maxReferenceCorrectionsPerShot": 1, "maxUploadScriptRuns": 3},
            }
        return {
            "ok": True,
            "state": "PIXEL_REVIEW_PENDING",
            "errorClass": error_class,
            "nextAction": "start_reference_image_audit_subagent",
            "requiredUploadMode": "seedance-human",
            "excludeNonHumanAndUncertain": True,
            "requiresNewSnapshot": phase == "video",
            "invalidateOldSnapshotResults": phase == "video",
            "affectedShotIds": affected,
            "requiresPaidConfirmationBeforeRegeneration": phase == "video" and bool(affected),
            "safeNextStep": "reinspect_actual_pixels_build_validated_review_manifest_upload_only_human_slots_then_recompile_and_regenerate_affected_shots",
            "limits": {"maxReferenceCorrectionsPerShot": 1, "maxUploadScriptRuns": 3},
        }
    if error_class == "reference_invalid_or_inactive":
        return {
            "ok": True,
            "state": "REFERENCE_RECOVERY_PENDING",
            "errorClass": error_class,
            "nextAction": "recover_or_wait_for_the_existing_reference",
            "requiresNewSnapshot": False,
            "affectedShotIds": [],
            "safeNextStep": "recover_the_existing_asset_reference_before_considering_reupload",
        }
    if error_class == "transient_remote" and operation_attempt < 3:
        return {
            "ok": True,
            "state": "RETRY_PENDING",
            "errorClass": error_class,
            "nextAction": "retry_the_same_remote_operation",
            "retryAttempt": operation_attempt + 1,
            "requiresNewSnapshot": False,
            "affectedShotIds": [],
            "safeNextStep": "retry_with_bounded_backoff_without_reauditing_material",
        }
    if error_class in {"ambiguous_commit", "response_contract"}:
        return {
            "ok": False,
            "state": "RECOVERY_LOOKUP_REQUIRED",
            "errorClass": error_class,
            "nextAction": "look_up_the_created_asset_or_task_before_retrying",
            "safeNextStep": "recover_the_created_object_by_platform_records_or_operation_id_to_avoid_duplicates",
            "affectedShotIds": [],
        }
    return {
        "ok": False,
        "state": "BLOCKED",
        "errorClass": error_class,
        "nextAction": "stop_and_apply_safe_next_step",
        "safeNextStep": "fix_auth_permission_input_policy_or_unknown_failure_before_retrying",
        "affectedShotIds": [],
    }


def load_recovery_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schemaVersion": RECOVERY_STATE_VERSION,
            "referenceCorrectionCounts": {},
            "records": [],
        }
    data = load_json(path)
    state = require_dict(data, "recoveryState")
    if state.get("schemaVersion") != RECOVERY_STATE_VERSION:
        raise WorkflowError(
            f"recovery state schemaVersion must be {RECOVERY_STATE_VERSION}",
            error_class="contract",
            safe_next_step="fix_or_recover_the_generation_recovery_state",
        )
    counts = state.get("referenceCorrectionCounts")
    records = state.get("records")
    if not isinstance(counts, dict) or not isinstance(records, list):
        raise WorkflowError(
            "recovery state counts or records are invalid",
            error_class="contract",
            safe_next_step="fix_or_recover_the_generation_recovery_state",
        )
    for shot_id, count in counts.items():
        if not isinstance(shot_id, str) or not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise WorkflowError(
                "recovery state contains an invalid correction count",
                error_class="contract",
                safe_next_step="fix_or_recover_the_generation_recovery_state",
            )
    return state


def write_recovery_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json_dumps(state) + "\n", encoding="utf-8")
    temporary.replace(path)


def persisted_correction_count(state: dict[str, Any], shot_states: object) -> int:
    counts = state["referenceCorrectionCounts"]
    values = []
    if isinstance(shot_states, list):
        for item in shot_states:
            if isinstance(item, dict) and isinstance(item.get("shotId"), str):
                values.append(int(counts.get(item["shotId"], 0)))
    return max(values, default=0)


def record_reference_correction(
    state: dict[str, Any],
    *,
    shot_ids: list[str],
    snapshot_id: str,
    task_ids: list[str],
) -> dict[str, Any]:
    if not shot_ids or len(set(shot_ids)) != len(shot_ids):
        raise WorkflowError("record-correction requires unique shot IDs", error_class="contract", safe_next_step="provide_every_corrected_shot_once")
    if not snapshot_id:
        raise WorkflowError("record-correction requires the new snapshot ID", error_class="contract", safe_next_step="provide_the_new_reference_snapshot_id")
    if task_ids and len(task_ids) != len(shot_ids):
        raise WorkflowError("task IDs must match shot IDs", error_class="contract", safe_next_step="record_each_created_generation_task")
    counts = state["referenceCorrectionCounts"]
    exhausted = [shot_id for shot_id in shot_ids if int(counts.get(shot_id, 0)) >= 1]
    if exhausted:
        raise WorkflowError(
            "reference correction budget already exhausted for: " + ", ".join(exhausted),
            error_class="reference_mode_mismatch",
            safe_next_step="stop_after_reference_correction_budget_exhausted",
        )
    for shot_id in shot_ids:
        counts[shot_id] = int(counts.get(shot_id, 0)) + 1
    state["records"].append(
        {
            "snapshotId": snapshot_id,
            "shotIds": shot_ids,
            "taskIds": task_ids,
        }
    )
    return state


def workspace_dir() -> Path:
    configured = os.environ.get("NOVVY_WORKSPACE_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else (Path.home() / "novvy_ad_workplace").resolve()


def ensure_output_dir(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(workspace_dir())
    except ValueError as exc:
        raise WorkflowError(
            f"output directory must be inside Novvy workspace: {workspace_dir()}",
            error_class="local_environment",
            safe_next_step="choose_output_inside_novvy_workspace",
        ) from exc
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def ensure_workspace_file(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(workspace_dir())
    except ValueError as exc:
        raise WorkflowError(
            f"state file must be inside Novvy workspace: {workspace_dir()}",
            error_class="local_environment",
            safe_next_step="choose_recovery_state_inside_novvy_workspace",
        ) from exc
    return resolved


def load_json(path: Path) -> object:
    try:
        return json.loads(path.expanduser().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkflowError(str(exc), error_class="contract", safe_next_step="fix_input_json") from exc


def write_internal_result(result: dict[str, Any], output_dir: Path, stem: str) -> Path:
    path = output_dir / f"{stem}.json"
    path.write_text(json_dumps(result) + "\n", encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage Novvy reference review and recovery contracts.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan-upload")
    plan_parser.add_argument("input", type=Path)
    plan_parser.add_argument("--output-dir", type=Path, required=True)

    snapshot_parser = subparsers.add_parser("build-snapshot")
    snapshot_parser.add_argument("upload_result", type=Path)
    snapshot_parser.add_argument("upload_plan", type=Path)
    snapshot_parser.add_argument("--supersedes-snapshot-id", default="")
    snapshot_parser.add_argument("--output-dir", type=Path, required=True)

    recovery_parser = subparsers.add_parser("plan-recovery")
    recovery_parser.add_argument("input", type=Path)
    recovery_parser.add_argument("--output-dir", type=Path, required=True)
    recovery_parser.add_argument("--state-file", type=Path, default=None)

    record_parser = subparsers.add_parser("record-correction")
    record_parser.add_argument("--shot-id", action="append", required=True)
    record_parser.add_argument("--snapshot-id", required=True)
    record_parser.add_argument("--task-id", action="append", default=[])
    record_parser.add_argument("--output-dir", type=Path, required=True)
    record_parser.add_argument("--state-file", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        output_dir = ensure_output_dir(args.output_dir)
        if args.command == "plan-upload":
            result = plan_upload(load_json(args.input))
            output_path = write_internal_result(result, output_dir, f"{result['reviewId']}-upload-plan")
            public = {
                "ok": True,
                "state": "UPLOAD_PLAN_READY",
                "auditId": result["auditId"],
                "uploadMode": result["uploadMode"],
                "requiredSlots": result["requiredSlots"],
                "waivedSlots": result["waivedSlots"],
                "acceptedSlots": [item["slot"] for item in result["acceptedSlots"]],
                "confirmedHumanSlots": result["confirmedHumanSlots"],
                "skippedSlots": result["skippedSlots"],
                "reviewManifestPath": str(args.input.expanduser().resolve()),
                "uploadPlanPath": str(output_path),
            }
        elif args.command == "build-snapshot":
            result = build_snapshot(load_json(args.upload_result), load_json(args.upload_plan), args.supersedes_snapshot_id)
            output_path = write_internal_result(result, output_dir, f"{result['snapshotId']}-snapshot")
            public = {
                "ok": True,
                "state": "SNAPSHOT_READY",
                "snapshotId": result["snapshotId"],
                "supersedesSnapshotId": result["supersedesSnapshotId"],
                "referenceField": result["referenceField"],
                "slotOrder": result["slotOrder"],
                "outputPath": str(output_path),
            }
        elif args.command == "plan-recovery":
            state_path = ensure_workspace_file(args.state_file or (output_dir / "recovery-state.json"))
            state = load_recovery_state(state_path)
            context = require_dict(load_json(args.input), "root")
            persisted = persisted_correction_count(state, context.get("shotStates"))
            requested = context.get("referenceCorrectionCount", 0)
            if not isinstance(requested, int) or isinstance(requested, bool) or requested < 0:
                raise WorkflowError("referenceCorrectionCount is invalid", error_class="contract", safe_next_step="fix_recovery_context_json")
            context["referenceCorrectionCount"] = max(requested, persisted)
            result = plan_recovery(context)
            output_path = write_internal_result(result, output_dir, "latest-recovery-plan")
            public = dict(result)
            public["outputPath"] = str(output_path)
            public["stateFile"] = str(state_path)
        else:
            state_path = ensure_workspace_file(args.state_file or (output_dir / "recovery-state.json"))
            state = load_recovery_state(state_path)
            updated = record_reference_correction(
                state,
                shot_ids=args.shot_id,
                snapshot_id=args.snapshot_id,
                task_ids=args.task_id,
            )
            write_recovery_state(state_path, updated)
            public = {
                "ok": True,
                "state": "REFERENCE_CORRECTION_RECORDED",
                "snapshotId": args.snapshot_id,
                "shotIds": args.shot_id,
                "referenceCorrectionCounts": {
                    shot_id: updated["referenceCorrectionCounts"][shot_id] for shot_id in args.shot_id
                },
                "stateFile": str(state_path),
            }
        print(json_dumps(public))
        return 0 if public.get("ok") else 2
    except WorkflowError as exc:
        print(json_dumps({"ok": False, "errorClass": exc.error_class, "error": str(exc), "safeNextStep": exc.safe_next_step}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
