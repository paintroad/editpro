#!/usr/bin/env python3
"""Calibrate placeholder detection and generate sample composites per orientation."""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2

from lifestyle_compositor import (
    CANVAS_SIZE,
    PLACEHOLDER_MIN_AREA_RATIO,
    _color_match_mask,
    _ensure_canvas,
    _filled_placeholder_mask,
    _inset_filled_mask,
    _mask_from_quad,
    _morph_placeholder_mask,
    _quad_placeholder_iou,
    _resolve_green_mat_mode,
    PLACEHOLDER_GREEN_RGB,
    _PLACEHOLDER_GREEN_LAB,
    PLACEHOLDER_RGB_TOLERANCE,
    PLACEHOLDER_LAB_TOLERANCE,
    composite_painting_into_frame,
    detect_placeholder_mask,
    detect_placeholder_quad,
    draw_quad_overlay,
)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def is_image_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS


def collect_frames(root: str) -> list[str]:
    paths: list[str] = []
    skip_dirs = {
        "_placeholder-debug",
        "_calibration-debug",
        "_calibration-debug-v2",
        "_calibration-debug-v3",
        "_placeholder-debug-baseline",
    }
    skip_prefixes = ("_calibration-debug", "_placeholder-debug")
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d
            for d in dirnames
            if not d.startswith(".")
            and d not in skip_dirs
            and not any(d.startswith(p) for p in skip_prefixes)
        ]
        for filename in sorted(filenames, key=lambda v: v.lower()):
            if filename.startswith(".") or filename.startswith("._") or not is_image_file(filename):
                continue
            paths.append(os.path.join(dirpath, filename))
    return paths


def analyze_frame(frame_path: str, output_dir: str) -> dict:
    frame_bgr = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if frame_bgr is None:
        return {"frame": frame_path, "ok": False, "error": "Could not read image."}

    mask = detect_placeholder_mask(frame_bgr, CANVAS_SIZE)
    frame_resized = _ensure_canvas(frame_bgr, CANVAS_SIZE)
    green_mask = _morph_placeholder_mask(
        _color_match_mask(
            frame_resized,
            PLACEHOLDER_GREEN_RGB,
            _PLACEHOLDER_GREEN_LAB,
            PLACEHOLDER_RGB_TOLERANCE,
            PLACEHOLDER_LAB_TOLERANCE,
        )
    )
    use_green_mat = _resolve_green_mat_mode(frame_resized, green_mask, CANVAS_SIZE)
    solid = _filled_placeholder_mask(mask, CANVAS_SIZE, use_green_mat=use_green_mat)
    quad = detect_placeholder_quad(
        frame_bgr, CANVAS_SIZE, placeholder_mask=mask, use_green_mat=use_green_mat
    )
    mask_area = int(cv2.countNonZero(mask))
    solid_area = int(cv2.countNonZero(solid))
    quad_mask = _mask_from_quad(quad, CANVAS_SIZE)
    overlap = cv2.bitwise_and(solid, quad_mask)
    if cv2.countNonZero(overlap) < cv2.countNonZero(quad_mask) * 0.5:
        region_mask = _inset_filled_mask(quad_mask)
    else:
        region_mask = cv2.bitwise_and(solid, quad_mask)
    quad_iou = float(_quad_placeholder_iou(quad, region_mask, CANVAS_SIZE))
    min_area = int(CANVAS_SIZE * CANVAS_SIZE * PLACEHOLDER_MIN_AREA_RATIO)
    ok = mask_area >= min_area and quad_iou >= 0.75

    rel = os.path.relpath(frame_path, os.path.dirname(frame_path))
    folder = os.path.basename(os.path.dirname(frame_path))
    stem = os.path.splitext(os.path.basename(frame_path))[0].replace(" ", "_")
    base = f"{folder}_{stem}"
    os.makedirs(output_dir, exist_ok=True)
    resized = cv2.resize(frame_bgr, (CANVAS_SIZE, CANVAS_SIZE), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(output_dir, f"{base}_quad.jpg"), draw_quad_overlay(resized, quad))
    cv2.imwrite(os.path.join(output_dir, f"{base}_mask.jpg"), mask)
    cv2.imwrite(os.path.join(output_dir, f"{base}_solid.jpg"), solid)

    return {
        "frame": frame_path,
        "folder": folder,
        "ok": ok,
        "maskArea": mask_area,
        "solidArea": solid_area,
        "quadIou": round(quad_iou, 4),
        "minArea": min_area,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibrate green frame placeholder detection")
    parser.add_argument("frames_path", help="Green frame references root")
    parser.add_argument("--output", required=True, help="Debug output folder")
    parser.add_argument(
        "--composite-output",
        default="",
        help="Folder for sample portrait/landscape/square composites",
    )
    parser.add_argument("--portrait-painting", default="")
    parser.add_argument("--landscape-painting", default="")
    parser.add_argument("--square-painting", default="")
    parser.add_argument("--all-composites", action="store_true", help="Render every frame for each orientation sample")
    args = parser.parse_args()

    frames_path = os.path.abspath(args.frames_path)
    output_dir = os.path.abspath(args.output)
    results = [analyze_frame(path, output_dir) for path in collect_frames(frames_path)]

    passed = sum(1 for item in results if item.get("ok"))
    failed = len(results) - passed
    print(f"Analyzed {len(results)} frames — passed: {passed}, failed: {failed}")
    for item in results:
        status = "OK" if item.get("ok") else "FAIL"
        print(
            f"  [{status}] {item.get('folder')}/{os.path.basename(item['frame'])} "
            f"mask={item.get('maskArea')} solid={item.get('solidArea')} iou={item.get('quadIou')}"
        )

    summary_path = os.path.join(output_dir, "summary.json")
    with open(summary_path, "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=2)
    print(f"Summary: {summary_path}")

    samples = {
        "Portrait": args.portrait_painting,
        "Landscape": args.landscape_painting,
        "Square": args.square_painting,
    }
    if args.composite_output:
        comp_dir = os.path.abspath(args.composite_output)
        os.makedirs(comp_dir, exist_ok=True)
        for orientation, painting in samples.items():
            if not painting or not os.path.isfile(painting):
                print(f"Skip composite {orientation}: painting not found")
                continue
            frame_dir = os.path.join(frames_path, orientation)
            null_frame = os.path.join(frame_dir, "1. Null.jpg")
            if not os.path.isfile(null_frame):
                frames = [
                    os.path.join(frame_dir, name)
                    for name in os.listdir(frame_dir)
                    if is_image_file(name)
                ]
                null_frame = sorted(frames)[0] if frames else ""
            if not null_frame:
                continue
            out_path = os.path.join(comp_dir, f"sample_{orientation.lower()}.jpg")
            composite_painting_into_frame(painting, null_frame, out_path)
            print(f"Composite {orientation}: {out_path}")

            if args.all_composites:
                all_dir = os.path.join(comp_dir, f"all_{orientation.lower()}")
                os.makedirs(all_dir, exist_ok=True)
                for frame_path in sorted(
                    os.path.join(frame_dir, name)
                    for name in os.listdir(frame_dir)
                    if is_image_file(name) and not name.startswith("._")
                ):
                    stem = os.path.splitext(os.path.basename(frame_path))[0].replace(" ", "_")
                    composite_painting_into_frame(
                        painting,
                        frame_path,
                        os.path.join(all_dir, f"{stem}.jpg"),
                    )
                print(f"All-frame composites {orientation}: {all_dir}")

    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
