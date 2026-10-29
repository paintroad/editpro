"""Make the black base frame show the painting end to end, with no white mat.

    py -3 fill_base_frames.py <set folder> [<set folder> ...]

The inside of each "1. Base <Orientation> Black.png" becomes plain opaque white (the template's mat
shading, smudges and small holes would otherwise show through the multiply blend), and its quad is
set to the inner edge of the black moulding plus a few pixels under it, so no white hairline is left.
Originals go to <frame references>/_Archive/Matted base frames/<set>. Already filled sets are skipped.
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lifestyle_compositor import FRAME_QUADS_PATH  # noqa: E402

UNDER_MOULDING_PX = 4


def _inner_edge(dark_line):
    idx = np.flatnonzero(dark_line)
    if not len(idx):
        return None
    end = idx[0]
    while end + 1 < len(dark_line) and dark_line[end + 1]:
        end += 1
    return end + 1


def frame_box(im):
    """Inner edge of the black moulding as (left, top, right, bottom), right/bottom exclusive."""
    h, w = im.shape[:2]
    dark = (im[:, :, 3] > 200) & (im[:, :, :3].astype(int).mean(axis=2) < 60)
    rows = range(int(h * 0.3), int(h * 0.7), 7)
    cols = range(int(w * 0.3), int(w * 0.7), 7)
    left = np.median([_inner_edge(dark[y]) for y in rows])
    right = w - np.median([_inner_edge(dark[y][::-1]) for y in rows])
    top = np.median([_inner_edge(dark[:, x]) for x in cols])
    bottom = h - np.median([_inner_edge(dark[:, x][::-1]) for x in cols])
    return int(left), int(top), int(right), int(bottom)


def fill(set_dir: str, quads: dict) -> int:
    set_name = os.path.basename(os.path.normpath(set_dir))
    rooms = quads.get(set_name) or {}
    archive = os.path.join(os.path.dirname(os.path.dirname(os.path.normpath(set_dir))), "_Archive", "Matted base frames", set_name)
    done = 0
    for name in sorted(os.listdir(set_dir)):
        if not (name.startswith("1. Base ") and name.endswith(" Black.png")):
            continue
        entry = rooms.get(name)
        if not entry or (entry.get("meta") or {}).get("filled"):
            continue
        path = os.path.join(set_dir, name)
        im = np.array(Image.open(path).convert("RGBA"))
        h, w = im.shape[:2]
        left, top, right, bottom = frame_box(im)
        os.makedirs(archive, exist_ok=True)
        keep = os.path.join(archive, name)
        if not os.path.exists(keep):
            shutil.copy2(path, keep)
        im[top:bottom, left:right] = 255
        Image.fromarray(im).save(path)
        pad = UNDER_MOULDING_PX
        x0, x1 = (left - pad) / w, (right + pad) / w
        y0, y1 = (top - pad) / h, (bottom + pad) / h
        entry["points"] = [[round(x, 6), round(y, 6)] for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
        entry["meta"] = {**(entry.get("meta") or {}), "method": f"moulding-inner+{pad}px", "filled": True}
        done += 1
    return done


def main(set_dirs):
    with open(FRAME_QUADS_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    total = 0
    for set_dir in set_dirs:
        n = fill(set_dir, payload["quads"])
        print(os.path.basename(os.path.normpath(set_dir)), "filled", n)
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
