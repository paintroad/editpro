"""Write each room's mat, edge, moulding and size changes into its image, so the set folder shows
the final look, and mark the room meta.baked so the compositor does not apply them again.

    py -3 bake_rooms.py <set folder> [<set folder> ...]

Originals go to <frame references>/_Archive/Unbaked rooms/<set>. Re-running build_set.js on a set
copies fresh rooms in and drops the baked flag, after which this can be run again.
"""
import json
import os
import shutil
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lifestyle_compositor import (  # noqa: E402
    CANVAS_SIZE,
    FRAME_QUADS_PATH,
    _ensure_canvas,
    order_points,
    rework_room,
)
import numpy as np  # noqa: E402

REWORK_KEYS = ("mat", "canvas", "edgeToEdge", "grow")


def bake(set_dir: str, quads: dict) -> int:
    set_name = os.path.basename(os.path.normpath(set_dir))
    rooms = quads.get(set_name)
    if not rooms:
        print(set_name, "has no frame-quads entry")
        return 0
    archive = os.path.join(os.path.dirname(os.path.dirname(os.path.normpath(set_dir))), "_Archive", "Unbaked rooms", set_name)
    baked = 0
    for template, entry in rooms.items():
        meta = entry.get("meta") or {}
        path = os.path.join(set_dir, template)
        if meta.get("baked") or not template.lower().endswith(".jpg") or not os.path.isfile(path):
            continue
        if not any(meta.get(k) for k in REWORK_KEYS):
            continue
        frame = cv2.imread(path, cv2.IMREAD_COLOR)
        if frame is None or frame.shape[:2] != (CANVAS_SIZE, CANVAS_SIZE):
            print(set_name, template, "skipped: not a", CANVAS_SIZE, "px square")
            continue
        quad = order_points(np.array(entry["points"], dtype=np.float32) * CANVAS_SIZE)
        out, quad, changed = rework_room(_ensure_canvas(frame, CANVAS_SIZE), quad, meta)
        if not changed:
            continue
        os.makedirs(archive, exist_ok=True)
        keep = os.path.join(archive, template)
        if not os.path.exists(keep):
            shutil.copy2(path, keep)
        cv2.imwrite(path, out, [cv2.IMWRITE_JPEG_QUALITY, 97])
        entry["points"] = [[round(float(x) / CANVAS_SIZE, 6), round(float(y) / CANVAS_SIZE, 6)] for x, y in quad]
        meta["baked"] = True
        entry["meta"] = meta
        baked += 1
    return baked


def main(set_dirs):
    with open(FRAME_QUADS_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    total = 0
    for set_dir in set_dirs:
        n = bake(set_dir, payload["quads"])
        print(os.path.basename(os.path.normpath(set_dir)), "baked", n, "rooms")
        total += n
    if total:
        with open(FRAME_QUADS_PATH, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
    print("total", total)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
