"""Core lifestyle image compositing: painting into frame with multiply blend."""

from __future__ import annotations

import json
import os
import tempfile
from functools import lru_cache
from typing import Optional, Tuple

import cv2
import numpy as np
from PIL import Image

CANVAS_SIZE = 1080
DARK_THRESHOLD = 70
# Production frames use grey mat #D7DBD8; calibration frames use green #30DF5F
PLACEHOLDER_GREY_RGB = np.array([215, 219, 216], dtype=np.uint8)
PLACEHOLDER_GREEN_RGB = np.array([48, 223, 95], dtype=np.uint8)  # #30DF5F
PLACEHOLDER_RGB_TOLERANCE = 18
PLACEHOLDER_LAB_TOLERANCE = 22
PLACEHOLDER_VARIANCE_THRESHOLD = 25.0
PLACEHOLDER_VARIANCE_WINDOW = 15
PLACEHOLDER_MIN_AREA_RATIO = 0.03
PLACEHOLDER_MAX_AREA_RATIO = 0.72
PLACEHOLDER_MORPH_KERNEL = 11
PLACEHOLDER_MAT_INSET_PX = 8
QUAD_MIN_ASPECT_RATIO = 0.3
QUAD_MAX_ASPECT_RATIO = 3.0

# Blend defaults. blendMode "scene" imparts the frame's normalized lighting/shadow
# onto the painting; "multiply" reproduces the exact old frame*paint/255 behavior.
DEFAULT_BLEND_MODE = "scene"
DEFAULT_BLEND_STRENGTH = 1.0
# Percentile of in-region frame luminance treated as the "white" reference (no darkening).
BLEND_SHADING_REFERENCE_PERCENTILE = 97.0

ORIENTATION_LABELS = {
    "portrait": "Portrait",
    "landscape": "Landscape",
    "square": "Square",
}
FRAME_QUADS_PATH = os.path.join(os.path.dirname(__file__), "frame-quads.json")

_PLACEHOLDER_GREY_BGR = np.array(
    [[[PLACEHOLDER_GREY_RGB[2], PLACEHOLDER_GREY_RGB[1], PLACEHOLDER_GREY_RGB[0]]]], dtype=np.uint8
)
_PLACEHOLDER_GREEN_BGR = np.array(
    [[[PLACEHOLDER_GREEN_RGB[2], PLACEHOLDER_GREEN_RGB[1], PLACEHOLDER_GREEN_RGB[0]]]], dtype=np.uint8
)
_PLACEHOLDER_GREY_LAB = cv2.cvtColor(_PLACEHOLDER_GREY_BGR, cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)
_PLACEHOLDER_GREEN_LAB = cv2.cvtColor(_PLACEHOLDER_GREEN_BGR, cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)


def _normalize_orientation_label(orientation: Optional[str]) -> Optional[str]:
    if not orientation:
        return None
    key = str(orientation).strip().lower()
    if key in ORIENTATION_LABELS:
        return ORIENTATION_LABELS[key]
    label = str(orientation).strip()
    return label[:1].upper() + label[1:] if label else None


@lru_cache(maxsize=1)
def load_frame_quads() -> dict:
    if not os.path.isfile(FRAME_QUADS_PATH):
        return {}
    try:
        with open(FRAME_QUADS_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return {}
    return payload.get("quads") or {}


def stored_quad_for(
    orientation: Optional[str],
    frame_template: Optional[str],
    canvas_size: int = CANVAS_SIZE,
    frame_set: Optional[str] = None,
) -> Optional[np.ndarray]:
    orientation_label = _normalize_orientation_label(orientation)
    template = str(frame_template or "").strip()
    if not template:
        return None

    quads = load_frame_quads()
    lookup_keys: list[str] = []
    if frame_set:
        lookup_keys.append(str(frame_set).strip())
    if orientation_label:
        lookup_keys.append(orientation_label)

    entry = None
    for key in lookup_keys:
        entry = (quads.get(key) or {}).get(template)
        if entry:
            break
    if not entry:
        return None

    points = entry.get("points")
    if not isinstance(points, list) or len(points) != 4:
        return None

    quad = np.array(points, dtype=np.float32)
    if quad.shape != (4, 2):
        return None

    quad[:, 0] *= float(canvas_size)
    quad[:, 1] *= float(canvas_size)
    return order_points(quad)


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
    h, w = painting_bgr.shape[:2]
    # Vectorized luminance from BGR channels (matches luminance(): 0.299R + 0.587G + 0.114B).
    frame_f = painting_bgr.astype(np.float32)
    lum = 0.114 * frame_f[..., 0] + 0.587 * frame_f[..., 1] + 0.299 * frame_f[..., 2]
    dark = lum < DARK_THRESHOLD

    if not np.any(dark):
        pad = max(2, int(min(h, w) * 0.02))
        return painting_bgr[pad : h - pad, pad : w - pad]

    ys, xs = np.where(dark)
    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())

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


