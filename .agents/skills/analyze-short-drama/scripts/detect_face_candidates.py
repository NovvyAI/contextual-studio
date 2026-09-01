#!/usr/bin/env python3
"""Scan a video locally and retain high-quality, multi-angle face observations.

This deliberately does not identify people. Identity grouping and narrative-role
labelling happen later from a compact contact sheet, while raw video frames stay
on the user's machine.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("output_dir")
    parser.add_argument("--model", required=True)
    parser.add_argument("--sample-fps", type=float, default=2.5)
    parser.add_argument("--max-candidates", type=int, default=80)
    parser.add_argument("--min-face-pixels", type=int, default=72)
    return parser.parse_args()


def head_pose(face: np.ndarray) -> tuple[str, float]:
    # YuNet provides five facial landmarks. Nose displacement relative to the
    # eye midpoint is a stable, lightweight yaw proxy; it is not biometric ID.
    face_width = max(1.0, float(face[2]))
    eye_mid_x = (float(face[4]) + float(face[6])) / 2.0
    normalized = (float(face[8]) - eye_mid_x) / face_width
    yaw = max(-75.0, min(75.0, normalized * 300.0))
    magnitude = abs(yaw)
    if magnitude < 13:
        return "front", yaw
    if magnitude < 36:
        return ("three_quarter_left" if yaw < 0 else "three_quarter_right"), yaw
    return ("left_profile" if yaw < 0 else "right_profile"), yaw


def quality_score(crop: np.ndarray, face_width: int, frame_width: int) -> tuple[float, float, float]:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    size_score = min(1.0, face_width / max(1.0, frame_width * 0.28))
    sharp_score = min(1.0, sharpness / 420.0)
    light_score = max(0.0, 1.0 - abs(brightness - 130.0) / 130.0)
    return round(0.45 * sharp_score + 0.35 * size_score + 0.20 * light_score, 4), sharpness, brightness


def make_sheet(items: list[dict], destination: Path) -> None:
    if not items:
        return
    tile_w, tile_h, columns = 240, 210, 5
    rows = math.ceil(len(items) / columns)
    sheet = np.full((rows * tile_h, columns * tile_w, 3), 22, dtype=np.uint8)
    for index, item in enumerate(items):
        image = cv2.imread(item.get("faceCropPath") or item["cropPath"])
        if image is None:
            continue
        scale = min(tile_w / image.shape[1], (tile_h - 32) / image.shape[0])
        resized = cv2.resize(image, (max(1, int(image.shape[1] * scale)), max(1, int(image.shape[0] * scale))))
        x0 = (index % columns) * tile_w + (tile_w - resized.shape[1]) // 2
        y0 = (index // columns) * tile_h
        sheet[y0:y0 + resized.shape[0], x0:x0 + resized.shape[1]] = resized
        label = f"{item['candidateId']} | {item['timestampSeconds']:.2f}s | {item['view']}"
        cv2.putText(sheet, label, ((index % columns) * tile_w + 7, y0 + tile_h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (210, 235, 130), 1, cv2.LINE_AA)
    cv2.imwrite(str(destination), sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])


def main() -> int:
    args = parse_args()
    video = Path(args.video).resolve()
    model = Path(args.model).resolve()
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not video.is_file() or not model.is_file():
        raise SystemExit("video or YuNet model does not exist")

    capture = cv2.VideoCapture(str(video))
    native_fps = float(capture.get(cv2.CAP_PROP_FPS) or 25.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / native_fps if frame_count else 0.0
    interval = max(1, round(native_fps / max(0.25, args.sample_fps)))

    detector = cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.85, 0.3, 5000)
    observations: list[dict] = []
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % interval:
            frame_index += 1
            continue
        timestamp = frame_index / native_fps
        height, width = frame.shape[:2]
        detector.setInputSize((width, height))
        _, faces = detector.detect(frame)
        for face in ([] if faces is None else faces):
            x1, y1, face_w, face_h = [int(value) for value in face[:4]]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(width, x1 + face_w), min(height, y1 + face_h)
            face_w, face_h = x2 - x1, y2 - y1
            if min(face_w, face_h) < args.min_face_pixels:
                continue
            margin_x, margin_y = int(face_w * 0.35), int(face_h * 0.35)
            ax1, ax2 = max(0, x1 - margin_x), min(width, x2 + margin_x)
            ay1, ay2 = max(0, y1 - margin_y), min(height, y2 + margin_y)
            face_crop = frame[ay1:ay2, ax1:ax2]
            # Preserve a larger source-frame portrait for costume, hair,
            # accessories, posture and visible body context.
            portrait_x1 = max(0, int(x1 - face_w * 1.05))
            portrait_x2 = min(width, int(x2 + face_w * 1.05))
            portrait_y1 = max(0, int(y1 - face_h * 0.55))
            portrait_y2 = min(height, int(y2 + face_h * 3.25))
            portrait_crop = frame[portrait_y1:portrait_y2, portrait_x1:portrait_x2]
            visual_score, sharpness, brightness = quality_score(face_crop, face_w, width)
            detection_confidence = float(face[-1])
            score = round(0.8 * visual_score + 0.2 * detection_confidence, 4)
            if score < 0.50:
                continue
            view, yaw = head_pose(face)
            observations.append({
                "timestampSeconds": round(timestamp, 3), "view": view, "yawDegrees": round(yaw, 2),
                "qualityScore": score, "sharpness": round(sharpness, 2), "brightness": round(brightness, 2),
                "detectionConfidence": round(detection_confidence, 4),
                "bbox": [x1, y1, face_w, face_h], "portraitBbox": [portrait_x1, portrait_y1, portrait_x2 - portrait_x1, portrait_y2 - portrait_y1],
                "faceCrop": face_crop, "crop": portrait_crop,
            })
        frame_index += 1
    capture.release()

    # Avoid returning dozens of near-identical adjacent observations. Keep the
    # best face for each angle in every 0.8-second temporal bucket.
    buckets: dict[tuple[int, str], dict] = {}
    for item in observations:
        key = (int(item["timestampSeconds"] / 0.8), item["view"])
        if key not in buckets or item["qualityScore"] > buckets[key]["qualityScore"]:
            buckets[key] = item
    selected = sorted(buckets.values(), key=lambda item: item["qualityScore"], reverse=True)[: args.max_candidates]
    selected.sort(key=lambda item: item["timestampSeconds"])
    serializable = []
    for index, item in enumerate(selected, 1):
        candidate_id = f"face-{index:03d}"
        crop_path = output / f"{candidate_id}.jpg"
        face_crop_path = output / f"{candidate_id}-face.jpg"
        cv2.imwrite(str(crop_path), item.pop("crop"), [cv2.IMWRITE_JPEG_QUALITY, 94])
        cv2.imwrite(str(face_crop_path), item.pop("faceCrop"), [cv2.IMWRITE_JPEG_QUALITY, 94])
        item.update({"candidateId": candidate_id, "cropPath": str(crop_path), "faceCropPath": str(face_crop_path)})
        serializable.append(item)
    sheet_path = output / "face-candidates.jpg"
    make_sheet(serializable, sheet_path)
    print(json.dumps({
        "version": "local-face-candidates.v1", "engine": "opencv-yunet",
        "sampleFps": args.sample_fps, "durationSeconds": duration,
        "candidateCount": len(serializable), "contactSheet": str(sheet_path) if serializable else "",
        "candidates": serializable,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
