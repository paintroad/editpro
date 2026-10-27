"""Take paintings out of the catalog: delete their rows and move their Oriented, Upscaled and Raw
files to ~/.editpro/pipeline-prep/deleted so neither the sync nor the Raw import brings them back.

    py -3 remove_paintings.py pinterest_206 nakhrro_27 ...
"""
import os, shutil, sqlite3, sys
from prep_paths import DB_PATH, PREP, catalog_root

root = catalog_root()
bin_dir = os.path.join(PREP, "deleted")
os.makedirs(bin_dir, exist_ok=True)
with sqlite3.connect(DB_PATH) as db:
    for n in sys.argv[1:]:
        row = db.execute("SELECT file, upscaled_file, source_path FROM images WHERE name = ?", (n,)).fetchone()
        if not row:
            print(n, "not in catalog")
            continue
        file, up, src = row
        for rel, label in ((file, "oriented"), (up, "upscaled"), (f"Raw/{src}" if src else None, "raw")):
            p = os.path.join(root, rel) if rel else None
            if p and os.path.exists(p):
                shutil.move(p, os.path.join(bin_dir, f"{n} - {label}{os.path.splitext(p)[1]}"))
                print(n, "moved", rel)
        for table in ("images", "crop_skips", "raw_skips"):
            if "name" in [r[1] for r in db.execute(f"PRAGMA table_info({table})")]:
                db.execute(f"DELETE FROM {table} WHERE name = ?", (n,))
        print(n, "removed")
