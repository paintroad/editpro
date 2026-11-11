"""Render the final files for every approved crop-review painting, for the final check in EditPro.

Applies the approved recipe (crop window, fill, cover strips, text removal) to the optimised file and the
same recipe to the printable file. Text removed on the optimised file is removed from the printable at the
same place. Printables saved sideways are turned to match first. No upscaling: a recipe's upscaled_printable
(made already cropped by printable_trials.py) is copied as the final printable unchanged.

    py -3 render_final.py [workers]     resumable; only paintings whose recipe changed are re-rendered

Writes  Downloads/_Catalog/LIVE/Optimised/<n>.<ext>, Downloads/_Catalog/LIVE/Printables/<n>.<ext>,
        ~/.editpro/pipeline-prep/final-previews/<n>.jpg (printable preview) and final-render.json.
"""
import hashlib, json, os, shutil, sys
from multiprocessing import Pool
import cv2
import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apply_review_notes as A
from crop_recipe import render

OUT = r"C:\Users\divya\Downloads\_Catalog\LIVE"
OUT_OPT = os.path.join(OUT, "Optimised")
OUT_PRT = os.path.join(OUT, "Printables")
PREVIEWS = os.path.join(A.PREP, "final-previews")
MANIFEST = os.path.join(A.PREP, "final-render.json")
INDEX = os.path.join(A.PREP, "catalog-file-index.json")
NEW_ITEMS = os.path.join(A.PREP, "new-batch-items.json")
PENDING_ITEMS = os.path.join(A.PREP, "pending-items.json")
PREVIEW_LONG = 1600
WORK_W = 1600
OPTIMISED_SIDE = 1600  # long side of an optimised file rebuilt from the printable (as in merge_catalogs.py)
FINAL = ("approved", "crop_only", "issue")


def recipe_of(item, entry):
    rec = dict(entry.get("recipe") or {})
    rec["frac"] = entry.get("frac") or rec.get("frac") or item["frac"]
    return rec


def signature(rec, printable):
    keep = {k: rec.get(k) for k in ("frac", "fill", "cover", "clean")}
    if rec.get("clean_printable"):
        keep["clean_printable"] = rec["clean_printable"]
    if rec.get("extend"):
        keep["extend"] = True
    if rec.get("from_printable"):
        keep["from_printable"] = OPTIMISED_SIDE
    if rec.get("upscaled_printable"):
        keep["upscaled_printable"] = rec["upscaled_printable"]
    keep["printable"] = printable
    keep["printable_time"] = os.path.getmtime(printable) if printable and os.path.exists(printable) else None
    return hashlib.sha1(json.dumps(keep, sort_keys=True).encode()).hexdigest()


def grey48(im):
    return np.asarray(im.convert("L").resize((48, 48)), np.int16)


def upright_printable(pim, opt):
    """Turn a printable saved in the other orientation; returns (image, 'same'|'rotated'|'different')."""
    ow, oh = opt.size
    pw, ph = pim.size
    if abs(pw / ph - ow / oh) <= 0.01:
        return pim, "same"
    if abs(ph / pw - ow / oh) > 0.01:
        return pim, "different"
    ref = grey48(opt)
    turns = [pim.transpose(Image.Transpose.ROTATE_270), pim.transpose(Image.Transpose.ROTATE_90)]
    best = min(turns, key=lambda t: np.abs(grey48(t) - ref).sum())
    return best, "rotated"


