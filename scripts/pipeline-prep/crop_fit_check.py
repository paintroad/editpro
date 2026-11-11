"""How much detail a crop to a target ratio would cut, per painting.

For each image it finds the crop window position that removes the least edge detail
(Sobel magnitude) and reports the share of detail lost.

    py -3 crop_fit_check.py <folder> <target_w> <target_h> <out_dir> [min_ratio max_ratio]
"""
import csv, os, sys
import cv2
import numpy as np

src, tw, th, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
lo, hi = (float(sys.argv[5]), float(sys.argv[6])) if len(sys.argv) > 6 else (0, 99)
target = tw / th
os.makedirs(out, exist_ok=True)
rows = []
for f in sorted(os.listdir(src)):
    img = cv2.imread(os.path.join(src, f))
    if img is None:
        continue
    h, w = img.shape[:2]
    if not lo <= w / h <= hi:
        continue
    s = 600 / max(h, w)
    small = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))))
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    energy = np.hypot(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1))
    sh, sw = energy.shape
    total = energy.sum() or 1
    if sw / sh > target:  # too wide: crop the sides
        keep = int(round(sh * target))
        cols = np.concatenate([[0], np.cumsum(energy.sum(axis=0))])
        kept = cols[keep:] - cols[:-keep] if keep < sw else np.array([total])
        best = int(np.argmax(kept))
        lost = 1 - kept[best] / total
        box = (best / sw, 0, (best + keep) / sw, 1)
        cut = 1 - keep / sw
    else:  # too tall: crop top and bottom
        keep = int(round(sw / target))
        rws = np.concatenate([[0], np.cumsum(energy.sum(axis=1))])
        kept = rws[keep:] - rws[:-keep] if keep < sh else np.array([total])
        best = int(np.argmax(kept))
        lost = 1 - kept[best] / total
        box = (0, best / sh, 1, (best + keep) / sh)
        cut = 1 - keep / sh
    rows.append((f, w, h, round(cut * 100, 1), round(lost * 100, 1), *[round(b, 4) for b in box]))

rows.sort(key=lambda r: r[4])
with open(os.path.join(out, "crop-fit.csv"), "w", newline="") as fh:
    csv.writer(fh).writerows([("file", "w", "h", "cut_pct", "detail_lost_pct", "x0", "y0", "x1", "y1")] + rows)
lost = np.array([r[4] for r in rows])
print("checked", len(rows))
for t in (3, 5, 8, 12):
    print(f"detail lost <= {t}%: {(lost <= t).sum()}")
