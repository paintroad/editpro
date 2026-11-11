"""Remove the dark bevel line between a thin mat and the painting.

    py -3 fix_mat_bevel.py [--dry] [--all | "<set>/<room file>" ...]

Generated thin-mat rooms keep a 2-5 px dark bevel just outside the grey window, which shows as a
grey line round the painting. Per side, the window is pushed out over that band (pixels clearly
darker than the mat beyond it), the band is repainted as placeholder and the room's quad in
frame-quads.json follows. --all handles every room with meta.thinMat in the new sets.
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lifestyle_compositor import FRAME_QUADS_PATH  # noqa: E402

ROOT = r"C:\Users\divya\Downloads\_Frames\_New Lifestyle Sets"
PLACEHOLDER_BGR = (216, 219, 215)
MAX_BAND = 8
MAX_BEVEL = 5
DARKER = 10


def band(profile):
    """Length of the dark run at the start of profile, judged against the mat further out."""
    mat = float(np.median(profile[MAX_BAND + 1 : MAX_BAND + 7]))
    n = 0
    for k in range(MAX_BAND):
        if profile[k] < mat - DARKER:
            n = k + 1
    # A run reaching the search limit is the moulding or a shadow, not a bevel.
    return n if n <= MAX_BEVEL else 0


def fix(img, points):
    h, w = img.shape[:2]
    x0, y0 = int(round(points[0][0] * w)) + 1, int(round(points[0][1] * h)) + 1
    x1, y1 = int(round(points[2][0] * w)) - 1, int(round(points[2][1] * h)) - 1
    lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ym = slice(y0 + (y1 - y0) // 4, y1 - (y1 - y0) // 4)
    xm = slice(x0 + (x1 - x0) // 4, x1 - (x1 - x0) // 4)
    reach = MAX_BAND + 8
    ring = {
        "left": band(lum[ym, x0 - reach : x0].mean(axis=0)[::-1]),
        "right": band(lum[ym, x1 + 1 : x1 + 1 + reach].mean(axis=0)),
        "top": band(lum[y0 - reach : y0, xm].mean(axis=1)[::-1]),
        "bottom": band(lum[y1 + 1 : y1 + 1 + reach, xm].mean(axis=1)),
    }
    nx0, ny0, nx1, ny1 = x0 - ring["left"], y0 - ring["top"], x1 + ring["right"], y1 + ring["bottom"]
    img[ny0 : ny1 + 1, nx0 : nx1 + 1] = PLACEHOLDER_BGR
    quad = [((nx0 - 1) / w, (ny0 - 1) / h), ((nx1 + 1) / w, (ny0 - 1) / h), ((nx1 + 1) / w, (ny1 + 1) / h), ((nx0 - 1) / w, (ny1 + 1) / h)]
    return ring, [[round(x, 6), round(y, 6)] for x, y in quad]


def main(args):
    dry = "--dry" in args
    args = [a for a in args if a != "--dry"]
    with open(FRAME_QUADS_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    quads = payload["quads"]
    if args == ["--all"]:
        targets = [
            f"{s}/{f}"
            for s, rooms in quads.items()
            if os.path.isdir(os.path.join(ROOT, s))
            for f, e in rooms.items()
            if (e.get("meta") or {}).get("thinMat") and not (e.get("meta") or {}).get("bevelFixed")
        ]
    else:
        targets = args
    changed = 0
    for key in targets:
        s, f = key.split("/", 1)
        entry = quads[s][f]
        path = os.path.join(ROOT, s, f)
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        ring, quad = fix(img, entry["points"])
        print(key, ring)
        if dry or not any(ring.values()):
            continue
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        entry["points"] = quad
        entry["meta"] = {**entry["meta"], "bevelFixed": ring}
        changed += 1
    if changed:
        with open(FRAME_QUADS_PATH, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
    print("changed", changed)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
