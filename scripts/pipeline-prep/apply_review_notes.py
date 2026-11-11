"""Turn crop-review notes into a new crop recipe per painting and put them back up for review.

A recipe is a box in original-image fractions (may reach past the image: that part is padded with
`fill`), optional `cover` strips painted over the result's edges, and an optional cleaned source
(text/dots/lines removed) under ~/.editpro/pipeline-prep/crop-review-clean.

    py -3 apply_review_notes.py            dry run: prints what each note becomes
    py -3 apply_review_notes.py --apply    writes recipes into crop-review.json, cleaned images
"""
import json, os, re, sys
import cv2
import numpy as np

PREP = os.path.join(os.path.expanduser("~"), ".editpro", "pipeline-prep")
ROOT = r"C:\Users\divya\Downloads\_Existing Catalog Correction"
CLEAN = os.path.join(PREP, "crop-review-clean")
FEEDBACK = os.path.join(PREP, "crop-review.json")
ITEMS = os.path.join(PREP, "crop-review-items.json")

# Screen pixels in notes ("move crop up by 10px") are on the review page preview.
PREVIEW_H, PREVIEW_W = 716, 820
SMALL_GROUP = 0.07      # content row groups shorter than this share of height count as text/dots/lines
TEXT_REACH = 0.28       # how far from the edge text removal looks
GAP = 0.006             # empty rows that separate two groups
DIFF = 38               # colour distance from background that counts as content
EXTRA_SPACE = 0.06      # "increase blank space" adds this much around the padded painting
LINE_TRIM = 0.012       # "remove lines on border" trims at least this much from each named side
THIN_STRIP = 0.006      # "thin line/strip" width as a share of the output side
APPROVED_REDO = {"10930", "12235", "12156"}
# Notes whose borders sit on textured paper or captions the detectors miss: insets measured by eye.
OVERRIDES = {
    "11784": {"insets": {"top": 0.05, "bottom": 0.045, "left": 0.03, "right": 0.03}},
    "10786": {"insets": {"top": 0.115, "bottom": 0.1, "left": 0.0, "right": 0.0}},
    "10700": {"insets": {"top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.03}, "pad": "plain"},
    "11711": {"insets": {"top": 0.085, "bottom": 0.02, "left": 0.025, "right": 0.025}},
    "11767": {"insets": {"top": 0.0, "bottom": 0.033, "left": 0.0, "right": 0.0}},
    "13247": {"zoom": 0.065, "zoom_keep": "top"},
    "13933": {"insets": {"top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.022}},
}


def stem(name):
    return os.path.splitext(name)[0]


def read(path):
    img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"cannot read {path}")
    return img


def write(path, img):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ext = os.path.splitext(path)[1].lower()
    params = [cv2.IMWRITE_JPEG_QUALITY, 95] if ext in (".jpg", ".jpeg") else []
    ok, buf = cv2.imencode(ext, img, params)
    buf.tofile(path)


# ---------- note parsing ----------

SIDES = ("top", "bottom", "left", "right")


def named_sides(text):
    if re.search(r"\ball sides\b", text):
        return list(SIDES)
    out = [s for s in SIDES if re.search(rf"\b{s}\b", text)]
    if re.search(r"\bsides\b", text):
        out += [s for s in ("left", "right") if s not in out]
    return out


def parse(note):
    t = re.sub(r"\s+", " ", note.lower())
    t = t.replace("center", "centre").replace("orders", "borders").replace("horiztonally", "horizontally")
    t = re.sub(r"\b(graph|corporate|group)\b", "crop", t)
    t = t.replace("and blank", "add blank").replace("de;ete", "delete")
    ops = {}
    if re.search(r"\bdelete\b", t):
        ops["delete"] = "duplicate" if "duplicate" in t else True
        return ops
    # "add yellow space on top or white space on all sides": take the first option
    t = t.split(" or ")[0]
    if re.search(r"background colour (?:and width )?is not matching", t):
        ops["even_margin"] = True
        return ops
    m = re.search(r"white lines? coming on (?:the )?(.*)", t)
    if m and named_sides(m.group(1)):
        ops["lines"] = named_sides(m.group(1))
        ops["lines_exact"] = True
        ops["pad"] = "plain"
        return ops
    if "background colour is not right" in t or "white line coming" in t:
        ops["refill"] = True
        return ops
    if re.search(r"remove (?:the )?(?:thin )?(?:white )?lines?\b", t):
        ops["lines"] = named_sides(t.split("line", 1)[1]) or list(SIDES)
    m = re.search(r"remove (?:the )?white (?:from |on )(?:the )?([a-z ]+)", t)
    if m and named_sides(m.group(1)):
        ops["lines"] = named_sides(m.group(1))
    if re.search(r"(crop|remove) (?:the )?(?:beige |black |white )?(?:blank space on )?border", t):
        ops["unborder"] = named_sides(t.split("border", 1)[1]) or True
    m = re.search(r"zoom in( (?:a )?(?:little|bit))?( more)?", t)
    if m:
        ops["zoom"] = 0.04 if m.group(1) else 0.07
        if m.group(2):
            ops["zoom_more"] = True
        if "bottom" in t:
            ops["zoom_keep"] = "top"
    if re.search(r"\badd (?:some )?blank space\b", t) and not named_sides(t.split("blank space", 1)[1]):
        ops["pad"] = "plain"
    if "9:16" in t:
        ops["target"] = 9 / 16
    if "make square" in t:
        ops["target"] = 1.0
    if "remove" in t and "border" in t and "lines" not in ops and "unborder" not in ops:
        ops["unborder"] = True
    m = re.search(r"remove (?:the )?(text|subtitles|dots)(?: and line)?(?: (?:at|from) (?:the )?(top|bottom))?", t)
    if m:
        ops["clean"] = m.group(2) or "bottom"
        if "keep" in t:
            ops["keep_tallest"] = True
        if m.group(1) == "dots":
            ops["only_nearest"] = True
    if re.search(r"increase (white|blank) space", t):
        ops["pad"] = "extra"
    if "instead of cropping" in t:
        ops["pad"] = "plain"
    if "white space from right" in t and "to left" in t:
        ops["centre_content"] = "x"
    elif re.search(r"\b(add|and)\b.*\b(strip|space|line)\b", t):
        rest = t.split("add", 1)[-1]
        named = named_sides(rest)
        if named:
            ops["strip"] = named
            if re.search(r"\bwhite\b", rest):
                ops["strip_colour"] = [255, 255, 255]
            m = re.search(r"(\d+)\s*px", rest)
            if m:
                ops["strip_px"] = int(m.group(1))
            elif re.search(r"\bthin\b", rest):
                ops["strip_thin"] = True
    m = re.search(r"crop (?:from )?(top|bottom|left|right)\b", t)
    if m and "centre_content" not in ops:
        ops["cut"] = m.group(1)
    if "centre" in t and "cut" not in ops:
        ops["centre"] = True
    m = re.search(r"move crop(?: area)?\s+(?:(up|down|left|right|below)\s+)?(?:by|to)?\.?\s*(\d+)\s*(?:px|pixels?)?(?:\s+(up|down|left|right|below))?", t)
    if m:
        d = m.group(1) or m.group(3)
        if not d:
            ops["unclear"] = "move direction missing"
        else:
            ops["move"] = ({"below": "down"}.get(d, d), int(m.group(2)))
    return ops


# ---------- image analysis ----------

def small(img, side=800):
    h, w = img.shape[:2]
    s = side / max(h, w)
    return cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA), s


def margin(img, side):
    """Thickness (share of that dimension) and colour of a plain band along one edge."""
    im, _ = small(img)
    if side in ("left", "right"):
        im = im.transpose(1, 0, 2)
    lines = im if side in ("top", "left") else im[::-1]
    edge = np.median(lines[:2].reshape(-1, 3), axis=0)
    n = 0
    for row in lines[: int(len(lines) * 0.25)]:
        if row.std(axis=0).max() < 9 and np.abs(np.median(row, axis=0) - edge).max() < 14:
            n += 1
        else:
            break
    return n / len(lines), [int(v) for v in edge[::-1]]


def border_insets(img):
    """Per side inset (fraction) of a painted or blank border, innermost line within 14%."""
    im, _ = small(img, 400)
    gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h, w = gray.shape
    rows = (np.abs(np.diff(gray, axis=0)) > 22).mean(axis=1)
    cols = (np.abs(np.diff(gray, axis=1)) > 22).mean(axis=0)
    rh, rw = int(h * 0.14), int(w * 0.14)
    lines = {
        "top": [i / h for i in range(2, rh) if rows[i] >= 0.5],
        "bottom": [(h - 1 - i) / h for i in range(h - rh, h - 3) if rows[i] >= 0.5],
        "left": [i / w for i in range(2, rw) if cols[i] >= 0.5],
        "right": [(w - 1 - i) / w for i in range(w - rw, w - 3) if cols[i] >= 0.5],
    }
    out = {}
    for a, b in (("top", "bottom"), ("left", "right")):
        # a painted border sits at the same depth on opposite sides; art lines rarely do
        pairs = [(x, y) for x in lines[a] for y in lines[b] if abs(x - y) <= 0.012]
        la, lb = max(pairs, key=lambda p: p[0] + p[1]) if pairs else (0.0, 0.0)
        pa, pb = margin(img, a)[0], margin(img, b)[0]
        out[a] = max(la, pa) + (0.004 if max(la, pa) > 0 else 0)
        out[b] = max(lb, pb) + (0.004 if max(lb, pb) > 0 else 0)
    return out


def content_span_x(img):
    im, _ = small(img)
    edge = np.median(np.concatenate([im[:, :3].reshape(-1, 3), im[:, -3:].reshape(-1, 3)]), axis=0)
    diff = np.abs(im.astype(np.int16) - edge).max(axis=2) > DIFF
    cols = np.where(diff.mean(axis=0) > 0.01)[0]
    if not len(cols):
        return 0.0, 1.0
    return cols[0] / im.shape[1], (cols[-1] + 1) / im.shape[1]


def clean_text(img, where, keep_tallest=False, only_nearest=False):
    """Remove short groups of content rows (text, dots, rules) nearest one edge; returns (img, rows removed)."""
    flip = where == "top"
    if flip:
        out, spans = clean_text(np.ascontiguousarray(img[::-1]), "bottom", keep_tallest, only_nearest)
        if out is None:
            return None, []
        return np.ascontiguousarray(out[::-1]), [(1 - b, 1 - a) for a, b in spans]
    h, w = img.shape[:2]
    band_h = int(h * TEXT_REACH)
    band = np.ascontiguousarray(img[h - band_h:])
    bg = np.median(band[-max(2, h // 100):].reshape(-1, 3), axis=0)
    diff = np.abs(band.astype(np.int16) - bg).max(axis=2) > DIFF
    has = diff.mean(axis=1) > 0.002
    groups, i, n = [], len(has) - 1, len(has)
    gap = max(2, int(h * GAP))
    while i >= 0:
        if not has[i]:
            i -= 1
            continue
        j = i
        empty = 0
        while j >= 0 and empty < gap:
            empty = empty + 1 if not has[j] else 0
            j -= 1
        top = j + empty + 1
        groups.append((top, i + 1))
        i = j
    removed = []
    for top, bot in groups:  # nearest the edge first
        if (bot - top) / h > SMALL_GROUP or top == 0:
            break
        removed.append((top, bot))
    if only_nearest:
        removed = removed[:1]
    if keep_tallest and removed:
        tallest = max(range(len(removed)), key=lambda k: removed[k][1] - removed[k][0])
        removed = removed[:tallest]
    if not removed:
        return None, []
    mask = np.zeros(diff.shape, np.uint8)
    for top, bot in removed:
        mask[top:bot] = diff[top:bot]
    mask = cv2.dilate(mask * 255, np.ones((7, 7), np.uint8))
    fixed = cv2.inpaint(band, mask, 5, cv2.INPAINT_TELEA)
    out = img.copy()
    out[h - band_h:] = fixed
    return out, [((h - band_h + t) / h, (h - band_h + b) / h) for t, b in removed]


# ---------- recipe ----------

def recipe(item, entry, ops):
    path = os.path.join(ROOT, item["folder"], item["file"])
    img = read(path)
    H, W = img.shape[:2]
    target = ops.get("target", item["target"])
    done = []
    clean_path = None
    if ops.get("refill"):
        prev = dict(entry.get("recipe") or {})
        prev["frac"] = entry.get("frac") or prev.get("frac") or item["frac"]
        src = read(prev["clean"]) if prev.get("clean") else img
        bg = bg_colour(src)
        prev["fill"] = bg
        for c in (prev.get("cover") or {}).values():
            c["color"] = bg
        prev["done"] = "padding now uses the painting's own background colour"
        prev.setdefault("target", target)
        return prev, None
    if ops.get("even_margin"):
        return even_margin(img, target), None
    if ops.get("lines") and (entry.get("recipe") or {}).get("fill") is not None:
        ops.setdefault("pad", "plain")
    if "clean" in ops:
        fixed, spans = clean_text(img, ops["clean"], ops.get("keep_tallest"), ops.get("only_nearest"))
        if fixed is None:
            done.append(f"found no text at the {ops['clean']} to remove")
        else:
            clean_path = os.path.join(CLEAN, item["folder"], item["file"])
            img = fixed
            done.append(f"removed {len(spans)} line(s) of text/marks at the {ops['clean']}")

    # region the crop works within (fractions)
    rx0, ry0, rx1, ry1 = 0.0, 0.0, 1.0, 1.0
    if ops.get("insets"):
        ins = ops["insets"]
        rx0, ry0, rx1, ry1 = ins["left"], ins["top"], 1 - ins["right"], 1 - ins["bottom"]
        done.append("cut off the border/caption (" + ", ".join(f"{s} {v:.1%}" for s, v in ins.items() if v) + ")")
    elif ops.get("unborder") or ops.get("lines"):
        ins = {s: 0.0 for s in SIDES} if ops.get("lines_exact") else border_insets(img)
        sides = ops.get("lines") or (ops["unborder"] if isinstance(ops["unborder"], list) else list(SIDES))
        floor = LINE_TRIM if ops.get("lines") else 0.0
        ins = {s: (max(ins[s], floor) if s in sides else 0.0) for s in SIDES}
        rx0, ry0, rx1, ry1 = ins["left"], ins["top"], 1 - ins["right"], 1 - ins["bottom"]
        what = "trimmed the lines along the edge" if ops.get("lines") else "cut inside the border"
        done.append(what + " (" + ", ".join(f"{s} {ins[s]:.1%}" for s in sides) + ")")
    rw, rh = (rx1 - rx0) * W, (ry1 - ry0) * H
    region_ratio = rw / rh
    cut_x = region_ratio > target   # cropping would trim left/right

    base = entry.get("frac") or (entry.get("recipe") or {}).get("frac") or item["frac"]
    if "target" in ops or ops.get("unborder") or ops.get("lines") or ops.get("insets"):
        base = None
    if cut_x:
        bw, bh = rh * target, rh
    else:
        bw, bh = rw, rw / target
    cx = (rx0 + rx1) / 2 * W
    cy = (ry0 + ry1) / 2 * H
    if base:
        cx = (base[0] + base[2]) / 2 * W
        cy = (base[1] + base[3]) / 2 * H
    fill = None
    cover = {}

    def pad_box(extra=0.0):
        nonlocal bw, bh, cx, cy
        if cut_x:
            bw, bh = rw, rw / target
        else:
            bw, bh = rh * target, rh
        bw, bh = bw * (1 + extra), bh * (1 + extra)
        cx, cy = (rx0 + rx1) / 2 * W, (ry0 + ry1) / 2 * H

    if ops.get("pad"):
        pad_box(EXTRA_SPACE if ops["pad"] == "extra" else 0.0)
        sides = ("top", "bottom") if cut_x else ("left", "right")
        fill = margin(img, sides[0])[1]
        done.append("added blank space instead of cropping" + (" with extra room all round" if ops["pad"] == "extra" else ""))
        fill = inner_edge_colour(img, (rx0, ry0, rx1, ry1), sides)
    if ops.get("strip"):
        named = ops["strip"]
        on_cut = all((s in ("left", "right")) == cut_x for s in named)
        given = ops.get("strip_colour")
        if ops.get("strip_px") or ops.get("strip_thin"):
            # a strip of a set width is painted over the crop's edge
            s = min(PREVIEW_H / H, PREVIEW_W / W)
            for side in named:
                out_dim = bh if side in ("top", "bottom") else bw
                size = ops["strip_px"] / s / out_dim if ops.get("strip_px") else THIN_STRIP
                colour = given or (margin(img, side)[1] if margin(img, side)[0] > 0 else bg_colour(img))
                cover[side] = {"size": round(size, 4), "color": colour}
            done.append("painted a {} strip on {}".format(
                f"{ops['strip_px']}px" if ops.get("strip_px") else "thin", " and ".join(named)))
        elif not on_cut:
            pad_box()
            # pad only on the named side(s)
            if len(named) == 1:
                s = named[0]
                if s == "top":
                    cy = (ry1 * H) - bh / 2
                elif s == "bottom":
                    cy = (ry0 * H) + bh / 2
                elif s == "left":
                    cx = (rx1 * W) - bw / 2
                else:
                    cx = (rx0 * W) + bw / 2
            fill = given or (margin(img, named[0])[1] if margin(img, named[0])[0] > 0 else bg_colour(img))
            done.append("added blank space on " + " and ".join(named) + " instead of cropping")
        else:
            if len(named) == 1:
                ops.setdefault("cut", named[0])
            else:
                ops["centre"] = True
            for s in named:
                opp = {"top": "bottom", "bottom": "top", "left": "right", "right": "left"}[s]
                size, colour = margin(img, s)
                if size < 0.006:
                    size, colour = margin(img, opp)
                if size < 0.006:
                    others = [margin(img, o) for o in SIDES if o not in (s, opp)]
                    size, colour = max(others) if max(others)[0] >= 0.006 else (0.025, [255, 255, 255])
                dim = H if s in ("top", "bottom") else W
                out_dim = bh if s in ("top", "bottom") else bw
                cover[s] = {"size": round(size * dim / out_dim, 4), "color": given or colour}
            done.append("cropped, then painted a strip on {} the same size as the margin".format(" and ".join(named)))
    if ops.get("centre_content") == "x":
        a, b = content_span_x(img)
        cx -= (1 - b) * W
        fill = margin(img, "right")[1]
        done.append("moved the painting to the middle (trimmed space on the right, added it on the left)")
    if ops.get("centre"):
        cx, cy = (rx0 + rx1) / 2 * W, (ry0 + ry1) / 2 * H
        done.append("centred the crop")
    if ops.get("cut"):
        s = ops["cut"]
        if s == "top":
            cy = ry1 * H - bh / 2
        elif s == "bottom":
            cy = ry0 * H + bh / 2
        elif s == "left":
            cx = rx1 * W - bw / 2
        else:
            cx = rx0 * W + bw / 2
        done.append(f"cropped from the {s}")
    if ops.get("zoom"):
        z = ops["zoom"]
        if ops.get("zoom_more") and base:
            bw, bh = (base[2] - base[0]) * W, (base[3] - base[1]) * H
        top = cy - bh / 2
        bw, bh = bw * (1 - z), bh * (1 - z)
        if ops.get("zoom_keep") == "top":
            cy = top + bh / 2
        done.append(f"zoomed in {z:.0%}" + (", keeping the top" if ops.get("zoom_keep") else ""))
    if "target" in ops:
        done.append("changed to " + ("square" if ops["target"] == 1 else "9:16"))
    if ops.get("move"):
        d, px = ops["move"]
        s = min(PREVIEW_H / H, PREVIEW_W / W)
        dist = px / s
        if d == "up":
            cy -= dist
        elif d == "down":
            cy += dist
        elif d == "left":
            cx -= dist
        else:
            cx += dist
        done.append(f"moved the crop {d} by {px}px")

    # keep a plain crop inside the image; padded or shifted boxes are left as built
    if fill is None:
        cx = min(max(cx, bw / 2), W - bw / 2) if bw <= W else W / 2
        cy = min(max(cy, bh / 2), H - bh / 2) if bh <= H else H / 2
    frac = [(cx - bw / 2) / W, (cy - bh / 2) / H, (cx + bw / 2) / W, (cy + bh / 2) / H]
    if fill is not None:
        # a padded box reaches past the trimmed region: paint the trimmed edge over with the fill too
        reach = {"left": (rx0 - frac[0]) * W / bw, "right": (frac[2] - rx1) * W / bw,
                 "top": (ry0 - frac[1]) * H / bh, "bottom": (frac[3] - ry1) * H / bh}
        trimmed = {"left": rx0, "right": 1 - rx1, "top": ry0, "bottom": 1 - ry1}
        for s in SIDES:
            if trimmed[s] > 0 and reach[s] > 0 and s not in cover:
                cover[s] = {"size": round(reach[s], 4), "color": fill}
    rec = {"frac": [round(v, 4) for v in frac], "target": target, "done": "; ".join(done)}
    if fill is not None:
        rec["fill"] = fill
    if cover:
        rec["cover"] = cover
    if clean_path:
        rec["clean"] = clean_path
    return rec, img if clean_path else None


def bg_colour(img):
    """Most common colour in the outer ring of the painting (its background), BGR -> RGB list."""
    im, _ = small(img, 400)
    h, w = im.shape[:2]
    r = max(3, int(min(h, w) * 0.06))
    ring = np.concatenate([im[:r].reshape(-1, 3), im[-r:].reshape(-1, 3), im[:, :r].reshape(-1, 3), im[:, -r:].reshape(-1, 3)])
    q = (ring // 16).astype(np.int32)
    keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    top = np.bincount(keys).argmax()
    return [int(v) for v in np.median(ring[keys == top], axis=0)[::-1]]


def inner_edge_colour(img, region, sides, depth=0.03):
    """Median colour of a thin band just inside the region along the given sides, RGB list."""
    H, W = img.shape[:2]
    x0, y0, x1, y1 = int(region[0] * W), int(region[1] * H), int(region[2] * W), int(region[3] * H)
    dx, dy = max(2, int(W * depth)), max(2, int(H * depth))
    bands = {"left": img[y0:y1, x0 + 2:x0 + dx], "right": img[y0:y1, x1 - dx:x1 - 2],
             "top": img[y0 + 2:y0 + dy, x0:x1], "bottom": img[y1 - dy:y1 - 2, x0:x1]}
    px = np.concatenate([bands[s].reshape(-1, 3) for s in sides])
    return [int(v) for v in np.median(px, axis=0)[::-1]]


def even_margin(img, target, share=0.04):
    """Box around the painted area with the same paper margin on every side (grown on one axis to fit
    the target), the whole margin repainted in the paper colour."""
    im, s = small(img)
    h, w = im.shape[:2]
    paper = bg_colour(img)
    diff = np.abs(im.astype(np.int16) - np.array(paper[::-1], np.int16)).max(axis=2) > DIFF
    rows = np.where(diff.mean(axis=1) > 0.02)[0]
    cols = np.where(diff.mean(axis=0) > 0.02)[0]
    x0, x1 = cols[0], cols[-1] + 1
    y0, y1 = rows[0], rows[-1] + 1
    m = share * max(x1 - x0, y1 - y0)
    bx0, by0, bx1, by1 = x0 - m, y0 - m, x1 + m, y1 + m
    bw, bh = bx1 - bx0, by1 - by0
    if bw / bh > target:
        grow = bw / target - bh
        by0, by1, bh = by0 - grow / 2, by1 + grow / 2, bw / target
    else:
        grow = bh * target - bw
        bx0, bx1, bw = bx0 - grow / 2, bx1 + grow / 2, bh * target
    cover = {
        "top": {"size": round((y0 - by0) / bh, 4), "color": paper},
        "bottom": {"size": round((by1 - y1) / bh, 4), "color": paper},
        "left": {"size": round((x0 - bx0) / bw, 4), "color": paper},
        "right": {"size": round((bx1 - x1) / bw, 4), "color": paper},
    }
    frac = [bx0 / w, by0 / h, bx1 / w, by1 / h]
    return {"frac": [round(v, 4) for v in frac], "target": target, "fill": paper, "cover": cover,
            "done": "even paper-coloured margin on all sides"}


def edge_colour(img):
    im, _ = small(img)
    ring = np.concatenate([im[:3].reshape(-1, 3), im[-3:].reshape(-1, 3), im[:, :3].reshape(-1, 3), im[:, -3:].reshape(-1, 3)])
    return [int(v) for v in np.median(ring, axis=0)[::-1]]


def main():
    apply = "--apply" in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    items = json.load(open(ITEMS, encoding="utf8"))
    by = {i["key"]: i for i in items}
    fb = json.load(open(FEEDBACK, encoding="utf8"))
    todo, deletes, unclear, unparsed = [], [], [], []
    for key, e in fb.items():
        it = by[key]
        st = e.get("status")
        if st in ("border", "delete", "crop_only"):
            continue
        if st == "approved" and stem(it["file"]) not in APPROVED_REDO:
            continue
        note = (e.get("note") or "").strip()
        if not note:
            continue
        if only and stem(it["file"]) not in only:
            continue
        ops = OVERRIDES.get(stem(it["file"])) or parse(note)
        if ops.get("delete"):
            deletes.append((key, ops["delete"]))
        elif ops.get("unclear"):
            unclear.append((key, note, ops["unclear"]))
        elif not ops:
            unparsed.append((key, note))
        else:
            todo.append((key, ops))
    print(f"to redo {len(todo)}  delete {len(deletes)}  unclear {len(unclear)}  unparsed {len(unparsed)}")
    for key, note, why in unclear:
        print("UNCLEAR", stem(by[key]["file"]), "|", note, "|", why)
    for key, note in unparsed:
        print("UNPARSED", stem(by[key]["file"]), "|", note)
    for key, ops in todo:
        it, e = by[key], fb[key]
        try:
            rec, cleaned = recipe(it, e, ops)
        except Exception as err:
            print("ERROR", stem(it["file"]), err)
            continue
        if not apply:
            print(stem(it["file"]), "|", e["note"], "|", rec["done"], "|", rec["frac"])
            continue
        if cleaned is not None:
            write(rec["clean"], cleaned)
        history = e.get("history", []) + [{"note": e.get("note", ""), "status": e.get("status"), "done": rec["done"]}]
        fb[key] = {"history": history, "recipe": rec, "recipe_round": len(history), "reworked": True}
        for keep in ("previous", "previous_note", "edge"):
            if e.get(keep):
                fb[key][keep] = e[keep]
    if apply:
        for key, kind in deletes:
            e = fb[key]
            e["status"] = "delete"
            e["delete_kind"] = kind
        tmp = FEEDBACK + ".tmp"
        json.dump(fb, open(tmp, "w", encoding="utf8"), indent=1)
        os.replace(tmp, FEEDBACK)
        print("written")


if __name__ == "__main__":
    main()
