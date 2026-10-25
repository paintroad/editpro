"""
Extract only the artwork from product images (no frame, mat or paper margin).

Atrang: framed print on a white background, usually with a white mat.
Nakhrro: artwork scan with a plain coloured paper margin, or already full-bleed.

Usage:
  py -3 artwork-extract.py --input ROOT --pipeline [--brand auto|atrang|nakhrro] [--overwrite]
      Catalog pipeline: extracts ROOT/Raw/<Brand>/<categories...>/* into ROOT/Extracted as
      <brand>_N (raw file deleted), moves right-ratio images on to ROOT/Oriented, and records
      everything in ROOT/catalog.db.
  py -3 artwork-extract.py --input DIR --output DIR [--brand ...] [--prefix NAME]
                           [--sample N] [--seed N] [--overwrite] [--dry-run]
      One-off extraction into a mirrored folder tree (artwork-manifest.json records results).
Prints one JSON object per line: {"type": "start"|"file"|"done", ...}.
"""
import argparse
import json
import os
import random
import re
import sqlite3
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artwork_trim  # noqa: E402

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF = True
except Exception:
    HEIF = False

Image.MAX_IMAGE_PIXELS = None

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"}
STAGE_DIRS = ("Raw", "Extracted", "Oriented", "Cropped", "Upscaled")
DB_NAME = "catalog.db"
DETECT_MAX = 1600
MANIFEST_NAME = "artwork-manifest.json"
TEXTILE_WORDS = re.compile(
    r"(?<![a-z])(quilts?|bedcovers?|bedspreads?|bed-sheets?|bedsheets?|dohars?|throws?|cushions?|pillows?|"
    r"runners?|table-covers?|curtains?|textiles?|razai|duvets?|blankets?|totes?|mugs?|coasters?|lumbar)(?![a-z])",
    re.I,
)

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def detect_brand(path, requested):
    if requested in ("atrang", "nakhrro"):
        return requested
    low = path.lower()
    if "atrang" in low:
        return "atrang"
    if "nakhrro" in low or "nakhro" in low:
        return "nakhrro"
    return None


def load_image(path):
    im = Image.open(path)
    im.load()
    exif = im.getexif() if hasattr(im, "getexif") else {}
    camera = bool(exif.get(271) or exif.get(272))
    im = ImageOps.exif_transpose(im)
    return im, camera


def to_rgb_array(im):
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        return np.asarray(bg.convert("RGB"))
    return np.asarray(im.convert("RGB"))


