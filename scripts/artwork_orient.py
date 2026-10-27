"""Orientation crop for extracted artwork that is not 4:3 / 3:4 / square: cuts the image to the
nearest of those shapes (whichever removes least), placing the window so the removed strips are
the emptiest part of the picture (plain sky, paper, background)."""

import cv2
import numpy as np

import artwork_trim

ANALYSE_MAX = 800
MAX_CUT = 0.25
EMPTY_RATIO = 0.6


def target_size(w, h):
    """(w, h) of the largest 4:3 / 3:4 / square window that removes the least area."""
    long_side, short_side = max(w, h), min(w, h)
    if long_side / short_side > 4 / 3:
        r43 = (short_side * 4 / 3, short_side)
    else:
        r43 = (long_side, long_side * 3 / 4)
    sq = (short_side, short_side)
    best = max((r43, sq), key=lambda s: s[0] * s[1])
    tw, th = (best if w >= h else (best[1], best[0]))
    return int(round(min(w, tw))), int(round(min(h, th)))


def energy_profile(arr, axis):
    """Detail per line along `axis` (0 = rows, 1 = columns) on a small grey copy."""
    h, w = arr.shape[:2]
    scale = min(1.0, ANALYSE_MAX / max(h, w))
    small = cv2.resize(arr, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    grey = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32)
    grey = cv2.GaussianBlur(grey, (3, 3), 0)
    mag = np.hypot(cv2.Sobel(grey, cv2.CV_32F, 1, 0), cv2.Sobel(grey, cv2.CV_32F, 0, 1))
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB).astype(np.float32)
    ref = np.median(lab.reshape(-1, 3), axis=0)
    colour = np.linalg.norm(lab - ref, axis=2)
    detail = mag + 0.5 * colour
    profile = detail.mean(axis=1 if axis == 0 else 0)
    return profile, scale


def plan(arr, size=None):
    """Returns dict(rect, cut, score, axis) or None when the image already fits. `arr` may be a
    reduced copy; `size` is the (w, h) of the full image the rect is returned for."""
    w, h = size or (arr.shape[1], arr.shape[0])
    tw, th = target_size(w, h)
    if tw == w and th == h:
        return None
    axis = 0 if th < h else 1
    full = h if axis == 0 else w
    keep = th if axis == 0 else tw
    profile, scale = energy_profile(arr, axis)
    n = len(profile)
    k = max(1, int(round(keep * n / full)))
    csum = np.concatenate([[0], np.cumsum(profile)])
    windows = csum[k:] - csum[:-k]
    start_small = int(np.argmax(windows))
    kept_mean = windows[start_small] / k
    removed = csum[-1] - windows[start_small]
    removed_mean = removed / max(1, n - k)
    score = float(removed_mean / max(kept_mean, 1e-6))
    start = int(round(start_small * full / n))
    start = max(0, min(full - keep, start))
    rect = (0, start, w, start + keep) if axis == 0 else (start, 0, start + keep, h)
    return {"rect": rect, "cut": 1 - keep / full, "score": score, "axis": "rows" if axis == 0 else "cols"}


TECHNIQUES = ("auto", "bottom", "pad", "even")
RING = 0.02
PAD_RING = 0.006
PAD_TRIM_MIN = 0.02
PAD_WHITE = 232
GRAIN_MAX = 8
CONTENT_DIFF = 28
CONTENT_LINE = 0.01


def target_ratio(w, h):
    tw, th = target_size(w, h)
    return tw / th


def _strips(arr, ring):
    h, w = arr.shape[:2]
    ry, rx = max(2, int(h * ring)), max(2, int(w * ring))
    return {"top": arr[:ry], "bottom": arr[-ry:], "left": arr[:, :rx], "right": arr[:, -rx:]}


def side_colours(arr, ring=RING):
    """Median colour of the outer ring on each side (RGB tuples)."""
    return {side: tuple(int(v) for v in np.median(s.reshape(-1, 3), axis=0)) for side, s in _strips(arr, ring).items()}


