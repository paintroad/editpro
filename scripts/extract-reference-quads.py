#!/usr/bin/env python3
"""Extract normalized painting quads from green-annotated reference frames."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import cv2
import numpy as np

from lifestyle_compositor import (
    PLACEHOLDER_GREEN_RGB,
    PLACEHOLDER_LAB_TOLERANCE,
    PLACEHOLDER_RGB_TOLERANCE,
    _PLACEHOLDER_GREEN_LAB,
    _color_match_mask,
    _morph_placeholder_mask,
    draw_quad_overlay,
    order_points,
)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ORIENTATION_FOLDERS = {"portrait": "Portrait", "landscape": "Landscape", "square": "Square"}
DEFAULT_OUTPUT = os.path.join(os.path.dirname(__file__), "frame-quads.json")


def is_image_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS


def detect_orientation_dirs(root: str) -> list[tuple[str, str]]:
    """Return (orientation_label, dir_path) pairs."""
    entries = [
        entry.name
        for entry in os.scandir(root)
        if entry.is_dir() and not entry.name.startswith(".")
    ]
    matched = []
    for entry_name in entries:
        key = entry_name.lower()
        if key in ORIENTATION_FOLDERS:
            matched.append((ORIENTATION_FOLDERS[key], os.path.join(root, entry_name)))
    if matched:
        return sorted(matched, key=lambda item: item[0])

    images = [name for name in os.listdir(root) if is_image_file(name) and not name.startswith(".")]
    if images:
        return [("Landscape", root)]
    return []


def _hull_quad_corners(points: np.ndarray) -> Optional[np.ndarray]:
    """True 4-corner quad (supports perspective) via convex hull + approxPolyDP."""
    hull = cv2.convexHull(points)
    peri = cv2.arcLength(hull, True)
    for epsilon_ratio in (0.01, 0.02, 0.03, 0.05, 0.08, 0.12):
        approx = cv2.approxPolyDP(hull, epsilon_ratio * peri, True)
        if len(approx) == 4:
            return order_points(approx.reshape(4, 2).astype(np.float32))
    return None


def extract_green_quad(image_bgr: np.ndarray) -> tuple[np.ndarray, dict]:
    h, w = image_bgr.shape[:2]
    green_raw = _color_match_mask(
        image_bgr,
        PLACEHOLDER_GREEN_RGB,
        _PLACEHOLDER_GREEN_LAB,
        PLACEHOLDER_RGB_TOLERANCE,
        PLACEHOLDER_LAB_TOLERANCE,
    )
    # Thin 2px line: only bridge tiny gaps with a small close; never open (that erased it).
    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    green_mask = cv2.morphologyEx(green_raw, cv2.MORPH_CLOSE, close_kernel, iterations=1)

    points = cv2.findNonZero(green_mask)
    mask_count = int(cv2.countNonZero(green_mask))
    if points is None or mask_count < h * w * 0.0005:
        raise ValueError("No green annotation found.")

    hull_quad = _hull_quad_corners(points)
    rect = cv2.minAreaRect(points)
    min_area_quad = order_points(cv2.boxPoints(rect).astype(np.float32))
    quad = hull_quad if hull_quad is not None else min_area_quad
    area = float(cv2.contourArea(quad.reshape(-1, 1, 2).astype(np.float32)))
    if area < h * w * 0.005:
        raise ValueError(f"Green annotation too small ({int(area)} px).")

    # Normalize to [0, 1] using source image dimensions.
    normalized = quad.copy()
    normalized[:, 0] /= float(w)
    normalized[:, 1] /= float(h)

    meta = {
        "width": w,
        "height": h,
        "areaPx": int(area),
        "aspect": round(float(max(rect[1]) / max(min(rect[1]), 1.0)), 4),
        "method": "hull" if hull_quad is not None else "minAreaRect",
    }
    return normalized, meta


def collect_reference_images(orientation_dirs: list[tuple[str, str]]) -> list[tuple[str, str, str]]:
    items: list[tuple[str, str, str]] = []
    for orientation, dir_path in orientation_dirs:
        for filename in sorted(os.listdir(dir_path), key=lambda value: value.lower()):
            if not is_image_file(filename) or filename.startswith("."):
                continue
            items.append((orientation, filename, os.path.join(dir_path, filename)))
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract painting quads from green reference frames")
    parser.add_argument("references_path", help="Green reference root (or orientation subfolders)")
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--debug-dir",
        default="",
        help="Optional folder for quad overlay previews",
    )
    args = parser.parse_args()

    root = os.path.abspath(args.references_path)
    if not os.path.isdir(root):
        print(f"References path not found: {root}", file=sys.stderr)
        return 1

    orientation_dirs = detect_orientation_dirs(root)
    if not orientation_dirs:
        print(f"No reference images found under {root}", file=sys.stderr)
        return 1

    payload: dict = {
        "version": 1,
        "sourceRoot": root,
        "quads": {},
    }
    errors = []
    debug_dir = os.path.abspath(args.debug_dir) if args.debug_dir else ""
    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)

    for orientation, filename, image_path in collect_reference_images(orientation_dirs):
        image_bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
        if image_bgr is None:
            errors.append({"orientation": orientation, "frameTemplate": filename, "error": "Could not read image."})
            continue
        try:
            normalized, meta = extract_green_quad(image_bgr)
        except ValueError as exc:
            errors.append({"orientation": orientation, "frameTemplate": filename, "error": str(exc)})
            continue

        payload["quads"].setdefault(orientation, {})[filename] = {
            "points": [[round(float(x), 6), round(float(y), 6)] for x, y in normalized],
            "meta": meta,
        }

        if debug_dir:
            h, w = image_bgr.shape[:2]
            quad_px = normalized.copy()
            quad_px[:, 0] *= w
            quad_px[:, 1] *= h
            stem = os.path.splitext(filename)[0].replace(" ", "_")
            overlay = draw_quad_overlay(image_bgr, quad_px)
            cv2.imwrite(os.path.join(debug_dir, f"{orientation}_{stem}_extracted_quad.jpg"), overlay)

        print(f"OK {orientation}/{filename} area={meta['areaPx']} aspect={meta['aspect']}")

    output_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    total = sum(len(items) for items in payload["quads"].values())
    print(f"Wrote {total} quads to {output_path}")
    if errors:
        print(f"Errors: {len(errors)}", file=sys.stderr)
        for item in errors:
            print(f"  {item['orientation']}/{item['frameTemplate']}: {item['error']}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
