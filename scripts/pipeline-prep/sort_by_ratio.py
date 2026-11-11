"""Move paintings outside the accepted shapes to a correction folder.

Accepted (same rule as describeShape in lib/artwork-pipeline.js): square within 5%,
or 4:3 / 3:4 with the long side within 10% of 4/3.

    py -3 sort_by_ratio.py <folder> <correction_folder>          # dry run
    py -3 sort_by_ratio.py <folder> <correction_folder> --apply  # move
"""
import csv, os, shutil, sys
from collections import Counter
from PIL import Image

SQUARE_TOLERANCE = 0.05
TARGET_RATIO = 4 / 3
TARGET_TOLERANCE = 10  # percent
NAMED = [(1, "1:1"), (5 / 4, "5:4"), (4 / 3, "4:3"), (3 / 2, "3:2"), (16 / 9, "16:9"), (2, "2:1"), (3, "3:1")]
Image.MAX_IMAGE_PIXELS = None


def shape(w, h):
    ratio = w / h
    long = max(w, h) / min(w, h)
    if abs(ratio - 1) <= SQUARE_TOLERANCE:
        return True, "1:1", 0.0
    deviation = round((long / TARGET_RATIO - 1) * 100, 1)
    ok = abs(deviation) <= TARGET_TOLERANCE
    import math
    label = "4:3" if ok else min(NAMED, key=lambda n: abs(math.log(long / n[0])))[1]
    if ratio < 1:
        a, b = label.split(":")
        label = f"{b}:{a}"
    return ok, label, deviation


def main():
    src, dst = sys.argv[1], sys.argv[2]
    apply = "--apply" in sys.argv
    rows, bad = [], []
    for f in sorted(os.listdir(src)):
        p = os.path.join(src, f)
        if not os.path.isfile(p):
            continue
        try:
            with Image.open(p) as im:
                w, h = im.size
        except Exception as e:
            rows.append((f, "", "", "", "unreadable", str(e)))
            continue
        ok, label, dev = shape(w, h)
        rows.append((f, w, h, label, "ok" if ok else "move", dev))
        if not ok:
            bad.append((f, label))
    print("total", len(rows), "accepted", sum(r[4] == "ok" for r in rows), "to move", len(bad),
          "unreadable", sum(r[4] == "unreadable" for r in rows))
    print("shapes to move", Counter(l for _, l in bad).most_common())
    report = os.path.join(os.path.expanduser(r"~\.editpro\pipeline-prep"), "existing-ratio-check.csv")
    with open(report, "w", newline="", encoding="utf8") as fh:
        csv.writer(fh).writerows([("file", "width", "height", "shape", "result", "deviation_pct")] + rows)
    print("report", report)
    if apply:
        os.makedirs(dst, exist_ok=True)
        for f, _ in bad:
            target = os.path.join(dst, f)
            if os.path.exists(target):
                print("exists, skipped", f)
                continue
            shutil.move(os.path.join(src, f), target)
        print("moved", len(bad))


if __name__ == "__main__":
    main()
