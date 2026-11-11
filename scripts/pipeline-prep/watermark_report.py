"""Summarise watermark-scan.jsonl: flag paintings whose text looks like a watermark, logo, URL or
signature line, and save close-up crops of each hit for review.

    py -3 watermark_report.py [report.jsonl] [printable folder] [out folder]
"""
import json
import os
import re
import sys

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
REPORT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.expanduser("~"), ".editpro", "pipeline-prep", "watermark-scan.jsonl")
FOLDER = sys.argv[2] if len(sys.argv) > 2 else r"C:\Users\divya\Downloads\_New Catalog Printable Files"
OUT = sys.argv[3] if len(sys.argv) > 3 else r"C:\Users\divya\Downloads\_Watermark review"

STRONG = re.compile(
    r"(即梦|梦|用户|\bAI\b|A1@|@|www|\.com|\.in\b|http|©|copyright|shutterstock|dreamstime|freepik|alamy|getty|"
    r"istock|adobe|depositphotos|123rf|pinterest|etsy|midjourney|leonardo|canva|watermark|stock|"
    r"atrang|nakh|instagram|facebook|youtube|tiktok|xiaohongshu|小红书|抖音|doubao|豆包|kling|可灵)",
    re.I,
)
MIN_SCORE = 0.6


def merge(texts):
    seen = []
    for t in sorted(texts, key=lambda t: -t["score"]):
        b = t["box"]
        if any(abs(b[0] - s["box"][0]) < 0.03 and abs(b[1] - s["box"][1]) < 0.03 for s in seen):
            continue
        seen.append(t)
    return seen


def main():
    rows = [json.loads(line) for line in open(REPORT, encoding="utf-8") if line.strip()]
    os.makedirs(OUT, exist_ok=True)
    strong, other = [], []
    for row in rows:
        texts = [t for t in row.get("texts", []) if t["score"] >= MIN_SCORE and len(t["text"].strip()) >= 2]
        if not texts:
            continue
        texts = merge(texts)
        hits = [t for t in texts if STRONG.search(t["text"])]
        (strong if hits else other).append((row, hits or texts))
    print(f"scanned {len(rows)}, likely watermark {len(strong)}, other text {len(other)}")
    for label, group in (("LIKELY", strong), ("OTHER", other)):
        for row, texts in sorted(group, key=lambda g: g[0]["file"]):
            print(label, row["file"], " | ".join(f'{t["text"]} ({t["region"]}, {t["score"]})' for t in texts[:4]))
    for row, texts in strong + other:
        path = os.path.join(FOLDER, row["file"])
        im = Image.open(path)
        im.draft("RGB", (1600, 1600))
        im = im.convert("RGB")
        w, h = im.size
        for k, t in enumerate(texts[:3]):
            x0, y0, x1, y1 = t["box"]
            pad = 0.04
            box = (max(0, int((x0 - pad) * w)), max(0, int((y0 - pad) * h)), min(w, int((x1 + pad) * w)), min(h, int((y1 + pad) * h)))
            crop = im.crop(box)
            draw = ImageDraw.Draw(crop)
            draw.rectangle((int(x0 * w) - box[0], int(y0 * h) - box[1], int(x1 * w) - box[0], int(y1 * h) - box[1]), outline=(255, 0, 255), width=2)
            tag = "likely" if (row, texts) in strong else "other"
            crop.save(os.path.join(OUT, f"{tag}_{os.path.splitext(row['file'])[0]}_{k}.jpg"), quality=88)


if __name__ == "__main__":
    main()
