"""Border-preserving fixes for artwork that sits on a plain coloured page.

Steps (each optional, driven by a JSON spec):
  rotate  deskew the page ("auto" uses the page-colour mask, or give degrees)
  crop    cut away backing/blank areas: "auto" keeps the page-colour region, or give [l, t, r, b]
  clean   repaint off-colour pixels in the outer band (lines, folds, ragged page edges)
  grow    reach the target aspect by repeating plain bands of columns/rows (borders that run along
          the band stay continuous), or by a tiny non-uniform resize when the change is under 2%

Usage: artwork_border.py --src in.jpg --dst out.jpg --spec '{"aspect": "3:4", "color": [x, y]}'
"""
import argparse
import json
import sys

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
RATIOS = {"3:4": 3 / 4, "4:3": 4 / 3, "1:1": 1.0}


def page_color(a, spec):
    if "rgb" in spec:
        return np.array(spec["rgb"], float)
    h, w, _ = a.shape
    fx, fy = spec.get("color", [0.06, 0.5])
    x, y = int(fx * w), int(fy * h)
    r = max(2, min(w, h) // 100)
    return np.median(a[y - r:y + r + 1, x - r:x + r + 1].reshape(-1, 3), 0)


def color_mask(a, rgb, tol):
    return np.abs(a.astype(np.int16) - rgb.astype(np.int16)).max(2) <= tol


def page_mask(a, rgb, tol):
    m = color_mask(a, rgb, tol).astype(np.uint8)
    k = max(3, min(a.shape[:2]) // 150) | 1
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return m.astype(bool)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == big


def auto_angle(mask):
    pts = cv2.findNonZero(mask.astype(np.uint8))
    hull = cv2.convexHull(pts)
    (_, _), (rw, rh), ang = cv2.minAreaRect(hull)
    if ang > 45:
        ang -= 90
    if ang < -45:
        ang += 90
    return float(ang)


def line_angle(a, share=0.3):
    """Tilt from long straight lines (frame rules, page edges): median deviation from level."""
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    e = cv2.Canny(g, 50, 150)
    h, w = g.shape
    lines = cv2.HoughLinesP(e, 1, np.pi / 1800, threshold=120, minLineLength=int(min(h, w) * share),
                            maxLineGap=8)
    if lines is None:
        return 0.0
    devs, weights = [], []
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        dev = (ang + 45) % 90 - 45
        if abs(dev) < 5:
            devs.append(dev)
            weights.append(np.hypot(x2 - x1, y2 - y1))
    if not devs:
        return 0.0
    order = np.argsort(devs)
    cum = np.cumsum(np.array(weights)[order])
    return float(np.array(devs)[order][np.searchsorted(cum, cum[-1] / 2)])


def profile_angle(a, span=3.0):
    """Tilt that makes edges line up best with rows and columns (sharpest projection profiles)."""
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    s = 900 / max(g.shape)
    g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else g
    e = cv2.Canny(g, 40, 120).astype(np.float32)
    h, w = e.shape
    pad = int(0.03 * max(h, w))
    e[:pad], e[-pad:], e[:, :pad], e[:, -pad:] = 0, 0, 0, 0

    def score(deg):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
        r = cv2.warpAffine(e, M, (w, h))
        return float((r.sum(1) ** 2).sum() + (r.sum(0) ** 2).sum())

    best = max(np.arange(-span, span + 1e-6, 0.1), key=score)
    return float(max(np.arange(best - 0.1, best + 0.1001, 0.02), key=score))


def side_points(a, side, tol, depth=0.3, n=30, run=3):
    """Where each scan line leaving the given edge first stops matching the edge colour."""
    h, w, _ = a.shape
    pts = []
    for t in np.linspace(0.1, 0.9, n):
        if side in ("l", "r"):
            y = int(t * h)
            line = a[max(0, y - 2):y + 3].mean(0)
            line = line if side == "l" else line[::-1]
        else:
            x = int(t * w)
            line = a[:, max(0, x - 2):x + 3].mean(1)
            line = line if side == "t" else line[::-1]
        start = 2
        bg = np.median(line[start:start + 4], 0)
        off = np.abs(line - bg).max(1) > tol
        lim = int(len(line) * depth)
        hit = next((i for i in range(start + 4, lim) if off[i:i + run].all()), None)
        if hit is None:
            continue
        pos = hit if side in ("l", "t") else len(line) - 1 - hit
        pts.append((pos, y) if side in ("l", "r") else (x, pos))
    return np.array(pts, float)


def fit_side(pts, vertical):
    """Robust straight-line fit: x = m*y + c for vertical sides, y = m*x + c otherwise."""
    u, v = (pts[:, 1], pts[:, 0]) if vertical else (pts[:, 0], pts[:, 1])
    keep = np.ones(len(u), bool)
    for _ in range(3):
        m, c = np.polyfit(u[keep], v[keep], 1)
        res = np.abs(v - (m * u + c))
        mad = np.median(res[keep]) + 1e-6
        keep = res <= max(3 * mad, 2.0)
    return m, c


def mask_corners(a, q):
    """Corners of the painting found as the biggest region that is not surround colour."""
    h, w, _ = a.shape
    surround = np.zeros((h, w), bool)
    for fx, fy in q["surround"]:
        x, y = int(fx * w), int(fy * h)
        r = max(3, min(h, w) // 150)
        rgb = np.median(a[y - r:y + r + 1, x - r:x + r + 1].reshape(-1, 3), 0)
        surround |= color_mask(a, rgb, q.get("tol", 30))
    if q.get("white"):
        surround |= a.min(2) > 225
    m = (~surround).astype(np.uint8)
    k = max(5, min(h, w) // 80) | 1
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k * 3, k * 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    cnts, _ = cv2.findContours((lab == big).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    hull = cv2.convexHull(max(cnts, key=cv2.contourArea)).reshape(-1, 2).astype(np.float32)
    s, d = hull.sum(1), hull[:, 0] - hull[:, 1]
    return [hull[np.argmin(s)], hull[np.argmax(d)], hull[np.argmax(s)], hull[np.argmin(d)]]


def quad_warp(a, q):
    pad = q.get("pad", 0)
    if q.get("corners"):
        tl, tr, br, bl = q["corners"]
    elif q.get("surround"):
        tl, tr, br, bl = mask_corners(a, q)
    else:
        tol = q.get("tol", 40)
        sides = {s: fit_side(side_points(a, s, tol), s in ("l", "r")) for s in ("l", "r", "t", "b")}

        def meet(vs, hs):
            (mv, cv), (mh, ch) = sides[vs], sides[hs]
            y = (mh * cv + ch) / (1 - mh * mv)
            return mv * y + cv, y

        tl, tr, br, bl = meet("l", "t"), meet("r", "t"), meet("r", "b"), meet("l", "b")
    src = np.array([tl, tr, br, bl], np.float32)
    W = int(round((np.hypot(*(src[1] - src[0])) + np.hypot(*(src[2] - src[3]))) / 2))
    H = int(round((np.hypot(*(src[3] - src[0])) + np.hypot(*(src[2] - src[1]))) / 2))
    dst = np.array([[pad, pad], [W - 1 - pad, pad], [W - 1 - pad, H - 1 - pad], [pad, H - 1 - pad]], np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(a, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return out, [[round(float(x), 1), round(float(y), 1)] for x, y in src]


def rotate(a, deg):
    h, w, _ = a.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    return cv2.warpAffine(a, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def auto_box(mask, share=0.12):
    cols, rows = mask.mean(0), mask.mean(1)
    xs, ys = np.where(cols >= share)[0], np.where(rows >= share)[0]
    return [int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1]


def clean(a, rgb, tol, band):
    """Replace off-colour pixels in the outer band with the pixel mirrored just inside the band."""
    h, w, _ = a.shape
    bad = ~color_mask(a, rgb, tol)
    out = a.copy()
    for side in ("l", "r", "t", "b"):
        for i in range(band):
            if side == "l":
                src, dst = out[:, 2 * band - i], (slice(None), i)
            elif side == "r":
                src, dst = out[:, w - 1 - 2 * band + i], (slice(None), w - 1 - i)
            elif side == "t":
                src, dst = out[2 * band - i], (i, slice(None))
            else:
                src, dst = out[h - 1 - 2 * band + i], (h - 1 - i, slice(None))
            sel = bad[dst]
            line = out[dst]
            line[sel] = src[sel]
            out[dst] = line
    return out


def margins(a, rgb, tol, full=0.85):
    """Width of the plain page margin on each side: how far the page colour covers almost every
    row (for left/right) or column (for top/bottom)."""
    m = color_mask(a, rgb, tol)
    cols, rows = m.mean(0), m.mean(1)

    def run(p):
        n = 0
        while n < len(p) and p[n] >= full:
            n += 1
        return n

    return run(cols), run(rows), run(cols[::-1]), run(rows[::-1])


def deline(a, rgb, tol, thresh, div=60):
    """Smooth away thin lines, creases and specks inside the plain margins only."""
    h, w, _ = a.shape
    l, t, r, b = margins(a, rgb, tol)
    region = np.zeros((h, w), bool)
    region[:, :max(0, l - 3)] = region[:, w - max(0, r - 3):] = True
    region[:max(0, t - 3)] = region[h - max(0, b - 3):] = True
    k = max(5, min(w, h) // div) | 1
    med = cv2.medianBlur(a, k)
    off = np.abs(a.astype(np.int16) - med.astype(np.int16)).max(2) > thresh
    out = a.copy()
    sel = region & off
    out[sel] = med[sel]
    return out, [l, t, r, b]


def patch(a, rgb, tol, boxes, mode="off"):
    """Inpaint folds, tears and backing showing through inside fractional boxes: either every
    off-page pixel, or ("light") only pale, low-saturation pixels."""
    h, w, _ = a.shape
    mask = np.zeros((h, w), np.uint8)
    if mode == "light":
        hsv = cv2.cvtColor(a, cv2.COLOR_RGB2HSV)
        off = (hsv[..., 2] > 140) & (hsv[..., 1] < 90)
    else:
        off = ~color_mask(a, rgb, tol)
    for x0, y0, x1, y1 in boxes:
        sl = (slice(int(y0 * h), int(y1 * h)), slice(int(x0 * w), int(x1 * w)))
        mask[sl] = off[sl]
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
    return cv2.inpaint(a, mask * 255, 7, cv2.INPAINT_TELEA)


def energy(a):
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))
    e = gx + gy
    return np.percentile(e, 95, axis=0) * 0.5 + e.mean(0)


def best_window(prof, lo, hi, n):
    hi = min(hi, len(prof)) - n
    if hi <= lo:
        return None
    c = np.concatenate([[0], np.cumsum(prof)])
    s = c[lo + n:hi + n] - c[lo:hi]
    return lo + int(np.argmin(s))


def insert_cols(a, n, zones, blend):
    """Add n columns by repeating plain bands chosen inside the given (lo, hi) zones."""
    per = [n // len(zones) + (1 if i < n % len(zones) else 0) for i in range(len(zones))]
    zones = sorted(zip(zones, per), key=lambda z: -z[0][0])
    for (lo, hi), k in zones:
        while k > 0:
            step = min(k, max(4, (hi - lo) // 2 - blend))
            p = best_window(energy(a), lo, hi, step + blend)
            if p is None:
                raise SystemExit(f"zone {lo}-{hi} too narrow for {step + blend} columns")
            left, right = a[:, :p + step + blend], a[:, p:]
            t = np.linspace(0, 1, blend)[None, :, None]
            mid = left[:, -blend:] * (1 - t) + right[:, :blend] * t
            a = np.concatenate([left[:, :-blend], mid.astype(np.uint8), right[:, blend:]], 1)
            k -= step
    return a


def frame_boxes(a, dark, core=0.6):
    """Outer and inner box of a dark frame drawn around the painting."""
    m = a.max(2) < dark
    h, w = m.shape
    ys, xs = slice(int(h * (1 - core) / 2), int(h * (1 + core) / 2)), slice(int(w * (1 - core) / 2), int(w * (1 + core) / 2))
    cols, rows = m[ys].mean(0), m[:, xs].mean(1)

    def side(p):
        i = 0
        while i < len(p) // 3 and p[i] < 0.5:
            i += 1
        j = i
        while j < len(p) // 3 and p[j] >= 0.5:
            j += 1
        return i, j

    (lo, li), (ro, ri) = side(cols), side(cols[::-1])
    (to, ti), (bo, bi) = side(rows), side(rows[::-1])
    return [lo, to, w - ro, h - bo], [li, ti, w - ri, h - bi]


def grow(a, aspect, spec, pad=0):
    h, w, _ = a.shape
    ratio = RATIOS[aspect]
    W, H = w + 2 * pad, h + 2 * pad
    TW, TH = (round(H * ratio), H) if W / H < ratio else (W, round(W / ratio))
    tw, th = TW - 2 * pad, TH - 2 * pad
    if (tw, th) == (w, h):
        return a
    if "crop_fit" in spec:
        share = spec["crop_fit"]
        if tw > w:
            keep = round((w + 2 * pad) / ratio) - 2 * pad
            cut = h - keep
            top = round(cut * share)
            return a[top:top + keep]
        keep = round((h + 2 * pad) * ratio) - 2 * pad
        cut = w - keep
        left = round(cut * share)
        return a[:, left:left + keep]
    if max(tw / w, th / h) - 1 <= spec.get("resize_max", 0.02):
        return np.asarray(Image.fromarray(a).resize((tw, th), Image.LANCZOS))
    t = tw == w
    if t:
        a = a.transpose(1, 0, 2)
    length = a.shape[1]
    key = "zones_y" if t else "zones_x"
    edge = max(4, int(length * 0.015))
    zones = spec.get(key) or [[edge, length // 3], [length * 2 // 3, length - edge]]
    zones = [(int(lo * length) if lo <= 1 else int(lo), int(hi * length) if hi <= 1 else int(hi))
             for lo, hi in zones]
    a = insert_cols(a, (th - h) if t else (tw - w), zones, spec.get("blend", 12))
    return a.transpose(1, 0, 2) if t else a


def run(src, dst, spec):
    im = Image.open(src)
    info = dict(im.info)
    a = np.asarray(im.convert("RGB"))
    tol = spec.get("tol", 40)
    rgb = page_color(a, spec)
    log = {"rgb": [int(v) for v in rgb]}
    if spec.get("quad"):
        stages = spec["quad"] if isinstance(spec["quad"], list) else [spec["quad"]]
        log["quad"] = []
        for q in stages:
            a, corners = quad_warp(np.ascontiguousarray(a), q)
            log["quad"].append(corners)
    rot = spec.get("rotate", 0)
    if rot == "auto":
        rot = auto_angle(page_mask(a, rgb, tol))
    elif rot == "lines":
        rot = line_angle(a)
    elif rot == "profile":
        rot = profile_angle(a)
    if rot:
        a = rotate(a, rot)
    log["rotate"] = round(float(rot), 2)
    crop = spec.get("crop")
    if crop == "auto":
        crop = auto_box(page_mask(a, rgb, tol))
    if crop:
        ins = spec.get("inset", 0.006)
        ins = round(ins * min(a.shape[:2])) if ins < 1 else int(ins)
        l, t, r, b = crop
        a = a[t + ins:b - ins, l + ins:r - ins]
        log["crop"] = [l + ins, t + ins, r - ins, b - ins]
    if spec.get("clean"):
        band = spec["clean"]
        band = round(band * min(a.shape[:2])) if band < 1 else int(band)
        a = clean(a, rgb, spec.get("clean_tol", tol + 15), band)
    if spec.get("patch"):
        a = patch(np.ascontiguousarray(a), rgb, spec.get("patch_tol", tol), spec["patch"],
                  spec.get("patch_mode", "off"))
    if spec.get("deline"):
        a, log["margins"] = deline(np.ascontiguousarray(a), rgb, tol, spec.get("deline_tol", 28),
                                   spec.get("deline_div", 60))
    if spec.get("frame"):
        outer, inner = frame_boxes(a, spec["frame"])
        widths = [inner[0] - outer[0], inner[1] - outer[1], outer[2] - inner[2], outer[3] - inner[3]]
        fw = int(spec.get("frame_width") or np.median(widths))
        frame_px = a[outer[1]:outer[3], outer[0]:outer[0] + max(1, widths[0])].reshape(-1, 3)
        fcol = np.median(frame_px[frame_px.max(1) < spec["frame"]], 0).astype(np.uint8)
        ins = spec.get("frame_inset", 2)
        a = a[inner[1] + ins:inner[3] - ins, inner[0] + ins:inner[2] - ins]
        log.update(frame_outer=outer, frame_inner=inner, frame_widths=widths, frame_width=fw)
        if spec.get("aspect"):
            a = grow(np.ascontiguousarray(a), spec["aspect"], spec, pad=fw)
        a = np.pad(a, ((fw, fw), (fw, fw), (0, 0)))
        a[:fw], a[-fw:], a[:, :fw], a[:, -fw:] = fcol, fcol, fcol, fcol
    elif spec.get("aspect"):
        a = grow(np.ascontiguousarray(a), spec["aspect"], spec)
    log["size"] = [a.shape[1], a.shape[0]]
    kw = {"icc_profile": info["icc_profile"]} if info.get("icc_profile") else {}
    if dst.lower().endswith((".jpg", ".jpeg")):
        kw.update(quality=95, subsampling=0)
    Image.fromarray(np.ascontiguousarray(a)).save(dst, **kw)
    print(json.dumps(log))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--dst", required=True)
    p.add_argument("--spec", default="{}")
    a = p.parse_args()
    run(a.src, a.dst, json.loads(a.spec))


if __name__ == "__main__":
    sys.exit(main())
