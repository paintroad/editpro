#!/usr/bin/env python3
"""Visual QA for #D7DBD8 placeholder detection on frame templates."""

from __future__ import annotations

import argparse
import os
import sys

import cv2

from lifestyle_compositor import (
    CANVAS_SIZE,
    PLACEHOLDER_MIN_AREA_RATIO,
    detect_placeholder_mask,
    detect_placeholder_quad,
    draw_quad_overlay,
)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def is_image_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS


def collect_frame_paths(root: str) -> list[str]:
    paths: list[str] = []
    for dirpath, _, filenames in os.walk(root):
        for filename in sorted(filenames, key=lambda value: value.lower()):
            if filename.startswith(".") or not is_image_file(filename):
                continue
            paths.append(os.path.join(dirpath, filename))
    return paths


def process_frame(frame_path: str, output_dir: str, canvas_size: int) -> dict:
    frame_bgr = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if frame_bgr is None:
        return {"frame": frame_path, "ok": False, "error": "Could not read image."}

    quad = detect_placeholder_quad(frame_bgr, canvas_size)
    mask = detect_placeholder_mask(frame_bgr, canvas_size)
    mask_area = int(cv2.countNonZero(mask))
    min_area = int(canvas_size * canvas_size * PLACEHOLDER_MIN_AREA_RATIO)
    ok = mask_area >= min_area

    rel = os.path.relpath(frame_path, start=os.path.commonpath([frame_path, output_dir]) if output_dir else ".")
    base_name = os.path.splitext(rel.replace(os.sep, "_"))[0]
    out_overlay = os.path.join(output_dir, f"{base_name}_quad.jpg")
    out_mask = os.path.join(output_dir, f"{base_name}_mask.jpg")
    os.makedirs(os.path.dirname(out_overlay) or ".", exist_ok=True)

    overlay = draw_quad_overlay(
        cv2.resize(frame_bgr, (canvas_size, canvas_size), interpolation=cv2.INTER_AREA),
        quad,
    )
    cv2.imwrite(out_overlay, overlay)
    cv2.imwrite(out_mask, mask)

    return {
        "frame": frame_path,
        "ok": ok,
        "maskArea": mask_area,
        "minArea": min_area,
        "overlay": out_overlay,
        "mask": out_mask,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Draw placeholder detection overlays on frame templates")
    parser.add_argument("frames_path", help="Frame templates folder (or parent with Portrait/Landscape/Square)")
    parser.add_argument(
        "--output",
        default="",
        help="Output folder for overlays (default: <frames_path>/_placeholder-debug)",
    )
    parser.add_argument("--canvas-size", type=int, default=CANVAS_SIZE)
    args = parser.parse_args()

    frames_path = os.path.abspath(args.frames_path)
    if not os.path.isdir(frames_path):
        print(f"Not a directory: {frames_path}", file=sys.stderr)
        return 1

    output_dir = os.path.abspath(args.output) if args.output else os.path.join(frames_path, "_placeholder-debug")
    frame_paths = collect_frame_paths(frames_path)
    if not frame_paths:
        print(f"No images found under {frames_path}", file=sys.stderr)
        return 1

    results = []
    for frame_path in frame_paths:
        results.append(process_frame(frame_path, output_dir, args.canvas_size))

    passed = sum(1 for item in results if item.get("ok"))
    failed = len(results) - passed
    print(f"Processed {len(results)} frame(s). Passed: {passed}, Failed: {failed}")
    print(f"Output: {output_dir}")
    for item in results:
        status = "OK" if item.get("ok") else "FAIL"
        area = item.get("maskArea", 0)
        print(f"  [{status}] {item['frame']} (mask area: {area})")
        if not item.get("ok"):
            print(f"         {item.get('error', 'Mask area below minimum.')}")

    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
