"""Merge the new catalog into the existing catalog folders and keep only exact shapes there.

Exact = 3:4, 4:3 or square within EXACT_TRIM. Everything else goes to the correction folders
(same layout for optimised and printables), grouped by shape. EditPro's catalog store and prep
database are pointed at the new locations.

    py -3 merge_catalogs.py           # dry run
    py -3 merge_catalogs.py --apply
"""
import csv, os, shutil, sqlite3, sys
from collections import Counter
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
DL = r"C:\Users\divya\Downloads"
NEW_OPT = os.path.join(DL, "_New Catalog Optimised")
NEW_PRINT = os.path.join(DL, "_New Catalog Printable Files")
OPT = os.path.join(DL, "_Existing Catalog Optimised")
PRINT = os.path.join(DL, "_Existing Catalog Printables")
OPT_FIX = os.path.join(DL, "_Existing Catalog Correction")
PRINT_FIX = os.path.join(DL, "_Existing Catalog Printables Correction")
DB = os.path.expanduser(r"~\.editpro\pipeline-prep\catalog.db")
EXACT_TRIM = 0.005
OPTIMISED_SIDE = 1600  # for optimised copies made from a printable


def trim_to(w, h):
    r = max(w, h) / min(w, h)
    t = 1.0 if r <= 1.05 else 4 / 3
    return (1 - t / r) if r > t else (1 - r / t), t


def group_for(w, h):
    """Correction subfolder for a non-exact painting (None when exact)."""
    trim, t = trim_to(w, h)
    if trim <= EXACT_TRIM:
        return None
    r = max(w, h) / min(w, h)
    portrait = h > w
    if t == 1.0:
        return "Square - trim to exact"
    if abs(r / (4 / 3) - 1) <= 0.10:
        band = "Trim up to 2%" if trim <= 0.02 else "Trim 2-5%" if trim <= 0.05 else "Trim 5-10%"
        return os.path.join("3x4 and 4x3 - trim to exact", band)
    if r >= 1.95:
        return "Very long (2x1 and longer)"
    if r >= 1.65:
        return "9x16 Portrait" if portrait else "16x9 Landscape"
    if r >= 1.42:
        return "2x3 Portrait" if portrait else "3x2 Landscape"
    return "Near 3x4 - light crop"


def files_in(d):
    return {os.path.splitext(f)[0]: os.path.join(d, f) for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))}


def main():
    apply = "--apply" in sys.argv
    new_opt, new_print = files_in(NEW_OPT), files_in(NEW_PRINT)
    moves = []  # (src, dst)

    # 1. Transfer the new catalog (optimised made from the printable where it is missing).
    made = []
    for stem, p in new_print.items():
        moves.append((p, os.path.join(PRINT, os.path.basename(p))))
        if stem in new_opt:
            moves.append((new_opt[stem], os.path.join(OPT, os.path.basename(new_opt[stem]))))
        else:
            made.append((stem, p))

    # 2. Classify everything that will sit in the optimised root.
    sizes = {}
    for stem, p in files_in(OPT).items():
        sizes[stem] = (Image.open(p).size, os.path.basename(p), "existing")
    for stem, p in new_opt.items():
        sizes[stem] = (Image.open(p).size, os.path.basename(p), "new")
    for stem, p in made:
        sizes[stem] = (Image.open(p).size, stem + ".jpg", "new")
    plan, counts = {}, Counter()
    for stem, ((w, h), name, origin) in sizes.items():
        g = group_for(w, h)
        counts[(g or "exact - stays", origin)] += 1
        if g:
            plan[stem] = (g, name)
    for (g, origin), n in sorted(counts.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        print(f"{n:5d}  {origin:8s} {g}")
    print("optimised to create from printable:", [s for s, _ in made])
    if not apply:
        return

    for src, dst in moves:
        shutil.move(src, dst)
    for stem, p in made:
        with Image.open(os.path.join(PRINT, os.path.basename(p))) as im:
            im = im.convert("RGB")
            im.thumbnail((OPTIMISED_SIDE, OPTIMISED_SIDE), Image.LANCZOS)
            im.save(os.path.join(OPT, stem + ".jpg"), quality=92)
    for stem, (g, name) in plan.items():
        d = os.path.join(OPT_FIX, g)
        os.makedirs(d, exist_ok=True)
        shutil.move(os.path.join(OPT, name), os.path.join(d, name))
    print("moved to optimised correction:", len(plan))


if __name__ == "__main__":
    main()
