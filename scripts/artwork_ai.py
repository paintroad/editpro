"""AI artwork pipeline helper: Raw -> AI (+ AI Compare) -> Oriented -> Upscaled.

  register --root R             name new Raw images (<brand>_<n>) and record them in catalog.db
  compare  --root R [--label L] [--before original|oriented] NAME...
                                build AI Compare/<name>.jpg (original or current final | AI) and mark it for review
  feedback --root R             list images with review feedback, as JSON
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

Image.MAX_IMAGE_PIXELS = None
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
RAW, AI, COMPARE, ORIENTED = "Raw", "AI", "AI Compare", "Oriented"
ORIGINALS = os.path.join("_ai_work", "originals")
COLUMNS = {
    "review_status": "TEXT", "review_note": "TEXT", "last_feedback": "TEXT",
    "reviewed_at": "TEXT", "ai_at": "TEXT", "compare_at": "TEXT",
    "crop_technique": "TEXT", "crop_applied": "TEXT",
}


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def emit(**row):
    print(json.dumps(row), flush=True)


def open_db(root):
    db = sqlite3.connect(os.path.join(root, "catalog.db"), timeout=10)
    db.row_factory = sqlite3.Row
    have = {r[1] for r in db.execute("PRAGMA table_info(images)")}
    for name, kind in COLUMNS.items():
        if name not in have:
            db.execute(f"ALTER TABLE images ADD COLUMN {name} {kind}")
    return db


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_") or "image"


def find(folder, stem):
    if not os.path.isdir(folder):
        return None
    for f in os.listdir(folder):
        if os.path.splitext(f)[0] == stem and os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS:
            return os.path.join(folder, f)
    return None


def image_size(path):
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            return im.size
    except Exception:
        return (None, None)


def register(root):
    db = open_db(root)
    known = {r["source_path"] for r in db.execute("SELECT source_path FROM images WHERE source_path IS NOT NULL")}
    used = {}
    for (name,) in db.execute("SELECT name FROM images"):
        m = re.fullmatch(r"(.+)_(\d+)", name)
        if m:
            used[m[1]] = max(used.get(m[1], 0), int(m[2]))
    raw_root = os.path.join(root, RAW)
    todo = []
    for dirpath, _, files in os.walk(raw_root):
        for f in sorted(files):
            if os.path.splitext(f)[1].lower() not in IMAGE_EXTENSIONS:
                continue
            rel = os.path.relpath(os.path.join(dirpath, f), raw_root).replace("\\", "/")
            if rel not in known:
                todo.append(rel)
    todo.sort(key=lambda p: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p)])
    emit(type="start", total=len(todo))
    counts = {"done": 0}
    for rel in todo:
        parts = rel.split("/")
        brand = slug(parts[0]) if len(parts) > 1 else "image"
        used[brand] = used.get(brand, 0) + 1
        name = f"{brand}_{used[brand]}"
        w, h = image_size(os.path.join(raw_root, rel))
        db.execute(
            "INSERT INTO images (name, brand, categories, source_file, source_path, stage, file, source_width,"
            " source_height, width, height, review_status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (name, brand, json.dumps(parts[1:-1]), parts[-1], rel, "raw", f"{RAW}/{rel}", w, h, w, h, None, now()),
        )
        counts["done"] += 1
        emit(type="file", path=rel, status="done", name=name)
    db.commit()
    emit(type="done", counts=counts)


def original_path(root, row):
    if row["source_path"]:
        p = os.path.join(root, RAW, row["source_path"])
        if os.path.exists(p):
            return p
    return find(os.path.join(root, ORIGINALS), row["name"])


def comparison(original, ai, stem, label, out, left="ORIGINAL"):
    font = ImageFont.truetype("arialbd.ttf", 40)
    a = ImageOps.exif_transpose(Image.open(original)).convert("RGB")
    b = Image.open(ai).convert("RGB")
    ratio = b.width / b.height
    shape = "1:1" if abs(ratio - 1) < 0.02 else ("4:3" if ratio > 1 else "3:4")
    H, gap, bar = 1200, 40, 70
    a = a.resize((round(a.width * H / a.height), H), Image.LANCZOS)
    b = b.resize((round(b.width * H / b.height), H), Image.LANCZOS)
    im = Image.new("RGB", (a.width + b.width + gap * 3, H + bar + gap), "white")
    im.paste(a, (gap, bar))
    im.paste(b, (gap * 2 + a.width, bar))
    d = ImageDraw.Draw(im)
    d.text((gap, 12), f"{stem}  {left}", fill="black", font=font)
    d.text((gap * 2 + a.width, 12), f"AI {shape}" + (f" ({label})" if label else ""), fill="black", font=font)
    im.save(out, quality=90)


def compare(root, names, label, before="original"):
    db = open_db(root)
    os.makedirs(os.path.join(root, COMPARE), exist_ok=True)
    emit(type="start", total=len(names))
    counts = {"done": 0, "skipped": 0}
    for name in names:
        row = db.execute("SELECT * FROM images WHERE name=?", (name,)).fetchone()
        ai = find(os.path.join(root, AI), name)
        if before == "oriented":
            original = find(os.path.join(root, ORIENTED), name)
        else:
            original = original_path(root, row) if row else None
        if not row or not ai or not original:
            reason = "not registered" if not row else "no AI image" if not ai else f"{before} not found"
            counts["skipped"] += 1
            emit(type="file", path=name, status="skipped", name=name, reason=reason)
            continue
        left = "CURRENT FINAL" if before == "oriented" else "ORIGINAL"
        comparison(original, ai, name, label, os.path.join(root, COMPARE, name + ".jpg"), left)
        w, h = image_size(ai)
        stamp = now()
        db.execute(
            "UPDATE images SET stage='ai', file=?, width=?, height=?, ai_at=?, compare_at=?, review_status='pending',"
            " last_feedback=CASE WHEN review_status='feedback' THEN review_note ELSE last_feedback END,"
            " review_note=NULL, updated_at=? WHERE name=?",
            (f"{AI}/{os.path.basename(ai)}", w, h, stamp, stamp, stamp, name),
        )
        counts["done"] += 1
        emit(type="file", path=name, status="done", name=name)
    db.commit()
    emit(type="done", counts=counts)


def feedback(root):
    db = open_db(root)
    rows = db.execute(
        "SELECT name, review_note, source_path FROM images WHERE review_status='feedback' ORDER BY name"
    ).fetchall()
    print(json.dumps([dict(r) for r in rows], indent=1))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["register", "compare", "feedback"])
    p.add_argument("names", nargs="*")
    p.add_argument("--root", required=True)
    p.add_argument("--label", default="")
    p.add_argument("--before", choices=["original", "oriented"], default="original")
    a = p.parse_args()
    root = os.path.abspath(a.root)
    if a.command == "register":
        register(root)
    elif a.command == "compare":
        compare(root, a.names, a.label, a.before)
    else:
        feedback(root)


if __name__ == "__main__":
    sys.exit(main())
