"""Close a catalog cycle: move Oriented to the Optimised folder and Upscaled to the Printable folder,
then mark those paintings shipped so Pipeline Prep starts the next cycle empty.

    py -3 ship_cycle.py "<Optimised folder>" "<Printable folder>"        # dry run
    py -3 ship_cycle.py "<Optimised folder>" "<Printable folder>" --go

Paintings with no upscale get their Oriented file copied to the Printable folder so both match.
"""
import os, shutil, sqlite3, sys, time
from prep_paths import DB_PATH, PREP, folder, stems

args = [a for a in sys.argv[1:] if a != "--go"]
if len(args) != 2:
    raise SystemExit(__doc__)
optimised, printable = args
ori, ups = folder("Oriented"), folder("Upscaled")
ori_files, ups_files = stems(ori), stems(ups)

plan = []
for src, files, dst in ((ori, ori_files, optimised), (ups, ups_files, printable)):
    os.makedirs(dst, exist_ok=True)
    taken = {f.lower() for f in os.listdir(dst)}
    for f in files.values():
        if f.lower() in taken:
            raise SystemExit(f"{f} already exists in {dst}")
        plan.append((os.path.join(src, f), os.path.join(dst, f)))
no_upscale = sorted(set(ori_files) - set(ups_files))
print(f"Oriented {len(ori_files)}, Upscaled {len(ups_files)}, copied as printable without upscale: {len(no_upscale)}")
if "--go" not in sys.argv:
    raise SystemExit("Dry run. Add --go to move the files.")

backup = os.path.join(PREP, "backups", f"catalog_before_ship_{time.strftime('%Y%m%d_%H%M')}.db")
os.makedirs(os.path.dirname(backup), exist_ok=True)
shutil.copy2(DB_PATH, backup)
for n in no_upscale:
    shutil.copy2(os.path.join(ori, ori_files[n]), os.path.join(printable, ori_files[n]))
for src, dst in plan:
    shutil.move(src, dst)

stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
with sqlite3.connect(DB_PATH) as db:
    names = [r[0] for r in db.execute("SELECT name FROM images WHERE stage = 'oriented'")]
    for n in names:
        up = ups_files.get(n) or ori_files.get(n)
        db.execute("UPDATE images SET stage = 'shipped', file = ?, upscaled_file = ?, updated_at = ? WHERE name = ?",
                   (os.path.join(optimised, ori_files[n]) if n in ori_files else None,
                    os.path.join(printable, up) if up else None, stamp, n))
print(f"shipped {len(names)} paintings; catalog backup at {backup}")
