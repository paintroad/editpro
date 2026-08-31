#!/usr/bin/env python3
"""Classify frame colour (Black / White / Wooden) from lifestyle composites.

Samples pixels in a border band outside the painting quad and compares to
prototypes from base reference frames (or fixed Lab centroids).

Usage:
  python scripts/detect-frame-colour.py --image path.jpg --frame-set Portrait --template "2. Living Room.jpg"
  python scripts/detect-frame-colour.py --batch-json items.json --apply-map
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import cv2
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
QUADS_PATH = os.path.join(SCRIPTS_DIR, "frame-quads.json")
DEFAULT_FRAMES_ROOT = r"C:\Users\divya\Downloads\_Frame References"

COLOURS = ("Black", "White", "Wooden")


def load_quads(path: str = QUADS_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload.get("quads") or {}


def quad_for(quads: dict, frame_set: str, template: str) -> Optional[np.ndarray]:
    entry = (quads.get(frame_set) or {}).get(template)
    if not entry:
        return None
    points = entry.get("points")
    if not points or len(points) != 4:
        return None
    return np.array(points, dtype=np.float32)


def sample_frame_lab(image_bgr: np.ndarray, quad_norm: np.ndarray, band_frac: float = 0.04) -> np.ndarray:
    """Sample Lab from frame moulding: outer band, excluding near-white mat/canvas."""
    h, w = image_bgr.shape[:2]
    t = max(8, int(min(h, w) * 0.12))
    rim = np.zeros((h, w), dtype=np.uint8)
    rim[:t, :] = 255
    rim[-t:, :] = 255
    rim[:, :t] = 255
    rim[:, -t:] = 255

    if quad_norm is not None:
        quad = quad_norm.copy()
        quad[:, 0] *= w
        quad[:, 1] *= h
        inner = np.zeros((h, w), dtype=np.uint8)
        cv2.fillConvexPoly(inner, quad.astype(np.int32), 255)
        # Keep only rim pixels outside the painting
        rim = cv2.bitwise_and(rim, cv2.bitwise_not(inner))

    # Drop near-white canvas/mat so we keep moulding (black / wood / off-white frame)
    bgr = image_bgr.astype(np.float32)
    near_white = (
        (bgr[:, :, 0] > 245) & (bgr[:, :, 1] > 245) & (bgr[:, :, 2] > 245)
    )
    rim[near_white] = 0

    ys, xs = np.where(rim > 0)
    if len(xs) < 40:
        # Fallback: darkest 5% of outer 15% band (include near-white exclusion off)
        rim = np.zeros((h, w), dtype=np.uint8)
        rim[:t, :] = 255
        rim[-t:, :] = 255
        rim[:, :t] = 255
        rim[:, -t:] = 255
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        vals = gray[rim > 0]
        if vals.size:
            thr = np.percentile(vals, 15)
            rim[(rim > 0) & (gray > thr)] = 0
        ys, xs = np.where(rim > 0)

    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    samples = lab[ys, xs]
    return np.median(samples, axis=0)


def prototype_from_base(frames_root: str, frame_set: str, colour: str, quads: dict) -> Optional[np.ndarray]:
    orient = frame_set.split()[0]  # Portrait / Landscape / Square
    # Try exact base filename patterns
    candidates = [
        f"1. Base {orient} {colour}.jpg",
        f"1. Base {frame_set} {colour}.jpg",
    ]
    set_dir = os.path.join(frames_root, frame_set)
    for name in candidates:
        path = os.path.join(set_dir, name)
        if not os.path.isfile(path):
            continue
        image = cv2.imread(path, cv2.IMREAD_COLOR)
        if image is None:
            continue
        q = quad_for(quads, frame_set, name)
        if q is None:
            # Use Null geometry if present
            q = quad_for(quads, frame_set, "1. Null.jpg")
        if q is None:
            # Center inset fallback
            q = np.array([[0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85]], dtype=np.float32)
        return sample_frame_lab(image, q)
    return None


def fixed_prototypes() -> dict[str, np.ndarray]:
    # Approximate Lab centroids
    return {
        "Black": np.array([25.0, 128.0, 128.0], dtype=np.float32),
        "White": np.array([230.0, 128.0, 128.0], dtype=np.float32),
        "Wooden": np.array([120.0, 140.0, 155.0], dtype=np.float32),
    }


def classify_lab(sample: np.ndarray, prototypes: dict[str, np.ndarray]) -> tuple[str, float]:
    best = "Black"
    best_dist = float("inf")
    dists = {}
    for name, proto in prototypes.items():
        d = float(np.linalg.norm(sample - proto))
        dists[name] = d
        if d < best_dist:
            best_dist = d
            best = name
    # Confidence: inverse relative gap
    ordered = sorted(dists.values())
    second = ordered[1] if len(ordered) > 1 else best_dist + 1
    conf = max(0.0, min(1.0, 1.0 - best_dist / max(second, 1e-3)))
    return best, round(conf, 4)


def classify_image(
    image_path: str,
    frame_set: str,
    template: str,
    frames_root: str = DEFAULT_FRAMES_ROOT,
    quads_path: str = QUADS_PATH,
) -> dict:
    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None:
        return {"error": f"Could not read image: {image_path}", "frameColour": None}

    quads = load_quads(quads_path)
    q = quad_for(quads, frame_set, template)
    if q is None:
        q = np.array([[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82]], dtype=np.float32)

    sample = sample_frame_lab(image, q)
    prototypes = fixed_prototypes()
    for colour in COLOURS:
        proto = prototype_from_base(frames_root, frame_set, colour, quads)
        if proto is not None:
            prototypes[colour] = proto

    label, confidence = classify_lab(sample, prototypes)
    return {
        "frameColour": label,
        "confidence": confidence,
        "sampleLab": [round(float(x), 2) for x in sample.tolist()],
        "imagePath": image_path,
        "frameSet": frame_set,
        "frameTemplate": template,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect Black/White/Wooden frame colour")
    parser.add_argument("--image", default="", help="Single lifestyle image path")
    parser.add_argument("--frame-set", default="", help="Frame set name e.g. Portrait")
    parser.add_argument("--template", default="", help="Frame template filename")
    parser.add_argument("--frames-root", default=DEFAULT_FRAMES_ROOT)
    parser.add_argument("--quads", default=QUADS_PATH)
    parser.add_argument("--batch-json", default="", help="JSON list of {imagePath,frameSet,frameTemplate,mapKey?}")
    parser.add_argument("--apply-map", action="store_true", help="Write frameColour into ~/.editpro/image-room-map.json")
    args = parser.parse_args()

    results = []
    if args.batch_json:
        with open(args.batch_json, "r", encoding="utf-8") as handle:
            items = json.load(handle)
        if isinstance(items, dict):
            items = items.get("items") or []
        for item in items:
            row = classify_image(
                item["imagePath"],
                item.get("frameSet") or item.get("frame_set") or "Portrait",
                item.get("frameTemplate") or item.get("frame_template") or "",
                frames_root=args.frames_root,
                quads_path=args.quads,
            )
            row["mapKey"] = item.get("mapKey")
            results.append(row)
    elif args.image:
        results.append(
            classify_image(
                args.image,
                args.frame_set or "Portrait",
                args.template or "",
                frames_root=args.frames_root,
                quads_path=args.quads,
            )
        )
    else:
        print("Provide --image or --batch-json", file=sys.stderr)
        return 1

    if args.apply_map:
        map_path = os.path.join(os.path.expanduser("~"), ".editpro", "image-room-map.json")
        with open(map_path, "r", encoding="utf-8") as handle:
            store = json.load(handle)
        mappings = store.get("mappings") or {}
        updated = 0
        for row in results:
            if not row.get("frameColour"):
                continue
            key = row.get("mapKey")
            if key and key in mappings:
                mappings[key]["frameColour"] = row["frameColour"]
                updated += 1
                continue
            # Match by localPath
            path = os.path.normpath(row.get("imagePath") or "")
            for entry in mappings.values():
                local = entry.get("localPath") or ""
                if local and os.path.normpath(local) == path:
                    entry["frameColour"] = row["frameColour"]
                    updated += 1
                    break
        store["mappings"] = mappings
        from datetime import datetime, timezone

        store["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with open(map_path, "w", encoding="utf-8") as handle:
            json.dump(store, handle, indent=2)
            handle.write("\n")
        print(json.dumps({"results": results, "updated": updated}))
    else:
        print(json.dumps({"results": results}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
