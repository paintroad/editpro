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
# "contain" never crops the painting: spare window space becomes mat. "cover" fills and crops.
PAINTING_FIT_MODE = os.environ.get("EDITPRO_PAINTING_FIT_MODE", "contain").strip().lower()
PAINTING_MAT_BGR = (255, 255, 255)
PAINTING_MAX_CROP = 0.03
# Room frames that could not be reshaped all the way may crop this much of the painting so it
# still fills the window edge to edge; only shapes further off are padded.
ROOM_MAX_CROP = float(os.environ.get("EDITPRO_ROOM_MAX_CROP", "0.10"))
# Extra mat on room frames, as a share of the window's shorter side. 0 because the room
# templates are built with their own mat and windows already shaped to the painting.
ROOM_MAT_RATIO = float(os.environ.get("EDITPRO_ROOM_MAT_RATIO", "0"))
# Reshape the template frame to the painting's own shape (straight-on frames only), so the
# painting fills the window exactly instead of being padded or cropped.
FRAME_ADAPT = os.environ.get("EDITPRO_FRAME_ADAPT", "1") != "0"
# Largest share of the window's width or height that may be removed when reshaping.
FRAME_ADAPT_MAX = 0.45
FRAME_EDGE_STEP = 9
FRAME_EDGE_REACH = 0.3
FRAME_SHADOW_MARGIN = 24
# The wall next to a frame is too busy to extend when more than FRAME_WALL_MAX_EDGES of its
# pixels have a brightness step above FRAME_WALL_MAX_GRADIENT.
FRAME_WALL_MAX_GRADIENT = 10.0
FRAME_WALL_MAX_EDGES = 0.004
# How far past the window the grey band round a canvas or edge-to-edge frame may reach, and
# the brightness step that marks where it meets wall, shadow or moulding.
CANVAS_EDGE_REACH = 9
CANVAS_EDGE_MIN_STEP = 6.0
# Matted rooms (meta.mat): "cover" runs the painting over the mat to the moulding, "thin" leaves
# a mat of MAT_THIN_SHARE of the painting's shorter side. MAT_REACH bounds the mat search (share
# of the window) and MAT_STEP is the brightness change where mat meets moulding.
MAT_THIN_SHARE = 0.035
MAT_REACH = 0.6
MAT_STEP = 22.0
# Rooms with meta.grow: a frame whose block (moulding included) spans less than
# FRAME_GROW_TARGET of the picture's width or height grows over plain wall, by at most
# FRAME_GROW_MAX of its size.
FRAME_GROW_TARGET = 0.40
FRAME_GROW_MAX = 0.35
# Mouldings wider than meta.mouldingMax (share of the painting's shorter side) are thinned from
# the inside: the painting or mat runs further out and the frame's outer edge stays.
# EDITPRO_MOULDING_MAX overrides it for every room, for trying other widths.
_moulding_env = os.environ.get("EDITPRO_MOULDING_MAX", "").strip()
MOULDING_MAX = float(_moulding_env) if _moulding_env else None

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


def _quad_entry(orientation: Optional[str], frame_template: Optional[str], frame_set: Optional[str]) -> Optional[dict]:
    template = str(frame_template or "").strip()
    if not template:
        return None
    orientation_label = _normalize_orientation_label(orientation)
    quads = load_frame_quads()
    lookup_keys: list[str] = []
    if frame_set:
        lookup_keys.append(str(frame_set).strip())
    if orientation_label:
        lookup_keys.append(orientation_label)
    for key in lookup_keys:
        entry = (quads.get(key) or {}).get(template)
        if entry:
            return entry
    return None


def room_meta(orientation: Optional[str], frame_template: Optional[str], frame_set: Optional[str] = None) -> dict:
    entry = _quad_entry(orientation, frame_template, frame_set)
    return (entry or {}).get("meta") or {}


def fills_to_edge(orientation: Optional[str], frame_template: Optional[str], frame_set: Optional[str] = None) -> bool:
    """Stretched canvases and edge-to-edge (no mat) frames: the painting reaches the canvas edge
    or the moulding, with no grey left between."""
    meta = room_meta(orientation, frame_template, frame_set)
    return bool(meta.get("canvas") or meta.get("edgeToEdge"))


def stored_quad_for(
    orientation: Optional[str],
    frame_template: Optional[str],
    canvas_size: int = CANVAS_SIZE,
    frame_set: Optional[str] = None,
) -> Optional[np.ndarray]:
    entry = _quad_entry(orientation, frame_template, frame_set)
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


def _trim_towards_aspect(painting_bgr: np.ndarray, target_ar: float, max_crop: float) -> np.ndarray:
    """Center-crop at most max_crop of one dimension to bring the painting closer to target_ar."""
    ph, pw = painting_bgr.shape[:2]
    if ph <= 0 or pw <= 0 or max_crop <= 0:
        return painting_bgr
    paint_ar = pw / ph
    if paint_ar > target_ar:
        keep_w = max(int(round(pw * (1.0 - max_crop))), int(round(ph * target_ar)))
        x0 = (pw - keep_w) // 2
        return painting_bgr[:, x0 : x0 + keep_w]
    keep_h = max(int(round(ph * (1.0 - max_crop))), int(round(pw / target_ar)))
    y0 = (ph - keep_h) // 2
    return painting_bgr[y0 : y0 + keep_h, :]


