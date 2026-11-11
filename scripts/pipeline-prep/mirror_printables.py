"""Give the printables the same correction layout as the optimised files, then repoint the prep
database (images.file / images.upscaled_file) at wherever each file now lives.

    py -3 mirror_printables.py
"""
import json, os, shutil, sqlite3

DL = r"C:\Users\divya\Downloads"
OPT = os.path.join(DL, "_Existing Catalog Optimised")
PRINT = os.path.join(DL, "_Existing Catalog Printables")
OPT_FIX = os.path.join(DL, "_Existing Catalog Correction")
PRINT_FIX = os.path.join(DL, "_Existing Catalog Printables Correction")
DB = os.path.expanduser(r"~\.editpro\pipeline-prep\catalog.db")
INDEX = os.path.expanduser(r"~\.editpro\pipeline-prep\catalog-file-index.json")


def walk(root):
    out = {}
    for d, _, names in os.walk(root):
        for n in names:
            if not n.lower().endswith(".csv"):
                out[os.path.splitext(n)[0]] = os.path.join(d, n)
    return out


prints = {os.path.splitext(f)[0]: os.path.join(PRINT, f) for f in os.listdir(PRINT) if os.path.isfile(os.path.join(PRINT, f))}
moved, missing = 0, []
for stem, p in walk(OPT_FIX).items():
    rel = os.path.relpath(os.path.dirname(p), OPT_FIX)
    src = prints.get(stem)
    if not src:
        if not os.path.exists(os.path.join(PRINT_FIX, rel)) or stem not in walk(os.path.join(PRINT_FIX, rel)):
            missing.append(stem)
        continue
    dest = os.path.join(PRINT_FIX, rel)
    os.makedirs(dest, exist_ok=True)
    shutil.move(src, os.path.join(dest, os.path.basename(src)))
    moved += 1
print("printables moved to correction:", moved, "| without printable:", missing[:10], len(missing))

opt_all = {**walk(OPT), **walk(OPT_FIX)}
print_all = {**walk(PRINT), **walk(PRINT_FIX)}
opt_only = set(opt_all) - set(print_all)
print_only = set(print_all) - set(opt_all)
print("optimised without printable:", len(opt_only), "| printable without optimised:", len(print_only))
json.dump({"optimised": opt_all, "printable": print_all}, open(INDEX, "w"), indent=0)

old = ("_New Catalog Optimised", "_New Catalog Printable Files", "_New Catalog\\Output")
with sqlite3.connect(DB) as db:
    rows = db.execute("SELECT name, product_id, file, upscaled_file FROM images WHERE product_id IS NOT NULL").fetchall()
    n = 0
    for name, pid, f, up in rows:
        if not any(o in (f or "") + (up or "") for o in old):
            continue
        nf, nu = opt_all.get(str(pid), f), print_all.get(str(pid), up)
        if (nf, nu) != (f, up):
            db.execute("UPDATE images SET file = ?, upscaled_file = ? WHERE name = ?", (nf, nu, name))
            n += 1
print("prep database rows repointed:", n)
print("index:", INDEX)
