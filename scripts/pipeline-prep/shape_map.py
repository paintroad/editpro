"""Painting number -> final shape for the existing catalog, written to ~/.editpro/lifestyle-sets/shapes.json.
Exact files are measured; files in correction take their crop target (or their own shape if not planned)."""
import json, os, re
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

HOME = os.path.expanduser("~")
EXACT = r"C:\Users\divya\Downloads\_Existing Catalog Optimised"
CORR = r"C:\Users\divya\Downloads\_Existing Catalog Correction"
ITEMS = os.path.join(HOME, ".editpro", "pipeline-prep", "crop-review-items.json")
OUT = os.path.join(HOME, ".editpro", "lifestyle-sets", "shapes.json")


def name_for(r):
    if abs(r - 1) < 0.05:
        return "square"
    if r < 1:
        return "portrait 9:16" if r < 0.66 else "portrait"
    return "landscape 16:9" if r > 1.55 else "landscape"


shapes = {}
for f in os.listdir(EXACT):
    m = re.match(r"(\d+)", f)
    if m:
        w, h = Image.open(os.path.join(EXACT, f)).size
        shapes[m.group(1)] = name_for(w / h)
planned = {}
for it in json.load(open(ITEMS, encoding="utf8")):
    planned[re.match(r"(\d+)", it["file"]).group(1)] = name_for(it["target"])
for root, _, files in os.walk(CORR):
    if os.path.basename(root) in ("Cropped", "Comparison"):
        continue
    for f in files:
        m = re.match(r"(\d+)", f)
        if not m or m.group(1) in shapes:
            continue
        n = m.group(1)
        if n in planned:
            shapes[n] = planned[n]
        else:
            w, h = Image.open(os.path.join(root, f)).size
            shapes[n] = name_for(w / h)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(shapes, open(OUT, "w"))
print(len(shapes))
