"""Give a straight-on room frame a slight perspective tilt, as in a photo taken a little from the side.

    py -3 skew_room.py "<set>" "<room file>" <left/right height ratio> [<top share>]

The ratio is the frame's left edge height over its right edge height (1.06 = left edge 6% taller,
so the wall recedes to the right). Top share is how much of the height difference is taken at the
top edge (default 0.6; the rest at the bottom). The room's mat, edge, moulding, size and scale
changes are applied first, the frame block (moulding plus a little shadow) is warped and the wall
it no longer covers is repainted from the plain wall round it. The image, its quad and meta.baked
are written back; run keep_before.js first.
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lifestyle_compositor import (  # noqa: E402
    CANVAS_SIZE,
    FRAME_QUADS_PATH,
    SHRINK_MARGIN,
    SHRINK_RING,
    _axis_aligned_window,
    _ensure_canvas,
    _frame_border,
    _wall_model,
    order_points,
    rework_room,
)

SETS = os.path.join(os.path.expanduser("~"), "Downloads", "_Frames", "_New Lifestyle Sets")


def skew(frame_bgr, quad, ratio, top_share):
    win = _axis_aligned_window(quad)
    if win is None:
        raise ValueError("frame is not straight-on")
    x0, y0, x1, y1 = win
    h, w = frame_bgr.shape[:2]
    lum = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    side, top = _frame_border(lum, win)
    # On a busy wall (wood planks) the border search runs past the moulding.
    cap = int(0.08 * min(x1 - x0, y1 - y0))
    side, top = min(side, cap), min(top, cap)
    # The shadow margin shrinks for a frame close to the image edge.
    m = min(SHRINK_MARGIN, x0 - side - 1, y0 - top - 1, w - 2 - x1 - side, h - 2 - y1 - top)
    if m < 4:
        raise ValueError("frame too close to the image edge")
    bx0, by0, bx1, by1 = x0 - side - m, y0 - top - m, x1 + side + m, y1 + top + m
    wall = _wall_model(frame_bgr, (bx0, by0, bx1, by1), SHRINK_RING)
    if wall is None:
        raise ValueError("too little plain wall round the frame")
    src = frame_bgr.copy()
    src[by0 : by1 + 1, bx0 : bx1 + 1] = np.clip(wall, 0, 255).astype(frame_bgr.dtype)
    mask = np.zeros((h, w), np.uint8)
    mask[by0 : by1 + 1, bx0 : bx1 + 1] = 255
    base = cv2.seamlessClone(src, frame_bgr, mask, ((bx0 + bx1) // 2, (by0 + by1) // 2), cv2.NORMAL_CLONE)

    # The taller edge keeps its height; the other shrinks, split between top and bottom.
    rect = np.array([[x0 - 1, y0 - 1], [x1 + 1, y0 - 1], [x1 + 1, y1 + 1], [x0 - 1, y1 + 1]], np.float32)
    height = (y1 + 1) - (y0 - 1)
    cut = height * (1 - min(ratio, 1 / ratio))
    dt, db = cut * top_share, cut * (1 - top_share)
    target = rect.copy()
    short = (1, 2) if ratio >= 1 else (0, 3)
    target[short[0], 1] += dt
    target[short[1], 1] -= db
    hmat = cv2.getPerspectiveTransform(rect, target)
    warped = cv2.warpPerspective(frame_bgr, hmat, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    # The block's own shadow margin fades into the repainted wall.
    rr = np.zeros((h, w), np.float32)
    bh, bw = by1 - by0 + 1, bx1 - bx0 + 1
    dist = np.minimum.outer(np.minimum(np.arange(bh), np.arange(bh)[::-1]), np.minimum(np.arange(bw), np.arange(bw)[::-1]))
    rr[by0 : by1 + 1, bx0 : bx1 + 1] = np.clip(dist / float(m), 0.0, 1.0)
    alpha = cv2.warpPerspective(rr, hmat, (w, h), flags=cv2.INTER_LINEAR)[..., None]
    out = base.astype(np.float32) * (1 - alpha) + warped.astype(np.float32) * alpha
    out = np.clip(out, 0, 255).astype(np.uint8)
    # Inside the window the placeholder stays flat.
    inner = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(inner, np.round(target).astype(np.int32), 255)
    inner = cv2.erode(inner, np.ones((5, 5), np.uint8))
    out[inner > 0] = (216, 219, 215)
    return out, target


def main(set_name, room, ratio, top_share=0.6):
    with open(FRAME_QUADS_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    entry = payload["quads"][set_name][room]
    meta = entry.get("meta") or {}
    path = os.path.join(SETS, set_name, room)
    frame = _ensure_canvas(cv2.imread(path, cv2.IMREAD_COLOR), CANVAS_SIZE)
    quad = order_points(np.array(entry["points"], dtype=np.float32) * CANVAS_SIZE)
    if not meta.get("baked"):
        frame, quad, _ = rework_room(frame, quad, meta)
    out, target = skew(frame, quad, float(ratio), float(top_share))
    cv2.imwrite(path, out, [cv2.IMWRITE_JPEG_QUALITY, 97])
    entry["points"] = [[round(float(x) / CANVAS_SIZE, 6), round(float(y) / CANVAS_SIZE, 6)] for x, y in target]
    meta["baked"] = True
    meta["skew"] = {"ratio": float(ratio), "topShare": float(top_share)}
    entry["meta"] = meta
    with open(FRAME_QUADS_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    print(set_name, room, json.dumps(entry["points"]))


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
