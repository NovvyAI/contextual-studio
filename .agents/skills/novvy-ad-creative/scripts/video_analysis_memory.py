#!/usr/bin/env python3
"""Persist and reuse Novvy video analysis by content fingerprint."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from prepare_video_evidence import content_fingerprint, default_output_dir, ensure_workspace_output, workspace_dir


MEMORY_SCHEMA_VERSION = 1
ANALYSIS_VERSION = "novvy-video-analysis-v5-drama-only-persistent"
VIDEO_EXTENSIONS = {
    ".3gp",
    ".avi",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".m2ts",
    ".ts",
    ".webm",
}


def natural_key(path: Path) -> list[tuple[int, object]]:
    return [
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", path.as_posix())
    ]


def discover_videos(input_path: Path) -> list[Path]:
    input_path = input_path.expanduser().resolve()
    if input_path.is_file():
        if input_path.suffix.casefold() not in VIDEO_EXTENSIONS:
            raise ValueError(f"Unsupported video extension: {input_path.suffix or '<none>'}")
        return [input_path]
    if not input_path.is_dir():
        raise FileNotFoundError(f"Video or series folder not found: {input_path}")

    videos = [
        path.resolve()
        for path in input_path.rglob("*")
        if path.is_file()
        and path.suffix.casefold() in VIDEO_EXTENSIONS
        and not any(part.startswith(".") for part in path.relative_to(input_path).parts)
    ]
    return sorted(videos, key=lambda path: natural_key(path.relative_to(input_path)))


def episode_key(fingerprint: str) -> str:
    digest = hashlib.sha256(f"{ANALYSIS_VERSION}\0{fingerprint}".encode("utf-8")).hexdigest()
    return digest[:32]


def series_key(fingerprints: list[str]) -> str:
    digest = hashlib.sha256()
    digest.update(ANALYSIS_VERSION.encode("utf-8"))
    digest.update(b"\0series\0")
    for fingerprint in fingerprints:
        digest.update(fingerprint.encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()[:32]


def memory_root() -> Path:
    return ensure_workspace_output(workspace_dir() / "video-memory" / "analysis", "Analysis memory")


def episode_analysis_path(key: str) -> Path:
    return memory_root() / "episodes" / key / "analysis.json"


def series_analysis_path(key: str) -> Path:
    return memory_root() / "series" / key / "analysis.json"


def read_record(path: Path) -> dict[str, Any] | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict):
        return None
    if record.get("memorySchemaVersion") != MEMORY_SCHEMA_VERSION:
        return None
    if record.get("analysisVersion") != ANALYSIS_VERSION:
        return None
    if not isinstance(record.get("analysis"), dict):
        return None
    return record


def identity_for(input_path: Path) -> dict[str, Any]:
    input_path = input_path.expanduser().resolve()
    videos = discover_videos(input_path)
    if not videos:
        raise ValueError(f"No supported video files found in series folder: {input_path}")

    episodes = []
    fingerprints = []
    for index, video in enumerate(videos, start=1):
        fingerprint = content_fingerprint(video)
        fingerprints.append(fingerprint)
        key = episode_key(fingerprint)
        analysis_path = episode_analysis_path(key)
        record = read_record(analysis_path)
        episodes.append(
            {
                "episodeIndex": index,
                "fileName": video.name,
                "source": str(video),
                "contentFingerprint": fingerprint,
                "episodeKey": key,
                "evidenceOutputDir": str(default_output_dir(fingerprint)),
                "analysisHit": record is not None,
                "analysisPath": str(analysis_path),
                "analysisRecord": record,
            }
        )

    key = series_key(fingerprints)
    path = series_analysis_path(key)
    series_record = read_record(path)
    return {
        "inputType": "series_folder" if input_path.is_dir() else "single_video",
        "source": str(input_path),
        "episodeCount": len(episodes),
        "seriesKey": key,
        "seriesAnalysisPath": str(path),
        "seriesAnalysisRecord": series_record,
        "episodes": episodes,
    }


def lookup(input_path: Path, include_analysis: bool) -> dict[str, Any]:
    identity = identity_for(input_path)
    series_record = identity.pop("seriesAnalysisRecord")
    episodes = identity["episodes"]
    for episode in episodes:
        record = episode.pop("analysisRecord")
        if include_analysis and record is not None:
            episode["analysis"] = record["analysis"]

    series_hit = series_record is not None
    all_episodes_hit = all(episode["analysisHit"] for episode in episodes)
    reused_indexes = [episode["episodeIndex"] for episode in episodes if episode["analysisHit"]]
    missed_indexes = [episode["episodeIndex"] for episode in episodes if not episode["analysisHit"]]
    if series_hit:
        recommendation = "reuse_series_analysis"
    elif all_episodes_hit:
        recommendation = "reuse_episode_analyses_and_merge"
    else:
        recommendation = "analyze_only_missed_episodes"
    identity.update(
        {
            "ok": True,
            "memorySchemaVersion": MEMORY_SCHEMA_VERSION,
            "analysisVersion": ANALYSIS_VERSION,
            "seriesAnalysisHit": series_hit,
            "allEpisodesAnalysisHit": all_episodes_hit,
            "reuseRecommendation": recommendation,
            "modelAnalysisRequired": not series_hit,
            "requiredEpisodeModelPassCount": (
                0 if series_hit else sum(1 for episode in episodes if not episode["analysisHit"])
            ),
            "requiredSeriesAggregationPassCount": 0 if series_hit else 1,
            "analysisArtifactPath": identity["seriesAnalysisPath"] if series_hit else None,
            "episodeAnalysisPaths": [episode["analysisPath"] for episode in episodes],
            "currentRunReusedEpisodeIndexes": (
                [episode["episodeIndex"] for episode in episodes] if series_hit else reused_indexes
            ),
            "currentRunAnalyzedEpisodeIndexes": [] if series_hit else missed_indexes,
        }
    )
    if include_analysis and series_record is not None:
        identity["seriesAnalysis"] = series_record["analysis"]
        identity["wholeSeriesAnalysis"] = series_record["analysis"]
    return identity


def parse_analysis(args: argparse.Namespace) -> dict[str, Any]:
    if args.analysis_json is not None:
        raw = args.analysis_json
    elif args.analysis_file is not None:
        raw = Path(args.analysis_file).expanduser().read_text(encoding="utf-8")
    else:
        raw = sys.stdin.read()
    try:
        analysis = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Analysis payload is not valid JSON: {exc}") from exc
    if not isinstance(analysis, dict):
        raise ValueError("Analysis payload must be one JSON object")
    return analysis


def write_record(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_episode_analysis(analysis: dict[str, Any], expected_episode_key: str) -> None:
    episode_index = analysis.get("episodeIndex")
    if not isinstance(episode_index, int) or isinstance(episode_index, bool) or episode_index < 1:
        raise ValueError("Episode analysis must contain episodeIndex >= 1")
    episode_key_value = analysis.get("episodeKey")
    if episode_key_value != expected_episode_key:
        raise ValueError("Episode analysis episodeKey does not match the video content fingerprint")
    if not isinstance(analysis.get("oneLineSummary"), str) or not analysis["oneLineSummary"].strip():
        raise ValueError("Episode analysis must contain non-empty oneLineSummary")
    for field in ("plotSignals", "audienceAndMarketSignals", "visualStyle", "referenceImageCandidates"):
        if not isinstance(analysis.get(field), dict):
            raise ValueError(f"Episode analysis must contain object field: {field}")
    continuity = analysis.get("narrativeContinuity")
    legacy_continuity = analysis.get("seriesContinuity")
    if not isinstance(continuity, dict) and not isinstance(legacy_continuity, dict):
        raise ValueError(
            "Episode analysis must contain object field: narrativeContinuity "
            "(legacy seriesContinuity is also accepted)"
        )
    if not isinstance(analysis.get("risksAndUncertainties"), list):
        raise ValueError("Episode analysis must contain risksAndUncertainties array")


def validate_series_analysis(analysis: dict[str, Any], expected_episode_count: int) -> None:
    if analysis.get("ok") is not True:
        raise ValueError("Incomplete or failed series analysis cannot be cached")
    if analysis.get("coverageScope") != "whole_series" or analysis.get("wholeSeriesEvidenceSufficient") is not True:
        raise ValueError("Series analysis must confirm sufficient whole-series evidence")
    if analysis.get("episodeCount") != expected_episode_count:
        raise ValueError("Series analysis episodeCount does not match discovered videos")
    episodes = analysis.get("episodeAnalyses")
    if not isinstance(episodes, list) or len(episodes) != expected_episode_count:
        raise ValueError("Series analysis must contain exactly one episodeAnalyses item per episode")
    indexes = [item.get("episodeIndex") if isinstance(item, dict) else None for item in episodes]
    if indexes != list(range(1, expected_episode_count + 1)):
        raise ValueError("Series episodeAnalyses must be unique and strictly ordered from 1..episodeCount")
    reused = analysis.get("reusedEpisodeIndexes")
    analyzed = analysis.get("analyzedEpisodeIndexes")
    if not isinstance(reused, list) or not isinstance(analyzed, list):
        raise ValueError("Series analysis must contain reusedEpisodeIndexes and analyzedEpisodeIndexes arrays")
    if set(reused) & set(analyzed) or set(reused) | set(analyzed) != set(indexes):
        raise ValueError("Reused and analyzed episode indexes must be disjoint and cover every episode")
    series_summary = analysis.get("seriesAnalysis")
    if not isinstance(series_summary, dict):
        raise ValueError("Series analysis must contain seriesAnalysis object")
    if not isinstance(series_summary.get("oneLineSeriesSummary"), str) or not series_summary[
        "oneLineSeriesSummary"
    ].strip():
        raise ValueError("Series analysis must contain non-empty oneLineSeriesSummary")
    if not isinstance(series_summary.get("seriesPremiseAndTheme"), str) or not series_summary[
        "seriesPremiseAndTheme"
    ].strip():
        raise ValueError("Series analysis must contain non-empty seriesPremiseAndTheme")
    coverage = series_summary.get("episodeAdEvidenceCoverage")
    if not isinstance(coverage, list) or len(coverage) < expected_episode_count:
        raise ValueError("Series analysis must include ad-relevance evidence for every episode")
    anchors = series_summary.get("seriesAdAnchors")
    if not isinstance(anchors, dict):
        raise ValueError("Series analysis must include seriesAdAnchors object")
    if not anchors.get("themeAndCoreConflict"):
        raise ValueError("Series ad anchors must include themeAndCoreConflict")
    if not anchors.get("characterAndRelationshipArcs"):
        raise ValueError("Series ad anchors must include characterAndRelationshipArcs")
    optional_anchor_fields = (
        "worldRulesAndRecurringActions",
        "visualMotifsAndIconicAssets",
        "crossEpisodeEmotionalPayoffs",
        "viewerMotivations",
    )
    if not any(anchors.get(field) for field in optional_anchor_fields):
        raise ValueError("Series ad anchors must include at least one additional cross-episode evidence category")
    if analysis.get("failedEpisodes"):
        raise ValueError("Series analysis with failedEpisodes cannot be cached")


def validate_persisted_episode_analyses(identity: dict[str, Any], analysis: dict[str, Any]) -> list[str]:
    persisted_paths = []
    for expected, episode_analysis in zip(identity["episodes"], analysis["episodeAnalyses"], strict=True):
        if episode_analysis.get("episodeKey") != expected["episodeKey"]:
            raise ValueError(
                f"Episode {expected['episodeIndex']} analysis episodeKey does not match the ordered series content"
            )
        path = Path(expected["analysisPath"])
        record = read_record(path)
        if record is None:
            raise ValueError(
                f"Episode {expected['episodeIndex']} full model summary must be stored before the series summary"
            )
        if record["analysis"] != episode_analysis:
            raise ValueError(
                f"Episode {expected['episodeIndex']} cached model summary differs from series episodeAnalyses"
            )
        persisted_paths.append(str(path))
    return persisted_paths


def store_episode(video_path: Path, analysis: dict[str, Any]) -> dict[str, Any]:
    identity = identity_for(video_path)
    episode = identity["episodes"][0]
    validate_episode_analysis(analysis, episode["episodeKey"])
    path = Path(episode["analysisPath"])
    record = {
        "memorySchemaVersion": MEMORY_SCHEMA_VERSION,
        "analysisVersion": ANALYSIS_VERSION,
        "kind": "episode",
        "episodeKey": episode["episodeKey"],
        "contentFingerprint": episode["contentFingerprint"],
        "sourceAtStoreTime": episode["source"],
        "storedAt": datetime.now(timezone.utc).isoformat(),
        "analysis": analysis,
    }
    write_record(path, record)
    return {"ok": True, "stored": "episode", "episodeKey": episode["episodeKey"], "analysisPath": str(path)}


def store_series(input_path: Path, analysis: dict[str, Any]) -> dict[str, Any]:
    identity = identity_for(input_path)
    validate_series_analysis(analysis, identity["episodeCount"])
    if analysis.get("seriesKey") != identity["seriesKey"]:
        raise ValueError("Series analysis seriesKey does not match the ordered whole-series content")
    episode_analysis_paths = validate_persisted_episode_analyses(identity, analysis)
    path = Path(identity["seriesAnalysisPath"])
    record = {
        "memorySchemaVersion": MEMORY_SCHEMA_VERSION,
        "analysisVersion": ANALYSIS_VERSION,
        "kind": "series",
        "seriesKey": identity["seriesKey"],
        "episodeKeys": [episode["episodeKey"] for episode in identity["episodes"]],
        "inputType": identity["inputType"],
        "sourceAtStoreTime": str(input_path),
        "storedAt": datetime.now(timezone.utc).isoformat(),
        "completeEpisodeAnalysesPersisted": True,
        "episodeAnalysisPaths": episode_analysis_paths,
        "finalSeriesSummaryPersisted": True,
        "analysis": analysis,
    }
    write_record(path, record)
    stored_record = read_record(path)
    cache_ready = stored_record is not None and stored_record["analysis"] == analysis
    if not cache_ready:
        raise ValueError("Whole-series analysis artifact could not be read back after storage")
    return {
        "ok": True,
        "stored": "series",
        "seriesKey": identity["seriesKey"],
        "episodeCount": identity["episodeCount"],
        "analysisPath": str(path),
        "analysisArtifactPath": str(path),
        "episodeAnalysisPaths": episode_analysis_paths,
        "completeEpisodeAnalysesPersisted": True,
        "finalSeriesSummaryPersisted": True,
        "cacheReadyForExactReuse": cache_ready,
        "nextLookupModelAnalysisRequired": False,
    }


def add_analysis_input(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--analysis-json", help="Analysis JSON object passed directly")
    group.add_argument("--analysis-file", help="UTF-8 JSON file containing one object")
    group.add_argument("--analysis-stdin", action="store_true", help="Read one JSON object from stdin")


def main() -> int:
    parser = argparse.ArgumentParser(description="Lookup or store content-addressed Novvy video analysis memory.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    lookup_parser = subparsers.add_parser("lookup", help="Find reusable episode and series analyses")
    lookup_parser.add_argument("input", help="One video file or a series folder")
    lookup_parser.add_argument("--include-analysis", action="store_true", help="Include cached JSON analyses in output")

    episode_parser = subparsers.add_parser("store-episode", help="Store one episode analysis")
    episode_parser.add_argument("video", help="One video file")
    add_analysis_input(episode_parser)

    series_parser = subparsers.add_parser("store-series", help="Store one complete whole-series analysis artifact")
    series_parser.add_argument("input", help="Whole-series compilation video or series folder")
    add_analysis_input(series_parser)

    args = parser.parse_args()
    try:
        if args.command == "lookup":
            result = lookup(Path(args.input).expanduser().resolve(), args.include_analysis)
        elif args.command == "store-episode":
            result = store_episode(Path(args.video).expanduser().resolve(), parse_analysis(args))
        else:
            result = store_series(Path(args.input).expanduser().resolve(), parse_analysis(args))
    except (OSError, ValueError, FileNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