def _color_match_mask(
    frame_bgr: np.ndarray,
    target_rgb: np.ndarray,
    target_lab: np.ndarray,
    tolerance: int,
    lab_tolerance: float,
) -> np.ndarray:
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    pr, pg, pb = (int(v) for v in target_rgb)
    tol = tolerance
    rgb_mask = (
        (rgb[:, :, 0] >= pr - tol)
        & (rgb[:, :, 0] <= pr + tol)
        & (rgb[:, :, 1] >= pg - tol)
        & (rgb[:, :, 1] <= pg + tol)
        & (rgb[:, :, 2] >= pb - tol)
        & (rgb[:, :, 2] <= pb + tol)
    )

    lab = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    dist = np.sqrt(np.sum((lab - target_lab) ** 2, axis=2))
    lab_mask = dist <= lab_tolerance

    return (rgb_mask | lab_mask).astype(np.uint8) * 255


def _morph_placeholder_mask(raw_mask: np.ndarray) -> np.ndarray:
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (PLACEHOLDER_MORPH_KERNEL, PLACEHOLDER_MORPH_KERNEL)
    )
    mask = cv2.morphologyEx(raw_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    return mask


def _apply_flatness_filter(frame_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    window = PLACEHOLDER_VARIANCE_WINDOW
    mean = cv2.blur(gray, (window, window))
    mean_sq = cv2.blur(gray * gray, (window, window))
    variance = mean_sq - mean * mean
    flat = (variance <= PLACEHOLDER_VARIANCE_THRESHOLD).astype(np.uint8) * 255
    return cv2.bitwise_and(mask, flat)


def _center_placeholder_color(frame_bgr: np.ndarray) -> str:
    """Prefer green when the mat opening at center is green (#30DF5F)."""
    h, w = frame_bgr.shape[:2]
    margin = max(24, min(h, w) // 8)
    cy, cx = h // 2, w // 2
    y0, y1 = max(0, cy - margin), min(h, cy + margin)
    x0, x1 = max(0, cx - margin), min(w, cx + margin)
    patch = frame_bgr[y0:y1, x0:x1]
    if patch.size == 0:
        return "grey"

    rgb = cv2.cvtColor(patch, cv2.COLOR_BGR2RGB)
    flat = rgb.reshape(-1, 3).astype(np.float32)
    green_dist = np.linalg.norm(flat - PLACEHOLDER_GREEN_RGB.astype(np.float32), axis=1)
    grey_dist = np.linalg.norm(flat - PLACEHOLDER_GREY_RGB.astype(np.float32), axis=1)
    green_hits = int(np.sum(green_dist <= PLACEHOLDER_RGB_TOLERANCE + 4))
    grey_hits = int(np.sum(grey_dist <= PLACEHOLDER_RGB_TOLERANCE + 4))
    total = flat.shape[0]
    if green_hits >= total * 0.25:
        return "green"
    if grey_hits >= total * 0.25:
        return "grey"
    return "green" if green_hits > grey_hits else "grey"


def _largest_component_area(mask: np.ndarray) -> int:
    num_labels, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if num_labels <= 1:
        return 0
    return int(np.max(stats[1:, cv2.CC_STAT_AREA]))


def _resolve_green_mat_mode(frame_bgr: np.ndarray, green_mask: np.ndarray, canvas_size: int) -> bool:
    min_area = int(canvas_size * canvas_size * PLACEHOLDER_MIN_AREA_RATIO)
    if _center_placeholder_color(frame_bgr) == "green":
        return True
    return _largest_component_area(green_mask) >= min_area


def detect_placeholder_mask(frame_bgr: np.ndarray, canvas_size: int = CANVAS_SIZE) -> np.ndarray:
    frame = _ensure_canvas(frame_bgr, canvas_size)
    min_area = int(canvas_size * canvas_size * PLACEHOLDER_MIN_AREA_RATIO)

    green_raw = _color_match_mask(
        frame,
        PLACEHOLDER_GREEN_RGB,
        _PLACEHOLDER_GREEN_LAB,
        PLACEHOLDER_RGB_TOLERANCE,
        PLACEHOLDER_LAB_TOLERANCE,
    )
    grey_raw = _color_match_mask(
        frame,
        PLACEHOLDER_GREY_RGB,
        _PLACEHOLDER_GREY_LAB,
        PLACEHOLDER_RGB_TOLERANCE,
        PLACEHOLDER_LAB_TOLERANCE,
    )

    green_mask = _morph_placeholder_mask(green_raw)
    grey_mask = _morph_placeholder_mask(grey_raw)
    green_area = cv2.countNonZero(green_mask)
    grey_area = cv2.countNonZero(grey_mask)
    center_color = _center_placeholder_color(frame)
    largest_green = _largest_component_area(green_mask)
    has_green_mat = largest_green >= min_area

    if has_green_mat or (center_color == "green" and green_area >= min_area):
        mask = green_mask
        use_flatness = False
        picked = "green"
    elif center_color == "grey" and grey_area >= min_area:
        mask = grey_mask
        use_flatness = True
        picked = "grey"
    elif green_area >= grey_area and green_area >= min_area:
        mask = green_mask
        use_flatness = False
        picked = "green"
    else:
        mask = grey_mask
        use_flatness = True
        picked = "grey"

    if use_flatness:
        mask = _apply_flatness_filter(frame, mask)

    return mask


def _component_rectangularity(
    labels: np.ndarray, stats: np.ndarray, label: int
) -> float:
    component = (labels == label).astype(np.uint8) * 255
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0
    area = float(stats[label, cv2.CC_STAT_AREA])
    rect = cv2.minAreaRect(max(contours, key=cv2.contourArea))
    rect_area = float(rect[1][0] * rect[1][1])
    if rect_area <= 0:
        return 0.0
    return area / rect_area


def _score_opening_component(
    labels: np.ndarray,
    stats: np.ndarray,
    centroids: np.ndarray,
    canvas_size: int,
) -> int:
    canvas_area = canvas_size * canvas_size
    best_label = 1
    best_score = -1.0

    for label in range(1, stats.shape[0]):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < canvas_area * 0.015 or area > canvas_area * 0.4:
            continue

        x, y, w, h, _ = stats[label]
        if w > canvas_size * 0.52 or h > canvas_size * 0.65:
            continue
        cx, cy = centroids[label]
        aspect = min(w, h) / max(w, h) if max(w, h) > 0 else 0.0
        rectangularity = _component_rectangularity(labels, stats, label)

        aspect_score = 1.0 - min(abs(aspect - 0.68) / 0.35, 1.0)
        center_score = 1.0 - (cy / canvas_size) * 0.35 - abs(cx / canvas_size - 0.5) * 0.35
        rect_score = min(rectangularity, 1.0)
        size_score = 1.0 - min(abs(area / (canvas_area * 0.12) - 1.0), 1.0)
        score = (
            aspect_score * 0.3
            + center_score * 0.2
            + rect_score * 0.35
            + size_score * 0.15
        )
        if score > best_score:
            best_score = score
            best_label = label

    return best_label


def _select_central_component(placeholder_mask: np.ndarray, canvas_size: int) -> np.ndarray:
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        placeholder_mask, connectivity=8
    )
    if num_labels <= 1:
        return placeholder_mask

    center = np.array([canvas_size / 2, canvas_size / 2], dtype=np.float32)
    best_label = 1
    best_score = -1.0
    canvas_area = canvas_size * canvas_size

    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < canvas_area * 0.015:
            continue
        cx, cy = centroids[label]
        dist = float(np.linalg.norm(np.array([cx, cy]) - center) / canvas_size)
        rect = _component_rectangularity(labels, stats, label)
        score = area * min(rect, 1.0) * (1.0 - min(dist, 0.55))
        if score > best_score:
            best_score = score
            best_label = label

    return (labels == best_label).astype(np.uint8) * 255


def _select_largest_rectangular_component(placeholder_mask: np.ndarray, canvas_size: int) -> np.ndarray:
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
        placeholder_mask, connectivity=8
    )
    if num_labels <= 1:
        return placeholder_mask

    canvas_area = canvas_size * canvas_size
    best_label = 1
    best_score = -1.0

    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < canvas_area * 0.02 or area > canvas_area * 0.7:
            continue
        rect = _component_rectangularity(labels, stats, label)
        score = area * min(rect, 1.0)
        if score > best_score:
            best_score = score
            best_label = label

    return (labels == best_label).astype(np.uint8) * 255


def _select_scored_grey_component(placeholder_mask: np.ndarray, canvas_size: int) -> np.ndarray:
    """Pick the painting opening on grey frames; reject wall-spanning grey blobs."""
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        placeholder_mask, connectivity=8
    )
    if num_labels <= 1:
        return np.zeros_like(placeholder_mask)

    canvas_area = canvas_size * canvas_size
    best_label = 0
    best_score = -1.0

    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < canvas_area * 0.02 or area > canvas_area * 0.22:
            continue

        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])
        if w > canvas_size * 0.52 or h > canvas_size * 0.65:
            continue

        touches_left = x <= 2
        touches_right = x + w >= canvas_size - 2
        touches_top = y <= 2
        touches_bottom = y + h >= canvas_size - 2
        if touches_left and touches_right:
            continue
        if (touches_left and touches_top and touches_right) or (
            touches_left and touches_bottom and touches_right
        ):
            continue

        cx, cy = centroids[label]
        aspect = min(w, h) / max(w, h) if max(w, h) > 0 else 0.0
        rectangularity = _component_rectangularity(labels, stats, label)
        aspect_score = 1.0 - min(abs(aspect - 0.72) / 0.35, 1.0)
        center_score = 1.0 - (cy / canvas_size) * 0.25 - abs(cx / canvas_size - 0.5) * 0.3
        rect_score = min(rectangularity, 1.0)
        size_score = 1.0 - min(abs(area / (canvas_area * 0.10) - 1.0), 1.0)
        score = aspect_score * 0.25 + center_score * 0.15 + rect_score * 0.25 + size_score * 0.35
        if score > best_score:
            best_score = score
            best_label = label

    if best_label <= 0:
        return np.zeros_like(placeholder_mask)
    return (labels == best_label).astype(np.uint8) * 255


