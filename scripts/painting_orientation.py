"""Detect painting orientation from the painting file's own shape."""

from __future__ import annotations

import cv2

SQUARE_MIN_RATIO = 0.9
SQUARE_MAX_RATIO = 1.1


def orientation_from_aspect_ratio(aspect_ratio: float) -> str:
    if SQUARE_MIN_RATIO <= aspect_ratio <= SQUARE_MAX_RATIO:
        return "square"
    if aspect_ratio > SQUARE_MAX_RATIO:
        return "landscape"
    return "portrait"


def detect_painting_orientation(image_path: str) -> dict:
    # The whole file is the artwork, light margins included, so its size is the painting's shape.
    image = cv2.imread(image_path)
    if image is None:
        return {
            "orientation": None,
            "aspectRatio": None,
            "method": "none",
            "error": f"Could not read image: {image_path}",
        }

    height, width = image.shape[:2]
    aspect_ratio = width / height
    return {
        "orientation": orientation_from_aspect_ratio(aspect_ratio),
        "aspectRatio": round(aspect_ratio, 4),
        "method": "image",
        "error": None,
    }
