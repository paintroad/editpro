"""Measure each new-style lifestyle set's room palette for set assignment: wall colour beside the
frame, and accent colours (saturated cushions, throws, rugs, decor) anywhere outside the frame.
Writes ~/.editpro/lifestyle-sets/room-palettes.json.
    python scripts/frames/room_palettes.py
"""
import colorsys
import json
import os
import re

import cv2
import numpy as np

ROOT = r"C:\Users\divya\Downloads\_Frames\_New Lifestyle Sets"
QUADS = os.path.join(os.path.dirname(__file__), "..", "frame-quads.json")
OUT = os.path.join(os.path.expanduser("~"), ".editpro", "lifestyle-sets", "room-palettes.json")
SET_NAME = re.compile(r"^(portrait|landscape|square|wide|tall)\s+(\w+)\s+(\d+)\s*-\s*(.+)$", re.I)
ROOM = re.compile(r"^\d+\.\s*(?!base)", re.I)
# Hue families (degrees) shared with assign_sets.js.
FAMILIES = [(0, 12, "red"), (12, 22, "rust"), (22, 40, "ochre"), (40, 70, "mustard"), (70, 160, "green"),
            (160, 200, "teal"), (200, 250, "blue"), (250, 290, "purple"), (290, 345, "pink"), (345, 361, "red")]
SIZE = 360


def room_palette(img, quad):
    img = cv2.resize(img, (SIZE, SIZE))
    p = (np.array(quad) * SIZE).astype(int)
    x0, y0 = p.min(0)
    x1, y1 = p.max(0)
    beside = np.concatenate([img[y0:y1, max(0, x0 - 40):max(1, x0 - 10)].reshape(-1, 3),
                             img[y0:y1, x1 + 10:x1 + 40].reshape(-1, 3)])
    wall = np.median(beside, 0)[::-1] if len(beside) else np.array([200, 200, 200])
    hls = cv2.cvtColor(img, cv2.COLOR_BGR2HLS_FULL).astype(np.float32)
    h, l, s = hls[..., 0] * 360 / 255, hls[..., 1] / 255, hls[..., 2] / 255
    outside = np.ones(l.shape, bool)
    outside[max(0, y0 - 8):y1 + 8, max(0, x0 - 8):x1 + 8] = False
    vivid = outside & (s > 0.38) & (l > 0.2) & (l < 0.8)
    counts = {}
    for a, b, name in FAMILIES:
        counts[name] = counts.get(name, 0) + int((vivid & (h >= a) & (h < b)).sum())
    return wall, counts, l.size


def main():
    quads = json.load(open(QUADS, encoding="utf8"))["quads"]
    out = {}
    for set_name in sorted(os.listdir(ROOT)):
        m = SET_NAME.match(set_name)
        if not m or not os.path.isdir(os.path.join(ROOT, set_name)):
            continue
        walls, counts, total = [], {}, 0
        for f in os.listdir(os.path.join(ROOT, set_name)):
            q = quads.get(set_name, {}).get(f)
            if not ROOM.match(f) or not q:
                continue
            img = cv2.imread(os.path.join(ROOT, set_name, f))
            if img is None:
                continue
            wall, c, n = room_palette(img, q["points"])
            walls.append(wall)
            total += n
            for k, v in c.items():
                counts[k] = counts.get(k, 0) + v
        if not walls:
            continue
        wall = np.median(np.array(walls), 0)
        hh, ll, ss = colorsys.rgb_to_hls(*(wall / 255))
        out[set_name] = {
            "rooms": len(walls),
            "wallRgb": [int(round(x)) for x in wall],
            "wallHue": round(hh * 360),
            "wallL": round(ll, 3),
            "wallS": round(ss, 3),
            # Percent of the room's pixels outside the frame that are vivid, per hue family.
            "accents": {k: round(100 * v / total, 2) for k, v in sorted(counts.items(), key=lambda kv: -kv[1]) if v},
        }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"{len(out)} sets -> {OUT}")


if __name__ == "__main__":
    main()
