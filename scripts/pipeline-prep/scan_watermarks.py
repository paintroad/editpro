"""Find text (watermarks, logos, signatures, URLs) in catalog paintings with local OCR (RapidOCR, free).

    py -3 scan_watermarks.py [folder] [report.jsonl]

Reads each painting at 1600 px plus close-ups of its four corners, where watermarks usually sit,
and writes one JSON line per painting with every piece of text found and where it is.
"""
import json
import os
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
FOLDER = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\divya\Downloads\_New Catalog Printable Files"
REPORT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.expanduser("~"), ".editpro", "pipeline-prep", "watermark-scan.jsonl")
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
FULL_PX = 1600
CORNER = 0.32
CORNER_PX = 900

_ocr = None


def ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


def load(path):
    im = Image.open(path)
    im.draft("RGB", (FULL_PX * 2, FULL_PX * 2))
    return im.convert("RGB")


def read(arr, ox, oy, scale, region):
    result, _ = ocr()(arr)
    out = []
    for box, text, score in result or []:
        pts = np.array(box, dtype=float) * scale + [ox, oy]
        out.append({"text": text, "score": round(float(score), 3), "region": region,
                    "box": [round(float(v), 4) for v in (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max())]})
    return out


def scan(path):
    try:
        im = load(path)
        w, h = im.size
        found = []
        s = min(1.0, FULL_PX / max(w, h))
        small = im.resize((max(1, int(w * s)), max(1, int(h * s)))) if s < 1 else im
        res = read(np.array(small), 0, 0, 1.0, "full")
        for t in res:
            t["box"] = [round(t["box"][0] / small.width, 4), round(t["box"][1] / small.height, 4),
                        round(t["box"][2] / small.width, 4), round(t["box"][3] / small.height, 4)]
        found += res
        cw, ch = int(w * CORNER), int(h * CORNER)
        for name, (x, y) in {"top-left": (0, 0), "top-right": (w - cw, 0), "bottom-left": (0, h - ch), "bottom-right": (w - cw, h - ch)}.items():
            crop = im.crop((x, y, x + cw, y + ch))
            cs = min(1.0, CORNER_PX / max(cw, ch))
            if cs < 1:
                crop = crop.resize((max(1, int(cw * cs)), max(1, int(ch * cs))))
            for t in read(np.array(crop), 0, 0, 1.0, name):
                bx = t["box"]
                t["box"] = [round((x + bx[0] / cs) / w, 4), round((y + bx[1] / cs) / h, 4),
                            round((x + bx[2] / cs) / w, 4), round((y + bx[3] / cs) / h, 4)]
                found.append(t)
        return {"file": os.path.basename(path), "size": [w, h], "texts": found}
    except Exception as exc:  # noqa: BLE001
        return {"file": os.path.basename(path), "error": str(exc)}


def main():
    files = sorted(os.path.join(FOLDER, f) for f in os.listdir(FOLDER) if os.path.splitext(f)[1].lower() in EXTS)
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    done = set()
    if os.path.exists(REPORT):
        with open(REPORT, encoding="utf-8") as fh:
            done = {json.loads(line)["file"] for line in fh if line.strip()}
    todo = [f for f in files if os.path.basename(f) not in done]
    print(f"{len(files)} paintings, {len(todo)} to scan", flush=True)
    with open(REPORT, "a", encoding="utf-8") as out, Pool(3) as pool:
        for n, row in enumerate(pool.imap_unordered(scan, todo), 1):
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            if n % 25 == 0 or n == len(todo):
                print(f"{n}/{len(todo)} scanned", flush=True)


if __name__ == "__main__":
    main()
