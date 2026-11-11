"""Copy paintings marked 'crop fine, printable wrong' into one folder per Topaz model for diagnosis.

The Topaz model per painting was never logged; it is rebuilt from the rules the bulk runs used.
Read-only on the catalog: only copies files and writes close-up sheets into OUT.
"""
import csv, json, os, re, shutil, sqlite3, sys
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None
P = os.path.expanduser(r"~\.editpro\pipeline-prep")
OUT = os.path.join(os.path.expanduser(r"~\Downloads"), "_Printable Issues")
FIRST, LAST = 13216, 14030

PIN_LOW = {7, 8, 11, 21, 25, 29, 30, 32, 33, 36, 37, 39, 40, 44, 48, 49, 58, 59, 60, 61, 63, 68, 70, 71, 76, 77, 80,
           81, 83, 85, 86, 91, 92, 93, 97, 99, 100, 101, 103, 105, 111, 113, 114, 117, 118, 121, 124, 125, 138, 139,
           140, 142, 143, 145, 148, 152, 155, 159, 160, 161, 168, 176, 178, 181, 182, 191, 194, 196, 197, 199, 204,
           135, 175, 110, 43, 89}
LOWRES_FIXED = {"atrang_41", "atrang_133", "atrang_100", "atrang_127"}
OWN = {"nakhrro_34", "nakhrro_86", "nakhrro_296", "nakhrro_312", "nakhrro_170_sq"}
WONDER_SMALL_SETS = {"hanuman": {16, 27, 28, 40, 41, 42, 43}, "rrv": {6}}

M_WONDER, M_LOW, M_CGI = "Wonder 3.5 high", "Low Resolution V2", "Art & CGI"
M_NONE, M_OWN = "Not upscaled (original)", "Own upscale (supplied)"
M_LARGE = "Large batch - Wonder high or Low Res or Art & CGI (split not logged)"
M_SMALL_NAK = "Low Resolution V2 or Art & CGI (small source)"


def model_for(name, brand, w, h, scale):
    num = re.search(r"(\d+)(_sq)?$", name)
    num = int(num.group(1)) if num else -1
    if name in OWN:
        return M_OWN
    if scale is None or scale < 1.05:
        return M_NONE
    if brand in WONDER_SMALL_SETS:
        return M_WONDER if num in WONDER_SMALL_SETS[brand] else M_NONE
    if brand == "warli_art":
        return M_CGI
    if brand == "pinterest":
        return M_LOW if num in PIN_LOW or scale > 6.05 else M_WONDER
    if name in LOWRES_FIXED:
        return M_LOW
    if scale > 6.05:
        return M_LOW if brand == "atrang" else M_SMALL_NAK
    if w * h >= 20e6 or max(w, h) >= 2000:
        return M_LARGE
    return M_WONDER


def safe(s):
    return re.sub(r'[<>:"/\\|?*]', "-", s).strip() or "Uncategorised"


STYLES = ["Thangka", "Pattachitra", "Pichwai", "Tanjore", "Kalamkari", "Madhubani", "Gond", "Kalighat", "Phad",
          "Warli", "Ragamala", "Indo-Mughal", "Mughal", "Indian Miniature", "Raja Ravi Verma", "Vintage Indian"]
ALIASES = {"Patchitra": "Pattachitra", "Ragmala": "Ragamala"}
GENERIC = {"Paintings", "Others", "Ramayana", "Vastu"}


def art_for(cats, tags):
    names = []
    for c in cats + tags:
        c = re.sub(r" Art$", "", c or "")
        names.append(ALIASES.get(c, c))
    for s in STYLES:
        if s in names:
            return s
    for c in names:
        if c and c not in GENERIC:
            return c
    return "Uncategorised"


FONT = ImageFont.truetype("arial.ttf", 20)
CROP = 600


