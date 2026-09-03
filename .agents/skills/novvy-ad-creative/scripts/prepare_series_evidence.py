#!/usr/bin/env python3
"""Prepare per-episode evidence for one whole-series video-analysis agent."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from prepare_video_evidence import ensure_workspace_output, workspace_dir
from video_analysis_memory import ANALYSIS_VERSION, MEMORY_SCHEMA_VERSION, lookup


WORKFLOW_VERSION = 4
FRAME_INTERVAL_SECONDS = 5
MAX_ANALYZE_DURATION_SECONDS = 900
OVERVIEW_FRAMES_PER_SHEET = 20


def run_episode_evidence(video_path: Path) -> tuple[dict[str, Any] | None, str]:
    evidence_script = Path(__file__).resolve().with_name("prepare_video_evidence.py")
    command = [
        sys.executable,
        str(evidence_script),
        str(video_path),
        "--frame-interval-seconds",
        str(FRAME_INTERVAL_SECONDS),
        "--max-duration-seconds",
        str(MAX_ANALYZE_DURATION_SECONDS),
        "--overview-frame-count",
        str(OVERVIEW_FRAMES_PER_SHEET),
        "--no-audio-preview",
    ]

    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(command, capture_output=True, text=True, env=environment)
    if result.returncode != 0:
        return None, result.stderr.strip() or f"prepare_video_evidence.py exited with {result.returncode}"

    try:
        evidence = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return None, f"prepare_video_evidence.py returned invalid JSON: {exc}"

    frames = evidence.get("frames") if isinstance(evidence, dict) else None
    sheets = evidence.get("overviewSheets") if isinstance(evidence, dict) else None
    if not isinstance(frames, list) or not frames:
        return None, "episode evidence must contain at least one sampled frame"
    if not isinstance(sheets, list) or not sheets:
        return None, "episode evidence must contain at least one overview sheet"
    return evidence, ""


def default_manifest_path(series_key: str) -> Path:
    return workspace_dir() / "video-memory" / "runs" / series_key / "series_evidence_manifest.json"


def build_manifest(
    series_folder: Path,
    *,
    force_reanalyze: bool,
) -> tuple[dict[str, Any], bool]:
    memory = lookup(series_folder, include_analysis=False)
    if memory["inputType"] != "series_folder":
        raise ValueError("prepare_series_evidence.py requires a series folder")

    exact_series_hit = bool(memory["seriesAnalysisHit"]) and not force_reanalyze
    episode_jobs = []
    evidence_failures = []
    evidence_script_call_count = 0

    for episode in memory["episodes"]:
        reuse_episode = bool(episode["analysisHit"]) and not force_reanalyze
        if exact_series_hit:
            evidence_summary = None
            evidence_status = "skipped_exact_series_memory_hit"
            evidence_error = ""
        elif reuse_episode:
            evidence_summary = None
            evidence_status = "skipped_episode_analysis_memory_hit"
            evidence_error = ""
        else:
            evidence_script_call_count += 1
            evidence_summary, evidence_error = run_episode_evidence(Path(episode["source"]))
            evidence_status = "ready" if evidence_summary is not None else "failed"
            if evidence_summary is None:
                evidence_failures.append(
                    {
                        "episodeIndex": episode["episodeIndex"],
                        "fileName": episode["fileName"],
                        "error": evidence_error,
                    }
                )

        if exact_series_hit or reuse_episode:
            analysis_action = "reuse_cached_analysis"
        elif evidence_status == "ready":
            analysis_action = "analyze_in_series_agent"
        else:
            analysis_action = "blocked_by_evidence_failure"

        episode_jobs.append(
            {
                "episodeIndex": episode["episodeIndex"],
                "fileName": episode["fileName"],
                "videoPath": episode["source"],
                "episodeKey": episode["episodeKey"],
                "evidence": {
                    "script": "prepare_video_evidence.py",
                    "requiredCallCount": 0 if exact_series_hit or reuse_episode else 1,
                    "status": evidence_status,
                    "error": evidence_error or None,
                    "actualFrameCount": evidence_summary.get("actualFrameCount") if evidence_summary else None,
                    "overviewSheets": evidence_summary.get("overviewSheets") if evidence_summary else None,
                    "metadataPath": (
                        str(Path(evidence_summary["outputDir"]) / "metadata.json") if evidence_summary else None
                    ),
                    "cacheHit": evidence_summary.get("evidenceCacheHit") if evidence_summary else None,
                },
                "analysis": {
                    "action": analysis_action,
                    "requiredVisualAnalysisPassCount": 1 if analysis_action == "analyze_in_series_agent" else 0,
                    "cachedAnalysisPath": episode["analysisPath"] if reuse_episode or exact_series_hit else None,
                },
            }
        )

    analysis_episode_indexes = [
        job["episodeIndex"] for job in episode_jobs if job["analysis"]["action"] == "analyze_in_series_agent"
    ]
    reused_episode_indexes = [
        job["episodeIndex"] for job in episode_jobs if job["analysis"]["action"] == "reuse_cached_analysis"
    ]
    if exact_series_hit:
        series_agent_action = "reuse_cached_series_analysis"
        required_agent_count = 0
    elif evidence_failures:
        series_agent_action = "blocked_by_evidence_failure"
        required_agent_count = 0
    else:
        series_agent_action = "analyze_entire_series"
        required_agent_count = 1

    manifest = {
        "ok": not evidence_failures,
        "workflowVersion": WORKFLOW_VERSION,
        "workflowMode": "single_series_video_analysis_agent",
        "analysisVersion": ANALYSIS_VERSION,
        "memorySchemaVersion": MEMORY_SCHEMA_VERSION,
        "series": {
            "folder": str(series_folder),
            "seriesKey": memory["seriesKey"],
            "episodeCount": memory["episodeCount"],
            "exactSeriesMemoryHit": exact_series_hit,
            "modelAnalysisRequired": not exact_series_hit,
            "cachedSeriesAnalysisPath": memory["seriesAnalysisPath"] if exact_series_hit else None,
        },
        "fixedInvariants": {
            "frameIntervalSeconds": FRAME_INTERVAL_SECONDS,
            "maxAnalyzeDurationSeconds": MAX_ANALYZE_DURATION_SECONDS,
            "overviewFramesPerSheet": OVERVIEW_FRAMES_PER_SHEET,
            "audioEvidenceEnabled": False,
            "evidencePreparedOnlyForAnalysisMisses": True,
            "maxEvidenceScriptCallsPerMissedEpisode": 1,
            "visualAnalysisPassesPerMissedEpisode": 1,
            "seriesAggregationPasses": 1 if series_agent_action == "analyze_entire_series" else 0,
            "oneSeriesAgentOwnsAllEpisodes": True,
            "parentMaySubmitEpisodeTasks": False,
            "parentMaySubmitAggregationTask": False,
            "seriesAgentMayCreateChildAgents": False,
            "modelMaySelectRepresentativeEpisodes": False,
            "exactSeriesHitRequiresZeroEpisodeModelPasses": True,
            "exactSeriesHitRequiresZeroAggregationPasses": True,
        },
        "evidenceScriptCallCount": evidence_script_call_count,
        "analysisEpisodeIndexes": analysis_episode_indexes,
        "reusedEpisodeIndexes": reused_episode_indexes,
        "episodeJobs": episode_jobs,
        "seriesAgent": {
            "action": series_agent_action,
            "requiredAgentCount": required_agent_count,
            "modelAnalysisRequired": not exact_series_hit and not evidence_failures,
            "requiredEpisodeModelPassCount": len(analysis_episode_indexes),
            "requiredAggregationPassCount": 1 if series_agent_action == "analyze_entire_series" else 0,
            "requiredEpisodeCount": memory["episodeCount"],
            "inputOrder": [job["episodeIndex"] for job in episode_jobs],
            "cachedSeriesAnalysisPath": memory["seriesAnalysisPath"] if exact_series_hit else None,
        },
        "evidenceFailures": evidence_failures,
    }
    return manifest, not evidence_failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prepare every episode and emit an evidence manifest for one whole-series analysis agent."
    )
    parser.add_argument("series_folder", help="Folder containing all episode video files")
    parser.add_argument("--output", help="Manifest JSON path inside the Novvy workspace")
    parser.add_argument(
        "--force-reanalyze",
        action="store_true",
        help="Ignore episode and series analysis memory while retaining evidence cache reuse",
    )
    args = parser.parse_args()

    series_folder = Path(args.series_folder).expanduser().resolve()
    if not series_folder.is_dir():
        print(f"Series folder not found: {series_folder}", file=sys.stderr)
        return 2

    try:
        manifest, ready = build_manifest(
            series_folder,
            force_reanalyze=args.force_reanalyze,
        )
        requested_output = Path(args.output) if args.output else default_manifest_path(manifest["series"]["seriesKey"])
        output_path = ensure_workspace_output(requested_output, "Series workflow manifest")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        manifest["manifestPath"] = str(output_path)
        output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, FileNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
