"""Review package for set assignments: one contact sheet per lifestyle set (its first room and wall colour,
then every painting assigned to it), plus Distribution.csv and Exceptions.csv.
Reads ~/.editpro/lifestyle-sets/set-assignments.json and set-assignment-report.json.
    python scripts/frames/set_assignment_sheets.py [output dir]
"""
import csv
import json
import os
import re
import sys

import cv2
import numpy as np

LS = os.path.join(os.path.expanduser("~"), ".editpro", "lifestyle-sets")
ROOT = r"C:\Users\divya\Downloads\_Frames\_New Lifestyle Sets"
OUT = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\divya\Downloads\_Catalog\Set Assignment Review"
THUMB, COLS, LABEL = 150, 12, 18
CROWDED = 80


def thumb(path):
    img = cv2.imread(path) if path and os.path.exists(path) else None
    tile = np.full((THUMB + LABEL, THUMB, 3), 255, np.uint8)
    if img is None:
        return tile
    h, w = img.shape[:2]
    s = THUMB / max(h, w)
    img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    y, x = (THUMB - img.shape[0]) // 2, (THUMB - img.shape[1]) // 2
    tile[y:y + img.shape[0], x:x + img.shape[1]] = img
    return tile


def header(set_name, count, palette, flagged):
    rooms = sorted([f for f in os.listdir(os.path.join(ROOT, set_name)) if re.match(r"^\d+\.\s*(?!base)", f, re.I) and f.lower().endswith(".jpg")],
                   key=lambda f: int(f.split(".")[0]))
    width = COLS * THUMB
    bar = np.full((260, width, 3), 255, np.uint8)
    x = 0
    for f in rooms[:4]:
        room = cv2.resize(cv2.imread(os.path.join(ROOT, set_name, f)), (240, 240))
        bar[10:250, x + 10:x + 250] = room
        x += 250
    if palette:
        cv2.rectangle(bar, (x + 20, 20), (x + 80, 80), tuple(int(c) for c in palette["wallRgb"][::-1]), -1)
        cv2.rectangle(bar, (x + 20, 20), (x + 80, 80), (120, 120, 120), 1)
        acc = ", ".join(k for k, v in list(palette["accents"].items())[:4] if v >= 1) or "no strong accents"
        cv2.putText(bar, f"wall lightness {palette['wallL']:.2f}", (x + 95, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (60, 60, 60), 1, cv2.LINE_AA)
        cv2.putText(bar, f"accents: {acc}", (x + 95, 72), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (60, 60, 60), 1, cv2.LINE_AA)
    cv2.putText(bar, set_name, (x + 20, 130), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2, cv2.LINE_AA)
    note = f"{count} paintings" + (f"  (crowded: over {CROWDED})" if count > CROWDED else "") + (f"  | {flagged} flagged (red label)" if flagged else "")
    cv2.putText(bar, note, (x + 20, 170), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 180) if count > CROWDED else (40, 40, 40), 1, cv2.LINE_AA)
    return bar


def main():
    data = json.load(open(os.path.join(LS, "set-assignments.json"), encoding="utf8"))["paintings"]
    report = json.load(open(os.path.join(LS, "set-assignment-report.json"), encoding="utf8"))
    palettes = json.load(open(os.path.join(LS, "room-palettes.json"), encoding="utf8"))
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.lower().endswith(".jpg"):
            os.remove(os.path.join(OUT, f))
    by_set = {}
    for stem, v in data.items():
        by_set.setdefault(v["set"], []).append((stem, v))
    for c in report["counts"]:
        name = c["set"]
        items = sorted(by_set.get(name, []), key=lambda kv: (-(kv[1].get("score") or 0)))
        tiles = []
        for stem, v in items:
            t = thumb(v.get("image"))
            flagged = bool(v.get("flags"))
            cv2.putText(t, stem, (4, THUMB + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 200) if flagged else (50, 50, 50), 1, cv2.LINE_AA)
            tiles.append(t)
        while len(tiles) % COLS or not tiles:
            tiles.append(np.full((THUMB + LABEL, THUMB, 3), 255, np.uint8))
        grid = np.vstack([np.hstack(tiles[i:i + COLS]) for i in range(0, len(tiles), COLS)])
        sheet = np.vstack([header(name, len(items), palettes.get(name), sum(1 for _, v in items if v.get("flags"))), grid])
        cv2.imwrite(os.path.join(OUT, f"{len(items):03d} - {name}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])

    with open(os.path.join(OUT, "Distribution.csv"), "w", newline="", encoding="utf8") as fh:
        w = csv.writer(fh)
        w.writerow(["Set", "Theme", "Shape", "Paintings", "Crowded (>80)", "Suggested sibling sets", "Avg lightness", "Main colours"])
        crowd = {c["set"]: c for c in report["crowded"]}
        for c in sorted(report["counts"], key=lambda c: -c["paintings"]):
            k = crowd.get(c["set"])
            w.writerow([c["set"], c["theme"], c["shape"], c["paintings"], "yes" if k else "", k["siblingsSuggested"] if k else "",
                        k["avgLightness"] if k else "", " / ".join(k["mainColours"]) if k else ""])
    with open(os.path.join(OUT, "Exceptions.csv"), "w", newline="", encoding="utf8") as fh:
        w = csv.writer(fh)
        w.writerow(["Painting", "Title", "Assigned set", "Why flagged", "Runner-up set", "Reason"])
        for e in sorted(report["exceptions"], key=lambda e: (e["set"], e["stem"])):
            v = data[e["stem"]]
            w.writerow([e["stem"], v["title"], v["set"], "; ".join(e["flags"]), v.get("runnerUp") or "", v["reason"]])
    print(f"{len(report['counts'])} sheets, {len(report['exceptions'])} exceptions -> {OUT}")


if __name__ == "__main__":
    main()