def _select_opening_component(
    placeholder_mask: np.ndarray, canvas_size: int, use_green_mat: bool = False
) -> np.ndarray:
    if use_green_mat:
        return _select_largest_rectangular_component(placeholder_mask, canvas_size)

    scored = _select_scored_grey_component(placeholder_mask, canvas_size)
    if cv2.countNonZero(scored) > 0:
        return scored
    return _select_central_component(placeholder_mask, canvas_size)


def _is_flat_template_mat(mask: np.ndarray, canvas_size: int) -> bool:
    """Null-style frames: large rectangular grey mat with white border strips."""
    area = cv2.countNonZero(mask)
    canvas_area = canvas_size * canvas_size
    if area < canvas_area * 0.42:
        return False

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False

    contour = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(contour)
    w, h = rect[1]
    if min(w, h) < canvas_size * 0.35:
        return False

    rect_area = float(w * h)
    if rect_area <= 0:
        return False
    return cv2.contourArea(contour) / rect_area > 0.88


def _inset_filled_mask(filled_mask: np.ndarray, inset_px: int = PLACEHOLDER_MAT_INSET_PX) -> np.ndarray:
    if inset_px <= 0:
        return filled_mask
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (inset_px * 2 + 1, inset_px * 2 + 1))
    eroded = cv2.erode(filled_mask, kernel, iterations=1)
    if cv2.countNonZero(eroded) < cv2.countNonZero(filled_mask) * 0.25:
        return filled_mask
    return eroded