def side_grain(arr, ring=PAD_RING):
    """Texture strength (std, capped) of the outer ring on each side, used to grain the padding."""
    return {side: float(min(GRAIN_MAX, s.reshape(-1, 3).std(axis=0).mean())) for side, s in _strips(arr, ring).items()}


def mat_trim(arr):
    """Rect (on `arr`) without leftover white mat bands that are at least PAD_TRIM_MIN deep."""
    h, w = arr.shape[:2]
    # Start a little way in so a scan shadow along the very edge doesn't block the trim.
    iy, ix = int(h * 0.015), int(w * 0.015)
    rect, _ = artwork_trim.trim_rect(arr[iy:h - iy, ix:w - ix], light_min=PAD_WHITE)
    x0, y0, x1, y1 = rect[0] + ix, rect[1] + iy, rect[2] + ix, rect[3] + iy
    x0, y0 = (0 if x0 == ix else x0), (0 if y0 == iy else y0)
    x1, y1 = (w if x1 == w - ix else x1), (h if y1 == h - iy else y1)
    x0 = x0 if x0 >= w * PAD_TRIM_MIN else 0
    x1 = x1 if w - x1 >= w * PAD_TRIM_MIN else w
    y0 = y0 if y0 >= h * PAD_TRIM_MIN else 0
    y1 = y1 if h - y1 >= h * PAD_TRIM_MIN else h
    return x0, y0, x1, y1


