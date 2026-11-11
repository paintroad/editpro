"""Crop every planned painting in the correction folders to its exact target shape.

For each image folder under the optimised correction tree (except "No easy crop"):
  <folder>/Cropped/<file>     cropped optimised file
  <folder>/Comparison/<file>  original (cut area darkened) beside the crop, for review
and the matching printable goes to the same <folder>/Cropped in the printables correction tree.
The window is chosen on the optimised file (least edge detail removed) and applied to both,
so optimised and printable always match. Resumable; a log is kept in crop-execute.csv.

    py -3 crop_execute.py [workers]
"""
import csv, os, sys
from multiprocessing import Pool
import cv2
import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crop_plan import best_crop

DL = r"C:\Users\divya\Downloads"
OPT_FIX = os.path.join(DL, "_Existing Catalog Correction")
PRINT_FIX = os.path.join(DL, "_Existing Catalog Printables Correction")
LOG = os.path.expanduser(r"~\.editpro\pipeline-prep\crop-execute.csv")
OUTPUT_DIRS = {"Cropped", "Comparison"}
SKIP_DIRS = {"No easy crop"}
COMPARE_H = 700


def target_for(rel, w, h):
    portrait = h > w
    if rel.startswith("Square"):
        return 1.0
    if any(k in rel for k in ("16x9", "9x16", "Very long")):
        return 9 / 16 if portrait else 16 / 9
    return 3 / 4 if portrait else 4 / 3


def load(path):
    im = ImageOps.exif_transpose(Image.open(path))
    return im


def save_like(im, src, dst, info):
    ext = os.path.splitext(dst)[1].lower()
    kw = {k: info[k] for k in ("dpi", "icc_profile") if k in info}
    if ext in (".jpg", ".jpeg"):
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.save(dst, quality=95, subsampling=0, **kw)
    else:
        im.save(dst, **kw)


def pixel_box(frac, w, h, target):
    """Exact-ratio pixel window inside w x h, placed where the fractional box says."""
    if w / h > target:
        cw, ch = max(1, round(h * target)), h
    else:
        cw, ch = w, max(1, round(w / target))
    x0 = min(max(0, round(frac[0] * w)), w - cw)
    y0 = min(max(0, round(frac[1] * h)), h - ch)
    return x0, y0, x0 + cw, y0 + ch


def energy_of(im):
    small = im.convert("RGB").copy()
    small.thumbnail((600, 600))
    g = cv2.GaussianBlur(cv2.cvtColor(np.array(small), cv2.COLOR_RGB2GRAY), (3, 3), 0)
    return np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))


def comparison(im, box, cropped):
    w, h = im.size
    s = COMPARE_H / h
    left = np.array(im.convert("RGB").resize((max(1, round(w * s)), COMPARE_H)))
    x0, y0, x1, y1 = [round(v * s) for v in box]
    dim = left.copy()
    dim[:] = (dim * 0.3).astype(np.uint8)
    dim[y0:y1, x0:x1] = left[y0:y1, x0:x1]
    cv2.rectangle(dim, (x0, y0), (max(x0, x1 - 1), max(y0, y1 - 1)), (255, 0, 0), 2)
    cw, ch = cropped.size
    right = np.array(cropped.convert("RGB").resize((max(1, round(cw * COMPARE_H / ch)), COMPARE_H)))
    gap = np.full((COMPARE_H, 16, 3), 255, np.uint8)
    return Image.fromarray(np.hstack([dim, gap, right]))


def find_printable(rel, stem):
    d = os.path.join(PRINT_FIX, rel)
    if not os.path.isdir(d):
        return None
    for f in os.listdir(d):
        if os.path.splitext(f)[0] == stem and os.path.isfile(os.path.join(d, f)):
            return os.path.join(d, f)
    return None


def work(job):
    rel, name = job
    src = os.path.join(OPT_FIX, rel, name)
    stem = os.path.splitext(name)[0]
    out_opt = os.path.join(OPT_FIX, rel, "Cropped", name)
    out_cmp = os.path.join(OPT_FIX, rel, "Comparison", stem + ".jpg")
    prt = find_printable(rel, stem)
    out_prt = os.path.join(PRINT_FIX, rel, "Cropped", os.path.basename(prt)) if prt else None
    if os.path.exists(out_opt) and os.path.exists(out_cmp) and (not prt or os.path.exists(out_prt)):
        return None
    try:
        im = load(src)
        w, h = im.size
        t = target_for(rel, w, h)
        e = energy_of(im)
        _, _, frac = best_crop(e, t)
        box = pixel_box(frac, w, h, t)
        cropped = im.crop(box)
        info = Image.open(src).info
        save_like(cropped, src, out_opt, info)
        comparison(im, box, cropped).save(out_cmp, quality=85)
        pinfo = ""
        if prt:
            pim = load(prt)
            pw, ph = pim.size
            pbox = pixel_box(frac, pw, ph, t)
            save_like(pim.crop(pbox), prt, out_prt, Image.open(prt).info)
            pinfo = f"{pw}x{ph}->{pbox[2] - pbox[0]}x{pbox[3] - pbox[1]}"
        return (rel, name, f"{w}x{h}->{box[2] - box[0]}x{box[3] - box[1]}", pinfo, round(t, 4), *[round(v, 4) for v in frac], "ok")
    except Exception as ex:
        return (rel, name, "", "", "", "", "", "", "", f"error: {ex}")


def jobs():
    out = []
    for d, dirs, names in os.walk(OPT_FIX):
        dirs[:] = [x for x in dirs if x not in OUTPUT_DIRS and x not in SKIP_DIRS]
        rel = os.path.relpath(d, OPT_FIX)
        if rel == ".":
            continue
        for n in names:
            if not n.lower().endswith(".csv"):
                out.append((rel, n))
    return sorted(out)


if __name__ == "__main__":
    todo = jobs()
    for rel in {r for r, _ in todo}:
        os.makedirs(os.path.join(OPT_FIX, rel, "Cropped"), exist_ok=True)
        os.makedirs(os.path.join(OPT_FIX, rel, "Comparison"), exist_ok=True)
        os.makedirs(os.path.join(PRINT_FIX, rel, "Cropped"), exist_ok=True)
    print("paintings:", len(todo), flush=True)
    new_log = not os.path.exists(LOG)
    done = errors = 0
    with open(LOG, "a", newline="") as fh, Pool(int(sys.argv[1]) if len(sys.argv) > 1 else 3) as pool:
        wr = csv.writer(fh)
        if new_log:
            wr.writerow(("folder", "file", "optimised", "printable", "target", "x0", "y0", "x1", "y1", "status"))
        for i, row in enumerate(pool.imap_unordered(work, todo, chunksize=2), 1):
            if row:
                wr.writerow(row)
                fh.flush()
                done += 1
                if row[-1] != "ok":
                    errors += 1
                    print("ERROR", row[0], row[1], row[-1], flush=True)
            if i % 100 == 0 or i == len(todo):
                print(f"{i}/{len(todo)} cropped {done} errors {errors}", flush=True)
