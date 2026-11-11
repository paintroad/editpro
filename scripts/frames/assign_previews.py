#!/usr/bin/env python3
"""Renders set-assignment previews: one painting in one room per job, many jobs per process.

    py -3 assign_previews.py <jobs.json> <worker> <workers>

jobs.json: [{"painting", "frame", "frameTemplate", "frameSet", "orientation", "out"}]. Each output is
saved at PREVIEW_LONG px. Prints one JSON line per job.
"""
import json
import os
import sys
import tempfile

import cv2

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from lifestyle_compositor import composite_painting_into_frame  # noqa: E402

PREVIEW_LONG = 760


def main() -> int:
    jobs_file, worker, workers = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    with open(jobs_file, encoding="utf8") as fh:
        jobs = json.load(fh)[worker::workers]
    tmp = tempfile.mkdtemp(prefix="assign-preview-")
    for job in jobs:
        try:
            raw = os.path.join(tmp, "full.jpg")
            composite_painting_into_frame(
                job["painting"], job["frame"], raw, canvas_size=1080, jpeg_quality=92,
                orientation=job["orientation"], frame_template=job["frameTemplate"], frame_set=job["frameSet"],
            )
            img = cv2.imread(raw, cv2.IMREAD_COLOR)
            h, w = img.shape[:2]
            s = PREVIEW_LONG / max(h, w)
            if s < 1:
                img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
            os.makedirs(os.path.dirname(job["out"]), exist_ok=True)
            part = job["out"] + ".part.jpg"
            cv2.imwrite(part, img, [cv2.IMWRITE_JPEG_QUALITY, 84])
            os.replace(part, job["out"])
            print(json.dumps({"ok": job["out"]}), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": str(exc), "out": job["out"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