def content_box(arr):
    """Bounding box (on `arr`) of everything that differs from the border background colour."""
    h, w = arr.shape[:2]
    colours = side_colours(arr)
    bg = np.median(np.array(list(colours.values())), axis=0)
    diff = np.abs(arr.astype(np.int16) - bg).max(axis=2) > CONTENT_DIFF
    diff = cv2.morphologyEx(diff.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    rows = np.where(diff.mean(axis=1) > CONTENT_LINE)[0]
    cols = np.where(diff.mean(axis=0) > CONTENT_LINE)[0]
    if not len(rows) or not len(cols):
        return (0, 0, w, h)
    return (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)


def pad_size(w, h):
    """Smallest 4:3 / 3:4 / square canvas (same orientation) that holds a w x h image."""
    long_side, short_side = max(w, h), min(w, h)
    if long_side / short_side > 4 / 3:
        options = [(long_side, long_side * 3 / 4)]
    else:
        options = [(short_side * 4 / 3, short_side), (long_side, long_side)]
    best = min(options, key=lambda s: s[0] * s[1])
    pw, ph = best if w >= h else (best[1], best[0])
    return max(w, int(round(pw))), max(h, int(round(ph)))


def window(arr, size, technique):
    """Output window for `technique` in full-image coordinates; may extend past the image (padding).
    Returns dict(rect, fills, cut, score) or None when the image already fits."""
    w, h = size
    sh, sw = arr.shape[:2]
    sx, sy = w / sw, h / sh
    tw, th = target_size(w, h)
    if tw == w and th == h:
        return None
    fills = side_colours(arr)
    if technique == "auto":
        p = plan(arr, size)
        return {**p, "fills": fills}
    if technique == "bottom":
        if th < h:
            rect = (0, 0, w, th)
        else:
            x0 = (w - tw) // 2
            rect = (x0, 0, x0 + tw, h)
        return {"rect": rect, "fills": fills, "cut": 1 - (tw * th) / (w * h), "score": None}
    if technique == "pad":
        tx0, ty0, tx1, ty1 = mat_trim(arr)
        inner = arr[ty0:ty1, tx0:tx1]
        fx0, fy0 = int(round(tx0 * sx)), int(round(ty0 * sy))
        fx1 = w if tx1 == sw else int(round(tx1 * sx))
        fy1 = h if ty1 == sh else int(round(ty1 * sy))
        iw, ih = fx1 - fx0, fy1 - fy0
        pw, ph = pad_size(iw, ih)
        x0, y0 = fx0 - (pw - iw) // 2, fy0 - (ph - ih) // 2
        return {"rect": (x0, y0, x0 + pw, y0 + ph), "inner": (fx0, fy0, fx1, fy1),
                "fills": side_colours(inner, PAD_RING), "grain": side_grain(inner), "cut": 0.0, "score": None}
    if technique == "even":
        bx0, by0, bx1, by1 = content_box(arr)
        bx0, bx1, by0, by1 = bx0 * sx, bx1 * sx, by0 * sy, by1 * sy
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        ratio = target_ratio(w, h)
        half_w, half_h = min(cx, w - cx), min(cy, h - cy)
        if half_w / half_h > ratio:
            half_w = half_h * ratio
        else:
            half_h = half_w / ratio
        need_w, need_h = (bx1 - bx0) / 2, (by1 - by0) / 2
        if half_w < need_w or half_h < need_h:
            scale = max(need_w / half_w, need_h / half_h)
            half_w, half_h = half_w * scale, half_h * scale
        rect = tuple(int(round(v)) for v in (cx - half_w, cy - half_h, cx + half_w, cy + half_h))
        kept = max(0, min(rect[2], w) - max(rect[0], 0)) * max(0, min(rect[3], h) - max(rect[1], 0))
        return {"rect": rect, "fills": fills, "cut": 1 - kept / (w * h), "score": None}
    raise ValueError(f"unknown technique {technique}")


def render(im, rect, fills, inner=None, grain=None):
    """Crop `im` to `rect`; any part of `rect` outside `inner` (default: the whole image) is filled
    with the nearest side's colour, lightly grained to match the edge texture."""
    from PIL import Image

    if inner and inner != (0, 0) + im.size:
        im = im.crop(inner)
        rect = (rect[0] - inner[0], rect[1] - inner[1], rect[2] - inner[0], rect[3] - inner[1])
    x0, y0, x1, y1 = rect
    w, h = im.size
    if x0 >= 0 and y0 >= 0 and x1 <= w and y1 <= h:
        return im.crop(rect)
    mode = "RGBA" if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info) else "RGB"
    src = im.convert(mode)
    alpha = (255,) if mode == "RGBA" else ()
    avg = tuple(int(np.mean([c[i] for c in fills.values()])) for i in range(3)) + alpha
    canvas = Image.new(mode, (x1 - x0, y1 - y0), avg)
    cw, ch = canvas.size
    ox, oy = -x0, -y0
    if oy > 0:
        canvas.paste(fills["top"] + alpha, (0, 0, cw, oy))
    if oy + h < ch:
        canvas.paste(fills["bottom"] + alpha, (0, oy + h, cw, ch))
    if ox > 0:
        canvas.paste(fills["left"] + alpha, (0, 0, ox, ch))
    if ox + w < cw:
        canvas.paste(fills["right"] + alpha, (ox + w, 0, cw, ch))
    if grain and max(grain.values()) > 0.5:
        rng = np.random.default_rng(7)
        bands = [("top", (0, 0, cw, oy)), ("bottom", (0, oy + h, cw, ch)),
                 ("left", (0, 0, ox, ch)), ("right", (ox + w, 0, cw, ch))]
        for side, box in bands:
            if box[2] <= box[0] or box[3] <= box[1] or grain[side] <= 0.5:
                continue
            band = np.asarray(canvas.crop(box)).astype(np.float32)
            noise = rng.standard_normal(band.shape[:2] + (1,)).astype(np.float32) * grain[side]
            band[..., :3] = np.clip(band[..., :3] + noise, 0, 255)
            canvas.paste(Image.fromarray(band.astype(np.uint8), mode), box[:2])
    part = src.crop((max(0, x0), max(0, y0), min(w, x1), min(h, y1)))
    canvas.paste(part, (max(0, ox), max(0, oy)))
    return canvas


def reject_reason(p):
    """None when the crop only removes empty space; otherwise why it was left for a manual crop."""
    if p["cut"] > MAX_CUT:
        return f"needs {p['cut']:.0%} cut (over {MAX_CUT:.0%})"
    if p["score"] > EMPTY_RATIO:
        return f"crop would cut into the artwork (detail {p['score']:.2f})"
    return None
