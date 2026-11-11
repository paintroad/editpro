"""Black base frames (the index image: the painting end to end in a black frame, PNG) for shapes
that have no template: 16:9 (wide) and 9:16 (tall).

    py -3 make_base_frames.py <wide|tall> <set folder> [<set folder> ...]

The filled landscape base of a finished set is cut nine ways (corners keep the moulding and its
edge exactly) and stretched to the new shape, as large as the 1080 canvas allows with the same
outer margin. Writes "1. Base Wide Black.png" / "1. Base Tall Black.png" into each set and its
quad (inner edge of the moulding plus 4 px, meta.filled) into frame-quads.json.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fill_base_frames import UNDER_MOULDING_PX, frame_box  # noqa: E402
from lifestyle_compositor import FRAME_QUADS_PATH  # noqa: E402

SOURCE_SET = r"C:\Users\divya\Downloads\_Frames\_New Lifestyle Sets\Landscape Devotional 1 - Modern Indian Luxe"
SOURCE = "1. Base Landscape Black.png"
CANVAS = 1080
RATIO = {"wide": 16 / 9, "tall": 9 / 16}


def nine_slice(src, out_w, out_h, corner):
    """Stretch src to out_w x out_h, keeping `corner` px at each edge unscaled."""
    h, w = src.shape[:2]
    c = corner
    xs = [(0, c, 0, c), (c, w - c, c, out_w - c), (w - c, w, out_w - c, out_w)]
    ys = [(0, c, 0, c), (c, h - c, c, out_h - c), (h - c, h, out_h - c, out_h)]
    out = np.zeros((out_h, out_w, src.shape[2]), src.dtype)
    for sy0, sy1, dy0, dy1 in ys:
        for sx0, sx1, dx0, dx1 in xs:
            piece = Image.fromarray(src[sy0:sy1, sx0:sx1])
            out[dy0:dy1, dx0:dx1] = np.array(piece.resize((dx1 - dx0, dy1 - dy0), Image.NEAREST))
    return out


def make(shape):
    im = np.array(Image.open(os.path.join(SOURCE_SET, SOURCE)).convert("RGBA"))
    ys, xs = np.nonzero(im[:, :, 3] > 200)
    oy0, oy1, ox0, ox1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    frame = im[oy0:oy1, ox0:ox1]
    left, top, _, _ = frame_box(im)
    moulding = max(left - ox0, top - oy0)
    margin = min(ox0, oy0, CANVAS - ox1, CANVAS - oy1)
    span = CANVAS - 2 * margin
    inner = span - 2 * moulding
    if RATIO[shape] >= 1:
        iw, ih = inner, int(round(inner / RATIO[shape]))
    else:
        iw, ih = int(round(inner * RATIO[shape])), inner
    ow, oh = iw + 2 * moulding, ih + 2 * moulding
    body = nine_slice(frame, ow, oh, moulding + 6)
    body[moulding : moulding + ih, moulding : moulding + iw] = 255
    out = np.zeros((CANVAS, CANVAS, 4), np.uint8)
    x0, y0 = (CANVAS - ow) // 2, (CANVAS - oh) // 2
    out[y0 : y0 + oh, x0 : x0 + ow] = body
    il, it, ir, ib = frame_box(out)
    pad = UNDER_MOULDING_PX
    quad = [((il - pad) / CANVAS, (it - pad) / CANVAS), ((ir + pad) / CANVAS, (it - pad) / CANVAS),
            ((ir + pad) / CANVAS, (ib + pad) / CANVAS), ((il - pad) / CANVAS, (ib + pad) / CANVAS)]
    return out, [[round(x, 6), round(y, 6)] for x, y in quad]


def main(shape, set_dirs):
    img, quad = make(shape)
    name = f"1. Base {shape.capitalize()} Black.png"
    with open(FRAME_QUADS_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    for set_dir in set_dirs:
        set_name = os.path.basename(os.path.normpath(set_dir))
        Image.fromarray(img).save(os.path.join(set_dir, name))
        payload["quads"].setdefault(set_name, {})
        rooms = payload["quads"][set_name]
        rooms[name] = {"points": quad, "meta": {"width": CANVAS, "height": CANVAS, "method": f"moulding-inner+{UNDER_MOULDING_PX}px",
                                                 "orientation": shape.capitalize(), "filled": True}}
        # Base first, like every other set.
        payload["quads"][set_name] = {name: rooms.pop(name), **rooms}
        print(set_name, name, quad)
    with open(FRAME_QUADS_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in RATIO:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2:])
