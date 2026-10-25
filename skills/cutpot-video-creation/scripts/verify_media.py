#!/usr/bin/env python3
"""Offline production-manifest and media checks; never submits generation tasks."""
import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys


def inspect(manifest_path, decode=False):
    manifest_path = Path(manifest_path).resolve()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    fps = Fraction(str(data.get("fps", 25)))
    if fps <= 0:
        raise ValueError("fps must be positive")
    # Historical production manifests contain stale resolution metadata.
    # Explicit CLI override is applied by main before inspect_media below.
    rows, errors, seen, cursor, total_frames = [], [], set(), 0.0, 0
    shots = data.get("shots", [])
    if not shots:
        errors.append("manifest has no shots")
    for shot in shots:
        sid = shot["id"]
        if sid in seen:
            errors.append(f"duplicate shot id: {sid}")
        seen.add(sid)
        start, end = float(shot["start"]), float(shot["end"])
        duration = float(shot["edit_seconds"])
        if not all(math.isfinite(v) for v in (start, end, duration)):
            raise ValueError(f"{sid}: non-finite time")
        frame_value = Fraction(str(shot["edit_seconds"])) * fps
        frames = round(frame_value)
        local = []
        if abs(start - cursor) > 1e-6:
            local.append(f"timeline gap/overlap: expected start {cursor}, got {start}")
        if duration <= 0 or abs(end - start - duration) > 1e-6:
            local.append("invalid duration or end-start mismatch")
        if frame_value.denominator != 1:
            local.append("duration is not aligned to target frame clock")
        for label, val in (("start", start), ("end", end)):
            if abs(val * float(fps) - round(val * float(fps))) > 1e-6:
                local.append(f"{label} is not aligned to target frame clock")
        if "duration_frames" in shot and shot["duration_frames"] != frames:
            local.append("duration_frames mismatch")
        cursor, total_frames = end, total_frames + frames
        output = shot.get("output")
        path = Path(output) if output else None
        if path is not None and not path.is_absolute():
            path = manifest_path.parent / path
        if path is None or not path.is_file():
            local.append("missing output file")
        row = {"id": sid, "file": str(path) if path else None,
               "expected_frames": frames, "expected_seconds": duration,
               "errors": local, "require_audio": shot.get("require_audio", data.get("require_audio", True))}
        rows.append(row)
    expected = float(data.get("total_seconds", sum(float(s["edit_seconds"]) for s in shots)))
    if abs(cursor - expected) > 1e-6 or abs(total_frames / float(fps) - expected) > 1e-6:
        errors.append("timeline total does not match total_seconds")
    return data, fps, {"manifest": str(manifest_path), "total_frames": total_frames,
                       "total_seconds": expected, "errors": errors, "shots": rows}


def inspect_media(report, fps, width, height, decode):
    if not shutil.which("ffprobe"):
        report["errors"].append("ffprobe not found")
        return
    if decode and not shutil.which("ffmpeg"):
        report["errors"].append("ffmpeg not found for --decode")
        return
    for row in report["shots"]:
        if row["file"] is None or not Path(row["file"]).is_file():
            continue
        try:
            cmd = ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", row["file"]]
            info = json.loads(subprocess.check_output(cmd, text=True, stderr=subprocess.PIPE, timeout=60))
            video = next(s for s in info["streams"] if s["codec_type"] == "video")
            audio = [s for s in info["streams"] if s["codec_type"] == "audio"]
            if (video["width"], video["height"]) != (width, height):
                row["errors"].append("resolution mismatch")
            if Fraction(video.get("avg_frame_rate", "0/1")) != fps:
                row["errors"].append("average frame rate mismatch")
            if Fraction(video.get("r_frame_rate", "0/1")) != fps:
                row["errors"].append("nominal frame rate mismatch")
            frames = video.get("nb_frames")
            if frames in (None, "N/A"):
                counted = json.loads(subprocess.check_output(
                    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                     "-show_entries", "stream=nb_read_frames", "-of", "json", row["file"]],
                    text=True, stderr=subprocess.PIPE, timeout=300))
                frames = counted["streams"][0]["nb_read_frames"]
            if int(frames) != row["expected_frames"]:
                row["errors"].append("video frame count mismatch")
            seconds = float(video.get("duration", info["format"]["duration"]))
            if abs(seconds - row["expected_seconds"]) > 1 / float(fps):
                row["errors"].append("video duration mismatch")
            if row["require_audio"] and not audio:
                row["errors"].append("required audio track missing")
            row["actual"] = {"width": video["width"], "height": video["height"],
                             "fps": video.get("avg_frame_rate"), "frames": int(frames),
                             "seconds": seconds, "audio_tracks": len(audio)}
            if decode:
                subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", row["file"],
                                "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
                               check=True, capture_output=True, timeout=300)
                row["decoded"] = True
        except (subprocess.SubprocessError, ValueError, ZeroDivisionError, KeyError, StopIteration) as exc:
            row["errors"].append(f"media check failed: {type(exc).__name__}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--resolution", help="Override manifest target, e.g. 1280x720")
    parser.add_argument("--decode", action="store_true", help="Fully decode each existing output")
    parser.add_argument("--report", type=Path, help="Save report; refuses to overwrite")
    args = parser.parse_args()
    try:
        if args.report and args.report.exists():
            raise ValueError("report already exists; choose a new path")
        data, fps, report = inspect(args.manifest, args.decode)
        resolution = args.resolution or data.get("resolution", "1280x720")
        width, height = map(int, resolution.lower().split("x"))
        if min(width, height) <= 0:
            raise ValueError("resolution must be positive")
        inspect_media(report, fps, width, height, args.decode)
        report["checked_shots"] = len(report["shots"])
        report["passed_shots"] = sum(not r["errors"] for r in report["shots"])
        report["technical_passed"] = not report["errors"] and report["passed_shots"] == report["checked_shots"]
        report["scope"] = "Technical checks only; requires visual review and listening."
        output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.report:
            with args.report.open("x", encoding="utf-8") as handle:
                handle.write(output)
        print(output, end="")
        return 0 if report["technical_passed"] else 1
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
