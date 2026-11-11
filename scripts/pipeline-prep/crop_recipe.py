"""Render a crop-review recipe: box in source fractions (may reach past the image, padded with fill, or with
the image's own edge pixels stretched outwards when extend is set), then optional cover strips painted over
the result's edges."""
import numpy as np
from PIL import Image


def render(src, recipe):
    """src: PIL image (RGB). recipe: {frac, fill?, extend?, cover?}. Returns a new PIL image."""
    W, H = src.size
    x0, y0, x1, y1 = recipe["frac"]
    box = (round(x0 * W), round(y0 * H), round(x1 * W), round(y1 * H))
    fill = tuple(recipe.get("fill") or (255, 255, 255))
    out = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), fill)
    sx0, sy0, sx1, sy1 = max(0, box[0]), max(0, box[1]), min(W, box[2]), min(H, box[3])
    px0, py0 = sx0 - box[0], sy0 - box[1]
    out.paste(src.crop((sx0, sy0, sx1, sy1)), (px0, py0))
    if recipe.get("extend"):
        a = np.array(out)
        px1, py1 = px0 + (sx1 - sx0), py0 + (sy1 - sy0)
        a[:, :px0] = a[:, px0:px0 + 1]
        a[:, px1:] = a[:, px1 - 1:px1]
        a[:py0] = a[py0:py0 + 1]
        a[py1:] = a[py1 - 1:py1]
        out = Image.fromarray(a)
    ow, oh = out.size
    for side, c in (recipe.get("cover") or {}).items():
        n = round(c["size"] * (oh if side in ("top", "bottom") else ow))
        if n <= 0:
            continue
        strip = Image.new("RGB", (ow, n) if side in ("top", "bottom") else (n, oh), tuple(c["color"]))
        out.paste(strip, {"top": (0, 0), "bottom": (0, oh - n), "left": (0, 0), "right": (ow - n, 0)}[side])
    return out