def closeup(opt_path, prt_path, out, label):
    prt = Image.open(prt_path).convert("RGB")
    opt = Image.open(opt_path).convert("RGB")
    pw, ph = prt.size
    c = min(CROP, pw, ph)
    small = np.asarray(prt.resize((max(1, pw // 4), max(1, ph // 4))).convert("L"))
    k = cv2.blur(np.abs(cv2.Laplacian(small, cv2.CV_32F)), (c // 4, c // 4))
    m = c // 8
    k[:m], k[-m:], k[:, :m], k[:, -m:] = 0, 0, 0, 0
    y, x = np.unravel_index(np.argmax(k), k.shape)
    x0 = int(min(max(0, x * 4 - c // 2), pw - c))
    y0 = int(min(max(0, y * 4 - c // 2), ph - c))
    box = (x0, y0, x0 + c, y0 + c)
    sx, sy = opt.width / pw, opt.height / ph
    up = opt.crop((box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy)).resize((c, c), Image.LANCZOS)
    sheet = Image.new("RGB", (c * 2 + 12, c + 60), (25, 25, 25))
    sheet.paste(up, (0, 60))
    sheet.paste(prt.crop(box), (c + 12, 60))
    d = ImageDraw.Draw(sheet)
    d.text((6, 4), label, fill="white", font=FONT)
    d.text((6, 32), "Left: optimised, plain enlargement    Right: printable (Topaz) at 100%", fill=(190, 190, 190), font=FONT)
    sheet.save(out, quality=90)


def main():
    statuses = set(sys.argv[1:]) or {"crop_only"}
    fb = json.load(open(os.path.join(P, "crop-review.json"), encoding="utf8"))
    items = json.load(open(os.path.join(P, "crop-review-items.json"), encoding="utf8")) + \
        json.load(open(os.path.join(P, "new-batch-items.json"), encoding="utf8"))
    idx = json.load(open(os.path.join(P, "catalog-file-index.json"), encoding="utf8"))
    final = json.load(open(os.path.join(P, "final-render.json"), encoding="utf8"))
    marked = {}
    for it in items:
        n = os.path.splitext(it["file"])[0]
        e = fb.get(it["key"], {})
        if n.isdigit() and FIRST <= int(n) <= LAST and e.get("status") in statuses:
            marked[n] = (it["key"], e["status"])

    db = sqlite3.connect(os.path.join(P, "catalog.db"))
    db.row_factory = sqlite3.Row
    rows = []
    for r in db.execute("select * from images"):
        n = r["product_id"]
        if n not in marked:
            continue
        w, h = r["width"], r["height"]
        scale = r["upscaled_width"] / w if r["upscaled_width"] and w else None
        model = model_for(r["name"], r["name"].rsplit("_", 1)[0], w, h, scale)
        art = art_for(json.loads(r["categories"] or "[]"), json.loads(r["collection_tags"] or "[]"))
        key, status = marked[n]
        fr = final.get(key, {})
        rows.append({"painting": n, "status": status, "model": model, "art": art,
                     "source_px": f"{w}x{h}", "upscale_x": round(scale, 2) if scale else "",
                     "printable_px": "x".join(map(str, fr.get("printable_px") or [])),
                     "optimised": fr.get("optimised") or idx["optimised"].get(n),
                     "printable": fr.get("printable") or idx["printable"].get(n)})

    missing = sorted(set(marked) - {r["painting"] for r in rows})
    os.makedirs(OUT, exist_ok=True)
    for i, r in enumerate(sorted(rows, key=lambda r: r["painting"]), 1):
        d = os.path.join(OUT, safe(r["model"]))
        os.makedirs(d, exist_ok=True)
        n = r["painting"]
        opt, prt = r["optimised"], r["printable"]
        if not (opt and prt and os.path.exists(opt) and os.path.exists(prt)):
            print("files missing for", n)
            continue
        shutil.copy2(opt, os.path.join(d, f"{n} - 1 optimised.jpg"))
        shutil.copy2(prt, os.path.join(d, f"{n} - 2 printable.jpg"))
        label = f"{n}  |  {r['model']}  |  {r['art']}  |  {r['source_px']} -> {r['printable_px']} ({r['upscale_x']}x)"
        closeup(opt, prt, os.path.join(d, f"{n} - 3 closeup.jpg"), label)
        print(f"{i}/{len(rows)} {n} -> {r['model']} / {r['art']}", flush=True)

    with open(os.path.join(OUT, "index.csv"), "w", newline="", encoding="utf8") as f:
        wr = csv.DictWriter(f, fieldnames=[k for k in rows[0] if k not in ("optimised", "printable")], extrasaction="ignore")
        wr.writeheader()
        wr.writerows(sorted(rows, key=lambda r: (r["model"], r["art"], r["painting"])))
    print("not in catalog.db:", missing)


if __name__ == "__main__":
    main()