def _filled_placeholder_mask(
    placeholder_mask: np.ndarray,
    canvas_size: int = CANVAS_SIZE,
    use_green_mat: bool = False,
) -> np.ndarray:
    """Solid opening mask: best placeholder component, gap-filled, contour-filled, mat-inset."""
    component = _select_opening_component(placeholder_mask, canvas_size, use_green_mat)
    flat_template = _is_flat_template_mat(component, canvas_size)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (31, 31))
    closed = cv2.morphologyEx(component, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return _inset_filled_mask(closed) if not flat_template else closed
    filled = np.zeros_like(placeholder_mask)
    cv2.drawContours(filled, [max(contours, key=cv2.contourArea)], -1, 255, thickness=cv2.FILLED)
    if flat_template:
        return filled
    return _inset_filled_mask(filled)


def _mask_from_quad(quad: np.ndarray, canvas_size: int = CANVAS_SIZE) -> np.ndarray:
    mask = np.zeros((canvas_size, canvas_size), dtype=np.uint8)
    cv2.fillConvexPoly(mask, quad.astype(np.int32), 255)
    return mask


def _quad_placeholder_iou(quad: np.ndarray, placeholder_mask: np.ndarray, canvas_size: int = CANVAS_SIZE) -> float:
    quad_mask = _mask_from_quad(quad, canvas_size)
    intersection = cv2.countNonZero(cv2.bitwise_and(quad_mask, placeholder_mask))
    union = cv2.countNonZero(cv2.bitwise_or(quad_mask, placeholder_mask))
    if union <= 0:
        return 0.0
    return intersection / union


def _quad_dimensions(quad: np.ndarray) -> Tuple[float, float]:
    width_a = np.linalg.norm(quad[1] - quad[0])
    width_b = np.linalg.norm(quad[2] - quad[3])
    height_a = np.linalg.norm(quad[3] - quad[0])
    height_b = np.linalg.norm(quad[2] - quad[1])
    return max(width_a, width_b), max(height_a, height_b)


def _is_valid_quad(
    quad: np.ndarray, canvas_size: int, min_area_ratio: float = PLACEHOLDER_MIN_AREA_RATIO
) -> bool:
    max_w, max_h = _quad_dimensions(quad)
    if max_w < 8 or max_h < 8:
        return False
    aspect = max_w / max_h if max_h > 0 else 0.0
    if aspect < QUAD_MIN_ASPECT_RATIO or aspect > QUAD_MAX_ASPECT_RATIO:
        return False
    area = cv2.contourArea(quad.reshape(-1, 1, 2).astype(np.float32))
    canvas_area = canvas_size * canvas_size
    if area < canvas_area * min_area_ratio:
        return False
    if area > canvas_area * PLACEHOLDER_MAX_AREA_RATIO:
        return False
    return True


def _quad_from_contour(contour: np.ndarray, canvas_size: int) -> np.ndarray:
    peri = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
    if len(approx) == 4:
        quad = order_points(approx.reshape(4, 2).astype(np.float32))
        if _is_valid_quad(quad, canvas_size):
            return quad

    rect = cv2.minAreaRect(contour)
    box = cv2.boxPoints(rect)
    return order_points(box.astype(np.float32))


def _quad_fit_mask(filled_mask: np.ndarray) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    for iterations in (2, 1):
        eroded = cv2.erode(filled_mask, kernel, iterations=iterations)
        if cv2.countNonZero(eroded) >= cv2.countNonZero(filled_mask) * 0.5:
            return eroded
    return filled_mask


def detect_grey_mat_quad_from_frame_border(
    frame_bgr: np.ndarray, canvas_size: int = CANVAS_SIZE
) -> Optional[np.ndarray]:
    """Find grey mat opening via dark picture-frame contour; inset for mat interior."""
    frame = _ensure_canvas(frame_bgr, canvas_size)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    dark = (gray < DARK_THRESHOLD).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, kernel, iterations=2)
    grey_raw = _color_match_mask(
        frame,
        PLACEHOLDER_GREY_RGB,
        _PLACEHOLDER_GREY_LAB,
        PLACEHOLDER_RGB_TOLERANCE,
        PLACEHOLDER_LAB_TOLERANCE,
    )

    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    canvas_area = canvas_size * canvas_size
    best_quad: Optional[np.ndarray] = None
    best_score = -1.0

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < canvas_area * 0.0015 or area > canvas_area * 0.18:
            continue

        rect = cv2.minAreaRect(contour)
        w, h = rect[1]
        if min(w, h) < 24:
            continue

        aspect = min(w, h) / max(w, h) if max(w, h) > 0 else 0.0
        if aspect < 0.35:
            continue

        box = order_points(cv2.boxPoints(rect).astype(np.float32))
        center = box.mean(axis=0)
        inset_ratio = 0.12
        inner = order_points((center + (box - center) * (1.0 - inset_ratio * 2)).astype(np.float32))
        if not _is_valid_quad(inner, canvas_size, min_area_ratio=0.015):
            continue

        inner_mask = _mask_from_quad(inner, canvas_size)
        inner_area = cv2.countNonZero(inner_mask)
        if inner_area < canvas_area * 0.01:
            continue

        grey_inside = cv2.countNonZero(cv2.bitwise_and(grey_raw, inner_mask))
        grey_density = grey_inside / inner_area
        if grey_density < 0.45:
            continue

        cx, cy = center
        center_score = 1.0 - (cy / canvas_size) * 0.35 - abs(cx / canvas_size - 0.5) * 0.35
        size_score = 1.0 - min(abs(area / (canvas_area * 0.05) - 1.0), 1.0)
        aspect_score = 1.0 - min(abs(aspect - 0.72) / 0.4, 1.0)
        score = (
            grey_density * 0.45
            + center_score * 0.2
            + size_score * 0.2
            + aspect_score * 0.15
        )
        if score > best_score:
            best_score = score
            best_quad = inner

    return best_quad


