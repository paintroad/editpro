#!/usr/bin/env python3
"""CLI: composite paintings into frame templates for catalog lifestyle images."""

from __future__ import annotations

import argparse
import json
import sys

from lifestyle_compositor import generate_for_product


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate lifestyle frame images")
    parser.add_argument("--manifest", required=True, help="Path to JSON manifest file")
    args = parser.parse_args()

    try:
        with open(args.manifest, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except OSError as exc:
        print(json.dumps({"error": str(exc), "images": [], "totalBytes": 0, "errors": []}))
        return 1

    painting_path = manifest.get("paintingPath")
    frame_paths = manifest.get("framePaths") or []
    frames = manifest.get("frames") or []
    output_dir = manifest.get("outputDir")
    output_base_name = manifest.get("outputBaseName")
    canvas_size = int(manifest.get("size") or 1080)
    jpeg_quality = int(manifest.get("jpegQuality") or 88)
    blend_mode = str(manifest.get("blendMode") or "scene")
    blend_strength = float(manifest.get("blendStrength", 1.0))

    if not painting_path or not output_dir or not output_base_name:
        print(
            json.dumps(
                {
                    "error": "paintingPath, outputDir, and outputBaseName are required.",
                    "images": [],
                    "totalBytes": 0,
                    "errors": [],
                }
            )
        )
        return 1

    if not frames and not frame_paths:
        print(
            json.dumps(
                {
                    "error": "frames or framePaths are required.",
                    "images": [],
                    "totalBytes": 0,
                    "errors": [],
                }
            )
        )
        return 1

    result = generate_for_product(
        painting_path=painting_path,
        frame_paths=frame_paths if not frames else None,
        frames=frames if frames else None,
        output_dir=output_dir,
        output_base_name=output_base_name,
        canvas_size=canvas_size,
        jpeg_quality=jpeg_quality,
        blend_mode=blend_mode,
        blend_strength=blend_strength,
    )
    print(json.dumps(result))
    return 0 if not result.get("errors") else 0


if __name__ == "__main__":
    sys.exit(main())
