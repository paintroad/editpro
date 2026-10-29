"""Correct a generated room template so its frame window has the exact painting shape.

The frame must hang straight-on against a plain wall. The script finds the grey window,
finds the outer edge of the frame (moulding + mat), stretches only that block so the window
is exactly 3:4, 4:3 or 1:1 (frames further off keep their shape; the compositor reshapes each
frame to its painting), repaints the window as a flat placeholder and writes the result
at 1080x1080. Prints JSON with the window quad (normalised, +1 px) for frame-quads.json.

    python scripts/frames/fit_frame.py <portrait|landscape|square> <input> <output.jpg>
"""
import json
import sys

import cv2
import numpy as np

CANVAS = 1080
TARGET = {"portrait": 3 / 4, "landscape": 4 / 3, "square": 1.0}
PLACEHOLDER_BGR = (216, 219, 215)  # #D7DBD8
MAX_CORRECTION = 0.15
MAX_SAT = 34
MIN_LUM, MAX_LUM = 150, 248
MAX_GRAD = 6
EDGE_STEP = 9
EDGE_REACH = 0.3
SHADOW_MARGIN = 10
FEATHER = 6


def find_window(img):
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    # Blur first so a stretched canvas's weave texture still reads as flat.
    lum = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 2.0)
    gx = np.abs(np.roll(lum, -1, 1) - np.roll(lum, 1, 1))
    gy = np.abs(np.roll(lum, -1, 0) - np.roll(lum, 1, 0))
    mask = ((sat <= MAX_SAT) & (lum >= MIN_LUM) & (lum <= MAX_LUM) & (gx + gy <= MAX_GRAD)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
    best = None
    for i in range(1, count):
        x, y, w, h, n = stats[i]
        if n < CANVAS * CANVAS * 0.01 or n / float(w * h) < 0.9:
            continue
        if best is None or n > best[4]:
            best = (x, y, w, h, n)
    if best is None:
        raise ValueError("no grey window found")
    x, y, w, h, _ = best
    return x, y, x + w - 1, y + h - 1


def last_edge(profile):
    """Distance from the window to the outermost sharp brightness change (frame edge or shadow)."""
    p = np.convolve(profile, np.ones(3) / 3.0, mode="same")
    edges = [k for k in range(3, len(p) - 3) if abs(p[k + 2] - p[k - 2]) > EDGE_STEP]
    return (max(edges) + 3) if edges else 0


def outer_frame(img, win):
    x0, y0, x1, y1 = win
    w, h = x1 - x0 + 1, y1 - y0 + 1
    lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    reach_x = int(w * EDGE_REACH)
    reach_y = int(h * EDGE_REACH)
    rows = [y0 + int(h * f) for f in (0.3, 0.5, 0.7)]
    cols = [x0 + int(w * f) for f in (0.3, 0.5, 0.7)]
    sides = []
    for y in rows:
        sides.append(last_edge(lum[y, max(0, x0 - reach_x) : x0][::-1]))
        sides.append(last_edge(lum[y, x1 + 1 : min(CANVAS, x1 + 1 + reach_x)]))
    tops = [last_edge(lum[max(0, y0 - reach_y) : y0, x][::-1]) for x in cols]
    side = int(np.median(sides))
    top_thick = int(np.median(tops))
    # Mouldings are even all round; a very different top reading is a lamp or shelf above.
    if abs(top_thick - side) > 0.5 * side:
        top_thick = side
    return x0 - side, y0 - top_thick, x1 + side, y1 + top_thick, side, top_thick


def main():
    orientation, src, dst = sys.argv[1:4]
    target = TARGET[orientation]
    img = cv2.imread(src, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {src}")
    img = cv2.resize(img, (CANVAS, CANVAS), interpolation=cv2.INTER_AREA)

    win = find_window(img)
    x0, y0, x1, y1 = win
    w, h = x1 - x0 + 1, y1 - y0 + 1
    aspect = w / h
    sx, sy = 1.0, 1.0
    if aspect < target:
        sx = target * h / w
    else:
        sy = (w / target) / h
    correction = max(sx, sy) - 1.0
    if correction > MAX_CORRECTION:
        # Too far to stretch without distorting the moulding; keep the frame's own shape.
        # The compositor reshapes the frame to each painting anyway.
        sx, sy, correction = 1.0, 1.0, 0.0

    ox0, oy0, ox1, oy1, side, top = outer_frame(img, win)
    ox0, oy0 = max(0, ox0 - SHADOW_MARGIN), max(0, oy0 - SHADOW_MARGIN)
    ox1, oy1 = min(CANVAS - 1, ox1 + SHADOW_MARGIN), min(CANVAS - 1, oy1 + SHADOW_MARGIN)
    block = img[oy0 : oy1 + 1, ox0 : ox1 + 1]
    bw, bh = block.shape[1], block.shape[0]
    nw, nh = int(round(bw * sx)), int(round(bh * sy))
    stretched = cv2.resize(block, (nw, nh), interpolation=cv2.INTER_CUBIC)

    cx, cy = (ox0 + ox1) / 2.0, (oy0 + oy1) / 2.0
    px0, py0 = int(round(cx - nw / 2.0)), int(round(cy - nh / 2.0))
    if px0 < 0 or py0 < 0 or px0 + nw > CANVAS or py0 + nh > CANVAS:
        print(json.dumps({"pass": False, "reason": "stretched frame leaves the canvas"}))
        return

    alpha = np.ones((nh, nw), np.float32)
    for i in range(FEATHER):
        v = (i + 1) / (FEATHER + 1)
        alpha[i, :] = np.minimum(alpha[i, :], v)
        alpha[nh - 1 - i, :] = np.minimum(alpha[nh - 1 - i, :], v)
        alpha[:, i] = np.minimum(alpha[:, i], v)
        alpha[:, nw - 1 - i] = np.minimum(alpha[:, nw - 1 - i], v)
    region = img[py0 : py0 + nh, px0 : px0 + nw].astype(np.float32)
    img[py0 : py0 + nh, px0 : px0 + nw] = (
        stretched.astype(np.float32) * alpha[..., None] + region * (1 - alpha[..., None])
    ).astype(np.uint8)

    # New window position: window centre stays put relative to the block centre.
    wcx = px0 + ((x0 + x1) / 2.0 - ox0) * sx
    wcy = py0 + ((y0 + y1) / 2.0 - oy0) * sy
    nwin_w, nwin_h = w * sx, h * sy
    wx0, wy0 = int(round(wcx - nwin_w / 2.0)), int(round(wcy - nwin_h / 2.0))
    wx1, wy1 = int(round(wcx + nwin_w / 2.0)) - 1, int(round(wcy + nwin_h / 2.0)) - 1
    img[wy0 : wy1 + 1, wx0 : wx1 + 1] = PLACEHOLDER_BGR
    cv2.imwrite(dst, img, [cv2.IMWRITE_JPEG_QUALITY, 95])

    l, t, r, b = (wx0 - 1) / CANVAS, (wy0 - 1) / CANVAS, (wx1 + 1) / CANVAS, (wy1 + 1) / CANVAS
    fw, fh = wx1 - wx0 + 1, wy1 - wy0 + 1
    print(
        json.dumps(
            {
                "pass": True,
                "before": round(aspect, 4),
                "after": round(fw / fh, 4),
                "stretchPct": round(correction * 100, 1),
                "frameSide": int(side),
                "frameTop": int(top),
                "window": [wx0, wy0, wx1, wy1],
                "quad": [[round(l, 6), round(t, 6)], [round(r, 6), round(t, 6)], [round(r, 6), round(b, 6)], [round(l, 6), round(b, 6)]],
            }
        )
    )


if __name__ == "__main__":
    main()
