"""Printable model trials: upscale an already-cropped painting with one or more Topaz models for comparison.

    py -3 printable_trials.py 13712=hfv2 13616=lowres 10291=cgi 10714=text 13822=recover   submit and wait
    py -3 printable_trials.py --dry 13712=hfv2                                               inputs only, no Topaz

The approved crop recipe (crop window, fill, cover strips, cleaned file) is applied first, so the upscale
is the finished printable and needs no re-cropping. Recently uploaded paintings start from the source
before any Topaz; older catalog paintings start from their current printable. Output is 150 ppi at the
largest size sold (36", 48" for 16:9 and 9:16). Nothing in the catalog is overwritten.

Writes ~/.editpro/pipeline-prep/printable-trials/<n>/input.jpg, <n>/<model>.jpg and printable-trials.json
(model, parameters, sizes, credits and seconds per run), shown in EditPro under Review > Printables.
"""
import json, os, sys, time
import requests
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apply_review_notes as A
from crop_recipe import render
from prep_paths import PREP, topaz_key
from render_final import recipe_of, transfer_clean, upright_printable

BASE = "https://api.topazlabs.com/image/v1"
OUT = os.path.join(PREP, "printable-trials")
LOG = os.path.join(OUT, "printable-trials.json")
INDEX = os.path.join(PREP, "catalog-file-index.json")
NOFACE = {"face_enhancement": "false", "faceEnhancement": "false"}
MODELS = {
    "hfv2": ("High Fidelity V2", "enhance", {"model": "High Fidelity V2", **NOFACE}),
    "hfv3": ("High Fidelity V3", "enhance", {"model": "Upscale High Fidelity V3", **NOFACE}),
    "lowres": ("Low Resolution V2", "enhance", {"model": "Low Resolution V2", **NOFACE}),
    "cgi": ("Art & CGI", "enhance", {"model": "CGI", **NOFACE}),
    "text": ("Text Refine", "enhance", {"model": "Text Refine", **NOFACE}),
    "recover": ("Recover 3", "enhance-gen", {"model": "Recover 3", **NOFACE}),
}
NEW_FIRST, NEW_LAST = 13216, 14030


def long_in(t):
    return 48 if abs(t - 16 / 9) < 0.05 or abs(t - 9 / 16) < 0.05 else 36


def load_items():
    items = {}
    for f in (A.ITEMS, os.path.join(PREP, "new-batch-items.json"), os.path.join(PREP, "pending-items.json")):
        if os.path.exists(f):
            for it in json.load(open(f, encoding="utf8")):
                items[A.stem(it["file"])] = it
    return items


def make_input(n, item, entry, printable):
    """The cropped image to upscale and where it came from."""
    rec = recipe_of(item, entry)
    src = item.get("path") or os.path.join(A.ROOT, item["folder"], item["file"])
    original = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    if NEW_FIRST <= int(n) <= NEW_LAST:
        base = Image.open(rec["clean"]).convert("RGB") if rec.get("clean") else original
        return render(base, rec), "source (before Topaz)", rec
    own = rec.get("clean_printable")
    pim = ImageOps.exif_transpose(Image.open(own or printable)).convert("RGB")
    # a cleaned printable has the cleaned optimised file's framing (border fixes change the shape)
    ref = Image.open(rec["clean"]).convert("RGB") if own and rec.get("clean") else original
    pim, framing = upright_printable(pim, ref)
    if framing == "different":
        raise SystemExit(f"{n}: printable framing differs from the optimised file")
    if rec.get("clean") and not own:
        pim = transfer_clean(pim, original, Image.open(rec["clean"]).convert("RGB"))
    return render(pim, rec), "current printable", rec


def main(args):
    dry = "--dry" in args
    jobs = [a.split("=") for a in args if "=" in a]
    if not jobs or any(m not in MODELS for _, m in jobs):
        raise SystemExit(__doc__)
    items, fb = load_items(), json.load(open(A.FEEDBACK, encoding="utf8"))
    index = json.load(open(INDEX, encoding="utf8"))["printable"]
    log = json.load(open(LOG, encoding="utf8")) if os.path.exists(LOG) else {}
    headers = {"X-API-KEY": topaz_key()}

    def save():
        os.makedirs(OUT, exist_ok=True)
        json.dump(log, open(LOG + ".tmp", "w", encoding="utf8"), indent=1)
        os.replace(LOG + ".tmp", LOG)

    pending = []
    for n, mkey in jobs:
        item = items[n]
        entry = fb.get(item["key"], {})
        folder = os.path.join(OUT, n)
        os.makedirs(folder, exist_ok=True)
        row = log.setdefault(n, {"runs": {}})
        inp = os.path.join(folder, "input.jpg")
        if not os.path.exists(inp):
            im, base, rec = make_input(n, item, entry, index.get(n))
            im.save(inp, quality=95, subsampling=0)
            row.update(key=item["key"], base=base, target=rec.get("target") or item.get("target"),
                       input_px=list(im.size), recipe_frac=rec["frac"])
        w, h = row["input_px"]
        need = 150 * long_in(w / h)
        s = need / max(w, h)
        ow, oh = round(w * s), round(h * s)
        print(n, row["base"], f"{w}x{h} -> {ow}x{oh} ({s:.2f}x)", MODELS[mkey][0], flush=True)
        save()
        if dry:
            continue
        label, endpoint, params = MODELS[mkey]
        size = {"output_width": ow, "output_height": oh, "outputWidth": ow, "outputHeight": oh, "output_format": "jpeg"}
        with open(inp, "rb") as fh:
            r = requests.post(f"{BASE}/{endpoint}/async", headers=headers, files={"image": fh},
                              data={**params, **size}, timeout=300)
        if r.status_code >= 300:
            print(n, mkey, "SUBMIT FAILED:", r.status_code, r.text[:300], flush=True)
            row["runs"][mkey] = {"model": label, "error": f"{r.status_code} {r.text[:300]}"}
            save()
            continue
        row["runs"][mkey] = {"model": label, "endpoint": endpoint, "params": {k: v for k, v in params.items()},
                             "scale": round(s, 2), "out": [ow, oh], "process_id": r.json()["process_id"],
                             "submitted": time.time()}
        save()
        pending.append((n, mkey))

    while pending:
        for n, mkey in list(pending):
            v = log[n]["runs"][mkey]
            st = requests.get(f"{BASE}/status/{v['process_id']}", headers=headers, timeout=60).json()
            if st.get("status") == "Completed":
                url = requests.get(f"{BASE}/download/{v['process_id']}", headers=headers, timeout=60).json()["download_url"]
                dst = os.path.join(OUT, n, f"{mkey}.jpg")
                open(dst, "wb").write(requests.get(url, timeout=600).content)
                v.update(file=dst, got=list(Image.open(dst).size), credits=st.get("credits"),
                         seconds=round(time.time() - v["submitted"]))
                pending.remove((n, mkey))
                print(n, mkey, "done", v["seconds"], "s", v["got"], "credits", v["credits"], flush=True)
                save()
            elif st.get("status") in ("Failed", "Cancelled"):
                v.update(error=json.dumps(st)[:300])
                pending.remove((n, mkey))
                print(n, mkey, st.get("status"), st, flush=True)
                save()
        if pending:
            time.sleep(5)
    print("credits this run", sum((log[n]["runs"][m].get("credits") or 0) for n, m in jobs if not dry))


if __name__ == "__main__":
    main(sys.argv[1:])
