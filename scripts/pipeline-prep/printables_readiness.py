"""Which approved crop-review paintings print sharply at the largest size we sell, once the approved
crop recipe is applied to the printable file, and what upscaling the rest with Topaz would cost.

    py -3 printables_readiness.py      writes printables-readiness.csv/.json in ~/.editpro/pipeline-prep

Largest size sold (long side, inches): 3:4 and 4:3 -> 36 (24x36), square -> 36, 9:16 and 16:9 -> 48 (27x48).
Grades at that size: high >= 150 ppi, fair 100-150 ppi, low < 100 ppi.
Topaz precision models bill 1 credit per 24 MP of output; credits cost $0.10 (100 for $10).
"""
import csv, json, math, os
import cv2
import numpy as np
from PIL import Image
import apply_review_notes as A

Image.MAX_IMAGE_PIXELS = None
INDEX = os.path.join(A.PREP, "catalog-file-index.json")
OUT_CSV = os.path.join(A.PREP, "printables-readiness.csv")
OUT_JSON = os.path.join(A.PREP, "printables-readiness.json")
HIGH, FAIR = 150, 100
CREDIT_USD = 0.10
MP_PER_CREDIT = 24e6


def long_inches(target):
    return 48 if abs(target - 16 / 9) < 0.05 or abs(target - 9 / 16) < 0.05 else 36


def flat_art(path):
    """Share of untextured pixels: flat digital art, posters and renders score 0.45+, painted work ~0.1."""
    im, _ = A.small(A.read(path), 400)
    lap = np.abs(cv2.Laplacian(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.CV_16S, ksize=3))
    return float((lap <= 4).mean())


def main():
    items = {i["key"]: i for i in json.load(open(A.ITEMS, encoding="utf8"))}
    fb = json.load(open(A.FEEDBACK, encoding="utf8"))
    printable = json.load(open(INDEX, encoding="utf8"))["printable"]
    rows = []
    for key, e in fb.items():
        if e.get("status") not in ("approved", "crop_only"):
            continue
        it = items[key]
        n = A.stem(it["file"])
        rec = e.get("recipe") or {}
        frac = e.get("frac") or rec.get("frac") or it["frac"]
        target = rec.get("target") or it["target"]
        src = os.path.join(A.ROOT, it["folder"], it["file"])
        p = printable.get(n)
        row = {"painting": n, "folder": it["folder"], "target": round(target, 4),
               "edits": ("text removed; " if rec.get("clean") else "") + (rec.get("done") or "crop"),
               "needs_clean_redo": bool(rec.get("clean"))}
        if not p or not os.path.exists(p):
            row.update(grade="no printable")
            rows.append(row)
            continue
        pw, ph = Image.open(p).size
        ow, oh = it["w"], it["h"]
        row.update(printable=p, printable_px=f"{pw}x{ph}", optimised_px=f"{ow}x{oh}")
        row["ratio_mismatch"] = abs(pw / ph - ow / oh) > 0.01
        if row["ratio_mismatch"] and abs(ph / pw - ow / oh) <= 0.01:
            # printable saved in the other orientation: the recipe applies once it is turned
            pw, ph = ph, pw
            row["ratio_mismatch"] = "rotated"
        out_w, out_h = (frac[2] - frac[0]) * pw, (frac[3] - frac[1]) * ph
        inches = long_inches(target)
        ppi = max(out_w, out_h) / inches
        grade = "high" if ppi >= HIGH else "fair" if ppi >= FAIR else "low"
        row.update(out_px=f"{round(out_w)}x{round(out_h)}", largest_in=inches, ppi=round(ppi), grade=grade)
        if grade != "high":
            want_long = HIGH * inches
            scale = want_long / max(out_w, out_h)
            mp = out_w * out_h * scale * scale
            row.update(upscale_x=round(scale, 2), upscale_mp=round(mp / 1e6, 1),
                       credits=round(mp / MP_PER_CREDIT, 2),
                       model="Art & CGI" if flat_art(src) >= 0.45 else "Low Resolution V2")
        rows.append(row)

    cols = ["painting", "grade", "ppi", "largest_in", "out_px", "printable_px", "optimised_px", "target",
            "ratio_mismatch", "needs_clean_redo", "upscale_x", "upscale_mp", "credits", "model", "edits",
            "folder", "printable"]
    with open(OUT_CSV, "w", newline="", encoding="utf8") as fh:
        w = csv.DictWriter(fh, cols, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r.get("ppi") or 0)):
            w.writerow(r)
    json.dump(rows, open(OUT_JSON, "w", encoding="utf8"), indent=1)

    def count(pred):
        return sum(1 for r in rows if pred(r))
    print("approved", len(rows))
    for g in ("high", "fair", "low", "no printable"):
        print(g, count(lambda r: r.get("grade") == g))
    print("printable in the other orientation", count(lambda r: r.get("ratio_mismatch") == "rotated"))
    print("printable framed differently", count(lambda r: r.get("ratio_mismatch") is True))
    print("text removal to redo at print size", count(lambda r: r.get("needs_clean_redo")))
    for g in ("fair", "low"):
        sel = [r for r in rows if r.get("grade") == g]
        cr = sum(r["credits"] for r in sel)
        per = sum(max(1, math.ceil(r["credits"])) for r in sel)
        models = {}
        for r in sel:
            models[r["model"]] = models.get(r["model"], 0) + 1
        print(f"{g}: {len(sel)} paintings, {cr:.0f} credits linear (${cr * CREDIT_USD:.0f}),"
              f" {per} if billed per whole credit (${per * CREDIT_USD:.0f}); models {models}")
    by = {}
    for r in rows:
        k = (str(r["target"]), r.get("grade"))
        by[k] = by.get(k, 0) + 1
    print("by shape:", sorted(by.items()))
    print(OUT_CSV)


if __name__ == "__main__":
    main()
