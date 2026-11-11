"""Plan crops for off-ratio paintings: existing size (3:4 / 4:3) first, else 9:16 / 16:9, else no easy crop.

Each option is scored by the share of edge detail (Sobel) the best crop window removes.
A crop counts as easy when it removes MAX_LOST or less, or when the removed strips are nearly blank.

    py -3 crop_plan.py <group_folder> [--apply]
Files directly in the folder or in its subfolders are planned; with --apply they are moved into
"Crop to 3x4" / "Crop to 9x16" (or 4x3 / 16x9) / "No easy crop", and crop-plan.csv is written.
"""
import csv, os, shutil, sys
from collections import Counter
import cv2
import numpy as np

MAX_LOST = 0.08
PLAIN_MEAN = 6  # mean Sobel magnitude below this means the cut strips are nearly blank
SKIP = {"crop-plan.csv"}


def energy_map(path):
    img = cv2.imread(path)
    h, w = img.shape[:2]
    s = 600 / max(h, w)
    small = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    g = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    return np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)), w, h


def best_crop(e, target):
    """Best window for target ratio (w/h). Returns (lost, cut_mean, box as fractions)."""
    sh, sw = e.shape
    total = e.sum() or 1
    axis_sides = sw / sh > target
    if axis_sides:
        keep = min(sw, int(round(sh * target)))
        line = e.sum(axis=0)
    else:
        keep = min(sh, int(round(sw / target)))
        line = e.sum(axis=1)
    c = np.concatenate([[0], np.cumsum(line)])
    kept = c[keep:] - c[:-keep]
    b = int(np.argmax(kept))
    lost = 1 - kept[b] / total
    if axis_sides:
        cut = np.concatenate([e[:, :b], e[:, b + keep:]], axis=1)
        box = (b / sw, 0.0, (b + keep) / sw, 1.0)
    else:
        cut = np.concatenate([e[:b], e[b + keep:]], axis=0)
        box = (0.0, b / sh, 1.0, (b + keep) / sh)
    return lost, float(cut.mean()) if cut.size else 0.0, box


def main():
    root = sys.argv[1]
    apply = "--apply" in sys.argv
    files = []
    for dirpath, _, names in os.walk(root):
        files += [os.path.join(dirpath, n) for n in names if n not in SKIP and not n.startswith("_")]
    rows, counts = [], Counter()
    for path in sorted(files):
        e, w, h = energy_map(path)
        portrait = h > w
        options = [("3x4", 3 / 4), ("9x16", 9 / 16)] if portrait else [("4x3", 4 / 3), ("16x9", 16 / 9)]
        scored = []
        for name, ratio in options:
            lost, cut_mean, box = best_crop(e, ratio)
            scored.append((name, lost, cut_mean, box, lost <= MAX_LOST or cut_mean < PLAIN_MEAN))
        easy = [s for s in scored if s[4]]
        pick = easy[0] if easy else None  # existing size first
        group = f"Crop to {pick[0]}" if pick else "No easy crop"
        counts[group] += 1
        rec = pick or min(scored, key=lambda s: s[1])
        rows.append([os.path.basename(path), w, h, group,
                     *[round(s[1] * 100, 1) for s in scored], *[round(v, 4) for v in rec[3]], path])
    for k, v in sorted(counts.items()):
        print(v, k)
    if not apply:
        return
    out_rows = []
    for r in rows:
        dest_dir = os.path.join(root, r[3])
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, r[0])
        if os.path.abspath(r[-1]) != os.path.abspath(dest):
            shutil.move(r[-1], dest)
        out_rows.append(r[:-1])
    for dirpath, dirs, names in sorted(os.walk(root), reverse=True):
        if dirpath != root and not os.listdir(dirpath):
            os.rmdir(dirpath)
    first, second = ("3x4", "9x16") if "Portrait" in root else ("4x3", "16x9")
    with open(os.path.join(root, "crop-plan.csv"), "w", newline="") as fh:
        csv.writer(fh).writerows(
            [("file", "width", "height", "plan", f"lost_{first}_pct", f"lost_{second}_pct", "crop_x0", "crop_y0", "crop_x1", "crop_y1")]
            + out_rows
        )


if __name__ == "__main__":
    main()
