"""Detect painting orientation from framed catalog hero shots."""

from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np

DARK_THRESHOLD = 70
SQUARE_MIN_RATIO = 0.9
SQUARE_MAX_RATIO = 1.1


def luminance(r: float, g: float, b: float) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def detect_frame_bbox(rgb: np.ndarray) -> Tuple[Optional[dict], str]:
    h, w = rgb.shape[:2]
    min_x, min_y, max_x, max_y = w, h, -1, -1
    dark_count = 0

    for y in range(h):
        for x in range(w):
            r, g, b = rgb[y, x]
            if luminance(float(r), float(g), float(b)) < DARK_THRESHOLD:
                dark_count += 1
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if dark_count == 0 or max_x < min_x or max_y < min_y:
        pad = max(2, int(min(h, w) * 0.02))
        box_w = w - 2 * pad
        box_h = h - 2 * pad
        if box_w <= 0 or box_h <= 0:
            return None, "none"
        return {
            "minX": pad,
            "minY": pad,
            "maxX": w - pad - 1,
            "maxY": h - pad - 1,
            "width": box_w,
            "height": box_h,
        }, "inset-fallback"

    pad = 2
    min_x = max(0, min_x - pad)
    min_y = max(0, min_y - pad)
    max_x = min(w - 1, max_x + pad)
    max_y = min(h - 1, max_y + pad)
    box_w = max_x - min_x + 1
    box_h = max_y - min_y + 1
    return {
        "minX": min_x,
        "minY": min_y,
        "maxX": max_x,
        "maxY": max_y,
        "width": box_w,
        "height": box_h,
    }, "black-frame"


def orientation_from_aspect_ratio(aspect_ratio: float) -> str:
    if SQUARE_MIN_RATIO <= aspect_ratio <= SQUARE_MAX_RATIO:
        return "square"
    if aspect_ratio > SQUARE_MAX_RATIO:
        return "landscape"
    return "portrait"


def detect_painting_orientation(image_path: str) -> dict:
    image = cv2.imread(image_path)
    if image is None:
        return {
            "orientation": None,
            "aspectRatio": None,
            "method": "none",
            "error": f"Could not read image: {image_path}",
        }

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    box, method = detect_frame_bbox(rgb)
    if not box:
        return {
            "orientation": None,
            "aspectRatio": None,
            "method": method,
            "error": "Could not detect painting frame.",
        }

    aspect_ratio = box["width"] / box["height"]
    orientation = orientation_from_aspect_ratio(aspect_ratio)
    return {
        "orientation": orientation,
        "aspectRatio": round(aspect_ratio, 4),
        "method": method,
        "error": None,
    }