def _quad_from_filled_mask(
    filled_mask: np.ndarray, canvas_size: int, flat_template: bool = False
) -> np.ndarray:
    """Perspective quad from the solid opening contour (4-corner fit, not axis-aligned bbox)."""
    fit_mask = filled_mask if flat_template else _quad_fit_mask(filled_mask)
    contours, _ = cv2.findContours(fit_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return fallback_rect(canvas_size)

    contour = max(contours, key=cv2.contourArea)

    if flat_template:
        rect = cv2.minAreaRect(contour)
        quad = order_points(cv2.boxPoints(rect).astype(np.float32))
        if _is_valid_quad(quad, canvas_size):
            return quad

    peri = cv2.arcLength(contour, True)
    best_quad: Optional[np.ndarray] = None
    best_iou = -1.0
    for epsilon_ratio in (
        0.003, 0.005, 0.008, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08, 0.12,
    ):
        approx = cv2.approxPolyDP(contour, epsilon_ratio * peri, True)
        if len(approx) != 4:
            continue
        quad = order_points(approx.reshape(4, 2).astype(np.float32))
        if not _is_valid_quad(quad, canvas_size):
            continue
        iou = _quad_placeholder_iou(quad, fit_mask, canvas_size)
        if iou > best_iou:
            best_iou = iou
            best_quad = quad

    if best_quad is not None and best_iou >= 0.45:
        return best_quad

    rect = cv2.minAreaRect(contour)
    quad = order_points(cv2.boxPoints(rect).astype(np.float32))
    if _is_valid_quad(quad, canvas_size):
        return quad
    return fallback_rect(canvas_size)


def detect_placeholder_quad(
    frame_bgr: np.ndarray,
    canvas_size: int = CANVAS_SIZE,
    placeholder_mask: Optional[np.ndarray] = None,
    center_is_green: Optional[bool] = None,
    use_green_mat: Optional[bool] = None,
) -> np.ndarray:
    frame = _ensure_canvas(frame_bgr, canvas_size)
    mask = placeholder_mask if placeholder_mask is not None else detect_placeholder_mask(frame, canvas_size)
    green_mask = _morph_placeholder_mask(
        _color_match_mask(
            frame,
            PLACEHOLDER_GREEN_RGB,
            _PLACEHOLDER_GREEN_LAB,
            PLACEHOLDER_RGB_TOLERANCE,
            PLACEHOLDER_LAB_TOLERANCE,
        )
    )
    if use_green_mat is None:
        use_green_mat = _resolve_green_mat_mode(frame, green_mask, canvas_size)
    filled_mask = _filled_placeholder_mask(mask, canvas_size, use_green_mat=use_green_mat)
    flat_template = _is_flat_template_mat(filled_mask, canvas_size)
    filled_area = cv2.countNonZero(filled_mask)
    canvas_area = canvas_size * canvas_size
    if filled_area < canvas_area * 0.008:
        return detect_opening_quad(frame, canvas_size)
    if filled_area > canvas_area * PLACEHOLDER_MAX_AREA_RATIO:
        return detect_opening_quad(frame, canvas_size)

    quad = _quad_from_filled_mask(filled_mask, canvas_size, flat_template=flat_template)
    iou = _quad_placeholder_iou(quad, filled_mask, canvas_size)

    if not use_green_mat and iou < 0.75:
        frame_quad = detect_grey_mat_quad_from_frame_border(frame, canvas_size)
        if frame_quad is not None:
            return frame_quad

    if iou < 0.45:
        opening_quad = detect_opening_quad(frame, canvas_size)
        opening_iou = _quad_placeholder_iou(opening_quad, filled_mask, canvas_size)
        if opening_iou > iou and opening_iou >= 0.45:
            return opening_quad
    return quad


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
    region_mask: np.ndarray,
    canvas_size: int = CANVAS_SIZE,
) -> None:
    debug_dir = os.path.join(tempfile.gettempdir(), "editpro-compositor-debug")
    os.makedirs(debug_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(output_path))[0]
    mask = detect_placeholder_mask(frame_resized, canvas_size)
    cv2.imwrite(os.path.join(debug_dir, f"{base_name}_mask.jpg"), mask)
    cv2.imwrite(os.path.join(debug_dir, f"{base_name}_region.jpg"), region_mask)
    cv2.imwrite(os.path.join(debug_dir, f"{base_name}_quad.jpg"), draw_quad_overlay(frame_resized, quad))


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


