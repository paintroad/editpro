"""Free local watermark removal: OpenCV inpainting over text masks found by OCR.

py -3 inpaint_watermarks.py <out_dir> <id> [<id> ...]
Reads the printable file, writes "<id> cleaned.jpg" and a before/after crop sheet to out_dir.
Boxes come from watermark-scan.jsonl; extra repeats are found by re-running OCR on the image.
"""
import json, os, sys
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

PRINTABLE = r"C:\Users\divya\Downloads\_New Catalog Printable Files"
SCAN = os.path.expanduser(r"~\.editpro\pipeline-prep\watermark-scan.jsonl")
OCR_SIDE = 2400


def scan_boxes(pid):
    for line in open(SCAN, encoding="utf8"):
        r = json.loads(line)
        if r["file"].startswith(pid + "."):
            return [t["box"] for t in r["texts"]]
    return []


def ocr_boxes(img, pattern):
    h, w = img.shape[:2]
    s = OCR_SIDE / max(h, w)
    small = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    res, _ = RapidOCR()(small)
    out = []
    for pts, text, _score in res or []:
        if pattern.lower() in text.lower().replace(" ", ""):
            xs = [p[0] / small.shape[1] for p in pts]
            ys = [p[1] / small.shape[0] for p in pts]
            out.append([min(xs), min(ys), max(xs), max(ys)])
    return out


def text_mask(region):
    """Pixels that stand out from their surroundings (thin strokes of overlaid text)."""
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    k = max(15, (min(region.shape[:2]) // 2) | 1)
    bg = cv2.medianBlur(gray, k)
    diff = cv2.absdiff(gray, bg)
    _, m = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = cv2.dilate(m, np.ones((5, 5), np.uint8), iterations=2)
    return m


def clone_from_above(img, rects):
    """Cover each box with the texture directly above it, feathered at the edges."""
    out = img.copy().astype(np.float32)
    h, w = img.shape[:2]
    for a, b, c, d in rects:
        bh = d - b
        sb = max(0, b - bh - 10)
        src = img[sb:sb + bh, a:c].astype(np.float32)
        feather = max(9, bh // 4) | 1
        m = np.zeros((h, w), np.float32)
        m[b:d, a:c] = 1
        m = cv2.GaussianBlur(m, (feather * 2 + 1, feather * 2 + 1), 0)[b:d, a:c, None]
        out[b:d, a:c] = src * m + out[b:d, a:c] * (1 - m)
    return out.clip(0, 255).astype(np.uint8)


# Per painting: extra or replacement boxes, boxes to skip (part of the art), method.
OVERRIDES = {
    "13879": {"boxes": [[0.585, 0.955, 0.98, 0.988]], "only_override": True, "method": "clone"},
    "13880": {"skip": lambda bx: bx[1] < 0.3},
    "13926": {"boxes": [[0.4525, 0.9387, 0.565, 0.951]]},
    # Brand names and artist signatures: only the real text, not OCR misreads of the pattern.
    "13393": {"boxes": [[0.8619, 0.9704, 0.9794, 0.9992]], "only_override": True},
    "13744": {"boxes": [[0.8384, 0.9619, 0.9917, 0.9775]], "only_override": True},
    "13758": {"boxes": [[0.0899, 0.9399, 0.1498, 0.9456]], "only_override": True},
    "13778": {"boxes": [[0.7824, 0.8888, 0.8691, 0.9012]], "only_override": True},
    "13856": {"boxes": [[0.6529, 0.6996, 0.7094, 0.7356]], "only_override": True},
    "13863": {"boxes": [[0.749, 0.8056, 0.8679, 0.8482]], "only_override": True},
    "13875": {"boxes": [[0.003, 0.865, 0.0215, 0.97]], "only_override": True, "pad": 4},
    "13900": {"boxes": [[0.789, 0.9531, 0.8599, 0.9725], [0.7938, 0.9236, 0.8322, 0.9364]], "only_override": True},
}


def clean(pid, out_dir, pattern=None):
    src = os.path.join(PRINTABLE, pid + ".jpg")
    img = cv2.imread(src)
    h, w = img.shape[:2]
    ov = OVERRIDES.get(pid, {})
    boxes = [] if ov.get("only_override") else scan_boxes(pid) + (ocr_boxes(img, pattern) if pattern else [])
    boxes = [bx for bx in boxes if not ov.get("skip", lambda _: False)(bx)] + ov.get("boxes", [])
    mask = np.zeros((h, w), np.uint8)
    rects = []
    for x0, y0, x1, y1 in boxes:
        pad = ov.get("pad", int(0.15 * (y1 - y0) * h) + 6)
        a, b = max(0, int(x0 * w) - pad), max(0, int(y0 * h) - pad)
        c, d = min(w, int(x1 * w) + pad), min(h, int(y1 * h) + pad)
        mask[b:d, a:c] = np.maximum(mask[b:d, a:c], text_mask(img[b:d, a:c]))
        rects.append((a, b, c, d))
    if ov.get("method") == "clone":
        out = clone_from_above(img, rects)
    else:
        out = cv2.inpaint(img, mask, 9, cv2.INPAINT_TELEA)
    cv2.imwrite(os.path.join(out_dir, f"{pid} cleaned.jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 95])

    tiles = []
    for a, b, c, d in rects[:6]:
        m = int(0.6 * (d - b)) + 20
        a2, b2, c2, d2 = max(0, a - m), max(0, b - m), min(w, c + m), min(h, d + m)
        pair = np.hstack([img[b2:d2, a2:c2], np.full((d2 - b2, 12, 3), 255, np.uint8), out[b2:d2, a2:c2]])
        tiles.append(cv2.resize(pair, (1400, int(pair.shape[0] * 1400 / pair.shape[1]))))
    sep = np.full((12, 1400, 3), 255, np.uint8)
    sheet = np.vstack(sum([[t, sep] for t in tiles], [])[:-1])
    cv2.imwrite(os.path.join(out_dir, f"{pid} before-after.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(pid, "boxes", len(boxes), "masked px", int((mask > 0).sum()))


if __name__ == "__main__":
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    patterns = {"13926": "scotch", "13880": "darshan"}
    for pid in sys.argv[2:]:
        clean(pid, out_dir, patterns.get(pid))