def fit_painting_to_quad(
    painting_bgr: np.ndarray, quad: np.ndarray, mat_ratio: float = 0.0, max_crop: float = PAINTING_MAX_CROP
) -> Tuple[np.ndarray, np.ndarray]:
    """Fit painting into quad bbox. "contain" crops at most max_crop to match the
    window shape, then keeps the whole painting inside an even mat of mat_ratio (share of the
    window's shorter side) on every edge, with any remaining space added to the short axis.
    "cover" scales to fill and center-crops the overflow axis."""
    max_w, max_h = _quad_dimensions(quad)
    max_w = max(int(max_w), 1)
    max_h = max(int(max_h), 1)

    if PAINTING_FIT_MODE == "contain":
        mat = int(round(min(max_w, max_h) * max(mat_ratio, 0.0)))
        inner_w = max(max_w - 2 * mat, 1)
        inner_h = max(max_h - 2 * mat, 1)
        painting_bgr = _trim_towards_aspect(painting_bgr, inner_w / inner_h, max_crop)
        ph, pw = painting_bgr.shape[:2]
        scale = min(inner_w / pw, inner_h / ph)
        new_w = min(max(int(round(pw * scale)), 1), inner_w)
        new_h = min(max(int(round(ph * scale)), 1), inner_h)
        resized = _resize_painting(painting_bgr, new_w, new_h)
        fill = PAINTING_MAT_BGR
        if (new_w < max_w or new_h < max_h) and mat == 0:
            # Spare space takes the painting's own edge colour rather than a white band.
            edge = np.concatenate([resized[0], resized[-1], resized[:, 0], resized[:, -1]])
            fill = tuple(int(v) for v in np.median(edge, axis=0))
        fitted = np.full((max_h, max_w, 3), fill, dtype=np.uint8)
        x0 = (max_w - new_w) // 2
        y0 = (max_h - new_h) // 2
        fitted[y0 : y0 + new_h, x0 : x0 + new_w] = resized
        warped = _warp_rect_to_quad(fitted, quad, CANVAS_SIZE)
        geom_mask_color = _warp_rect_to_quad(np.full_like(fitted, 255, dtype=np.uint8), quad, CANVAS_SIZE)
        geom_mask = cv2.cvtColor(geom_mask_color, cv2.COLOR_BGR2GRAY)
        _, geom_mask = cv2.threshold(geom_mask, 1, 255, cv2.THRESH_BINARY)
        return warped, geom_mask

    ph, pw = painting_bgr.shape[:2]
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


def _read_frame_with_alpha(frame_path: str):
    raw = cv2.imread(frame_path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        return None, None
    if raw.ndim == 2:
        return cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR), None
    if raw.shape[2] == 4:
        return raw[:, :, :3], raw[:, :, 3]
    return raw[:, :, :3], None


def _resize_alpha(alpha: Optional[np.ndarray], canvas_size: int) -> Optional[np.ndarray]:
    if alpha is None:
        return None
    if alpha.shape[0] == canvas_size and alpha.shape[1] == canvas_size:
        return alpha
    return cv2.resize(alpha, (canvas_size, canvas_size), interpolation=cv2.INTER_AREA)


