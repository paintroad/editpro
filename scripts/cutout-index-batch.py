"""Remove the studio margin outside the black frame and write a PNG.

Edge-connected near-neutral pixels become transparent, including the gray drop
shadow on the right and bottom. The black frame is much darker, so the flood
stops there and the painting inside the frame stays opaque.
"""
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
# Margin outside the frame bottoms out around 54. Frame pixels are under 25.
WHITE_MIN = 40
WHITE_SPREAD = 18


def find_source(src_dir: Path, product_id: str) -> Path | None:
    """Framed catalog image with no room: {id}/{id}_1_black.jpg."""
    framed = src_dir / product_id / f"{product_id}_1_black.jpg"
    if framed.is_file():
        return framed
    for ext in EXTENSIONS:
        candidate = src_dir / f"{product_id}{ext}"
        if candidate.is_file():
            return candidate
    return None


def is_margin_white(rgb: np.ndarray) -> np.ndarray:
    low = rgb.min(axis=2)
    high = rgb.max(axis=2)
    return (low >= WHITE_MIN) & ((high - low) <= WHITE_SPREAD)


def remove_outer_white(image: Image.Image) -> tuple[Image.Image, str]:
    rgb = np.asarray(image.convert("RGB"))
    removable = is_margin_white(rgb)
    _count, labels = cv2.connectedComponents(removable.astype(np.uint8), connectivity=4)
    border_ids = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    border_ids = border_ids[border_ids != 0]
    visited = np.isin(labels, border_ids) if border_ids.size else np.zeros(removable.shape, dtype=bool)
    alpha = np.where(visited, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])
    removed = float(visited.mean())
    return Image.fromarray(rgba), f"removed {removed:.1%} outer white"


def load_jobs(args: list[str]) -> list[dict[str, str]]:
    if len(args) == 1 and args[0].lower().endswith(".json"):
        payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))
        return [
            {
                "productId": str(job["productId"]),
                "filename": str(job.get("filename") or f"{job['productId']}_0.png"),
            }
            for job in payload
        ]
    return [{"productId": product_id, "filename": f"{product_id}_0.png"} for product_id in args]


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: cutout-index-batch.py <source-dir> <output-dir> <jobs.json | product-id...>",
            file=sys.stderr,
        )
        return 2

    src_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    failed = 0
    succeeded = 0
    for job in load_jobs(sys.argv[3:]):
        product_id = job["productId"]
        filename = Path(job["filename"]).name
        if not filename.lower().endswith(".png"):
            filename = f"{Path(filename).stem}.png"
        dest = out_dir / filename
        source = find_source(src_dir, product_id)
        if source is None:
            print(f"missing {product_id}", flush=True)
            failed += 1
            continue
        try:
            if job.get("copySource"):
                source_copy = out_dir / f"{dest.stem}_source{source.suffix.lower()}"
                shutil.copyfile(source, source_copy)
            image = Image.open(source)
            result, note = remove_outer_white(image)
            result.save(dest)
            print(f"ok {product_id} {filename} {note}", flush=True)
            succeeded += 1
        except Exception as error:  # noqa: BLE001 — report per product and continue
            print(f"error {product_id} {error}", flush=True)
            failed += 1
    print(f"done ok={succeeded} failed={failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
