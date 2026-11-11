"""Sort paintings by what runs along their edges:
  border  - a painted border/frame inside the painting (straight lines parallel to 3+ edges)
  space   - plain blank space around the painting (uniform strips on 2+ sides)
  bleed   - the painting runs to the edges

    py -3 classify_edges.py <out_csv> <file>...   (or a folder as the only file argument)
"""
import csv, os, sys
import cv2
import numpy as np

SIDE = 400
LINE_GRAD = 22        # brightness step that counts as part of a straight line
LINE_COVER = 0.6      # share of a row/column that must be on that line
BORDER_REACH = 0.14   # look for frame lines within this share of each edge
MIN_INSET = 0.01
PLAIN_STRIP = 0.03    # outer strip checked for blank space
PLAIN_STD = 7.0


def load(path):
    img = cv2.imread(path)
    h, w = img.shape[:2]
    s = SIDE / max(h, w)
    return cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)


def line_insets(gray):
    """Per side, distance from that edge (share of size) where a straight line runs along most of it."""
    h, w = gray.shape
    gy = np.abs(np.diff(gray.astype(np.float32), axis=0))
    gx = np.abs(np.diff(gray.astype(np.float32), axis=1))
    rows = (gy > LINE_GRAD).mean(axis=1)
    cols = (gx > LINE_GRAD).mean(axis=0)
    reach_h, reach_w = max(2, int(h * BORDER_REACH)), max(2, int(w * BORDER_REACH))
    # Lines hugging the image edge are outlines or scan edges, not a painted border.
    skip_h, skip_w = max(1, int(h * MIN_INSET)), max(1, int(w * MIN_INSET))
    sides = {
        "top": [i / h for i in range(skip_h, reach_h) if rows[i] >= LINE_COVER],
        "bottom": [(h - 1 - i) / h for i in range(h - reach_h, h - 1 - skip_h) if rows[i] >= LINE_COVER],
        "left": [i / w for i in range(skip_w, reach_w) if cols[i] >= LINE_COVER],
        "right": [(w - 1 - i) / w for i in range(w - reach_w, w - 1 - skip_w) if cols[i] >= LINE_COVER],
    }
    return sides


def plain_sides(img):
    h, w = img.shape[:2]
    sh, sw = max(2, int(h * PLAIN_STRIP)), max(2, int(w * PLAIN_STRIP))
    strips = {"top": img[:sh], "bottom": img[-sh:], "left": img[:, :sw], "right": img[:, -sw:]}
    return [k for k, s in strips.items() if s.reshape(-1, 3).std(axis=0).max() < PLAIN_STD]


def matched(a, b, tol=0.025):
    """Opposite sides carry a frame line at about the same distance from their edge."""
    return any(abs(x - y) <= tol for x in a for y in b)


def classify(path):
    img = load(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    plain = plain_sides(img)
    lines = line_insets(gray)
    framed = [k for k, v in lines.items() if v]
    pairs = matched(lines["top"], lines["bottom"]) + matched(lines["left"], lines["right"])
    if pairs == 2 or (pairs == 1 and len(framed) >= 3 and len(plain) < 2):
        return "border", plain, framed
    if len(plain) >= 2:
        return "space", plain, framed
    return "bleed", plain, framed


def main():
    out, args = sys.argv[1], sys.argv[2:]
    if len(args) == 1 and os.path.isdir(args[0]):
        args = [os.path.join(args[0], f) for f in os.listdir(args[0])]
    with open(out, "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(("path", "edge_type", "plain_sides", "line_sides"))
        for p in args:
            kind, plain, framed = classify(p)
            wr.writerow((p, kind, "|".join(plain), "|".join(framed)))


if __name__ == "__main__":
    main()
