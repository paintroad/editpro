"""Repaint the wall of a lifestyle-set room in another colour, keeping its light and shadow, so the
rooms of one set do not all share the same paint. Only wall pixels connected to the plain wall
beside the frame change; the frame, furniture, ceiling, trim and floor keep their colours.

    python scripts/frames/recolour_walls.py "<set>" "<room file>" <#rrggbb> <out.jpg | --write> [--strict]

--write replaces the room image in the set folder (run keep_before.js first) and records the paint
in its frame-quads meta (wallPaint). The frame quad is unchanged.
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = r"C:\Users\divya\Downloads\_Frames\_New Lifestyle Sets"
QUADS = os.path.join(os.path.dirname(__file__), "..", "frame-quads.json")
BEFORE = os.path.join(os.path.expanduser("~"), ".editpro", "lifestyle-sets", "before")
# Wall pixels: chroma within AB_TOL of the wall paint and lightness within L_TOL (shading varies more).
AB_TOL = 9.0
L_TOL = 28.0


def lab_of(rgb):
    px = np.uint8([[rgb[::-1]]])
    return cv2.cvtColor(px, cv2.COLOR_BGR2LAB).astype(np.float32)[0, 0]


def wall_mask(img, quad, strict=False):
    h, w = img.shape[:2]
    p = (np.array(quad) * [w, h]).astype(int)
    x0, y0 = p.min(0)
    x1, y1 = p.max(0)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    pad = max(8, (x1 - x0) // 40)
    beside = np.concatenate([lab[y0:y1, max(0, x0 - 6 * pad):max(1, x0 - 2 * pad)].reshape(-1, 3),
                             lab[y0:y1, min(w - 1, x1 + 2 * pad):x1 + 6 * pad].reshape(-1, 3),
                             lab[max(0, y0 - 5 * pad):max(1, y0 - 2 * pad), x0:x1].reshape(-1, 3)])
    ref = np.median(beside, 0)
    d_ab = np.hypot(lab[..., 1] - ref[1], lab[..., 2] - ref[2])
    d_l = np.abs(lab[..., 0] - ref[0])
    block = np.zeros((h, w), bool)
    block[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad] = True
    # Painted walls drift smoothly in tone across the room (light falloff, lime-wash clouding), so
    # model the paint as a smooth surface over the image and keep pixels that sit close to it.
    smooth = cv2.cvtColor(cv2.bilateralFilter(img, 9, 25, 9), cv2.COLOR_BGR2LAB).astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    xn, yn = xx / w - 0.5, yy / h - 0.5
    feats = np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn,
                      xn ** 3, xn * xn * yn, xn * yn * yn, yn ** 3], -1)
    sample = (d_ab < 2.5 * AB_TOL) & (d_l < L_TOL) & ~block
    pts = np.argwhere(sample)
    rng = np.random.default_rng(0)
    pts = pts[rng.choice(len(pts), min(len(pts), 30000), replace=False)]
    F, V = feats[pts[:, 0], pts[:, 1]], smooth[pts[:, 0], pts[:, 1]]
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(F, V, rcond=None)
        res = V - F @ coef
        sig = np.maximum(res.std(0), 1.0)
        keep = (np.abs(res) < 2.0 * sig).all(1)
        F, V = F[keep], V[keep]
    model = feats @ coef
    r_l = np.abs(smooth[..., 0] - model[..., 0])
    r_ab = np.hypot(smooth[..., 1] - model[..., 1], smooth[..., 2] - model[..., 2])
    near_neutral = np.hypot(ref[1] - 128, ref[2] - 128) < 16
    mask = ((r_l < max(12.0, 4 * sig[0])) & (r_ab < (4.5 if near_neutral else max(8.0, 4 * np.hypot(sig[1], sig[2]))))).astype(np.uint8)
    mask[block] = 0
    busy = np.zeros((h, w), bool)
    if strict:
        # Foliage in the paint's own colour passes the colour tests; plaster is far smoother.
        mean = cv2.blur(lab[..., 0], (7, 7))
        tex = np.sqrt(np.maximum(cv2.blur(lab[..., 0] ** 2, (7, 7)) - mean ** 2, 0))
        busy = tex > max(5.0, 2.5 * float(np.median(tex[mask > 0])))
        mask[busy] = 0
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # Keep only wall regions touching the plain wall right beside the frame.
    seeds = np.zeros_like(mask)
    seeds[y0:y1, max(0, x0 - 6 * pad):max(1, x0 - 2 * pad)] = 1
    seeds[y0:y1, min(w - 1, x1 + 2 * pad):x1 + 6 * pad] = 1
    seeds[max(0, y0 - 5 * pad):max(1, y0 - 2 * pad), x0:x1] = 1
    _, labels = cv2.connectedComponents(mask)
    ids = np.unique(labels[(seeds > 0) & (mask > 0)])
    mask = np.isin(labels, ids[ids > 0]).astype(np.uint8)
    # Grow into neighbouring pixels that are a looser match (strong light falloff at wall edges),
    # one step at a time so it only reaches wall connected to what was found.
    # Corners and side walls are the same paint in deeper shade, so lightness may drift far; the
    # colour may drift only in proportion to how strong the paint is (white upholstery against a
    # soft blue is a small colour step). Neutral paint is close to cream upholstery, so it grows little.
    chroma = float(np.hypot(ref[1] - 128, ref[2] - 128))
    if near_neutral:
        loose = (r_l < 1.3 * max(12.0, 4 * sig[0])) & (r_ab < 1.3 * 4.5)
    else:
        loose = (r_l < 3 * max(12.0, 4 * sig[0])) & (r_ab < max(6.0, 0.45 * chroma))
    hue = np.degrees(np.arctan2(smooth[..., 2] - 128, smooth[..., 1] - 128))
    ref_hue = np.degrees(np.arctan2(ref[2] - 128, ref[1] - 128))
    dh = np.abs((hue - ref_hue + 180) % 360 - 180)
    px_chroma = np.hypot(smooth[..., 1] - 128, smooth[..., 2] - 128)
    if not near_neutral and not strict:
        # Shadows on a painted wall (cast by a canvas or a plant) keep the paint's hue at lower
        # lightness and chroma. --strict skips this where plants share the wall's hue.
        loose |= (dh < 7) & (px_chroma > 0.35 * chroma) & (px_chroma < 1.3 * chroma) & (smooth[..., 0] < ref[0] + 10)
    loose = loose.astype(np.uint8)
    loose[block | busy] = 0
    for _ in range(60):
        grown = cv2.dilate(mask, np.ones((3, 3), np.uint8)) & loose
        if (grown == mask).all():
            break
        mask = grown
    # Fill small holes left by plaster texture; large holes are furniture and decor.
    n, holes, stats, _ = cv2.connectedComponentsWithStats(1 - mask)
    for i in range(1, n):
        x, y, ww, hh, area = stats[i]
        if area < 0.002 * h * w and x > 0 and y > 0 and x + ww < w and y + hh < h:
            mask[holes == i] = 1
    # Paint under the frame block too, so the wall right up to the moulding changes evenly.
    ring = block.copy()
    ring[y0:y1, x0:x1] = False
    mask[ring & (r_l < 3 * max(6.0, sig[0])) & (r_ab < 3 * max(4.0, sig[1]))] = 1
    if not near_neutral:
        # The frame's drop shadow on a coloured wall: same hue, darker.
        mask[ring & (dh < 12) & (px_chroma > 0.4 * chroma) & (px_chroma < 1.3 * chroma)] = 1
    # The dark gap between wall and moulding is a few px wide; the moulding itself stops the growth
    # unless it is darker than the wall.
    near = cv2.dilate(block.astype(np.uint8), np.ones((2 * pad + 1, 2 * pad + 1), np.uint8)) > 0
    near[y0:y1, x0:x1] = False
    gap = (near & (lab[..., 0] < ref[0])).astype(np.uint8)
    for _ in range(4):
        mask |= cv2.dilate(mask, np.ones((3, 3), np.uint8)) & gap
    return mask, ref, lab, model


def recolour(img, quad, hex_colour, strict=False):
    target = lab_of([int(hex_colour.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)])
    mask, ref, lab, model = wall_mask(img, quad, strict)
    alpha = cv2.GaussianBlur(mask.astype(np.float32), (5, 5), 0)[..., None]
    out = lab.copy()
    out[..., 0] = np.clip(lab[..., 0] + (target[0] - ref[0]), 0, 255)
    ref_chroma = float(np.hypot(ref[1] - 128, ref[2] - 128))
    if ref_chroma >= 16:
        # Coloured paint: every wall pixel takes the new hue, keeping its saturation relative to the
        # wall around it, so shadows stay duller and texture stays.
        ratio = np.hypot(lab[..., 1] - 128, lab[..., 2] - 128) / ref_chroma
        out[..., 1] = np.clip(128 + (target[1] - 128) * ratio, 0, 255)
        out[..., 2] = np.clip(128 + (target[2] - 128) * ratio, 0, 255)
    else:
        # Near-neutral paint: the new colour plus the wall's own texture and a little of its light drift.
        out[..., 1] = np.clip(target[1] + (lab[..., 1] - model[..., 1]) + 0.3 * (model[..., 1] - ref[1]), 0, 255)
        out[..., 2] = np.clip(target[2] + (lab[..., 2] - model[..., 2]) + 0.3 * (model[..., 2] - ref[2]), 0, 255)
    mixed = lab * (1 - alpha) + out * alpha
    return cv2.cvtColor(mixed.astype(np.uint8), cv2.COLOR_LAB2BGR), float(mask.mean())


def main():
    set_name, room, hex_colour, dest = sys.argv[1:5]
    quads = json.load(open(QUADS, encoding="utf8"))
    entry = quads["quads"][set_name][room]
    path = os.path.join(ROOT, set_name, room)
    # Always paint from the room as it was before any repaint, so reruns do not compound.
    before = os.path.join(BEFORE, set_name, room)
    img = cv2.imread(before if entry.get("meta", {}).get("wallPaint") and os.path.exists(before) else path)
    out, share = recolour(img, entry["points"], hex_colour, "--strict" in sys.argv[5:])
    if dest == "--write":
        cv2.imwrite(path, out, [cv2.IMWRITE_JPEG_QUALITY, 95])
        entry.setdefault("meta", {})["wallPaint"] = hex_colour
        with open(QUADS, "w", encoding="utf8") as f:
            f.write(json.dumps(quads, indent=2) + "\n")
    else:
        cv2.imwrite(dest, out, [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(json.dumps({"room": f"{set_name}/{room}", "paint": hex_colour, "wallShare": round(share, 3)}))


if __name__ == "__main__":
    main()
