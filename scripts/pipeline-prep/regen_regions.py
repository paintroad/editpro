"""Regenerate small regions of a painting (watermarks, badges, signatures) with an AI edit.

  py -3 regen_regions.py prep  <work_dir>            -> <id>_crop.png, <id>_mask.png, jobs.json
  node regen_regions.js <work_dir>                    -> <id>_out.png (one paid call per painting)
  py -3 regen_regions.py paste <work_dir> <review_dir> -> "<id> regenerated.jpg" + before-after

Only the masked box is replaced in the full-resolution printable file; the rest is untouched.
"""
import json, os, sys
import cv2
import numpy as np

PRINTABLE = r"C:\Users\divya\Downloads\_New Catalog Printable Files"
SIDE = 1024  # sent to OpenAI; stays under the 1080 px ceiling

STYLE_KEEP = "Keep everything outside the masked area exactly as it is. No text, letters, logos, signatures or badges anywhere."
JOBS = {
    "13863": {"box": [0.715, 0.762, 0.90, 0.89], "group": "2 Brand name",
              "prompt": "Remove the oval cream plaque with its gold frame completely. Fill the area by continuing the surrounding deep green background with raised gold floral filigree scrolls, matching their style, lighting and density."},
    "13856": {"box": [0.645, 0.682, 0.716, 0.740], "group": "2 Brand name",
              "prompt": "Remove the round cream seal badge completely. Fill the area by continuing the surrounding deep navy blue textured wall and the neighbouring orange cloth edge and pearl column, matching lighting and texture."},
    "13880": {"box": [0.035, 0.698, 0.29, 0.727], "group": "1 Watermark",
              "prompt": "Remove the overlaid text completely. Continue the dark brown ornate background on the left and the red and gold embroidered cloth folds and gold trim on the right, matching their detail and lighting."},
    "13900": {"box": [0.78, 0.91, 0.85, 0.975], "group": "3 Artist signature",
              "prompt": "Remove the handwritten white text completely. Continue the bright pink dripping paint area with its natural texture and drips, matching the surrounding painting."},
    "13758": {"box": [0.078, 0.934, 0.262, 0.951], "paste_box": [0.0795, 0.9378, 0.2605, 0.9468], "context": 2.2,
              "group": "3 Artist signature",
              "prompt": "Remove the stamped lettering on the horizontal dark brown fabric seam band completely. Keep the band exactly the same thickness, position and colour, as a plain stitched fabric strip. Do not move or change the quilted patches above and below it."},
    "13744": {"box": [0.79, 0.93, 1.0, 0.995], "group": "3 Artist signature",
              "prompt": "Remove the white calligraphy title text completely. Continue the surrounding dense flowers, leaves and foliage in the same illustrated style and colours."},
}


# Full-image row below which the original is kept (the AI redrew the marble ledge edge on 13863).
KEEP_BELOW = {"13863": 4822}


def window(box, w, h, context=1.6):
    x0, y0, x1, y1 = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    side = int(min(max(x1 - x0, y1 - y0) * context + 200, w, h))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    a = int(min(max(0, cx - side / 2), w - side))
    b = int(min(max(0, cy - side / 2), h - side))
    return a, b, side


def prep(work):
    os.makedirs(work, exist_ok=True)
    meta = {}
    for pid, job in JOBS.items():
        img = cv2.imread(os.path.join(PRINTABLE, pid + ".jpg"))
        h, w = img.shape[:2]
        a, b, side = window(job["box"], w, h, job.get("context", 1.6))
        crop = cv2.resize(img[b:b + side, a:a + side], (SIDE, SIDE), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(work, f"{pid}_crop.png"), crop)
        s = SIDE / side
        x0, y0 = int((job["box"][0] * w - a) * s), int((job["box"][1] * h - b) * s)
        x1, y1 = int((job["box"][2] * w - a) * s), int((job["box"][3] * h - b) * s)
        mask = np.full((SIDE, SIDE, 4), 255, np.uint8)
        mask[max(0, y0):y1, max(0, x0):x1, 3] = 0  # transparent = area to regenerate
        cv2.imwrite(os.path.join(work, f"{pid}_mask.png"), mask)
        meta[pid] = {"window": [a, b, side], "mask": [x0, y0, x1, y1], "prompt": job["prompt"] + " " + STYLE_KEEP, "group": job["group"], "paste_box": job.get("paste_box")}
    json.dump(meta, open(os.path.join(work, "jobs.json"), "w"), indent=1)
    print("prepared", list(meta))


def paste(work, review):
    meta = json.load(open(os.path.join(work, "jobs.json")))
    for pid, m in meta.items():
        out_path = os.path.join(work, f"{pid}_out.png")
        if not os.path.isfile(out_path):
            print(pid, "no AI output, skipped")
            continue
        img = cv2.imread(os.path.join(PRINTABLE, pid + ".jpg"))
        a, b, side = m["window"]
        gen = cv2.resize(cv2.imread(out_path), (side, side), interpolation=cv2.INTER_CUBIC)
        s = side / SIDE
        x0, y0, x1, y1 = [int(v * s) for v in m["mask"]]
        pad = max(12, int(0.08 * min(x1 - x0, y1 - y0)))
        alpha = np.zeros((side, side), np.float32)
        if m.get("paste_box"):
            # Paste only this box (full-image fractions) so the AI cannot shift what is around it.
            H, W = img.shape[:2]
            px0, py0, px1, py1 = m["paste_box"]
            x0, y0, x1, y1 = int(px0 * W) - a, int(py0 * H) - b, int(px1 * W) - a, int(py1 * H) - b
            pad = 3
        alpha[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad] = 1
        k = pad * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (k, k), 0)
        keep = KEEP_BELOW.get(pid)
        if keep:
            r = keep - b
            ramp = np.linspace(1, 0, 16, dtype=np.float32)[:, None]
            alpha[max(0, r - 16):r, :] *= ramp[-(r - max(0, r - 16)):]
            alpha[r:, :] = 0
        alpha = alpha[..., None]
        region = img[b:b + side, a:a + side].astype(np.float32)
        result = img.copy()
        result[b:b + side, a:a + side] = (gen * alpha + region * (1 - alpha)).clip(0, 255).astype(np.uint8)
        d = os.path.join(review, m["group"], "Regenerated (AI)")
        os.makedirs(d, exist_ok=True)
        cv2.imwrite(os.path.join(d, f"{pid} regenerated.jpg"), result, [cv2.IMWRITE_JPEG_QUALITY, 95])
        before, after = img[b:b + side, a:a + side], result[b:b + side, a:a + side]
        pair = np.hstack([before, np.full((side, max(8, side // 80), 3), 255, np.uint8), after])
        pair = cv2.resize(pair, (1600, int(pair.shape[0] * 1600 / pair.shape[1])))
        cv2.imwrite(os.path.join(d, f"{pid} before-after.jpg"), pair, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(pid, "pasted ->", d)


if __name__ == "__main__":
    if sys.argv[1] == "prep":
        prep(sys.argv[2])
    else:
        paste(sys.argv[2], sys.argv[3])