def _warp_rect_to_quad(
    rect_bgr: np.ndarray,
    quad: np.ndarray,
    canvas_size: int = CANVAS_SIZE,
) -> np.ndarray:
    rect_h, rect_w = rect_bgr.shape[:2]
    src = np.array(
        [[0, 0], [rect_w - 1, 0], [rect_w - 1, rect_h - 1], [0, rect_h - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(src, quad.astype(np.float32))
    return cv2.warpPerspective(
        rect_bgr,
        matrix,
        (canvas_size, canvas_size),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )


def _resize_painting(painting_bgr: np.ndarray, width: int, height: int) -> np.ndarray:
    src_h, src_w = painting_bgr.shape[:2]
    if src_w <= 0 or src_h <= 0:
        return painting_bgr
    upscaling = width > src_w or height > src_h
    interpolation = cv2.INTER_CUBIC if upscaling else cv2.INTER_AREA
    return cv2.resize(painting_bgr, (width, height), interpolation=interpolation)


def fit_painting_to_quad(painting_bgr: np.ndarray, quad: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Cover-fit painting into quad bbox: scale to fill, center-crop overflow axis."""
    max_w, max_h = _quad_dimensions(quad)
    max_w = max(int(max_w), 1)
    max_h = max(int(max_h), 1)

    ph, pw = painting_bgr.shape[:2]
    paint_ar = pw / ph if ph > 0 else 1.0
    quad_ar = max_w / max_h if max_h > 0 else 1.0
    scale_w = max_w / pw if pw > 0 else 1.0
    scale_h = max_h / ph if ph > 0 else 1.0
    scale = max(scale_w, scale_h)

    new_w = max(int(round(pw * scale)), 1)
    new_h = max(int(round(ph * scale)), 1)
    resized = _resize_painting(painting_bgr, new_w, new_h)

    x0 = max(0, (new_w - max_w) // 2)
    y0 = max(0, (new_h - max_h) // 2)
    cropped = resized[y0 : y0 + max_h, x0 : x0 + max_w]

    if cropped.shape[0] != max_h or cropped.shape[1] != max_w:
        fitted = np.full((max_h, max_w, 3), 255, dtype=np.uint8)
        h = min(cropped.shape[0], max_h)
        w = min(cropped.shape[1], max_w)
        fitted[0:h, 0:w] = cropped[0:h, 0:w]
        cropped = fitted

    fit_mode = "width-fit" if scale_w >= scale_h else "height-fit"
    crop_x = x0 if new_w > max_w else 0
    crop_y = y0 if new_h > max_h else 0

    warped = _warp_rect_to_quad(cropped, quad, CANVAS_SIZE)
    white_rect = np.full_like(cropped, 255, dtype=np.uint8)
    geom_mask_color = _warp_rect_to_quad(white_rect, quad, CANVAS_SIZE)
    geom_mask = cv2.cvtColor(geom_mask_color, cv2.COLOR_BGR2GRAY)
    _, geom_mask = cv2.threshold(geom_mask, 1, 255, cv2.THRESH_BINARY)
    return warped, geom_mask


def multiply_blend(
    frame_bgr: np.ndarray,
    painting_bgr: np.ndarray,
    mask: np.ndarray,
    mode: str = DEFAULT_BLEND_MODE,
    strength: float = DEFAULT_BLEND_STRENGTH,
) -> np.ndarray:
    frame_f = frame_bgr.astype(np.float32)
    paint_f = painting_bgr.astype(np.float32)
    alpha = (mask.astype(np.float32) / 255.0)[..., None]

    if str(mode).strip().lower() == "multiply":
        # Legacy behaviour: true multiply against the raw frame color.
        shaded = (frame_f * paint_f) / 255.0
    else:
        # Scene-shading: normalize the frame's in-region luminance so the brightest
        # mat pixels leave the painting untouched and only shadows/light falloff
        # darken it. This imparts the room's lighting without uniform dimming.
        lum = 0.114 * frame_f[..., 0] + 0.587 * frame_f[..., 1] + 0.299 * frame_f[..., 2]
        region_vals = lum[mask > 0]
        if region_vals.size:
            # Subsample for the percentile: a global brightness reference is stable
            # under sampling, and this avoids sorting ~1M pixels every frame.
            if region_vals.size > 50000:
                region_vals = region_vals[:: region_vals.size // 50000]
            ref = float(np.percentile(region_vals, BLEND_SHADING_REFERENCE_PERCENTILE))
        else:
            ref = 255.0
        ref = max(ref, 1.0)
        shading = np.clip(lum / ref, 0.0, 1.0)[..., None]
        clamped_strength = float(np.clip(strength, 0.0, 1.0))
        shading = 1.0 - clamped_strength * (1.0 - shading)
        shaded = paint_f * shading

    result = frame_f * (1.0 - alpha) + shaded * alpha
    return np.clip(result, 0, 255).astype(np.uint8)


def composite_painting_into_frame(
    painting_path: str,
    frame_path: str,
    output_path: str,
    canvas_size: int = CANVAS_SIZE,
    jpeg_quality: int = 88,
    orientation: Optional[str] = None,
    frame_template: Optional[str] = None,
    frame_set: Optional[str] = None,
    painting_crop: Optional[np.ndarray] = None,
    blend_mode: str = DEFAULT_BLEND_MODE,
    blend_strength: float = DEFAULT_BLEND_STRENGTH,
) -> dict:
    # painting_crop may be supplied pre-cropped (read + detected once per product);
    # otherwise read and crop here for standalone use.
    if painting_crop is None:
        painting_bgr = cv2.imread(painting_path, cv2.IMREAD_COLOR)
        if painting_bgr is None:
            raise ValueError(f"Could not read painting: {painting_path}")
        painting_crop = detect_painting_content(painting_bgr)

    frame_bgr = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if frame_bgr is None:
        raise ValueError(f"Could not read frame: {frame_path}")

    frame_resized = _ensure_canvas(frame_bgr, canvas_size)
    stored_quad = stored_quad_for(orientation, frame_template, canvas_size, frame_set=frame_set)
    if stored_quad is not None:
        quad = stored_quad
        warped, geom_mask = fit_painting_to_quad(painting_crop, quad)
        region_mask = _mask_from_quad(quad, canvas_size)
    else:
        green_mask = _morph_placeholder_mask(
            _color_match_mask(
                frame_resized,
                PLACEHOLDER_GREEN_RGB,
                _PLACEHOLDER_GREEN_LAB,
                PLACEHOLDER_RGB_TOLERANCE,
                PLACEHOLDER_LAB_TOLERANCE,
            )
        )
        use_green_mat = _resolve_green_mat_mode(frame_resized, green_mask, canvas_size)
        placeholder_mask = detect_placeholder_mask(frame_resized, canvas_size)
        solid_mask = _filled_placeholder_mask(
            placeholder_mask, canvas_size, use_green_mat=use_green_mat
        )
        quad = detect_placeholder_quad(
            frame_resized,
            canvas_size,
            placeholder_mask=placeholder_mask,
            use_green_mat=use_green_mat,
        )
        warped, geom_mask = fit_painting_to_quad(painting_crop, quad)
        quad_mask = _mask_from_quad(quad, canvas_size)
        flat_template = _is_flat_template_mat(solid_mask, canvas_size)
        overlap = cv2.bitwise_and(solid_mask, quad_mask)
        if flat_template:
            solid_mask = quad_mask
        elif cv2.countNonZero(overlap) < cv2.countNonZero(quad_mask) * 0.5:
            solid_mask = _inset_filled_mask(quad_mask)
        else:
            solid_mask = cv2.bitwise_and(solid_mask, quad_mask)
        region_mask = cv2.bitwise_and(geom_mask, solid_mask)

    result = multiply_blend(frame_resized, warped, region_mask, mode=blend_mode, strength=blend_strength)

    if os.getenv("EDITPRO_COMPOSITOR_DEBUG") == "1":
        _write_compositor_debug(frame_resized, quad, output_path, region_mask, canvas_size)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    rgb = cv2.cvtColor(result, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb)
    fd, tmp_path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        img.save(tmp_path, format="JPEG", quality=jpeg_quality, optimize=True)
        os.replace(tmp_path, output_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
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
    blend_mode: str = DEFAULT_BLEND_MODE,
    blend_strength: float = DEFAULT_BLEND_STRENGTH,
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

    # Read + crop the painting once and reuse across all frames for this product.
    painting_bgr = cv2.imread(painting_path, cv2.IMREAD_COLOR)
    if painting_bgr is None:
        return {
            "images": [],
            "totalBytes": 0,
            "errors": [{"message": f"Could not read painting: {painting_path}"}],
        }
    painting_crop = detect_painting_content(painting_bgr)

    for entry in frame_entries:
        frame_path = entry.get("framePath") or entry.get("frame_path")
        output_index = entry.get("outputIndex", entry.get("output_index"))
        if output_index is None:
            output_index = 0
        frame_name = entry.get("frameTemplate") or entry.get("frame_template") or os.path.basename(frame_path or "")
        orientation = entry.get("orientation")
        frame_set = entry.get("frameSet") or entry.get("frame_set")
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
                orientation=orientation,
                frame_template=frame_name,
                frame_set=frame_set,
                painting_crop=painting_crop,
                blend_mode=blend_mode,
                blend_strength=blend_strength,
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
