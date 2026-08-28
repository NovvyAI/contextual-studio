from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storyboard = load_module("storyboard_prompt_contract", SCRIPT_DIR / "storyboard_prompt_contract.py")
reference = load_module("reference_workflow", SCRIPT_DIR / "reference_workflow.py")
uploader = load_module("upload_ai_platform_asset", SCRIPT_DIR / "upload_ai_platform_asset.py")
memory = load_module("video_analysis_memory", SCRIPT_DIR / "video_analysis_memory.py")
series_evidence = load_module("prepare_series_evidence", SCRIPT_DIR / "prepare_series_evidence.py")
concat = load_module("concat_storyboard_videos", SCRIPT_DIR / "concat_storyboard_videos.py")


def bilingual(zh: str, en: str) -> dict[str, str]:
    return {"zh": zh, "en": en}


def shot(index: int, slots: list[str], final: bool) -> dict:
    return {
        "shotId": f"shot-{index:02d}",
        "order": index,
        "version": 1,
        "durationSeconds": 10,
        "narrativeStage": "real_operation" if index == 1 else "agency_handoff",
        "narrativeFunction": bilingual("承接并展示操作", "Continue the story and show one clear operation."),
        "coreGameplayAction": bilingual("合并物品", "Merge two matching items."),
        "audienceAndSellingPoint": bilingual("面向休闲玩家，强调即时反馈", "Give casual players immediate, readable feedback."),
        "includesFinalCard": final,
        "referenceBindings": [
            {"slot": slot_name, "purpose": bilingual(f"锁定 {slot_name}", f"Preserve the approved {slot_name} identity and view.")}
            for slot_name in slots
        ],
        "identityConstraints": [bilingual("保持同一人物", "Keep the exact same character identity.")],
        "continuity": {
            "start": bilingual("承接上一镜动作", "Continue the previous action and camera direction."),
            "end": bilingual("把动作交给下一镜", "Hand the same action into the next shot."),
        },
        "visualAction": bilingual("角色完成一次清楚操作", "The character completes one clear, readable operation."),
        "onScreenTextEn": ["Merge and grow"],
        "dialogue": [{"speakerEn": "Lead", "targetEn": "Partner", "lineEn": "One more move."}],
        "voiceoverEn": [],
        "camera": bilingual("稳定推进", "Use a controlled push-in."),
        "transition": bilingual("动作匹配转场", "Use a match-on-action transition."),
        "audio": bilingual("延续环境声并增强反馈音", "Continue the ambience and emphasize the success sound."),
        "additionalNegativeConstraints": [],
        "finalCard": (
            {
                "productNameEn": "Merge Story",
                "benefitEn": "Build your next chapter",
                "ctaEn": "Play Now",
                "destinationEn": "App Store",
                "layout": bilingual("清晰居中，避开人物脸", "Use a clean centered layout away from faces."),
            }
            if final
            else None
        ),
    }


def human_storyboard_plan() -> dict:
    slots = ["lead_front", "lead_side"]
    return {
        "schemaVersion": storyboard.SCHEMA_VERSION,
        "planId": "plan-A",
        "creativeOptionId": "A",
        "visualStyle": {
            "renderingType": "live_action_realistic",
            "reviewLabelZh": "真人写实",
            "promptLabelEn": "live-action realistic",
        },
        "referenceSnapshot": {
            "snapshotId": "ref-human-001",
            "referenceField": "humanImageUrls",
            "slotOrder": slots,
            "referenceUrls": ["asset://lead-front", "asset://lead-side"],
            "summaryZh": "两张已审核真人参考图",
        },
        "generation": {
            "model": storyboard.MODEL,
            "ratio": storyboard.RATIO,
            "resolution": storyboard.RESOLUTION,
            "generateAudio": True,
        },
        "shots": [shot(1, slots, False), shot(2, slots, True)],
    }


