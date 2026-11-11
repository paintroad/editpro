"""Reshape the frame in an installed lifestyle-set room, in place.

  stretch: grows the frame block vertically until the window is exactly 16:9 (frames generated
           too long for a wide print). anchor top|center|bottom is the edge that stays put.
  thicken: widens the moulding by <px> on every side (or only the listed sides), outward over
           the wall; the window stays.
           Clears meta.mouldingMax so the compositor does not thin it back.

    python scripts/frames/reshape_frame.py "<set>" "<room file>" stretch [top|center|bottom]
    python scripts/frames/reshape_frame.py "<set>" "<room file>" thicken <px> [left,right,top,bottom]

Run keep_before.js on the room first if the reviewer should see the old version.
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from fit_frame import PLACEHOLDER_BGR, SHADOW_MARGIN, last_edge  # noqa: E402

ROOT = r"C:\Users\divya\Downloads\_Frames\_New Lifestyle Sets"
QUADS = os.path.join(os.path.dirname(__file__), "..", "frame-quads.json")
WIDE = 16 / 9
FEATHER = 6
# Mouldings in these rooms are under 30 px; a wider search catches lamps and plants beside them.
REACH = 50


def outer_frame(img, win):
    x0, y0, x1, y1 = win
    w, h = x1 - x0 + 1, y1 - y0 + 1
    lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sides = []
    for y in [y0 + int(h * f) for f in (0.3, 0.5, 0.7)]:
        sides.append(last_edge(lum[y, max(0, x0 - REACH):x0][::-1]))
        sides.append(last_edge(lum[y, x1 + 1:x1 + 1 + REACH]))
    tops = []
    for x in [x0 + int(w * f) for f in (0.3, 0.5, 0.7)]:
        tops.append(last_edge(lum[max(0, y0 - REACH):y0, x][::-1]))
        tops.append(last_edge(lum[y1 + 1:y1 + 1 + REACH, x]))
    side, top = int(np.median(sides)), int(np.median(tops))
    return x0 - side, y0 - top, x1 + side, y1 + top, side, top


def feather_paste(img, patch, x, y):
    h, w = patch.shape[:2]
    alpha = np.ones((h, w), np.float32)
    for i in range(FEATHER):
        v = (i + 1) / (FEATHER + 1)
        alpha[i, :] = np.minimum(alpha[i, :], v)
        alpha[h - 1 - i, :] = np.minimum(alpha[h - 1 - i, :], v)
        alpha[:, i] = np.minimum(alpha[:, i], v)
        alpha[:, w - 1 - i] = np.minimum(alpha[:, w - 1 - i], v)
    region = img[y:y + h, x:x + w].astype(np.float32)
    img[y:y + h, x:x + w] = (patch.astype(np.float32) * alpha[..., None] + region * (1 - alpha[..., None])).astype(np.uint8)


def stretch(img, win, anchor):
    x0, y0, x1, y1 = win
    w, h = x1 - x0 + 1, y1 - y0 + 1
    sy = (w / WIDE) / h
    ox0, oy0, ox1, oy1, _, _ = outer_frame(img, win)
    ox0, oy0 = max(0, ox0 - SHADOW_MARGIN), max(0, oy0 - SHADOW_MARGIN)
    ox1, oy1 = min(img.shape[1] - 1, ox1 + SHADOW_MARGIN), min(img.shape[0] - 1, oy1 + SHADOW_MARGIN)
    block = img[oy0:oy1 + 1, ox0:ox1 + 1]
    bh = block.shape[0]
    nh = int(round(bh * sy))
    grown = cv2.resize(block, (block.shape[1], nh), interpolation=cv2.INTER_CUBIC)
    py0 = {"top": oy0, "bottom": oy1 + 1 - nh, "center": int(round((oy0 + oy1 + 1 - nh) / 2))}[anchor]
    if py0 < 0 or py0 + nh > img.shape[0]:
        raise SystemExit("stretched frame leaves the canvas")
    feather_paste(img, grown, ox0, py0)
    ny0 = int(round(py0 + (y0 - oy0) * sy))
    ny1 = ny0 + int(round(w / WIDE)) - 1
    return (x0, ny0, x1, ny1), round((sy - 1) * 100, 1)


def thicken(img, win, px, sides):
    x0, y0, x1, y1 = win
    _, _, _, _, side, top = outer_frame(img, win)
    m = SHADOW_MARGIN
    H, W = img.shape[:2]
    pl, pr, pt, pb = [px if s in sides else 0 for s in ("left", "right", "top", "bottom")]

    def axis_map(n, a0, a1, band, p_lo, p_hi):
        """Destination -> source coordinates along one axis: the moulding band on each side of
        [a0, a1] is stretched from band to band + p, the shadow beyond it shifted out by p."""
        src = np.arange(n, dtype=np.float32)
        for a, p, sign in ((a0, p_lo, -1), (a1, p_hi, 1)):
            if not p:
                continue
            k = (band + p) / max(band, 1)
            for off in range(1, band + p + m + 1):
                d = a + sign * off
                if 0 <= d < n:
                    src[d] = a + sign * (off / k if off <= band + p else band + (off - band - p))
        return src

    mx = axis_map(W, x0, x1, side, pl, pr)
    my = axis_map(H, y0, y1, top, pt, pb)
    bx0, bx1 = max(0, x0 - side - pl - m), min(W - 1, x1 + side + pr + m)
    by0, by1 = max(0, y0 - top - pt - m), min(H - 1, y1 + top + pb + m)
    gx, gy = np.meshgrid(mx[bx0:bx1 + 1], my[by0:by1 + 1])
    patch = cv2.remap(img, gx, gy, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    feather_paste(img, patch, bx0, by0)
    return win


def main():
    set_name, room, op = sys.argv[1:4]
    arg = sys.argv[4] if len(sys.argv) > 4 else None
    quads = json.load(open(QUADS, encoding="utf8"))
    entry = quads["quads"][set_name][room]
    path = os.path.join(ROOT, set_name, room)
    img = cv2.imread(path)
    H, W = img.shape[:2]
    p = (np.array(entry["points"]) * [W, H]).round().astype(int)
    win = (p[:, 0].min() + 1, p[:, 1].min() + 1, p[:, 0].max() - 1, p[:, 1].max() - 1)
    meta = entry.setdefault("meta", {})
    if op == "stretch":
        win, pct = stretch(img, win, arg or "center")
        meta["stretchPct"] = round(float(meta.get("stretchPct") or 0) + pct, 1)
    elif op == "thicken":
        sides = sys.argv[5].split(",") if len(sys.argv) > 5 else ["left", "right", "top", "bottom"]
        win = thicken(img, win, int(arg), sides)
        meta.pop("mouldingMax", None)
        meta["thickened"] = int(meta.get("thickened", 0)) + int(arg)
    else:
        raise SystemExit(f"unknown op {op}")
    x0, y0, x1, y1 = win
    img[y0:y1 + 1, x0:x1 + 1] = PLACEHOLDER_BGR
    cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    l, t, r, b = (x0 - 1) / W, (y0 - 1) / H, (x1 + 1) / W, (y1 + 1) / H
    entry["points"] = [[round(l, 6), round(t, 6)], [round(r, 6), round(t, 6)], [round(r, 6), round(b, 6)], [round(l, 6), round(b, 6)]]
    with open(QUADS, "w", encoding="utf8") as f:
        f.write(json.dumps(quads, indent=2) + "\n")
    print(json.dumps({"room": f"{set_name}/{room}", "op": op, "window": [int(v) for v in win], "ratio": round((x1 - x0 + 1) / (y1 - y0 + 1), 3)}))


if __name__ == "__main__":
    main()
