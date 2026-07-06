"""Core lifestyle image compositing: painting into frame with multiply blend."""

from __future__ import annotations

import os
from typing import Optional, Tuple

import cv2
import numpy as np
from PIL import Image

CANVAS_SIZE = 1080
DARK_THRESHOLD = 70
PLACEHOLDER_RGB = np.array([215, 219, 216], dtype=np.uint8)  # #D7DBD8
PLACEHOLDER_RGB_TOLERANCE = 12
PLACEHOLDER_LAB_TOLERANCE = 18
PLACEHOLDER_MIN_AREA_RATIO = 0.04
PLACEHOLDER_MORPH_KERNEL = 11

_PLACEHOLDER_BGR = np.array([[[PLACEHOLDER_RGB[2], PLACEHOLDER_RGB[1], PLACEHOLDER_RGB[0]]]], dtype=np.uint8)
_PLACEHOLDER_LAB = cv2.cvtColor(_PLACEHOLDER_BGR, cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)


def luminance(r: float, g: float, b: float) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def fallback_rect(size: int) -> np.ndarray:
    margin = int(size * 0.18)
    return np.array(
        [
            [margin, margin],
            [size - margin - 1, margin],
            [size - margin - 1, size - margin - 1],
            [margin, size - margin - 1],
        ],
        dtype=np.float32,
    )


def detect_painting_content(painting_bgr: np.ndarray) -> np.ndarray:
    rgb = cv2.cvtColor(painting_bgr, cv2.COLOR_BGR2RGB)
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
        return painting_bgr[pad : h - pad, pad : w - pad]

    pad = 2
    min_x = max(0, min_x - pad)
    min_y = max(0, min_y - pad)
    max_x = min(w - 1, max_x + pad)
    max_y = min(h - 1, max_y + pad)
    return painting_bgr[min_y : max_y + 1, min_x : max_x + 1]


def _ensure_canvas(frame_bgr: np.ndarray, canvas_size: int) -> np.ndarray:
    h, w = frame_bgr.shape[:2]
    if h == canvas_size and w == canvas_size:
        return frame_bgr
    return cv2.resize(frame_bgr, (canvas_size, canvas_size), interpolation=cv2.INTER_AREA)


def detect_placeholder_mask(frame_bgr: np.ndarray, canvas_size: int = CANVAS_SIZE) -> np.ndarray:
    frame = _ensure_canvas(frame_bgr, canvas_size)
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    pr, pg, pb = (int(v) for v in PLACEHOLDER_RGB)
    tol = PLACEHOLDER_RGB_TOLERANCE
    rgb_mask = (
        (rgb[:, :, 0] >= pr - tol)
        & (rgb[:, :, 0] <= pr + tol)
        & (rgb[:, :, 1] >= pg - tol)
        & (rgb[:, :, 1] <= pg + tol)
        & (rgb[:, :, 2] >= pb - tol)
        & (rgb[:, :, 2] <= pb + tol)
    )

    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB).astype(np.float32)
    dist = np.sqrt(np.sum((lab - _PLACEHOLDER_LAB) ** 2, axis=2))
    lab_mask = dist <= PLACEHOLDER_LAB_TOLERANCE

    combined = (rgb_mask | lab_mask).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (PLACEHOLDER_MORPH_KERNEL, PLACEHOLDER_MORPH_KERNEL)
    )
    mask = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    return mask


def _quad_from_contour(contour: np.ndarray, canvas_size: int) -> np.ndarray:
    peri = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
    if len(approx) == 4:
        return order_points(approx.reshape(4, 2).astype(np.float32))
    rect = cv2.minAreaRect(contour)
    box = cv2.boxPoints(rect)
    return order_points(box.astype(np.float32))


def detect_placeholder_quad(frame_bgr: np.ndarray, canvas_size: int = CANVAS_SIZE) -> np.ndarray:
    frame = _ensure_canvas(frame_bgr, canvas_size)
    mask = detect_placeholder_mask(frame, canvas_size)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return detect_opening_quad(frame, canvas_size)

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    min_area = canvas_size * canvas_size * PLACEHOLDER_MIN_AREA_RATIO
    if area < min_area:
        return detect_opening_quad(frame, canvas_size)

    return _quad_from_contour(largest, canvas_size)


def draw_quad_overlay(frame_bgr: np.ndarray, quad: np.ndarray) -> np.ndarray:
    overlay = frame_bgr.copy()
    pts = quad.astype(np.int32).reshape(-1, 1, 2)
    cv2.polylines(overlay, [pts], isClosed=True, color=(0, 255, 0), thickness=3)
    for index, point in enumerate(quad.astype(np.int32)):
        cv2.circle(overlay, tuple(point), 6, (0, 0, 255), -1)
        cv2.putText(
            overlay,
            str(index),
            (int(point[0]) + 8, int(point[1]) - 8),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (0, 0, 255),
            2,
        )
    return overlay


def _write_compositor_debug(
    frame_resized: np.ndarray,
    quad: np.ndarray,
    output_path: str,
    canvas_size: int = CANVAS_SIZE,
) -> None:
    base, _ = os.path.splitext(output_path)
    mask = detect_placeholder_mask(frame_resized, canvas_size)
    cv2.imwrite(f"{base}_mask.jpg", mask)
    cv2.imwrite(f"{base}_quad.jpg", draw_quad_overlay(frame_resized, quad))