class StoryboardContractTests(unittest.TestCase):
    def test_compile_is_deterministic_and_uses_fixed_sections(self) -> None:
        plan = human_storyboard_plan()
        first = storyboard.compile_plan(plan)
        second = storyboard.compile_plan(plan)
        self.assertEqual(first, second)
        self.assertEqual(len(first["videoTasks"]), 2)
        review = first["reviewMarkdown"]
        for heading in (
            "【分镜任务】",
            "【参考图绑定】",
            "【人物与画面一致性】",
            "【前后镜连续性】",
            "【当前分镜脚本】",
            "【声音与对白】",
            "【落版】",
            "【负面约束】",
        ):
            self.assertEqual(review.count(heading), 2)
        for task in first["videoTasks"]:
            self.assertEqual(task["snapshotId"], "ref-human-001")
            self.assertEqual(task["payload"]["humanImageUrls"], ["asset://lead-front", "asset://lead-side"])
            self.assertNotIn("humanImageUrls", task["prompt"])
            self.assertNotIn("asset://", task["prompt"])

    def test_rejects_extra_fields_chinese_english_and_wrong_final_card(self) -> None:
        plan = human_storyboard_plan()
        plan["unexpected"] = True
        with self.assertRaises(storyboard.ContractError):
            storyboard.compile_plan(plan)

        plan = human_storyboard_plan()
        plan["shots"][0]["visualAction"]["en"] = "角色 moves forward"
        with self.assertRaises(storyboard.ContractError):
            storyboard.compile_plan(plan)

        plan = human_storyboard_plan()
        plan["shots"][0]["includesFinalCard"] = True
        with self.assertRaises(storyboard.ContractError):
            storyboard.compile_plan(plan)

    def test_single_shot_revision_does_not_recompile_other_shots(self) -> None:
        plan = human_storyboard_plan()
        original = storyboard.compile_plan(plan)
        plan["shots"][1]["version"] = 2
        plan["shots"][1]["visualAction"] = bilingual("修改第二镜动作", "Change only the second shot action.")
        revised = storyboard.compile_plan(plan, "shot-02")
        self.assertEqual(len(revised["videoTasks"]), 1)
        self.assertEqual(revised["videoTasks"][0]["version"], 2)
        self.assertNotEqual(revised["videoTasks"][0]["promptSha256"], original["videoTasks"][1]["promptSha256"])


class ReferenceWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.human_path = self.root / "human.png"
        self.card_path = self.root / "card.png"
        self.human_path.write_bytes(b"reviewed-human-bytes")
        self.card_path.write_bytes(b"reviewed-card-bytes")

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def fingerprint(path: Path) -> str:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()

    def review_manifest(self) -> dict:
        return {
            "schemaVersion": reference.REVIEW_SCHEMA_VERSION,
            "reviewId": "review-A",
            "requestedUploadMode": "seedance-human",
            "requiredSlots": ["lead_front"],
            "waivedSlots": [],
            "priorFailure": None,
            "slots": [
                {
                    "slot": "lead_front",
                    "source": str(self.human_path),
                    "sourceFingerprint": self.fingerprint(self.human_path),
                    "pixelReviewed": True,
                    "visualClass": "human_photorealistic",
                    "reviewDecision": "pass",
                    "reviewReason": "真人照片观感且身份视角可核对",
                    "identityMatch": "pass",
                    "viewMatch": "pass",
                },
                {
                    "slot": "final_card",
                    "source": str(self.card_path),
                    "sourceFingerprint": self.fingerprint(self.card_path),
                    "pixelReviewed": True,
                    "visualClass": "non_human",
                    "reviewDecision": "exclude",
                    "reviewReason": "落版不是人像",
                    "identityMatch": "not_applicable",
                    "viewMatch": "not_applicable",
                },
            ],
        }

    def test_human_plan_excludes_non_human_and_binds_hash(self) -> None:
        manifest = self.review_manifest()
        plan = reference.plan_upload(manifest)
        self.assertEqual([item["slot"] for item in plan["acceptedSlots"]], ["lead_front"])
        self.assertEqual(plan["confirmedHumanSlots"], ["lead_front"])
        self.assertEqual(plan["skippedSlots"][0]["slot"], "final_card")

        self.human_path.write_bytes(b"changed-after-review")
        with self.assertRaises(reference.WorkflowError) as raised:
            reference.plan_upload(manifest)
        self.assertEqual(raised.exception.error_class, "source_invalid")

    def test_asset_plan_rejects_confirmed_photorealistic_human(self) -> None:
        manifest = self.review_manifest()
        manifest["requestedUploadMode"] = "asset"
        manifest["slots"][1]["reviewDecision"] = "pass"
        with self.assertRaises(reference.WorkflowError) as raised:
            reference.plan_upload(manifest)
        self.assertEqual(raised.exception.error_class, "reference_mode_mismatch")

    def test_required_human_slot_cannot_be_silently_excluded(self) -> None:
        manifest = self.review_manifest()
        manifest["requiredSlots"] = ["lead_front", "final_card"]
        with self.assertRaises(reference.WorkflowError) as raised:
            reference.plan_upload(manifest)
        self.assertEqual(raised.exception.error_class, "human_review_required")
        manifest["waivedSlots"] = ["final_card"]
        plan = reference.plan_upload(manifest)
        self.assertEqual(plan["waivedSlots"], ["final_card"])

    def test_recovery_invalidates_all_old_snapshot_results(self) -> None:
        context = {
            "schemaVersion": reference.RECOVERY_SCHEMA_VERSION,
            "phase": "video",
            "failure": {
                "errorClass": "reference_mode_mismatch",
                "code": "HUMAN_REFERENCE_REQUIRED",
                "message": "Use human references",
            },
            "referenceCorrectionCount": 0,
            "operationAttempt": 1,
            "activeSnapshotId": "ref-old",
            "shotStates": [
                {"shotId": "shot-01", "snapshotId": "ref-old", "status": "approved"},
                {"shotId": "shot-02", "snapshotId": "ref-old", "status": "failed"},
                {"shotId": "shot-03", "snapshotId": "ref-new", "status": "approved"},
            ],
        }
        recovery = reference.plan_recovery(context)
        self.assertEqual(recovery["state"], "PIXEL_REVIEW_PENDING")
        self.assertEqual(recovery["affectedShotIds"], ["shot-01", "shot-02"])
        self.assertTrue(recovery["invalidateOldSnapshotResults"])
        self.assertTrue(recovery["requiresPaidConfirmationBeforeRegeneration"])

        context["referenceCorrectionCount"] = 1
        blocked = reference.plan_recovery(context)
        self.assertEqual(blocked["state"], "BLOCKED")

        state = {
            "schemaVersion": reference.RECOVERY_STATE_VERSION,
            "referenceCorrectionCounts": {},
            "records": [],
        }
        reference.record_reference_correction(
            state,
            shot_ids=["shot-01", "shot-02"],
            snapshot_id="ref-new",
            task_ids=["task-01", "task-02"],
        )
        self.assertEqual(reference.persisted_correction_count(state, context["shotStates"]), 1)
        with self.assertRaises(reference.WorkflowError):
            reference.record_reference_correction(
                state,
                shot_ids=["shot-01"],
                snapshot_id="ref-newer",
                task_ids=["task-03"],
            )

    def test_snapshot_hash_is_stable_and_changes_with_reference(self) -> None:
        plan = reference.plan_upload(self.review_manifest())
        upload = {
            "ok": True,
            "referenceField": "humanImageUrls",
            "referenceUrls": ["asset://lead-v1"],
            "slots": [{"slot": "lead_front"}],
        }
        first = reference.build_snapshot(upload, plan)
        second = reference.build_snapshot(upload, plan)
        self.assertEqual(first["snapshotId"], second["snapshotId"])
        upload["referenceUrls"] = ["asset://lead-v2"]
        changed = reference.build_snapshot(upload, plan)
        self.assertNotEqual(first["snapshotId"], changed["snapshotId"])