def transfer_clean(pim, original, cleaned):
    """Remove text from the printable in the rows where it was removed on the optimised file.

    The cleaned optimised file was re-saved, so it differs faintly everywhere; only strongly changed rows
    count. Inside those rows the text is found again on the printable itself, at full resolution."""
    a = np.asarray(original.convert("RGB"), np.int16)
    b = np.asarray(cleaned.convert("RGB"), np.int16)
    strong = (np.abs(a - b).max(axis=2) > 40).astype(np.uint8)
    changed = strong.mean(axis=1) > 0.01
    if not changed.any():
        return pim
    pw, ph = pim.size
    scale = ph / len(changed)
    k = max(3, int(round(scale * 3)) | 1)
    allowed = cv2.resize(cv2.dilate(strong * 255, np.ones((9, 9), np.uint8)), (pw, ph), interpolation=cv2.INTER_NEAREST)
    arr = np.asarray(pim.convert("RGB")).copy()
    mask = np.zeros((ph, pw), np.uint8)
    rows = np.where(changed)[0]
    spans, start = [], rows[0]
    for r0, r1 in zip(rows, rows[1:]):
        if r1 - r0 > 3:
            spans.append((start, r0 + 1))
            start = r1
    spans.append((start, rows[-1] + 1))
    for s0, s1 in spans:
        y0, y1 = max(0, int((s0 - 2) * scale)), min(ph, int((s1 + 2) * scale))
        band = arr[y0:y1].astype(np.int16)
        bg = np.median(band.reshape(-1, 3), axis=0)
        mask[y0:y1] = (np.abs(band - bg).max(axis=2) > A.DIFF).astype(np.uint8) * 255
    mask = cv2.dilate(mask & allowed, np.ones((k, k), np.uint8))
    hit = np.where(mask.any(axis=1))[0]
    if not len(hit):
        return pim
    pad = k * 4
    y0, y1 = max(0, hit[0] - pad), min(ph, hit[-1] + 1 + pad)
    band, bmask = arr[y0:y1], mask[y0:y1]
    # inpainting time grows with mask area x radius^2, so fill at working size and paste back the masked pixels
    f = min(1.0, WORK_W / pw)
    sw, sh = max(1, round(pw * f)), max(1, round((y1 - y0) * f))
    small = cv2.resize(band, (sw, sh), interpolation=cv2.INTER_AREA)
    smask = cv2.dilate(cv2.resize(bmask, (sw, sh), interpolation=cv2.INTER_NEAREST), np.ones((5, 5), np.uint8))
    fixed = cv2.inpaint(small, smask, 5, cv2.INPAINT_TELEA)
    big = cv2.resize(fixed, (pw, y1 - y0), interpolation=cv2.INTER_CUBIC)
    grown = cv2.dilate(bmask, np.ones((k, k), np.uint8))
    halo = cv2.dilate(grown, np.ones((k, k), np.uint8))
    soft = np.maximum(grown, cv2.GaussianBlur(halo, (0, 0), k / 2)).astype(np.float32)[..., None] / 255
    arr[y0:y1] = (band * (1 - soft) + big * soft).astype(np.uint8)
    return Image.fromarray(arr)


def save_like(im, dst, info):
    ext = os.path.splitext(dst)[1].lower()
    kw = {k: info[k] for k in ("dpi", "icc_profile") if k in info}
    if ext in (".jpg", ".jpeg"):
        im.convert("RGB").save(dst, quality=95, subsampling=0, **kw)
    else:
        im.save(dst, **kw)


def untouched(rec):
    return list(rec["frac"]) == [0, 0, 1, 1] and not any(
        rec.get(k) for k in ("fill", "cover", "clean", "extend", "from_printable", "upscaled_printable"))


def passthrough(key, item, rec, src, printable):
    """No edit to make: point at the original files (no re-save) and only write the preview."""
    n = A.stem(item["file"])
    row = {"painting": n, "optimised": src, "sig": signature(rec, printable), "frac": rec["frac"], "passthrough": True}
    if printable and os.path.exists(printable):
        raw = Image.open(printable)
        opt = Image.open(src)
        oriented = (raw.getexif().get(0x0112, 1) in (1, None)) and (opt.getexif().get(0x0112, 1) in (1, None))
        if not oriented or abs(raw.width / raw.height - opt.width / opt.height) > 0.01:
            return None
        prev = raw.convert("RGB")
        prev.thumbnail((PREVIEW_LONG, PREVIEW_LONG))
        preview = os.path.join(PREVIEWS, n + ".jpg")
        prev.save(preview, quality=85)
        row.update(printable=printable, preview=preview, printable_px=[raw.width, raw.height], framing="same",
                   clean_printable=False)
    return key, row