def detect_opening_quad(frame_bgr: np.ndarray, canvas_size: int = CANVAS_SIZE) -> np.ndarray:
    """Legacy bright-region detector; used as fallback when placeholder mask is too small."""
    frame = _ensure_canvas(frame_bgr, canvas_size)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (7, 7), 0)
    thresh_val = float(np.percentile(blur, 58))
    mask = (blur > thresh_val).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (13, 13))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return fallback_rect(canvas_size)

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    min_area = canvas_size * canvas_size * 0.12
    if area < min_area:
        return fallback_rect(canvas_size)

    return _quad_from_contour(largest, canvas_size)


def fit_painting_to_quad(painting_bgr: np.ndarray, quad: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    width_a = np.linalg.norm(quad[1] - quad[0])
    width_b = np.linalg.norm(quad[2] - quad[3])
    height_a = np.linalg.norm(quad[3] - quad[0])
    height_b = np.linalg.norm(quad[2] - quad[1])
    max_w = max(int(max(width_a, width_b)), 1)
    max_h = max(int(max(height_a, height_b)), 1)

    ph, pw = painting_bgr.shape[:2]
    scale = max(max_w / pw, max_h / ph)
    new_w = max(int(pw * scale), 1)
    new_h = max(int(ph * scale), 1)
    resized = cv2.resize(painting_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)

    x0 = max(0, (new_w - max_w) // 2)
    y0 = max(0, (new_h - max_h) // 2)
    cropped = resized[y0 : y0 + max_h, x0 : x0 + max_w]

    src = np.array(
        [[0, 0], [cropped.shape[1] - 1, 0], [cropped.shape[1] - 1, cropped.shape[0] - 1], [0, cropped.shape[0] - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(src, quad.astype(np.float32))
    warped = cv2.warpPerspective(
        cropped,
        matrix,
        (CANVAS_SIZE, CANVAS_SIZE),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 12, 255, cv2.THRESH_BINARY)
    mask = cv2.GaussianBlur(mask, (5, 5), 0)
    return warped, mask


def multiply_blend(frame_bgr: np.ndarray, painting_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    frame_f = frame_bgr.astype(np.float32)
    paint_f = painting_bgr.astype(np.float32)
    alpha = (mask.astype(np.float32) / 255.0)[..., None]
    blended = (frame_f * paint_f) / 255.0
    result = frame_f * (1.0 - alpha) + blended * alpha
    return np.clip(result, 0, 255).astype(np.uint8)


def composite_painting_into_frame(
    painting_path: str,
    frame_path: str,
    output_path: str,
    canvas_size: int = CANVAS_SIZE,
    jpeg_quality: int = 88,
) -> dict:
    painting_bgr = cv2.imread(painting_path, cv2.IMREAD_COLOR)
    frame_bgr = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if painting_bgr is None:
        raise ValueError(f"Could not read painting: {painting_path}")
    if frame_bgr is None:
        raise ValueError(f"Could not read frame: {frame_path}")

    painting_crop = detect_painting_content(painting_bgr)
    frame_resized = _ensure_canvas(frame_bgr, canvas_size)
    quad = detect_placeholder_quad(frame_resized, canvas_size)
    warped, mask = fit_painting_to_quad(painting_crop, quad)
    result = multiply_blend(frame_resized, warped, mask)

    if os.getenv("EDITPRO_COMPOSITOR_DEBUG") == "1":
        _write_compositor_debug(frame_resized, quad, output_path, canvas_size)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    rgb = cv2.cvtColor(result, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb)
    img.save(output_path, format="JPEG", quality=jpeg_quality, optimize=True)
    file_size = os.path.getsize(output_path)
    return {"path": output_path, "bytes": file_size}


def generate_for_product(
    painting_path: str,
    output_dir: str,
    output_base_name: str,
    frame_paths: Optional[list] = None,
    frames: Optional[list] = None,
    canvas_size: int = CANVAS_SIZE,
    jpeg_quality: int = 88,
) -> dict:
    os.makedirs(output_dir, exist_ok=True)
    images = []
    errors = []
    total_bytes = 0

    if frames:
        frame_entries = frames
    elif frame_paths:
        frame_entries = [
            {
                "framePath": frame_path,
                "outputIndex": index,
                "room": None,
                "frameTemplate": os.path.basename(frame_path),
            }
            for index, frame_path in enumerate(frame_paths)
        ]
    else:
        return {"images": [], "totalBytes": 0, "errors": [{"message": "No frames provided."}]}

    for entry in frame_entries:
        frame_path = entry.get("framePath") or entry.get("frame_path")
        output_index = entry.get("outputIndex", entry.get("output_index"))
        if output_index is None:
            output_index = 0
        frame_name = entry.get("frameTemplate") or entry.get("frame_template") or os.path.basename(frame_path or "")
        room = entry.get("room")
        filename = f"{output_base_name}_{output_index}.jpg"
        output_path = os.path.join(output_dir, filename)
        try:
            result = composite_painting_into_frame(
                painting_path,
                frame_path,
                output_path,
                canvas_size=canvas_size,
                jpeg_quality=jpeg_quality,
            )
            total_bytes += result["bytes"]
            image_record = {
                "index": output_index,
                "filename": filename,
                "path": output_path,
                "bytes": result["bytes"],
                "frameTemplate": frame_name,
            }
            if room is not None:
                image_record["room"] = room
            room_label = entry.get("roomLabel") or entry.get("room_label")
            if room_label is not None:
                image_record["roomLabel"] = room_label
            images.append(image_record)
        except Exception as exc:  # noqa: BLE001
            errors.append({"frameTemplate": frame_name, "message": str(exc)})

    return {"images": images, "totalBytes": total_bytes, "errors": errors}
