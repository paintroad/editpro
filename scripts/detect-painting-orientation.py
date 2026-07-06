#!/usr/bin/env python3
"""CLI: detect painting orientation for catalog builder products."""

from __future__ import annotations

import argparse
import json
import sys

from painting_orientation import detect_painting_orientation


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect painting orientation from source images")
    parser.add_argument("--manifest", required=True, help="Path to JSON manifest file")
    args = parser.parse_args()

    try:
        with open(args.manifest, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except OSError as exc:
        print(json.dumps({"error": str(exc), "results": []}))
        return 1

    products = manifest.get("products") or []
    results = []

    for entry in products:
        product_id = str(entry.get("productId") or "").strip()
        image_path = entry.get("imagePath")
        if not product_id or not image_path:
            results.append(
                {
                    "productId": product_id or None,
                    "orientation": None,
                    "aspectRatio": None,
                    "error": "productId and imagePath are required.",
                }
            )
            continue

        detected = detect_painting_orientation(image_path)
        results.append(
            {
                "productId": product_id,
                "orientation": detected.get("orientation"),
                "aspectRatio": detected.get("aspectRatio"),
                "method": detected.get("method"),
                "error": detected.get("error"),
            }
        )

    print(json.dumps({"results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