def work(job):
    key, item, entry, printable = job
    n = A.stem(item["file"])
    rec = recipe_of(item, entry)
    try:
        src = item.get("path") or os.path.join(A.ROOT, item["folder"], item["file"])
        if untouched(rec):
            done = passthrough(key, item, rec, src, printable)
            if done:
                return done
        original = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        opt_src = Image.open(rec["clean"]).convert("RGB") if rec.get("clean") else original
        if rec.get("from_printable") and printable and os.path.exists(printable):
            base = rec.get("clean_printable") or printable
            pim0, framing0 = upright_printable(ImageOps.exif_transpose(Image.open(base)).convert("RGB"), original)
            if framing0 != "different":
                side = max(max(original.size), min(OPTIMISED_SIDE, max(pim0.size)))
                s = side / max(pim0.size)
                opt_src = original = pim0.resize((round(pim0.width * s), round(pim0.height * s)), Image.LANCZOS)
        out_opt = os.path.join(OUT_OPT, item["file"])
        save_like(render(opt_src, rec), out_opt, Image.open(src).info)
        row = {"painting": n, "optimised": out_opt, "sig": signature(rec, printable), "frac": rec["frac"]}
        up = rec.get("upscaled_printable")
        if up and os.path.exists(up):
            # already cropped and cleaned before upscaling (printable_trials.py): used as it is
            final = Image.open(up).convert("RGB")
            out_prt = os.path.join(OUT_PRT, n + ".jpg")
            shutil.copyfile(up, out_prt)
            prev = final.copy()
            prev.thumbnail((PREVIEW_LONG, PREVIEW_LONG))
            preview = os.path.join(PREVIEWS, n + ".jpg")
            prev.save(preview, quality=85)
            row.update(printable=out_prt, preview=preview, printable_px=list(final.size), framing="same",
                       clean_printable=bool(rec.get("clean") or rec.get("clean_printable")), upscaled=True)
        elif printable and os.path.exists(printable):
            raw = Image.open(printable)
            info = raw.info
            own = rec.get("clean_printable")
            pim = ImageOps.exif_transpose(Image.open(own) if own else raw).convert("RGB")
            pim, framing = upright_printable(pim, original)
            if rec.get("clean") and not own:
                pim = transfer_clean(pim, original, opt_src)
            final = render(pim, rec)
            out_prt = os.path.join(OUT_PRT, n + os.path.splitext(printable)[1].lower())
            save_like(final, out_prt, info)
            prev = final.copy()
            prev.thumbnail((PREVIEW_LONG, PREVIEW_LONG))
            preview = os.path.join(PREVIEWS, n + ".jpg")
            prev.save(preview, quality=85)
            row.update(printable=out_prt, preview=preview, printable_px=list(final.size), framing=framing,
                       clean_printable=bool(rec.get("clean") or rec.get("clean_printable")))
        return key, row
    except Exception as ex:
        return key, {"painting": n, "error": str(ex)}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--only=")]
    only = {n for a in sys.argv[1:] if a.startswith("--only=") for n in a[7:].split(",")}
    workers = int(args[0]) if args else 4
    items = {i["key"]: i for i in json.load(open(A.ITEMS, encoding="utf8"))}
    fb = json.load(open(A.FEEDBACK, encoding="utf8"))
    if os.path.exists(NEW_ITEMS):
        # recently uploaded paintings that needed no crop are final unless rejected in the final check
        for it in json.load(open(NEW_ITEMS, encoding="utf8")):
            items[it["key"]] = it
            entry = fb.setdefault(it["key"], {})
            if not entry.get("status"):
                fb[it["key"]] = {**entry, "status": "approved"}
    if os.path.exists(PENDING_ITEMS):
        # live paintings never final-checked: rendered only once decided in the final check
        for it in json.load(open(PENDING_ITEMS, encoding="utf8")):
            items[it["key"]] = it
    index = json.load(open(INDEX, encoding="utf8"))["printable"]
    manifest = json.load(open(MANIFEST, encoding="utf8")) if os.path.exists(MANIFEST) else {}
    for d in (OUT_OPT, OUT_PRT, PREVIEWS):
        os.makedirs(d, exist_ok=True)
    jobs = []
    for key, e in fb.items():
        if e.get("status") not in FINAL:
            manifest.pop(key, None)
            continue
        it = items[key]
        if only and A.stem(it["file"]) not in only:
            continue
        p = index.get(A.stem(it["file"]))
        old = manifest.get(key)
        if old and not old.get("error") and old.get("sig") == signature(recipe_of(it, e), p):
            continue
        jobs.append((key, it, e, p))
    print("to render", len(jobs), flush=True)
    errors = 0
    with Pool(workers) as pool:
        for i, (key, row) in enumerate(pool.imap_unordered(work, jobs, chunksize=1), 1):
            old = manifest.get(key)
            # Source folders were removed after the catalog was consolidated: a failed re-render keeps the finished files.
            if row.get("error") and old and not old.get("error") and os.path.exists(old.get("optimised") or ""):
                errors += 1
                print("KEPT", row["painting"], row["error"], flush=True)
                continue
            manifest[key] = row
            if row.get("error"):
                errors += 1
                print("ERROR", row["painting"], row["error"], flush=True)
            if i % 50 == 0 or i == len(jobs):
                tmp = MANIFEST + ".tmp"
                json.dump(manifest, open(tmp, "w", encoding="utf8"), indent=1)
                os.replace(tmp, MANIFEST)
                print(f"{i}/{len(jobs)} errors {errors}", flush=True)
    tmp = MANIFEST + ".tmp"
    json.dump(manifest, open(tmp, "w", encoding="utf8"), indent=1)
    os.replace(tmp, MANIFEST)
    print("done", len(manifest), "rendered, errors", errors)


if __name__ == "__main__":
    main()
