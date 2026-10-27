"""AI outpainting helper for artwork that is off the 3:4 / 4:3 ratio.

prep:    place each original, unscaled, in the centre of a 3:4 or 4:3 canvas with flat grey
         margins and save a small reference copy for the image model, plus a manifest.
compose: take the model's output for each canvas, scale it to the full canvas size, paste the
         original pixels back over the centre (feathered edge) and write the result plus a
         side-by-side comparison.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None
GREY = (128, 128, 128)
REF_MAX = 1536
FEATHER = 0.012
MAX_DRIFT = 20
EXTS = (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp")


def canvas_size(w, h):
    ratio = 3 / 4 if h >= w else 4 / 3
    if w / h > ratio:
        return w, round(w / ratio), ratio
    return round(h * ratio), h, ratio


def white_box(im, level=236, share=0.97, cap=0.1):
    """Crop box that drops plain white rows/columns around the painting (at most `cap` per side)."""
    a = np.asarray(im.convert("L")) >= level
    h, w = a.shape

    def run(lines, limit):
        n = 0
        while n < limit and lines[n].mean() >= share:
            n += 1
        return n

    l, r = run(a.T, int(w * cap)), run(a.T[::-1], int(w * cap))
    t, b = run(a, int(h * cap)), run(a[::-1], int(h * cap))
    return l, t, w - r, h - b


def prep(src_dir, work_dir, names=None, trim=False):
    refs = os.path.join(work_dir, "refs")
    os.makedirs(refs, exist_ok=True)
    manifest = {}
    for f in sorted(os.listdir(src_dir)):
        stem, ext = os.path.splitext(f)
        if ext.lower() not in EXTS or (names and stem not in names):
            continue
        im = Image.open(os.path.join(src_dir, f)).convert("RGB")
        box = white_box(im) if trim else (0, 0) + im.size
        im = im.crop(box)
        w, h = im.size
        cw, ch, ratio = canvas_size(w, h)
        if abs(cw - w) <= w * 0.005 and abs(ch - h) <= h * 0.005:
            cw, ch = w, h
        x, y = (cw - w) // 2, (ch - h) // 2
        scale = min(1.0, REF_MAX / max(cw, ch))
        canvas = Image.new("RGB", (round(cw * scale), round(ch * scale)), GREY)
        canvas.paste(im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS),
                     (round(x * scale), round(y * scale)))
        canvas.save(os.path.join(refs, stem + ".jpg"), quality=92)
        manifest[stem] = {"file": f, "size": [w, h], "canvas": [cw, ch], "offset": [x, y],
                          "aspect": "3:4" if ratio < 1 else "4:3", "box": list(box),
                          "fits": (cw, ch) == (w, h)}
        im.close()
    with open(os.path.join(work_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
    fits = sum(m["fits"] for m in manifest.values())
    print(len(manifest), "prepared,", fits, "already in ratio after trim")


def feather_mask(w, h, edge):
    ramp = lambda n: np.clip(np.minimum(np.arange(n) + 1, np.arange(n)[::-1] + 1) / max(edge, 1), 0, 1)
    return Image.fromarray((np.outer(ramp(h), ramp(w)) * 255).astype(np.uint8), "L")


def edge_drift(gen, orig, x, y):
    """Mean grey difference along the original's outer ring between the original and the model's
    output at the same place. High values mean the model moved the painting or redrew its frame."""
    f = 8
    w, h = orig.size
    G = np.asarray(gen.crop((x, y, x + w, y + h)).convert("L").resize((max(1, w // f), max(1, h // f))), float)
    O = np.asarray(orig.convert("L").resize((max(1, w // f), max(1, h // f))), float)
    k = max(2, min(O.shape) // 20)
    ring = np.zeros(O.shape, bool)
    ring[:k] = ring[-k:] = True
    ring[:, :k] = ring[:, -k:] = True
    return float(np.abs(G - O)[ring].mean())


def write(im, path, src_info):
    ext = os.path.splitext(path)[1].lower()
    icc = src_info.get("icc_profile")
    kw = {"icc_profile": icc} if icc else {}
    if ext in (".jpg", ".jpeg"):
        im.save(path, quality=95, subsampling=0, **kw)
    elif ext in (".tif", ".tiff"):
        im.save(path, compression="tiff_lzw", **kw)
    elif ext == ".webp":
        im.save(path, quality=95, **kw)
    else:
        im.save(path, **kw)


def compose(src_dir, work_dir, gen_dir, out_dir, compare_dir, names):
    with open(os.path.join(work_dir, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(compare_dir, exist_ok=True)
    font = ImageFont.truetype("arialbd.ttf", 40)
    done, missing = [], []
    report_path = os.path.join(work_dir, "report.json")
    report = json.load(open(report_path, encoding="utf-8")) if os.path.exists(report_path) else {}
    for stem, m in manifest.items():
        if names and stem not in names:
            continue
        gen = next((os.path.join(gen_dir, stem + "_gen" + e) for e in (".jpg", ".png", ".webp")
                    if os.path.exists(os.path.join(gen_dir, stem + "_gen" + e))), None)
        if not gen and not m.get("fits"):
            missing.append(stem)
            continue
        src = Image.open(os.path.join(src_dir, m["file"]))
        info = dict(src.info)
        full = src.convert("RGB")
        orig = full.crop(tuple(m["box"])) if "box" in m else full
        cw, ch = m["canvas"]
        x, y = m["offset"]
        w, h = m["size"]
        if m.get("fits"):
            out, kept, drift = orig.copy(), True, 0.0
        else:
            out = Image.open(gen).convert("RGB").resize((cw, ch), Image.LANCZOS)
            drift = edge_drift(out, orig, x, y)
            kept = drift <= MAX_DRIFT
            if kept:
                edge = max(2, round(FEATHER * max(w, h)))
                out.paste(orig, (x, y), feather_mask(w, h, edge))
        write(out, os.path.join(out_dir, m["file"]), info)
        report[stem] = {"original_kept": kept, "edge_drift": round(drift, 1), "aspect": m["aspect"]}

        H, gap, bar = 1200, 40, 70
        w, h = full.size
        a = full.resize((round(w * H / h), H), Image.LANCZOS)
        b = out.resize((round(cw * H / ch), H), Image.LANCZOS)
        cmp_im = Image.new("RGB", (a.width + b.width + gap * 3, H + bar + gap), "white")
        cmp_im.paste(a, (gap, bar))
        cmp_im.paste(b, (gap * 2 + a.width, bar))
        dr = ImageDraw.Draw(cmp_im)
        dr.text((gap, 12), f"{stem}  ORIGINAL", fill="black", font=font)
        if m.get("fits"):
            label = "unchanged" if orig.size == full.size else "white edge trimmed"
        else:
            label = "original kept" if kept else "AI redrawn"
        dr.text((gap * 2 + a.width, 12), f"EXTENDED {m['aspect']} ({label})", fill="black", font=font)
        cmp_im.save(os.path.join(compare_dir, stem + ".jpg"), quality=90)
        done.append(stem)
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    print(json.dumps({"done": len(done), "missing": missing}))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=("prep", "compose"))
    p.add_argument("--src", required=True)
    p.add_argument("--work", required=True)
    p.add_argument("--gen", default="")
    p.add_argument("--out", default="")
    p.add_argument("--compare", default="")
    p.add_argument("--names", default="", help="comma-separated stems, or @file with one name per line")
    p.add_argument("--trim", action="store_true", help="drop plain white margins before extending")
    a = p.parse_args()
    if a.names.startswith("@"):
        with open(a.names[1:], encoding="utf-8") as fh:
            names = {os.path.splitext(n.strip())[0] for n in fh if n.strip()}
    else:
        names = set(filter(None, a.names.split(",")))
    if a.mode == "prep":
        prep(a.src, a.work, names, a.trim)
    else:
        compose(a.src, a.work, a.gen, a.out, a.compare, names)


if __name__ == "__main__":
    sys.exit(main())