def _quad_from_alpha(alpha: np.ndarray, canvas_size: int) -> Optional[np.ndarray]:
    hole = (alpha < 16).astype(np.uint8) * 255
    if cv2.countNonZero(hole) < canvas_size * canvas_size * 0.02:
        return None
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    hole = cv2.morphologyEx(hole, cv2.MORPH_CLOSE, kernel, iterations=1)
    contours, _ = cv2.findContours(hole, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(contour)
    quad = order_points(cv2.boxPoints(rect).astype(np.float32))
    if not _is_valid_quad(quad, canvas_size):
        return None
    return quad


def _save_composite(result_bgr, output_path: str, jpeg_quality: int, alpha=None, region_mask=None) -> None:
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    write_png = output_path.lower().endswith(".png")
    suffix = ".png" if write_png else ".jpg"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        if write_png:
            rgb = cv2.cvtColor(result_bgr, cv2.COLOR_BGR2RGB)
            if alpha is None:
                out_alpha = np.full(rgb.shape[:2], 255, np.uint8)
            else:
                out_alpha = alpha.copy()
                if region_mask is not None:
                    out_alpha[region_mask > 0] = 255
            rgba = np.dstack([rgb, out_alpha])
            Image.fromarray(rgba, mode="RGBA").save(tmp_path, format="PNG")
        else:
            rgb = cv2.cvtColor(result_bgr, cv2.COLOR_BGR2RGB)
            Image.fromarray(rgb).save(tmp_path, format="JPEG", quality=jpeg_quality, optimize=True)
        os.replace(tmp_path, output_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def _last_edge(profile: np.ndarray) -> int:
    """Distance from the window to the outermost sharp brightness change (frame edge or shadow)."""
    if profile.size < 8:
        return 0
    p = np.convolve(profile, np.ones(3) / 3.0, mode="same")
    k = np.nonzero(np.abs(p[4:] - p[:-4]) > FRAME_EDGE_STEP)[0] + 2
    k = k[(k >= 3) & (k < profile.size - 3)]
    return int(k.max()) + 3 if k.size else 0


def _frame_border(lum: np.ndarray, win: Tuple[int, int, int, int]) -> Tuple[int, int]:
    x0, y0, x1, y1 = win
    height, width = lum.shape
    w, h = x1 - x0 + 1, y1 - y0 + 1
    reach_x, reach_y = int(w * FRAME_EDGE_REACH), int(h * FRAME_EDGE_REACH)
    sides = []
    for f in (0.3, 0.5, 0.7):
        y = y0 + int(h * f)
        sides.append(_last_edge(lum[y, max(0, x0 - reach_x) : x0][::-1]))
        sides.append(_last_edge(lum[y, x1 + 1 : min(width, x1 + 1 + reach_x)]))
    tops = [_last_edge(lum[max(0, y0 - reach_y) : y0, x0 + int(w * f)][::-1]) for f in (0.3, 0.5, 0.7)]
    side, top = int(np.median(sides)), int(np.median(tops))
    # Mouldings are even all round; a very different top reading is a lamp or shelf above.
    if abs(top - side) > 0.5 * side:
        top = side
    return side, top


def _axis_aligned_window(quad: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    q = np.asarray(quad, dtype=np.float32)
    skew = max(abs(q[0, 1] - q[1, 1]), abs(q[3, 1] - q[2, 1]), abs(q[0, 0] - q[3, 0]), abs(q[1, 0] - q[2, 0]))
    if skew > 2:
        return None
    # Stored quads sit 1 px outside the grey window.
    return (
        int(round(q[:, 0].min())) + 1,
        int(round(q[:, 1].min())) + 1,
        int(round(q[:, 0].max())) - 1,
        int(round(q[:, 1].max())) - 1,
    )


def expand_to_edge(frame_bgr: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """The placeholder window stops a few pixels short of a stretched canvas's edge or an
    edge-to-edge frame's moulding, leaving a thin grey band. The quad is pushed out on each side
    to the step where that band meets wall, shadow or moulding, so the painting runs to the edge.
    The band is often a darker rim in the template; it takes the brightness of the face next to
    it, or scene shading would draw it on a light painting as a grey border.
    Returns (frame_bgr, quad)."""
    win = _axis_aligned_window(quad)
    if win is None:
        return frame_bgr, quad
    x0, y0, x1, y1 = win
    h, w = frame_bgr.shape[:2]
    lum = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ym = slice(y0 + (y1 - y0) // 4, y1 - (y1 - y0) // 4)
    xm = slice(x0 + (x1 - x0) // 4, x1 - (x1 - x0) // 4)
    profiles = {
        "left": lum[ym, max(0, x0 - CANVAS_EDGE_REACH) : x0].mean(axis=0)[::-1],
        "right": lum[ym, x1 + 1 : min(w, x1 + 1 + CANVAS_EDGE_REACH)].mean(axis=0),
        "top": lum[max(0, y0 - CANVAS_EDGE_REACH) : y0, xm].mean(axis=1)[::-1],
        "bottom": lum[y1 + 1 : min(h, y1 + 1 + CANVAS_EDGE_REACH), xm].mean(axis=1),
    }
    ring = {}
    for name, p in profiles.items():
        steps = np.abs(np.diff(p)) if p.size > 1 else np.zeros(0)
        ring[name] = int(np.argmax(steps)) + 1 if steps.size and steps.max() >= CANVAS_EDGE_MIN_STEP else 0
    out, box = _extend_box(frame_bgr, win, ring)
    return out, _quad_for_box(box)


def _quad_for_box(box: Tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = box
    return np.array([[x0 - 1, y0 - 1], [x1 + 1, y0 - 1], [x1 + 1, y1 + 1], [x0 - 1, y1 + 1]], dtype=np.float32)


def _extend_box(frame_bgr: np.ndarray, box: Tuple[int, int, int, int], ring: dict):
    """Push a box out by ring[side] px per side, filling the new band with the box's own edge
    pixels (taken 2 px inside, past its 1 px outline). Returns (frame_bgr, new box)."""
    x0, y0, x1, y1 = box
    nx0, ny0 = x0 - ring["left"], y0 - ring["top"]
    nx1, ny1 = x1 + ring["right"], y1 + ring["bottom"]
    out = frame_bgr.copy()
    # Columns first over the box's rows, then rows over the full new width (fills corners).
    if ring["left"]:
        out[y0 : y1 + 1, nx0 - 1 : x0 + 1] = out[y0 : y1 + 1, x0 + 2 : x0 + 3]
    if ring["right"]:
        out[y0 : y1 + 1, x1 : nx1 + 2] = out[y0 : y1 + 1, x1 - 2 : x1 - 1]
    if ring["top"]:
        out[ny0 - 1 : y0 + 1, nx0 - 1 : nx1 + 2] = out[y0 + 2 : y0 + 3, nx0 - 1 : nx1 + 2]
    if ring["bottom"]:
        out[y1 : ny1 + 2, nx0 - 1 : nx1 + 2] = out[y1 - 2 : y1 - 1, nx0 - 1 : nx1 + 2]
    return out, (nx0, ny0, nx1, ny1)


def _moulding_width(frame_bgr: np.ndarray, box: Tuple[int, int, int, int]) -> int:
    """Width of the moulding round a box that starts at the moulding's inner edge: where the
    colour, walking out, stays closer to the wall than to the moulding. Read on the top, left
    and right (the bottom often carries shadow or a shelf); 0 when unclear."""
    x0, y0, x1, y1 = box
    h, w = frame_bgr.shape[:2]
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    reach = int(0.25 * min(bw, bh))
    lab = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    ym = slice(y0 + bh // 4, y1 - bh // 4)
    xm = slice(x0 + bw // 4, x1 - bw // 4)
    profiles = [
        lab[max(0, y0 - reach) : y0, xm].mean(axis=1)[::-1],
        lab[ym, max(0, x0 - reach) : x0].mean(axis=0)[::-1],
        lab[ym, x1 + 1 : min(w, x1 + 1 + reach)].mean(axis=0),
    ]
    widths = []
    for p in profiles:
        if len(p) < reach or reach < 12:
            return 0
        wall = np.median(p[-6:], axis=0)
        d_wall = np.linalg.norm(p - wall, axis=1)
        inner = int(0.6 * len(p))
        mould = p[int(np.argmax(d_wall[:inner]))]
        if d_wall[:inner].max() < 20:
            return 0
        d_mould = np.linalg.norm(p - mould, axis=1)
        wallish = d_wall < d_mould
        # First position from which the profile stays wall-like to the end.
        stays = np.flip(np.logical_and.accumulate(np.flip(wallish)))
        idx = np.nonzero(stays)[0]
        if not idx.size or idx[0] >= len(p) - 6:
            return 0
        widths.append(int(idx[0]))
    return int(np.median(widths))


def thin_moulding(frame_bgr: np.ndarray, box: Tuple[int, int, int, int], max_share: float, short_side: int):
    """Cover the inside of a moulding wider than max_share of short_side with the box's edge
    pixels, so only an outer strip of max_share is left. Returns (frame_bgr, box)."""
    width = _moulding_width(frame_bgr, box)
    keep = max(4, int(round(max_share * short_side)))
    cut = width - keep
    if cut < 3:
        return frame_bgr, box
    return _extend_box(frame_bgr, box, {"left": cut, "right": cut, "top": cut, "bottom": cut})


def _mat_widths(lum: np.ndarray, win: Tuple[int, int, int, int]) -> Optional[dict]:
    """Per side, how far the mat runs from the window to the moulding, or None when no clear
    mat-to-moulding step is found on every side."""
    x0, y0, x1, y1 = win
    h, w = lum.shape
    ww, wh = x1 - x0 + 1, y1 - y0 + 1
    reach = int(MAT_REACH * min(ww, wh))
    ym = slice(y0 + wh // 4, y1 - wh // 4)
    xm = slice(x0 + ww // 4, x1 - ww // 4)
    profiles = {
        "left": lum[ym, max(0, x0 - reach) : x0].mean(axis=0)[::-1],
        "right": lum[ym, x1 + 1 : min(w, x1 + 1 + reach)].mean(axis=0),
        "top": lum[max(0, y0 - reach) : y0, xm].mean(axis=1)[::-1],
        "bottom": lum[y1 + 1 : min(h, y1 + 1 + reach), xm].mean(axis=1),
    }
    widths = {}
    for name, p in profiles.items():
        if p.size < 20:
            return None
        p = np.convolve(p, np.ones(3) / 3.0, mode="same")
        # Past the bevel, the mat is flat; the moulding is the first lasting step away from it.
        ref = float(np.median(p[5:15]))
        off = np.abs(p - ref) > MAT_STEP
        found = [i for i in range(15, p.size - 3) if off[i] and off[i + 1] and off[i + 2]]
        if not found:
            return None
        widths[name] = found[0]
    return widths


def narrow_mat(frame_bgr: np.ndarray, quad: np.ndarray, keep_share: float, moulding_max: Optional[float] = None):
    """Run the painting over a matted frame's mat, leaving keep_share of the new window's
    shorter side as mat. The covered window and bevel are repainted from the mat around them
    and smoothed, so scene shading keeps the room's light falloff without the old window's
    outline. Returns (frame_bgr, quad), unchanged when no mat is found."""
    win = _axis_aligned_window(quad)
    if win is None:
        return frame_bgr, quad
    x0, y0, x1, y1 = win
    lum = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mat = _mat_widths(lum, win)
    if mat is None:
        return frame_bgr, quad
    nx0, ny0, nx1, ny1 = x0 - mat["left"], y0 - mat["top"], x1 + mat["right"], y1 + mat["bottom"]
    if moulding_max:
        # The mat spreads over the inside of a thick moulding before it is narrowed.
        short = min(nx1 - nx0 + 1, ny1 - ny0 + 1)
        frame_bgr, (nx0, ny0, nx1, ny1) = thin_moulding(frame_bgr, (nx0, ny0, nx1, ny1), moulding_max, short)
    # A covered mat tucks the painting just under the moulding's lip so no mat line shows.
    keep = int(round(keep_share * min(nx1 - nx0 + 1, ny1 - ny0 + 1))) if keep_share > 0 else -2
    nx0, ny0, nx1, ny1 = nx0 + keep, ny0 + keep, nx1 - keep, ny1 - keep

    pad = 12
    cx0, cy0 = max(0, nx0 - pad), max(0, ny0 - pad)
    cx1, cy1 = min(frame_bgr.shape[1] - 1, nx1 + pad), min(frame_bgr.shape[0] - 1, ny1 + pad)
    crop = frame_bgr[cy0 : cy1 + 1, cx0 : cx1 + 1]
    hole = np.zeros(crop.shape[:2], np.uint8)
    bevel = 6
    hole[
        max(0, y0 - bevel - cy0) : y1 + bevel - cy0 + 1,
        max(0, x0 - bevel - cx0) : x1 + bevel - cx0 + 1,
    ] = 255
    filled = cv2.inpaint(crop, hole, 5, cv2.INPAINT_TELEA).astype(np.float32)
    # Blur within the mat only, so the dark moulding does not bleed into the painting's edge.
    inside = np.zeros(crop.shape[:2], np.float32)
    inside[ny0 - cy0 + 2 : ny1 - cy0 - 1, nx0 - cx0 + 2 : nx1 - cx0 - 1] = 1.0
    weight = cv2.GaussianBlur(inside, (0, 0), 10)[..., None]
    smooth = cv2.GaussianBlur(filled * inside[..., None], (0, 0), 10) / np.maximum(weight, 1e-3)
    smooth = np.clip(smooth, 0, 255).astype(np.uint8)
    out = frame_bgr.copy()
    out[ny0 : ny1 + 1, nx0 : nx1 + 1] = smooth[ny0 - cy0 : ny1 - cy0 + 1, nx0 - cx0 : nx1 - cx0 + 1]
    new_quad = np.array([[nx0 - 1, ny0 - 1], [nx1 + 1, ny0 - 1], [nx1 + 1, ny1 + 1], [nx0 - 1, ny1 + 1]], dtype=np.float32)
    return out, new_quad


def enlarge_frame(frame_bgr: np.ndarray, quad: np.ndarray, target: float = FRAME_GROW_TARGET):
    """Grow a straight-on frame that looks small in its room, keeping its shape and moulding,
    as far as the plain wall around it allows. Returns (frame_bgr, quad) or None."""
    win = _axis_aligned_window(quad)
    if win is None:
        return None
    x0, y0, x1, y1 = win
    canvas_h, canvas_w = frame_bgr.shape[:2]
    lum = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    side, top = _frame_border(lum, win)
    if x0 - side < 0 or y0 - top < 0 or x1 + side >= canvas_w or y1 + top >= canvas_h:
        return None
    bw, bh = x1 - x0 + 1 + 2 * side, y1 - y0 + 1 + 2 * top
    share = max(bw / canvas_w, bh / canvas_h)
    if share >= target:
        return None
    g = min(target / share, 1.0 + FRAME_GROW_MAX) - 1.0
    want = {"x": int(round(bw * g)), "y": int(round(bh * g))}
    m = FRAME_SHADOW_MARGIN

    def axes(img):
        lm = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        box = (max(0, x0 - side - m), max(0, y0 - top - m), min(canvas_w - 1, x1 + side + m), min(canvas_h - 1, y1 + top + m))
        return {
            "y": (img, lm, box, (y0, y1)),
            "x": (img.swapaxes(0, 1), lm.T, (box[1], box[0], box[3], box[2]), (x0, x1)),
        }

    # Grow both axes by the same fraction of what each wants, so the frame keeps its shape.
    a = axes(frame_bgr)
    frac = 1.0
    for axis in ("x", "y"):
        if want[axis] <= 0:
            return None
        split = _frame_split(a[axis][1], a[axis][2], want[axis], True)
        if split is None:
            return None
        frac = min(frac, sum(split) / want[axis])
    if frac * min(want.values()) < 6:
        return None
    img = frame_bgr
    for axis in ("y", "x"):
        a_img, a_lum, a_box, a_win = axes(img)[axis]
        amount = int(round(want[axis] * frac))
        above, below = _frame_split(a_lum, a_box, amount, True)
        out, (n0, n1) = _resize_frame_rows(a_img, a_box, a_win, above, below, False, True)
        img = np.ascontiguousarray(out if axis == "y" else out.swapaxes(0, 1))
        if axis == "y":
            y0, y1 = n0, n1
        else:
            x0, x1 = n0, n1
    new_quad = np.array([[x0 - 1, y0 - 1], [x1 + 1, y0 - 1], [x1 + 1, y1 + 1], [x0 - 1, y1 + 1]], dtype=np.float32)
    return img, new_quad


def _busy(lum: np.ndarray) -> bool:
    """True when the wall strip holds objects (any real edges), not just plaster texture."""
    if lum.shape[0] < 3 or lum.shape[1] < 3:
        return True
    smooth = cv2.GaussianBlur(np.ascontiguousarray(lum), (0, 0), 1.2)
    grad = np.abs(np.diff(smooth, axis=1))[:-1] + np.abs(np.diff(smooth, axis=0))[:, :-1]
    return float((grad > FRAME_WALL_MAX_GRADIENT).mean()) > FRAME_WALL_MAX_EDGES


def adapt_frame_to_painting(
    frame_bgr: np.ndarray, frame_alpha: Optional[np.ndarray], quad: np.ndarray, painting_ar: float
):
    """Reshape a straight-on frame so its window has the painting's aspect ratio.

    The frame block (moulding, mat, window and a shadow margin) is cut or extended through its
    middle, so moulding and mat keep their thickness. A frame grows over plain wall or shrinks
    (the freed wall is filled by mirroring the plain wall beside it). The change is split between
    the two sides by how much plain wall each has. When neither growing nor shrinking alone is
    possible, the frame grows as far as the wall allows and shrinks along the other axis for the
    rest. Returns (frame_bgr, frame_alpha, quad) or None when nothing could be changed."""
    win = _axis_aligned_window(quad)
    if win is None or painting_ar <= 0:
        return None
    x0, y0, x1, y1 = win
    if x1 - x0 < 19 or y1 - y0 < 19:
        return None
    tolerance = np.log(1.0 + PAINTING_MAX_CROP)
    if abs(np.log(painting_ar * (y1 - y0 + 1) / (x1 - x0 + 1))) <= tolerance:
        return None

    canvas_h, canvas_w = frame_bgr.shape[:2]
    lum0 = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if frame_alpha is not None:
        lum0 = np.where(frame_alpha < 128, 255.0, lum0)
    side, top = _frame_border(lum0, win)
    if x0 - side < 0 or y0 - top < 0 or x1 + side >= canvas_w or y1 + top >= canvas_h:
        return None
    check = frame_alpha is None
    img = frame_bgr if frame_alpha is None else np.dstack([frame_bgr, frame_alpha])
    m = FRAME_SHADOW_MARGIN
    changed = False

    for _ in range(2):
        w, h = x1 - x0 + 1, y1 - y0 + 1
        window_ar = w / h
        if abs(np.log(painting_ar / window_ar)) <= tolerance:
            break
        lum = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
        if frame_alpha is not None:
            lum = np.where(img[:, :, 3] < 128, 255.0, lum)
        box = (max(0, x0 - side - m), max(0, y0 - top - m), min(canvas_w - 1, x1 + side + m), min(canvas_h - 1, y1 + top + m))
        # Each axis is handled as rows; columns work on the transposed image.
        axes = {
            "y": (img, lum, box, (y0, y1), h),
            "x": (img.swapaxes(0, 1), lum.T, (box[1], box[0], box[3], box[2]), (x0, x1), w),
        }
        if painting_ar < window_ar:
            plans = [("y", int(round(w / painting_ar - h))), ("x", -int(round(w - h * painting_ar)))]
        else:
            plans = [("x", int(round(h * painting_ar - w))), ("y", -int(round(h - w / painting_ar)))]

        best = None
        for axis, change in plans:
            a_img, a_lum, a_box, a_win, span = axes[axis]
            change = int(np.sign(change)) * min(abs(change), int(span * FRAME_ADAPT_MAX))
            if change == 0:
                continue
            split = _frame_split(a_lum, a_box, change, check)
            if split is None:
                continue
            above, below = split
            done = above + below
            if best is None or done > best[3]:
                best = (axis, change, (above, below), done)
            if done == abs(change):
                break
        if best is None or best[3] < 2:
            break
        axis, change, (above, below), _ = best
        a_img, a_lum, a_box, a_win, _ = axes[axis]
        out, (n0, n1) = _resize_frame_rows(a_img, a_box, a_win, above, below, change < 0, check)
        img = out if axis == "y" else out.swapaxes(0, 1)
        if axis == "x":
            x0, x1 = n0, n1
        else:
            y0, y1 = n0, n1
        changed = True

    if not changed:
        return None
    new_quad = np.array([[x0 - 1, y0 - 1], [x1 + 1, y0 - 1], [x1 + 1, y1 + 1], [x0 - 1, y1 + 1]], dtype=np.float32)
    img = np.ascontiguousarray(img)
    if frame_alpha is None:
        return img, None, new_quad
    return img[:, :, :3].copy(), img[:, :, 3].copy(), new_quad


def _plain_reach(lum, cols, start, step, limit):
    """How many rows from `start` (going up when step < 0) stay plain wall, up to `limit`."""
    height = lum.shape[0]
    room = start if step < 0 else height - start
    limit = min(limit, room)
    reach = 0
    for n in list(range(4, limit, 4)) + [limit]:
        a, b = (start - n, start) if step < 0 else (start, start + n)
        if n <= 0 or _busy(lum[a:b, cols]):
            break
        reach = n
    return reach


def _frame_split(lum, box, change, check_wall):
    """Rows (above, below) a frame block can grow or shrink by, at most |change| in total.

    Growing covers wall beyond the block; shrinking refills the freed rows (plus the faded
    margin) from the wall beyond the block. Either way that wall has to be plain. The split stays
    as even as the wall allows."""
    c0, r0, c1, r1 = box
    amount = abs(change)
    m = FRAME_SHADOW_MARGIN if change < 0 else 0
    if not check_wall:
        if change > 0 and (r0 - amount // 2 < 0 or r1 + amount - amount // 2 >= lum.shape[0]):
            return None
        return amount // 2, amount - amount // 2
    # Objects in the outer blend margin stay mostly visible, so only the frame's own width
    # plus a little shadow has to be plain wall.
    inset = max(0, FRAME_SHADOW_MARGIN - 8)
    cols = slice(c0 + inset, c1 + 1 - inset)
    up = max(0, _plain_reach(lum, cols, r0, -1, amount + m) - m)
    down = max(0, _plain_reach(lum, cols, r1 + 1, 1, amount + m) - m)
    above = int(np.clip(amount // 2, amount - down, up))
    below = min(down, amount - above)
    return above, below


def _wall_fill(mirrored: np.ndarray, original: np.ndarray) -> np.ndarray:
    """Wall rows mirrored from beyond a shrunk frame, shaded to match the wall on either side
    of them (the outer columns of `original`, the frame's shadow margin) and faded into it."""
    fill = mirrored.astype(np.float32)
    orig = original.astype(np.float32)
    n, k = fill.shape[:2]
    edge = 8
    if k <= 4 * edge or n < 2:
        return mirrored
    sigma = 4.0
    d_left = cv2.GaussianBlur((orig[:, :edge] - fill[:, :edge]).mean(axis=1, keepdims=True), (1, 0), sigma)
    d_right = cv2.GaussianBlur((orig[:, -edge:] - fill[:, -edge:]).mean(axis=1, keepdims=True), (1, 0), sigma)
    t = np.linspace(0.0, 1.0, k, dtype=np.float32)[None, :]
    if fill.ndim == 3:
        t = t[..., None]
    fill += d_left * (1.0 - t) + d_right * t
    ramp = np.linspace(0.0, 1.0, FRAME_SHADOW_MARGIN + 2, dtype=np.float32)[1:-1]
    wc = np.ones(k, np.float32)
    wc[: ramp.size] = ramp
    wc[k - ramp.size :] = ramp[::-1]
    wc = wc[None, :, None] if fill.ndim == 3 else wc[None, :]
    return np.clip(fill * wc + orig * (1.0 - wc), 0, 255).astype(mirrored.dtype)


def _resize_frame_rows(img, box, window_rows, above, below, shrink, fill_from_wall):
    """Change a frame block's height by moving its top edge `above` rows and its bottom edge
    `below` rows (outwards when growing, inwards when shrinking).

    box is (left, top, right, bottom) of the block, window_rows the window's (top, bottom).
    Returns (image, (new window top, new window bottom))."""
    c0, r0, c1, r1 = box
    w0, w1 = window_rows
    amount = above + below
    change = -amount if shrink else amount
    wall_cols = slice(c0, c1 + 1)
    # A shrinking block's faded margin lands on rows that held the old frame, so the wall fill
    # reaches that far too.
    m = FRAME_SHADOW_MARGIN
    out = img.copy()
    block = img[r0 : r1 + 1, wall_cols]
    centre = (w0 + w1) // 2 - r0
    if shrink:
        cut = centre - amount // 2
        block = np.concatenate([block[:cut], block[cut + amount :]], axis=0)
        fill_above = above + m if above else 0
        fill_below = below + m if below else 0
        if not fill_from_wall:
            out[r0 : r0 + fill_above, wall_cols] = 0
            out[r1 + 1 - fill_below : r1 + 1, wall_cols] = 0
        else:
            if fill_above:
                out[r0 : r0 + fill_above, wall_cols] = _wall_fill(
                    img[r0 - fill_above : r0, wall_cols][::-1], img[r0 : r0 + fill_above, wall_cols]
                )
            if fill_below:
                out[r1 + 1 - fill_below : r1 + 1, wall_cols] = _wall_fill(
                    img[r1 + 1 : r1 + 1 + fill_below, wall_cols][::-1], img[r1 + 1 - fill_below : r1 + 1, wall_cols]
                )
        top = r0 + above
    else:
        span = max(1, min(amount, (w1 - w0) // 2))
        band = block[centre - span // 2 : centre - span // 2 + span]
        filler = np.concatenate([band] * (amount // span + 1), axis=0)[:amount]
        block = np.concatenate([block[:centre], filler, block[centre:]], axis=0)
        top = r0 - above
    # The block's wall margin fades into the wall at its new place, so lighting differences
    # along the wall leave no visible edge.
    n, k = block.shape[:2]
    ramp = np.linspace(0.0, 1.0, FRAME_SHADOW_MARGIN + 2, dtype=np.float32)[1:-1]
    wr = np.ones(n, np.float32)
    wr[: ramp.size] = ramp
    wr[n - ramp.size :] = ramp[::-1]
    wc = np.ones(k, np.float32)
    wc[: ramp.size] = ramp
    wc[k - ramp.size :] = ramp[::-1]
    weight = np.minimum(wr[:, None], wc[None, :])
    if block.ndim == 3:
        weight = weight[..., None]
    dest = out[top : top + n, wall_cols].astype(np.float32)
    out[top : top + n, wall_cols] = (block.astype(np.float32) * weight + dest * (1.0 - weight)).astype(img.dtype)
    new_top = w0 - r0 + top
    new_bottom = new_top + (w1 - w0 + 1) + change - 1
    return out, (new_top, new_bottom)


def rework_room(frame_bgr: np.ndarray, quad: np.ndarray, meta: dict):
    """Mat, edge, moulding and size changes a room's meta asks for. None of them depend on the
    painting, so scripts/frames/bake_rooms.py writes them into the room image once and marks the
    room meta.baked. Returns (frame_bgr, quad, changed)."""
    changed = False
    # The temple's surround is not a moulding, and canvases have none.
    moulding_max = None if (meta.get("godOnly") or meta.get("canvas")) else (MOULDING_MAX or meta.get("mouldingMax"))
    if meta.get("mat") in ("thin", "cover"):
        keep = MAT_THIN_SHARE if meta.get("mat") == "thin" else 0.0
        frame_bgr, quad = narrow_mat(frame_bgr, quad, keep, moulding_max)
        changed = True
    # Window edges are settled before the frame is reshaped to the painting, so the final
    # window has the painting's shape.
    if meta.get("canvas") or meta.get("edgeToEdge"):
        frame_bgr, quad = expand_to_edge(frame_bgr, quad)
        win = _axis_aligned_window(quad)
        if moulding_max and meta.get("edgeToEdge") and win is not None:
            short = min(win[2] - win[0] + 1, win[3] - win[1] + 1)
            frame_bgr, box = thin_moulding(frame_bgr, win, moulding_max, short)
            quad = _quad_for_box(box)
        changed = True
    if meta.get("grow"):
        grown = enlarge_frame(frame_bgr, quad)
        if grown is not None:
            frame_bgr, quad = grown
            changed = True
    return frame_bgr, quad, changed


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
    is_base: bool = False,
) -> dict:
    mat_ratio = 0.0 if is_base else ROOM_MAT_RATIO
    max_crop = PAINTING_MAX_CROP if is_base else ROOM_MAX_CROP
    # painting_crop may be supplied already read (once per product); otherwise read it here.
    # The painting file is used whole: its own margins are part of the artwork.
    if painting_crop is None:
        painting_crop = cv2.imread(painting_path, cv2.IMREAD_COLOR)
        if painting_crop is None:
            raise ValueError(f"Could not read painting: {painting_path}")

    frame_bgr, frame_alpha = _read_frame_with_alpha(frame_path)
    if frame_bgr is None:
        raise ValueError(f"Could not read frame: {frame_path}")

    frame_resized = _ensure_canvas(frame_bgr, canvas_size)
    frame_alpha = _resize_alpha(frame_alpha, canvas_size)
    stored_quad = stored_quad_for(orientation, frame_template, canvas_size, frame_set=frame_set)
    meta = room_meta(orientation, frame_template, frame_set)
    reworked = False
    if stored_quad is not None and frame_alpha is None and not is_base and not meta.get("baked"):
        frame_resized, stored_quad, reworked = rework_room(frame_resized, stored_quad, meta)
    adapted = None
    if FRAME_ADAPT and stored_quad is not None:
        ph, pw = painting_crop.shape[:2]
        adapted = adapt_frame_to_painting(frame_resized, frame_alpha, stored_quad, pw / max(ph, 1))
    if adapted is not None:
        frame_resized, frame_alpha, stored_quad = adapted
    if adapted is not None or reworked:
        alpha_quad = None
    else:
        alpha_quad = _quad_from_alpha(frame_alpha, canvas_size) if frame_alpha is not None else None
    if alpha_quad is not None:
        hole = (frame_alpha < 16).astype(np.uint8) * 255
        warped, geom_mask = fit_painting_to_quad(painting_crop, alpha_quad, mat_ratio, max_crop)
        region_mask = cv2.bitwise_and(hole, cv2.bitwise_and(geom_mask, _mask_from_quad(alpha_quad, canvas_size)))
    elif stored_quad is not None:
        quad = stored_quad
        warped, geom_mask = fit_painting_to_quad(painting_crop, quad, mat_ratio, max_crop)
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
        warped, geom_mask = fit_painting_to_quad(painting_crop, quad, mat_ratio)
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
        debug_quad = alpha_quad if alpha_quad is not None else (stored_quad if stored_quad is not None else quad)
        _write_compositor_debug(frame_resized, debug_quad, output_path, region_mask, canvas_size)

    _save_composite(
        result,
        output_path,
        jpeg_quality,
        alpha=frame_alpha if output_path.lower().endswith(".png") else None,
        region_mask=region_mask if output_path.lower().endswith(".png") else None,
    )
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

    # Read the painting once and reuse it across all frames for this product.
    painting_crop = cv2.imread(painting_path, cv2.IMREAD_COLOR)
    if painting_crop is None:
        return {
            "images": [],
            "totalBytes": 0,
            "errors": [{"message": f"Could not read painting: {painting_path}"}],
        }

    for entry in frame_entries:
        frame_path = entry.get("framePath") or entry.get("frame_path")
        output_index = entry.get("outputIndex", entry.get("output_index"))
        if output_index is None:
            output_index = 0
        frame_name = entry.get("frameTemplate") or entry.get("frame_template") or os.path.basename(frame_path or "")
        orientation = entry.get("orientation")
        frame_set = entry.get("frameSet") or entry.get("frame_set")
        room = entry.get("room")
        frame_colour = entry.get("frameColour") or entry.get("frame_colour")
        output_suffix = entry.get("outputSuffix") or entry.get("output_suffix")
        if not output_suffix and frame_colour:
            output_suffix = str(frame_colour).strip().lower()
        is_base = bool(entry.get("isBase") or entry.get("is_base"))
        ext = ".png" if is_base else ".jpg"
        if output_suffix:
            filename = f"{output_base_name}_{output_index}_{output_suffix}{ext}"
        else:
            filename = f"{output_base_name}_{output_index}{ext}"
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
                is_base=is_base,
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
            if frame_colour:
                image_record["frameColour"] = frame_colour
            images.append(image_record)
        except Exception as exc:  # noqa: BLE001
            errors.append({"frameTemplate": frame_name, "message": str(exc)})

    return {"images": images, "totalBytes": total_bytes, "errors": errors}
