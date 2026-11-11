"""List the paintings that already have a Topaz upscale, for the Upscale yes/no buttons in the final check.

    py -3 list_topaz_upscaled.py

A painting counts when catalog.db has an upscaled file clearly larger than its oriented source (a same-size
copy is not an upscale). Writes ~/.editpro/pipeline-prep/topaz-upscaled.json (painting numbers).
"""
import json, os, sqlite3
from prep_paths import DB_PATH, PREP

OUT = os.path.join(PREP, "topaz-upscaled.json")

with sqlite3.connect(DB_PATH) as db:
    rows = db.execute("SELECT product_id, width, upscaled_width FROM images "
                      "WHERE product_id IS NOT NULL AND upscaled_file IS NOT NULL").fetchall()
numbers = sorted({str(p).upper() for p, w, uw in rows if w and uw and uw > 1.2 * w})
json.dump(numbers, open(OUT, "w", encoding="utf8"), indent=1)
print(len(numbers), "paintings with a Topaz upscale ->", OUT)
