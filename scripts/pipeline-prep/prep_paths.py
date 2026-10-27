"""Shared locations for the Pipeline Prep scripts.

The catalog folder is the one last loaded in EditPro's Pipeline Prep module. Long-lived state
(catalog.db, Topaz job logs, replaced upscales, removed paintings) lives in ~/.editpro/pipeline-prep.
"""
import json
import os

EDITPRO = os.path.join(os.path.expanduser("~"), ".editpro")
PREP = os.path.join(EDITPRO, "pipeline-prep")
DB_PATH = os.path.join(PREP, "catalog.db")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


def catalog_root():
    with open(os.path.join(EDITPRO, "artwork-extract.json"), encoding="utf-8") as fh:
        root = json.load(fh).get("input")
    if not root or not os.path.isdir(root):
        raise SystemExit("Load the catalog folder in Pipeline Prep first.")
    return root


def folder(name):
    return os.path.join(catalog_root(), name)


def topaz_key():
    with open(os.path.join(EDITPRO, "config.json"), encoding="utf-8") as fh:
        return json.load(fh)["topazApiKey"]


def stems(path):
    """Image files in a folder keyed by name without extension."""
    if not os.path.isdir(path):
        return {}
    return {os.path.splitext(f)[0]: f for f in os.listdir(path) if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS}
