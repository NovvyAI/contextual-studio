#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 VIDEO OUTPUT_DIR" >&2
  exit 2
fi

video_path=$1
output_dir=$2

if [[ ! -f "$video_path" ]]; then
  echo "Video not found: $video_path" >&2
  exit 1
fi

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe is required" >&2; exit 1; }

mkdir -p "$output_dir/frames"

ffprobe -v error \
  -show_entries format=duration:stream=index,codec_type,codec_name,width,height \
  -of default=noprint_wrappers=1 \
  "$video_path" > "$output_dir/media-info.txt"

ffmpeg -hide_banner -loglevel error -i "$video_path" \
  -vf "fps=1/8,scale=270:-1,tile=4x4" -frames:v 1 \
  "$output_dir/overview.jpg"

ffmpeg -hide_banner -loglevel error -i "$video_path" \
  -vf "fps=1/4,scale=270:-1,tile=5x5" -frames:v 1 \
  "$output_dir/dense.jpg"

ffmpeg -hide_banner -loglevel error -i "$video_path" \
  -vf "fps=1/4,scale=360:-1" \
  "$output_dir/frames/frame_%03d.jpg"

echo "Created analysis frames in $output_dir"
