"""One-off fixes for AI-extended artwork in the AI folder.

pad-top:     add the missing height above the painting using the colour and grain of its top rows.
inset:       re-compose an AI canvas but paste the original slightly inside its own edge, so a thin
             outline on the original does not show as a line in the result.
frame-prep:  crop the painting inside its border and place it on a grey canvas sized for the new
             interior, for the image model to fill.
frame:       keep the border, lengthen it by repeating its own pattern, and put the extended
             interior inside it (the original interior pasted back when the model kept it in place).
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
GREY = (128, 128, 128)
REF_MAX = 1536
MAX_DRIFT = 20


def save(im, path, info):
    kw = {"icc_profile": info["icc_profile"]} if info.get("icc_profile") else {}
    if path.lower().endswith((".jpg", ".jpeg")):
        im.save(path, quality=95, subsampling=0, **kw)
    else:
        im.save(path, **kw)


def load(path):
    src = Image.open(path)
    return np.asarray(src.convert("RGB")).astype(float), dict(src.info)


def target(w, h, aspect):
    ratio = {"3:4": 3 / 4, "4:3": 4 / 3, "1:1": 1.0}[aspect]
    return (w, round(w / ratio)) if w / h > ratio else (round(h * ratio), h)


def feathered(w, h, inset, feather):
    mask = Image.new("L", (w, h), 0)
    mask.paste(255, (inset + feather, inset + feather, w - inset - feather, h - inset - feather))
    return mask.filter(ImageFilter.GaussianBlur(max(1, feather / 2)))


def drift(gen, orig, x, y):
    w, h = orig.size
    f = 4
    G = np.asarray(gen.crop((x, y, x + w, y + h)).convert("L").resize((max(1, w // f), max(1, h // f))), float)
    O = np.asarray(orig.convert("L").resize((max(1, w // f), max(1, h // f))), float)
    k = max(2, min(O.shape) // 20)
    ring = np.zeros(O.shape, bool)
    ring[:k] = ring[-k:] = True
    ring[:, :k] = ring[:, -k:] = True
    return float(np.abs(G - O)[ring].mean())


def texture_fill(a, med, add, w, edge=4):
    """Tile the largest clean background patch from the top corners (mirrored, so tiles join
    without hard edges) to an add x w block."""
    h = a.shape[0]
    clean = np.abs(a - med).sum(2) < 45
    best = None
    for x0 in (edge, None):
        for size in range(min(h // 2, 400), 24, -8):
            xs = slice(edge, edge + size) if x0 is not None else slice(a.shape[1] - edge - size, a.shape[1] - edge)
            if clean[edge:edge + size, xs].mean() > 0.995:
                if not best or size > best[0]:
                    best = (size, a[edge:edge + size, xs])
                break
    patch = best[1]
    tile = np.concatenate([patch, patch[:, ::-1]], 1)
    tile = np.concatenate([tile, tile[::-1]], 0)
    reps = (add // tile.shape[0] + 1, w // tile.shape[1] + 1, 1)
    return np.tile(tile, reps)[:add, :w]


def pad_top(src, dst, aspect, rows=16, blend=24, seed=1, grain=0.5):
    a, info = load(src)
    h, w, _ = a.shape
    _, th = target(w, h, aspect)
    add = th - h
    band = a[max(2, h // 100):max(rows, h // 15)].reshape(-1, 3)
    med = np.median(band, 0)
    cut = 0
    while cut < 8 and np.abs(np.median(a[cut], 0) - med).sum() > 12:
        cut += 1
    a = a[cut:]
    h = a.shape[0]
    add = th - h
    fill = texture_fill(a, med, add, w)
    out = np.vstack([fill, a])
    top = a[:blend]
    for i in range(blend):
        t = (i + 1) / (blend + 1)
        keep = np.abs(top[i] - med).sum(1, keepdims=True) > 60
        out[add + i] = np.where(keep, top[i], top[i] * t + fill[-1 - i % 4] * (1 - t))
    save(Image.fromarray(out.astype(np.uint8)), dst, info)


def inset(src, gen, dst, canvas, offset, inset_frac=0.02, feather_frac=0.03):
    a, info = load(src)
    orig = Image.fromarray(a.astype(np.uint8))
    w, h = orig.size
    out = Image.open(gen).convert("RGB").resize(tuple(canvas), Image.LANCZOS)
    i = max(2, round(inset_frac * min(w, h)))
    f = max(3, round(feather_frac * min(w, h)))
    out.paste(orig, tuple(offset), feathered(w, h, i, f))
    save(out, dst, info)


def extend_strip(strip, add, axis, k=4, blend=10, margin=8):
    """Lengthen a border strip along `axis` by `add` px by repeating the stretch [p, p+add) right
    after itself. Only the start of the repeat is a join; p is chosen where it matches best."""
    s = np.moveaxis(strip, axis, 0)
    n = s.shape[0]
    flat = s.reshape(n, -1)
    best, bp = 1e18, margin
    for p in range(margin, n - add - k - margin):
        e = np.abs(flat[p + add:p + add + k] - flat[p:p + k]).mean()
        if e < best:
            best, bp = e, p
    block = s[bp:bp + add].copy()
    for i in range(min(blend, add // 2)):
        t = (i + 1) / (blend + 1)
        block[i] = (1 - t) * s[bp + add + i] + t * block[i]
    out = np.concatenate([s[:bp + add], block, s[bp + add:]])
    return np.moveaxis(out, 0, axis), round(float(best), 1)


def frame_size(w, h, aspect, insets):
    tw, th = target(w, h, aspect)
    l, t, r, b = insets
    return tw, th, (w - l - r, h - t - b), (tw - l - r, th - t - b)


def gen_box(iw, ih):
    """The interior padded out to the nearest ratio the image model supports."""
    ratio = iw / ih
    name, r = min(("3:4", 0.75), ("4:3", 4 / 3), ("1:1", 1.0), key=lambda kv: abs(kv[1] - ratio))
    gw, gh = (iw, round(iw / r)) if ratio > r else (round(ih * r), ih)
    return name, gw, gh


def place(outer, inner, ox, oy, align):
    """Top-left of an inner box inside an outer box: centred, or pinned to the bottom of the
    interior region that starts at oy within the outer box."""
    (gw, gh), (iw0, ih0) = outer, inner
    x = (gw - iw0) // 2
    if align == "bottom":
        return x, gh - oy - ih0
    return x, (gh - ih0) // 2


def frame_prep(src, dst, aspect, insets, align="center"):
    a, _ = load(src)
    h, w, _ = a.shape
    l, t, r, b = insets
    tw, th, (iw0, ih0), (iw, ih) = frame_size(w, h, aspect, insets)
    name, gw, gh = gen_box(iw, ih)
    inner = Image.fromarray(a[t:h - b, l:w - r].astype(np.uint8))
    scale = min(1.0, REF_MAX / max(gw, gh))
    canvas = Image.new("RGB", (round(gw * scale), round(gh * scale)), GREY)
    x, y = place((gw, gh), (iw0, ih0), 0, (gh - ih) // 2, align)
    canvas.paste(inner.resize((max(1, round(iw0 * scale)), max(1, round(ih0 * scale))), Image.LANCZOS),
                 (round(x * scale), round(y * scale)))
    canvas.save(dst, quality=92)
    print(json.dumps({"interior": [iw, ih], "gen": [gw, gh], "gen_aspect": name}))


def frame(src, dst, aspect, insets, interior=None, fill=None, align="center"):
    a, info = load(src)
    h, w, _ = a.shape
    l, t, r, b = insets
    tw, th, (iw0, ih0), (iw, ih) = frame_size(w, h, aspect, insets)
    dx, dy = tw - w, th - h
    out = np.zeros((th, tw, 3))
    out[:t, :l] = a[:t, :l]
    out[:t, tw - r:] = a[:t, w - r:]
    out[th - b:, :l] = a[h - b:, :l]
    out[th - b:, tw - r:] = a[h - b:, w - r:]
    errs = {}
    for name, seg, rows in (("top", a[:t, l:w - r], slice(0, t)), ("bottom", a[h - b:, l:w - r], slice(th - b, th))):
        if dx:
            seg, errs[name] = extend_strip(seg, dx, 1)
        out[rows, l:tw - r] = seg
    for name, seg, cols in (("left", a[t:h - b, :l], slice(0, l)), ("right", a[t:h - b, w - r:], slice(tw - r, tw))):
        if dy:
            seg, errs[name] = extend_strip(seg, dy, 0)
        out[t:th - b, cols] = seg

    inner0 = Image.fromarray(a[t:h - b, l:w - r].astype(np.uint8))
    x, y = place((iw, ih), (iw0, ih0), 0, 0, align)
    if interior:
        _, gw, gh = gen_box(iw, ih)
        full = Image.open(interior).convert("RGB").resize((gw, gh), Image.LANCZOS)
        ox, oy = (gw - iw) // 2, (gh - ih) // 2
        inner = full.crop((ox, oy, ox + iw, oy + ih))
        d = drift(inner, inner0, x, y)
        errs["interior_drift"] = round(d, 1)
        if d <= MAX_DRIFT:
            f = max(3, round(0.02 * min(iw0, ih0)))
            inner.paste(inner0, (x, y), feathered(iw0, ih0, 0, f))
            errs["original_kept"] = True
        else:
            errs["original_kept"] = False
    else:
        colour = np.array(fill, float)
        inner = Image.fromarray(np.full((ih, iw, 3), colour).astype(np.uint8))
        inner.paste(inner0, (x, y))
    out[t:th - b, l:tw - r] = np.asarray(inner, float)
    save(Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), dst, info)
    print(json.dumps(errs))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=("pad-top", "inset", "frame-prep", "frame"))
    p.add_argument("--src", required=True)
    p.add_argument("--dst", required=True)
    p.add_argument("--aspect", default="4:3")
    p.add_argument("--gen", default="")
    p.add_argument("--canvas", default="")
    p.add_argument("--offset", default="")
    p.add_argument("--insets", default="")
    p.add_argument("--interior", default="")
    p.add_argument("--fill", default="")
    p.add_argument("--align", default="center", choices=("center", "bottom"))
    a = p.parse_args()
    if a.mode == "pad-top":
        pad_top(a.src, a.dst, a.aspect)
    elif a.mode == "inset":
        inset(a.src, a.gen, a.dst, json.loads(a.canvas), json.loads(a.offset))
    elif a.mode == "frame-prep":
        frame_prep(a.src, a.dst, a.aspect, json.loads(a.insets), a.align)
    else:
        frame(a.src, a.dst, a.aspect, json.loads(a.insets), a.interior or None,
              json.loads(a.fill) if a.fill else None, a.align)


if __name__ == "__main__":
    main()
