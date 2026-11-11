"""Splits the final check into four groups, using the live Shopify snapshot from fetch_live_products.js.

  reviewed  paintings already in the final check, plus every older delete
  sets      split panels (11456A, 11505C, ...), not going live
  pending   live paintings never final-checked: old "border" ones from the crop review, and live paintings
            that were never in the review (added to pending-items.json)
Paintings with no active product stay in these groups; the review page marks them as not on the store.
Writes review-groups.json and pending-items.json in ~/.editpro/pipeline-prep. Run again after the store changes;
existing feedback is kept, a painting only changes group.
"""
import json, os, re, csv
from PIL import Image, ImageOps

import apply_review_notes as A

Image.MAX_IMAGE_PIXELS = None
LIVE = os.path.join(A.PREP, "live-products.json")
NEW_ITEMS = os.path.join(A.PREP, "new-batch-items.json")
PENDING_ITEMS = os.path.join(A.PREP, "pending-items.json")
GROUPS = os.path.join(A.PREP, "review-groups.json")
INDEX = os.path.join(A.PREP, "catalog-file-index.json")
SPLIT = re.compile(r"^\d{5}[A-Z]$")


def load(path, fallback):
    return json.load(open(path, encoding="utf8")) if os.path.exists(path) else fallback


def in_final(it, e):
    s = e.get("status")
    return s in ("approved", "crop_only") or bool(e.get("checked") or e.get("recheck") or e.get("revised")) or (bool(it.get("path")) and not s)


def size(path):
    with Image.open(path) as im:
        w, h = im.size
        return (h, w) if im.getexif().get(0x0112, 1) >= 5 else (w, h)


def centre_frac(w, h):
    """Largest centred 3:4 / 4:3 / 1:1 window: the shape the crop review would aim for."""
    r = w / h
    target = 1.0 if abs(r - 1) < 0.08 else 3 / 4 if r < 1 else 4 / 3
    if r > target:
        cw = target / r
        return [round((1 - cw) / 2, 4), 0, round((1 + cw) / 2, 4), 1], target
    ch = r / target
    return [0, round((1 - ch) / 2, 4), 1, round((1 + ch) / 2, 4)], target


def main():
    live = load(LIVE, None)
    if live is None:
        raise SystemExit("Run fetch_live_products.js first.")
    active = {p["number"] for p in live if p["status"] == "ACTIVE" and p["number"]}
    fb = load(A.FEEDBACK, {})
    items = load(A.ITEMS, []) + load(NEW_ITEMS, [])
    ratio = {os.path.splitext(r["file"])[0].upper(): r for r in csv.DictReader(open(os.path.join(A.PREP, "existing-ratio-check.csv"), encoding="utf8"))}
    idx = load(INDEX, {})

    groups = {"reviewed": [], "sets": [], "pending": []}
    # A painting stays in its group once placed, so a decision made in a group never moves it out.
    before = {k: g for g, keys in load(GROUPS, {}).items() for k in keys}
    known = set()
    for it in items:
        n = A.stem(it["file"]).upper()
        known.add(n)
        e = fb.get(it["key"], {})
        s = e.get("status")
        if before.get(it["key"]) in groups:
            groups[before[it["key"]]].append(it["key"])
        elif SPLIT.match(n) and n not in active:
            groups["sets"].append(it["key"])
        elif s == "delete" or in_final(it, e):
            groups["reviewed"].append(it["key"])
        else:
            groups["pending"].append(it["key"])

    old = {i["key"]: i for i in load(PENDING_ITEMS, [])}
    pending_items = []
    for n in sorted(active - known):
        opt = idx.get("optimised", {}).get(n)
        if not opt or not os.path.exists(opt):
            print("no optimised file for live painting", n)
            continue
        folder = os.path.basename(os.path.dirname(opt))
        key = f"Pending/{os.path.basename(opt)}"
        it = old.get(key)
        if not it:
            w, h = size(opt)
            frac, target = centre_frac(w, h)
            no_crop = ratio.get(n, {}).get("result") == "ok" or frac == [0, 0, 1, 1]
            it = {"key": key, "folder": "Never reviewed - exact ratio, no crop needed" if no_crop else f"Never reviewed - crop not done ({folder})",
                  "file": os.path.basename(opt), "path": opt, "edge": "", "w": w, "h": h,
                  "target": round(w / h, 4) if no_crop else target, "frac": [0, 0, 1, 1] if no_crop else frac}
        pending_items.append(it)
        groups[before.get(key) if before.get(key) in groups else "pending"].append(key)

    json.dump(pending_items, open(PENDING_ITEMS, "w", encoding="utf8"), indent=1)
    json.dump(groups, open(GROUPS, "w", encoding="utf8"), indent=1)
    for g, v in groups.items():
        print(f"{g}: {len(v)}")
    print(f"pending items added: {len(pending_items)}")


if __name__ == "__main__":
    main()