class UploaderAndMemoryTests(unittest.TestCase):
    def test_upload_error_is_sanitized(self) -> None:
        error = uploader.UploadError(
            "bad response",
            failed_step="http_upload_parse",
            response_body={"uploadUrl": "https://signed.example/secret"},
            completed_slots=["lead_front"],
            pending_slots=["lead_side"],
        )
        result = uploader.compact_error_response(error)
        self.assertNotIn("responseBody", result)
        self.assertEqual(result["errorClass"], "response_contract")
        self.assertEqual(result["completedSlots"], ["lead_front"])

    def test_series_analysis_validator_rejects_missing_or_unordered_episodes(self) -> None:
        valid = {
            "ok": True,
            "episodeCount": 2,
            "episodeAnalyses": [{"episodeIndex": 1}, {"episodeIndex": 2}],
            "reusedEpisodeIndexes": [1],
            "analyzedEpisodeIndexes": [2],
            "seriesAnalysis": {"episodeEndingOpportunities": [{}, {}]},
            "failedEpisodes": [],
        }
        memory.validate_series_analysis(valid, 2)
        invalid = json.loads(json.dumps(valid))
        invalid["episodeAnalyses"] = [{"episodeIndex": 2}, {"episodeIndex": 1}]
        with self.assertRaises(ValueError):
            memory.validate_series_analysis(invalid, 2)

    def test_partial_memory_hit_prepares_only_missed_episode_evidence(self) -> None:
        lookup_result = {
            "inputType": "series_folder",
            "seriesAnalysisHit": False,
            "seriesKey": "series-key",
            "episodeCount": 2,
            "seriesAnalysisPath": "/workspace/series.json",
            "episodes": [
                {
                    "episodeIndex": 1,
                    "fileName": "ep1.mp4",
                    "source": "/videos/ep1.mp4",
                    "episodeKey": "episode-1",
                    "analysisHit": True,
                    "analysisPath": "/workspace/episode-1.json",
                },
                {
                    "episodeIndex": 2,
                    "fileName": "ep2.mp4",
                    "source": "/videos/ep2.mp4",
                    "episodeKey": "episode-2",
                    "analysisHit": False,
                    "analysisPath": "/workspace/episode-2.json",
                },
            ],
        }
        evidence = {
            "frames": ["frame.png"],
            "overviewSheets": ["sheet.png"],
            "actualFrameCount": 1,
            "contactSheet": "sheet.png",
            "outputDir": "/workspace/evidence",
            "evidenceCacheHit": False,
        }
        with mock.patch.object(series_evidence, "lookup", return_value=lookup_result), mock.patch.object(
            series_evidence, "run_episode_evidence", return_value=(evidence, "")
        ) as run_evidence:
            manifest, ready = series_evidence.build_manifest(Path("/videos"), no_audio_preview=False, force_reanalyze=False)
        self.assertTrue(ready)
        run_evidence.assert_called_once_with(Path("/videos/ep2.mp4"), False)
        self.assertEqual(manifest["evidenceScriptCallCount"], 1)
        self.assertEqual(manifest["episodeJobs"][0]["evidence"]["requiredCallCount"], 0)
        self.assertEqual(manifest["episodeJobs"][1]["evidence"]["requiredCallCount"], 1)

    def test_concat_manifest_rejects_mixed_reference_snapshots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "concat.json"
            manifest = {
                "schemaVersion": concat.CONCAT_MANIFEST_VERSION,
                "activeSnapshotId": "ref-current",
                "shots": [
                    {
                        "shotId": "shot-01",
                        "order": 1,
                        "version": 1,
                        "status": "approved",
                        "snapshotId": "ref-current",
                        "source": "/videos/shot-01.mp4",
                    },
                    {
                        "shotId": "shot-02",
                        "order": 2,
                        "version": 2,
                        "status": "approved",
                        "snapshotId": "ref-old",
                        "source": "/videos/shot-02.mp4",
                    },
                ],
            }
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(concat.ConcatError):
                concat.parse_concat_manifest(str(path))
            manifest["shots"][1]["snapshotId"] = "ref-current"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            clips, snapshot_id = concat.parse_concat_manifest(str(path))
            self.assertEqual(snapshot_id, "ref-current")
            self.assertEqual([item["shotId"] for item in clips], ["shot-01", "shot-02"])


if __name__ == "__main__":
    unittest.main()