def detection_copy(arr):
    h, w = arr.shape[:2]
    scale = min(1.0, DETECT_MAX / max(h, w))
    if scale < 1.0:
        small = cv2.resize(arr, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    else:
        small = arr
    return small, scale


def same_orientation(src_w, src_h, out_w, out_h, tolerance=0.08):
    a = src_w / src_h
    b = out_w / out_h
    if abs(a - 1) <= tolerance or abs(b - 1) <= tolerance:
        return abs(a - b) <= 0.25
    return (a > 1) == (b > 1)


# ---------------------------------------------------------------- Atrang ----


def atrang_rect(arr):
    small, scale = detection_copy(arr)
    h, w = small.shape[:2]
    low = small.min(axis=2)
    white = low >= 244

    ring = max(4, int(min(h, w) * 0.01))
    border = np.concatenate([white[:ring].ravel(), white[-ring:].ravel(), white[:, :ring].ravel(), white[:, -ring:].ravel()])
    if border.mean() < 0.85:
        found = mat_in_scene(small)
        if found is None:
            return None, "no white mat found on a non-white background (lifestyle photo)"
        rect, box = found
        rw, rh = rect[2] - rect[0], rect[3] - rect[1]
        if not same_orientation(box[2] - box[0], box[3] - box[1], rw, rh):
            return None, "artwork shape does not match the frame"
        return {"rect": tuple(int(round(v / scale)) for v in rect), "method": "mat-scene"}, None

    nonwhite = (~white).astype(np.uint8)
    nonwhite = cv2.morphologyEx(nonwhite, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(nonwhite, 8)
    if count <= 1:
        return None, "no frame found"
    areas = stats[1:, cv2.CC_STAT_WIDTH] * stats[1:, cv2.CC_STAT_HEIGHT]
    order = np.argsort(-areas)
    main = order[0] + 1
    fx, fy, fw, fh = stats[main, :4]
    if fw * fh < 0.15 * w * h:
        return None, "frame too small"
    for idx in order[1:]:
        x, y, cw, ch = stats[idx + 1, :4]
        inside_main = x >= fx and y >= fy and x + cw <= fx + fw and y + ch <= fy + fh
        if not inside_main and areas[idx] > 0.12 * areas[order[0]]:
            return None, "more than one frame (set or lifestyle)"

    # White regions enclosed by the frame: the mat is the one that hugs the frame.
    inside = np.zeros_like(white)
    inside[fy : fy + fh, fx : fx + fw] = True
    enclosed = (white & inside).astype(np.uint8)
    wcount, wlabels, wstats, _ = cv2.connectedComponentsWithStats(enclosed, 4)
    mat = None
    best = 0
    for i in range(1, wcount):
        x, y, cw, ch, area = wstats[i]
        if x <= 0 or y <= 0 or x + cw >= w or y + ch >= h:
            continue
        if cw < 0.6 * fw or ch < 0.6 * fh:
            continue
        if area > best:
            best = area
            mat = i

    if mat is not None:
        mat_mask = (wlabels == mat).astype(np.uint8)
        mx, my, mw, mh = wstats[mat, :4]
        filled = mat_mask.copy()
        contours, _ = cv2.findContours(mat_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
        hole = (filled == 1) & (mat_mask == 0)
        ys, xs = np.nonzero(hole)
        if len(xs) == 0:
            return None, "mat has no artwork inside"
        # Ignore thin specks; keep the main block.
        hcount, hlabels, hstats, _ = cv2.connectedComponentsWithStats(hole.astype(np.uint8), 8)
        big = np.argmax(hstats[1:, cv2.CC_STAT_AREA]) + 1
        keep = [big]
        bx, by, bw, bh = hstats[big, :4]
        for i in range(1, hcount):
            if i == big:
                continue
            x, y, cw, ch, area = hstats[i]
            if area > 0.02 * hstats[big, cv2.CC_STAT_AREA]:
                keep.append(i)
        sel = np.isin(hlabels, keep)
        ys, xs = np.nonzero(sel)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        left, right = x0 - mx, mx + mw - x1
        top, bottom = y0 - my, my + mh - y1
        if abs(left - right) > 0.04 * mw or abs(top - bottom) > 0.04 * mh:
            return None, "artwork background blends into the mat"
        # Step past the thin grey line that edges the print.
        inset = 1
        rect = (x0 + inset, y0 + inset, x1 - inset, y1 - inset)
        frame_box = (mx, my, mx + mw, my + mh)
        method = "mat"
    else:
        rect = frame_inner_edge(small, (fx, fy, fw, fh))
        if rect is None:
            return None, "could not find the inside edge of the frame"
        frame_box = (fx, fy, fx + fw, fy + fh)
        method = "frame"

    x0, y0, x1, y1 = rect
    rw, rh = x1 - x0, y1 - y0
    if rw <= 0 or rh <= 0:
        return None, "empty artwork area"
    bw = frame_box[2] - frame_box[0]
    bh = frame_box[3] - frame_box[1]
    if rw * rh < 0.25 * bw * bh:
        return None, "artwork area too small inside frame"
    cx = (x0 + x1) / 2 - (frame_box[0] + frame_box[2]) / 2
    cy = (y0 + y1) / 2 - (frame_box[1] + frame_box[3]) / 2
    if abs(cx) > 0.06 * bw or abs(cy) > 0.06 * bh:
        return None, "artwork is off-centre in the frame"
    if not same_orientation(fw, fh, rw, rh):
        return None, "artwork shape does not match the frame"

    full = tuple(int(round(v / scale)) for v in rect)
    return {"rect": full, "method": method}, None


def mat_in_scene(small):
    """Framed print photographed on marble, a wall or in a room: find the white mat ring and its hole."""
    h, w = small.shape[:2]
    low = small.min(axis=2)
    spread = small.max(axis=2).astype(np.int16) - low
    best = None
    for level in (244, 234, 222):
        white = ((low >= level) & (spread <= 18)).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(white, 4)
        for i in range(1, count):
            x, y, cw, ch, area = stats[i]
            if x <= 1 or y <= 1 or x + cw >= w - 1 or y + ch >= h - 1:
                continue
            if cw * ch < 0.06 * w * h or area < 0.03 * w * h:
                continue
            mask = (labels[y : y + ch, x : x + cw] == i).astype(np.uint8)
            filled = mask.copy()
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
            if filled.sum() < 0.93 * cw * ch:
                continue
            hole = (filled == 1) & (mask == 0)
            hcount, hlabels, hstats, _ = cv2.connectedComponentsWithStats(hole.astype(np.uint8), 8)
            if hcount <= 1:
                continue
            big = np.argmax(hstats[1:, cv2.CC_STAT_AREA]) + 1
            bx, by, bw, bh, barea = hstats[big]
            if bw * bh < 0.25 * cw * ch or bw * bh > 0.92 * cw * ch:
                continue
            if barea < 0.85 * bw * bh:
                continue
            left, right, top, bottom = bx, cw - bx - bw, by, ch - by - bh
            if min(left, right, top, bottom) < 2:
                continue
            if abs(left - right) > 0.04 * cw or abs(top - bottom) > 0.04 * ch:
                continue
            if best is None or cw * ch > best[2]:
                rect = (x + bx + 1, y + by + 1, x + bx + bw - 1, y + by + bh - 1)
                best = (rect, (x, y, x + cw, y + ch), cw * ch)
        if best is not None:
            return best[0], best[1]
    return None


def frame_inner_edge(small, frame):
    fx, fy, fw, fh = frame
    img = small.astype(np.int16)
    edges = {}
    for side in ("left", "right", "top", "bottom"):
        hits = []
        for t in np.linspace(0.35, 0.65, 7):
            if side in ("left", "right"):
                y = int(fy + t * fh)
                line = img[y, fx : fx + fw] if side == "left" else img[y, fx : fx + fw][::-1]
            else:
                x = int(fx + t * fw)
                line = img[fy : fy + fh, x] if side == "top" else img[fy : fy + fh, x][::-1]
            limit = int(len(line) * 0.2)
            probe = max(2, int(len(line) * 0.006))
            ref = np.median(line[probe : probe * 2 + 1], axis=0)
            dist = np.abs(line[:limit] - ref).max(axis=1)
            pos = None
            for i in range(probe, limit - 3):
                if dist[i] > 55 and dist[i + 1] > 55 and dist[i + 2] > 55:
                    pos = i
                    break
            if pos is not None:
                hits.append(pos)
        if len(hits) < 4:
            return None
        edges[side] = int(np.median(hits))
    x0 = fx + edges["left"] + 1
    x1 = fx + fw - edges["right"] - 1
    y0 = fy + edges["top"] + 1
    y1 = fy + fh - edges["bottom"] - 1
    return (x0, y0, x1, y1)


# --------------------------------------------------------------- Nakhrro ----


def nakhrro_rect(arr):
    small, scale = detection_copy(arr)
    h, w = small.shape[:2]
    img = small.astype(np.int16)
    best = None
    # Outer ring, then a ring a little further in (skips a thin scan edge).
    for a, b in ((0.0, 0.012), (0.025, 0.045)):
        lo = int(min(h, w) * a)
        hi = max(lo + 3, int(min(h, w) * b))
        ring_px = np.concatenate(
            [
                img[lo:hi, lo : w - lo].reshape(-1, 3),
                img[h - hi : h - lo, lo : w - lo].reshape(-1, 3),
                img[lo : h - lo, lo:hi].reshape(-1, 3),
                img[lo : h - lo, w - hi : w - lo].reshape(-1, 3),
            ]
        )
        ref = np.median(ring_px, axis=0)
        uniform = (np.abs(ring_px - ref).max(axis=1) < 40).mean()
        if best is None or uniform > best[0] + 0.1:
            best = (uniform, ref)
    uniform, ref = best
    if uniform < 0.7:
        return full_bleed(small, arr)

    dist = np.abs(img - ref).max(axis=2)
    art = dist > 42
    step = max(3, int(min(h, w) * 0.01))

    def first_art(profile, strict=True):
        n = len(profile)
        start = None
        for i in range(min(n, int(n * 0.3))):
            if profile[i] < 0.2:
                start = i
                break
        if start is None:
            return None
        for i in range(start, n - 3):
            if profile[i] > 0.5:
                after = profile[i : i + 2 * step]
                if after.mean() < 0.4:
                    continue
                before = profile[max(start, i - 3 * step) : max(start, i - step)]
                sharp = not strict or len(before) == 0 or before.mean() < 0.15
                return i if sharp else -1
        return None

    ys = slice(int(h * 0.2), int(h * 0.8))
    xs = slice(int(w * 0.2), int(w * 0.8))
    col = art[ys, :].mean(axis=0)
    row = art[:, xs].mean(axis=1)
    profiles = [col[: w // 2], col[::-1][: w // 2], row[: h // 2], row[::-1][: h // 2]]
    sides = [first_art(p) for p in profiles]
    if sides.count(-1) == 1:
        index = sides.index(-1)
        sides[index] = first_art(profiles[index], strict=False)
    left, right, top, bottom = sides
    if None in (left, right, top, bottom):
        return None, "could not find the painted area"
    if -1 in (left, right, top, bottom):
        return full_bleed(small, arr)
    x0, x1, y0, y1 = left, w - right, top, h - bottom
    rw, rh = x1 - x0, y1 - y0
    if rw * rh < 0.3 * w * h:
        return None, "painted area too small"
    if not same_orientation(w, h, rw, rh):
        return None, "painted area shape does not match the image"
    margin = max(left, right, top, bottom) / min(w, h)
    if margin < 0.01:
        return full_bleed(small, arr)
    outside = np.ones((h, w), bool)
    outside[y0:y1, x0:x1] = False
    if art[outside].mean() > 0.15:
        return None, "not plain paper around the artwork (lifestyle photo)"
    inner = art[y0:y1, x0:x1]
    if has_gutter(inner.mean(axis=0)) or has_gutter(inner.mean(axis=1)):
        return None, "two or more artworks side by side (set)"
    full = (int(round(x0 / scale)), int(round(y0 / scale)), int(round(x1 / scale)), int(round(y1 / scale)))
    return {"rect": full, "method": "margin"}, None


def has_gutter(profile):
    """A plain-paper strip through the middle means separate panels."""
    n = len(profile)
    mid = profile[int(n * 0.2) : int(n * 0.8)]
    width = max(3, int(n * 0.012))
    run = 0
    for value in mid:
        run = run + 1 if value < 0.08 else 0
        if run >= width:
            return True
    return False


def full_bleed(small, arr):
    """Whole image is the artwork, unless a framed piece is photographed inside a room."""
    h, w = small.shape[:2]
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 40, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < 0.08 * w * h or area > 0.7 * w * h:
            continue
        approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        x, y, cw, ch = cv2.boundingRect(approx)
        if area < 0.85 * cw * ch:
            continue
        if x > 0.02 * w and y > 0.02 * h and x + cw < 0.98 * w and y + ch < 0.98 * h:
            return None, "framed artwork shown in a room (lifestyle photo)"
    return {"rect": (0, 0, arr.shape[1], arr.shape[0]), "method": "full-bleed"}, None


# ------------------------------------------------------------------ main ----


class Manifest:
    """Output names (prefix_N) and results per source image, kept in the output folder."""

    def __init__(self, out_root, prefix):
        self.path = os.path.join(out_root, MANIFEST_NAME)
        data = {}
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as handle:
                data = json.load(handle)
        self.prefix = data.get("prefix") or prefix
        self.items = data.get("items") or {}
        numbers = [name_number(item.get("name")) for item in self.items.values()]
        self.next = max([n for n in numbers if n] + [0]) + 1

    def take_number(self):
        number = self.next
        self.next += 1
        return number

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"prefix": self.prefix, "items": self.items}, handle, indent=1)
        os.replace(tmp, self.path)


def name_number(name):
    match = re.search(r"_(\d+)$", name or "")
    return int(match.group(1)) if match else None


def output_rel(rel, name):
    ext = os.path.splitext(rel)[1].lower()
    if ext == ".heic":
        ext = ".jpg"
    return os.path.join(os.path.dirname(rel), name + ext)


def save(im, rect, dest):
    x0, y0, x1, y1 = rect
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(im.width, x1), min(im.height, y1)
    out = im.crop((x0, y0, x1, y1))
    ext = os.path.splitext(dest)[1].lower()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    icc = im.info.get("icc_profile")
    kwargs = {"icc_profile": icc} if icc else {}
    if ext in (".jpg", ".jpeg"):
        out.convert("RGB").save(dest, quality=95, subsampling=0, **kwargs)
    elif ext == ".webp":
        out.save(dest, quality=95, method=6, **kwargs)
    else:
        out.save(dest, **kwargs)
    return dest, out.size


def detect(src, rel, brand):
    """Returns (found, reason, image)."""
    if TEXTILE_WORDS.search(rel) or "home textiles" in rel.lower():
        return None, "textile or gift product", None
    if os.path.splitext(src)[1].lower() == ".heic" and not HEIF:
        return None, "HEIC reader not installed", None
    try:
        im, camera = load_image(src)
    except Exception as error:
        raise RuntimeError(f"cannot open: {error}")
    if brand == "nakhrro" and camera:
        return None, "camera photo (lifestyle)", im
    rect_fn = {"atrang": atrang_rect, "nakhrro": nakhrro_rect, "generic": generic_rect}[brand]
    found, reason = rect_fn(to_rgb_array(im))
    return found, reason, im


def generic_rect(arr):
    """Images outside the Atrang / Nakhrro layouts: a white mat inside a frame, else trimmed
    white space, else the inside of a frame or mount, else the image as it is."""
    small, scale = detection_copy(arr)
    found = mat_in_scene(small)
    if found is not None:
        rect, method = found[0], "mat-scene"
    else:
        rect, method = artwork_trim.find_rect(small)
    if method == "full":
        return {"rect": (0, 0, arr.shape[1], arr.shape[0]), "method": "full"}, None
    x0, y0, x1, y1 = (int(round(v / scale)) for v in rect)
    inset = 1 if method == "mat-scene" else 0
    return {"rect": (x0 + inset, y0 + inset, x1 - inset, y1 - inset), "method": method}, None


def process(src, rel, out_root, brand, overwrite, manifest=None):
    row = {"type": "file", "path": rel, "brand": brand}
    if manifest is None:
        try:
            found, reason, im = detect(src, rel, brand)
        except RuntimeError as error:
            return {**row, "status": "error", "reason": str(error)}
        if not found:
            return {**row, "status": "skipped", "reason": reason}
        x0, y0, x1, y1 = found["rect"]
        return {**row, "status": "done", "method": found["method"], "rect": list(found["rect"]),
                "source_size": [im.width, im.height], "output_size": [x1 - x0, y1 - y0]}

    key = rel.replace("\\", "/")
    item = manifest.items.get(key) or {}
    old_output = os.path.join(out_root, item["output"]) if item.get("output") else None
    if not overwrite and old_output and os.path.exists(old_output):
        return {**row, "status": "exists", "name": item.get("name"), "output": old_output}
    try:
        found, reason, im = detect(src, rel, brand)
    except RuntimeError as error:
        manifest.items[key] = {**item, "status": "error", "reason": str(error)}
        return {**row, "status": "error", "reason": str(error)}
    source_size = [im.width, im.height] if im else None
    if not found:
        if old_output and os.path.exists(old_output):
            os.remove(old_output)
        manifest.items[key] = {"name": item.get("name"), "status": "skipped", "reason": reason,
                               "source_size": source_size}
        return {**row, "status": "skipped", "reason": reason, "source_size": source_size}
    name = item.get("name") or f"{manifest.prefix}_{manifest.take_number()}"
    out_rel = output_rel(rel, name)
    out_path, size = save(im, found["rect"], os.path.join(out_root, out_rel))
    manifest.items[key] = {"name": name, "output": out_rel.replace("\\", "/"), "status": "done",
                           "method": found["method"], "source_size": source_size, "output_size": list(size)}
    return {**row, "status": "done", "name": name, "method": found["method"], "output": out_path,
            "source_size": source_size, "output_size": list(size)}


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


SQUARE_TOLERANCE = 0.05
RIGHT_43_TOLERANCE = 0.10
SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
  name TEXT PRIMARY KEY,
  brand TEXT,
  categories TEXT,
  source_file TEXT,
  source_path TEXT,
  stage TEXT,
  file TEXT,
  method TEXT,
  source_width INTEGER,
  source_height INTEGER,
  width INTEGER,
  height INTEGER,
  upscaled_file TEXT,
  upscaled_width INTEGER,
  upscaled_height INTEGER,
  extracted_at TEXT,
  oriented_at TEXT,
  cropped_at TEXT,
  upscaled_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS raw_skips (
  path TEXT PRIMARY KEY,
  reason TEXT,
  updated_at TEXT
);
"""


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def open_db(root):
    con = sqlite3.connect(os.path.join(root, DB_NAME), timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


def right_ratio(w, h):
    """4:3 / 3:4 within 10%, or square."""
    if abs(w / h - 1) <= SQUARE_TOLERANCE:
        return True
    return abs(max(w, h) / min(w, h) / (4 / 3) - 1) <= RIGHT_43_TOLERANCE


def list_images(folder):
    out = []
    for d, dirs, names in os.walk(folder):
        dirs.sort()
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() in EXTENSIONS:
                out.append(os.path.join(d, name))
    return out


def next_number(con, root, prefix):
    pattern = re.compile(rf"{re.escape(prefix)}_(\d+)$")
    used = [int(m.group(1)) for (name,) in con.execute("SELECT name FROM images") if (m := pattern.match(name))]
    for stage in STAGE_DIRS[1:]:
        for path in list_images(os.path.join(root, stage)):
            m = pattern.match(os.path.splitext(os.path.basename(path))[0])
            if m:
                used.append(int(m.group(1)))
    return max(used + [0]) + 1


def orient_extracted(con, root):
    """Move images in Extracted that already have the right ratio to Oriented."""
    moved = 0
    for path in list_images(os.path.join(root, "Extracted")):
        with Image.open(path) as im:
            w, h = ImageOps.exif_transpose(im).size
        if not right_ratio(w, h):
            continue
        file_name = os.path.basename(path)
        os.replace(path, os.path.join(root, "Oriented", file_name))
        name = os.path.splitext(file_name)[0]
        con.execute(
            "INSERT INTO images (name, stage, file, width, height, oriented_at, updated_at) VALUES (?, 'oriented', ?, ?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET stage='oriented', file=excluded.file, width=excluded.width, "
            "height=excluded.height, oriented_at=excluded.oriented_at, updated_at=excluded.updated_at",
            (name, f"Oriented/{file_name}", w, h, now(), now()),
        )
        moved += 1
    con.commit()
    return moved


def run_pipeline(root, brand_arg, overwrite):
    """Extract every image in Raw (Raw/<Brand>/<categories...>/file) into Extracted as <brand>_N,
    record it in catalog.db and delete the raw file. Images with the right ratio go on to Oriented."""
    for stage in STAGE_DIRS:
        os.makedirs(os.path.join(root, stage), exist_ok=True)
    con = open_db(root)
    raw_root = os.path.join(root, "Raw")
    skips = {path for (path,) in con.execute("SELECT path FROM raw_skips")}
    files = list_images(raw_root)
    todo = [f for f in files if overwrite or os.path.relpath(f, raw_root).replace("\\", "/") not in skips]
    emit({"type": "start", "total": len(todo), "files": len(files), "heif": HEIF})
    counts = {}
    numbers = {}
    for src in todo:
        rel = os.path.relpath(src, raw_root)
        key = rel.replace("\\", "/")
        parts = key.split("/")
        row = {"type": "file", "path": "Raw/" + key}
        existing = con.execute(
            "SELECT brand, categories, source_file, source_path FROM images WHERE name = ?",
            (os.path.splitext(parts[-1])[0],),
        ).fetchone()
        if existing:
            # An image moved back to Raw for another pass: keep its name and catalog metadata.
            brand, categories = existing[0] or "", json.loads(existing[1] or "[]")
            pattern = brand_arg if brand_arg in ("atrang", "nakhrro", "generic") else "generic"
        else:
            brand = parts[0] if len(parts) > 1 else ""
            categories = parts[1:-1]
            pattern = brand_arg if brand_arg == "generic" else detect_brand(brand, brand_arg) or "generic"
        try:
            found, reason, im = detect(src, key, pattern)
        except RuntimeError as error:
            found, reason, im = None, str(error), None
        if not found:
            con.execute("INSERT OR REPLACE INTO raw_skips (path, reason, updated_at) VALUES (?, ?, ?)", (key, reason, now()))
            con.commit()
            row.update(status="skipped", reason=reason)
        else:
            if existing:
                name = os.path.splitext(parts[-1])[0]
                source_file, source_path = existing[2] or parts[-1], existing[3] or "Raw/" + key
            else:
                prefix = slug(brand) or "artwork"
                if prefix not in numbers:
                    numbers[prefix] = next_number(con, root, prefix)
                name = f"{prefix}_{numbers[prefix]}"
                numbers[prefix] += 1
                source_file, source_path = parts[-1], "Raw/" + key
            ext = ".jpg" if os.path.splitext(key)[1].lower() == ".heic" else os.path.splitext(key)[1].lower()
            x0, y0, x1, y1 = found["rect"]
            oriented = right_ratio(x1 - x0, y1 - y0)
            folder = "Oriented" if oriented else "Extracted"
            for stage in STAGE_DIRS[1:4]:
                for old in list_images(os.path.join(root, stage)):
                    if os.path.splitext(os.path.basename(old))[0] == name:
                        os.remove(old)
            _, size = save(im, found["rect"], os.path.join(root, folder, name + ext))
            stamp = now()
            con.execute(
                "INSERT OR REPLACE INTO images (name, brand, categories, source_file, source_path, stage, file, method, "
                "source_width, source_height, width, height, extracted_at, oriented_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (name, brand, json.dumps(categories), source_file, source_path, "oriented" if oriented else "extracted",
                 f"{folder}/{name}{ext}", found["method"], im.width, im.height, size[0], size[1], stamp,
                 stamp if oriented else None, stamp),
            )
            con.execute("DELETE FROM raw_skips WHERE path = ?", (key,))
            con.commit()
            os.remove(src)
            row.update(status="done", name=name, stage="oriented" if oriented else "extracted",
                       method=found["method"], output_size=list(size))
        counts[row["status"]] = counts.get(row["status"], 0) + 1
        emit(row)
    counts["oriented_existing"] = orient_extracted(con, root)
    con.close()
    emit({"type": "done", "counts": counts})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", default="")
    parser.add_argument("--pipeline", action="store_true")
    parser.add_argument("--brand", default="auto")
    parser.add_argument("--sample", type=int, default=0)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prefix", default="")
    args = parser.parse_args()

    root = os.path.abspath(args.input)
    if args.pipeline:
        run_pipeline(root, args.brand.lower(), args.overwrite)
        return
    if not args.output:
        sys.exit("--output is required unless --pipeline is used.")
    out_root = os.path.abspath(args.output)
    if os.path.exists(os.path.join(root, DB_NAME)):
        sys.exit("The input folder is the catalog pipeline root; use --pipeline.")
    prefix = re.sub(r"[^a-z0-9]+", "_", (args.prefix or os.path.basename(root)).lower()).strip("_") or "artwork"
    manifest = None if args.dry_run else Manifest(out_root, prefix)
    files = []
    for d, dirs, names in os.walk(root):
        if os.path.abspath(d).startswith(out_root):
            dirs[:] = []
            continue
        dirs.sort()
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() in EXTENSIONS:
                files.append(os.path.join(d, name))

    if args.sample:
        rng = random.Random(args.seed)
        by_dir = {}
        for path in files:
            by_dir.setdefault(os.path.dirname(path), []).append(path)
        queues = list(by_dir.values())
        for queue in queues:
            rng.shuffle(queue)
        rng.shuffle(queues)
        files = []
        while any(queues):
            for queue in queues:
                if queue:
                    files.append(queue.pop())

    emit({"type": "start", "total": args.sample or len(files), "files": len(files), "heif": HEIF})
    done = 0
    counts = {}
    for src in files:
        rel = os.path.relpath(src, root)
        brand = detect_brand(src, args.brand.lower())
        if not brand:
            result = {"type": "file", "path": rel, "status": "skipped", "reason": "unknown brand (choose Atrang or Nakhrro)"}
        else:
            result = process(src, rel, out_root, brand, args.overwrite, manifest)
        counts[result["status"]] = counts.get(result["status"], 0) + 1
        if manifest is not None and result["status"] != "exists":
            manifest.save()
        emit(result)
        if result["status"] == "done":
            done += 1
            if args.sample and done >= args.sample:
                break
    emit({"type": "done", "counts": counts})


if __name__ == "__main__":
    main()
